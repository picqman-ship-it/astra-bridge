import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DIST, load, waitFor } from './helpers.js';
import { makeRemoteDir, cleanupJobs, workerRecord, readJobRecord } from './remote-helpers.js';

const { loadRemoteConfig } = await load('remote/config.js');
const { JobStore, newJobId, TERMINAL_STATES } = await load('remote/jobs.js');
const { JobService } = await load('remote/job-service.js');
const { stopDurableJobs, enableDurableJobs, JOBS_DISABLED_FILE } = await load('remote/offboarding.js');
const { processStatus } = await load('remote/durable.js');

function storeFor(t) {
  const r = makeRemoteDir({ config: { trustedTerminal: true, jobs: { maxConcurrent: 1 } } });
  t.after(async () => { await cleanupJobs(r.dir); r.cleanup(); });
  const cfg = loadRemoteConfig(r.dir); const store = new JobStore(cfg); store.ensureDirs();
  return { r, cfg, store };
}

function queued(store, patch = {}) {
  const id = newJobId();
  const rec = { v: 1, id, state: 'queued', command: 'sleep 30', cwd: '/', shell: '/bin/sh', timeoutSec: 30,
    keyHash: 'a'.repeat(64), fingerprint: 'b'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stdout: { bytes: 0, dropped: 0 }, stderr: { bytes: 0, dropped: 0 }, progress: null, ...patch };
  store.createJob(rec); store.markActive(id); return rec;
}

test('offboarding cancels queued jobs without starting a worker and requires explicit local re-enable', async (t) => {
  const { r, cfg, store } = storeFor(t); const job = queued(store);
  const signals = [];
  await stopDurableJobs(r.dir, { signal: (...args) => signals.push(args) });
  assert.equal(store.readJob(job.id).state, 'cancelled'); assert.deepEqual(signals, []);
  assert.deepEqual(store.activeIds(), []);
  const service = new JobService(cfg);
  await assert.rejects(service.submit({ command: 'echo must-not-run', idempotencyKey: 'offboard-1' }), /disabled during offboarding/);
  await assert.rejects(service.ensureWorker(), /disabled during offboarding/);
  assert.equal(workerRecord(r.dir), null);
  await enableDurableJobs(r.dir);
  assert.equal(fs.existsSync(path.join(store.root, JOBS_DISABLED_FILE)), false);
  assert.equal(store.readJob(job.id).state, 'cancelled', 're-enable does not resurrect queued work');
});

test('offboarding stops a real detached worker and its running job; queued work never runs', async (t) => {
  const { r, cfg, store } = storeFor(t); const service = new JobService(cfg);
  const running = await service.submit({ command: 'sleep 30', idempotencyKey: 'running-offboard' });
  await waitFor(() => readJobRecord(r.dir, running.jobId).state === 'running', { timeout: 10_000 });
  const before = readJobRecord(r.dir, running.jobId); const worker = workerRecord(r.dir);
  const marker = path.join(r.work, 'must-not-exist');
  const pending = await service.submit({ command: `touch '${marker}'`, idempotencyKey: 'queued-offboard' });
  assert.equal(store.readJob(pending.jobId).state, 'queued');
  await stopDurableJobs(r.dir);
  assert.equal(processStatus(worker.pid, worker.identity), 'gone');
  assert.equal(processStatus(before.pid, before.pidIdentity), 'gone');
  assert.ok(TERMINAL_STATES.has(store.readJob(running.jobId).state));
  assert.equal(store.readJob(pending.jobId).state, 'cancelled');
  assert.equal(fs.existsSync(marker), false);
  await stopDurableJobs(r.dir); // repeatable, never launches a replacement worker
});

test('offboarding waits for a verified job group that outlives its leader instead of reporting it unconfirmed', async (t) => {
  const { r, cfg, store } = storeFor(t); const service = new JobService(cfg);
  const ready = path.join(r.work, 'member-ready');
  const exited = path.join(r.work, 'member-exited');
  // The leader (exec'd sleep) dies at once on SIGTERM; a background member of its group traps
  // SIGTERM and exits a moment later, so for a while the group exists without its leader. The
  // member does not hold the job's pipes, so the worker finishes and exits before it does.
  const member = `const fs = require('fs'); process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(process.argv[2], ''); process.exit(0); }, 700)); fs.writeFileSync(process.argv[1], ''); setInterval(() => {}, 1000)`;
  const command = `'${process.execPath}' -e "${member}" '${ready}' '${exited}' </dev/null >/dev/null 2>&1 & exec sleep 30`;
  const job = await service.submit({ command, idempotencyKey: 'group-outlives-leader' });
  await waitFor(() => fs.existsSync(ready) && readJobRecord(r.dir, job.jobId).state === 'running', { timeout: 15_000 });
  const rec = readJobRecord(r.dir, job.jobId);
  await stopDurableJobs(r.dir);
  assert.ok(fs.existsSync(exited), 'the member received SIGTERM and exited on its own');
  assert.throws(() => process.kill(-rec.pid, 0), { code: 'ESRCH' });
  assert.ok(TERMINAL_STATES.has(store.readJob(job.jobId).state));
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.root, JOBS_DISABLED_FILE), 'utf8')).complete, true);
});

for (const kind of ['unknown-worker', 'unknown-job', 'starting-without-pid', 'malformed-worker', 'malformed-job']) {
  test(`offboarding refuses ${kind}, retains evidence and never signals an unverified PID`, async (t) => {
    const { r, store } = storeFor(t); const signals = [];
    if (kind === 'malformed-worker') fs.writeFileSync(store.workerFile, '{bad', { mode: 0o600 });
    else if (kind === 'unknown-worker') fs.writeFileSync(store.workerFile, JSON.stringify({ pid: 313371, identity: 'unknown' }), { mode: 0o600 });
    else {
      const job = queued(store, kind === 'starting-without-pid' ? { state: 'starting' } : { state: 'running', pid: 313371, pidIdentity: 'unknown' });
      if (kind === 'malformed-job') fs.writeFileSync(path.join(store.jobDir(job.id), 'job.json'), '{bad');
    }
    await assert.rejects(stopDurableJobs(r.dir, { status: () => 'unknown', signal: (...args) => signals.push(args) }), /unknown|unconfirmed|malformed/);
    assert.deepEqual(signals, []);
    assert.ok(fs.existsSync(store.root));
    await assert.rejects(enableDurableJobs(r.dir), /shutdown is unconfirmed/);
  });
}

test('offboarding never signals a reused worker PID and never reports an unverifiable surviving group stopped', async (t) => {
  const { r, store } = storeFor(t); const signals = [];
  fs.writeFileSync(store.workerFile, JSON.stringify({ pid: 313371, identity: 'old' }), { mode: 0o600 });
  await stopDurableJobs(r.dir, { status: () => 'gone', signal: (...args) => signals.push(args) });
  assert.deepEqual(signals, []);
  queued(store, { state: 'interrupted', processMayStillRun: true, pid: 313372, pidIdentity: 'old' });
  await assert.rejects(stopDurableJobs(r.dir, { status: () => 'gone', signal: (...args) => signals.push(args) }), /without a verified leader/);
  assert.deepEqual(signals, [[-313372, 0]], 'only a liveness probe, never a destructive signal');
});

test('offboarding still stops verified processes when another entry is unverifiable, and reports it unconfirmed', async (t) => {
  const { r, store } = storeFor(t); const signals = [];
  fs.writeFileSync(store.workerFile, JSON.stringify({ pid: 313371, identity: 'w' }), { mode: 0o600 });
  queued(store, { state: 'running', pid: 313372, pidIdentity: 'j' });
  let stopped = false;
  const status = (pid) => (pid === 313372 ? 'unknown' : stopped ? 'gone' : 'same');
  await assert.rejects(stopDurableJobs(r.dir, { status, signal: (...args) => { signals.push(args); stopped = true; } }),
    /PID 313372 .* could not be verified.*unconfirmed/);
  assert.deepEqual(signals, [[313371, 'SIGTERM']], 'the verified worker is stopped; the unverifiable group is never signalled');
  await assert.rejects(enableDurableJobs(r.dir), /unconfirmed/);
});

test('a dead worker without a recorded identity does not block offboarding; a live one does', async (t) => {
  const { r, store } = storeFor(t); const signals = [];
  fs.writeFileSync(store.workerFile, JSON.stringify({ pid: 313371, identity: null }), { mode: 0o600 });
  await assert.rejects(stopDurableJobs(r.dir, { status: () => 'unknown', signal: (...args) => signals.push(args) }), /could not be verified/);
  assert.deepEqual(await stopDurableJobs(r.dir, { status: () => 'gone', signal: (...args) => signals.push(args) }), { cancelled: 0, stopped: 0 });
  assert.deepEqual(signals, []);
  assert.equal(workerRecord(r.dir), null);
});

test('a job that appears during shutdown is never reported stopped', async (t) => {
  const { r, store } = storeFor(t); let calls = 0; let injected;
  fs.writeFileSync(store.workerFile, JSON.stringify({ pid: 313371, identity: 'w' }), { mode: 0o600 });
  await assert.rejects(stopDurableJobs(r.dir, {
    status: () => (calls++ < 3 ? 'same' : 'gone'),
    signal: () => {},
    wait: async () => { injected ??= queued(store, { state: 'running', pid: 313372, pidIdentity: 'x' }); },
  }), /appeared during shutdown/);
  assert.equal(store.readJob(injected.id).state, 'running');
  await assert.rejects(enableDurableJobs(r.dir), /unconfirmed/);
});

test('a finished job with a leftover process keeps its outcome once the process is verified gone', async (t) => {
  const { r, store } = storeFor(t); const signals = []; let calls = 0;
  const job = queued(store, { state: 'outcome_unknown', processMayStillRun: true, pid: 313372, pidIdentity: 'j', reason: 'Whether the command ran is unknown.' });
  const result = await stopDurableJobs(r.dir, {
    status: () => (calls++ < 2 ? 'same' : 'gone'),
    signal: (pid, sig) => { signals.push([pid, sig]); if (sig === 0) throw Object.assign(new Error('no such group'), { code: 'ESRCH' }); },
  });
  assert.deepEqual(result, { cancelled: 0, stopped: 1 });
  assert.deepEqual(signals, [[-313372, 'SIGTERM'], [-313372, 0]]);
  const after = store.readJob(job.id);
  assert.equal(after.state, 'outcome_unknown');
  assert.equal(after.processMayStillRun, false);
  assert.match(after.reason, /unknown\. Its leftover process was stopped and verified gone/);
  assert.deepEqual(store.activeIds(), []);
});

test('offboarding stop failure remains incomplete and symlinked durable state is refused', async (t) => {
  const { r, store } = storeFor(t);
  fs.writeFileSync(store.workerFile, JSON.stringify({ pid: 313371, identity: 'same' }), { mode: 0o600 });
  await assert.rejects(stopDurableJobs(r.dir, { status: () => 'same', signal: () => { throw new Error('signal denied'); } }), /signal denied/);
  await assert.rejects(enableDurableJobs(r.dir), /unconfirmed/);
  fs.renameSync(store.root, `${store.root}-saved`); fs.symlinkSync(`${store.root}-saved`, store.root);
  await assert.rejects(stopDurableJobs(r.dir), /symlinks are refused/);
});

test('a worker spawned just before offboarding cannot claim the store or overwrite unresolved evidence', async (t) => {
  const { r, store } = storeFor(t);
  const evidence = '{bad';
  fs.writeFileSync(store.workerFile, evidence, { mode: 0o600 });
  fs.writeFileSync(path.join(store.root, JOBS_DISABLED_FILE), JSON.stringify({ complete: false }), { mode: 0o600 });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIST, 'remote/job-worker.js'), '--remote-dir', r.dir], { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', resolve);
  });
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(store.workerFile, 'utf8'), evidence);
});
