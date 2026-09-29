#!/usr/bin/env node
import '../bootstrap.js';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { childEnv, shellSpawnArgs } from '../terminal/shell.js';
import { VERSION } from '../version.js';
import { EX_CONFIG, parseRemoteArgs, rejectExtraArgs } from './cli.js';
import { loadRemoteConfig, type RemoteConfig } from './config.js';
import { DurableStateError, ownIdentity, processIdentity, processStatus, writeAtomic } from './durable.js';
import {
  HEARTBEAT_EVERY_MS, JobStore, TERMINAL_STATES, parseProgress, validateJobRequest, type JobRecord, type StreamInfo,
  type WorkerRecord,
} from './jobs.js';

/**
 * The durable job worker: one per remote directory, detached from the MCP server that spawned it
 * (own session and process group, stdin/stdout/stderr on /dev/null), so it keeps running — and
 * keeps its children's pipes open — when the server exits, is restarted or is SIGKILLed, and when
 * MCP connections drop. TerminalManager.shutdown() never sees these processes.
 *
 * Every tick it takes the state lock, writes a heartbeat, reads the active markers, applies
 * cancellation requests, recovers jobs of a previous worker that died, and starts queued jobs
 * (oldest first) while fewer than jobs.maxConcurrent run. Before a job starts its command and
 * cwd are validated again against the current remote.json, and the "starting" state is written;
 * only then is the process spawned, and "running" with its PID and identity is written after.
 *
 * What it can NOT do: a job whose worker died (crash, SIGKILL, logout, reboot) is never resumed
 * or re-run. The next worker marks it "interrupted" (it was running) or "outcome_unknown" (the
 * worker died between recording the intent and recording the start). Queued jobs stay queued and
 * run when a worker runs again. After idle for jobs.workerIdleExitMs the worker exits; the
 * servers start a new one on demand.
 */

const LABEL = 'mcp-commander-job-worker';
const USAGE = 'Usage: job-worker.js --remote-dir <dir>\nStarted by the remote MCP server; not meant to be run by hand.\n';
const TICK_MS = 200;
const KILL_GRACE_MS = 3000;
const WORKER_LOG_MAX = 1024 * 1024;
const PROGRESS_LINE_MAX = 1024;

interface Stream extends StreamInfo {
  fd: number | null;
  logError?: string;
}

interface Running {
  rec: JobRecord;
  child: ChildProcess;
  out: Stream;
  err: Stream;
  carry: string;
  dirty: boolean;
  stopping: null | 'cancel' | 'timeout' | 'shutdown';
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  finalized: boolean;
}

let store: JobStore;
let remoteDir: string;
let cfg: RemoteConfig;
const nonce = crypto.randomBytes(12).toString('hex');
const running = new Map<string, Running>();
const reportedCorrupt = new Set<string>();
let lastBeat = 0;
let idleSince: number | null = null;
let stopping = false;

function log(msg: string): void {
  try {
    const st = fs.lstatSync(store.workerLog, { throwIfNoEntry: false });
    if (st && (!st.isFile() || st.isSymbolicLink())) return;
    if (st && st.size > WORKER_LOG_MAX) fs.truncateSync(store.workerLog, 0);
    fs.appendFileSync(store.workerLog, `${new Date().toISOString()} [${process.pid}] ${msg}\n`, { mode: 0o600 });
  } catch {
    /* diagnostics must never stop the worker */
  }
}

const now = () => new Date().toISOString();

function writeJobSafe(rec: JobRecord): boolean {
  try {
    store.writeJob(rec);
    return true;
  } catch (err) {
    log(`job ${rec.id}: record write failed (${(err as Error).message})`);
    return false;
  }
}

function finish(rec: JobRecord, state: JobRecord['state'], reason?: string): void {
  rec.state = state;
  if (reason) rec.reason = reason;
  rec.finishedAt = now();
  if (rec.startedAt) rec.elapsedMs = Date.parse(rec.finishedAt) - Date.parse(rec.startedAt);
  if (writeJobSafe(rec)) store.clearActive(rec.id);
}

/** A job of a worker that is gone: never resumed, never re-run. */
function recover(rec: JobRecord): void {
  const status = processStatus(rec.pid, rec.pidIdentity);
  if (rec.state === 'starting') {
    rec.processMayStillRun = status !== 'gone';
    finish(
      rec,
      'outcome_unknown',
      'The job worker stopped after recording the intent to start this job but before recording that it had started. ' +
        'Whether the command ran is unknown; it was NOT re-run automatically.',
    );
  } else if (rec.state === 'running') {
    rec.processMayStillRun = status !== 'gone';
    finish(
      rec,
      'interrupted',
      'The job worker stopped (crash, kill, logout or reboot) while this job was running. It was NOT resumed or re-run; ' +
        'its effects may be partial.' +
        (status === 'same'
          ? ' Its process (same PID and start time) was still running at recovery; job_cancel can stop it.'
          : status === 'unknown'
            ? ' Its PID was still in use but could not be confirmed to be the same process; it is not signalled automatically.'
            : ''),
    );
  }
  log(`job ${rec.id}: recovered as ${rec.state}`);
}

function signalGroup(r: Running, sig: NodeJS.Signals): void {
  const pid = r.child.pid;
  if (!pid) return;
  // Our own unreaped child's group (detached: pgid = pid) cannot have been recycled.
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

function stop(r: Running, why: 'cancel' | 'timeout' | 'shutdown'): void {
  if (r.stopping) return;
  r.stopping = why;
  if (why === 'cancel') r.rec.cancelRequestedAt = now();
  r.dirty = true;
  signalGroup(r, 'SIGTERM');
  r.killTimer = setTimeout(() => signalGroup(r, 'SIGKILL'), KILL_GRACE_MS);
}

function writeChunk(r: Running, s: Stream, chunk: Buffer): void {
  const room = cfg.jobs.maxLogBytes - s.bytes;
  let stored = 0;
  if (room > 0 && s.fd !== null) {
    const want = Math.min(room, chunk.length);
    try {
      // A write may be short: continue until the allowed part is stored.
      while (stored < want) {
        const n = fs.writeSync(s.fd, chunk, stored, want - stored, null);
        if (n <= 0) break;
        stored += n;
      }
    } catch (err) {
      s.logError = (err as NodeJS.ErrnoException).code ?? 'error';
    }
  }
  s.bytes += stored;
  s.dropped += chunk.length - stored;
  r.dirty = true;
}

function scanProgress(r: Running, chunk: Buffer): void {
  const text = r.carry + chunk.toString('utf8');
  const lines = text.split('\n');
  const last = lines.pop() ?? '';
  r.carry = last.length > PROGRESS_LINE_MAX ? '' : last;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length > PROGRESS_LINE_MAX || !lines[i].includes('MCPC_PROGRESS')) continue;
    const p = parseProgress(lines[i]);
    if (p) {
      r.rec.progress = { ...p, at: now() };
      r.dirty = true;
      break;
    }
  }
}

function syncStreams(r: Running): void {
  r.rec.stdout = { bytes: r.out.bytes, dropped: r.out.dropped };
  r.rec.stderr = { bytes: r.err.bytes, dropped: r.err.dropped };
}

function finalize(r: Running): void {
  if (r.finalized) return;
  r.finalized = true;
  clearTimeout(r.timer);
  clearTimeout(r.killTimer);
  if (r.carry) scanProgress(r, Buffer.from('\n'));
  for (const s of [r.out, r.err]) {
    if (s.fd !== null) fs.closeSync(s.fd);
    s.fd = null;
  }
  syncStreams(r);
  const code = r.exit?.code ?? null;
  const signal = r.exit?.signal ?? null;
  r.rec.exitCode = code;
  r.rec.signal = signal;
  const logNote = [r.out, r.err].some((s) => s.logError) ? ` Some output could not be stored (${r.out.logError ?? r.err.logError}).` : '';
  if (r.stopping === 'cancel') finish(r.rec, 'cancelled', `Cancelled on request.${logNote}`);
  else if (r.stopping === 'timeout') finish(r.rec, 'timed_out', `Stopped after the ${r.rec.timeoutSec}s timeout.${logNote}`);
  else if (r.stopping === 'shutdown') finish(r.rec, 'interrupted', `The job worker was stopped by a signal while this job was running; it was NOT re-run.${logNote}`);
  else if (code === 0) finish(r.rec, 'succeeded', logNote.trim() || undefined);
  else finish(r.rec, 'failed', signal ? `Terminated by ${signal}.${logNote}` : `Exited with code ${code}.${logNote}`);
  running.delete(r.rec.id);
  log(`job ${r.rec.id}: ${r.rec.state}`);
}

function openLog(rec: JobRecord, stream: 'stdout' | 'stderr'): number {
  return fs.openSync(store.logFile(rec.id, stream), fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0));
}

async function startJob(rec: JobRecord): Promise<void> {
  // Validate again, against the configuration as it is now: the cwd may have been removed (or its
  // volume unmounted), the blocklist or roots changed, or trusted-terminal mode switched off.
  let fresh: RemoteConfig;
  try {
    fresh = loadRemoteConfig(remoteDir);
  } catch (err) {
    return finish(rec, 'failed', `Not started: the remote configuration is no longer valid (${(err as Error).message}).`);
  }
  if (!fresh.trustedTerminal) return finish(rec, 'failed', 'Not started: trusted-terminal mode is now off.');
  let req;
  try {
    req = await validateJobRequest(fresh, { command: rec.command, cwd: rec.cwd, shell: rec.shell });
  } catch (err) {
    return finish(rec, 'failed', `Not started: ${(err as Error).message}`);
  }
  if (req.cwd !== rec.cwd) return finish(rec, 'failed', `Not started: cwd now resolves to a different location (${req.cwd}).`);

  // Intent first: if we die after this, the job is reported outcome_unknown, never re-run.
  rec.state = 'starting';
  rec.worker = { pid: process.pid, nonce };
  store.writeJob(rec); // throws: the job stays queued and nothing is spawned

  let out: number | null = null;
  let errFd: number | null = null;
  let child: ChildProcess;
  try {
    out = openLog(rec, 'stdout');
    errFd = openLog(rec, 'stderr');
    const spec = shellSpawnArgs(req.shellPath, rec.command);
    child = spawn(spec.file, spec.args, {
      cwd: req.cwd,
      env: childEnv({ ...process.env, MCPC_JOB_ID: rec.id }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    for (const fd of [out, errFd]) if (fd !== null) fs.closeSync(fd);
    return finish(rec, 'failed', `Failed to start: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  const r: Running = {
    rec,
    child,
    out: { fd: out, bytes: 0, dropped: 0 },
    err: { fd: errFd, bytes: 0, dropped: 0 },
    carry: '',
    dirty: false,
    stopping: null,
    finalized: false,
  };
  running.set(rec.id, r);
  child.stdout!.on('data', (c: Buffer) => {
    writeChunk(r, r.out, c);
    scanProgress(r, c);
  });
  child.stderr!.on('data', (c: Buffer) => writeChunk(r, r.err, c));
  child.on('error', (e: NodeJS.ErrnoException) => {
    if (!child.pid) {
      rec.reason = `Failed to start: ${e.code ?? e.message}`;
      r.exit = { code: null, signal: null };
      finalize(r);
    }
  });
  child.on('exit', (code, signal) => {
    r.exit = { code, signal };
    // A background process may keep the pipes open: do not wait for it forever.
    setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finalize(r);
    }, 2000).unref();
  });
  child.on('close', () => finalize(r));

  if (!child.pid) return; // the 'error' event finalizes it
  rec.pid = child.pid;
  rec.pidIdentity = processIdentity(child.pid);
  rec.state = 'running';
  rec.startedAt = now();
  r.timer = setTimeout(() => stop(r, 'timeout'), rec.timeoutSec * 1000);
  if (!writeJobSafe(rec)) r.dirty = true;
  log(`job ${rec.id}: running as pid ${child.pid}`);
}

function heartbeat(w: WorkerRecord): void {
  w.heartbeatAt = Date.now();
  writeAtomic(store.workerFile, JSON.stringify(w) + '\n');
  lastBeat = w.heartbeatAt;
  for (const r of running.values()) {
    if (!r.dirty || r.finalized) continue;
    syncStreams(r);
    if (writeJobSafe(r.rec)) r.dirty = false;
  }
}

/** One scheduling pass under the lock. Returns 'exit' when the worker should stop. */
async function tick(): Promise<'ok' | 'exit' | 'lost'> {
  return store.lock.with(async () => {
    const w = store.readWorker();
    if (!w || w.nonce !== nonce) return 'lost';
    if (Date.now() - lastBeat >= HEARTBEAT_EVERY_MS) heartbeat(w);

    const queued: JobRecord[] = [];
    const active = store.activeIds();
    for (const id of active) {
      const mine = running.get(id);
      if (mine) {
        if (!mine.stopping && fs.existsSync(store.cancelFile(id))) stop(mine, 'cancel');
        continue;
      }
      let rec: JobRecord | null;
      try {
        rec = store.readJob(id);
      } catch (err) {
        if (!reportedCorrupt.has(id)) log(`job ${id}: unreadable record, skipped (${(err as Error).message})`);
        reportedCorrupt.add(id);
        continue;
      }
      if (!rec || TERMINAL_STATES.has(rec.state)) {
        store.clearActive(id);
        continue;
      }
      if (rec.state === 'queued') {
        if (fs.existsSync(store.cancelFile(id))) {
          rec.cancelRequestedAt = now();
          finish(rec, 'cancelled', 'Cancelled before it started.');
        } else queued.push(rec);
        continue;
      }
      // starting/running but not ours: its worker is gone (we hold the singleton).
      recover(rec);
    }

    queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const rec of queued) {
      if (running.size >= cfg.jobs.maxConcurrent || stopping) break;
      try {
        await startJob(rec);
      } catch (err) {
        log(`job ${rec.id}: not started (${(err as Error).message})`);
        if (err instanceof DurableStateError) break; // state not writable: start nothing
      }
    }

    if (running.size === 0 && store.activeIds().length === 0) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= cfg.jobs.workerIdleExitMs) {
        // Under the lock: a server that queues a job after this sees no worker and starts one.
        fs.rmSync(store.workerFile, { force: true });
        return 'exit';
      }
    } else idleSince = null;
    return 'ok';
  });
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping ${running.size} running job(s); queued jobs stay queued`);
  for (const r of running.values()) stop(r, 'shutdown');
  const deadline = Date.now() + KILL_GRACE_MS + 2000;
  while (running.size && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  for (const r of running.values()) finalize(r);
  try {
    await store.lock.with(() => {
      const w = store.readWorker();
      if (w?.nonce === nonce) fs.rmSync(store.workerFile, { force: true });
    }, 3000);
  } catch {
    /* the next worker treats our record as dead */
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const args = parseRemoteArgs(process.argv.slice(2), USAGE);
  rejectExtraArgs(args.rest, USAGE);
  remoteDir = args.remoteDir;
  try {
    cfg = loadRemoteConfig(remoteDir);
  } catch (err) {
    console.error(`[${LABEL}] refusing to start: ${(err as Error).message}`);
    process.exit(EX_CONFIG);
  }
  store = new JobStore(cfg);
  if (!cfg.trustedTerminal) process.exit(EX_CONFIG);
  store.ensureDirs();

  const me: WorkerRecord = { v: 1, pid: process.pid, identity: ownIdentity(), nonce, startedAt: now(), heartbeatAt: Date.now() };
  const claimed = await store.lock.with(() => {
    const h = store.workerHealth();
    if (h.state === 'running' || h.state === 'unresponsive') return false;
    writeAtomic(store.workerFile, JSON.stringify(me) + '\n');
    lastBeat = me.heartbeatAt;
    // Recovery: every unfinished job gets an active marker; jobs of the dead worker are settled.
    for (const id of store.allIds()) {
      try {
        const rec = store.readJob(id);
        if (!rec || TERMINAL_STATES.has(rec.state)) continue;
        if (rec.state === 'starting' || rec.state === 'running') recover(rec);
        else store.markActive(id);
      } catch (err) {
        log(`job ${id}: unreadable during recovery (${(err as Error).message})`);
      }
    }
    return true;
  });
  if (!claimed) process.exit(0);
  log(`worker ${VERSION} started (maxConcurrent ${cfg.jobs.maxConcurrent})`);

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => {}); // no terminal to hang up on; keep running
  process.on('uncaughtException', (err) => {
    log(`uncaught exception (${err.name}: ${err.message}); exiting — unfinished jobs will be reported interrupted`);
    process.exit(70);
  });
  process.on('unhandledRejection', (err) => log(`unhandled rejection (${err instanceof Error ? err.message : String(err)})`));

  for (;;) {
    let result: 'ok' | 'exit' | 'lost';
    try {
      result = await tick();
    } catch (err) {
      if (!fs.existsSync(store.root)) {
        // The whole state directory is gone (removed by the owner): nothing can be recorded any more.
        await shutdown('state directory removed');
        return;
      }
      log(`tick failed (${(err as Error).message})`);
      result = 'ok';
    }
    if (result === 'exit') {
      log('idle: exiting');
      process.exit(0);
    }
    if (result === 'lost') {
      // Another worker judged us dead and took over: do not run jobs twice.
      log('lost the worker lease; stopping own jobs');
      await shutdown('lease lost');
    }
    if (stopping) return;
    await new Promise((res) => setTimeout(res, TICK_MS));
  }
}

main().catch((err) => {
  console.error(`[${LABEL}] fatal: ${err instanceof Error ? err.message : 'error'}`);
  process.exit(1);
});
