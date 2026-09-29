// Security layer: validatePath (real temp dirs + symlinks), runsInteractiveShell, checkCommand basics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, tmpDir, rmrf } from './helpers.js';

const { validatePath, PathNotAllowedError, expandHome, isWithin, resolveReal } = await load('security/paths.js');
const { checkCommand, runsInteractiveShell } = await load('security/commands.js');
const { DEFAULT_BLOCKED_COMMANDS } = await load('config.js');

const insensitive = process.platform === 'darwin' || process.platform === 'win32';

/** root/allowed, root/allowed-evil, root/outside (+ files), all realpath'd. */
function sandbox() {
  const root = tmpDir('mcpc-sec-');
  const allowed = path.join(root, 'allowed');
  const evil = path.join(root, 'allowed-evil');
  const outside = path.join(root, 'outside');
  for (const d of [allowed, evil, outside]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(allowed, 'in.txt'), 'in');
  fs.writeFileSync(path.join(evil, 'e.txt'), 'evil');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  return { root, allowed, evil, outside, done: () => rmrf(root) };
}

async function denied(p, dirs) {
  await assert.rejects(validatePath(p, dirs), (err) => {
    assert.ok(err instanceof PathNotAllowedError, `expected PathNotAllowedError, got ${err}`);
    assert.equal(
      err.message,
      `Path not allowed: ${p}. Must be within one of these directories: ${dirs.map((d) => d.trim()).filter(Boolean).join(', ')}`,
    );
    return true;
  });
}

// ---------------------------------------------------------------- validatePath

test('validatePath: allowed dir itself, child file, nonexistent child and nested write target', async () => {
  const s = sandbox();
  try {
    assert.equal(await validatePath(s.allowed, [s.allowed]), s.allowed);
    assert.equal(await validatePath(s.allowed + path.sep, [s.allowed]), s.allowed);
    assert.equal(await validatePath(path.join(s.allowed, 'in.txt'), [s.allowed]), path.join(s.allowed, 'in.txt'));
    assert.equal(await validatePath(path.join(s.allowed, 'new.txt'), [s.allowed]), path.join(s.allowed, 'new.txt'));
    assert.equal(
      await validatePath(path.join(s.allowed, 'a', 'b', 'c.txt'), [s.allowed]),
      path.join(s.allowed, 'a', 'b', 'c.txt'),
    );
    // allowed entry with a trailing slash
    assert.equal(await validatePath(path.join(s.allowed, 'in.txt'), [s.allowed + '/']), path.join(s.allowed, 'in.txt'));
  } finally {
    s.done();
  }
});

test('validatePath: ../ traversal out of the allowed dir is denied', async () => {
  const s = sandbox();
  try {
    await denied(path.join(s.allowed, '..', 'outside', 'secret.txt'), [s.allowed]);
    await denied(`${s.allowed}/../outside`, [s.allowed]);
    await denied(`${s.allowed}/sub/../../outside/new.txt`, [s.allowed]);
    // traversal that stays inside is fine
    assert.equal(await validatePath(`${s.allowed}/x/../in.txt`, [s.allowed]), path.join(s.allowed, 'in.txt'));
  } finally {
    s.done();
  }
});

test('validatePath: prefix trick (allowed vs allowed-evil) is denied', async () => {
  const s = sandbox();
  try {
    await denied(s.evil, [s.allowed]);
    await denied(path.join(s.evil, 'e.txt'), [s.allowed]);
    await denied(path.join(s.evil, 'new.txt'), [s.allowed]);
  } finally {
    s.done();
  }
});

test('validatePath: symlinks inside the allowed dir that point outside are denied', async () => {
  const s = sandbox();
  try {
    fs.symlinkSync(path.join(s.outside, 'secret.txt'), path.join(s.allowed, 'file-link'));
    fs.symlinkSync(s.outside, path.join(s.allowed, 'dir-link'));
    await denied(path.join(s.allowed, 'file-link'), [s.allowed]);
    await denied(path.join(s.allowed, 'dir-link'), [s.allowed]);
    await denied(path.join(s.allowed, 'dir-link', 'secret.txt'), [s.allowed]);
    // not-yet-existing file (and nested dirs) under a symlinked directory
    await denied(path.join(s.allowed, 'dir-link', 'new.txt'), [s.allowed]);
    await denied(path.join(s.allowed, 'dir-link', 'x', 'y', 'new.txt'), [s.allowed]);
  } finally {
    s.done();
  }
});

test('validatePath: a dangling symlink is followed (a write through it cannot escape)', async () => {
  const s = sandbox();
  try {
    const outTarget = path.join(s.outside, 'created-by-write.txt');
    const link = path.join(s.allowed, 'dangling-out');
    fs.symlinkSync(outTarget, link);
    await assert.rejects(validatePath(link, [s.allowed]), (err) => {
      assert.ok(err instanceof PathNotAllowedError);
      assert.equal(
        err.message,
        `Path not allowed: ${link} (a symbolic link to ${outTarget}). Must be within one of these directories: ${s.allowed}`,
      );
      return true;
    });
    // dangling link to a missing directory, used as a parent
    fs.symlinkSync(path.join(s.outside, 'nodir'), path.join(s.allowed, 'dangling-dir'));
    await denied(path.join(s.allowed, 'dangling-dir', 'f.txt'), [s.allowed]);
    // dangling link that stays inside resolves to its target
    const inTarget = path.join(s.allowed, 'future.txt');
    fs.symlinkSync('future.txt', path.join(s.allowed, 'dangling-in'));
    assert.equal(await validatePath(path.join(s.allowed, 'dangling-in'), [s.allowed]), inTarget);
    // chain of dangling links
    fs.symlinkSync('dangling-out', path.join(s.allowed, 'chain'));
    await assert.rejects(validatePath(path.join(s.allowed, 'chain'), [s.allowed]), PathNotAllowedError);
    assert.equal(fs.existsSync(outTarget), false);
  } finally {
    s.done();
  }
});

test('validatePath: symlink loop is an error, not an allow', async () => {
  const s = sandbox();
  try {
    fs.symlinkSync('loop-b', path.join(s.allowed, 'loop-a'));
    fs.symlinkSync('loop-a', path.join(s.allowed, 'loop-b'));
    await assert.rejects(validatePath(path.join(s.allowed, 'loop-a'), [s.allowed]), /ELOOP|symbolic links/);
  } finally {
    s.done();
  }
});

test('validatePath: a symlink outside pointing inside is allowed (resolved target is inside)', async () => {
  const s = sandbox();
  try {
    const link = path.join(s.outside, 'to-allowed');
    fs.symlinkSync(s.allowed, link);
    assert.equal(await validatePath(link, [s.allowed]), s.allowed);
    assert.equal(await validatePath(path.join(link, 'in.txt'), [s.allowed]), path.join(s.allowed, 'in.txt'));
    assert.equal(await validatePath(path.join(link, 'new.txt'), [s.allowed]), path.join(s.allowed, 'new.txt'));
  } finally {
    s.done();
  }
});

test('validatePath: allowed dir given through a symlink (unresolved os.tmpdir()) works', async () => {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-sec-raw-'));
  try {
    fs.writeFileSync(path.join(raw, 'f.txt'), 'x');
    const real = fs.realpathSync(raw);
    // allowed entry unresolved, requested path unresolved and resolved
    assert.equal(await validatePath(path.join(raw, 'f.txt'), [raw]), path.join(real, 'f.txt'));
    assert.equal(await validatePath(path.join(real, 'f.txt'), [raw]), path.join(real, 'f.txt'));
    assert.equal(await validatePath(path.join(raw, 'f.txt'), [real]), path.join(real, 'f.txt'));
    assert.equal(await validatePath(path.join(raw, 'missing', 'g.txt'), [raw]), path.join(real, 'missing', 'g.txt'));
    // explicit symlinked root
    const s = sandbox();
    try {
      const alias = path.join(s.root, 'alias');
      fs.symlinkSync(s.allowed, alias);
      assert.equal(await validatePath(path.join(s.allowed, 'in.txt'), [alias]), path.join(s.allowed, 'in.txt'));
      await denied(path.join(s.outside, 'secret.txt'), [alias]);
    } finally {
      s.done();
    }
  } finally {
    rmrf(raw);
  }
});

test('validatePath: ~ expansion (path and allowed entry)', async () => {
  const home = os.homedir();
  const homeReal = fs.realpathSync(home);
  assert.equal(expandHome('~'), home);
  assert.equal(expandHome('~/a/b'), path.join(home, 'a', 'b'));
  assert.equal(expandHome('~user/x'), '~user/x');
  assert.equal(expandHome('/x/~/y'), '/x/~/y');
  const name = `mcpc-nonexistent-${process.pid}-${Date.now()}.txt`;
  assert.equal(await validatePath(`~/${name}`, ['~']), path.join(homeReal, name));
  assert.equal(await validatePath('~', [home]), homeReal);
  await denied(`~/${name}`, [path.join(home, `mcpc-other-${process.pid}`)]);
});

test('validatePath: relative paths resolve against process.cwd()', async () => {
  const s = sandbox();
  const saved = process.cwd();
  try {
    process.chdir(s.allowed);
    assert.equal(await validatePath('in.txt', [s.allowed]), path.join(s.allowed, 'in.txt'));
    assert.equal(await validatePath('./sub/new.txt', [s.allowed]), path.join(s.allowed, 'sub', 'new.txt'));
    assert.equal(await validatePath('.', [s.allowed]), s.allowed);
    await denied('../outside/secret.txt', [s.allowed]);
    // relative allowed entries resolve against cwd too
    assert.equal(await validatePath('in.txt', ['.']), path.join(s.allowed, 'in.txt'));
    await denied('../outside', ['.']);
  } finally {
    process.chdir(saved);
    s.done();
  }
});

test("validatePath: empty list, ['/'] and whitespace-only lists allow everything", async () => {
  const s = sandbox();
  try {
    const p = path.join(s.outside, 'secret.txt');
    assert.equal(await validatePath(p, []), p);
    assert.equal(await validatePath(p, ['/']), p);
    assert.equal(await validatePath(p, ['  ', '']), p);
    assert.equal(await validatePath(p, [s.allowed, '/']), p);
  } finally {
    s.done();
  }
});

test('validatePath: whitespace entries are ignored and entries are trimmed', async () => {
  const s = sandbox();
  try {
    const p = path.join(s.allowed, 'in.txt');
    assert.equal(await validatePath(p, ['  ', ` ${s.allowed} `, '']), p);
    await denied(path.join(s.outside, 'secret.txt'), ['  ', ` ${s.allowed} `, '']);
  } finally {
    s.done();
  }
});

test('validatePath: multiple allowed dirs, error lists all of them', async () => {
  const s = sandbox();
  try {
    assert.equal(await validatePath(path.join(s.evil, 'e.txt'), [s.allowed, s.evil]), path.join(s.evil, 'e.txt'));
    await denied(path.join(s.outside, 'secret.txt'), [s.allowed, s.evil]);
    await assert.rejects(
      validatePath(path.join(s.outside, 'secret.txt'), [s.allowed, s.evil]),
      new RegExp(`Must be within one of these directories: ${s.allowed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, `),
    );
  } finally {
    s.done();
  }
});

test('validatePath: case handling is platform dependent', async () => {
  const s = sandbox();
  try {
    const upper = path.join(s.root, 'ALLOWED', 'in.txt');
    if (insensitive) {
      await validatePath(upper, [s.allowed]); // same directory on a case-insensitive FS
      assert.equal(isWithin('/A/B/c', '/a/b'), true);
    } else {
      await denied(upper, [s.allowed]);
      assert.equal(isWithin('/A/B/c', '/a/b'), false);
    }
  } finally {
    s.done();
  }
});

test('validatePath: empty or non-string path is rejected', async () => {
  await assert.rejects(validatePath('', ['/tmp']), /Path must be a non-empty string/);
  await assert.rejects(validatePath('   ', []), /Path must be a non-empty string/);
  await assert.rejects(validatePath(undefined, []), /Path must be a non-empty string/);
});

test('isWithin / resolveReal basics', async () => {
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b/', '/a/b'), true);
  assert.equal(isWithin('/a/b/c', '/a/b/'), true);
  assert.equal(isWithin('/a/bc', '/a/b'), false);
  assert.equal(isWithin('/a', '/a/b'), false);
  assert.equal(isWithin('/anything', '/'), true);
  const s = sandbox();
  try {
    assert.equal(await resolveReal(path.join(s.allowed, 'x', 'y')), path.join(s.allowed, 'x', 'y'));
    // a regular file used as a directory component (ENOTDIR) still resolves
    assert.equal(await resolveReal(path.join(s.allowed, 'in.txt', 'z')), path.join(s.allowed, 'in.txt', 'z'));
  } finally {
    s.done();
  }
});

// ---------------------------------------------------------------- runsInteractiveShell

test('runsInteractiveShell table', () => {
  const table = [
    ['bash', true],
    ['zsh -i', true],
    ['sh', true],
    ['bash -l', true],
    ['/bin/bash -il', true],
    ['ssh host', true],
    ['ssh -p 22 user@host', true],
    ['pwsh', true],
    ['env FOO=1 bash', true],
    ['FOO=1 zsh', true],
    ['bash -c "ls"', false],
    ['bash -lc "ls"', false],
    ['bash script.sh', false],
    ['python3 -i', false],
    ['node', false],
    ['ssh host ls', false],
    ['ssh -p 22 host uptime', false],
    ['ls', false],
    ['', false],
  ];
  for (const [cmd, expected] of table) {
    assert.equal(runsInteractiveShell(cmd), expected, `runsInteractiveShell(${JSON.stringify(cmd)})`);
  }
});

// ---------------------------------------------------------------- checkCommand basics

test('checkCommand: ordinary commands are allowed (no false positives)', () => {
  const allowed = [
    'ls -la',
    'echo sudo',
    'grep sudo /etc/group',
    'git commit -m "fix sudo docs"',
    'npm run build && npm test',
    'python3 -c "print(1)"',
    'ls 2>&1 | head',
    'cat file > out.txt',
    'echo "a;b|c&d"',
    'find . -name "*.ts" -exec wc -l {} \\;',
    'docker ps',
    'initdb -D x',
    'formatter --check',
    'netstat -an',
    'scp a b',
    'git status; git log --oneline | head -5',
  ];
  for (const cmd of allowed) {
    assert.deepEqual(checkCommand(cmd, DEFAULT_BLOCKED_COMMANDS), { allowed: true }, `should allow ${JSON.stringify(cmd)}`);
  }
});

test('checkCommand: a blocked name is refused and reported', () => {
  const r = checkCommand('sudo ls', DEFAULT_BLOCKED_COMMANDS);
  assert.equal(r.allowed, false);
  assert.equal(r.blocked, 'sudo');
  assert.equal(checkCommand('ls; reboot', DEFAULT_BLOCKED_COMMANDS).blocked, 'reboot');
  assert.equal(checkCommand('/sbin/shutdown -h now', DEFAULT_BLOCKED_COMMANDS).blocked, 'shutdown');
});

test('checkCommand: blocklist entries are case-insensitive and trimmed; empty list allows all', () => {
  assert.equal(checkCommand('mytool --x', [' MyTool ']).allowed, false);
  assert.equal(checkCommand('mytool --x', [' MyTool ']).blocked, 'mytool');
  assert.deepEqual(checkCommand('sudo ls', []), { allowed: true });
  assert.deepEqual(checkCommand('sudo ls', ['', '  ']), { allowed: true });
});
