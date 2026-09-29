// End-to-end scenarios from the model's point of view: a real MCP client talks to a real server
// (connectInMemory) and every decision is taken by reading the returned TEXT, the way a model
// would — PIDs, line numbers, continuation offsets and ports are all parsed out of tool output.
// Several scenarios started as { todo } reproductions of real bugs (prompt detection without a
// TTY, python stdout/stderr ordering, write_file line counts); they are regression tests now.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { connectInMemory, load, rmrf, textOf, tmpDir, waitFor } from './helpers.js';

const { findExecutable } = await load('terminal/shell.js');

const isWindows = process.platform === 'win32';
const SH = '/bin/sh';
const python = !isWindows && findExecutable('python3');
const npm = !isWindows && findExecutable('npm');
const curl = !isWindows && findExecutable('curl');

const pidOf = (text) => {
  const m = /Process started with PID (\d+)/.exec(text);
  assert.ok(m, `no PID in: ${text}`);
  return Number(m[1]);
};

/** A connected client plus a `run(tool, args)` that returns { text, isError } like a model sees it. */
async function session(t, configOverrides) {
  const env = await connectInMemory(configOverrides);
  t.after(() => env.close());
  const run = async (name, args = {}) => {
    const r = await env.call(name, args);
    return { text: textOf(r), isError: r.isError === true };
  };
  const ok = async (name, args) => {
    const r = await run(name, args);
    assert.equal(r.isError, false, `${name} failed: ${r.text}`);
    return r.text;
  };
  return { env, run, ok };
}

/** Starts a command through the default-free /bin/sh so user login profiles never leak in. */
const startArgs = (command, extra = {}) => ({ command, shell: SH, timeout_ms: 10000, ...extra });

/** Keeps calling read_process_output (offset 0) until `done(text)`; returns everything read. */
async function readUntil(ok, pid, done, { maxCalls = 40, timeout_ms = 2000 } = {}) {
  let all = '';
  for (let i = 0; i < maxCalls; i++) {
    const text = await ok('read_process_output', { pid, timeout_ms });
    all += `${text}\n`;
    if (done(text, all)) return all;
  }
  assert.fail(`condition not reached after ${maxCalls} reads:\n${all}`);
}

const waitingFor = (text) => /🔄 Process \d+ is waiting for input \(detected: "([^"]*)"\)$/.exec(text)?.[1] ?? null;

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// ---------------------------------------------------------------------------------------------
// (1) Scaffold a Node project, run its tests, find the bug, fix it, rerun until green
// ---------------------------------------------------------------------------------------------

test('scenario: scaffold a tiny Node project, npm test fails, search + edit_block fix, green', { skip: !npm && 'npm not installed' }, async (t) => {
  const { ok } = await session(t);
  const dir = tmpDir('mcpc-scen-node-');
  t.after(() => rmrf(dir));
  // The server shares this process's env; inside node:test, a child `node --test` would see
  // NODE_TEST_CONTEXT and skip its files. A real client never runs the server under node:test.
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved; });

  const pkg = JSON.stringify({ name: 'tiny', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2);
  assert.match(await ok('write_file', { path: `${dir}/package.json`, content: `${pkg}\n` }), /^Successfully wrote to /);
  // Source and test written in chunks: rewrite first, then append.
  await ok('write_file', { path: `${dir}/src/index.js`, content: 'export function add(a, b) {\n  return a - b;\n}\n', mode: 'rewrite' });
  assert.match(
    await ok('write_file', { path: `${dir}/src/index.js`, content: 'export function mul(a, b) {\n  return a * b;\n}\n', mode: 'append' }),
    /^Successfully appended to /,
  );
  await ok('write_file', {
    path: `${dir}/test/index.test.js`,
    content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, mul } from '../src/index.js';\n\n",
    mode: 'rewrite',
  });
  await ok('write_file', {
    path: `${dir}/test/index.test.js`,
    content: "test('add', () => assert.equal(add(2, 3), 5));\ntest('mul', () => assert.equal(mul(2, 3), 6));\n",
    mode: 'append',
  });
  const src = await ok('read_file', { path: `${dir}/src/index.js` });
  assert.equal(
    src,
    '[Reading 6 lines from start (total: 6 lines, 0 remaining)]\n\n' +
      'export function add(a, b) {\n  return a - b;\n}\nexport function mul(a, b) {\n  return a * b;\n}',
  );

  // First run with a tiny timeout: the model gets "still running" and polls for the rest.
  const first = await ok('start_process', startArgs('npm test', { cwd: dir, timeout_ms: 50 }));
  const pid = pidOf(first);
  let run1 = first;
  if (!/✅ Process exited with code/.test(first)) {
    assert.match(first, /⏳ Process is still running\. Use read_process_output/);
    run1 += await readUntil(ok, pid, (text) => /✅ Process (completed with exit code|terminated by signal)/.test(text), { timeout_ms: 5000 });
  }
  assert.match(run1, /exit code 1/, run1);
  assert.match(run1, /✖ add/);
  assert.match(run1, /✔ mul/);
  assert.match(run1, /-1 !== 5/);
  // The whole run was delivered exactly once across the polled reads.
  assert.equal(run1.match(/ℹ tests 2/g)?.length, 1, run1);

  // Locate the bug by content, reading the location from the search result text.
  const found = await ok('start_search', { path: dir, pattern: 'a - b', searchType: 'content', literalSearch: true });
  assert.match(found, /Status: COMPLETED/);
  assert.match(found, /Total results: 1\n/);
  const hit = /📄 (.+):(\d+) - (.*)/.exec(found);
  assert.ok(hit, found);
  assert.equal(hit[1], path.join(dir, 'src', 'index.js'));
  assert.equal(hit[3], '  return a - b;');
  const line = Number(hit[2]);
  assert.equal(line, 2);
  // search lines are 1-based, read_file offsets 0-based
  const around = await ok('read_file', { path: hit[1], offset: line - 1, length: 1 });
  assert.equal(around, '[Reading 1 lines from line 1 (total: 6 lines, 4 remaining)]\n\n  return a - b;\n\n[... 4 more lines. Call read_file with offset=2 to continue]');

  const edit = await ok('edit_block', { file_path: hit[1], old_string: '  return a - b;', new_string: '  return a + b;' });
  assert.match(edit, /^Successfully applied 1 edit\(s\) to /);
  assert.match(edit, /\n {2}return a \+ b;\n/);

  // Rerun until green.
  let green = null;
  for (let attempt = 0; attempt < 3 && !green; attempt++) {
    const text = await ok('start_process', startArgs('npm test', { cwd: dir, timeout_ms: 60000 }));
    if (/✅ Process exited with code 0/.test(text)) green = text;
  }
  assert.ok(green, 'npm test never went green');
  assert.match(green, /ℹ pass 2\nℹ fail 0/);

  const sessions = await ok('list_sessions');
  assert.match(sessions, /^No active sessions\n\nRecently completed:\n/);
  assert.match(sessions, new RegExp(`PID: ${pid}, Exit: 1, Runtime: \\d+s, Command: npm test`));
});

// ---------------------------------------------------------------------------------------------
// (2) Long-running HTTP server: wait for 'listening', curl it, terminate, port is free again
// ---------------------------------------------------------------------------------------------

test('scenario: HTTP server session, request from a second process, force_terminate frees the port', { skip: isWindows }, async (t) => {
  const { ok, run } = await session(t);
  const dir = tmpDir('mcpc-scen-http-');
  t.after(() => rmrf(dir));
  await ok('write_file', {
    path: `${dir}/server.js`,
    content:
      "const http = require('http');\n" +
      "const srv = http.createServer((req, res) => { console.log('request', req.method, req.url); res.end('hello from ' + req.url + '\\n'); });\n" +
      "setTimeout(() => srv.listen(0, '127.0.0.1', () => console.log('listening on port ' + srv.address().port)), 300);\n",
  });

  const started = await ok('start_process', startArgs(`node server.js`, { cwd: dir, timeout_ms: 100 }));
  const pid = pidOf(started);
  assert.match(started, /⏳ Process is still running/);
  const log = await readUntil(ok, pid, (text) => /listening on port \d+/.test(text));
  const port = Number(/listening on port (\d+)/.exec(log)[1]);
  assert.match(log, /⏳ Process \d+ is still running/);

  const client = curl ? `curl -s http://127.0.0.1:${port}/hello` : `node -e "fetch('http://127.0.0.1:${port}/hello').then(r => r.text()).then(t => process.stdout.write(t))"`;
  const response = await ok('start_process', startArgs(client, { timeout_ms: 15000 }));
  assert.match(response, /\nhello from \/hello\n✅ Process exited with code 0/);

  const served = await readUntil(ok, pid, (_text, all) => /request GET \/hello/.test(all));
  assert.match(served, /⏳ Process \d+ is still running/);
  assert.match(await ok('list_sessions'), new RegExp(`Active sessions:\\nPID: ${pid}, Status: running, `));

  assert.match(await ok('force_terminate', { pid }), new RegExp(`^Successfully terminated session ${pid} \\(signal SIG(INT|KILL)\\)$`));
  assert.ok(await portIsFree(port), `port ${port} still in use after force_terminate`);
  assert.match(await ok('read_process_output', { pid }), /\(No new output\)\n✅ Process terminated by signal SIG(INT|KILL)/);
  assert.doesNotMatch(await ok('list_sessions'), /Active sessions/);
  const again = await run('force_terminate', { pid });
  assert.equal(again.isError, true);
  assert.equal(again.text, `Error: No active session found for PID ${pid}`);
});

// ---------------------------------------------------------------------------------------------
// (3) Python REPL data work
// ---------------------------------------------------------------------------------------------

test('scenario: python3 -i data work — multi-line def over several calls, traceback, exit status', { skip: !python && 'python3 not installed' }, async (t) => {
  const { ok } = await session(t);
  const started = await ok('start_process', startArgs('python3 -i'));
  const pid = pidOf(started);
  assert.equal(waitingFor(started), '>>>');
  const send = (input) => ok('interact_with_process', { pid, input, timeout_ms: 8000 });

  let out = await send('data = [3, 1, 4, 1, 5, 9, 2, 6]');
  assert.equal(out, `✅ Input executed in process ${pid}.\n📭 (No output produced)\n\n🔄 Process ${pid} is waiting for input (detected: ">>>")`);
  assert.equal(waitingFor(await send('def stats(xs):')), '...');
  assert.equal(waitingFor(await send('    n = len(xs)')), '...');
  assert.equal(waitingFor(await send('    return {"n": n, "mean": sum(xs) / n, "max": max(xs)}')), '...');
  assert.equal(waitingFor(await send('')), '>>>', 'a blank line ends the block');

  out = await send('print(stats(data))');
  assert.equal(out, `✅ Input executed in process ${pid}:\n\n📤 Output:\n{'n': 8, 'mean': 3.875, 'max': 9}\n\n🔄 Process ${pid} is waiting for input (detected: ">>>")`);

  out = await send('stats([])');
  assert.match(out, /📤 Output:\nTraceback \(most recent call last\):\n[\s\S]*ZeroDivisionError: division by zero\n\n🔄 Process \d+ is waiting for input \(detected: ">>>"\)$/);
  // The session survived the exception and kept its state.
  assert.match(await send('sorted(data)[-3:]'), /📤 Output:\n\[5, 6, 9\]\n/);

  out = await send('exit(3)');
  assert.equal(out, `✅ Input executed in process ${pid}.\n📭 (No output produced)\n\n✅ Process exited with code 3`);
  assert.match(await ok('read_process_output', { pid }), /\(No new output\)\n✅ Process completed with exit code 3 \(runtime: /);
  assert.match(await ok('list_sessions'), new RegExp(`Recently completed:\\nPID: ${pid}, Exit: 3, Runtime: \\d+s, Command: python3 -i`));
});

test('scenario: python3 -i — output printed right before a traceback still ends at the prompt', {
  skip: !python && 'python3 not installed',
}, async (t) => {
  const { ok } = await session(t);
  const pid = pidOf(await ok('start_process', startArgs('python3 -i')));
  const t0 = Date.now();
  const out = await ok('interact_with_process', { pid, input: 'print("dbg"); 1/0', timeout_ms: 3000 });
  const elapsed = Date.now() - t0;
  assert.match(out, /dbg/);
  assert.match(out, /ZeroDivisionError: division by zero/);
  assert.match(out, /🔄 Process \d+ is waiting for input \(detected: ">>>"\)$/, out);
  assert.ok(elapsed < 2500, `took ${elapsed}ms: waited for the timeout although the REPL was back at its prompt`);
});

test('scenario: busy interactive session — after interact times out, read_process_output waits for the result', {
  skip: isWindows,
}, async (t) => {
  const { ok } = await session(t);
  const started = await ok('start_process', startArgs('sh -i'));
  const pid = pidOf(started);
  const prompt = waitingFor(started);
  assert.ok(prompt, started);

  const sent = await ok('interact_with_process', { pid, input: 'sleep 1; echo slow result', timeout_ms: 200 });
  assert.match(sent, /⏱️ No prompt detected within 200ms — the process may still be working\. Use read_process_output/);

  // The tool's own advice: use read_process_output. The shell is busy, not waiting for input.
  assert.match(await ok('list_sessions'), new RegExp(`PID: ${pid}, Status: running, `));
  const t0 = Date.now();
  const read = await ok('read_process_output', { pid, timeout_ms: 5000 });
  assert.match(read, /\nslow result\n/, `read returned after ${Date.now() - t0}ms:\n${read}`);
  assert.equal(waitingFor(read), prompt);
});

// ---------------------------------------------------------------------------------------------
// (4) Find-and-refactor across files
// ---------------------------------------------------------------------------------------------

test('scenario: rename a symbol across 5 files with start_search + edit_block, verify with read_multiple_files', async (t) => {
  const { ok, run } = await session(t);
  const dir = tmpDir('mcpc-scen-refactor-');
  t.after(() => rmrf(dir));
  const files = {
    'src/util.js': 'export function fetchUserData(id) {\n  return { id };\n}\n',
    'src/api.js': "import { fetchUserData } from './util.js';\nexport const get = (id) => fetchUserData(id);\n",
    'src/page.js':
      "import { fetchUserData } from './util.js';\n\nexport function render(id) {\n  const a = fetchUserData(id);\n  const b = fetchUserData(id + 1);\n  return [a, b];\n}\n",
    'test/util.test.js': "import { loadUser } from '../src/util.js';\nimport { fetchUserData } from '../src/api.js';\n",
    'README.md': '# Demo\n\nCall `fetchUserData(id)` to load a user.\n',
  };
  files['test/util.test.js'] = "import { fetchUserData } from '../src/util.js';\nconsole.log(JSON.stringify(fetchUserData(7)));\n";
  for (const [rel, content] of Object.entries(files)) await ok('write_file', { path: `${dir}/${rel}`, content });

  const search = await ok('start_search', { path: dir, pattern: 'fetchUserData', searchType: 'content' });
  assert.match(search, /Total results: 9\n/);
  const hits = [...search.matchAll(/📄 (.+):(\d+) - /g)].map((m) => [path.relative(dir, m[1]), Number(m[2])]);
  const perFile = {};
  for (const [f, l] of hits) (perFile[f] ??= []).push(l);
  assert.deepEqual(perFile, {
    'README.md': [3],
    [path.join('src', 'api.js')]: [1, 2],
    [path.join('src', 'page.js')]: [1, 4, 5],
    [path.join('src', 'util.js')]: [1],
    [path.join('test', 'util.test.js')]: [1, 2],
  });

  // page.js: the call appears twice — the first attempt says so, with line numbers.
  const page = `${dir}/src/page.js`;
  const twice = await run('edit_block', { file_path: page, old_string: 'fetchUserData(id', new_string: 'loadUser(id' });
  assert.equal(twice.isError, true);
  assert.match(twice.text, /Expected 1 occurrences but found 2 in .*page\.js \(at lines 4, 5\)\. If you want to replace all 2 occurrences, set expected_replacements to 2\./);
  assert.match(await ok('edit_block', { file_path: page, old_string: 'fetchUserData(id', new_string: 'loadUser(id', expected_replacements: 2 }), /^Successfully applied 2 edit\(s\)/);
  await ok('edit_block', { file_path: page, old_string: 'import { fetchUserData }', new_string: 'import { loadUser }' });
  await ok('edit_block', { file_path: `${dir}/src/util.js`, old_string: 'export function fetchUserData(id) {', new_string: 'export function loadUser(id) {' });
  await ok('edit_block', {
    file_path: `${dir}/src/api.js`,
    old_string: "import { fetchUserData } from './util.js';\nexport const get = (id) => fetchUserData(id);",
    new_string: "import { loadUser } from './util.js';\nexport const get = (id) => loadUser(id);",
  });
  await ok('edit_block', { file_path: `${dir}/test/util.test.js`, old_string: 'fetchUserData', new_string: 'loadUser', expected_replacements: 2 });
  // A typo gets a fuzzy hint (and changes nothing); the copied text then applies.
  const typo = await run('edit_block', { file_path: `${dir}/README.md`, old_string: 'fetchUserdata(id)', new_string: 'loadUser(id)' });
  assert.equal(typo.isError, true);
  assert.match(typo.text, /similarity at line 3[\s\S]*Found text \(copy it exactly if this is the text you meant\):\nfetchUserData\(id\)$/);
  await ok('edit_block', { file_path: `${dir}/README.md`, old_string: 'fetchUserData(id)', new_string: 'loadUser(id)' });

  assert.match(await ok('start_search', { path: dir, pattern: 'fetchUserData', searchType: 'content' }), /Total results: 0\n\nNo matches found\./);
  const paths = Object.keys(files).map((rel) => `${dir}/${rel}`);
  const all = await ok('read_multiple_files', { paths });
  assert.equal(all.split('\n').slice(0, 5).join('\n'), paths.map((p) => `${p}: text/plain (text)`).join('\n'));
  for (const p of paths) assert.match(all, new RegExp(`--- ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} contents: ---\\n\\[Reading \\d+ lines from start`));
  assert.doesNotMatch(all, /fetchUserData/);
  assert.equal(all.match(/loadUser/g).length, 9);
  for (const p of paths) assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /fetchUserData/);

  // And the refactored code still runs.
  const ran = await ok('start_process', startArgs('node test/util.test.js', { cwd: dir }));
  assert.match(ran, /\n\{"id":7\}\n✅ Process exited with code 0/);
});

// ---------------------------------------------------------------------------------------------
// (5) Large file: write in chunks, read page by page following the continuation hints
// ---------------------------------------------------------------------------------------------

test('scenario: 3000-line file written in 50-line chunks, read back by following continuation hints', async (t) => {
  const { ok } = await session(t);
  const dir = tmpDir('mcpc-scen-big-');
  t.after(() => rmrf(dir));
  const file = `${dir}/big.txt`;
  const N = 3000;
  const CHUNK = 50;
  const lineText = (i) => `line ${i} ${'x'.repeat(i % 7)}`.trimEnd();
  for (let start = 0; start < N; start += CHUNK) {
    const chunk = Array.from({ length: CHUNK }, (_, k) => lineText(start + k)).join('\n') + '\n';
    const text = await ok('write_file', { path: file, content: chunk, mode: start === 0 ? 'rewrite' : 'append' });
    assert.match(text, start === 0 ? /^Successfully wrote to / : /^Successfully appended to /);
  }
  assert.match(await ok('get_file_info', { path: file }), /\nlineCount: 3000\nlastLine: 2999\nappendPosition: 3000$/);

  const seen = [];
  const headers = [];
  let offset = 0;
  for (let pages = 0; pages < 10; pages++) {
    const text = await ok('read_file', { path: file, offset });
    const [header, ...rest] = text.split('\n\n');
    headers.push(header);
    const hint = /\n\n\[\.\.\. (\d+) more lines\. Call read_file with offset=(\d+) to continue\]$/.exec(text);
    const body = hint ? text.slice(header.length + 2, hint.index) : rest.join('\n\n');
    seen.push(...body.split('\n'));
    if (!hint) break;
    assert.equal(Number(hint[2]), seen.length, 'the hint continues exactly after the last line shown');
    offset = Number(hint[2]);
  }
  assert.deepEqual(headers, [
    '[Reading 1000 lines from start (total: 3000 lines, 2000 remaining)]',
    '[Reading 1000 lines from line 1000 (total: 3000 lines, 1000 remaining)]',
    '[Reading 1000 lines from line 2000 (total: 3000 lines, 0 remaining)]',
  ]);
  assert.equal(seen.length, N);
  assert.deepEqual(seen, Array.from({ length: N }, (_, i) => lineText(i)), 'every line exactly once, in order');

  assert.equal(await ok('read_file', { path: file, offset: -2 }), `[Reading last 2 lines (total: 3000 lines)]\n\n${lineText(2998)}\n${lineText(2999)}`);
});

test('scenario: a 50-line chunk (the documented limit) is reported as 50 lines, without an over-limit tip', {
}, async (t) => {
  const { ok } = await session(t);
  const dir = tmpDir('mcpc-scen-chunk-');
  t.after(() => rmrf(dir));
  const file = `${dir}/chunk.txt`;
  const content = Array.from({ length: 50 }, (_, i) => `row ${i}`).join('\n') + '\n';
  assert.match(await ok('read_file', { path: (await ok('write_file', { path: file, content }), file) }), /^\[Reading 50 lines from start \(total: 50 lines, 0 remaining\)\]/);
  const again = await ok('write_file', { path: file, content, mode: 'rewrite' });
  assert.equal(again, `Successfully wrote to ${file} (50 lines)`);
});

// ---------------------------------------------------------------------------------------------
// (6) Interactive prompts answered through interact_with_process
// ---------------------------------------------------------------------------------------------

const QUESTIONS_JS =
  "const readline = require('node:readline');\n" +
  'const rl = readline.createInterface({ input: process.stdin, output: process.stdout });\n' +
  "console.log('Setting up project...');\n" +
  "rl.question('Name: ', (name) => {\n" +
  "  rl.question('Age? ', (age) => {\n" +
  "    rl.question('Overwrite existing config? (y/n) ', (yn) => {\n" +
  "      console.log('Hello ' + name + ', you are ' + age + (yn === 'y' ? ' (overwritten)' : ''));\n" +
  '      rl.close();\n' +
  '      process.exit(0);\n' +
  '    });\n' +
  '  });\n' +
  '});\n';

test('scenario: a readline script asks questions; answers go in with interact_with_process', { skip: isWindows }, async (t) => {
  const { ok } = await session(t);
  const dir = tmpDir('mcpc-scen-ask-');
  t.after(() => rmrf(dir));
  await ok('write_file', { path: `${dir}/ask.js`, content: QUESTIONS_JS });

  const started = await ok('start_process', startArgs('node ask.js', { cwd: dir }));
  const pid = pidOf(started);
  assert.match(started, /Initial output:\nSetting up project\.\.\.\nName: \n🔄 Process \d+ is waiting for input \(detected: "Name:"\)$/);

  let out = await ok('interact_with_process', { pid, input: 'Ada' });
  assert.match(waitingFor(out) ?? '', /Age\?$/, out);
  out = await ok('interact_with_process', { pid, input: '36' });
  assert.match(waitingFor(out) ?? '', /Overwrite existing config\? \(y\/n\)$/, out);
  out = await ok('interact_with_process', { pid, input: 'y' });
  assert.equal(out, `✅ Input executed in process ${pid}:\n\n📤 Output:\nHello Ada, you are 36 (overwritten)\n\n✅ Process exited with code 0`);
});

test('scenario: python input() prompts, including a [y/N] confirmation', { skip: !python && 'python3 not installed' }, async (t) => {
  const { ok } = await session(t);
  const started = await ok('start_process', startArgs(`python3 -c "n = input('Your name: '); print('hi', n); m = input('Continue? [y/N] '); print('bye', m)"`));
  const pid = pidOf(started);
  assert.equal(waitingFor(started), 'Your name:');
  const out = await ok('interact_with_process', { pid, input: 'Bob' });
  assert.equal(out, `✅ Input executed in process ${pid}:\n\n📤 Output:\nhi Bob\n\n🔄 Process ${pid} is waiting for input (detected: "Continue? [y/N]")`);
  assert.equal(await ok('interact_with_process', { pid, input: 'y' }), `✅ Input executed in process ${pid}:\n\n📤 Output:\nbye y\n\n✅ Process exited with code 0`);
});

test('scenario: the prompt reported after an answer is the new question only', {
  skip: isWindows,
}, async (t) => {
  const { ok } = await session(t);
  const dir = tmpDir('mcpc-scen-ask2-');
  t.after(() => rmrf(dir));
  await ok('write_file', { path: `${dir}/ask.js`, content: QUESTIONS_JS });
  const pid = pidOf(await ok('start_process', startArgs('node ask.js', { cwd: dir })));
  assert.equal(waitingFor(await ok('interact_with_process', { pid, input: 'Ada' })), 'Age?');
  assert.equal(waitingFor(await ok('interact_with_process', { pid, input: '36' })), 'Overwrite existing config? (y/n)');
  await ok('force_terminate', { pid });
});

// ---------------------------------------------------------------------------------------------
// (7) allowedDirectories sandbox
// ---------------------------------------------------------------------------------------------

test('scenario: allowedDirectories set via set_config_value confines the file and search tools, then reset', { skip: isWindows }, async (t) => {
  const { ok, run } = await session(t);
  const inside = tmpDir('mcpc-scen-in-');
  const outside = tmpDir('mcpc-scen-out-');
  t.after(() => {
    rmrf(inside);
    rmrf(outside);
  });
  fs.writeFileSync(`${inside}/a.txt`, 'inside\n');
  fs.writeFileSync(`${outside}/b.txt`, 'outside needle\n');
  fs.symlinkSync(`${outside}/b.txt`, `${inside}/link.txt`);
  fs.symlinkSync(outside, `${inside}/linkdir`);

  const set = await ok('set_config_value', { key: 'allowedDirectories', value: [inside] });
  assert.match(set, /^Successfully set allowedDirectories to \[\n {2}".*"\n\]/);
  assert.ok(JSON.parse(await ok('get_config').then((t) => t.slice(t.indexOf('{')))).allowedDirectories.includes(inside));

  assert.match(await ok('read_file', { path: `${inside}/a.txt` }), /\n\ninside$/);
  const denied = (text, p) => assert.equal(text, `Error: Path not allowed: ${p}. Must be within one of these directories: ${inside}`);
  const refuse = async (name, args, p) => {
    const r = await run(name, args);
    assert.equal(r.isError, true, `${name} was not refused: ${r.text}`);
    denied(r.text, p);
  };
  await refuse('read_file', { path: `${outside}/b.txt` }, `${outside}/b.txt`);
  const dotdot = `${inside}/../${path.basename(outside)}/b.txt`;
  await refuse('read_file', { path: dotdot }, dotdot);
  await refuse('read_file', { path: `${inside}/link.txt` }, `${inside}/link.txt`);
  const multi = await ok('read_multiple_files', { paths: [`${inside}/a.txt`, `${outside}/b.txt`] });
  assert.match(multi, new RegExp(`\\n${outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/b\\.txt: Error - Path not allowed: `));
  assert.doesNotMatch(multi, /needle/);

  await refuse('move_file', { source: `${inside}/a.txt`, destination: `${outside}/a.txt` }, `${outside}/a.txt`);
  await refuse('move_file', { source: `${inside}/a.txt`, destination: `${inside}/linkdir/a.txt` }, `${inside}/linkdir/a.txt`);
  await refuse('move_file', { source: `${outside}/b.txt`, destination: `${inside}/b.txt` }, `${outside}/b.txt`);
  assert.ok(fs.existsSync(`${inside}/a.txt`), 'source must still be in place');

  await refuse('start_search', { path: outside, pattern: 'needle', searchType: 'content' }, outside);
  await refuse('start_search', { path: `${inside}/linkdir`, pattern: 'needle', searchType: 'content' }, `${inside}/linkdir`);
  // Searching the allowed dir does not follow the links out of it.
  assert.match(await ok('start_search', { path: inside, pattern: 'needle', searchType: 'content' }), /Total results: 0\n/);

  await refuse('write_file', { path: `${outside}/c.txt`, content: 'x' }, `${outside}/c.txt`);
  await refuse('write_file', { path: `${inside}/link.txt`, content: 'x', mode: 'rewrite' }, `${inside}/link.txt`);
  await refuse('edit_block', { file_path: `${outside}/b.txt`, old_string: 'needle', new_string: 'pin' }, `${outside}/b.txt`);
  await refuse('list_directory', { path: outside }, outside);
  await refuse('create_directory', { path: `${outside}/sub` }, `${outside}/sub`);
  await refuse('start_process', startArgs('pwd', { cwd: outside }), outside);
  assert.deepEqual(fs.readdirSync(outside), ['b.txt']);
  assert.equal(fs.readFileSync(`${outside}/b.txt`, 'utf8'), 'outside needle\n');

  assert.match(await ok('set_config_value', { key: 'allowedDirectories', value: [] }), /^Successfully set allowedDirectories to \[\]/);
  assert.match(await ok('read_file', { path: `${outside}/b.txt` }), /\n\noutside needle$/);
});
