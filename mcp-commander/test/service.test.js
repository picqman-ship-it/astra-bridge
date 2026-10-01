// LaunchAgent generation and the install/status/uninstall/doctor commands. launchctl is replaced
// by a fake that records its arguments, and the agents dir is a temp dir: no real service is ever
// registered, started or stopped by these tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DIST, load, rmrf, tmpDir } from './helpers.js';
import { freePort, makeRemoteDir, startChild, stopChild } from './remote-helpers.js';

const { buildPlist, defaultPathEnv, LABEL } = await load('remote/launchagent.js');
const { VERSION } = await load('version.js');

const FAKE_LAUNCHCTL = `#!/bin/sh
echo "$@" >> "$FAKE_LAUNCHCTL_DIR/calls.log"
case "$1" in
  print)
    if [ -f "$FAKE_LAUNCHCTL_DIR/loaded" ]; then
      printf '\\tstate = running\\n\\tpid = 4242\\n\\tlast exit code = (never exited)\\n'; exit 0
    fi
    echo "Could not find service" >&2; exit 113;;
  bootstrap) touch "$FAKE_LAUNCHCTL_DIR/loaded"; exit 0;;
  bootout) rm -f "$FAKE_LAUNCHCTL_DIR/loaded"; exit 0;;
  enable) exit 0;;
esac
exit 64
`;

function fakeEnv() {
  const dir = tmpDir('mcpc-fake-launchctl-');
  const bin = path.join(dir, 'launchctl');
  fs.writeFileSync(bin, FAKE_LAUNCHCTL, { mode: 0o755 });
  const agents = path.join(dir, 'LaunchAgents');
  return {
    dir,
    agents,
    env: { ...process.env, MCP_COMMANDER_LAUNCHCTL: bin, FAKE_LAUNCHCTL_DIR: dir },
    calls: () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') : []),
    cleanup: () => rmrf(dir),
  };
}

function service(args, env) {
  return spawnSync(process.execPath, [path.join(DIST, 'remote', 'service.js'), ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

function doctor(args, env) {
  return spawnSync(process.execPath, [path.join(DIST, 'remote', 'doctor.js'), ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

describe('LaunchAgent plist', () => {
  const opts = {
    nodePath: '/usr/local/bin/node',
    entry: '/Users/me/projects/mcp-commander/dist/http.js',
    remoteDir: '/Users/me/.mcp-commander-remote',
    logFile: '/Users/me/.mcp-commander-remote/logs/service.log',
    pathEnv: defaultPathEnv('/usr/local/bin/node'),
  };

  it('has absolute paths, RunAtLoad, KeepAlive on failure, throttling, graceful stop, private umask and logs', () => {
    const xml = buildPlist(opts);
    assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
    assert.match(xml, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/me\/projects\/mcp-commander\/dist\/http\.js<\/string>\s*<\/array>/);
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    assert.match(xml, /<key>ExitTimeOut<\/key>\s*<integer>20<\/integer>/);
    assert.match(xml, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
    assert.match(xml, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
    assert.match(xml, /<key>MCP_COMMANDER_REMOTE_DIR<\/key>\s*<string>\/Users\/me\/\.mcp-commander-remote<\/string>/);
    assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/\.mcp-commander-remote\/logs\/service\.log<\/string>/);
    assert.doesNotMatch(xml, /token|Bearer|sudo|UserName/i);
  });

  it('escapes XML and rejects relative paths', () => {
    const xml = buildPlist({ ...opts, remoteDir: '/tmp/a&b<c>' });
    assert.ok(xml.includes('/tmp/a&amp;b&lt;c&gt;'));
    assert.throws(() => buildPlist({ ...opts, nodePath: 'node' }), /absolute/);
  });

  it('passes plutil -lint', { skip: process.platform !== 'darwin' }, () => {
    const dir = tmpDir('mcpc-plist-');
    try {
      const file = path.join(dir, 'x.plist');
      fs.writeFileSync(file, buildPlist(opts));
      const r = spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally {
      rmrf(dir);
    }
  });
});

describe('service install/status/uninstall (fake launchctl)', () => {
  let fake;
  let remote;
  let child;
  let port;
  before(async () => {
    fake = fakeEnv();
    port = await freePort();
    remote = makeRemoteDir({ port });
    // A real server on the configured port, so install's health wait and doctor's probes succeed.
    child = await startChild(remote.dir);
  });
  after(async () => {
    if (child) await stopChild(child);
    remote?.cleanup();
    fake?.cleanup();
  });

  it('refuses a custom agents dir with the real launchctl', () => {
    const env = { ...process.env };
    delete env.MCP_COMMANDER_LAUNCHCTL;
    const r = service(['status', '--remote-dir', remote.dir, '--launch-agents-dir', fake.agents], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires MCP_COMMANDER_LAUNCHCTL/);
  });

  it('print shows the plist without changing anything', () => {
    const r = service(['print', '--remote-dir', remote.dir, '--launch-agents-dir', fake.agents], fake.env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(path.join(DIST, 'http.js')));
    assert.ok(r.stdout.includes(process.execPath));
    assert.ok(!r.stdout.includes(remote.token));
    assert.equal(fs.existsSync(fake.agents), false);
    assert.deepEqual(fake.calls(), []);
  });

  it('install is idempotent and reloads gracefully', () => {
    const first = service(['install', '--remote-dir', remote.dir, '--launch-agents-dir', fake.agents], fake.env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /wrote .*local\.mcp-commander\.remote\.plist/);
    assert.match(first.stdout, /service healthy/);
    const plist = path.join(fake.agents, `${LABEL}.plist`);
    assert.equal(fs.statSync(plist).mode & 0o777, 0o644);
    const uid = process.getuid();
    assert.deepEqual(fake.calls(), [`print gui/${uid}/${LABEL}`, `enable gui/${uid}/${LABEL}`, `bootstrap gui/${uid} ${plist}`]);

    const second = service(['install', '--remote-dir', remote.dir, '--launch-agents-dir', fake.agents], fake.env);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /unchanged/);
    assert.match(second.stdout, /bootout: exit 0/);
    const calls = fake.calls().slice(3);
    assert.equal(calls[0], `print gui/${uid}/${LABEL}`);
    assert.equal(calls[1], `bootout gui/${uid}/${LABEL}`);
    assert.ok(calls.includes(`bootstrap gui/${uid} ${plist}`));
  });

  it('status reports plist, launchd state and health', () => {
    const r = service(['status', '--remote-dir', remote.dir, '--launch-agents-dir', fake.agents], fake.env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /plist matches this build: yes/);
    assert.match(r.stdout, /launchd: loaded, state=running, pid=4242/);
    assert.match(r.stdout, /health: HTTP 200/);
  });

  it('doctor verifies build, config, token, agent, health and the running version', () => {
    const r = doctor(['--remote-dir', remote.dir, '--launch-agents-dir', fake.agents, '--json'], fake.env);
    const out = JSON.parse(r.stdout);
    const byName = Object.fromEntries(out.checks.map((c) => [c.name, c]));
    assert.equal(byName['build version'].level, 'pass');
    assert.equal(byName['remote config'].level, 'pass');
    assert.equal(byName['token file'].level, 'pass');
    assert.equal(byName['launch agent'].level, 'pass');
    assert.equal(byName.health.level, 'pass');
    assert.equal(byName['running version'].level, 'pass');
    assert.ok(byName['running version'].detail.includes(`mcp-commander ${VERSION}`));
    assert.equal(byName['exposed tools'].level, 'pass');
    assert.ok(!r.stdout.includes(remote.token) && !r.stderr.includes(remote.token));
    assert.equal(r.status, out.ok ? 0 : 1);
  });

  it('uninstall stops the agent and removes the plist but keeps config and token', () => {
    const r = service(['uninstall', '--remote-dir', remote.dir, '--launch-agents-dir', fake.agents], fake.env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /bootout: exit 0/);
    assert.equal(fs.existsSync(path.join(fake.agents, `${LABEL}.plist`)), false);
    assert.ok(fs.existsSync(path.join(remote.dir, 'token')) && fs.existsSync(path.join(remote.dir, 'remote.json')));
    const again = service(['uninstall', '--remote-dir', remote.dir, '--launch-agents-dir', fake.agents], fake.env);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /not loaded/);
  });

  it('install refuses an invalid config and writes no plist', () => {
    fs.chmodSync(path.join(remote.dir, 'token'), 0o644);
    try {
      const other = fakeEnv();
      try {
        const r = service(['install', '--remote-dir', remote.dir, '--launch-agents-dir', other.agents], other.env);
        assert.equal(r.status, 78);
        assert.match(r.stderr, /must be 0600/);
        assert.equal(fs.existsSync(other.agents), false);
        assert.deepEqual(other.calls(), []);
      } finally {
        other.cleanup();
      }
    } finally {
      fs.chmodSync(path.join(remote.dir, 'token'), 0o600);
    }
  });

  it('doctor fails on a bad token file and on an installed but unloaded agent', () => {
    fs.chmodSync(path.join(remote.dir, 'token'), 0o644);
    try {
      const r = doctor(['--remote-dir', remote.dir, '--launch-agents-dir', fake.agents, '--json'], fake.env);
      assert.equal(r.status, 1);
      const out = JSON.parse(r.stdout);
      assert.equal(out.checks.find((c) => c.name === 'token file').level, 'fail');
    } finally {
      fs.chmodSync(path.join(remote.dir, 'token'), 0o600);
    }
    fs.mkdirSync(fake.agents, { recursive: true });
    fs.writeFileSync(path.join(fake.agents, `${LABEL}.plist`), 'x');
    const r = doctor(['--remote-dir', remote.dir, '--launch-agents-dir', fake.agents, '--json'], fake.env);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).checks.find((c) => c.name === 'launch agent').level, 'fail');
  });
});

describe('remote setup command', () => {
  it('creates 0700/0600 files without printing the token, is idempotent, and rotates on request', () => {
    const base = tmpDir('mcpc-setup-');
    try {
      const dir = path.join(base, 'remote');
      const work = path.join(base, 'work');
      fs.mkdirSync(work);
      const run = (...args) => spawnSync(process.execPath, [path.join(DIST, 'remote', 'setup.js'), '--remote-dir', dir, ...args], { encoding: 'utf8' });

      const missingRoot = run();
      assert.equal(missingRoot.status, 2);
      assert.match(missingRoot.stderr, /--root/);

      const first = run('--root', work, '--port', '9876');
      assert.equal(first.status, 0, first.stderr);
      const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
      assert.equal(token.length, 43);
      assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token));
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(dir, 'logs')).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(dir, 'remote.json')).mode & 0o777, 0o600);
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'remote.json'), 'utf8'));
      assert.equal(cfg.port, 9876);
      assert.equal(cfg.trustedTerminal, false);
      assert.deepEqual(cfg.roots, [work]);

      const second = run();
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /kept existing/);
      assert.equal(fs.readFileSync(path.join(dir, 'token'), 'utf8').trim(), token);

      const rotated = run('--rotate-token');
      assert.equal(rotated.status, 0);
      const token2 = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
      assert.notEqual(token2, token);
      assert.ok(!rotated.stdout.includes(token2));

      fs.chmodSync(dir, 0o755);
      const repaired = run();
      assert.equal(repaired.status, 0);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

      assert.equal(cfg.trustedGui, false, 'GUI tools are off unless asked for');
      const gui = spawnSync(process.execPath, [path.join(DIST, 'remote', 'setup.js'), '--remote-dir', path.join(base, 'r3'), '--root', work, '--trusted-gui'], { encoding: 'utf8' });
      assert.equal(gui.status, 0, gui.stderr);
      assert.match(gui.stdout, /Trusted GUI: ON/);
      const guiCfg = JSON.parse(fs.readFileSync(path.join(base, 'r3', 'remote.json'), 'utf8'));
      assert.equal(guiCfg.trustedGui, true);
      assert.equal(guiCfg.trustedTerminal, false, '--trusted-gui does not imply the terminal');

      const tooBroad = spawnSync(process.execPath, [path.join(DIST, 'remote', 'setup.js'), '--remote-dir', path.join(base, 'r2'), '--root', '/'], { encoding: 'utf8' });
      assert.equal(tooBroad.status, 78);
      assert.match(tooBroad.stderr, /filesystem root|home directory/);
      assert.equal(fs.existsSync(path.join(base, 'r2', 'remote.json')), false);
      assert.equal(fs.existsSync(path.join(base, 'r2', 'token')), false);
    } finally {
      rmrf(base);
    }
  });
});
