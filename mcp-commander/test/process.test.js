// OS process tools: list_processes and kill_process, against real child processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { load, makeCtx, runTool, textOf, waitFor } from './helpers.js';

const { processTools } = await load('tools/process.js');

const isWindows = process.platform === 'win32';
const NODE = process.execPath;

const { ctx, cleanup } = await makeCtx();
const tools = processTools(ctx);
const call = (name, args) => runTool(tools, name, args);

const children = new Set();
/** A node child that idles for 30s; `script` runs first. Extra argv shows up in its command line. */
function spawnIdle(extraArgs = [], script = '') {
  const child = spawn(NODE, ['-e', `${script};setInterval(() => {}, 1000)`, ...extraArgs], { stdio: 'ignore' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
const exited = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

test.after(() => {
  for (const c of children) c.kill('SIGKILL');
  cleanup();
});

// ---------------------------------------------------------------------------------------------
// list_processes
// ---------------------------------------------------------------------------------------------

const LINE_RE =
  /^PID: (\d+), PPID: (\d+|n\/a), User: (\S+), CPU: ([\d.]+%|n\/a), Memory: ([\d.]+ MB|n\/a)(?: \(([\d.]+)%\))?, Command: (.*)$/;

test('list_processes finds a spawned child by (case-insensitive) filter', { skip: isWindows }, async () => {
  const marker = `mcpc-marker-${randomBytes(4).toString('hex')}`;
  const child = spawnIdle([marker]);
  await waitFor(() => alive(child.pid));
  const r = await waitFor(async () => {
    const res = await call('list_processes', { filter: marker.toUpperCase() });
    return textOf(res).includes(`PID: ${child.pid},`) ? res : null;
  });
  assert.ok(!r.isError);
  const lines = textOf(r).split('\n');
  assert.equal(lines[0], 'Processes (showing 1 of 1, sorted by CPU)');
  assert.equal(lines.length, 2);
  const m = LINE_RE.exec(lines[1]);
  assert.ok(m, `line format: ${lines[1]}`);
  assert.equal(Number(m[1]), child.pid);
  assert.equal(Number(m[2]), process.pid, 'PPID is this test process');
  assert.equal(m[3], execFileSync('id', ['-un'], { encoding: 'utf8' }).trim());
  assert.match(m[5], /^\d+\.\d MB$/, 'resident memory in MB');
  assert.ok(m[6] !== undefined, 'memory percentage shown');
  assert.ok(m[7].includes(marker) && m[7].includes(NODE), `command line: ${m[7]}`);
});

test('list_processes: no match, limit, sort order, truncation, argument validation', { skip: isWindows }, async () => {
  const none = await call('list_processes', { filter: 'no-such-process-mcpc-zzz-' + randomBytes(4).toString('hex') });
  assert.ok(!none.isError);
  assert.match(textOf(none), /^Processes \(showing 0 of 0, sorted by CPU\)\nNo process command line contains "no-such-process-mcpc-zzz-[0-9a-f]+"$/);

  const r = await call('list_processes', { limit: '5' });
  const lines = textOf(r).split('\n');
  const head = /^Processes \(showing 5 of (\d+), sorted by CPU\)$/.exec(lines[0]);
  assert.ok(head, lines[0]);
  assert.ok(Number(head[1]) >= 5);
  assert.equal(lines.length, 6);
  const cpus = lines.slice(1).map((l) => {
    const m = LINE_RE.exec(l);
    assert.ok(m, `line format: ${l}`);
    return Number.parseFloat(m[4]);
  });
  for (let i = 1; i < cpus.length; i++) assert.ok(cpus[i - 1] >= cpus[i], `sorted by CPU desc: ${cpus}`);

  const all = textOf(await call('list_processes', {}));
  const total = Number(/of (\d+),/.exec(all)[1]);
  assert.equal(all.split('\n').length - 1, Math.min(100, total), 'default limit is 100');

  const longMarker = `mcpc-long-${randomBytes(4).toString('hex')}-${'x'.repeat(300)}`;
  const child = spawnIdle([longMarker]);
  const found = await waitFor(async () => {
    const t = textOf(await call('list_processes', { filter: longMarker.slice(0, 20) }));
    return t.includes(`PID: ${child.pid},`) ? t : null;
  });
  const cmd = found.split('\n')[1].split('Command: ')[1];
  assert.equal(cmd.length, 200, 'command truncated to 200 chars');
  assert.ok(cmd.endsWith('...'));

  for (const limit of [0, 2001, 'abc']) {
    const bad = await call('list_processes', { limit });
    assert.equal(bad.isError, true, `limit ${limit} rejected`);
    assert.match(textOf(bad), /^Error: Invalid arguments: limit: /);
  }
});

// ---------------------------------------------------------------------------------------------
// kill_process
// ---------------------------------------------------------------------------------------------

test('kill_process refuses init, pid 0, negative pids, this server and its parent', async () => {
  const cases = [
    [1, 'Error: Refusing to signal PID 1: PID 1 is the init/launchd process'],
    [0, "Error: Refusing to signal PID 0: PID 0 addresses this server's whole process group"],
    [-1, 'Error: Refusing to signal PID -1: negative PIDs address whole process groups'],
    [process.pid, `Error: Refusing to signal PID ${process.pid}: it is this MCP server itself`],
    [process.ppid, `Error: Refusing to signal PID ${process.ppid}: it is the parent of this MCP server (the MCP client)`],
  ];
  for (const [pid, expected] of cases) {
    const r = await call('kill_process', { pid });
    assert.equal(r.isError, true, `pid ${pid}`);
    assert.equal(textOf(r), expected);
  }
  assert.ok(alive(process.pid));
});

test('kill_process terminates a spawned process, then reports it gone', { skip: isWindows }, async () => {
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  children.add(sleeper);
  await waitFor(() => alive(sleeper.pid));
  const r = await call('kill_process', { pid: String(sleeper.pid) });
  assert.ok(!r.isError, textOf(r));
  assert.equal(textOf(r), `Successfully terminated process ${sleeper.pid}`);
  await exited(sleeper);
  assert.equal(sleeper.signalCode, 'SIGTERM');

  const again = await call('kill_process', { pid: sleeper.pid });
  assert.equal(again.isError, true);
  assert.equal(textOf(again), `Error: No process with PID ${sleeper.pid}`);
});

test('kill_process: a process that ignores SIGTERM is reported alive; SIGKILL (any spelling) stops it', { skip: isWindows }, async () => {
  const stubborn = spawn(NODE, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.add(stubborn);
  // the SIGTERM handler is installed before 'ready' is printed
  await new Promise((resolve) => stubborn.stdout.once('data', resolve));
  const t0 = Date.now();
  const r = await call('kill_process', { pid: stubborn.pid, signal: 'SIGTERM' });
  assert.ok(Date.now() - t0 >= 900, 'polled for about a second');
  assert.equal(textOf(r), `Sent SIGTERM to process ${stubborn.pid}, but it is still running. Use signal "SIGKILL" to force it`);
  assert.ok(alive(stubborn.pid));

  const k = await call('kill_process', { pid: stubborn.pid, signal: 'kill' });
  assert.equal(textOf(k), `Successfully terminated process ${stubborn.pid}`);
  await exited(stubborn);
  assert.equal(stubborn.signalCode, 'SIGKILL');

  const bad = await call('kill_process', { pid: 12345, signal: 'SIGSTOP' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /^Error: Invalid arguments: signal: /);
});

test('kill_process reports EPERM for another user\'s process', { skip: isWindows || process.getuid?.() === 0 }, async (t) => {
  // Find a root process we may not signal. kill(pid, 0) performs the same permission check
  // without delivering anything, so this never signals a process we are allowed to touch.
  const out = execFileSync('ps', ['-axo', 'pid=,uid='], { encoding: 'utf8' });
  const target = out
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, uid]) => pid > 1 && uid === 0)
    .map(([pid]) => pid)
    .find((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return err.code === 'EPERM';
      }
    });
  if (!target) {
    t.skip('no root-owned process found that this user cannot signal');
    return;
  }
  const r = await call('kill_process', { pid: target });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), `Error: Permission denied to signal PID ${target}`);
});

// ---------------------------------------------------------------------------------------------
// Through a real MCP client, when the full server builds
// ---------------------------------------------------------------------------------------------

test('through an in-memory MCP client: schemas and coercion', async (t) => {
  let conn;
  try {
    await load('server.js');
    const { connectInMemory } = await import('./helpers.js');
    conn = await connectInMemory();
  } catch (err) {
    t.skip(`server.js not loadable yet: ${err.message.split('\n')[0]}`);
    return;
  }
  try {
    const listed = await conn.client.listTools();
    const names = listed.tools.map((x) => x.name);
    assert.deepEqual(names.filter((n) => n === 'list_processes' || n === 'kill_process'), ['list_processes', 'kill_process']);
    const kill = listed.tools.find((x) => x.name === 'kill_process');
    assert.deepEqual(kill.inputSchema.required, ['pid']);
    const r = await conn.call('kill_process', { pid: '1' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Refusing to signal PID 1/);
    const l = await conn.call('list_processes', { filter: String(process.pid), limit: '2000' });
    assert.ok(!l.isError, textOf(l));
    assert.match(textOf(l), /^Processes \(showing \d+ of \d+, sorted by CPU\)/);
  } finally {
    await conn.close();
  }
});
