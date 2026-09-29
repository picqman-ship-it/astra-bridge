// ConfigManager / coerceConfigValue: defaults, persistence, coercion, hot reload, corruption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, tmpDir, rmrf } from './helpers.js';

const cfgMod = await load('config.js');
const { ConfigManager, coerceConfigValue, getDefaultConfig, DEFAULT_BLOCKED_COMMANDS, CONFIG_KEYS } = cfgMod;

const EXPECTED_BLOCKED = [
  'mkfs', 'format', 'mount', 'umount', 'fdisk', 'dd', 'parted', 'diskpart', 'sudo', 'su', 'passwd',
  'adduser', 'useradd', 'usermod', 'groupadd', 'chsh', 'visudo', 'shutdown', 'reboot', 'halt',
  'poweroff', 'init', 'iptables', 'firewall', 'netsh', 'sfc', 'bcdedit', 'reg', 'net', 'sc', 'runas',
  'cipher', 'takeown',
];

function fresh() {
  const dir = tmpDir('mcpc-cfgtest-');
  return { dir, cm: new ConfigManager(dir), file: path.join(dir, 'config.json'), done: () => rmrf(dir) };
}

test('fresh dir: config.json is created with exact defaults and 0600 perms', () => {
  const { cm, file, done } = fresh();
  try {
    assert.ok(fs.existsSync(file));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk, cm.get());
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(onDisk, null, 2) + '\n');
    const c = cm.get();
    assert.equal(c.blockedCommands.length, 33);
    assert.deepEqual(c.blockedCommands, EXPECTED_BLOCKED);
    assert.deepEqual(DEFAULT_BLOCKED_COMMANDS, EXPECTED_BLOCKED);
    assert.deepEqual(c.allowedDirectories, []);
    assert.equal(c.fileReadLineLimit, 1000);
    assert.equal(c.fileWriteLineLimit, 50);
    const shell = process.platform === 'win32'
      ? 'powershell.exe'
      : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    assert.equal(c.defaultShell, shell);
    assert.deepEqual(Object.keys(c).sort(), [...CONFIG_KEYS].sort());
    assert.equal(cm.loadError, null);
    assert.equal(cm.file, file);
  } finally {
    done();
  }
});

test('defaultShell rule follows $SHELL', () => {
  const saved = process.env.SHELL;
  try {
    process.env.SHELL = '/opt/custom/fish';
    if (process.platform !== 'win32') assert.equal(getDefaultConfig().defaultShell, '/opt/custom/fish');
    delete process.env.SHELL;
    if (process.platform === 'darwin') assert.equal(getDefaultConfig().defaultShell, '/bin/zsh');
    if (process.platform === 'linux') assert.equal(getDefaultConfig().defaultShell, '/bin/sh');
  } finally {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
});

test('get() returns a copy: mutating it does not change the config', () => {
  const { cm, done } = fresh();
  try {
    cm.get().blockedCommands.push('zzz');
    cm.getValue('allowedDirectories').push('/x');
    assert.ok(!cm.get().blockedCommands.includes('zzz'));
    assert.deepEqual(cm.getValue('allowedDirectories'), []);
  } finally {
    done();
  }
});

test('set() persists, returns the new config, and survives a new manager', () => {
  const { dir, cm, file, done } = fresh();
  try {
    const out = cm.set('fileReadLineLimit', 2000);
    assert.equal(out.fileReadLineLimit, 2000);
    assert.equal(out.fileWriteLineLimit, 50);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fileReadLineLimit, 2000);
    cm.set('allowedDirectories', ['/a', '/b']);
    const again = new ConfigManager(dir);
    assert.equal(again.getValue('fileReadLineLimit'), 2000);
    assert.deepEqual(again.getValue('allowedDirectories'), ['/a', '/b']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // no temp files left behind
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  } finally {
    done();
  }
});

test('set() rejects an invalid value without touching the file', () => {
  const { cm, file, done } = fresh();
  try {
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => cm.set('fileReadLineLimit', 'abc'), /fileReadLineLimit must be a positive integer/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    done();
  }
});

test('coercion: array keys', () => {
  const c = (v) => coerceConfigValue('blockedCommands', v);
  assert.deepEqual(c('["a","b"]'), ['a', 'b']);
  assert.deepEqual(c('  ["a", " b "]'), ['a', 'b']);
  assert.deepEqual(c('sudo'), ['sudo']);
  assert.deepEqual(c(''), []);
  assert.deepEqual(c('   '), []);
  assert.deepEqual(c('[]'), []);
  assert.deepEqual(c(['x', '', '  ']), ['x']);
  assert.throws(() => c('[1,2]'), /must be an array of strings/);
  assert.throws(() => c([1]), /must be an array of strings/);
  assert.throws(() => c(['a', null]), /must be an array of strings/);
  assert.throws(() => c(null), /must be an array of strings/);
  assert.throws(() => c(5), /must be an array of strings/);
  assert.throws(() => c('{"a":1}'), /must be an array of strings/);
  assert.throws(() => c('[bad'), /not a valid JSON array/);
});

test('coercion: number keys', () => {
  const c = (v) => coerceConfigValue('fileReadLineLimit', v);
  assert.equal(c(10), 10);
  assert.equal(c('2000'), 2000);
  assert.equal(c(' 42 '), 42);
  for (const bad of ['abc', 'NaN', NaN, 0, '0', -5, '-5', 1.5, '1.5', '', '   ', null, true, [5], Infinity, 1e300]) {
    assert.throws(() => c(bad), /fileReadLineLimit must be a positive integer/, `should reject ${String(bad)}`);
  }
});

test('coercion: string keys and unknown keys', () => {
  assert.equal(coerceConfigValue('defaultShell', ' /bin/bash '), '/bin/bash');
  for (const bad of ['', '   ', 5, null, ['bash']]) {
    assert.throws(() => coerceConfigValue('defaultShell', bad), /defaultShell must be a non-empty string/);
  }
  assert.throws(() => coerceConfigValue('nope', 1), /Unknown config key: nope/);
  assert.throws(() => coerceConfigValue('__proto__', 1), /Unknown config key/);
});

test('hot reload: two quick external edits are both seen (no mtime granularity blind spot)', () => {
  const { cm, file, done } = fresh();
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t = fs.statSync(file).mtime;
    cfg.fileReadLineLimit = 111;
    fs.writeFileSync(file, JSON.stringify(cfg));
    fs.utimesSync(file, t, t);
    assert.equal(cm.getValue('fileReadLineLimit'), 111);
    // Same size, same mtime, different content: must still be picked up.
    cfg.fileReadLineLimit = 222;
    fs.writeFileSync(file, JSON.stringify(cfg));
    fs.utimesSync(file, t, t);
    assert.equal(cm.getValue('fileReadLineLimit'), 222);
    cfg.allowedDirectories = ['/only/here'];
    fs.writeFileSync(file, JSON.stringify(cfg));
    assert.deepEqual(cm.getValue('allowedDirectories'), ['/only/here']);
  } finally {
    done();
  }
});

test('corrupt file keeps previous config, sets loadError, and recovers when fixed', () => {
  const { cm, file, done } = fresh();
  try {
    cm.set('allowedDirectories', ['/safe']);
    fs.writeFileSync(file, '{ "allowedDirectories": [ oops');
    assert.deepEqual(cm.getValue('allowedDirectories'), ['/safe']);
    assert.match(cm.loadError, /^Could not parse .*config\.json: /);
    // still corrupt on later reads
    assert.deepEqual(cm.getValue('allowedDirectories'), ['/safe']);
    assert.ok(cm.loadError);
    fs.writeFileSync(file, JSON.stringify({ allowedDirectories: ['/fixed'] }));
    assert.deepEqual(cm.getValue('allowedDirectories'), ['/fixed']);
    assert.equal(cm.loadError, null);
    // keys missing from the fixed file fall back to defaults
    assert.equal(cm.getValue('fileReadLineLimit'), 1000);
  } finally {
    done();
  }
});

test('a corrupt file present at startup: defaults in memory + loadError', () => {
  const dir = tmpDir('mcpc-cfgtest-');
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json');
    const cm = new ConfigManager(dir);
    assert.ok(cm.loadError);
    assert.deepEqual(cm.getValue('blockedCommands'), EXPECTED_BLOCKED);
  } finally {
    rmrf(dir);
  }
});

test('set() while the file is corrupt writes a good file and clears loadError', () => {
  const { cm, file, done } = fresh();
  try {
    cm.set('fileWriteLineLimit', 77);
    fs.writeFileSync(file, '<<<garbage>>>');
    cm.get();
    assert.ok(cm.loadError);
    const out = cm.set('fileReadLineLimit', 5);
    assert.equal(out.fileReadLineLimit, 5);
    assert.equal(out.fileWriteLineLimit, 77, 'previous good values are kept');
    assert.equal(cm.loadError, null);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.fileReadLineLimit, 5);
    assert.equal(onDisk.fileWriteLineLimit, 77);
  } finally {
    done();
  }
});

test('deleting the file keeps the last config; set() recreates it', () => {
  const { cm, file, done } = fresh();
  try {
    cm.set('blockedCommands', ['foo']);
    fs.rmSync(file);
    assert.deepEqual(cm.getValue('blockedCommands'), ['foo']);
    assert.equal(cm.loadError, null);
    cm.set('fileReadLineLimit', 9);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk.blockedCommands, ['foo']);
    assert.equal(onDisk.fileReadLineLimit, 9);
  } finally {
    done();
  }
});

test('unknown keys are ignored; invalid non-security preferences use defaults', () => {
  const { cm, file, done } = fresh();
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        telemetryEnabled: true,
        clientId: 'x',
        __proto__: { polluted: true },
        fileReadLineLimit: 'lots',
        fileWriteLineLimit: '25',
        allowedDirectories: ['/limited'],
        blockedCommands: 'rm',
        defaultShell: '',
      }),
    );
    const c = cm.get();
    assert.deepEqual(Object.keys(c).sort(), [...CONFIG_KEYS].sort());
    assert.equal(c.fileReadLineLimit, 1000);
    assert.equal(c.fileWriteLineLimit, 25);
    assert.deepEqual(c.allowedDirectories, ['/limited']);
    assert.deepEqual(c.blockedCommands, ['rm']);
    assert.equal(c.defaultShell, getDefaultConfig().defaultShell);
    assert.equal(cm.loadError, null);
    assert.equal({}.polluted, undefined);
  } finally {
    done();
  }
});

test('non-object JSON keeps prior settings and reports a config error', () => {
  const { cm, file, done } = fresh();
  try {
    for (const text of ['[]', 'null', '42', '"str"']) {
      fs.writeFileSync(file, text);
      assert.deepEqual(cm.get(), getDefaultConfig(), text);
      assert.match(cm.loadError ?? '', /must contain a JSON object/);
    }
  } finally {
    done();
  }
});

test('an unwritable config location does not throw: defaults in memory + loadError', () => {
  const root = tmpDir('mcpc-cfgtest-');
  try {
    // a regular file where the config directory should be (works for any user, root included)
    const blocker = path.join(root, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const cm = new ConfigManager(blocker);
    assert.match(cm.loadError, /^Could not create .*config\.json: .*using defaults/);
    assert.deepEqual(cm.get(), getDefaultConfig());
    assert.throws(() => cm.set('fileReadLineLimit', 5));
    assert.equal(cm.getValue('fileReadLineLimit'), 1000, 'a failed save changes nothing');
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const ro = path.join(root, 'ro');
      fs.mkdirSync(ro, { mode: 0o500 });
      const cm2 = new ConfigManager(ro);
      assert.match(cm2.loadError, /Could not create/);
      assert.deepEqual(cm2.getValue('blockedCommands'), EXPECTED_BLOCKED);
      fs.chmodSync(ro, 0o700);
    }
  } finally {
    rmrf(root);
  }
});

test('history: arguments are capped at every depth, and long lists say how much was dropped', async () => {
  const { CallHistory } = await load('history.js');
  const h = new CallHistory();
  const long = 'z'.repeat(100000);
  h.add(
    'x',
    {
      content: long,
      deep: { a: { b: { c: { d: { e: long } } } } },
      list: Array.from({ length: 120 }, () => 'q'),
      nested: [[[[[[long]]]]]],
      wide: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i])),
    },
    { content: [{ type: 'text', text: 'ok' }] },
    1,
  );
  const [rec] = h.recent();
  const stored = JSON.stringify(rec.arguments);
  assert.ok(stored.length < 3000, `stored ${stored.length} chars`);
  assert.equal(rec.arguments.content.length, 300 + '… [99700 more chars]'.length);
  assert.equal(rec.arguments.deep.a.b.c.d, '[nested object]');
  assert.equal(rec.arguments.list.length, 51);
  assert.equal(rec.arguments.list[50], '… [70 more items]');
  assert.equal(rec.arguments.wide['…'], '[30 more keys]');
  assert.equal(Object.keys(rec.arguments.wide).length, 51);
});

test('an unreadable config.json is reported (not silently replaced by defaults) and never overwritten', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const root = tmpDir('mcpc-cfgtest-');
  try {
    // chmod 000 (e.g. left root-owned by a sudo run): the restrictions in it must not vanish silently.
    const dir = path.join(root, 'noperm');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'config.json');
    const text = JSON.stringify({ allowedDirectories: ['/only/here'], blockedCommands: ['rm'] });
    fs.writeFileSync(file, text, { mode: 0o000 });
    const cm = new ConfigManager(dir);
    assert.match(cm.loadError ?? '', /^Could not read .*config\.json: EACCES.*using defaults/);
    assert.throws(() => cm.set('fileReadLineLimit', 5), /cannot be read.*Refusing to overwrite/);
    fs.chmodSync(file, 0o600);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'the unreadable file was left alone');
    // readable again: loaded, warning cleared
    assert.deepEqual(cm.getValue('allowedDirectories'), ['/only/here']);
    assert.equal(cm.loadError, null);
    // unreadable after a successful load: the last loaded settings stay, with a warning
    fs.chmodSync(file, 0o000);
    assert.deepEqual(cm.getValue('allowedDirectories'), ['/only/here']);
    assert.match(cm.loadError ?? '', /^Could not read .*keeping the last loaded settings/);
    fs.chmodSync(file, 0o600);
    assert.deepEqual(cm.getValue('blockedCommands'), ['rm']);
    assert.equal(cm.loadError, null, 'same content as before, but the warning is cleared once readable');

    // config.json is a directory
    const dir2 = path.join(root, 'isdir');
    fs.mkdirSync(path.join(dir2, 'config.json'), { recursive: true });
    const cm2 = new ConfigManager(dir2);
    assert.match(cm2.loadError ?? '', /^Could not read .*config\.json: EISDIR/);
  } finally {
    for (const f of [path.join(root, 'noperm', 'config.json')]) fs.existsSync(f) && fs.chmodSync(f, 0o600);
    rmrf(root);
  }
});

test('set() writes through a symlinked config.json instead of replacing the link', () => {
  if (process.platform === 'win32') return;
  const root = tmpDir('mcpc-cfgtest-');
  try {
    const target = path.join(root, 'dotfiles', 'mcp-commander.json');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, JSON.stringify({ allowedDirectories: ['/work'] }));
    const dir = path.join(root, 'cfg');
    fs.mkdirSync(dir);
    const link = path.join(dir, 'config.json');
    fs.symlinkSync(target, link);
    const cm = new ConfigManager(dir);
    assert.deepEqual(cm.getValue('allowedDirectories'), ['/work']);
    cm.set('fileReadLineLimit', 777);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'config.json is still a symlink');
    const onDisk = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(onDisk.fileReadLineLimit, 777);
    assert.deepEqual(onDisk.allowedDirectories, ['/work']);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['mcp-commander.json'], 'no temp files left behind');
    // later external edits of the real file are still seen
    fs.writeFileSync(target, JSON.stringify({ fileReadLineLimit: 12 }));
    assert.equal(cm.getValue('fileReadLineLimit'), 12);
  } finally {
    rmrf(root);
  }
});

test('a config dir starting with ~ is expanded to the home directory (not created under the cwd)', () => {
  const root = tmpDir('mcpc-cfgtest-');
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const savedCwd = process.cwd();
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  try {
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.chdir(cwd); // a failure must not litter the repo with a "~" directory
    const cm = new ConfigManager('~/.mcpc-test');
    assert.equal(cm.file, path.join(root, '.mcpc-test', 'config.json'));
    assert.ok(fs.existsSync(cm.file));
    assert.deepEqual(fs.readdirSync(cwd), [], 'no literal "~" directory in the cwd');
    // relative dirs are made absolute, so get_config reports where the file really is
    const rel = new ConfigManager('rel-config');
    assert.equal(rel.file, path.join(fs.realpathSync(cwd), 'rel-config', 'config.json'));
  } finally {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmrf(root);
  }
});

test('blockedCommands given as a plain "a, b" string blocks each name (not one never-matching entry)', () => {
  const c = (v) => coerceConfigValue('blockedCommands', v);
  assert.deepEqual(c('rm, sudo'), ['rm', 'sudo']);
  assert.deepEqual(c('rm,sudo'), ['rm', 'sudo']);
  assert.deepEqual(c('rm sudo  dd'), ['rm', 'sudo', 'dd']);
  assert.deepEqual(c(' ,, '), []);
  // allowedDirectories: a plain string is one path (paths may contain spaces and commas)
  assert.deepEqual(coerceConfigValue('allowedDirectories', '/Users/me/My Projects, 2024'), ['/Users/me/My Projects, 2024']);
});
