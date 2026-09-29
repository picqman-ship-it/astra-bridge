// Streamable HTTP entrypoint: request gating order, limits, sessions, tool policy, auditing,
// restart semantics and fail-closed startup. Temp configs only; loopback only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DIST, sleep, textOf, waitFor } from './helpers.js';
import {
  alive, connectHttp, freePort, INIT_BODY, makeRemoteDir, MCP_HEADERS, rawRequest, runChildToExit, startChild,
  startInProcess, stopChild,
} from './remote-helpers.js';

const { remoteToolNames } = await import(path.join(DIST, 'remote', 'policy.js'));

const auth = (token) => ({ authorization: `Bearer ${token}` });
const noCors = (res) => !Object.keys(res.headers).some((h) => h.startsWith('access-control-'));

describe('HTTP request gating', () => {
  let s;
  before(async () => {
    s = await startInProcess({ allowedOrigins: ['https://trusted.example'], limits: { maxBodyBytes: 2048 } });
  });
  after(async () => s?.close());

  it('binds to 127.0.0.1 only', () => {
    assert.equal(s.handle.server.address().address, '127.0.0.1');
    assert.equal(s.handle.url, `http://127.0.0.1:${s.port}/mcp`);
  });

  it('healthz is minimal and discloses nothing', async () => {
    const r = await rawRequest(s.port, { method: 'GET', path: '/healthz' });
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"status":"ok"}');
    assert.ok(!r.body.includes(s.token) && !r.body.includes(s.work));
    assert.ok(noCors(r));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal((await rawRequest(s.port, { method: 'POST', path: '/healthz' })).status, 405);
  });

  it('refuses a Host outside the allowlist, even with a valid token and even for healthz', async () => {
    for (const host of ['evil.example', `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, `0.0.0.0:${s.port}`]) {
      const r = await rawRequest(s.port, { headers: { ...MCP_HEADERS, ...auth(s.token), host }, body: INIT_BODY });
      assert.equal(r.status, 403, host);
      const h = await rawRequest(s.port, { method: 'GET', path: '/healthz', headers: { host } });
      assert.equal(h.status, 403, host);
    }
    const ok = await rawRequest(s.port, { method: 'GET', path: '/healthz', headers: { host: `localhost:${s.port}` } });
    assert.equal(ok.status, 200);
  });

  it('refuses browser origins that are not explicitly listed; never sends CORS headers', async () => {
    for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${s.port}`]) {
      const r = await rawRequest(s.port, { headers: { ...MCP_HEADERS, ...auth(s.token), origin }, body: INIT_BODY });
      assert.equal(r.status, 403, origin);
      assert.ok(noCors(r));
    }
    // A listed origin passes the origin gate but still needs the token.
    const listed = await rawRequest(s.port, { headers: { ...MCP_HEADERS, origin: 'https://trusted.example' }, body: INIT_BODY });
    assert.equal(listed.status, 401);
    assert.ok(noCors(listed));
    const pre = await rawRequest(s.port, { method: 'OPTIONS', headers: { origin: 'https://trusted.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 405);
    assert.ok(noCors(pre));
  });

  it('requires the bearer token on every MCP request, before any session lookup', async () => {
    const none = await rawRequest(s.port, { headers: MCP_HEADERS, body: INIT_BODY });
    assert.equal(none.status, 401);
    assert.match(none.headers['www-authenticate'], /^Bearer /);
    assert.equal(JSON.parse(none.body).error.message, 'Unauthorized');
    const wrong = await rawRequest(s.port, { headers: { ...MCP_HEADERS, ...auth(crypto.randomBytes(32).toString('base64url')) }, body: INIT_BODY });
    assert.equal(wrong.status, 401);
    // Unknown session without a token: 401, not 404 — nothing about sessions leaks unauthenticated.
    const sid = crypto.randomUUID();
    for (const method of ['GET', 'POST', 'DELETE']) {
      const r = await rawRequest(s.port, { method, headers: { ...MCP_HEADERS, 'mcp-session-id': sid }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 401, method);
    }
    const withToken = await rawRequest(s.port, { method: 'DELETE', headers: { ...auth(s.token), 'mcp-session-id': sid } });
    assert.equal(withToken.status, 404);
  });

  it('never accepts credentials or anything else in the URL', async () => {
    const r = await rawRequest(s.port, { path: `/mcp?access_token=${s.token}`, headers: MCP_HEADERS, body: INIT_BODY });
    assert.equal(r.status, 400);
    const r2 = await rawRequest(s.port, { path: '/mcp?x=1', headers: { ...MCP_HEADERS, ...auth(s.token) }, body: INIT_BODY });
    assert.equal(r2.status, 400);
  });

  it('handles methods and paths strictly', async () => {
    const put = await rawRequest(s.port, { method: 'PUT', headers: { ...MCP_HEADERS, ...auth(s.token) }, body: INIT_BODY });
    assert.equal(put.status, 405);
    assert.equal(put.headers.allow, 'GET, POST, DELETE');
    assert.equal((await rawRequest(s.port, { method: 'GET', path: '/', headers: auth(s.token) })).status, 404);
    assert.equal((await rawRequest(s.port, { method: 'GET', path: '/mcp/', headers: auth(s.token) })).status, 404);
    const getNoSession = await rawRequest(s.port, { method: 'GET', headers: { ...auth(s.token), accept: 'text/event-stream' } });
    assert.equal(getNoSession.status, 400);
    const delNoSession = await rawRequest(s.port, { method: 'DELETE', headers: auth(s.token) });
    assert.equal(delNoSession.status, 400);
  });

  it('validates content type, body size, UTF-8 and JSON before reaching the SDK', async () => {
    const h = { ...auth(s.token), accept: MCP_HEADERS.accept };
    for (const ct of ['text/plain', 'application/json; charset=latin1', 'application/jsonx', 'multipart/form-data']) {
      const r = await rawRequest(s.port, { headers: { ...h, 'content-type': ct }, body: INIT_BODY });
      assert.equal(r.status, 415, ct);
    }
    const okCharset = await rawRequest(s.port, { headers: { ...h, 'content-type': 'application/json; charset=UTF-8' }, body: '{' });
    assert.equal(okCharset.status, 400);
    assert.equal(JSON.parse(okCharset.body).error.code, -32700);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(4096) } });
    const tooBig = await rawRequest(s.port, { headers: { ...h, 'content-type': 'application/json' }, body: big });
    assert.equal(tooBig.status, 413);
    const badUtf8 = await rawRequest(s.port, { headers: { ...h, 'content-type': 'application/json' }, body: Buffer.from([0x7b, 0xff, 0x7d]) });
    assert.equal(badUtf8.status, 400);
    const notInit = await rawRequest(s.port, { headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.equal(notInit.status, 400);
    const badSid = await rawRequest(s.port, {
      headers: { ...h, 'content-type': 'application/json', 'mcp-session-id': '../../etc' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(badSid.status, 404);
  });

  it('keeps error bodies generic', async () => {
    const r = await rawRequest(s.port, { headers: MCP_HEADERS, body: INIT_BODY });
    const body = JSON.parse(r.body);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'id', 'jsonrpc']);
    assert.ok(!r.body.includes(s.dir) && !r.body.includes(s.work));
  });

  it('writes auth failures to the audit log without any credential', async () => {
    const bogus = crypto.randomBytes(32).toString('base64url');
    await rawRequest(s.port, { headers: { ...MCP_HEADERS, ...auth(bogus) }, body: INIT_BODY });
    const audit = fs.readFileSync(s.auditFile, 'utf8');
    assert.match(audit, /"event":"auth_failed","status":"denied"/);
    assert.ok(!audit.includes(bogus) && !audit.includes(s.token));
  });
});

describe('HTTP tool policy (default mode)', () => {
  let s;
  let c;
  before(async () => {
    s = await startInProcess();
    c = await connectHttp(s.port, s.token);
  });
  after(async () => {
    await c?.close();
    await s?.close();
  });

  it('exposes exactly the remote tool set: no config mutation, no terminal', async () => {
    const names = (await c.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...remoteToolNames(false)].sort());
    assert.deepEqual(names, [
      'create_directory', 'edit_block', 'get_config', 'get_file_info', 'get_more_search_results', 'get_recent_tool_calls',
      'get_usage_stats', 'list_directory', 'list_searches', 'move_file', 'read_file', 'read_multiple_files', 'start_search',
      'stop_search', 'write_file',
    ]);
    const denied = await c.call('set_config_value', { key: 'allowedDirectories', value: '[]' }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }));
    assert.equal(denied.isError, true);
    const started = await c.call('start_process', { command: 'echo hi' }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }));
    assert.equal(started.isError, true);
  });

  it('get_config is read-only and reports the remote settings', async () => {
    const r = await c.call('get_config');
    const text = textOf(r);
    assert.match(text, /"mode": "remote"/);
    assert.match(text, /"trustedTerminal": false/);
    assert.ok(text.includes(s.work));
    assert.ok(!text.includes(s.token));
  });

  it('confines file and search tools to the roots (symlinks included)', async () => {
    const inside = path.join(s.work, 'a.txt');
    assert.equal((await c.call('write_file', { path: inside, content: 'hello\n' })).isError, undefined);
    assert.match(textOf(await c.call('read_file', { path: inside })), /hello/);
    const outsideFile = path.join(s.base, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');
    assert.equal((await c.call('read_file', { path: outsideFile })).isError, true);
    assert.equal((await c.call('read_file', { path: path.join(s.dir, 'token') })).isError, true);
    assert.equal((await c.call('write_file', { path: path.join(s.dir, 'remote.json'), content: '{}' })).isError, true);
    fs.symlinkSync(outsideFile, path.join(s.work, 'link.txt'));
    const viaLink = await c.call('read_file', { path: path.join(s.work, 'link.txt') });
    assert.equal(viaLink.isError, true);
    assert.ok(!textOf(viaLink).includes('secret\n'));
    assert.equal((await c.call('start_search', { path: s.base, pattern: 'secret' })).isError, true);
    assert.equal((await c.call('move_file', { source: inside, destination: path.join(s.base, 'moved.txt') })).isError, true);
  });

  it('does not fetch URLs', async () => {
    const r = await c.call('read_file', { path: 'http://127.0.0.1:9/x' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /URL fetching is disabled/);
    assert.equal((await c.call('read_file', { path: '/x', isUrl: true })).isError, true);
    // read_multiple_files has its own URL refusal; it must not be a way around the wrapper.
    const multi = await c.call('read_multiple_files', { paths: ['http://127.0.0.1:9/x', 'https://example.com/'] });
    assert.match(textOf(multi), /http:\/\/127\.0\.0\.1:9\/x: Error - URLs are not supported/);
    assert.match(textOf(multi), /https:\/\/example\.com\/: Error - URLs are not supported/);
  });

  it('audits tool calls with metadata only', async () => {
    const marker = `marker-${crypto.randomBytes(8).toString('hex')}`;
    await c.call('write_file', { path: path.join(s.work, 'm.txt'), content: marker });
    await c.call('read_file', { path: path.join(s.base, 'nope.txt') });
    const lines = fs.readFileSync(s.auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const tools = lines.filter((l) => l.event === 'tool');
    assert.ok(tools.some((l) => l.tool === 'write_file' && l.status === 'ok' && Number.isInteger(l.durationMs)));
    assert.ok(tools.some((l) => l.tool === 'read_file' && l.status === 'error'));
    for (const l of tools) assert.deepEqual(Object.keys(l).sort(), ['durationMs', 'event', 'session', 'status', 'tool', 'ts']);
    const raw = fs.readFileSync(s.auditFile, 'utf8');
    assert.ok(!raw.includes(marker) && !raw.includes(s.work) && !raw.includes(c.transport.sessionId));
    assert.ok(lines.some((l) => l.event === 'session_open'));
  });
});

describe('HTTP sessions and trusted-terminal continuity', () => {
  let s;
  before(async () => {
    s = await startInProcess({ trustedTerminal: true, limits: { maxSessions: 2, sessionIdleMs: 1000 } });
  });
  after(async () => s?.close());

  it('keeps a REPL across requests, a reconnect with the same session and a new session', async () => {
    const a = await connectHttp(s.port, s.token);
    const names = (await a.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...remoteToolNames(true)].sort());
    assert.equal(names.length, 27);
    assert.deepEqual(names.filter((n) => !remoteToolNames(false).includes(n)), [
      'force_terminate', 'interact_with_process', 'job_cancel', 'job_list', 'job_logs', 'job_start', 'job_status',
      'kill_process', 'list_processes', 'list_sessions', 'read_process_output', 'start_process',
    ]);
    assert.ok(!names.includes('set_config_value'));
    const start = await a.call('start_process', { command: 'python3 -i -q', timeout_ms: 5000 });
    const pid = Number(/PID (\d+)/.exec(textOf(start))?.[1]);
    assert.ok(pid > 0, textOf(start));
    await a.call('interact_with_process', { pid, input: 'v = 1000 + 234', timeout_ms: 5000 });
    assert.match(textOf(await a.call('interact_with_process', { pid, input: 'print("out=%d" % v)', timeout_ms: 5000 })), /out=1234/);

    const b = await connectHttp(s.port, s.token, a.transport.sessionId);
    assert.match(textOf(await b.call('interact_with_process', { pid, input: 'print("out=%d" % (v + 1))', timeout_ms: 5000 })), /out=1235/);

    const c = await connectHttp(s.port, s.token);
    assert.match(textOf(await c.call('list_sessions')), new RegExp(`\\b${pid}\\b`));
    assert.match(textOf(await c.call('interact_with_process', { pid, input: 'print("out=%d" % (v + 2))', timeout_ms: 5000 })), /out=1236/);

    // Deleting a session does not stop service-owned processes.
    await c.transport.terminateSession();
    assert.ok(alive(pid));
    const r = await c.call('list_sessions').catch((e) => e);
    assert.ok(r instanceof Error, 'a deleted session must not answer');
    await a.call('force_terminate', { pid });
    await waitFor(() => !alive(pid), { timeout: 5000 });
    await b.close();
    await a.close();
    await c.close();
  });

  it('start_process runs in the first root by default and refuses a cwd outside the roots', async () => {
    const a = await connectHttp(s.port, s.token);
    const r = await a.call('start_process', { command: 'pwd', timeout_ms: 5000 });
    assert.ok(textOf(r).includes(s.work), textOf(r));
    const bad = await a.call('start_process', { command: 'pwd', cwd: s.base, timeout_ms: 5000 });
    assert.equal(bad.isError, true);
    await a.transport.terminateSession();
    await a.close();
  });

  it('expires idle sessions', async () => {
    const a = await connectHttp(s.port, s.token);
    const sid = a.transport.sessionId;
    await sleep(1800);
    const r = await rawRequest(s.port, {
      headers: { ...MCP_HEADERS, ...auth(s.token), 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    });
    assert.equal(r.status, 404);
    const audit = fs.readFileSync(s.auditFile, 'utf8');
    assert.match(audit, /"event":"session_close","session":"[0-9a-f]{12}","reason":"idle"/);
    await a.close();
  });

  it('evicts the least recently used idle session at the limit, and answers 503 when all are busy', async () => {
    const a = await connectHttp(s.port, s.token);
    await sleep(20);
    const b = await connectHttp(s.port, s.token);
    await b.client.listTools();
    const c = await connectHttp(s.port, s.token);
    assert.equal(s.handle.sessionCount(), 2);
    assert.ok(await a.client.listTools().then(() => false, () => true), 'the oldest idle session was evicted');
    await b.client.listTools();
    await c.client.listTools();

    // Both remaining sessions busy with a long call: a third initialize is refused.
    const busy1 = b.call('start_process', { command: 'sleep 3', timeout_ms: 1500 });
    const busy2 = c.call('start_process', { command: 'sleep 3', timeout_ms: 1500 });
    await sleep(300);
    const r = await rawRequest(s.port, { headers: { ...MCP_HEADERS, ...auth(s.token) }, body: INIT_BODY });
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '30');
    await Promise.all([busy1, busy2]);
    for (const x of [b, c]) await x.transport.terminateSession().catch(() => {});
    await Promise.all([a.close(), b.close(), c.close()]);
  });
});

describe('HTTP service process lifecycle', () => {
  it('stops owned processes on SIGTERM; after restart the old session is gone and a new one works', async () => {
    const port = await freePort();
    const r = makeRemoteDir({ port, config: { trustedTerminal: true } });
    let child;
    try {
      child = await startChild(r.dir);
      assert.ok(!child.getStderr().includes(r.token));
      const a = await connectHttp(port, r.token);
      const start = await a.call('start_process', { command: 'python3 -i -q', timeout_ms: 5000 });
      const pid = Number(/PID (\d+)/.exec(textOf(start))?.[1]);
      assert.ok(alive(pid));
      const oldSid = a.transport.sessionId;
      await a.close();
      assert.equal(await stopChild(child), 0);
      assert.equal(alive(pid), false, 'shutdown must stop service-owned processes');

      child = await startChild(r.dir);
      const stale = await rawRequest(port, {
        headers: { ...MCP_HEADERS, ...auth(r.token), 'mcp-session-id': oldSid, 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      });
      assert.equal(stale.status, 404);
      const b = await connectHttp(port, r.token);
      const ls = textOf(await b.call('list_sessions'));
      assert.ok(!new RegExp(`\\b${pid}\\b`).test(ls), ls);
      const again = await b.call('interact_with_process', { pid, input: 'print(1)', timeout_ms: 1000 });
      assert.equal(again.isError, true, 'a process from before the restart cannot be resumed');
      await b.transport.terminateSession();
      await b.close();
      const audit = fs.readFileSync(r.auditFile, 'utf8');
      assert.match(audit, /"event":"service_stop","reason":"SIGTERM"/);
      assert.equal((audit.match(/"event":"service_start"/g) ?? []).length, 2);
    } finally {
      if (child) await stopChild(child);
      r.cleanup();
    }
  });

  it('refuses to start without a valid config and owner-only token (exit 78), never echoing secrets', async () => {
    const port = await freePort();
    const r = makeRemoteDir({ port });
    try {
      fs.chmodSync(path.join(r.dir, 'token'), 0o644);
      let out = await runChildToExit(['--remote-dir', r.dir]);
      assert.equal(out.code, 78);
      assert.match(out.stderr, /refusing to start: .*must be 0600/);
      assert.ok(!out.stderr.includes(r.token));

      fs.chmodSync(path.join(r.dir, 'token'), 0o600);
      fs.writeFileSync(path.join(r.dir, 'token'), 'x'.repeat(50), { mode: 0o600 });
      out = await runChildToExit(['--remote-dir', r.dir]);
      assert.equal(out.code, 78);
      assert.match(out.stderr, /not acceptable/);

      fs.rmSync(path.join(r.dir, 'token'));
      out = await runChildToExit(['--remote-dir', r.dir]);
      assert.equal(out.code, 78);

      fs.writeFileSync(path.join(r.dir, 'token'), `${r.token}\n`, { mode: 0o600 });
      r.writeConfig({ schemaVersion: 1, host: '0.0.0.0', port, roots: [r.work] });
      out = await runChildToExit(['--remote-dir', r.dir]);
      assert.equal(out.code, 78);
      assert.match(out.stderr, /loopback/);

      out = await runChildToExit(['--remote-dir', r.dir, `--token=${r.token}`]);
      assert.equal(out.code, 2);
      assert.ok(!out.stderr.includes(r.token));
      out = await runChildToExit(['--remote-dir', r.dir, '--no-auth']);
      assert.equal(out.code, 2);

      out = await runChildToExit(['--remote-dir', path.join(r.base, 'missing')]);
      assert.equal(out.code, 78);
    } finally {
      r.cleanup();
    }
  });
});

describe('MCP protocol versions (installed SDK)', () => {
  let s;
  before(async () => {
    s = await startInProcess();
  });
  after(async () => s?.close());

  const sseJson = (body) => JSON.parse(/^data: (.*)$/m.exec(body)?.[1] ?? body);
  const init = (protocolVersion) =>
    rawRequest(s.port, {
      headers: { ...MCP_HEADERS, ...auth(s.token) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'v', version: '1' } } }),
    });

  it('negotiates every version the installed SDK supports and answers others with its latest', async () => {
    const { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } = await import('@modelcontextprotocol/sdk/types.js');
    assert.equal(LATEST_PROTOCOL_VERSION, '2025-11-25');
    assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      const r = await init(v);
      assert.equal(r.status, 200, v);
      assert.equal(sseJson(r.body).result.protocolVersion, v);
    }
    // A client asking for an unknown (e.g. future) version gets the latest supported one back
    // and must decide itself whether to continue; the server does not pretend to speak it.
    const future = await init('2026-07-28');
    assert.equal(future.status, 200);
    assert.equal(sseJson(future.body).result.protocolVersion, '2025-11-25');
    assert.equal(sseJson(future.body).result.capabilities.tasks, undefined, 'no native MCP Tasks capability is advertised');

    // After initialization, a request carrying an unsupported MCP-Protocol-Version header is refused.
    const sid = future.headers['mcp-session-id'];
    const bad = await rawRequest(s.port, {
      headers: { ...MCP_HEADERS, ...auth(s.token), 'mcp-session-id': sid, 'mcp-protocol-version': '2099-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(bad.status, 400);
  });
});

describe('remote-stdio entrypoint', () => {
  it('serves the same remote policy over stdio and refuses a bad config', async () => {
    const r = makeRemoteDir({ port: 8765 });
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(DIST, 'remote-stdio.js'), '--remote-dir', r.dir],
        stderr: 'pipe',
      });
      const client = new Client({ name: 'remote-stdio-test', version: '1' });
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, [...remoteToolNames(false)].sort());
      const denied = await client.callTool({ name: 'read_file', arguments: { path: path.join(r.dir, 'token') } });
      assert.equal(denied.isError, true);
      await client.close();

      r.writeConfig({ schemaVersion: 1, roots: [] });
      const bad = new StdioClientTransport({ command: process.execPath, args: [path.join(DIST, 'remote-stdio.js'), '--remote-dir', r.dir], stderr: 'pipe' });
      const c2 = new Client({ name: 'remote-stdio-test', version: '1' });
      await assert.rejects(c2.connect(bad));
      await c2.close().catch(() => {});
    } finally {
      r.cleanup();
    }
  });
});
