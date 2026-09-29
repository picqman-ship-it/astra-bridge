// Helpers for the remote (HTTP / remote-stdio / service) tests. Everything lives in fresh temp
// directories: the real ~/.mcp-commander and ~/.mcp-commander-remote are never touched.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DIST, load, rmrf, tmpDir } from './helpers.js';

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * A remote dir (0700) with token (0600) and remote.json (0600) whose single root is a fresh
 * work dir. `config` entries are merged into remote.json.
 */
export function makeRemoteDir({ port = 1, config = {}, token = crypto.randomBytes(32).toString('base64url') } = {}) {
  const base = tmpDir('mcpc-remote-');
  const dir = path.join(base, 'remote');
  const work = path.join(base, 'work');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'logs'), { mode: 0o700 });
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(dir, 'token'), `${token}\n`, { mode: 0o600 });
  const cfg = { schemaVersion: 1, host: '127.0.0.1', port, roots: [work], ...config };
  fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return {
    base,
    dir,
    work,
    token,
    auditFile: path.join(dir, 'logs', 'audit.jsonl'),
    writeConfig: (next) => fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify(next, null, 2), { mode: 0o600 }),
    cleanup: () => rmrf(base),
  };
}

/** Starts the HTTP server in-process on a free port. */
export async function startInProcess(config = {}) {
  const port = await freePort();
  const remote = makeRemoteDir({ port, config });
  const { loadRemoteConfig } = await load('remote/config.js');
  const { BearerToken } = await load('remote/secrets.js');
  const { startRemoteHttpServer } = await load('remote/http-server.js');
  const cfg = loadRemoteConfig(remote.dir);
  const handle = await startRemoteHttpServer(cfg, BearerToken.fromFile(cfg.tokenFile));
  return {
    ...remote,
    port,
    cfg,
    handle,
    close: async () => {
      await handle.close();
      await cleanupJobs(remote.dir);
      remote.cleanup();
    },
  };
}

/** Spawns dist/http.js; resolves once it logs "listening on". */
export function startChild(remoteDir, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIST, 'http.js'), '--remote-dir', remoteDir, ...extraArgs], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`http.js did not start: ${stderr}`)), 10_000);
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.includes('listening on')) {
        clearTimeout(timer);
        resolve(Object.assign(child, { getStderr: () => stderr }));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`http.js exited ${code}: ${stderr}`), { code, stderr }));
    });
  });
}

/** Runs dist/http.js expecting it to exit; resolves { code, stderr }. */
export function runChildToExit(args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(DIST, 'http.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stderr: out });
    });
  });
}

export function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
    child.kill('SIGTERM');
  });
}

export function rawRequest(port, { method = 'POST', path: p = '/mcp', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});

export const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

export async function connectHttp(port, token, sessionId) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    ...(sessionId ? { sessionId } : {}),
  });
  const client = new Client({ name: 'mcpc-http-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

/** Job settings for tests; they only ever go into a temp remote.json. */
export const TEST_JOBS = { workerIdleExitMs: 1000 };

export function workerRecord(remoteDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(remoteDir, 'durable', 'worker.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function readJobRecord(remoteDir, id) {
  return JSON.parse(fs.readFileSync(path.join(remoteDir, 'durable', 'jobs', id, 'job.json'), 'utf8'));
}

/** Parses the JSON a job tool returns in its first text block. */
export function jobJson(result) {
  const t = result.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`not JSON: ${t.slice(0, 400)}`);
  }
}

/** Polls job_status until the job is finished (or `until` holds); returns the last status. */
export async function waitJob(call, jobId, { timeout = 20_000, until } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const r = await call('job_status', { jobId });
    const st = jobJson(r);
    if (until ? until(st) : st.finished) return st;
    if (Date.now() > end) throw new Error(`job ${jobId} still ${st.state} after ${timeout}ms`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

/**
 * Stops everything a test's job worker left behind, and nothing else: job workers whose command
 * line names THIS temp remote dir, and job process groups whose recorded identity (PID + start
 * time) still matches.
 */
export async function cleanupJobs(remoteDir) {
  const { processIdentity } = await load('remote/durable.js');
  const jobsDir = path.join(remoteDir, 'durable', 'jobs');
  let ids = [];
  try {
    ids = fs.readdirSync(jobsDir).filter((f) => /^j/.test(f));
  } catch {
    /* no jobs */
  }
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  for (const line of (ps.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].includes('job-worker.js') && m[2].includes(`--remote-dir ${remoteDir}`)) {
      try {
        process.kill(Number(m[1]), 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  for (const id of ids) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'job.json'), 'utf8'));
      if (rec.pid && rec.pidIdentity && processIdentity(rec.pid) === rec.pidIdentity) process.kill(-rec.pid, 'SIGKILL');
    } catch {
      /* unreadable or gone */
    }
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
