#!/usr/bin/env node
// Independent smoke test of the Streamable HTTP entrypoint through the official MCP SDK client.
//
// Everything runs against temporary directories (never ~/.mcp-commander or
// ~/.mcp-commander-remote): setup creates a throwaway remote dir and token, `dist/http.js` is
// started as a real child process on a free loopback port, and the client does
// write/read/search. With trusted-terminal mode it also drives a Python REPL across a reconnect
// with the same session, a second session, and a service restart (the REPL must be gone after it,
// while a durable job started before the restart must finish). Exact tool names are asserted for
// both modes (15 file-only, 27 trusted).
//
// Usage: node scripts/http-smoke.mjs [--trusted-only | --untrusted-only]
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const modes = process.argv.includes('--trusted-only') ? [true] : process.argv.includes('--untrusted-only') ? [false] : [false, true];

// The remote policy, spelled out independently of dist/remote/policy.js.
const FILE_ONLY_TOOLS = [
  'read_file', 'read_multiple_files', 'write_file', 'create_directory', 'list_directory', 'move_file', 'get_file_info',
  'edit_block', 'start_search', 'get_more_search_results', 'stop_search', 'list_searches', 'get_config',
  'get_recent_tool_calls', 'get_usage_stats',
];
const TRUSTED_EXTRA_TOOLS = [
  'start_process', 'read_process_output', 'interact_with_process', 'force_terminate', 'list_sessions', 'list_processes',
  'kill_process', 'job_start', 'job_status', 'job_list', 'job_logs', 'job_cancel',
];

const results = [];
function check(name, ok, detail = '') {
  results.push([name, !!ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
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

function startServer(remoteDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dist, 'http.js'), '--remote-dir', remoteDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${err}`)), 10_000);
    child.stderr.on('data', (d) => {
      err += d;
      if (err.includes('listening on')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${err}`));
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
    child.kill('SIGTERM');
  });
}

function rawRequest(port, { method = 'POST', path: p = '/mcp', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function connect(port, token, sessionId) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    ...(sessionId ? { sessionId } : {}),
  });
  const client = new Client({ name: 'mcp-commander-http-smoke', version: '1.0.0' });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, transport, call };
}

async function runMode(trusted) {
  console.log(`\n[smoke] mode: ${trusted ? 'trusted-terminal' : 'default (no terminal tools)'}`);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-http-smoke-')));
  const remoteDir = path.join(tmp, 'remote');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  let server;
  try {
    const port = await freePort();
    const setup = spawnSync(
      process.execPath,
      [path.join(dist, 'remote', 'setup.js'), '--remote-dir', remoteDir, '--root', work, '--port', String(port), ...(trusted ? ['--trusted-terminal'] : [])],
      { encoding: 'utf8' },
    );
    check('setup exits 0', setup.status === 0, setup.stderr);
    // Temp config only: let the job worker exit soon after the run.
    const cfgFile = path.join(remoteDir, 'remote.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), jobs: { workerIdleExitMs: 1000 } }, null, 2), { mode: 0o600 });
    const token = fs.readFileSync(path.join(remoteDir, 'token'), 'utf8').trim();
    check('setup output does not contain the token', !setup.stdout.includes(token) && !setup.stderr.includes(token));
    check('token file is 0600, dir is 0700', (fs.statSync(path.join(remoteDir, 'token')).mode & 0o777) === 0o600 && (fs.statSync(remoteDir).mode & 0o777) === 0o700);

    server = await startServer(remoteDir);
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    const accept = 'application/json, text/event-stream';
    const base = { 'content-type': 'application/json', accept, host: `127.0.0.1:${port}` };
    const noAuth = await rawRequest(port, { headers: base, body: init });
    check('no token → 401', noAuth.status === 401, noAuth.status);
    const badAuth = await rawRequest(port, { headers: { ...base, authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` }, body: init });
    check('wrong token → 401', badAuth.status === 401, badAuth.status);
    const badHost = await rawRequest(port, { headers: { ...base, host: 'evil.example', authorization: `Bearer ${token}` }, body: init });
    check('foreign Host → 403', badHost.status === 403, badHost.status);
    const badOrigin = await rawRequest(port, { headers: { ...base, origin: 'https://evil.example', authorization: `Bearer ${token}` }, body: init });
    check('browser Origin → 403, no CORS headers', badOrigin.status === 403 && !Object.keys(badOrigin.headers).some((h) => h.startsWith('access-control-')), badOrigin.status);
    const health = await rawRequest(port, { method: 'GET', path: '/healthz', headers: { host: `127.0.0.1:${port}` } });
    check('healthz is minimal', health.status === 200 && health.body === '{"status":"ok"}', health.body);

    const a = await connect(port, token);
    const tools = (await a.client.listTools()).tools.map((t) => t.name);
    check('set_config_value is not exposed', !tools.includes('set_config_value'));
    check(`terminal tools ${trusted ? 'exposed' : 'hidden'}`, tools.includes('start_process') === trusted && tools.includes('kill_process') === trusted, tools.join(','));
    const expected = [...FILE_ONLY_TOOLS, ...(trusted ? TRUSTED_EXTRA_TOOLS : [])].sort();
    check(`exactly ${expected.length} tools with the expected names`, JSON.stringify([...tools].sort()) === JSON.stringify(expected), tools.join(','));

    const nonce = crypto.randomBytes(12).toString('hex');
    const file = path.join(work, 'smoke.txt');
    const w = await a.call('write_file', { path: file, content: `smoke ${nonce}\n` });
    check('write_file inside root', !w.isError && fs.readFileSync(file, 'utf8').includes(nonce), text(w));
    const r = await a.call('read_file', { path: file });
    check('read_file returns content', !r.isError && text(r).includes(nonce), text(r));
    const s = await a.call('start_search', { path: work, pattern: nonce, searchType: 'content' });
    const sid = /Started (?:.*?)search session: (\S+)/.exec(text(s))?.[1] ?? /session[:\s]+(\S+)/i.exec(text(s))?.[1];
    let found = text(s).includes('smoke.txt');
    for (let i = 0; i < 40 && !found && sid; i++) {
      await sleep(100);
      const more = await a.call('get_more_search_results', { sessionId: sid.replace(/[.,]$/, '') });
      found = text(more).includes('smoke.txt');
    }
    check('start_search finds the file', found, text(s));
    const outside = await a.call('write_file', { path: path.join(tmp, 'outside.txt'), content: 'x' });
    check('write outside roots is refused', outside.isError && !fs.existsSync(path.join(tmp, 'outside.txt')), text(outside));
    const url = await a.call('read_file', { path: 'http://127.0.0.1:1/', isUrl: true });
    check('URL fetching is refused', url.isError, text(url));

    if (trusted) {
      const start = await a.call('start_process', { command: 'python3 -i -q', timeout_ms: 5000 });
      const pid = Number(/PID (\d+)/.exec(text(start))?.[1]);
      check('start_process python3 REPL', pid > 0 && !start.isError, text(start));
      await a.call('interact_with_process', { pid, input: 'x = 6 * 7', timeout_ms: 5000 });
      const r1 = await a.call('interact_with_process', { pid, input: 'print("v=%d" % x)', timeout_ms: 5000 });
      check('REPL answers across requests', text(r1).includes('v=42'), text(r1));

      const b = await connect(port, token, a.transport.sessionId);
      const r2 = await b.call('interact_with_process', { pid, input: 'print("v=%d" % (x + 1))', timeout_ms: 5000 });
      check('reconnect with the same session keeps the REPL', text(r2).includes('v=43'), text(r2));
      const c = await connect(port, token);
      const r3 = await c.call('interact_with_process', { pid, input: 'print("v=%d" % (x + 2))', timeout_ms: 5000 });
      check('a new session reaches the same REPL (service-owned)', text(r3).includes('v=44'), text(r3));
      await c.transport.terminateSession();
      const afterDelete = await rawRequest(port, {
        headers: { ...base, authorization: `Bearer ${token}`, 'mcp-session-id': c.transport.sessionId ?? 'x', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
      check('DELETE ends that session (404 afterwards)', afterDelete.status === 404, afterDelete.status);
      check('the REPL survives session deletion', alive(pid));

      const jobFile = path.join(work, 'job-done.txt');
      const jobStart = await a.call('job_start', { command: `sleep 2; echo job-done > '${jobFile}'`, idempotencyKey: crypto.randomUUID() });
      const jobId = JSON.parse(text(jobStart)).jobId;
      check('job_start accepts a durable job', !jobStart.isError && /^j/.test(jobId ?? ''), text(jobStart));

      const oldSession = a.transport.sessionId;
      await b.client.close().catch(() => {});
      await a.client.close().catch(() => {});
      const code = await stopServer(server);
      server = undefined;
      check('service stops cleanly on SIGTERM', code === 0, code);
      check('service shutdown stopped the REPL', !alive(pid));

      server = await startServer(remoteDir);
      const stale = await rawRequest(port, {
        headers: { ...base, authorization: `Bearer ${token}`, 'mcp-session-id': oldSession, 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
      check('old session is unknown after restart (404)', stale.status === 404, stale.status);
      const d = await connect(port, token);
      const ls = await d.call('list_sessions');
      check('new session works; the old REPL is not listed', !ls.isError && !text(ls).includes(String(pid)), text(ls));
      let job;
      for (let i = 0; i < 100; i++) {
        job = JSON.parse(text(await d.call('job_status', { jobId })));
        if (job.finished) break;
        await sleep(100);
      }
      check('the durable job survived the service restart and succeeded', job?.state === 'succeeded' && fs.readFileSync(jobFile, 'utf8') === 'job-done\n', JSON.stringify(job));
      await d.transport.terminateSession().catch(() => {});
      await d.client.close();
    } else {
      await a.transport.terminateSession().catch(() => {});
      await a.client.close();
    }

    const audit = fs.readFileSync(path.join(remoteDir, 'logs', 'audit.jsonl'), 'utf8');
    check('audit log has tool metadata', /"event":"tool","tool":"write_file","status":"ok","durationMs":\d+/.test(audit));
    check('audit log has no arguments, content or token', !audit.includes(nonce) && !audit.includes(token) && !audit.includes(work));
  } catch (err) {
    check('smoke run completed', false, err instanceof Error ? err.stack : err);
  } finally {
    if (server) await stopServer(server);
    await stopWorkers(remoteDir);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Stop this temporary test's workers, and wait before deleting the state they write. */
async function stopWorkers(remoteDir) {
  const scopedPids = () => {
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
    if (ps.status !== 0) throw new Error('Cannot verify temporary worker shutdown');
    return (ps.stdout ?? '').split('\n').flatMap(line => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      return m && m[2].includes('job-worker.js') && m[2].includes('--remote-dir ' + remoteDir) ? [Number(m[1])] : [];
    });
  };
  for (const pid of scopedPids()) {
    try { process.kill(pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
  const deadline = Date.now() + 10000;
  while (scopedPids().length) {
    if (Date.now() >= deadline) throw new Error('Temporary worker did not exit; its directory was retained');
    await sleep(50);
  }
}

for (const trusted of modes) await runMode(trusted);
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n[smoke] ${results.length - failed}/${results.length} checks passed`);
console.log(failed ? '[smoke] FAIL' : '[smoke] PASS');
process.exit(failed ? 1 : 0);
