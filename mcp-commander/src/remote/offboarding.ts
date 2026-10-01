import fs from 'node:fs';
import path from 'node:path';
import { remotePaths } from './config.js';
import { DurableStateError, ensurePrivateDir, processStatus, readJson, writeAtomic } from './durable.js';
import { JobStore, TERMINAL_STATES } from './jobs.js';
import { assertPrivateDir } from './secrets.js';

export const JOBS_DISABLED_FILE = 'jobs-disabled.json';

export function assertJobsEnabled(durableDir: string): void {
  if (fs.lstatSync(path.join(durableDir, JOBS_DISABLED_FILE), { throwIfNoEntry: false })) {
    throw new DurableStateError('Durable jobs were disabled during offboarding. The owner must explicitly re-enable terminal tools locally.');
  }
}

export interface OffboardingResult {
  /** Queued jobs cancelled before they started. */
  cancelled: number;
  /** Verified processes (worker, job process groups) that were signalled and confirmed gone. */
  stopped: number;
}

interface Tracked {
  pid: number;
  identity: string | null | undefined;
  /** A job's process group (signalled as -pid); otherwise the worker process itself. */
  group: boolean;
  what: string;
}

/** Stop recorded processes only after verifying PID + start identity, never a bare stored PID. */
export async function stopDurableJobs(dir: string, {
  timeoutMs = 10_000,
  status = processStatus,
  signal = (pid: number, sig: NodeJS.Signals | 0) => process.kill(pid, sig),
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
} = {}): Promise<OffboardingResult> {
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })) return { cancelled: 0, stopped: 0 };
  assertPrivateDir(dir, 'Remote config directory');
  const store = new JobStore(remotePaths(dir));
  // Also disables submissions by another server using the same remote directory.
  store.ensureDirs();
  const marker = path.join(store.root, JOBS_DISABLED_FILE);
  const unconfirmed = (why: string) => new DurableStateError(
    `${why}; durable-job shutdown is unconfirmed. Nothing unverified was signalled and every record in ${store.root} is kept.`);
  const unverifiable = (id: string, why: string) => unconfirmed(
    `Job ${id} ${why}. Look for its command (${store.jobDir(id)}/job.json) in \`ps -axo pid,pgid,lstart,command\` and stop what you find; ` +
    `to acknowledge a job that is confirmed not running, move that one directory out of ${store.jobsDir} (keep it for your records) and retry`);
  const seen = new Set<string>();
  let cancelled = 0;
  const tracked = await store.lock.with(() => {
    writeAtomic(marker, JSON.stringify({ complete: false }) + '\n');
    const worker = store.readWorker(); // malformed state is an error, never "absent"
    const processes: Tracked[] = [];
    if (worker) {
      if (!Number.isSafeInteger(worker.pid) || worker.pid <= 1) throw unconfirmed(`The worker record ${store.workerFile} has no valid PID`);
      // A dead PID is gone whatever identity was recorded; a live one must match it (see live()).
      processes.push({ pid: worker.pid, identity: worker.identity, group: false, what: `job worker (PID ${worker.pid})` });
    }
    for (const id of store.allIds()) {
      seen.add(id);
      ensurePrivateDir(store.jobDir(id));
      const rec = store.readJob(id);
      if (!rec) throw unconfirmed(`Job ${id} has no record (${store.jobDir(id)}/job.json)`);
      if (rec.state === 'queued') {
        rec.state = 'cancelled';
        rec.finishedAt = rec.cancelRequestedAt = new Date().toISOString();
        rec.reason = 'Cancelled by local offboarding before it started.';
        store.writeJob(rec);
        store.clearActive(id);
        cancelled++;
      } else if (!TERMINAL_STATES.has(rec.state) || rec.processMayStillRun || rec.state === 'outcome_unknown') {
        if (!Number.isSafeInteger(rec.pid) || rec.pid! <= 1) throw unverifiable(id, `(${rec.state}) has no recorded process ID, so whether a program it started still runs cannot be verified`);
        processes.push({ pid: rec.pid!, identity: rec.pidIdentity, group: true, what: `job ${id} (process group ${rec.pid})` });
      }
    }
    return processes;
  });

  // A process group ID is never reused while the group exists. So a group whose leader was verified
  // during this shutdown, and that was seen at every check since, is still that job's group even
  // after its leader exited (members that handle SIGTERM more slowly). A group that was never
  // verified is never signalled, and once anything is seen gone it is never looked at again.
  const verified = new Set<Tracked>();
  const done = new Set<Tracked>();
  const signalled = new Set<Tracked>();
  const live = (p: Tracked): boolean => {
    if (done.has(p)) return false;
    const state = status(p.pid, p.identity);
    if (state === 'unknown') throw unconfirmed(`PID ${p.pid} of the ${p.what} is running but could not be verified as the recorded process`);
    if (state === 'same') {
      verified.add(p);
      return true;
    }
    if (p.group) {
      try {
        signal(-p.pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          done.add(p);
          return false;
        }
        throw unconfirmed(`Cannot inspect process group ${p.pid} of the ${p.what}`);
      }
      if (verified.has(p)) return true;
      throw unconfirmed(`Process group ${p.pid} of the ${p.what} still exists without a verified leader (the PID may have been reused)`);
    }
    done.add(p);
    return false;
  };
  // An entry that cannot be verified (or signalled) is never touched again, but does not keep the
  // verified ones running: they are still stopped, and the shutdown is then reported unconfirmed.
  const problems: Error[] = [];
  const alive = (p: Tracked): boolean => {
    try {
      return live(p);
    } catch (err) {
      problems.push(err as Error);
      done.add(p);
      return false;
    }
  };
  const send = (p: Tracked, sig: NodeJS.Signals) => {
    if (!alive(p)) return;
    try {
      signal(p.group ? -p.pid : p.pid, sig);
      signalled.add(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
      problems.push(err as Error);
      done.add(p);
    }
  };
  // Verify everything before anything is signalled: a stopping worker signals its own job groups,
  // so a leader checked only after the worker was signalled could already be gone.
  for (const p of tracked) alive(p);
  for (const p of tracked) send(p, 'SIGTERM');
  const started = Date.now();
  // Every entry is checked on every pass (no short-circuit), which the group rule above relies on.
  while (tracked.filter(alive).length) {
    if (Date.now() - started >= timeoutMs) throw unconfirmed(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for tracked durable-job processes to stop`);
    if (Date.now() - started >= 3500) for (const p of tracked) send(p, 'SIGKILL');
    await wait(100);
  }
  if (problems.length) throw problems[0];
  return store.lock.with(() => {
    const worker = store.readWorker();
    if (worker && status(worker.pid, worker.identity) !== 'gone') throw unconfirmed(`A job worker record (${store.workerFile}) appeared or changed during shutdown`);
    for (const id of store.allIds()) {
      const rec = store.readJob(id);
      if (!rec) throw unconfirmed(`Job ${id} lost its record during shutdown`);
      if (TERMINAL_STATES.has(rec.state) && !rec.processMayStillRun) continue;
      if (!seen.has(id)) throw unconfirmed(`Job ${id} appeared during shutdown (another server may use ${dir})`);
      if (TERMINAL_STATES.has(rec.state)) {
        rec.reason = `${rec.reason ? `${rec.reason} ` : ''}Its leftover process was stopped and verified gone by local offboarding.`;
      } else {
        rec.state = 'interrupted';
        rec.finishedAt = new Date().toISOString();
        if (rec.startedAt) rec.elapsedMs = Date.parse(rec.finishedAt) - Date.parse(rec.startedAt);
        rec.reason = 'Stopped and verified gone by local offboarding while it was running. It was NOT re-run; its effects may be partial.';
      }
      rec.processMayStillRun = false;
      store.writeJob(rec);
      store.clearActive(id);
    }
    fs.rmSync(store.workerFile, { force: true });
    writeAtomic(marker, JSON.stringify({ complete: true }) + '\n');
    return { cancelled, stopped: signalled.size };
  });
}

/** Explicit local opt-in only; ordinary reinstall must not resurrect offboarded work. */
export async function enableDurableJobs(dir: string): Promise<void> {
  const store = new JobStore(remotePaths(dir));
  if (!fs.lstatSync(store.root, { throwIfNoEntry: false })) return;
  assertPrivateDir(dir, 'Remote config directory');
  store.ensureDirs();
  await store.lock.with(() => {
    const marker = path.join(store.root, JOBS_DISABLED_FILE);
    const saved = readJson<{ complete: boolean }>(marker);
    if (saved && saved.complete !== true) throw new DurableStateError('Previous durable-job shutdown is unconfirmed; finish offboarding before enabling terminal tools.');
    fs.rmSync(marker, { force: true });
  });
}
