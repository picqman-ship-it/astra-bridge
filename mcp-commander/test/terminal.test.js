// Terminal sessions: start_process, read_process_output, interact_with_process, force_terminate,
// list_sessions, plus the prompt detector, shell resolution and output buffering internals.
// Everything runs real processes; most tests use /bin/sh (no login profile) for determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, makeCtx, rmrf, runTool, sleep, textOf, tmpDir, waitFor } from './helpers.js';

const { TerminalManager, OutputBuffer, StreamCleaner, displayText } = await load('terminal/manager.js');
const { terminalTools } = await load('tools/terminal.js');
const { detectPrompt } = await load('terminal/prompt.js');
const { shellSpawnArgs, resolveShell, findExecutable, childEnv } = await load('terminal/shell.js');

const isWindows = process.platform === 'win32';
const SH = '/bin/sh';
const NODE = process.execPath;

const pidOf = (result) => {
  const m = /PID (\d+)/.exec(textOf(result));
  assert.ok(m, `no PID in: ${textOf(result)}`);
  return Number(m[1]);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// One manager + ctx for most tests; tests that need special options make their own.
const { ctx, cleanup } = await makeCtx();
const tm = new TerminalManager();
const tools = terminalTools(ctx, tm);
const call = (name, args) => runTool(tools, name, args);
const start = (command, extra = {}) => call('start_process', { command, shell: SH, timeout_ms: 5000, ...extra });

test.after(async () => {
  await tm.shutdown();
  cleanup();
});

// ---------------------------------------------------------------------------------------------
// detectPrompt
// ---------------------------------------------------------------------------------------------

test('detectPrompt recognises common prompts', () => {
  const cases = [
    ['>>> ', '>>>'],
    ['... ', '...'],
    ['In [3]: ', 'In [3]:'],
    ['   ...: ', '...:'],
    ['> ', '>'],
    ['$ ', '$'],
    ['user@host:~/dir$ ', 'user@host:~/dir$'],
    ['bash-3.2$ ', 'bash-3.2$'],
    ['% ', '%'],
    ['host% ', 'host%'],
    ['# ', '#'],
    ['root@box:/# ', 'root@box:/#'],
    ['mysql> ', 'mysql>'],
    ['    -> ', '->'],
    ['db=# ', 'db=#'],
    ['db-# ', 'db-#'],
    ['irb(main):001:0> ', 'irb(main):001:0>'],
    ['sqlite> ', 'sqlite>'],
    ['julia> ', 'julia>'],
    ['PS C:\\Users\\me> ', 'PS C:\\Users\\me>'],
    ['(Pdb) ', '(Pdb)'],
    ['(gdb) ', '(gdb)'],
    ['Password: ', 'Password:'],
    ['Password:', 'Password:'],
    ["user@host's password: ", "user@host's password:"],
    ['Enter your name: ', 'Enter your name:'],
    ['Continue? [y/N] ', 'Continue? [y/N]'],
    ['Continue? [y/N]', 'Continue? [y/N]'],
    ['(y/n) ', '(y/n)'],
    ['Overwrite file? (y/n) ', 'Overwrite file? (y/n)'],
    ['package name: (my-app) ', 'package name: (my-app)'],
    ['Are you sure? ', 'Are you sure?'],
    ['❯ ', '❯'],
    ['>>> >>> ', '>>>'],
    ['... ... >>> ', '>>>'],
    ['... ... ', '...'],
    ['previous line\n>>> ', '>>>'],
    ['progress 10%\r>>> ', '>>>'],
  ];
  for (const [line, expected] of cases) {
    assert.equal(detectPrompt(line), expected, `detectPrompt(${JSON.stringify(line)})`);
  }
});

test('detectPrompt ignores output that is not a prompt', () => {
  const cases = [
    '',
    '\n',
    'hello\n',
    '>>> \n',
    'price $\n',
    'Server listening on port 3000',
    'Server listening on port 3000 ',
    '2024-01-01 12:00:00 ',
    'Downloading 45%',
    'Downloading 45% ',
    '<div>',
    '<div> ',
    '</p> ',
    '<a href="x"> ',
    'Compiling...',
    'Compiling... ',
    'Done.',
    '   ',
    ':',
    ': ',
    '?',
    'x'.repeat(201) + '$ ',
    'x'.repeat(250),
    'Step 1 of 3 ',
    'a + b',
  ];
  for (const line of cases) {
    assert.equal(detectPrompt(line), null, `detectPrompt(${JSON.stringify(line)}) should be null`);
  }
});

// ---------------------------------------------------------------------------------------------
// Shell resolution / spawn args
// ---------------------------------------------------------------------------------------------

test('shellSpawnArgs picks flags by shell basename', () => {
  assert.deepEqual(shellSpawnArgs('/bin/bash', 'ls'), { file: '/bin/bash', args: ['-l', '-c', 'ls'] });
  assert.deepEqual(shellSpawnArgs('/usr/local/bin/zsh', 'ls'), { file: '/usr/local/bin/zsh', args: ['-l', '-c', 'ls'] });
  assert.deepEqual(shellSpawnArgs('/opt/homebrew/bin/fish', 'ls'), { file: '/opt/homebrew/bin/fish', args: ['-l', '-c', 'ls'] });
  assert.deepEqual(shellSpawnArgs('pwsh', 'ls'), { file: 'pwsh', args: ['-Login', '-Command', 'ls'] });
  assert.deepEqual(shellSpawnArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'ls'), {
    file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoProfile', '-Command', 'ls'],
  });
  assert.deepEqual(shellSpawnArgs('C:\\Windows\\System32\\cmd.exe', 'dir "a b"'), {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/c', 'dir "a b"'],
    windowsVerbatimArguments: true,
  });
  assert.deepEqual(shellSpawnArgs('/bin/sh', 'ls'), { file: '/bin/sh', args: ['-c', 'ls'] });
  assert.deepEqual(shellSpawnArgs('/bin/dash', 'ls'), { file: '/bin/dash', args: ['-c', 'ls'] });
});

test('resolveShell precedence: argument > config > environment > fallback', { skip: isWindows }, () => {
  assert.deepEqual(resolveShell('/bin/bash', '/bin/zsh', { SHELL: '/bin/ksh' }), { shell: '/bin/bash', source: 'argument' });
  assert.deepEqual(resolveShell(undefined, '/bin/zsh', { SHELL: '/bin/ksh' }), { shell: '/bin/zsh', source: 'config' });
  assert.deepEqual(resolveShell('  ', '', { SHELL: '/bin/ksh' }), { shell: '/bin/ksh', source: 'environment' });
  assert.deepEqual(resolveShell(undefined, undefined, {}), { shell: '/bin/sh', source: 'fallback' });
});

test('findExecutable resolves names on PATH and checks paths', { skip: isWindows }, () => {
  const sh = findExecutable('sh');
  assert.ok(sh && path.isAbsolute(sh), `sh resolved to ${sh}`);
  assert.equal(findExecutable('/bin/sh'), '/bin/sh');
  assert.equal(findExecutable('/definitely/not/here/zsh'), null);
  assert.equal(findExecutable('no-such-shell-mcpc-xyz'), null);
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'notexec');
    fs.writeFileSync(f, '#!/bin/sh\n');
    fs.chmodSync(f, 0o644);
    assert.equal(findExecutable(f), null, 'non-executable file is not a shell');
    assert.equal(findExecutable(dir), null, 'directory is not a shell');
  } finally {
    rmrf(dir);
  }
  const env = childEnv({ PATH: '/bin', TERM: '' });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.PAGER, 'cat');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(childEnv({ TERM: 'dumb' }).TERM, 'dumb');
});

// ---------------------------------------------------------------------------------------------
// Buffer internals
// ---------------------------------------------------------------------------------------------

test('OutputBuffer keeps absolute offsets across eviction of whole lines', () => {
  const b = new OutputBuffer(50);
  for (let i = 0; i < 20; i++) b.append(`line${String(i).padStart(2, '0')}\n`); // 7 chars each
  assert.equal(b.end, 140);
  assert.ok(b.retained().length <= 50, 'cap respected');
  assert.ok(b.retained().startsWith('line'), 'evicted on a line boundary');
  assert.equal(b.start, 140 - b.retained().length);
  assert.equal(b.evictedLines * 7, b.evictedChars);
  assert.ok(b.retained().endsWith('line19\n'));
  b.append('>>> ');
  assert.equal(b.lastLine(), '>>> ');
  b.append('x\r>>> ');
  assert.equal(b.lastLine(), '>>> ');
  b.shrinkTo(0);
  assert.equal(b.retained(), '');
  assert.equal(b.start, b.end);
});

test('StreamCleaner strips ANSI split across chunks and normalizes CRLF', () => {
  const c = new StreamCleaner();
  let out = '';
  for (const piece of ['\x1b[3', '1mred\x1b', '[0m plain\x1b]0;ti', 'tle\x07 end\r', '\nnext\x1b[?25l\x07\n']) {
    out += c.push(piece);
  }
  out += c.flush();
  assert.equal(out, 'red plain end\nnext\n');
  const c2 = new StreamCleaner();
  assert.equal(c2.push('ab\x1b[') + c2.flush(), 'ab', 'dangling escape dropped at end of stream');
  const c3 = new StreamCleaner();
  assert.equal(c3.push('ab\x1b[3') + c3.flush(), 'ab', 'dangling CSI parameters dropped too');
  const pieces = (chunks) => {
    const c = new StreamCleaner();
    return chunks.map((p) => c.push(p)).join('') + c.flush();
  };
  assert.equal(pieces(['a\x1b]0;title\x1b', '\\b\n']), 'ab\n', 'OSC split between ESC and backslash of ST');
  assert.equal(pieces(['a\x1b', '[?2004hb>>> ']), 'ab>>> ', 'lone ESC completed by the next chunk');
  assert.equal(pieces(['x\x1b(', 'By\n']), 'xy\n', 'charset designation split after its intermediate byte');
  const c4 = new StreamCleaner();
  assert.equal(c4.push('p\x1b]not an osc\nline two\n'), 'pnot an osc\nline two\n', 'unterminated OSC before a newline is not held');
  assert.equal(displayText('p 10%\rp 50%\rp 100%\nok\n'), 'p 100%\nok');
});

// ---------------------------------------------------------------------------------------------
// start_process
// ---------------------------------------------------------------------------------------------

test('start_process runs a command with the default shell and reports the exit code', async () => {
  const shell = ctx.config.getValue('defaultShell');
  const r = await call('start_process', { command: 'echo hello-mcpc', timeout_ms: 10000 });
  const text = textOf(r);
  assert.ok(!r.isError, text);
  assert.match(text, new RegExp(`^Process started with PID \\d+ \\(shell: ${shell.replace(/[/\\]/g, '\\$&')}\\)\nInitial output:\n`));
  assert.match(text, /hello-mcpc/);
  assert.match(text, /\n✅ Process exited with code 0 \(runtime: \d+\.\d\ds\)$/);
});

test('start_process: exit code, merged stderr, no output', async () => {
  let r = await start('printf "a\\n"; exit 3');
  assert.match(textOf(r), /Initial output:\na\n✅ Process exited with code 3 \(runtime: /);

  r = await start('echo one; sleep 0.05; echo two >&2; sleep 0.05; echo three');
  assert.match(textOf(r), /Initial output:\none\ntwo\nthree\n✅ Process exited with code 0/);

  r = await start('true');
  assert.match(textOf(r), /Initial output:\n\(no output yet\)\n✅ Process exited with code 0/);

  r = await start('kill -TERM $$');
  assert.match(textOf(r), /✅ Process terminated by signal SIGTERM \(runtime: /);
});

test('start_process returns on timeout without killing; read_process_output sees completion', async () => {
  const t0 = Date.now();
  const r = await start('sleep 0.6; echo done-late', { timeout_ms: 150 });
  const text = textOf(r);
  assert.ok(Date.now() - t0 < 1000, 'returned at the timeout');
  assert.match(
    text,
    /Initial output:\n\(no output yet\)\n⏳ Process is still running\. Use read_process_output to get more output, interact_with_process to send input, or force_terminate to stop it\.$/,
  );
  const pid = pidOf(r);
  const read = await call('read_process_output', { pid, timeout_ms: 5000 });
  const rt = textOf(read);
  assert.match(rt, /^\[Reading 1 new lines \(total: 1 lines\)\]\n\ndone-late\n✅ Process completed with exit code 0 \(runtime: \d+\.\d\ds\)$/);
});

test('start_process timeout_ms 0 returns immediately; bounds are validated', async () => {
  const r = await start('sleep 5', { timeout_ms: 0 });
  assert.match(textOf(r), /⏳ Process is still running/);
  await call('force_terminate', { pid: pidOf(r) });

  const bad = await start('echo x', { timeout_ms: 700000 });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Invalid arguments: timeout_ms: Number must be less than or equal to 600000/);

  const str = await start('echo coerced', { timeout_ms: '3000' });
  assert.match(textOf(str), /coerced/, 'numeric strings are accepted');
});

test('start_process refuses blocked commands (also nested) and blocked/missing shells', async () => {
  const before = tm.listActive().length + tm.listCompleted().length;
  let r = await start('sudo ls');
  assert.equal(r.isError, true);
  assert.equal(textOf(r), 'Error: Command not allowed: sudo ls (blocked: sudo)');

  r = await start('bash -c "sudo x"');
  assert.equal(r.isError, true);
  assert.equal(textOf(r), 'Error: Command not allowed: bash -c "sudo x" (blocked: sudo)');

  r = await start('echo ok\nshutdown -h now');
  assert.equal(r.isError, true);
  assert.match(textOf(r), /\(blocked: shutdown\)$/);

  r = await call('start_process', { command: 'ls', shell: 'sudo' });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), 'Error: Shell not allowed: sudo (blocked: sudo)');

  r = await call('start_process', { command: 'ls', shell: '/nonexistent/bin/zsh' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^Error: Shell not found: \/nonexistent\/bin\/zsh/);

  assert.equal(tm.listActive().length + tm.listCompleted().length, before, 'nothing was spawned');

  const { ctx: badCtx, cleanup: c2 } = await makeCtx({ defaultShell: '/nonexistent/default-shell' });
  try {
    const r2 = await runTool(terminalTools(badCtx, tm), 'start_process', { command: 'echo x' });
    assert.equal(r2.isError, true);
    assert.match(textOf(r2), /^Error: Failed to start process: shell not found: \/nonexistent\/default-shell \(from config defaultShell\)/);
  } finally {
    c2();
  }
});

test('TerminalManager.start rejects with the OS error when spawn fails', async () => {
  await assert.rejects(
    tm.start({ file: '/nonexistent/binary', args: [], command: 'x', shell: 'x', cwd: os.tmpdir(), env: process.env }),
    /ENOENT/,
  );
});

test('start_process cwd: directory, ~, missing, file, allowedDirectories', { skip: isWindows }, async () => {
  const dir = tmpDir();
  try {
    let r = await start('pwd', { cwd: dir });
    assert.match(textOf(r), new RegExp(`Initial output:\n${dir}\n✅`));

    r = await start('pwd', { cwd: '~' });
    assert.ok(textOf(r).includes(`Initial output:\n${fs.realpathSync(os.homedir())}\n`) || textOf(r).includes(`Initial output:\n${os.homedir()}\n`), textOf(r));

    r = await start('pwd', { cwd: path.join(dir, 'missing') });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `Error: cwd does not exist: ${path.join(dir, 'missing')}`);

    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
    r = await start('pwd', { cwd: path.join(dir, 'file.txt') });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `Error: cwd is not a directory: ${path.join(dir, 'file.txt')}`);

    const allowed = path.join(dir, 'allowed');
    const other = path.join(dir, 'other');
    fs.mkdirSync(path.join(allowed, 'sub'), { recursive: true });
    fs.mkdirSync(other);
    const { ctx: aCtx, cleanup: c2 } = await makeCtx({ allowedDirectories: [allowed] });
    try {
      const aTools = terminalTools(aCtx, tm);
      const denied = await runTool(aTools, 'start_process', { command: 'pwd', shell: SH, cwd: other });
      assert.equal(denied.isError, true);
      assert.match(textOf(denied), /Path not allowed/);
      const ok = await runTool(aTools, 'start_process', { command: 'pwd', shell: SH, cwd: path.join(allowed, 'sub') });
      assert.match(textOf(ok), new RegExp(`Initial output:\n${path.join(allowed, 'sub')}\n✅`));
    } finally {
      c2();
    }
  } finally {
    rmrf(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// read_process_output: cursor, caps, offsets
// ---------------------------------------------------------------------------------------------

test('output cap, cursor paging, absolute and tail reads', async () => {
  const { ctx: c5, cleanup: c2 } = await makeCtx({ fileReadLineLimit: 5 });
  try {
    const t5 = terminalTools(c5, tm);
    const r = await runTool(t5, 'start_process', { command: 'seq 1 12', shell: SH });
    const pid = pidOf(r);
    assert.match(
      textOf(r),
      /Initial output:\n1\n2\n3\n4\n5\n\[\.\.\. 7 more lines\. Use read_process_output to continue\]\n✅ Process exited with code 0/,
    );
    const read = async (args) => textOf(await runTool(t5, 'read_process_output', { pid, ...args }));
    assert.match(await read({}), /^\[Reading 5 new lines from line 5 \(total: 12 lines, 2 remaining\)\]\n\n6\n7\n8\n9\n10\n✅ Process completed with exit code 0/);
    assert.match(await read({}), /^\[Reading 2 new lines \(total: 12 lines\)\]\n\n11\n12\n✅ Process completed/);
    assert.match(await read({}), /^\[Reading 0 new lines \(total: 12 lines\)\]\n\n\(No new output\)\n✅ Process completed/);
    assert.match(await read({ offset: 3, length: 2 }), /^\[Reading 2 lines from line 3 \(total: 12 lines, 7 remaining\)\]\n\n4\n5\n✅/);
    assert.match(await read({ offset: -3 }), /^\[Reading last 3 lines \(total: 12 lines\)\]\n\n10\n11\n12\n✅/);
    assert.match(await read({ offset: -12, length: 2 }), /^\[Reading last 2 lines \(total: 12 lines\)\]\n\n1\n2\n✅/);
    assert.match(await read({ offset: 50 }), /^\[Reading 0 lines from line 50 \(total: 12 lines, 0 remaining\)\]\n\n\(No output in requested range\)\n✅/);
    assert.match(await read({ offset: '-1' }), /\n\n12\n✅/, 'numeric strings coerce');
  } finally {
    c2();
  }
});

test('regression: text after an already-read line is never lost (foo, read, bar, read -> bar)', async () => {
  const r = await start('cat', { timeout_ms: 100 });
  const pid = pidOf(r);
  assert.match(textOf(r), /\(no output yet\)\n⏳ Process is still running/);

  let s = await call('interact_with_process', { pid, input: 'foo', wait_for_prompt: false });
  assert.equal(textOf(s), `✅ Input sent to process ${pid}. Use read_process_output to get the response.`);
  let read = textOf(await call('read_process_output', { pid, timeout_ms: 3000 }));
  assert.equal(read, `[Reading 1 new lines (total: 1 lines)]\n\nfoo\n⏳ Process ${pid} is still running`);

  s = await call('interact_with_process', { pid, input: 'bar', wait_for_prompt: 'false' });
  assert.ok(!s.isError);
  read = textOf(await call('read_process_output', { pid, timeout_ms: 3000 }));
  assert.equal(read, `[Reading 1 new lines (total: 2 lines)]\n\nbar\n⏳ Process ${pid} is still running`);

  const t0 = Date.now();
  read = textOf(await call('read_process_output', { pid, timeout_ms: 200 }));
  assert.ok(Date.now() - t0 >= 180, 'waited for new output');
  assert.equal(read, `[Reading 0 new lines (total: 2 lines)]\n\n(No new output)\n⏳ Process ${pid} is still running`);
  await call('force_terminate', { pid });
});

test('partial lines: appended text on a read partial line is returned next time', async () => {
  const script = "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d.trim()))";
  const r = await start(`'${NODE}' -e "${script}"`, { timeout_ms: 300 });
  const pid = pidOf(r);
  await call('interact_with_process', { pid, input: 'ab', wait_for_prompt: false });
  let read = textOf(await call('read_process_output', { pid, timeout_ms: 3000 }));
  assert.match(read, /^\[Reading 1 new lines \(total: 1 lines\)\]\n\nab\n⏳/);
  await call('interact_with_process', { pid, input: 'cd', wait_for_prompt: false });
  read = textOf(await call('read_process_output', { pid, timeout_ms: 3000 }));
  assert.match(read, /^\[Reading 1 new lines \(total: 1 lines\)\]\n\ncd\n⏳/);
  read = textOf(await call('read_process_output', { pid, offset: -1 }));
  assert.match(read, /\n\nabcd\n⏳/);
  await call('force_terminate', { pid });
});

test('read_process_output on unknown pid; eviction warning; completed-session tail', async () => {
  const r = await call('read_process_output', { pid: 999999 });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), 'Error: No session found for PID 999999');

  const small = new TerminalManager({ maxBufferChars: 2000, completedTailChars: 1000 });
  try {
    const t = terminalTools(ctx, small);
    const s = await runTool(t, 'start_process', { command: 'seq 1 3000', shell: SH, timeout_ms: 5000 });
    const pid = pidOf(s);
    assert.match(textOf(s), /✅ Process exited with code 0/);
    assert.match(
      textOf(s),
      /Initial output:\n\[WARNING: output exceeded the session buffer limit; \d+ chars of unread output were evicted before they could be read\]\n\d+\n/,
      'start_process says that unread output was lost',
    );
    const again = textOf(await runTool(t, 'read_process_output', { pid }));
    assert.ok(!again.includes('chars of unread output'), 'no loss once the cursor is inside the retained buffer');
    const tail = textOf(await runTool(t, 'read_process_output', { pid, offset: -2 }));
    assert.match(
      tail,
      /^\[Reading last 2 lines \(total: \d+ lines\)\]\n\[WARNING: output exceeded the session buffer limit; the \d+ earliest lines were evicted and cannot be read\. Line numbers and totals refer to the retained buffer only\]\n\n2999\n3000\n✅/,
    );
    const session = small.get(pid);
    assert.ok(session.buffer.retained().length <= 1000, 'completed sessions keep only the tail');
  } finally {
    await small.shutdown();
  }
});

test('completed sessions are capped (oldest evicted)', async () => {
  const small = new TerminalManager({ maxCompleted: 2 });
  try {
    const t = terminalTools(ctx, small);
    const pids = [];
    for (let i = 0; i < 3; i++) pids.push(pidOf(await runTool(t, 'start_process', { command: `echo run${i}`, shell: SH })));
    assert.equal(textOf(await runTool(t, 'read_process_output', { pid: pids[0] })), `Error: No session found for PID ${pids[0]}`);
    assert.match(textOf(await runTool(t, 'read_process_output', { pid: pids[2], offset: -1 })), /run2/);
  } finally {
    await small.shutdown();
  }
});

// ---------------------------------------------------------------------------------------------
// Output cleanup
// ---------------------------------------------------------------------------------------------

test('ANSI escapes are stripped, CRLF normalized, progress bars collapsed', async () => {
  let r = await start("printf '\\033[31mred\\033[0m plain\\033]0;title\\007 end\\r\\n'");
  assert.match(textOf(r), /Initial output:\nred plain end\n✅/);
  assert.ok(!textOf(r).includes('\x1b'));

  const split = "process.stdout.write('\\x1b[3'); setTimeout(() => process.stdout.write('1mred\\x1b[0m\\n'), 60)";
  r = await start(`'${NODE}' -e "${split}"`);
  assert.match(textOf(r), /Initial output:\nred\n✅/);

  r = await start("printf 'p 10%%\\rp 50%%\\rp 100%%\\n'");
  assert.match(textOf(r), /Initial output:\np 100%\n✅/);
});

test('multibyte characters split across chunks are decoded intact', async () => {
  const script =
    "const b = Buffer.from('h\\u00e9llo \\u{1F600} w\\u00f6rld\\n'); process.stdout.write(b.subarray(0, 9)); " +
    'setTimeout(() => process.stdout.write(b.subarray(9)), 60)';
  const r = await start(`'${NODE}' -e "${script}"`);
  const text = textOf(r);
  assert.match(text, /Initial output:\nhéllo 😀 wörld\n✅/);
  assert.ok(!text.includes('\uFFFD'));
});

// ---------------------------------------------------------------------------------------------
// interact_with_process
// ---------------------------------------------------------------------------------------------

const python = findExecutable('python3');

test('python3 -i: prompt detection, state across inputs, errors, exit detection', { skip: !python && 'python3 not installed' }, async () => {
  const r = await start('python3 -i', { timeout_ms: 10000 });
  const pid = pidOf(r);
  assert.match(textOf(r), new RegExp(`\n🔄 Process ${pid} is waiting for input \\(detected: ">>>"\\)$`));

  const send = async (input, extra = {}) => textOf(await call('interact_with_process', { pid, input, ...extra }));
  const waiting = `🔄 Process ${pid} is waiting for input (detected: ">>>")`;

  assert.equal(await send('x = 21'), `✅ Input executed in process ${pid}.\n📭 (No output produced)\n\n${waiting}`);
  assert.equal(await send('print(x * 2)'), `✅ Input executed in process ${pid}:\n\n📤 Output:\n42\n\n${waiting}`);
  assert.equal(await send('def f(n):\n    return n + 1\n\n'), `✅ Input executed in process ${pid}.\n📭 (No output produced)\n\n${waiting}`);
  assert.equal(await send('print(f(41)); print("> quoted"); print("+1")'), `✅ Input executed in process ${pid}:\n\n📤 Output:\n42\n> quoted\n+1\n\n${waiting}`);
  // REPL input is not shell syntax: it is not checked against the blocklist.
  assert.equal(await send('sudo = 3'), `✅ Input executed in process ${pid}.\n📭 (No output produced)\n\n${waiting}`);
  const err = await send('print(undefined_name)');
  assert.match(err, /📤 Output:\nTraceback[\s\S]*NameError[\s\S]*\n\n🔄 Process \d+ is waiting for input \(detected: ">>>"\)$/);

  // No new output while at the prompt: read returns immediately instead of waiting.
  const t0 = Date.now();
  const idle = textOf(await call('read_process_output', { pid, timeout_ms: 5000 }));
  assert.ok(Date.now() - t0 < 1000, 'did not wait at a prompt');
  assert.equal(idle, `[Reading 0 new lines (total: ${idle.match(/total: (\d+)/)[1]} lines)]\n\n(No new output)\n${waiting}`);

  const t1 = Date.now();
  const bye = await send('exit()');
  assert.ok(Date.now() - t1 < 3000, 'exit detected well before the 8s timeout');
  assert.equal(bye, `✅ Input executed in process ${pid}.\n📭 (No output produced)\n\n✅ Process exited with code 0`);

  const after = await call('interact_with_process', { pid, input: 'print(1)' });
  assert.equal(after.isError, true);
  assert.equal(textOf(after), `Error: No active session for PID ${pid} (it may have exited; use read_process_output to see its final output)`);
  assert.match(textOf(await call('read_process_output', { pid })), /\(No new output\)\n✅ Process completed with exit code 0/);
});

test('node -i: prompt "> ", output, exit', async () => {
  const r = await start(`'${NODE}' -i`, { timeout_ms: 10000 });
  const pid = pidOf(r);
  assert.match(textOf(r), /🔄 Process \d+ is waiting for input \(detected: ">"\)$/);
  const out = textOf(await call('interact_with_process', { pid, input: '[1, 2].map(n => n * 21)' }));
  assert.match(out, /📤 Output:\n\[ 21, 42 \]\n\n🔄 Process \d+ is waiting for input \(detected: ">"\)$/);
  const bye = textOf(await call('interact_with_process', { pid, input: '.exit' }));
  assert.match(bye, /✅ Process exited with code 0$/);
});

test('interactive shell session: commands, blocklist on input, exit', { skip: isWindows }, async () => {
  const r = await start('sh -i', { timeout_ms: 5000 });
  const pid = pidOf(r);
  const m = /🔄 Process \d+ is waiting for input \(detected: "([^"]+)"\)$/.exec(textOf(r));
  assert.ok(m, textOf(r));
  const prompt = m[1];

  const out = textOf(await call('interact_with_process', { pid, input: 'echo hi; echo there' }));
  assert.equal(out, `✅ Input executed in process ${pid}:\n\n📤 Output:\nhi\nthere\n\n🔄 Process ${pid} is waiting for input (detected: "${prompt}")`);

  let denied = await call('interact_with_process', { pid, input: 'sudo ls' });
  assert.equal(denied.isError, true);
  assert.equal(textOf(denied), 'Error: Command not allowed: sudo ls (blocked: sudo)');
  denied = await call('interact_with_process', { pid, input: 'echo x | env sudo reboot' });
  assert.equal(denied.isError, true);

  const bye = textOf(await call('interact_with_process', { pid, input: 'exit' }));
  assert.match(bye, /✅ Process exited with code 0$/);
});

test('interact: timeout message, includes earlier unread output, advances the cursor', async () => {
  const r = await start('cat', { timeout_ms: 100 });
  const pid = pidOf(r);
  await call('interact_with_process', { pid, input: 'one', wait_for_prompt: false });
  const t0 = Date.now();
  const out = textOf(await call('interact_with_process', { pid, input: 'two', timeout_ms: 300 }));
  assert.ok(Date.now() - t0 >= 280);
  assert.equal(
    out,
    `✅ Input executed in process ${pid}:\n\n📤 Output:\none\ntwo\n\n⏱️ No prompt detected within 300ms — the process may still be working. Use read_process_output to get more output.`,
  );
  const read = textOf(await call('read_process_output', { pid, timeout_ms: 0 }));
  assert.match(read, /\(No new output\)/, 'interact consumed what it returned');
  await call('force_terminate', { pid });

  const none = await call('interact_with_process', { pid: 999999, input: 'x' });
  assert.equal(none.isError, true);
  assert.match(textOf(none), /^Error: No active session for PID 999999/);
});

test('interact output is capped at fileReadLineLimit and the rest stays readable', async () => {
  const { ctx: c3, cleanup: c2 } = await makeCtx({ fileReadLineLimit: 3 });
  try {
    const t3 = terminalTools(c3, tm);
    const r = await runTool(t3, 'start_process', { command: 'sh -i', shell: SH, timeout_ms: 5000 });
    const pid = pidOf(r);
    const out = textOf(await runTool(t3, 'interact_with_process', { pid, input: 'seq 1 7' }));
    assert.match(out, /📤 Output:\n1\n2\n3\n\[\.\.\. \d+ more lines\. Use read_process_output to continue\]\n\n🔄/);
    const rest = textOf(await runTool(t3, 'read_process_output', { pid }));
    assert.match(rest, /\n\n4\n5\n6\n/);
    await runTool(t3, 'force_terminate', { pid });
  } finally {
    c2();
  }
});

// ---------------------------------------------------------------------------------------------
// force_terminate / shutdown / list_sessions
// ---------------------------------------------------------------------------------------------

test('force_terminate kills the whole process group, including background children', { skip: isWindows }, async () => {
  const r = await start('sleep 30 & echo "child:$!"; wait', { timeout_ms: 400 });
  const pid = pidOf(r);
  const childPid = Number(/child:(\d+)/.exec(textOf(r))?.[1]);
  assert.ok(childPid > 0, textOf(r));
  assert.ok(alive(childPid));

  const t = textOf(await call('force_terminate', { pid }));
  assert.match(t, new RegExp(`^Successfully terminated session ${pid} \\((signal SIG[A-Z]+|exit code \\d+)\\)$`));
  await waitFor(() => !alive(childPid), { timeout: 3000 });
  assert.match(textOf(await call('read_process_output', { pid })), /✅ Process (terminated by signal|completed with exit code)/);

  const again = await call('force_terminate', { pid });
  assert.equal(again.isError, true);
  assert.equal(textOf(again), `Error: No active session found for PID ${pid}`);
});

/**
 * A python REPL that exited on its own after SIGINT + EOF: 3.12 reports exit code 0, while 3.14
 * re-raises the pending KeyboardInterrupt at exit (signal SIGINT). Never SIGTERM/SIGKILL.
 */
const cleanReplExit = (pid) => new RegExp(`^Successfully terminated session ${pid} \\((exit code 0|signal SIGINT)\\)$`);

test('force_terminate lets a REPL that catches SIGINT exit cleanly on EOF (atexit runs), not by SIGKILL', { skip: isWindows || (!python && 'python3 not installed') }, async () => {
  const dir = tmpDir();
  try {
    const mark = path.join(dir, 'atexit.txt');
    const pid = pidOf(await start('python3 -i -q', { timeout_ms: 10000 }));
    const reg = `import atexit; atexit.register(lambda: open(${JSON.stringify(mark)}, 'w').write('atexit ran'))`;
    assert.match(textOf(await call('interact_with_process', { pid, input: reg })), /waiting for input/);
    const t0 = Date.now();
    assert.match(textOf(await call('force_terminate', { pid })), cleanReplExit(pid));
    // python answers SIGINT with "KeyboardInterrupt" and a fresh ">>> ": the rest of the SIGINT wait is skipped.
    assert.ok(Date.now() - t0 < 900, `took ${Date.now() - t0}ms`);
    assert.equal(fs.readFileSync(mark, 'utf8'), 'atexit ran');
  } finally {
    rmrf(dir);
  }
});

test('force_terminate: an interactive shell that ignores SIGINT exits on EOF', { skip: isWindows }, async () => {
  const pid = pidOf(await start('sh -i', { timeout_ms: 5000 }));
  const t = textOf(await call('force_terminate', { pid }));
  assert.match(t, new RegExp(`^Successfully terminated session ${pid} \\(exit code \\d+\\)$`));
});

test('force_terminate reaches jobs an interactive shell moved to their own process group (job control)', { skip: isWindows }, async () => {
  // macOS bash (sh -i / bash -i) turns job control on without a TTY: each job gets its own
  // process group, which kill(-sessionPid) alone never reaches.
  for (const shell of ['sh -i', 'bash -i']) {
    const jobs = [];
    try {
      const pid = pidOf(await start(shell, { timeout_ms: 5000 }));
      await call('interact_with_process', { pid, input: 'sleep 28 > /dev/null 2>&1 & echo bg:$!' }); // unquoted: no history expansion
      await call('interact_with_process', { pid, input: `sh -c 'echo "fg:$$"; exec sleep 27'`, wait_for_prompt: false });
      await waitFor(() => /fg:\d+/.test(tm.get(pid).buffer.retained()), { timeout: 5000 });
      const out = tm.get(pid).buffer.retained();
      jobs.push(...[/bg:(\d+)/, /fg:(\d+)/].map((re) => Number(re.exec(out)?.[1])));
      assert.ok(jobs.every((j) => j > 0 && alive(j)), `${shell}: ${out}`);

      const t0 = Date.now();
      const t = textOf(await call('force_terminate', { pid }));
      assert.match(t, new RegExp(`^Successfully terminated session ${pid} \\((exit code \\d+|signal SIG[A-Z]+)\\)$`), `${shell}: ${t}`);
      assert.ok(Date.now() - t0 < 3000, `${shell}: took ${Date.now() - t0}ms`);
      await waitFor(() => jobs.every((j) => !alive(j)), { timeout: 2000 }).catch(() => {});
      assert.deepEqual(jobs.filter(alive), [], `${shell}: jobs left running`);
    } finally {
      for (const j of jobs.filter((x) => x > 0 && alive(x))) process.kill(j, 'SIGKILL');
    }
  }
});

test('force_terminate escalates to SIGTERM when SIGINT and EOF do not stop it, and to SIGKILL last', { skip: isWindows }, async () => {
  const dir = tmpDir();
  try {
    const mark = path.join(dir, 'term.txt');
    const script = path.join(dir, 'stubborn.cjs');
    fs.writeFileSync(
      script,
      `process.on('SIGINT', () => {}); process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(mark)}, 'SIGTERM handled'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);`,
    );
    const pid = pidOf(await start(`'${NODE}' '${script}'`, { timeout_ms: 0 }));
    assert.match(textOf(await call('read_process_output', { pid, timeout_ms: 5000 })), /ready/); // handlers installed
    const t0 = Date.now();
    assert.equal(textOf(await call('force_terminate', { pid })), `Successfully terminated session ${pid} (exit code 0)`);
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0}ms`);
    assert.equal(fs.readFileSync(mark, 'utf8'), 'SIGTERM handled');

    const deaf = pidOf(await start('trap "" INT TERM; sleep 30', { timeout_ms: 200 }));
    const t1 = Date.now();
    assert.equal(textOf(await call('force_terminate', { pid: deaf })), `Successfully terminated session ${deaf} (signal SIGKILL)`);
    assert.ok(Date.now() - t1 < 6000, `took ${Date.now() - t1}ms`);
  } finally {
    rmrf(dir);
  }
});

test('force_terminate: concurrent calls on one REPL share one escalation (still a clean exit)', { skip: isWindows || (!python && 'python3 not installed') }, async () => {
  const dir = tmpDir();
  try {
    const mark = path.join(dir, 'atexit.txt');
    const pid = pidOf(await start('python3 -i -q', { timeout_ms: 10000 }));
    await call('interact_with_process', { pid, input: `import atexit; atexit.register(lambda: open(${JSON.stringify(mark)}, 'w').write('ok'))` });
    const both = await Promise.all([call('force_terminate', { pid }), call('force_terminate', { pid })]);
    for (const r of both) assert.match(textOf(r), cleanReplExit(pid));
    assert.equal(fs.readFileSync(mark, 'utf8'), 'ok');
  } finally {
    rmrf(dir);
  }
});

test('force_terminate: prompt-like output during SIGINT cleanup does not cut the grace period short', { skip: isWindows }, async () => {
  const dir = tmpDir();
  try {
    const mark = path.join(dir, 'saved.txt');
    const script = path.join(dir, 'worker.cjs');
    // Not a REPL: it was never at a prompt, so "…checkpoint: " must not count as one.
    fs.writeFileSync(
      script,
      `process.on('SIGINT', () => { process.stdout.write('Interrupted, saving checkpoint: '); setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(mark)}, 'saved'); process.exit(0); }, 1500); }); console.log('working'); setInterval(() => {}, 1000);`,
    );
    const pid = pidOf(await start(`'${NODE}' '${script}'`, { timeout_ms: 0 }));
    assert.match(textOf(await call('read_process_output', { pid, timeout_ms: 5000 })), /working/);
    assert.equal(textOf(await call('force_terminate', { pid })), `Successfully terminated session ${pid} (exit code 0)`);
    assert.equal(fs.readFileSync(mark, 'utf8'), 'saved');
  } finally {
    rmrf(dir);
  }
});

test('a background child holding the output open: start/interact return once the shell has exited', { skip: isWindows }, async () => {
  const t0 = Date.now();
  const r = await start('sleep 1.2 & echo started', { timeout_ms: 8000 });
  const text = textOf(r);
  const pid = pidOf(r);
  assert.ok(Date.now() - t0 < 1000, `returned after the shell exited, not at the timeout (${Date.now() - t0}ms)`);
  assert.match(
    text,
    /Initial output:\nstarted\n⏳ Process is still running \(its shell exited with code 0, but a background process still holds the output open\)\. Use read_process_output/,
  );
  // The session closes when the background sleep ends and releases the pipe.
  const read = textOf(await call('read_process_output', { pid, timeout_ms: 5000 }));
  assert.match(read, /^\[Reading 0 new lines \(total: 1 lines\)\]\n\n\(No new output\)\n✅ Process completed with exit code 0/);

  const sh = await start('sh -i', { timeout_ms: 5000 });
  const shPid = pidOf(sh);
  assert.match(textOf(sh), /🔄 Process \d+ is waiting for input/);
  const t1 = Date.now();
  const bye = textOf(await call('interact_with_process', { pid: shPid, input: 'sleep 1.2 & exit 4' }));
  assert.ok(Date.now() - t1 < 1000, `exit noticed without waiting for the background child (${Date.now() - t1}ms)`);
  assert.match(bye, /\n\n✅ Process exited with code 4 \(a background process it started still holds its output open; /);
  assert.ok(tm.getActive(shPid), 'session stays active until the output closes');
  await call('force_terminate', { pid: shPid });
  assert.equal(tm.getActive(shPid), undefined);
});

test('shutdown() kills every session (escalating to SIGKILL) and refuses new ones', { skip: isWindows }, async () => {
  const m = new TerminalManager();
  const t = terminalTools(ctx, m);
  const a = pidOf(await runTool(t, 'start_process', { command: 'sleep 30', shell: SH, timeout_ms: 0 }));
  const b = await runTool(t, 'start_process', { command: 'sleep 30 & echo "bg:$!"; wait', shell: SH, timeout_ms: 300 });
  const bg = Number(/bg:(\d+)/.exec(textOf(b))[1]);
  const c = pidOf(await runTool(t, 'start_process', { command: 'trap "" TERM; sleep 30', shell: SH, timeout_ms: 200 }));
  for (const p of [a, pidOf(b), bg, c]) assert.ok(alive(p), `pid ${p} alive before shutdown`);

  const t0 = Date.now();
  await m.shutdown();
  assert.ok(Date.now() - t0 < 3500, `shutdown took ${Date.now() - t0}ms`);
  await waitFor(() => [a, pidOf(b), bg, c].every((p) => !alive(p)), { timeout: 2000 });
  assert.equal(m.listActive().length, 0);

  const refused = await runTool(t, 'start_process', { command: 'echo x', shell: SH });
  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), 'Error: Failed to start process: the server is shutting down');
});

test('shutdown() also stops jobs a job-control shell moved to their own process group', { skip: isWindows }, async () => {
  const m = new TerminalManager();
  const t = terminalTools(ctx, m);
  let bg = 0;
  try {
    const sh = pidOf(await runTool(t, 'start_process', { command: 'sh -i', shell: SH, timeout_ms: 5000 }));
    const out = textOf(await runTool(t, 'interact_with_process', { pid: sh, input: 'sleep 29 > /dev/null 2>&1 & echo bg:$!' }));
    bg = Number(/bg:(\d+)/.exec(out)?.[1]);
    assert.ok(bg > 0 && alive(bg), out);
    await m.shutdown();
    await waitFor(() => !alive(bg), { timeout: 2000 }).catch(() => {});
    assert.ok(!alive(bg), `job ${bg} survived shutdown()`);
  } finally {
    if (bg > 0 && alive(bg)) process.kill(bg, 'SIGKILL');
  }
});

test('list_sessions formats active and recently completed sessions', { skip: isWindows }, async () => {
  const m = new TerminalManager();
  const t = terminalTools(ctx, m);
  try {
    assert.equal(textOf(await runTool(t, 'list_sessions', {})), 'No active sessions');
    const done = pidOf(await runTool(t, 'start_process', { command: 'echo done', shell: SH }));
    assert.equal(
      textOf(await runTool(t, 'list_sessions', {})),
      `No active sessions\n\nRecently completed:\nPID: ${done}, Exit: 0, Runtime: 0s, Command: echo done`,
    );
    const run = pidOf(await runTool(t, 'start_process', { command: 'sleep 30', shell: SH, timeout_ms: 0 }));
    const shellPid = pidOf(await runTool(t, 'start_process', { command: 'sh -i', shell: SH }));
    const long = 'sleep 31 # ' + 'x'.repeat(100);
    const longPid = pidOf(await runTool(t, 'start_process', { command: long, shell: SH, timeout_ms: 0 }));
    await sleep(150); // let the shell prompt go quiet
    const text = textOf(await runTool(t, 'list_sessions', {}));
    assert.match(text, /^Active sessions:\n/);
    assert.match(text, new RegExp(`PID: ${run}, Status: running, Runtime: \\d+s, Command: sleep 30\n`));
    assert.match(text, new RegExp(`PID: ${shellPid}, Status: waiting for input, Runtime: \\d+s, Command: sh -i\n`));
    const longLine = text.split('\n').find((l) => l.startsWith(`PID: ${longPid},`));
    const shown = longLine.slice(longLine.indexOf('Command: ') + 9);
    assert.equal(shown.length, 80);
    assert.ok(shown.endsWith('...'));
    assert.ok(text.endsWith(`\n\nRecently completed:\nPID: ${done}, Exit: 0, Runtime: 0s, Command: echo done`), text);

    await runTool(t, 'force_terminate', { pid: run });
    const after = textOf(await runTool(t, 'list_sessions', {}));
    assert.match(after, new RegExp(`Recently completed:\nPID: ${run}, Exit: SIG[A-Z]+, Runtime: \\d+s, Command: sleep 30\nPID: ${done}, Exit: 0`));
  } finally {
    await m.shutdown();
  }
});

// ---------------------------------------------------------------------------------------------
// Through a real MCP client (schema validation + coercion by the SDK), when the full server builds
// ---------------------------------------------------------------------------------------------

test('through an in-memory MCP client: coercion, tool list order', async (t) => {
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
    const ours = ['start_process', 'read_process_output', 'interact_with_process', 'force_terminate', 'list_sessions'];
    assert.deepEqual(names.filter((n) => ours.includes(n)), ours);
    const startTool = listed.tools.find((x) => x.name === 'start_process');
    assert.equal(startTool.inputSchema.properties.timeout_ms.type, 'integer');
    assert.deepEqual(startTool.inputSchema.required, ['command']);

    const r = await conn.call('start_process', { command: 'echo via-mcp', shell: SH, timeout_ms: '5000' });
    assert.ok(!r.isError, textOf(r));
    const pid = pidOf(r);
    const read = await conn.call('read_process_output', { pid: String(pid), offset: '-1' });
    assert.match(textOf(read), /via-mcp/);
    const w = await conn.call('interact_with_process', { pid, input: 'x', wait_for_prompt: 'false' });
    assert.match(textOf(w), /No active session for PID/);
  } finally {
    await conn.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Regressions found in review
// ---------------------------------------------------------------------------------------------

test('regression: stdout and stderr keep the order they were written in', { skip: isWindows }, async () => {
  const r = await start('echo out1; echo err1 >&2; echo out2; echo err2 >&2; echo out3');
  assert.match(textOf(r), /Initial output:\nout1\nerr1\nout2\nerr2\nout3\n✅ Process exited with code 0/);
});

test('regression: a prompt written to stderr right after a result on stdout is detected (python3 -i style)', { skip: isWindows }, async () => {
  // Like python3 -i without a TTY: results on stdout, prompts on stderr. With two pipes the
  // prompt could be read before the result, leaving "2\n" as the last line: an 8s wait and
  // "No prompt detected".
  const script = "printf '>>> ' >&2; while read -r l; do echo \"$l\"; printf '>>> ' >&2; done";
  const r = await start(script);
  const pid = pidOf(r);
  assert.match(textOf(r), /🔄 Process \d+ is waiting for input \(detected: ">>>"\)$/);
  const t0 = Date.now();
  const out = textOf(await call('interact_with_process', { pid, input: 'a\nb', timeout_ms: 3000 }));
  assert.ok(Date.now() - t0 < 1500, `prompt seen without waiting out the timeout (${Date.now() - t0}ms)`);
  assert.equal(out, `✅ Input executed in process ${pid}:\n\n📤 Output:\na\n>>> b\n\n🔄 Process ${pid} is waiting for input (detected: ">>>")`);
  await call('force_terminate', { pid });
});

test('regression: an answered prompt is not reported as waiting; read_process_output waits for the reply', async () => {
  const script =
    "process.stdout.write('cmd> '); process.stdin.on('data', () => setTimeout(() => process.stdout.write('done\\ncmd> '), 600))";
  const r = await start(`'${NODE}' -e "${script}"`);
  const pid = pidOf(r);
  const waiting = `🔄 Process ${pid} is waiting for input (detected: "cmd>")`;
  assert.ok(textOf(r).endsWith(`\n${waiting}`), textOf(r));

  const sent = await call('interact_with_process', { pid, input: 'go', wait_for_prompt: false });
  assert.ok(!sent.isError);
  await sleep(150); // past the quiet period, so a stale prompt would show
  assert.match(textOf(await call('list_sessions', {})), new RegExp(`PID: ${pid}, Status: running,`));
  const t0 = Date.now();
  const read = textOf(await call('read_process_output', { pid, timeout_ms: 5000 }));
  assert.ok(Date.now() - t0 >= 300, `waited for the reply (${Date.now() - t0}ms)`);
  assert.equal(read, `[Reading 2 new lines (total: 2 lines)]\n\ndone\ncmd> \n${waiting}`);

  // Same through interact with a short timeout: the stale prompt must not end the wait early.
  const short = textOf(await call('interact_with_process', { pid, input: 'again', timeout_ms: 200 }));
  assert.match(short, /⏱️ No prompt detected within 200ms/);
  const later = textOf(await call('read_process_output', { pid, timeout_ms: 5000 }));
  assert.match(later, new RegExp(`\n\ndone\ncmd> \n${waiting.replace(/[()]/g, '\\$&')}$`));
  await call('force_terminate', { pid });
});

test('regression: the next prompt on the line of an answered one is reported alone (no echo)', { skip: isWindows }, async () => {
  const r = await start('sh -i', { timeout_ms: 5000 });
  const pid = pidOf(r);
  const prompt = /detected: "([^"]+)"\)$/.exec(textOf(r))[1];
  // `cd /` prints nothing, so sh's next prompt lands on the same line as the previous one.
  const out = textOf(await call('interact_with_process', { pid, input: 'cd /' }));
  assert.equal(out, `✅ Input executed in process ${pid}.\n📭 (No output produced)\n\n🔄 Process ${pid} is waiting for input (detected: "${prompt}")`);
  await call('force_terminate', { pid });
});

test('regression: node REPL continuation prompt "| " counts as waiting for input', async () => {
  assert.equal(detectPrompt('| '), '|');
  assert.equal(detectPrompt('| | '), '|');
  assert.equal(detectPrompt('a | b | '), null);
  const r = await start(`'${NODE}' -i`, { timeout_ms: 10000 });
  const pid = pidOf(r);
  const t0 = Date.now();
  const out = textOf(await call('interact_with_process', { pid, input: 'const o = {\n  a: 1,', timeout_ms: 5000 }));
  assert.ok(Date.now() - t0 < 2000, `continuation prompt detected (${Date.now() - t0}ms)`);
  assert.match(out, /🔄 Process \d+ is waiting for input \(detected: "\|"\)$/);
  const done = textOf(await call('interact_with_process', { pid, input: '  b: 2 };\no.a + o.b' }));
  // Without a TTY there is no echo, so the prompt printed after `undefined` shares a line with `3`.
  assert.match(done, /\n(?:> )?3\n\n🔄 Process \d+ is waiting for input \(detected: ">"\)$/);
  await call('force_terminate', { pid });
});

test('regression: backspace overstrikes (man pages) and \\b spinners are rendered like a terminal', async () => {
  const c = new StreamCleaner();
  assert.equal(c.push('N\bNA\bAM\bME\bE\n     l\bls\bs - list, _\bf_\bi_\bl_\be\n'), 'NAME\n     ls - list, file\n');
  assert.equal(new StreamCleaner().push('spin |\b/\b-\bok\n\bx\n'), 'spin ok\nx\n');
  const r = await start("printf 'N\\bNA\\bAM\\bME\\bE\\n  -\\b-a\\ba  all\\n'");
  assert.match(textOf(r), /Initial output:\nNAME\n  -a  all\n✅/);
});

test('regression: background processes that outlive their session are stopped by force_terminate and shutdown()', { skip: isWindows }, async () => {
  const m = new TerminalManager();
  const t = terminalTools(ctx, m);
  const run = (command) => runTool(t, 'start_process', { command, shell: SH, timeout_ms: 5000 });
  const a = await run('sleep 30 > /dev/null 2>&1 & echo "bg:$!"');
  const aPid = pidOf(a);
  const aBg = Number(/bg:(\d+)/.exec(textOf(a))[1]);
  assert.match(textOf(a), /✅ Process exited with code 0/);
  assert.ok(alive(aBg));
  const listed = textOf(await runTool(t, 'list_sessions', {}));
  assert.match(listed, new RegExp(`PID: ${aPid}, Exit: 0 \\(processes it started are still running; force_terminate stops them\\), `));

  const ft = textOf(await runTool(t, 'force_terminate', { pid: aPid }));
  assert.equal(ft, `Session ${aPid} exited with code 0 earlier; terminated the background processes it left running`);
  assert.ok(!alive(aBg));
  const again = await runTool(t, 'force_terminate', { pid: aPid });
  assert.equal(textOf(again), `Error: No active session found for PID ${aPid}`);

  const b = await run('trap "" TERM; sleep 30 > /dev/null 2>&1 & echo "bg:$!"');
  const bBg = Number(/bg:(\d+)/.exec(textOf(b))[1]);
  assert.ok(alive(bBg));
  await m.shutdown();
  await waitFor(() => !alive(bBg), { timeout: 3000 });
});
