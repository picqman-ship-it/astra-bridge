#!/usr/bin/env node
// Independent reliability smoke test of the 0.3.0 durable jobs and idempotency keys, against REAL
// dist/http.js server processes on a free loopback port and a throwaway remote dir created by
// dist/remote/setup.js. It never touches ~/.mcp-commander-remote, the installed LaunchAgent or
// launchd, and only runs harmless commands (echo/sleep) inside a temp directory.
//
// Checks: two concurrent job_start calls with one idempotency key -> one job, one execution; the job
// keeps running while its HTTP server is SIGKILLed and while another is stopped normally (SIGTERM);
// retries from fresh server processes return the same job; a changed request with the same key is
// refused; concurrent duplicate appends with one key write once; a retry after a full restart is
// replayed; the job finishes exactly once.
//
// Output: progress lines on stderr, one JSON object on stdout; exit 0 only when every check passed.
// Bounded: a hard 150s limit cleans up and exits 2.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const { VERSION } = await import(pathToFileURL(path.join(dist, 'version.js')).href);
const startedAt = Date.now();
const checks = [];
const children = new Set();
let tmp;
let remoteDir;

const log = (msg) => process.stderr.write(`[reliability] ${msg}\n`);
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail).slice(0, 400) }) });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
}
const text = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dist, 'http.js'), '--remote-dir', remoteDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.add(child);
    child.on('exit', () => children.delete(child));
    let err = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${err}`)), 10_000);
    child.stderr.on('data', (d) => {
      err += d;
      if (err.includes('listening on')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${err}`));
    });
  });
}

function stopServer(child, signal = 'SIGTERM') {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode ?? child.signalCode);
    const t = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('exit', (code, sig) => {
      clearTimeout(t);
      resolve(code ?? sig);
    });
    child.kill(signal);
  });
}

async function connect(port, token) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mcp-commander-reliability-smoke', version: '1.0.0' });
  await client.connect(transport);
  return {
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: async () => {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    },
  };
}

const json = (r) => JSON.parse(text(r));

async function waitJob(c, jobId, until, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = json(await c.call('job_status', { jobId }));
    if (until(st) || Date.now() > end) return st;
    await sleep(100);
  }
}

/** PIDs of job workers of THIS temp remote dir only (matched by command line). */
function workerPids() {
  if (!remoteDir) return [];
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  const pids = [];
  for (const line of (ps.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].includes('job-worker.js') && m[2].includes(`--remote-dir ${remoteDir}`)) pids.push(Number(m[1]));
  }
  return pids;
}

async function cleanup() {
  for (const c of [...children]) await stopServer(c);
  for (const pid of workerPids()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
  for (let i = 0; i < 50 && workerPids().length; i++) await sleep(100);
  for (const pid of workerPids()) process.kill(pid, 'SIGKILL');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

function finish(code) {
  const failed = checks.filter((c) => !c.ok).length;
  const report = {
    name: 'reliability-smoke',
    version: VERSION,
    ok: code === 0 && failed === 0 && checks.length > 0,
    passed: checks.length - failed,
    failed,
    total: checks.length,
    durationMs: Date.now() - startedAt,
    node: process.version,
    checks,
  };
  log(`${report.passed}/${report.total} checks passed in ${report.durationMs}ms`);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.ok ? 0 : code || 1);
}

const hardLimit = setTimeout(() => {
  check('run finished within 150s', false, 'hard time limit reached');
  cleanup().finally(() => finish(2));
}, 150_000);
hardLimit.unref();

async function main() {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-reliability-')));
  remoteDir = path.join(tmp, 'remote');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  const port = await freePort();
  const setup = spawnSync(
    process.execPath,
    [path.join(dist, 'remote', 'setup.js'), '--remote-dir', remoteDir, '--root', work, '--port', String(port), '--trusted-terminal'],
    { encoding: 'utf8' },
  );
  check('temp setup (trusted terminal) exits 0', setup.status === 0, setup.stderr);
  // Temp config only: a quick worker idle exit for cleanup.
  const cfgFile = path.join(remoteDir, 'remote.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), jobs: { workerIdleExitMs: 1500 } }, null, 2), { mode: 0o600 });
  const token = fs.readFileSync(path.join(remoteDir, 'token'), 'utf8').trim();

  let server = await startServer();
  const serverPid1 = server.pid;
  const a = await connect(port, token);
  const b = await connect(port, token);

  // 1. One key, two simultaneous clients -> one job.
  const events = path.join(work, 'events.txt');
  const jobArgs = { command: `echo "start $$" >> '${events}'; sleep 6; echo "end $$" >> '${events}'`, idempotencyKey: crypto.randomUUID(), label: 'reliability' };
  const [ra, rb] = await Promise.all([a.call('job_start', jobArgs), b.call('job_start', jobArgs)]);
  const ja = json(ra);
  const jb = json(rb);
  check('concurrent same-key job_start returns one job id', ja.jobId && ja.jobId === jb.jobId, `${ja.jobId} vs ${jb.jobId}`);
  check('exactly one of them created it', [ja.deduplicated, jb.deduplicated].sort().join() === 'false,true', `${ja.deduplicated},${jb.deduplicated}`);
  const jobId = ja.jobId;
  const running = await waitJob(a, jobId, (s) => s.state === 'running' || s.finished);
  check('job is running', running.state === 'running', running.state);
  const worker = JSON.parse(fs.readFileSync(path.join(remoteDir, 'durable', 'worker.json'), 'utf8'));
  check('job runs in a separate worker process, not in the HTTP server', worker.pid !== serverPid1 && alive(worker.pid), `worker ${worker.pid}, server ${serverPid1}`);
  await a.close();
  await b.close();

  // 2. SIGKILL the server: the job and worker keep running.
  await stopServer(server, 'SIGKILL');
  check('HTTP server was SIGKILLed', !alive(serverPid1));
  await sleep(300);
  check('job process survives the server SIGKILL', alive(running.pid), running.pid);
  check('worker survives the server SIGKILL', alive(worker.pid), worker.pid);

  // 3. Fresh server process: retries dedupe, a changed request conflicts.
  server = await startServer();
  const c = await connect(port, token);
  const retry = json(await c.call('job_start', jobArgs));
  check('retry after restart returns the same job (deduplicated)', retry.jobId === jobId && retry.deduplicated === true, JSON.stringify(retry).slice(0, 200));
  const conflict = await c.call('job_start', { ...jobArgs, command: `${jobArgs.command} # changed` });
  check('same key with a changed request is refused', conflict.isError === true && /different job request/.test(text(conflict)), text(conflict));

  // 4. Duplicate-write protection across two clients.
  const d = await connect(port, token);
  const appendFile = path.join(work, 'append.txt');
  const appendArgs = { path: appendFile, content: 'appended once\n', mode: 'append', idempotencyKey: crypto.randomUUID() };
  const appends = await Promise.all([c.call('write_file', appendArgs), d.call('write_file', appendArgs), c.call('write_file', appendArgs)]);
  check('concurrent duplicate appends with one key write exactly once', fs.readFileSync(appendFile, 'utf8') === 'appended once\n', fs.readFileSync(appendFile, 'utf8'));
  check('exactly one append executed; the others were not', appends.filter((r) => !r.isError && !/NOT executed again/.test(text(r))).length === 1);
  const noKey = path.join(work, 'nokey.txt');
  await c.call('write_file', { path: noKey, content: 'x\n', mode: 'append' });
  await c.call('write_file', { path: noKey, content: 'x\n', mode: 'append' });
  check('without a key a retried append runs again (documented: no protection)', fs.readFileSync(noKey, 'utf8') === 'x\nx\n');
  await c.close();
  await d.close();

  // 5. Normal service stop (SIGTERM) and start: job continues, append retry is replayed.
  const code = await stopServer(server, 'SIGTERM');
  check('HTTP server stops cleanly on SIGTERM', code === 0, code);
  const stillRunning = alive(running.pid);
  server = await startServer();
  const e = await connect(port, token);
  const replay = await e.call('write_file', appendArgs);
  check('append retry after a full server restart is replayed, not repeated', /NOT executed again/.test(text(replay)) && fs.readFileSync(appendFile, 'utf8') === 'appended once\n', text(replay));
  const done = await waitJob(e, jobId, (s) => s.finished, 20_000);
  check('the job finished successfully after two server restarts', done.state === 'succeeded' && done.exitCode === 0, JSON.stringify(done).slice(0, 300));
  const ev = lines(events);
  check('the job executed exactly once (one start, one end, same PID)', ev.length === 2 && ev[0] === `start ${done.pid}` && ev[1] === `end ${done.pid}`, ev.join(' | '));
  check('the job process was still running after the SIGTERM service stop', stillRunning);
  const list = json(await e.call('job_list', { limit: 50 }));
  check('job_list shows exactly one job', list.total === 1 && list.jobs[0]?.jobId === jobId, JSON.stringify(list).slice(0, 200));
  await e.close();

  // 6. Private state stays private and outside the root.
  const st = fs.statSync(path.join(remoteDir, 'durable'));
  check('durable state dir is 0700 and outside the exposed root', (st.mode & 0o777) === 0o700 && !path.join(remoteDir, 'durable').startsWith(work));
  const audit = fs.readFileSync(path.join(remoteDir, 'logs', 'audit.jsonl'), 'utf8');
  check('audit log holds no key, command or content', !audit.includes(appendArgs.idempotencyKey) && !audit.includes(jobArgs.idempotencyKey) && !audit.includes('appended once') && !audit.includes('sleep 6'));
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  check('smoke run completed', false, err instanceof Error ? err.stack : err);
  exitCode = 1;
} finally {
  await cleanup();
  check('no worker or server left running for the temp dir', children.size === 0 && workerPids().length === 0);
}
clearTimeout(hardLimit);
finish(exitCode);
