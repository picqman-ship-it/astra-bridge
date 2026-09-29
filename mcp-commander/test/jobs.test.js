// Durable jobs: storage primitives, the MCP job tools over real HTTP + SDK, concurrency/queue
// bounds, cancellation, timeouts, log caps, revalidation before execution, fail-closed state,
// worker death (interrupted / outcome_unknown, never replayed) and survival of HTTP server
// SIGKILL/SIGTERM restarts. Temp remote dirs and harmless shell commands only; every test cleans
// up its worker and job processes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DIST, load, sleep, textOf, tmpDir, rmrf, waitFor } from './helpers.js';
import {
  alive, cleanupJobs, connectHttp, freePort, jobJson, makeRemoteDir, readJobRecord, startChild, startInProcess,
  stopChild, TEST_JOBS, waitJob, workerRecord,
} from './remote-helpers.js';

const durable = await load('remote/durable.js');
const jobsMod = await load('remote/jobs.js');
const { remoteToolNames, JOB_TOOLS } = await load('remote/policy.js');

const DURABLE_JS = pathToFileURL(path.join(DIST, 'remote', 'durable.js')).href;
const uuid = () => crypto.randomUUID();
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

describe('durable storage primitives', () => {
  it('createExclusive lets exactly one of many concurrent processes claim a record', async () => {
    const dir = tmpDir('mcpc-durable-');
    try {
      const target = path.join(dir, 'claim.json');
      const code = `
        const { createExclusive } = await import(${JSON.stringify(DURABLE_JS)});
        await new Promise((r) => setTimeout(r, 200 - (Date.now() % 200)));
        process.stdout.write(createExclusive(process.argv[1], JSON.stringify({ pid: process.pid })) ? 'won' : 'lost');`;
      const kids = Array.from({ length: 8 }, () =>
        new Promise((resolve) => {
          const c = spawn(process.execPath, ['--input-type=module', '-e', code, target], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          c.stdout.on('data', (d) => (out += d));
          c.on('exit', () => resolve(out));
        }),
      );
      const results = await Promise.all(kids);
      assert.equal(results.filter((r) => r === 'won').length, 1, results.join(','));
      assert.equal(results.filter((r) => r === 'lost').length, 7);
      const rec = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.ok(rec.pid > 0);
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(dir), ['claim.json'], 'no temp files left behind');
    } finally {
      rmrf(dir);
    }
  });

  it('FileLock gives mutual exclusion across processes and breaks a lock left by a dead process', async () => {
    const dir = tmpDir('mcpc-lock-');
    try {
      const counter = path.join(dir, 'counter');
      fs.writeFileSync(counter, '0');
      const code = `
        const fs = await import('node:fs');
        const { FileLock } = await import(${JSON.stringify(DURABLE_JS)});
        const lock = new FileLock(process.argv[1]);
        for (let i = 0; i < 25; i++) {
          await lock.with(async () => {
            const n = Number(fs.readFileSync(process.argv[2], 'utf8'));
            await new Promise((r) => setImmediate(r));
            fs.writeFileSync(process.argv[2], String(n + 1));
          });
        }`;
      const kids = Array.from({ length: 4 }, () =>
        new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', code, path.join(dir, 'lock'), counter], { stdio: 'ignore' }).on('exit', resolve)),
      );
      assert.deepEqual(await Promise.all(kids), [0, 0, 0, 0]);
      assert.equal(fs.readFileSync(counter, 'utf8'), '100');

      // A lock whose owner PID is gone is broken; one held by a live process is respected.
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
      fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: Number(dead.stdout), nonce: 'x', at: Date.now() }));
      const lock = new durable.FileLock(path.join(dir, 'lock'));
      const release = await lock.acquire(2000);
      await assert.rejects(new durable.FileLock(path.join(dir, 'lock')).acquire(300), /Timed out waiting/);
      release();
      assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
    } finally {
      rmrf(dir);
    }
  });

  it('FileLock never robs a live owner, however old; a confirmed-gone owner (dead or PID reused) is broken safely', async () => {
    const dir = tmpDir('mcpc-lock-live-');
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await waitFor(() => durable.processIdentity(holder.pid));
      const lockFile = path.join(dir, 'lock');
      const old = Date.now() - 10 * 60_000;
      fs.writeFileSync(lockFile, JSON.stringify({ pid: holder.pid, identity: durable.processIdentity(holder.pid), nonce: 'live-old', at: old }), { mode: 0o600 });
      fs.utimesSync(lockFile, new Date(old), new Date(old));
      // Several contenders at once, with a tiny identity-check threshold: all must time out.
      const contenders = Array.from({ length: 4 }, () => new durable.FileLock(lockFile, 1).acquire(400));
      const results = await Promise.allSettled(contenders);
      assert.ok(results.every((r) => r.status === 'rejected' && /Timed out waiting.*running or could not be confirmed gone/.test(r.reason.message)));
      assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce, 'live-old', 'the live owner still holds it');

      // Same live PID but a different recorded start time = the PID was reused: the owner is gone.
      fs.writeFileSync(lockFile, JSON.stringify({ pid: holder.pid, identity: `${holder.pid} Thu Jan  1 00:00:00 1970`, nonce: 'reused', at: old }), { mode: 0o600 });
      const release = await new durable.FileLock(lockFile, 1).acquire(3000);
      release();

      // Many processes racing to break one dead owner's lock still get strict mutual exclusion.
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
      fs.writeFileSync(lockFile, JSON.stringify({ pid: Number(dead.stdout), identity: null, nonce: 'dead', at: old }), { mode: 0o600 });
      const counter = path.join(dir, 'counter');
      fs.writeFileSync(counter, '0');
      const code = `
        const fs = await import('node:fs');
        const { FileLock } = await import(${JSON.stringify(DURABLE_JS)});
        const lock = new FileLock(process.argv[1]);
        for (let i = 0; i < 10; i++) {
          await lock.with(async () => {
            const n = Number(fs.readFileSync(process.argv[2], 'utf8'));
            await new Promise((r) => setTimeout(r, 2));
            fs.writeFileSync(process.argv[2], String(n + 1));
          });
        }`;
      const kids = Array.from({ length: 5 }, () =>
        new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', code, lockFile, counter], { stdio: 'ignore' }).on('exit', resolve)),
      );
      assert.deepEqual(await Promise.all(kids), [0, 0, 0, 0, 0]);
      assert.equal(fs.readFileSync(counter, 'utf8'), '50');
      assert.deepEqual(fs.readdirSync(dir).sort(), ['counter'], 'no lock, break or temp files left');

      // A breaker that died mid-break leaves lock.break behind: recovery fails closed within the
      // deadline (no busy loop, nothing removed) and names both files for manual recovery.
      fs.writeFileSync(lockFile, JSON.stringify({ pid: Number(dead.stdout), identity: null, nonce: 'dead2', at: old }), { mode: 0o600 });
      fs.writeFileSync(`${lockFile}.break`, JSON.stringify({ pid: Number(dead.stdout), identity: null, nonce: 'breaker', at: old }), { mode: 0o600 });
      const t0 = Date.now();
      await assert.rejects(new durable.FileLock(lockFile).acquire(300), /Timed out waiting.*lock\.break/);
      assert.ok(Date.now() - t0 < 2000, 'the deadline is honoured');
      assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce, 'dead2');
    } finally {
      holder.kill('SIGKILL');
      rmrf(dir);
    }
  });

  it('refuses symlinks, foreign modes and malformed records', () => {
    const dir = tmpDir('mcpc-durable-');
    try {
      const priv = path.join(dir, 'p');
      durable.ensurePrivateDir(priv);
      assert.equal(fs.statSync(priv).mode & 0o777, 0o700);
      fs.mkdirSync(path.join(dir, 'open'), { mode: 0o755 });
      fs.chmodSync(path.join(dir, 'open'), 0o755);
      assert.throws(() => durable.ensurePrivateDir(path.join(dir, 'open')), /must be 0700/);
      fs.symlinkSync(priv, path.join(dir, 'link'));
      assert.throws(() => durable.ensurePrivateDir(path.join(dir, 'link')), /not a real directory/);

      fs.writeFileSync(path.join(dir, 'target.json'), '{"a":1}');
      fs.symlinkSync(path.join(dir, 'target.json'), path.join(priv, 'rec.json'));
      assert.throws(() => durable.readJson(path.join(priv, 'rec.json')), /symbolic link/);
      fs.writeFileSync(path.join(priv, 'bad.json'), '{"a":', { mode: 0o600 });
      assert.throws(() => durable.readJson(path.join(priv, 'bad.json')), /malformed/);
      assert.equal(durable.readJson(path.join(priv, 'missing.json')), null);
      // writeAtomic over a planted symlink replaces the link, never writes through it.
      durable.writeAtomic(path.join(priv, 'rec.json'), '{"b":2}');
      assert.equal(fs.readFileSync(path.join(dir, 'target.json'), 'utf8'), '{"a":1}');
      assert.equal(fs.lstatSync(path.join(priv, 'rec.json')).isSymbolicLink(), false);
    } finally {
      rmrf(dir);
    }
  });

  it('validates job ids and parses only explicit progress lines', () => {
    assert.ok(jobsMod.isJobId(jobsMod.newJobId()));
    for (const bad of ['../x', 'j../../etc', '', 'jABC-0123456789abcdef', `j0mg1abcd-0123456789abcdef/..`]) assert.equal(jobsMod.isJobId(bad), false, bad);
    assert.deepEqual(jobsMod.parseProgress('MCPC_PROGRESS 3/10 copying'), { done: 3, total: 10, percent: 30, message: 'copying' });
    assert.deepEqual(jobsMod.parseProgress('MCPC_PROGRESS 40%'), { percent: 40, message: undefined });
    for (const bad of ['progress 40%', 'MCPC_PROGRESS 140%', 'MCPC_PROGRESS 11/10', 'MCPC_PROGRESS x']) assert.equal(jobsMod.parseProgress(bad), null, bad);
    assert.deepEqual(JSON.parse(durable.canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })), { a: { d: [2, { y: 2, z: 1 }] }, b: 1 });
    assert.equal(durable.canonicalJson({ b: 1, a: 2 }), durable.canonicalJson({ a: 2, b: 1 }));
  });
});

describe('durable jobs over HTTP (real SDK round trips)', () => {
  let s;
  let c;
  before(async () => {
    s = await startInProcess({ trustedTerminal: true, jobs: { ...TEST_JOBS, maxConcurrent: 2, maxQueued: 4 } });
    c = await connectHttp(s.port, s.token);
  });
  after(async () => {
    await c?.close();
    await s?.close();
  });

  it('exposes exactly the trusted remote tool set: 27 tools, job tools included, no config mutation', async () => {
    const tools = (await c.client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...remoteToolNames(true)].sort());
    assert.equal(names.length, 27);
    for (const t of JOB_TOOLS) assert.ok(names.includes(t), t);
    assert.ok(!names.includes('set_config_value'));
    const start = tools.find((t) => t.name === 'job_start');
    assert.ok(start.inputSchema.required.includes('idempotencyKey'));
    assert.ok(start.inputSchema.required.includes('command'));
  });

  it('runs a job to completion: exit code, separate stdout/stderr logs, self-reported progress, listing', async () => {
    const missingKey = await c.call('job_start', { command: 'echo hi' }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }));
    assert.equal(missingKey.isError, true);

    const r = await c.call('job_start', {
      command: "printf 'MCPC_PROGRESS 1/2 half\\n'; echo out-line; echo err-line >&2; exit 3",
      idempotencyKey: uuid(),
      label: 'round trip',
    });
    const started = jobJson(r);
    assert.ok(jobsMod.isJobId(started.jobId), JSON.stringify(started));
    assert.equal(started.deduplicated, false);
    assert.equal(started.cwd, s.work);
    const done = await waitJob(c.call, started.jobId);
    assert.equal(done.state, 'failed');
    assert.equal(done.exitCode, 3);
    assert.ok(done.elapsedMs >= 0 && done.startedAt && done.finishedAt);
    assert.deepEqual({ ...done.progress, at: undefined }, { done: 1, total: 2, percent: 50, message: 'half', at: undefined });
    assert.equal(done.stdout.dropped, 0);

    const out = await c.call('job_logs', { jobId: started.jobId });
    const meta = jobJson(out);
    assert.equal(meta.endOfLog, true);
    assert.match(out.content[1].text, /out-line/);
    assert.doesNotMatch(out.content[1].text, /err-line/);
    const err = await c.call('job_logs', { jobId: started.jobId, stream: 'stderr' });
    assert.match(err.content[1].text, /err-line/);
    const tail = await c.call('job_logs', { jobId: started.jobId, offset: -9 });
    assert.equal(tail.content[1].text, 'out-line\n');
    assert.equal(jobJson(tail).nextOffset, meta.size);

    const list = jobJson(await c.call('job_list', {}));
    assert.ok(list.jobs.some((j) => j.jobId === started.jobId && j.label === 'round trip' && j.exitCode === 3));
    const noProgress = await waitJob(c.call, jobJson(await c.call('job_start', { command: 'true', idempotencyKey: uuid() })).jobId);
    assert.equal(noProgress.state, 'succeeded');
    assert.equal(noProgress.progress, null, 'no invented progress');
  });

  it('two simultaneous submissions with one key from two clients start ONE job (one marker line, one PID)', async () => {
    const other = await connectHttp(s.port, s.token);
    try {
      const marker = path.join(s.work, `marker-${uuid()}.txt`);
      const key = uuid();
      const args = { command: `echo "$$" >> '${marker}'; sleep 0.5`, idempotencyKey: key };
      const [a, b] = await Promise.all([c.call('job_start', args), other.call('job_start', args)]);
      const ja = jobJson(a);
      const jb = jobJson(b);
      assert.equal(ja.jobId, jb.jobId);
      assert.deepEqual([ja.deduplicated, jb.deduplicated].sort(), [false, true]);
      const done = await waitJob(c.call, ja.jobId);
      assert.equal(done.state, 'succeeded');
      assert.deepEqual(lines(marker), [String(done.pid)], 'exactly one execution, by the recorded PID');

      const again = jobJson(await other.call('job_start', args));
      assert.equal(again.jobId, ja.jobId);
      assert.equal(again.deduplicated, true);
      assert.equal(again.state, 'succeeded');

      const before = jobJson(await c.call('job_list', { limit: 200 })).total;
      const conflict = await c.call('job_start', { ...args, command: `${args.command}; echo changed` });
      assert.equal(conflict.isError, true);
      assert.match(textOf(conflict), /already used for a different job request/);
      const conflict2 = await c.call('job_start', { ...args, timeoutSeconds: 99 });
      assert.equal(conflict2.isError, true);
      assert.equal(jobJson(await c.call('job_list', { limit: 200 })).total, before, 'no job created by a conflicting request');
      assert.deepEqual(lines(marker), [String(done.pid)]);
    } finally {
      await other.close();
    }
  });

  it('validates command, shell, cwd and job ids before anything is recorded', async () => {
    const before = jobJson(await c.call('job_list', { limit: 200 })).total;
    const sudo = await c.call('job_start', { command: 'echo x && sudo ls', idempotencyKey: uuid() });
    assert.equal(sudo.isError, true);
    assert.match(textOf(sudo), /blocked: sudo/);
    const outside = await c.call('job_start', { command: 'pwd', cwd: s.base, idempotencyKey: uuid() });
    assert.equal(outside.isError, true);
    assert.match(textOf(outside), /not allowed/);
    fs.symlinkSync(s.base, path.join(s.work, 'mnt-link'));
    const viaLink = await c.call('job_start', { command: 'pwd', cwd: path.join(s.work, 'mnt-link'), idempotencyKey: uuid() });
    assert.equal(viaLink.isError, true, 'a link to a location outside the roots (e.g. another volume) is refused');
    const missing = await c.call('job_start', { command: 'pwd', cwd: path.join(s.work, 'Volumes-not-mounted'), idempotencyKey: uuid() });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /does not exist/);
    const shortKey = await c.call('job_start', { command: 'pwd', idempotencyKey: 'abc' });
    assert.equal(shortKey.isError, true);
    assert.equal(jobJson(await c.call('job_list', { limit: 200 })).total, before);
    for (const jobId of ['../../etc/passwd', 'j0000000-zzzz', '']) {
      const r = await c.call('job_status', { jobId });
      assert.equal(r.isError, true, jobId);
      assert.match(textOf(r), /Invalid job id/);
    }
    assert.equal((await c.call('job_status', { jobId: jobsMod.newJobId() })).isError, true);
  });

  it('bounds concurrency and queue size; cancels queued and running jobs', async () => {
    const running = [];
    for (let i = 0; i < 2; i++) {
      running.push(jobJson(await c.call('job_start', { command: `echo busy${i}; exec sleep 30`, idempotencyKey: uuid() })).jobId);
    }
    for (const id of running) await waitJob(c.call, id, { until: (st) => st.state === 'running' });
    const queued = [];
    for (let i = 0; i < 4; i++) queued.push(jobJson(await c.call('job_start', { command: 'echo never', idempotencyKey: uuid() })).jobId);
    await sleep(600);
    for (const id of queued) assert.equal(jobJson(await c.call('job_status', { jobId: id })).state, 'queued', 'concurrency bound holds');
    const full = await c.call('job_start', { command: 'echo over', idempotencyKey: uuid() });
    assert.equal(full.isError, true);
    assert.match(textOf(full), /queue is full/);

    const cq = jobJson(await c.call('job_cancel', { jobId: queued[0] }));
    assert.equal(cq.state, 'cancelled');
    assert.match(cq.action, /before it started/);
    assert.equal(cq.startedAt, null);
    for (const id of queued.slice(1)) await c.call('job_cancel', { jobId: id, wait_ms: 0 });

    const pid = jobJson(await c.call('job_status', { jobId: running[0] })).pid;
    assert.ok(alive(pid));
    const cr = jobJson(await c.call('job_cancel', { jobId: running[0], wait_ms: 8000 }));
    assert.equal(cr.state, 'cancelled', JSON.stringify(cr));
    assert.ok(cr.cancelRequestedAt);
    await waitFor(() => !alive(pid), { timeout: 5000 });
    const again = jobJson(await c.call('job_cancel', { jobId: running[0] }));
    assert.match(again.action, /already finished/);
    jobJson(await c.call('job_cancel', { jobId: running[1], wait_ms: 8000 }));
    for (const id of queued) assert.equal(jobJson(await c.call('job_status', { jobId: id })).state, 'cancelled');
    assert.equal(lines(path.join(s.work, 'never')).length, 0);
  });

  it('stops a job at its timeout', async () => {
    const id = jobJson(await c.call('job_start', { command: 'exec sleep 30', timeoutSeconds: 1, idempotencyKey: uuid() })).jobId;
    const st = await waitJob(c.call, id, { timeout: 10_000 });
    assert.equal(st.state, 'timed_out');
    assert.equal(st.signal, 'SIGTERM');
    assert.ok(st.elapsedMs >= 900 && st.elapsedMs < 6000, String(st.elapsedMs));
    assert.ok(!alive(st.pid));
  });

  it('revalidates before execution: a cwd removed or swapped for a link while queued is not used', async () => {
    const blockers = [];
    for (let i = 0; i < 2; i++) blockers.push(jobJson(await c.call('job_start', { command: 'sleep 1.5', idempotencyKey: uuid() })).jobId);
    const gone = path.join(s.work, 'will-vanish');
    const swapped = path.join(s.work, 'will-be-link');
    fs.mkdirSync(gone);
    fs.mkdirSync(swapped);
    const outside = path.join(s.base, 'outside-dir');
    fs.mkdirSync(outside);
    const j1 = jobJson(await c.call('job_start', { command: 'touch ran-here', cwd: gone, idempotencyKey: uuid() })).jobId;
    const j2 = jobJson(await c.call('job_start', { command: 'touch ran-here', cwd: swapped, idempotencyKey: uuid() })).jobId;
    fs.rmSync(gone, { recursive: true });
    fs.rmSync(swapped, { recursive: true });
    fs.symlinkSync(outside, swapped);
    const s1 = await waitJob(c.call, j1, { timeout: 15_000 });
    const s2 = await waitJob(c.call, j2, { timeout: 15_000 });
    assert.equal(s1.state, 'failed');
    assert.match(s1.reason, /Not started: cwd does not exist/);
    assert.equal(s1.startedAt, null);
    assert.equal(s2.state, 'failed');
    assert.match(s2.reason, /Not started/);
    assert.equal(fs.existsSync(path.join(outside, 'ran-here')), false);
    for (const id of blockers) assert.equal((await waitJob(c.call, id)).state, 'succeeded');
  });

  it('a retry of an accepted job still returns it after its cwd disappeared (e.g. a volume was unmounted)', async () => {
    const vol = path.join(s.work, 'volume');
    fs.mkdirSync(vol);
    const args = { command: 'echo on-volume', cwd: vol, idempotencyKey: uuid() };
    const first = jobJson(await c.call('job_start', args));
    assert.equal((await waitJob(c.call, first.jobId)).state, 'succeeded');
    fs.rmSync(vol, { recursive: true });
    const retry = jobJson(await c.call('job_start', args));
    assert.equal(retry.jobId, first.jobId);
    assert.equal(retry.deduplicated, true);
    const fresh = await c.call('job_start', { ...args, idempotencyKey: uuid() });
    assert.equal(fresh.isError, true, 'a NEW job for the missing cwd is refused');
    assert.match(textOf(fresh), /does not exist/);
  });

  it('job_status and job_list are read-only; only job_start/job_cancel and server supervision start a worker', async () => {
    const tools = (await c.client.listTools()).tools;
    const ann = (n) => tools.find((t) => t.name === n).annotations ?? {};
    for (const n of ['job_status', 'job_list', 'job_logs']) assert.equal(ann(n).readOnlyHint, true, n);
    for (const n of ['job_start', 'job_cancel']) assert.equal(ann(n).readOnlyHint, false, n);
  });

  it('bounded large file tree and many concurrent short jobs', async () => {
    const tree = path.join(s.work, 'tree');
    for (let d = 0; d < 30; d++) {
      fs.mkdirSync(path.join(tree, `d${d}`), { recursive: true });
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(tree, `d${d}`, `f${f}.txt`), 'x');
    }
    const count = jobJson(await c.call('job_start', { command: 'find . -type f | wc -l', cwd: tree, idempotencyKey: uuid() })).jobId;
    assert.equal((await waitJob(c.call, count)).state, 'succeeded');
    assert.equal(jobJson(await c.call('job_logs', { jobId: count })).size > 0, true);
    assert.equal((await c.call('job_logs', { jobId: count })).content[1].text.trim(), '3000');

    // More submissions than queue slots arrive at once: every accepted job runs, the rest are refused.
    const counts = path.join(s.work, 'concurrency.txt');
    const cmd = `mkdir -p run; touch "run/$MCPC_JOB_ID"; ls run | wc -l >> '${counts}'; sleep 0.2; rm "run/$MCPC_JOB_ID"`;
    const results = await Promise.all(Array.from({ length: 12 }, () => c.call('job_start', { command: cmd, idempotencyKey: uuid() })));
    const accepted = results.filter((r) => !r.isError).map((r) => jobJson(r).jobId);
    const refused = results.filter((r) => r.isError);
    assert.ok(accepted.length >= 4, `accepted ${accepted.length}`);
    for (const r of refused) assert.match(textOf(r), /queue is full/);
    for (const id of accepted) assert.equal((await waitJob(c.call, id)).state, 'succeeded');
    const seen = lines(counts).map(Number);
    assert.equal(seen.length, accepted.length);
    assert.ok(Math.max(...seen) <= 2, `never more than 2 at once: ${seen.join(',')}`);
  });

  it('fails closed on corrupted, unwritable or full state, before anything runs', async () => {
    const root = path.join(s.dir, 'durable');
    const fakeId = jobsMod.newJobId();
    fs.mkdirSync(path.join(root, 'jobs', fakeId), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'jobs', fakeId, 'job.json'), '{"v":1,"id":', { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'active', fakeId), '', { mode: 0o600 });
    const marker = path.join(s.work, `fc-${uuid()}`);
    try {
      const r = await c.call('job_start', { command: `touch '${marker}'`, idempotencyKey: uuid() });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /fail closed/);
      const list = jobJson(await c.call('job_list', { limit: 200 }));
      assert.ok(list.jobs.some((j) => j.id === fakeId && j.state === 'unreadable'));
    } finally {
      fs.rmSync(path.join(root, 'active', fakeId));
      fs.rmSync(path.join(root, 'jobs', fakeId), { recursive: true });
    }

    fs.chmodSync(path.join(root, 'jobs'), 0o500);
    try {
      const r = await c.call('job_start', { command: `touch '${marker}'`, idempotencyKey: uuid() });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /EACCES|fail closed/);
    } finally {
      fs.chmodSync(path.join(root, 'jobs'), 0o700);
    }

    // Disk full, injected while the job record is written (after the key was claimed).
    const key = uuid();
    durable.faults.beforeWrite = (file) => {
      if (file.includes(`${path.sep}jobs${path.sep}.new-`)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    try {
      const r = await c.call('job_start', { command: `touch '${marker}'`, idempotencyKey: key });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /ENOSPC/);
    } finally {
      durable.faults.beforeWrite = undefined;
    }
    const retry = jobJson(await c.call('job_start', { command: `touch '${marker}'`, idempotencyKey: key }));
    assert.equal(retry.state, 'never_started');
    assert.match(retry.warning, /Nothing was started/);
    // Disk full while claiming the key: nothing is claimed, so the same key works afterwards.
    const key2 = uuid();
    durable.faults.beforeWrite = (file) => {
      if (file.includes(`${path.sep}jobkeys${path.sep}`)) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    };
    try {
      assert.equal((await c.call('job_start', { command: 'true', idempotencyKey: key2 })).isError, true);
    } finally {
      durable.faults.beforeWrite = undefined;
    }
    await sleep(500);
    assert.equal(fs.existsSync(marker), false, 'nothing ran');
    const ok = jobJson(await c.call('job_start', { command: 'true', idempotencyKey: key2 }));
    assert.equal(ok.deduplicated, false);
    assert.equal((await waitJob(c.call, ok.jobId)).state, 'succeeded');
  });
});

describe('job log cap and store capacity', () => {
  it('stores at most maxLogBytes per stream and counts the rest; refuses new jobs when the store is full', async () => {
    const s = await startInProcess({ trustedTerminal: true, jobs: { ...TEST_JOBS, maxLogBytes: 4096, maxJobRecords: 4 } });
    const c = await connectHttp(s.port, s.token);
    try {
      const id = jobJson(await c.call('job_start', { command: "head -c 100000 /dev/zero | tr '\\0' x; head -c 5000 /dev/zero | tr '\\0' y >&2", idempotencyKey: uuid() })).jobId;
      const st = await waitJob(c.call, id);
      assert.equal(st.state, 'succeeded');
      assert.deepEqual(st.stdout, { bytes: 4096, dropped: 100000 - 4096 });
      assert.deepEqual(st.stderr, { bytes: 4096, dropped: 5000 - 4096 });
      assert.equal(fs.statSync(path.join(s.dir, 'durable', 'jobs', id, 'stdout.log')).size, 4096);
      const logs = jobJson(await c.call('job_logs', { jobId: id, length: 65536 }));
      assert.equal(logs.size, 4096);
      assert.equal(logs.droppedAfterLimit, 95904);
      for (let i = 0; i < 3; i++) await c.call('job_start', { command: 'true', idempotencyKey: uuid() });
      const full = await c.call('job_start', { command: 'true', idempotencyKey: uuid() });
      assert.equal(full.isError, true);
      assert.match(textOf(full), /Job store is full \(4 job records/);
      const perms = fs.statSync(path.join(s.dir, 'durable')).mode & 0o777;
      assert.equal(perms, 0o700);
      const rec = fs.statSync(path.join(s.dir, 'durable', 'jobs', id, 'job.json')).mode & 0o777;
      assert.equal(rec, 0o600);
    } finally {
      await c.close();
      await s.close();
    }
  });

  it('file-only mode exposes no job tools and creates no worker', async () => {
    const s = await startInProcess();
    const c = await connectHttp(s.port, s.token);
    try {
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      assert.equal(names.length, 15);
      for (const t of JOB_TOOLS) assert.ok(!names.includes(t), t);
      const r = await c.call('job_start', { command: 'echo x', idempotencyKey: uuid() }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }));
      assert.equal(r.isError, true);
      assert.equal(workerRecord(s.dir), null);
    } finally {
      await c.close();
      await s.close();
    }
  });
});

describe('worker death: interrupted / outcome_unknown, never replayed; queued jobs survive', () => {
  it('marks the running job interrupted, runs the queued one, and cancels a verified leftover process', async () => {
    const s = await startInProcess({ trustedTerminal: true, jobs: { ...TEST_JOBS, maxConcurrent: 1 } });
    const c = await connectHttp(s.port, s.token);
    try {
      const marker = path.join(s.work, 'runs.txt');
      const first = jobJson(await c.call('job_start', { command: `echo run >> '${marker}'; exec sleep 30`, idempotencyKey: uuid() })).jobId;
      const running = await waitJob(c.call, first, { until: (st) => st.state === 'running' });
      const second = jobJson(await c.call('job_start', { command: `echo second >> '${marker}'`, idempotencyKey: uuid() })).jobId;
      const w = workerRecord(s.dir);
      assert.ok(w && alive(w.pid));
      process.kill(w.pid, 'SIGKILL');
      await waitFor(() => !alive(w.pid), { timeout: 5000 });
      assert.ok(alive(running.pid), 'the job process outlives its worker (it is not killed blindly)');

      // A later job call notices the dead worker and starts a new one, which recovers.
      const st = await waitJob(c.call, first, { timeout: 15_000 });
      assert.equal(st.state, 'interrupted');
      assert.match(st.reason, /NOT resumed or re-run/);
      assert.equal(st.processMayStillRun, true);
      assert.equal((await waitJob(c.call, second, { timeout: 15_000 })).state, 'succeeded', 'the queued job did not vanish');
      assert.deepEqual(lines(marker), ['run', 'second'], 'the interrupted command was not re-run');
      const w2 = workerRecord(s.dir);
      assert.ok(!w2 || w2.nonce !== w.nonce);

      const cancelled = jobJson(await c.call('job_cancel', { jobId: first, wait_ms: 5000 }));
      assert.match(cancelled.action, /identity verified/);
      await waitFor(() => !alive(running.pid), { timeout: 5000 });
      assert.equal(readJobRecord(s.dir, first).state, 'interrupted');
    } finally {
      await c.close();
      await s.close();
    }
  });

  it('a job left in "starting" by a dead worker becomes outcome_unknown and is not run', async () => {
    const s = await startInProcess({ trustedTerminal: true, jobs: TEST_JOBS });
    const c = await connectHttp(s.port, s.token);
    try {
      // Create the store through a normal job, then plant a record exactly as a worker that died
      // between writing "starting" and spawning would leave it.
      await waitJob(c.call, jobJson(await c.call('job_start', { command: 'true', idempotencyKey: uuid() })).jobId);
      const root = path.join(s.dir, 'durable');
      const id = jobsMod.newJobId();
      const marker = path.join(s.work, 'must-not-exist');
      const at = new Date().toISOString();
      const rec = {
        v: 1, id, state: 'starting', command: `touch '${marker}'`, cwd: s.work, shell: '/bin/sh', timeoutSec: 60, keyHash: '0'.repeat(64),
        fingerprint: '0'.repeat(64), createdAt: at, updatedAt: at, worker: { pid: 999999, nonce: 'dead' },
        stdout: { bytes: 0, dropped: 0 }, stderr: { bytes: 0, dropped: 0 }, progress: null,
      };
      fs.mkdirSync(path.join(root, 'jobs', id), { mode: 0o700 });
      fs.writeFileSync(path.join(root, 'jobs', id, 'job.json'), JSON.stringify(rec), { mode: 0o600 });
      fs.writeFileSync(path.join(root, 'active', id), '', { mode: 0o600 });
      const st = await waitJob(c.call, id, { timeout: 15_000 });
      assert.equal(st.state, 'outcome_unknown');
      assert.match(st.reason, /NOT re-run/);
      await sleep(500);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      await c.close();
      await s.close();
    }
  });
});

describe('jobs survive HTTP server SIGKILL and SIGTERM restarts (child processes)', () => {
  it('keeps running, deduplicates retries from fresh server processes, and finishes exactly once', async () => {
    const port = await freePort();
    const r = makeRemoteDir({ port, config: { trustedTerminal: true, jobs: TEST_JOBS } });
    let child;
    try {
      child = await startChild(r.dir);
      let c = await connectHttp(port, r.token);
      const marker = path.join(r.work, 'events.txt');
      const key = uuid();
      const args = { command: `echo begin >> '${marker}'; sleep 3; echo end >> '${marker}'`, idempotencyKey: key };
      const id = jobJson(await c.call('job_start', args)).jobId;
      const st = await waitJob(c.call, id, { until: (x) => x.state === 'running' });
      await c.close();

      child.kill('SIGKILL');
      await new Promise((res) => child.once('exit', res));
      child = undefined;
      assert.ok(alive(st.pid), 'the job keeps running while no server exists');
      await sleep(300);
      child = await startChild(r.dir);
      c = await connectHttp(port, r.token);
      const retry = jobJson(await c.call('job_start', args));
      assert.equal(retry.jobId, id);
      assert.equal(retry.deduplicated, true);
      const done = await waitJob(c.call, id, { timeout: 15_000 });
      assert.equal(done.state, 'succeeded');
      assert.deepEqual(lines(marker), ['begin', 'end']);

      // A normal (SIGTERM) service stop terminates interactive sessions, not durable jobs.
      const id2 = jobJson(await c.call('job_start', { command: `sleep 2; echo second >> '${marker}'`, idempotencyKey: uuid() })).jobId;
      const st2 = await waitJob(c.call, id2, { until: (x) => x.state === 'running' });
      await c.close();
      assert.equal(await stopChild(child), 0);
      child = undefined;
      assert.ok(alive(st2.pid));
      child = await startChild(r.dir);
      c = await connectHttp(port, r.token);
      assert.equal((await waitJob(c.call, id2, { timeout: 15_000 })).state, 'succeeded');
      assert.deepEqual(lines(marker), ['begin', 'end', 'second']);
      await c.close();
    } finally {
      if (child) await stopChild(child);
      await cleanupJobs(r.dir);
      r.cleanup();
    }
  });
});
