// Remote configuration, token file and audit log: everything must fail closed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { load, rmrf, ROOT, tmpDir } from './helpers.js';
import { makeRemoteDir } from './remote-helpers.js';

const { loadRemoteConfig, RemoteConfigSource, DEFAULT_LIMITS, DEFAULT_JOB_LIMITS, DEFAULT_IDEMPOTENCY } = await load('remote/config.js');
const { BearerToken, tokenWeakness, generateToken, RemoteSetupError } = await load('remote/secrets.js');
const { AuditLog } = await load('remote/audit.js');
const { remoteToolNames, TERMINAL_TOOLS, JOB_TOOLS } = await load('remote/policy.js');

function withRemote(config, fn) {
  const r = makeRemoteDir({ port: 8765 });
  try {
    if (config) r.writeConfig(typeof config === 'function' ? config(r) : config);
    return fn(r);
  } finally {
    r.cleanup();
  }
}

function rejects(config, pattern) {
  withRemote(config, (r) => {
    assert.throws(() => loadRemoteConfig(r.dir), (err) => err instanceof RemoteSetupError && pattern.test(err.message));
  });
}

describe('remote config', () => {
  it('loads a minimal valid config with safe defaults', () => {
    withRemote(null, (r) => {
      const cfg = loadRemoteConfig(r.dir);
      assert.equal(cfg.host, '127.0.0.1');
      assert.equal(cfg.port, 8765);
      assert.deepEqual(cfg.roots, [r.work]);
      assert.equal(cfg.trustedTerminal, false);
      assert.deepEqual(cfg.allowedHosts, ['127.0.0.1:8765', 'localhost:8765']);
      assert.deepEqual(cfg.allowedOrigins, []);
      assert.deepEqual(cfg.limits, DEFAULT_LIMITS);
      assert.ok(cfg.blockedCommands.includes('sudo'));
      assert.equal(cfg.file, path.join(r.dir, 'remote.json'));
    });
  });

  it('is independent of the local config dir and never reads ~/.mcp-commander', () => {
    withRemote(null, (r) => {
      const cfg = loadRemoteConfig(r.dir);
      assert.ok(!cfg.file.includes(`${path.sep}.mcp-commander${path.sep}`));
    });
  });

  it('rejects unknown keys, a wrong schemaVersion and non-JSON', () => {
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], extra: true }), /unknown key "extra"/);
    rejects((r) => ({ schemaVersion: 2, roots: [r.work] }), /schemaVersion must be 1/);
    withRemote(null, (r) => {
      fs.writeFileSync(path.join(r.dir, 'remote.json'), '{ nope', { mode: 0o600 });
      assert.throws(() => loadRemoteConfig(r.dir), /not valid JSON/);
    });
  });

  it('only listens on loopback', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.2', 'localhost', 'example.com']) {
      rejects((r) => ({ schemaVersion: 1, host, roots: [r.work] }), /host must be "127.0.0.1" or "::1"/);
    }
  });

  it('requires explicit, narrow roots', () => {
    rejects(() => ({ schemaVersion: 1 }), /roots must be an array/);
    rejects(() => ({ schemaVersion: 1, roots: [] }), /at least one directory/);
    rejects(() => ({ schemaVersion: 1, roots: ['/'] }), /filesystem root|home directory/);
    rejects(() => ({ schemaVersion: 1, roots: [os.homedir()] }), /home directory/);
    rejects(() => ({ schemaVersion: 1, roots: ['relative/dir'] }), /absolute path/);
    rejects((r) => ({ schemaVersion: 1, roots: [path.join(r.work, 'missing')] }), /does not exist/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.dir] }), /overlaps protected location/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.base] }), /overlaps protected location/);
    rejects(() => ({ schemaVersion: 1, roots: [path.join(os.homedir(), 'Library', 'LaunchAgents')] }), /overlaps protected location|does not exist/);
  });

  it('refuses roots that would let file tools replace the code the service runs', () => {
    // This installation (dist/, scripts/, node_modules/) and anything inside or around it.
    rejects(() => ({ schemaVersion: 1, roots: [ROOT] }), /overlaps protected location/);
    rejects(() => ({ schemaVersion: 1, roots: [path.join(ROOT, 'dist')] }), /overlaps protected location/);
    rejects(() => ({ schemaVersion: 1, roots: [path.dirname(ROOT)] }), /overlaps protected location/);
    // Node's prefix (its binary and the libraries it loads), via the symlink and the real path.
    const prefix = path.dirname(path.dirname(process.execPath));
    rejects(() => ({ schemaVersion: 1, roots: [path.dirname(process.execPath)] }), /overlaps protected location|filesystem root/);
    rejects(() => ({ schemaVersion: 1, roots: [prefix] }), /overlaps protected location|filesystem root/);
    const realBin = path.dirname(fs.realpathSync(process.execPath));
    rejects(() => ({ schemaVersion: 1, roots: [realBin] }), /overlaps protected location/);
  });

  it('realpaths roots, so a symlinked root cannot hide a protected location', () => {
    withRemote(null, (r) => {
      const link = path.join(r.base, 'link-to-remote');
      fs.symlinkSync(r.dir, link);
      r.writeConfig({ schemaVersion: 1, roots: [link] });
      assert.throws(() => loadRemoteConfig(r.dir), /overlaps protected location/);
    });
  });

  it('rejects wildcard or malformed host/origin allowlists and non-boolean trustedTerminal', () => {
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], allowedOrigins: ['*'] }), /exact origin/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], allowedOrigins: ['null'] }), /exact origin/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], allowedOrigins: ['https://a.example/path'] }), /exact origin/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], allowedHosts: ['*'] }), /no wildcards/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], allowedHosts: [] }), /must not be empty/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], trustedTerminal: 'true' }), /trustedTerminal must be true or false/);
  });

  it('validates limits and audit bounds', () => {
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], limits: { maxBodyBytes: 10 } }), /limits.maxBodyBytes/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], limits: { bogus: 1 } }), /unknown limits key/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], limits: { headersTimeoutMs: 20000, requestTimeoutMs: 10000 } }), /headersTimeoutMs must not exceed/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], audit: { maxFiles: 0 } }), /audit.maxFiles/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], blockedCommands: 'sudo' }), /blockedCommands must be an array/);
  });

  it('defaults and validates the durable job and idempotency limits; state lives outside the roots', () => {
    withRemote(null, (r) => {
      const cfg = loadRemoteConfig(r.dir);
      assert.deepEqual(cfg.jobs, DEFAULT_JOB_LIMITS);
      assert.equal(cfg.jobs.maxConcurrent, 2);
      assert.equal(cfg.jobs.maxQueued, 32);
      assert.equal(cfg.jobs.maxLogBytes, 4 * 1024 * 1024);
      assert.deepEqual(cfg.idempotency, DEFAULT_IDEMPOTENCY);
      assert.equal(cfg.durableDir, path.join(r.dir, 'durable'));
      assert.ok(!cfg.roots.some((root) => cfg.durableDir.startsWith(root)));
    });
    withRemote((r) => ({ schemaVersion: 1, roots: [r.work], jobs: { maxConcurrent: 1, maxLogBytes: 8192 }, idempotency: { maxKeys: 5 } }), (r) => {
      const cfg = loadRemoteConfig(r.dir);
      assert.equal(cfg.jobs.maxConcurrent, 1);
      assert.equal(cfg.jobs.maxQueued, 32);
      assert.equal(cfg.jobs.maxLogBytes, 8192);
      assert.equal(cfg.idempotency.maxKeys, 5);
    });
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], jobs: { maxConcurrent: 0 } }), /jobs.maxConcurrent/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], jobs: { maxConcurrent: 1.5 } }), /jobs.maxConcurrent/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], jobs: { maxLogBytes: 1024 * 1024 * 1024 } }), /jobs.maxLogBytes/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], jobs: { autoRetry: true } }), /unknown jobs key/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], jobs: [] }), /jobs must be an object/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], idempotency: { maxKeys: '10' } }), /idempotency.maxKeys/);
    rejects((r) => ({ schemaVersion: 1, roots: [r.work], idempotency: { ttl: 1 } }), /unknown idempotency key/);
  });

  it('refuses a config dir or file readable by others, or a symlinked config', () => {
    withRemote(null, (r) => {
      fs.chmodSync(r.dir, 0o755);
      assert.throws(() => loadRemoteConfig(r.dir), /must be 0700/);
      fs.chmodSync(r.dir, 0o700);
      fs.chmodSync(path.join(r.dir, 'remote.json'), 0o644);
      assert.throws(() => loadRemoteConfig(r.dir), /must be 0600/);
      fs.chmodSync(path.join(r.dir, 'remote.json'), 0o600);
      const real = path.join(r.base, 'elsewhere.json');
      fs.renameSync(path.join(r.dir, 'remote.json'), real);
      fs.symlinkSync(real, path.join(r.dir, 'remote.json'));
      assert.throws(() => loadRemoteConfig(r.dir), /must not be a symbolic link/);
    });
  });

  it('exposes a read-only ConfigSource whose allowedDirectories are the roots', () => {
    withRemote(null, (r) => {
      const src = new RemoteConfigSource(loadRemoteConfig(r.dir));
      assert.deepEqual(src.getValue('allowedDirectories'), [r.work]);
      assert.equal(src.loadError, null);
      assert.throws(() => src.set('allowedDirectories', []), /read-only/);
      src.get().allowedDirectories.push('/');
      assert.deepEqual(src.getValue('allowedDirectories'), [r.work]);
    });
  });
});

describe('bearer token file', () => {
  it('accepts a generated token and compares in constant time via digests', () => {
    withRemote(null, (r) => {
      const t = BearerToken.fromFile(path.join(r.dir, 'token'));
      assert.equal(t.matches(r.token), true);
      assert.equal(t.matches(`${r.token}x`), false);
      assert.equal(t.matches(''), false);
      assert.equal(t.matchesHeader(`Bearer ${r.token}`), true);
      assert.equal(t.matchesHeader(`bearer ${r.token}`), true);
      assert.equal(t.matchesHeader(r.token), false);
      assert.equal(t.matchesHeader(`Basic ${r.token}`), false);
      assert.equal(t.matchesHeader(undefined), false);
      assert.equal(t.matchesHeader([`Bearer ${r.token}`]), false);
      assert.equal(JSON.stringify({ t }), '{"t":"[redacted]"}');
      assert.equal(String(t), '[redacted]');
    });
  });

  it('rejects weak tokens without echoing them', () => {
    assert.match(tokenWeakness('short'), /shorter than 43/);
    assert.match(tokenWeakness('a'.repeat(64)), /distinct characters/);
    assert.match(tokenWeakness(`${'Ab1'.repeat(20)}!`), /outside/);
    assert.equal(tokenWeakness(generateToken()), null);
    withRemote(null, (r) => {
      const weak = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      fs.writeFileSync(path.join(r.dir, 'token'), weak, { mode: 0o600 });
      assert.throws(
        () => BearerToken.fromFile(path.join(r.dir, 'token')),
        (err) => /not acceptable/.test(err.message) && !err.message.includes(weak),
      );
    });
  });

  it('rejects missing, group/other-readable, symlinked or oversized token files', () => {
    withRemote(null, (r) => {
      const file = path.join(r.dir, 'token');
      fs.chmodSync(file, 0o640);
      assert.throws(() => BearerToken.fromFile(file), /must be 0600/);
      fs.chmodSync(file, 0o600);
      const real = path.join(r.base, 'real-token');
      fs.renameSync(file, real);
      fs.symlinkSync(real, file);
      assert.throws(() => BearerToken.fromFile(file), /must not be a symbolic link/);
      fs.rmSync(file);
      assert.throws(() => BearerToken.fromFile(file), /missing or unreadable/);
      fs.writeFileSync(file, crypto.randomBytes(3000).toString('base64url'), { mode: 0o600 });
      assert.throws(() => BearerToken.fromFile(file), /larger than|longer than/);
    });
  });
});

describe('remote tool policy', () => {
  it('never includes set_config_value; terminal tools only when trusted', () => {
    assert.ok(!remoteToolNames(false).includes('set_config_value'));
    assert.ok(!remoteToolNames(true).includes('set_config_value'));
    for (const t of TERMINAL_TOOLS) {
      assert.ok(!remoteToolNames(false).includes(t), t);
      assert.ok(remoteToolNames(true).includes(t), t);
    }
  });

  it('counts 15 tools file-only and 27 trusted (terminal + job tools), each name once', () => {
    assert.equal(remoteToolNames(false).length, 15);
    assert.equal(remoteToolNames(true).length, 27);
    assert.equal(new Set(remoteToolNames(true)).size, 27);
    assert.deepEqual(JOB_TOOLS, ['job_start', 'job_status', 'job_list', 'job_logs', 'job_cancel']);
    for (const t of JOB_TOOLS) {
      assert.ok(!remoteToolNames(false).includes(t), t);
      assert.ok(remoteToolNames(true).includes(t), t);
    }
  });
});

describe('audit log', () => {
  it('stays bounded by rotation and records metadata only', () => {
    const dir = tmpDir('mcpc-audit-');
    try {
      const file = path.join(dir, 'logs', 'audit.jsonl');
      const log = new AuditLog(file, 16 * 1024, 3);
      for (let i = 0; i < 2000; i++) log.write({ event: 'tool', tool: 'read_file', status: 'ok', durationMs: i });
      const files = fs.readdirSync(path.dirname(file)).sort();
      assert.deepEqual(files, ['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2']);
      for (const f of files) assert.ok(fs.statSync(path.join(dir, 'logs', f)).size <= 16 * 1024);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());
      assert.deepEqual(Object.keys(last).sort(), ['durationMs', 'event', 'status', 'tool', 'ts']);
    } finally {
      rmrf(dir);
    }
  });
});
