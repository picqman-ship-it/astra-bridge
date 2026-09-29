// Optional idempotencyKey on the remote mutating tools: replay of recorded results, conflicts,
// concurrent claims, bounded capacity, fail-closed state (corrupt, EACCES, ENOSPC), the
// action-completed/result-not-recorded crash window (injected and with a real SIGKILL), sharing
// the store between HTTP and remote-stdio processes, and retries after a server restart.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DIST, load, textOf } from './helpers.js';
import { cleanupJobs, connectHttp, freePort, makeRemoteDir, startChild, startInProcess, stopChild } from './remote-helpers.js';

const durable = await load('remote/durable.js');
const { IDEMPOTENT_TOOLS } = await load('remote/idempotency.js');

const uuid = () => crypto.randomUUID();
const idemDir = (remoteDir) => path.join(remoteDir, 'durable', 'idem');
const keyFile = (remoteDir, key) => path.join(idemDir(remoteDir), `${durable.sha256(key)}.json`);
const REPLAY = /idempotent replay: .*NOT executed again/;

describe('idempotencyKey on remote file tools (HTTP, real SDK)', () => {
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

  it('is an optional parameter of exactly the mutating tools', async () => {
    const tools = (await c.client.listTools()).tools;
    for (const t of tools) {
      const has = 'idempotencyKey' in (t.inputSchema.properties ?? {});
      assert.equal(has, IDEMPOTENT_TOOLS.includes(t.name), t.name);
      if (has) assert.ok(!(t.inputSchema.required ?? []).includes('idempotencyKey'), t.name);
    }
    assert.deepEqual(
      tools.filter((t) => 'idempotencyKey' in (t.inputSchema.properties ?? {})).map((t) => t.name).sort(),
      ['create_directory', 'edit_block', 'move_file', 'write_file'],
    );
  });

  it('a retried append with the same key is replayed, not executed again', async () => {
    const file = path.join(s.work, 'append.txt');
    const key = uuid();
    const first = await c.call('write_file', { path: file, content: 'line\n', mode: 'append', idempotencyKey: key });
    assert.equal(first.isError, undefined, textOf(first));
    const second = await c.call('write_file', { path: file, content: 'line\n', mode: 'append', idempotencyKey: key });
    assert.equal(second.isError, undefined);
    assert.match(textOf(second), REPLAY);
    assert.match(textOf(second), /Successfully appended/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'line\n');
    const rec = JSON.parse(fs.readFileSync(keyFile(s.dir, key), 'utf8'));
    assert.equal(rec.state, 'completed');
    assert.ok(!JSON.stringify(rec).includes(key), 'the key itself is stored only as a hash');
    assert.equal(fs.statSync(keyFile(s.dir, key)).mode & 0o777, 0o600);
  });

  it('concurrent calls with one key execute once', async () => {
    const file = path.join(s.work, 'concurrent.txt');
    const key = uuid();
    const args = { path: file, content: 'x\n', mode: 'append', idempotencyKey: key };
    const results = await Promise.all(Array.from({ length: 6 }, () => c.call('write_file', args)));
    assert.equal(fs.readFileSync(file, 'utf8'), 'x\n');
    const executed = results.filter((r) => !r.isError && !REPLAY.test(textOf(r)));
    assert.equal(executed.length, 1);
    for (const r of results) if (r !== executed[0]) assert.match(textOf(r), /NOT executed again|still in progress/);
  });

  it('refuses the same key with different arguments or another tool; calls without a key are unprotected', async () => {
    const file = path.join(s.work, 'conflict.txt');
    const key = uuid();
    await c.call('write_file', { path: file, content: 'a\n', mode: 'append', idempotencyKey: key });
    const changed = await c.call('write_file', { path: file, content: 'b\n', mode: 'append', idempotencyKey: key });
    assert.equal(changed.isError, true);
    assert.match(textOf(changed), /different call \(same tool, different arguments\)/);
    const otherTool = await c.call('create_directory', { path: path.join(s.work, 'dir-x'), idempotencyKey: key });
    assert.equal(otherTool.isError, true);
    assert.match(textOf(otherTool), /tool write_file/);
    assert.equal(fs.existsSync(path.join(s.work, 'dir-x')), false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\n');

    await c.call('write_file', { path: file, content: 'n\n', mode: 'append' });
    await c.call('write_file', { path: file, content: 'n\n', mode: 'append' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\nn\nn\n', 'without a key a retry runs again');

    const bad = await c.call('write_file', { path: file, content: 'z\n', mode: 'append', idempotencyKey: 'short' });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /idempotencyKey must be/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\nn\nn\n');
  });

  it('replays move_file, create_directory and edit_block instead of failing or repeating them', async () => {
    const src = path.join(s.work, 'm-src.txt');
    const dst = path.join(s.work, 'm-dst.txt');
    fs.writeFileSync(src, 'move me');
    const mk = uuid();
    assert.equal((await c.call('move_file', { source: src, destination: dst, idempotencyKey: mk })).isError, undefined);
    const again = await c.call('move_file', { source: src, destination: dst, idempotencyKey: mk });
    assert.equal(again.isError, undefined, 'the retry reports the original success, not "source not found"');
    assert.match(textOf(again), REPLAY);

    const dk = uuid();
    const dir = path.join(s.work, 'made');
    assert.match(textOf(await c.call('create_directory', { path: dir, idempotencyKey: dk })), /Successfully created/);
    assert.match(textOf(await c.call('create_directory', { path: dir, idempotencyKey: dk })), /Successfully created/);

    const f = path.join(s.work, 'edit.txt');
    fs.writeFileSync(f, 'count: x\n');
    const ek = uuid();
    const edit = { file_path: f, old_string: 'x', new_string: 'xx', expected_replacements: 1, idempotencyKey: ek };
    assert.equal((await c.call('edit_block', edit)).isError, undefined);
    assert.match(textOf(await c.call('edit_block', edit)), REPLAY);
    assert.equal(fs.readFileSync(f, 'utf8'), 'count: xx\n');
    // Defaults are part of the normalized request: omitting expected_replacements is the same call.
    const { expected_replacements: _, ...withoutDefault } = edit;
    assert.match(textOf(await c.call('edit_block', withoutDefault)), REPLAY);
  });

  it('fails closed on a malformed record, an unwritable store and a full disk before acting', async () => {
    const file = path.join(s.work, 'fc.txt');
    const key = uuid();
    fs.mkdirSync(idemDir(s.dir), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile(s.dir, key), '{"v":1,', { mode: 0o600 });
    const corrupt = await c.call('write_file', { path: file, content: 'c\n', mode: 'append', idempotencyKey: key });
    assert.equal(corrupt.isError, true);
    assert.match(textOf(corrupt), /NOT executed \(fail closed\).*malformed/);
    assert.equal(fs.existsSync(file), false);

    fs.chmodSync(idemDir(s.dir), 0o500);
    try {
      const r = await c.call('write_file', { path: file, content: 'c\n', mode: 'append', idempotencyKey: uuid() });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /NOT executed.*EACCES/);
      assert.equal(fs.existsSync(file), false);
    } finally {
      fs.chmodSync(idemDir(s.dir), 0o700);
    }

    durable.faults.beforeWrite = (p) => {
      if (p.includes(`${path.sep}idem${path.sep}`)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    try {
      const r = await c.call('write_file', { path: file, content: 'c\n', mode: 'append', idempotencyKey: uuid() });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /NOT executed.*ENOSPC/);
      assert.equal(fs.existsSync(file), false);
    } finally {
      durable.faults.beforeWrite = undefined;
    }
  });

  it('action completed but result not recorded: the caller is warned and a retry reports an unknown outcome, never a rerun', async () => {
    const file = path.join(s.work, 'window.txt');
    const key = uuid();
    const kf = keyFile(s.dir, key);
    let writes = 0;
    durable.faults.beforeWrite = (p) => {
      // First write of this record = the pending claim; the second = the completed result.
      if (p === kf && ++writes === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    let first;
    try {
      first = await c.call('write_file', { path: file, content: 'once\n', mode: 'append', idempotencyKey: key });
    } finally {
      durable.faults.beforeWrite = undefined;
    }
    assert.equal(first.isError, undefined);
    assert.match(textOf(first), /Successfully appended/);
    assert.match(textOf(first), /result could not be recorded/);
    // The call is no longer in flight, so even this same (live) server process must not claim
    // "in progress": the honest answer is an unknown outcome.
    const retry = await c.call('write_file', { path: file, content: 'once\n', mode: 'append', idempotencyKey: key });
    assert.equal(retry.isError, true);
    assert.match(textOf(retry), /Outcome unknown: .*NOT executed again/);
    assert.doesNotMatch(textOf(retry), /still in progress/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'once\n');
  });

  it('keeps keys and content out of the audit log', async () => {
    const key = uuid();
    const marker = `secret-${uuid()}`;
    await c.call('write_file', { path: path.join(s.work, 'audit.txt'), content: marker, idempotencyKey: key });
    await c.call('write_file', { path: path.join(s.work, 'audit.txt'), content: marker, idempotencyKey: key });
    const audit = fs.readFileSync(s.auditFile, 'utf8');
    assert.ok(!audit.includes(key) && !audit.includes(durable.sha256(key)) && !audit.includes(marker));
    for (const l of audit.trim().split('\n').map((x) => JSON.parse(x)).filter((x) => x.event === 'tool')) {
      assert.deepEqual(Object.keys(l).sort(), ['durationMs', 'event', 'session', 'status', 'tool', 'ts']);
    }
  });
});

describe('idempotency capacity', () => {
  it('refuses new keys when full, without executing, and never evicts old keys', async () => {
    const s = await startInProcess({ idempotency: { maxKeys: 3 } });
    const c = await connectHttp(s.port, s.token);
    try {
      const file = path.join(s.work, 'cap.txt');
      const keys = [uuid(), uuid(), uuid()];
      for (const k of keys) await c.call('write_file', { path: file, content: 'k\n', mode: 'append', idempotencyKey: k });
      const full = await c.call('write_file', { path: file, content: 'k\n', mode: 'append', idempotencyKey: uuid() });
      assert.equal(full.isError, true);
      assert.match(textOf(full), /Idempotency store is full \(3 keys/);
      assert.doesNotMatch(textOf(full), /without idempotencyKey/, 'never suggests dropping duplicate protection');
      assert.equal(fs.readFileSync(file, 'utf8'), 'k\nk\nk\n');
      assert.match(textOf(await c.call('write_file', { path: file, content: 'k\n', mode: 'append', idempotencyKey: keys[0] })), REPLAY);
      assert.equal(fs.readdirSync(idemDir(s.dir)).filter((f) => f.endsWith('.json')).length, 3);
    } finally {
      await c.close();
      await s.close();
    }
  });
});

describe('idempotency across processes, crashes and restarts', () => {
  it('a server SIGKILLed after acting but before recording: a fresh server reports outcome unknown and does not rerun', async () => {
    const port = await freePort();
    const r = makeRemoteDir({ port });
    let child;
    try {
      const file = path.join(r.work, 'crash.txt');
      const key = uuid();
      // A real remote runtime and the real wrapped write_file; the process kills itself at the
      // moment it would record the result (the second write of the key's record).
      const code = `
        const { loadRemoteConfig } = await import(${JSON.stringify(pathToFileURL(path.join(DIST, 'remote', 'config.js')).href)});
        const { RemoteRuntime } = await import(${JSON.stringify(pathToFileURL(path.join(DIST, 'remote', 'runtime.js')).href)});
        const { faults } = await import(${JSON.stringify(pathToFileURL(path.join(DIST, 'remote', 'durable.js')).href)});
        const rt = new RemoteRuntime(loadRemoteConfig(process.argv[1]));
        const tool = rt.createServer(() => 'x').tools.find((t) => t.name === 'write_file');
        let n = 0;
        faults.beforeWrite = (p) => { if (p.includes('/idem/') && ++n === 2) process.kill(process.pid, 'SIGKILL'); };
        await tool.handler({ path: process.argv[2], content: 'once\\n', mode: 'append', idempotencyKey: process.argv[3] });
        process.stdout.write('not killed');`;
      const exit = await new Promise((resolve) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', code, r.dir, file, key], { stdio: ['ignore', 'pipe', 'pipe'] });
        p.on('exit', (c, sig) => resolve(sig ?? c));
      });
      assert.equal(exit, 'SIGKILL');
      assert.equal(fs.readFileSync(file, 'utf8'), 'once\n', 'the action happened');
      assert.equal(JSON.parse(fs.readFileSync(keyFile(r.dir, key), 'utf8')).state, 'pending');

      child = await startChild(r.dir);
      const c = await connectHttp(port, r.token);
      const retry = await c.call('write_file', { path: file, content: 'once\n', mode: 'append', idempotencyKey: key });
      assert.equal(retry.isError, true);
      assert.match(textOf(retry), /Outcome unknown: .*NOT executed again/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'once\n');
      await c.close();
    } finally {
      if (child) await stopChild(child);
      r.cleanup();
    }
  });

  it('HTTP and remote-stdio processes share one store; a retry after a full server restart is replayed', async () => {
    const port = await freePort();
    const r = makeRemoteDir({ port });
    let child;
    let stdio;
    try {
      child = await startChild(r.dir);
      const h = await connectHttp(port, r.token);
      stdio = new Client({ name: 'idem-stdio', version: '1' });
      await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(DIST, 'remote-stdio.js'), '--remote-dir', r.dir], stderr: 'pipe' }));
      const file = path.join(r.work, 'shared.txt');
      const args = { path: file, content: 'shared\n', mode: 'append', idempotencyKey: uuid() };
      const results = await Promise.all([
        h.call('write_file', args),
        stdio.callTool({ name: 'write_file', arguments: args }),
        h.call('write_file', args),
        stdio.callTool({ name: 'write_file', arguments: args }),
      ]);
      assert.equal(fs.readFileSync(file, 'utf8'), 'shared\n');
      assert.equal(results.filter((x) => !x.isError && !REPLAY.test(textOf(x))).length, 1);
      await h.close();

      assert.equal(await stopChild(child), 0);
      child = await startChild(r.dir);
      const h2 = await connectHttp(port, r.token);
      const replay = await h2.call('write_file', args);
      assert.match(textOf(replay), REPLAY);
      assert.equal(fs.readFileSync(file, 'utf8'), 'shared\n');
      await h2.close();
    } finally {
      await stdio?.close().catch(() => {});
      if (child) await stopChild(child);
      r.cleanup();
    }
  });
});

describe('idempotency on trusted terminal tools', () => {
  it('interact_with_process and start_process with a key run once', async () => {
    const s = await startInProcess({ trustedTerminal: true });
    const c = await connectHttp(s.port, s.token);
    let pid;
    try {
      const start = await c.call('start_process', { command: 'python3 -i -q', timeout_ms: 5000 });
      pid = Number(/PID (\d+)/.exec(textOf(start))?.[1]);
      await c.call('interact_with_process', { pid, input: 'n = 0', timeout_ms: 5000 });
      const inc = { pid, input: 'n += 1; print("n=%d" % n)', timeout_ms: 5000, idempotencyKey: uuid() };
      assert.match(textOf(await c.call('interact_with_process', inc)), /n=1/);
      const again = await c.call('interact_with_process', inc);
      assert.match(textOf(again), REPLAY);
      assert.match(textOf(await c.call('interact_with_process', { pid, input: 'print("now=%d" % n)', timeout_ms: 5000 })), /now=1/);

      const sk = { command: 'sleep 20', timeout_ms: 200, idempotencyKey: uuid() };
      const p1 = Number(/PID (\d+)/.exec(textOf(await c.call('start_process', sk)))?.[1]);
      const second = await c.call('start_process', sk);
      assert.match(textOf(second), REPLAY);
      assert.match(textOf(second), /does not show the current state/);
      assert.equal(Number(/PID (\d+)/.exec(textOf(second))?.[1]), p1);
      const sessions = textOf(await c.call('list_sessions'));
      assert.equal((sessions.match(/Command: sleep 20/g) ?? []).length, 1, sessions);
      await c.call('force_terminate', { pid: p1 });
    } finally {
      if (pid) await c.call('force_terminate', { pid }).catch(() => {});
      await c.close();
      await s.close();
      await cleanupJobs(s.dir);
    }
  });
});
