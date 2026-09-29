// End-to-end over the real stdio transport: spawns `node dist/index.js` exactly the way an MCP
// client (Claude Desktop / Claude Code) does and drives a realistic session through it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DIST, ROOT, rmrf, sleep, textOf, tmpDir, waitFor } from './helpers.js';

const EXPECTED_TOOLS = [
  'get_config', 'set_config_value',
  'read_file', 'read_multiple_files', 'write_file', 'create_directory', 'list_directory', 'move_file', 'get_file_info',
  'start_search', 'get_more_search_results', 'stop_search', 'list_searches',
  'edit_block',
  'start_process', 'read_process_output', 'interact_with_process', 'force_terminate', 'list_sessions',
  'list_processes', 'kill_process',
  'list_windows', 'inspect_ui', 'press_element', 'set_element_value',
  'get_recent_tool_calls', 'get_usage_stats',
];

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('stdio server', () => {
  let client;
  let transport;
  let work;
  let configDir;
  const transportErrors = [];
  let stderr = '';

  const call = async (name, args = {}) => client.callTool({ name, arguments: args });

  before(async () => {
    work = tmpDir('mcpc-e2e-');
    configDir = tmpDir('mcpc-e2e-config-');
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(DIST, 'index.js')],
      env: { ...process.env, MCP_COMMANDER_CONFIG_DIR: configDir },
      stderr: 'pipe',
    });
    transport.stderr.on('data', (d) => (stderr += d));
    client = new Client({ name: 'stdio-e2e', version: '1.0.0' });
    client.onerror = (e) => transportErrors.push(e);
    await client.connect(transport);
  });

  after(async () => {
    await client?.close().catch(() => {});
    rmrf(work);
    rmrf(configDir);
  });

  it('handshakes and lists every tool in a stable order', async () => {
    assert.equal(client.getServerVersion().name, 'mcp-commander');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), EXPECTED_TOOLS);
    // The local server is unchanged by the remote-only job tools and idempotency wrapper.
    assert.equal(tools.length, 27);
    assert.ok(!tools.some((t) => t.name.startsWith('job_')));
    for (const t of tools) assert.ok(!('idempotencyKey' in (t.inputSchema.properties ?? {})), t.name);
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 30, `${t.name} has a real description`);
      assert.equal(t.description, t.description.trim(), `${t.name} description is trimmed`);
      assert.equal(t.inputSchema.type, 'object');
    }
    const start = tools.find((t) => t.name === 'start_process');
    assert.deepEqual(start.inputSchema.required, ['command']);
  });

  it('writes, reads, edits and searches a file', async () => {
    const file = path.join(work, 'notes', 'todo.md');
    let r = await call('write_file', { path: file, content: '# Todo\n- buy milk\n- call Bob\n' });
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /Successfully wrote to/);

    r = await call('read_file', { path: file });
    assert.match(textOf(r), /^\[Reading 3 lines from start \(total: 3 lines, 0 remaining\)\]\n\n# Todo\n- buy milk\n- call Bob$/);

    r = await call('edit_block', { file_path: file, old_string: '- call Bob', new_string: '- call Alice' });
    assert.ok(!r.isError, textOf(r));
    assert.equal(fs.readFileSync(file, 'utf8'), '# Todo\n- buy milk\n- call Alice\n');

    r = await call('edit_block', { file_path: file, old_string: '- call Bobby', new_string: 'x' });
    assert.equal(r.isError, true, 'a failed edit is reported as an error');

    r = await call('start_search', { path: work, pattern: 'alice', searchType: 'content' });
    assert.match(textOf(r), /todo\.md:3/);
  });

  it('runs commands and talks to an interactive REPL', async () => {
    let r = await call('start_process', { command: 'echo hello-from-shell', timeout_ms: 5000 });
    assert.match(textOf(r), /hello-from-shell/);
    assert.match(textOf(r), /exited with code 0/);

    r = await call('start_process', { command: 'python3 -i -q', timeout_ms: 8000 });
    const pid = Number(/PID (\d+)/.exec(textOf(r))[1]);
    assert.match(textOf(r), /waiting for input/);
    r = await call('interact_with_process', { pid, input: 'x = 6 * 7' });
    r = await call('interact_with_process', { pid, input: 'print(x)' });
    assert.match(textOf(r), /42/);
    r = await call('force_terminate', { pid });
    assert.ok(!r.isError, textOf(r));
  });

  it('enforces the command blocklist and allowedDirectories', async () => {
    let r = await call('start_process', { command: 'bash -c "sudo reboot"', timeout_ms: 1000 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /not allowed/i);

    r = await call('set_config_value', { key: 'allowedDirectories', value: [work] });
    assert.ok(!r.isError, textOf(r));
    r = await call('read_file', { path: '/etc/hosts' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Path not allowed/);
    r = await call('set_config_value', { key: 'allowedDirectories', value: [] });
    assert.ok(!r.isError, textOf(r));
  });

  it('tells the model about unsupported parameters instead of silently dropping them', async () => {
    const r = await call('list_directory', { path: work, view_range: [1, 2] });
    assert.match(textOf(r), /parameters not supported by this tool, which were ignored: view_range/);
    assert.match(textOf(r), /\[DIR\] notes/);
  });

  it('keeps a call history', async () => {
    const r = await call('get_recent_tool_calls', { maxResults: 5 });
    assert.match(textOf(r), /Tool Call History \(5 results/);
    assert.match(textOf(r), /"toolName": "list_directory"/);
  });

  it('never writes non-protocol bytes to stdout', () => {
    assert.deepEqual(transportErrors, [], `transport errors: ${transportErrors.join('; ')}\nstderr:\n${stderr}`);
  });

  it('kills its child processes when the client disconnects', async () => {
    const r = await call('start_process', { command: 'sleep 300', timeout_ms: 300 });
    const pid = Number(/PID (\d+)/.exec(textOf(r))[1]);
    assert.ok(alive(pid));
    const serverPid = transport.pid;
    await client.close();
    await waitFor(() => !alive(serverPid), { timeout: 5000 });
    await waitFor(() => !alive(pid), { timeout: 5000 });
    await sleep(10);
  });
});

// Raw newline-delimited JSON-RPC, for what the SDK client never sends (no `arguments`, oversized lines).
function rawServer(args = [], env = {}) {
  const configDir = env.MCP_COMMANDER_CONFIG_DIR ?? tmpDir('mcpc-raw-config-');
  const child = spawn(process.execPath, [path.join(DIST, 'index.js'), ...args], {
    env: { ...process.env, MCP_COMMANDER_CONFIG_DIR: configDir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  const waiters = new Map();
  let buf = '';
  let stderr = '';
  const nonJson = [];
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        nonJson.push(line);
        continue;
      }
      waiters.get(msg.id)?.(msg);
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      waiters.set(myId, resolve);
      exited.then((code) => reject(new Error(`server exited (${code}) before answering ${method}:\n${stderr}`)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  const init = async () => {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  };
  const rawText = (r) => (r.result?.content ?? []).map((c) => c.text).join('\n');
  return { child, request, init, exited, nonJson, rawText, configDir, stderr: () => stderr };
}

describe('stdio server (raw JSON-RPC)', () => {
  it('accepts tools/call without an `arguments` object (it is optional in MCP)', async () => {
    const s = rawServer();
    try {
      await s.init();
      let r = await s.request('tools/call', { name: 'get_config' });
      assert.notEqual(r.result.isError, true, s.rawText(r));
      assert.match(s.rawText(r), /^Current configuration:/);
      r = await s.request('tools/call', { name: 'list_sessions' });
      assert.notEqual(r.result.isError, true, s.rawText(r));
      // a tool with a required parameter still reports it
      r = await s.request('tools/call', { name: 'read_file' });
      assert.equal(r.result.isError, true);
      assert.match(s.rawText(r), /Required/);
      assert.deepEqual(s.nonJson, []);
    } finally {
      s.child.stdin.end();
      await s.exited;
      rmrf(s.configDir);
    }
  });

  it('exits and kills its children when the transport dies on an oversized message', async () => {
    const s = rawServer();
    let pid;
    try {
      await s.init();
      const r = await s.request('tools/call', { name: 'start_process', arguments: { command: 'sleep 300', timeout_ms: 300 } });
      pid = Number(/PID (\d+)/.exec(s.rawText(r))[1]);
      assert.ok(alive(pid));
      // over the SDK's 10MB read buffer: the transport closes itself and would never read again
      s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'write_file', arguments: { path: '/nonexistent/x', content: 'y'.repeat(11 * 1024 * 1024) } } }) + '\n');
      const code = await Promise.race([s.exited, sleep(8000).then(() => 'still running')]);
      assert.equal(code, 1, `server exit: ${code}\nstderr:\n${s.stderr()}`);
      await waitFor(() => !alive(pid), { timeout: 5000 });
      assert.match(s.stderr(), /transport error: ReadBuffer exceeded maximum size/);
    } finally {
      if (s.child.exitCode === null) s.child.kill('SIGKILL');
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      rmrf(s.configDir);
    }
  });

  it('starts even when the config location cannot be created, and says so in get_config', async () => {
    const root = tmpDir('mcpc-raw-');
    const blocker = path.join(root, 'file-not-dir');
    fs.writeFileSync(blocker, 'x');
    const s = rawServer([], { MCP_COMMANDER_CONFIG_DIR: blocker });
    try {
      await s.init();
      const r = await s.request('tools/call', { name: 'get_config', arguments: {} });
      assert.notEqual(r.result.isError, true, s.rawText(r));
      assert.match(s.rawText(r), /"configWarning": "Could not create /);
      assert.deepEqual(s.nonJson, []);
    } finally {
      s.child.stdin.end();
      assert.equal(await s.exited, 0);
      rmrf(root);
    }
  });

  it('an empty --config-dir falls back to the default instead of the current directory', async () => {
    const cwd = tmpDir('mcpc-raw-cwd-');
    const configDir = tmpDir('mcpc-raw-config-');
    const child = spawn(process.execPath, [path.join(DIST, 'index.js'), '--config-dir='], {
      cwd,
      env: { ...process.env, MCP_COMMANDER_CONFIG_DIR: configDir },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    try {
      await waitFor(() => /ready/.test(stderr), { timeout: 5000 });
      assert.ok(fs.existsSync(path.join(configDir, 'config.json')), stderr);
      assert.deepEqual(fs.readdirSync(cwd), []);
    } finally {
      child.stdin.end();
      await new Promise((r) => child.once('exit', r));
      rmrf(cwd);
      rmrf(configDir);
    }
  });
});

describe('stdio server shutdown and packaging', () => {
  it('stdin EOF does not cut off a large response the client has not read yet', async () => {
    const work = tmpDir('mcpc-raw-eof-');
    const big = path.join(work, 'big.txt');
    fs.writeFileSync(big, `${'x'.repeat(600)}\n`.repeat(1000)); // ~600KB reply, far over a pipe buffer
    const s = rawServer();
    try {
      await s.init();
      // A slow reader: the reply fills the pipe and the rest waits in the server's stdout buffer.
      s.child.stdout.pause();
      const reply = s.request('tools/call', { name: 'read_file', arguments: { path: big } }).catch((e) => e);
      await sleep(500);
      s.child.stdin.end(); // the client starts the MCP shutdown
      await sleep(300);
      s.child.stdout.resume();
      const r = await reply;
      assert.ok(!(r instanceof Error), String(r));
      assert.match(s.rawText(r), /^\[Reading 1000 lines from start/);
      assert.equal(s.rawText(r).split('\n').filter((l) => l === 'x'.repeat(600)).length, 1000);
      assert.equal(await s.exited, 0);
      assert.deepEqual(s.nonJson.map((l) => l.slice(0, 80)), [], 'stdout carried a truncated JSON line');
    } finally {
      if (s.child.exitCode === null) s.child.kill('SIGKILL');
      rmrf(work);
      rmrf(s.configDir);
    }
  });

  it('answers every request already received when stdin closes (e.g. `cat requests | mcp-commander`)', async () => {
    const work = tmpDir('mcpc-raw-eof-');
    const big = path.join(work, 'big.txt');
    fs.writeFileSync(big, `${'y'.repeat(300)}\n`.repeat(1000));
    const s = rawServer();
    try {
      // everything in one write, then EOF: nothing waits for a reply before closing
      const init = s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } });
      s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const replies = [
        s.request('tools/call', { name: 'read_file', arguments: { path: big } }),
        s.request('tools/call', { name: 'get_file_info', arguments: { path: big } }),
        s.request('tools/call', { name: 'list_directory', arguments: { path: work } }),
      ];
      s.child.stdin.end();
      await init;
      const [read, info, list] = await Promise.all(replies);
      assert.match(s.rawText(read), /^\[Reading 1000 lines from start/);
      assert.match(s.rawText(info), /size/i);
      assert.match(s.rawText(list), /\[FILE\] big\.txt/);
      assert.equal(await s.exited, 0);
      assert.deepEqual(s.nonJson, []);
    } finally {
      if (s.child.exitCode === null) s.child.kill('SIGKILL');
      rmrf(work);
      rmrf(s.configDir);
    }
  });

  it('the npm package ships dist/, README.md, LICENSE, docs/remote-runbook.md and package.json only', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = JSON.parse(out)[0].files.map((f) => f.path);
    const top = [...new Set(files.map((f) => f.split('/')[0]))].sort();
    assert.deepEqual(top, ['LICENSE', 'README.md', 'dist', 'docs', 'package.json']);
    assert.deepEqual(files.filter((f) => f.startsWith('docs/')), ['docs/remote-runbook.md'], 'only the runbook ships from docs/');
    assert.ok(files.includes('dist/index.js'), 'the bin entry is packed');
    assert.ok(files.includes('dist/tools/fuzzy-worker.js'), 'the worker entry is packed');
  });
});
