import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkCommand, commandName } from '../security/commands.js';
import { expandHome, validatePath } from '../security/paths.js';
import { findExecutable, resolveShell } from '../terminal/shell.js';
import { ToolError } from '../types.js';
import type { RemoteConfig } from './config.js';
import {
  DurableStateError, FileLock, createExclusive, ensurePrivateDir, isAlive, processStatus, readJson, writeAtomic,
} from './durable.js';

/**
 * Durable jobs: records on disk, shared by the MCP server processes (which submit, read and
 * cancel) and the single detached job worker (which runs them). See job-worker.ts for the
 * lifecycle and docs/remote-runbook.md for the guarantees and their limits.
 *
 * Layout below <remote-dir>/durable (all 0700 dirs / 0600 files):
 *   lock                      cross-process mutex (FileLock)
 *   worker.json               the running worker: pid, process identity, nonce, heartbeat
 *   worker.log                the worker's own diagnostics (bounded)
 *   jobs/<id>/job.json        the job record
 *   jobs/<id>/stdout.log      captured output, at most jobs.maxLogBytes each
 *   jobs/<id>/stderr.log
 *   jobs/<id>/cancel.json     a durable cancellation request
 *   active/<id>               marker: the job is not finished yet (what the worker scans)
 *   jobkeys/<sha256(key)>.json  idempotency claim of job_start: key -> job id
 *   idem/<sha256(key)>.json   idempotency records of other tools (idempotency.ts)
 */

export type JobState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'
  | 'outcome_unknown';

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'outcome_unknown',
]);
export const ALL_STATES: readonly JobState[] = [
  'queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'outcome_unknown',
];

export interface StreamInfo {
  /** Bytes stored in the log file. */
  bytes: number;
  /** Bytes the job wrote after the log reached jobs.maxLogBytes (counted, not stored). */
  dropped: number;
}

export interface JobProgress {
  percent?: number;
  done?: number;
  total?: number;
  message?: string;
  at: string;
}

export interface JobRecord {
  v: 1;
  id: string;
  state: JobState;
  command: string;
  cwd: string;
  shell: string;
  timeoutSec: number;
  label?: string;
  keyHash: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  /** The job's process (and process-group) id, and its identity (see processIdentity). */
  pid?: number;
  pidIdentity?: string | null;
  /** The worker that started it. */
  worker?: { pid: number; nonce: string };
  stdout: StreamInfo;
  stderr: StreamInfo;
  /** Reported by the job itself (MCPC_PROGRESS lines); never estimated. */
  progress: JobProgress | null;
  cancelRequestedAt?: string;
  /** Why the job failed / was interrupted / has an unknown outcome, when that is not an exit code. */
  reason?: string;
  /**
   * interrupted/outcome_unknown only: at recovery the job's PID was still running and was not
   * confirmed to be a different process. job_cancel signals it only after confirming the identity.
   */
  processMayStillRun?: boolean;
}

export interface WorkerRecord {
  v: 1;
  pid: number;
  identity: string | null;
  nonce: string;
  startedAt: string;
  heartbeatAt: number;
}

export interface JobKeyRecord {
  v: 1;
  keyHash: string;
  fingerprint: string;
  jobId: string;
  createdAt: string;
}

const JOB_ID = /^j[0-9a-z]{8,11}-[0-9a-f]{16}$/;
/** Heartbeats are written every second; one older than this means the worker is not working. */
export const HEARTBEAT_STALE_MS = 5000;
export const HEARTBEAT_EVERY_MS = 1000;
const RECORD_MAX_BYTES = 256 * 1024;

export function newJobId(): string {
  return `j${Date.now().toString(36).padStart(9, '0')}-${crypto.randomBytes(8).toString('hex')}`;
}

export function isJobId(id: unknown): id is string {
  return typeof id === 'string' && JOB_ID.test(id);
}

export function assertJobId(id: unknown): string {
  if (!isJobId(id)) throw new ToolError(`Invalid job id ${JSON.stringify(String(id).slice(0, 80))}: expected an id returned by job_start (e.g. j0mg1abcd-0123456789abcdef).`);
  return id;
}

/** Idempotency keys: 8-200 visible ASCII characters (a UUID is ideal). */
export function assertIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{8,200}$/.test(key)) {
    throw new ToolError('idempotencyKey must be 8-200 visible ASCII characters without spaces (use a fresh UUID per intended action).');
  }
  return key;
}

/** One progress line: "MCPC_PROGRESS 42%", "MCPC_PROGRESS 42", "MCPC_PROGRESS 3/10 copying files". */
export function parseProgress(line: string): Omit<JobProgress, 'at'> | null {
  const m = /^MCPC_PROGRESS[ \t]+(\d{1,12})(?:(%)|\/(\d{1,12}))?(?:[ \t]+(.*))?$/.exec(line.trim());
  if (!m) return null;
  const message = m[4]?.slice(0, 200) || undefined;
  if (m[3] !== undefined) {
    const done = Number(m[1]);
    const total = Number(m[3]);
    if (total <= 0 || done > total) return null;
    return { done, total, percent: Math.round((done / total) * 1000) / 10, message };
  }
  const percent = Number(m[1]);
  if (percent > 100) return null;
  return { percent, message };
}

export interface JobRequest {
  command: string;
  cwd: string;
  shell: string;
  shellPath: string;
}

/**
 * Validates a job request against the remote configuration: blocklist, shell, and a cwd that is a
 * directory inside a configured root (symlinks resolved). Runs at submission and again right
 * before execution, because the tree (or a mounted volume) can change in between.
 */
export async function validateJobRequest(
  cfg: RemoteConfig,
  raw: { command: string; cwd?: string; shell?: string },
): Promise<JobRequest> {
  const command = raw.command;
  if (typeof command !== 'string' || !command.trim()) throw new ToolError('command must not be empty');
  if (command.length > 64 * 1024) throw new ToolError('command is longer than 64 KiB');
  const check = checkCommand(command, cfg.blockedCommands);
  if (!check.allowed) {
    throw new ToolError(`Command not allowed: ${command.slice(0, 200)} (${check.blocked ? `blocked: ${check.blocked}` : check.reason ?? 'rejected'})`);
  }
  const { shell, source } = resolveShell(raw.shell, cfg.defaultShell);
  if (source === 'argument' && cfg.blockedCommands.some((b) => b.trim().toLowerCase() === commandName(shell))) {
    throw new ToolError(`Shell not allowed: ${shell} (blocked: ${commandName(shell)})`);
  }
  const shellPath = findExecutable(shell);
  if (!shellPath) throw new ToolError(`Shell not found: ${shell}`);

  const requested = raw.cwd && raw.cwd.trim() ? raw.cwd.trim() : cfg.roots[0];
  const cwd = await validatePath(path.resolve(expandHome(requested)), cfg.roots);
  let st: fs.Stats;
  try {
    st = fs.statSync(cwd);
  } catch {
    throw new ToolError(`cwd does not exist (missing, or on a volume that is not mounted): ${requested}`);
  }
  if (!st.isDirectory()) throw new ToolError(`cwd is not a directory: ${requested}`);
  return { command, cwd, shell, shellPath };
}

export type WorkerHealth =
  | { state: 'absent' }
  | { state: 'running'; pid: number; heartbeatAgeMs: number }
  /**
   * No recent heartbeat, but the process is still there (stopped, or the Mac slept) or could not be
   * confirmed gone. Never replaced automatically.
   */
  | { state: 'unresponsive'; pid: number; heartbeatAgeMs: number }
  | { state: 'dead'; pid: number; heartbeatAgeMs: number };

export class JobStore {
  readonly root: string;
  readonly jobsDir: string;
  readonly activeDir: string;
  readonly keysDir: string;
  readonly workerFile: string;
  readonly workerLog: string;
  readonly lock: FileLock;

  constructor(readonly cfg: Pick<RemoteConfig, 'durableDir'>) {
    this.root = cfg.durableDir;
    this.jobsDir = path.join(this.root, 'jobs');
    this.activeDir = path.join(this.root, 'active');
    this.keysDir = path.join(this.root, 'jobkeys');
    this.workerFile = path.join(this.root, 'worker.json');
    this.workerLog = path.join(this.root, 'worker.log');
    this.lock = new FileLock(path.join(this.root, 'lock'));
  }

  /** Creates/checks the private directories. Throws DurableStateError: callers must not act. */
  ensureDirs(): void {
    ensurePrivateDir(this.root);
    for (const d of [this.jobsDir, this.activeDir, this.keysDir]) ensurePrivateDir(d);
  }

  jobDir(id: string): string {
    return path.join(this.jobsDir, assertJobId(id));
  }

  logFile(id: string, stream: 'stdout' | 'stderr'): string {
    return path.join(this.jobDir(id), `${stream}.log`);
  }

  cancelFile(id: string): string {
    return path.join(this.jobDir(id), 'cancel.json');
  }

  readJob(id: string): JobRecord | null {
    const rec = readJson<JobRecord>(path.join(this.jobDir(id), 'job.json'), RECORD_MAX_BYTES);
    if (rec && (rec.id !== id || !ALL_STATES.includes(rec.state))) {
      throw new DurableStateError(`Job record ${id} is inconsistent (id/state); refusing to act on it.`);
    }
    return rec;
  }

  writeJob(rec: JobRecord): void {
    rec.updatedAt = new Date().toISOString();
    writeAtomic(path.join(this.jobDir(rec.id), 'job.json'), JSON.stringify(rec, null, 2) + '\n');
  }

  /**
   * Creates a job directory with its record and empty logs, then publishes it with one directory
   * rename, so a job is either fully there or not at all.
   */
  createJob(rec: JobRecord): void {
    const staging = path.join(this.jobsDir, `.new-${rec.id}`);
    ensurePrivateDir(staging);
    try {
      writeAtomic(path.join(staging, 'job.json'), JSON.stringify(rec, null, 2) + '\n');
      for (const s of ['stdout', 'stderr']) createExclusive(path.join(staging, `${s}.log`), '');
      fs.renameSync(staging, this.jobDir(rec.id));
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err instanceof DurableStateError ? err : new DurableStateError(`Cannot create job ${rec.id} (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
    }
  }

  markActive(id: string): void {
    createExclusive(path.join(this.activeDir, assertJobId(id)), '');
  }

  clearActive(id: string): void {
    fs.rmSync(path.join(this.activeDir, assertJobId(id)), { force: true });
  }

  /** Ids with an active marker (unfinished jobs). */
  activeIds(): string[] {
    return fs.readdirSync(this.activeDir).filter(isJobId).sort();
  }

  /** Every job id on disk, oldest first (ids sort by creation time). */
  allIds(): string[] {
    return fs.readdirSync(this.jobsDir).filter(isJobId).sort();
  }

  keyFile(keyHash: string): string {
    if (!/^[0-9a-f]{64}$/.test(keyHash)) throw new DurableStateError('bad key hash');
    return path.join(this.keysDir, `${keyHash}.json`);
  }

  readWorker(): WorkerRecord | null {
    return readJson<WorkerRecord>(this.workerFile, 64 * 1024);
  }

  workerHealth(): WorkerHealth {
    let w: WorkerRecord | null;
    try {
      w = this.readWorker();
    } catch {
      return { state: 'absent' };
    }
    if (!w) return { state: 'absent' };
    const heartbeatAgeMs = Math.max(0, Date.now() - w.heartbeatAt);
    if (heartbeatAgeMs <= HEARTBEAT_STALE_MS && isAlive(w.pid)) return { state: 'running', pid: w.pid, heartbeatAgeMs };
    // Stale heartbeat: the worker is dead only when that is confirmed (PID gone, or now a different
    // process). Still the same process, or not confirmable: never replaced (no second worker).
    if (processStatus(w.pid, w.identity) !== 'gone') return { state: 'unresponsive', pid: w.pid, heartbeatAgeMs };
    return { state: 'dead', pid: w.pid, heartbeatAgeMs };
  }
}

/** Seconds elapsed for a record (running jobs: until now). */
export function elapsedMs(rec: JobRecord): number | undefined {
  if (rec.elapsedMs !== undefined) return rec.elapsedMs;
  if (!rec.startedAt) return undefined;
  return Date.now() - Date.parse(rec.startedAt);
}
