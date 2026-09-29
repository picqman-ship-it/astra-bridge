import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from '../types.js';
import type { RemoteConfig } from './config.js';
import { PathNotAllowedError, expandHome } from '../security/paths.js';
import { resolveShell } from '../terminal/shell.js';
import {
  DurableStateError, UnsyncedRecordError, canonicalJson, createExclusive, processStatus, readJson, sameProcess, sha256,
} from './durable.js';
import {
  JobStore, TERMINAL_STATES, assertIdempotencyKey, assertJobId, elapsedMs, newJobId, validateJobRequest,
  type JobKeyRecord, type JobRecord, type JobState, type WorkerHealth,
} from './jobs.js';

/**
 * The MCP-server side of durable jobs: submit (with a mandatory idempotency key), read, list,
 * read logs, cancel, and make sure a worker is running. Never runs a job itself: jobs only run in
 * the detached worker (job-worker.ts), so nothing here depends on this process staying alive.
 */

const WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job-worker.js');
export const MAX_TIMEOUT_SEC = 7 * 24 * 3600;
const LOG_READ_DEFAULT = 16 * 1024;
export const LOG_READ_MAX = 64 * 1024;

export interface SubmitRequest {
  command: string;
  idempotencyKey: string;
  cwd?: string;
  shell?: string;
  timeoutSeconds?: number;
  label?: string;
}

export interface SubmitResult {
  job: JobRecord | null;
  jobId: string;
  deduplicated: boolean;
  worker: WorkerHealth['state'] | 'started' | 'error';
  warning?: string;
}

function stateError(err: unknown): never {
  if (err instanceof ToolError || err instanceof PathNotAllowedError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  throw new ToolError(`Job state is not usable, so nothing was done (fail closed): ${msg}`);
}

export class JobService {
  readonly store: JobStore;

  constructor(readonly cfg: RemoteConfig) {
    this.store = new JobStore(cfg);
  }

  private spawnWorker(): void {
    const child = spawn(process.execPath, [WORKER_SCRIPT, '--remote-dir', this.cfg.dir], {
      detached: true, // own session/process group: survives this server and its process group
      stdio: 'ignore', // never connected to an MCP stream
      cwd: '/',
      env: process.env,
    });
    child.on('error', () => {});
    child.unref();
  }

  /** Starts a worker unless one is running (or exists but is unresponsive). */
  async ensureWorker(): Promise<WorkerHealth['state'] | 'started'> {
    return this.store.lock.with(() => {
      const h = this.store.workerHealth();
      if (h.state === 'running' || h.state === 'unresponsive') return h.state;
      this.spawnWorker();
      return 'started';
    });
  }

  /**
   * Server-side supervision (at server start and then every few seconds, never from a read-only
   * tool): if unfinished jobs exist and no worker runs — or it is confirmed dead — start one; it
   * recovers the dead worker's jobs (interrupted / outcome_unknown, never re-run) and runs the
   * queued ones. An unresponsive or unconfirmable worker is left alone.
   */
  async resumeIfPending(): Promise<void> {
    if (!fs.existsSync(this.store.activeDir)) return;
    this.store.ensureDirs();
    if (!this.store.activeIds().length) return;
    const h = this.store.workerHealth();
    if (h.state === 'absent' || h.state === 'dead') await this.ensureWorker();
  }

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    const key = assertIdempotencyKey(req.idempotencyKey);
    if (typeof req.command !== 'string') throw new ToolError('command must be a string');
    const timeoutSec = req.timeoutSeconds ?? this.cfg.jobs.defaultTimeoutSec;
    if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) {
      throw new ToolError(`timeoutSeconds must be an integer between 1 and ${MAX_TIMEOUT_SEC}`);
    }
    const label = req.label?.trim() || undefined;
    // The fingerprint uses the request as given (defaults applied, paths normalized without
    // touching the filesystem), so a retry of an accepted job finds it even if its cwd has since
    // disappeared (e.g. an unmounted volume).
    const requestedCwd = path.resolve(expandHome(req.cwd?.trim() || this.cfg.roots[0]));
    const { shell } = resolveShell(req.shell, this.cfg.defaultShell);
    const fingerprint = sha256(
      canonicalJson({ tool: 'job_start', command: req.command, cwd: requestedCwd, shell, timeoutSec, label: label ?? null }),
    );
    const keyHash = sha256(key);

    let outcome: { job: JobRecord | null; jobId: string; deduplicated: boolean };
    try {
      this.store.ensureDirs();
      // Unwritable state refuses here, before a key is claimed.
      for (const d of [this.store.root, this.store.jobsDir, this.store.activeDir, this.store.keysDir]) {
        try {
          fs.accessSync(d, fs.constants.W_OK | fs.constants.X_OK);
        } catch (err) {
          throw new DurableStateError(`${d} is not writable (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
        }
      }
      outcome = await this.store.lock.with(async () => {
        const keyFile = this.store.keyFile(keyHash);
        const existing = readJson<JobKeyRecord>(keyFile);
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new ToolError(
              'idempotencyKey was already used for a different job request (command, cwd, shell, timeout or label differ). ' +
                'Nothing was started. Use a new key for a new job.',
            );
          }
          return { job: this.store.readJob(assertJobId(existing.jobId)), jobId: existing.jobId, deduplicated: true };
        }
        // A new job: validate it now (blocklist, shell, cwd inside a root). Nothing is claimed yet.
        const valid = await validateJobRequest(this.cfg, req);
        const total = this.store.allIds().length;
        if (total >= this.cfg.jobs.maxJobRecords) {
          throw new ToolError(
            `Job store is full (${total} job records; limit jobs.maxJobRecords=${this.cfg.jobs.maxJobRecords}). Nothing was started. ` +
              'Records are never deleted automatically; the owner can archive finished ones (see the runbook).',
          );
        }
        let queued = 0;
        for (const id of this.store.activeIds()) {
          const rec = this.store.readJob(id); // a malformed record throws: refuse rather than guess
          if (rec?.state === 'queued') queued++;
        }
        if (queued >= this.cfg.jobs.maxQueued) {
          throw new ToolError(`Job queue is full (${queued} queued; limit jobs.maxQueued=${this.cfg.jobs.maxQueued}). Nothing was started; retry later.`);
        }
        const id = newJobId();
        const at = new Date().toISOString();
        // Claim the key before anything else: a crash after this leaves a claim whose job never
        // starts (reported as such), never a second job for the same key.
        const claim: JobKeyRecord = { v: 1, keyHash, fingerprint, jobId: id, createdAt: at };
        try {
          if (!createExclusive(keyFile, JSON.stringify(claim) + '\n')) throw new DurableStateError('key claimed concurrently');
        } catch (err) {
          // Published but not durable: take the claim back (no job exists for it) and do nothing.
          if (err instanceof UnsyncedRecordError) fs.rmSync(keyFile, { force: true });
          throw err;
        }
        const rec: JobRecord = {
          v: 1,
          id,
          state: 'queued',
          command: valid.command,
          cwd: valid.cwd,
          shell: valid.shell,
          timeoutSec,
          ...(label ? { label } : {}),
          keyHash,
          fingerprint,
          createdAt: at,
          updatedAt: at,
          stdout: { bytes: 0, dropped: 0 },
          stderr: { bytes: 0, dropped: 0 },
          progress: null,
        };
        this.store.markActive(id); // a marker without a job is dropped by the worker
        this.store.createJob(rec);
        return { job: rec, jobId: id, deduplicated: false };
      });
    } catch (err) {
      stateError(err);
    }

    let worker: SubmitResult['worker'] = 'running';
    let warning: string | undefined;
    if (!outcome.job) {
      warning =
        'This idempotencyKey was claimed, but its job record was never written (the server stopped during submission). ' +
        'Nothing was started for it and nothing will be. Use a new key.';
    } else if (!TERMINAL_STATES.has(outcome.job.state)) {
      try {
        worker = await this.ensureWorker();
      } catch (err) {
        worker = 'error';
        warning = `The job is recorded but the worker could not be started now (${(err as Error).message}); it starts with the next job call or server start.`;
      }
    }
    return { ...outcome, worker, warning };
  }

  get(id: string): JobRecord {
    assertJobId(id);
    let rec: JobRecord | null;
    try {
      rec = fs.existsSync(this.store.root) ? this.store.readJob(id) : null;
    } catch (err) {
      stateError(err);
    }
    if (!rec) throw new ToolError(`No job ${id}`);
    return rec;
  }

  /** Worker health (read-only). */
  workerState(): WorkerHealth['state'] {
    try {
      return this.store.workerHealth().state;
    } catch {
      return 'absent';
    }
  }

  /** Worker health, and a worker start when unfinished work has none. Used by job_cancel only. */
  async health(rec?: JobRecord): Promise<WorkerHealth['state'] | 'started'> {
    const h = this.store.workerHealth();
    if ((h.state === 'dead' || h.state === 'absent') && (!rec || !TERMINAL_STATES.has(rec.state))) {
      try {
        return await this.ensureWorker();
      } catch {
        return h.state;
      }
    }
    return h.state;
  }

  list(state: JobState | undefined, limit: number): { jobs: Array<JobRecord | { id: string; state: 'unreadable'; error: string }>; total: number } {
    if (!fs.existsSync(this.store.jobsDir)) return { jobs: [], total: 0 };
    let ids: string[];
    try {
      this.store.ensureDirs();
      ids = this.store.allIds().reverse();
    } catch (err) {
      stateError(err);
    }
    const jobs: Array<JobRecord | { id: string; state: 'unreadable'; error: string }> = [];
    for (const id of ids) {
      if (jobs.length >= limit) break;
      try {
        const rec = this.store.readJob(id);
        if (rec && (!state || rec.state === state)) jobs.push(rec);
      } catch (err) {
        if (!state) jobs.push({ id, state: 'unreadable', error: (err as Error).message });
      }
    }
    return { jobs, total: ids.length };
  }

  logs(id: string, stream: 'stdout' | 'stderr', offset: number, length: number | undefined) {
    const rec = this.get(id);
    const want = Math.min(LOG_READ_MAX, Math.max(1, length ?? LOG_READ_DEFAULT));
    let fd: number;
    try {
      fd = fs.openSync(this.store.logFile(id, stream), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (err) {
      stateError(new DurableStateError(`log ${stream} of ${id} is unreadable (${(err as NodeJS.ErrnoException).code ?? 'error'})`));
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) stateError(new DurableStateError(`log ${stream} of ${id} is not a regular file`));
      const size = st.size;
      const start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
      const buf = Buffer.alloc(Math.min(want, size - start));
      const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, start) : 0;
      const info = rec[stream];
      return {
        jobId: id,
        stream,
        state: rec.state,
        offset: start,
        bytesReturned: n,
        nextOffset: start + n,
        size,
        droppedAfterLimit: info.dropped,
        limitBytes: this.cfg.jobs.maxLogBytes,
        endOfLog: start + n >= size && TERMINAL_STATES.has(rec.state),
        text: buf.subarray(0, n).toString('utf8'),
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Queued: cancelled at once (under the lock, so the worker cannot start it meanwhile).
   * Starting/running: a durable cancel request the worker applies to the process group it owns.
   * Interrupted with its process still running: signalled only after checking the recorded PID
   * still belongs to the same process (PID + start time); a reused PID is never signalled.
   */
  async cancel(id: string, waitMs: number): Promise<{ rec: JobRecord; action: string }> {
    assertJobId(id);
    let action: string;
    try {
      this.store.ensureDirs();
      action = await this.store.lock.with(() => {
        const rec = this.store.readJob(id);
        if (!rec) throw new ToolError(`No job ${id}`);
        if (rec.state === 'queued') {
          rec.state = 'cancelled';
          rec.cancelRequestedAt = rec.finishedAt = new Date().toISOString();
          rec.reason = 'Cancelled before it started.';
          this.store.writeJob(rec);
          this.store.clearActive(id);
          return 'cancelled before it started';
        }
        if (TERMINAL_STATES.has(rec.state) && rec.processMayStillRun) {
          const status = processStatus(rec.pid, rec.pidIdentity);
          if (status === 'gone') {
            rec.processMayStillRun = false;
            this.store.writeJob(rec);
            return 'its leftover process is no longer running (nothing signalled)';
          }
          if (status === 'unknown') {
            return `its PID ${rec.pid ?? '?'} is in use but could not be confirmed to be the job's process; nothing was signalled (check it manually)`;
          }
          try {
            process.kill(-rec.pid!, 'SIGTERM');
          } catch {
            /* gone meanwhile */
          }
          return 'sent SIGTERM to the leftover process group of the interrupted job (identity verified)';
        }
        if (TERMINAL_STATES.has(rec.state)) return `already finished (${rec.state}); nothing to cancel`;
        createExclusive(this.store.cancelFile(id), JSON.stringify({ at: new Date().toISOString() }) + '\n');
        return 'cancellation requested; the worker stops the process group (SIGTERM, then SIGKILL after 3s)';
      });
    } catch (err) {
      stateError(err);
    }
    let rec = this.get(id);
    if (!TERMINAL_STATES.has(rec.state) || rec.processMayStillRun) {
      await this.health(rec);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        rec = this.get(id);
        if (TERMINAL_STATES.has(rec.state) && !(rec.state === 'interrupted' && rec.processMayStillRun && sameProcess(rec.pid, rec.pidIdentity))) break;
      }
      if (rec.state === 'interrupted' && rec.processMayStillRun && !sameProcess(rec.pid, rec.pidIdentity)) {
        rec = await this.store.lock.with(() => {
          const fresh = this.store.readJob(id)!;
          fresh.processMayStillRun = false;
          this.store.writeJob(fresh);
          return fresh;
        });
      }
    }
    return { rec, action };
  }
}

/** The client-facing view of a record (internal hashes omitted). */
export function jobView(rec: JobRecord, worker?: string): Record<string, unknown> {
  return {
    jobId: rec.id,
    state: rec.state,
    finished: TERMINAL_STATES.has(rec.state),
    ...(rec.label ? { label: rec.label } : {}),
    command: rec.command,
    cwd: rec.cwd,
    shell: rec.shell,
    timeoutSec: rec.timeoutSec,
    createdAt: rec.createdAt,
    startedAt: rec.startedAt ?? null,
    finishedAt: rec.finishedAt ?? null,
    elapsedMs: elapsedMs(rec) ?? null,
    exitCode: rec.exitCode ?? null,
    signal: rec.signal ?? null,
    pid: rec.pid ?? null,
    progress: rec.progress,
    stdout: rec.stdout,
    stderr: rec.stderr,
    ...(rec.cancelRequestedAt ? { cancelRequestedAt: rec.cancelRequestedAt } : {}),
    ...(rec.reason ? { reason: rec.reason } : {}),
    ...(rec.processMayStillRun !== undefined ? { processMayStillRun: rec.processMayStillRun } : {}),
    ...(worker ? { worker } : {}),
  };
}
