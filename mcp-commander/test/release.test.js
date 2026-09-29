// Snapshot packaging: manifest verifies, exclusions hold, and a leaked secret aborts the build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, rmrf, tmpDir } from './helpers.js';

const SCRIPT = path.join(ROOT, 'scripts', 'package-release.mjs');

function pack(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 });
}

describe('release snapshot', () => {
  it('packages the project with a verifiable SHA-256 manifest and no node_modules, secrets or logs', () => {
    const out = tmpDir('mcpc-release-');
    const remote = tmpDir('mcpc-release-remote-');
    try {
      const r = pack(['--out', out], { MCP_COMMANDER_REMOTE_DIR: remote });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /not Git history/);
      const archive = fs.readdirSync(out).find((f) => f.endsWith('.tar.gz'));
      assert.ok(archive);
      const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
      assert.match(archive, new RegExp(`^mcp-commander-${version.replace(/\./g, '\\.')}-\\d{8}T\\d{6}Z\\.tar\\.gz$`));

      const sum = spawnSync('shasum', ['-a', '256', '-c', `${archive}.sha256`], { cwd: out, encoding: 'utf8' });
      assert.equal(sum.status, 0, sum.stdout + sum.stderr);

      const x = spawnSync('tar', ['-xzf', archive], { cwd: out, encoding: 'utf8' });
      assert.equal(x.status, 0, x.stderr);
      const top = path.join(out, `mcp-commander-${version}`);
      const check = spawnSync('shasum', ['-a', '256', '-c', 'MANIFEST.sha256'], { cwd: top, encoding: 'utf8' });
      assert.equal(check.status, 0, check.stdout.slice(-500) + check.stderr);

      const listed = fs.readFileSync(path.join(top, 'MANIFEST.sha256'), 'utf8').trim().split('\n').map((l) => l.slice(66));
      assert.ok(listed.includes('dist/http.js') && listed.includes('src/remote/http-server.ts') && listed.includes('package-lock.json'));
      assert.ok(!listed.some((f) => f.startsWith('node_modules/') || f.startsWith('release/') || f.startsWith('.analysis/')));
      assert.ok(!listed.some((f) => /(^|\/)token$|remote\.json$|\.log$|\.jsonl$/.test(f)));
      assert.equal(fs.existsSync(path.join(top, 'node_modules')), false);
      const meta = JSON.parse(fs.readFileSync(path.join(top, 'SNAPSHOT.json'), 'utf8'));
      assert.equal(meta.version, version);
      assert.match(meta.kind, /not a Git commit/);
      assert.equal(fs.readdirSync(out).filter((f) => f.startsWith('.staging-')).length, 0);
    } finally {
      rmrf(out);
      rmrf(remote);
    }
  });

  function miniProject(extra) {
    const dir = tmpDir('mcpc-mini-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mini', version: '9.9.9' }));
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'version.js'), "export const VERSION = '9.9.9';\n");
    fs.mkdirSync(path.join(dir, 'docs'));
    for (const [rel, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, rel), content);
    return dir;
  }

  it('aborts when a file contains the live remote token, without printing it', () => {
    const token = crypto.randomBytes(32).toString('base64url');
    const remote = tmpDir('mcpc-release-remote-');
    fs.writeFileSync(path.join(remote, 'token'), `${token}\n`, { mode: 0o600 });
    const proj = miniProject({ 'docs/notes.md': `oops ${token}\n` });
    const out = tmpDir('mcpc-release-out-');
    try {
      const r = pack(['--project', proj, '--out', out], { MCP_COMMANDER_REMOTE_DIR: remote });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /docs\/notes\.md contains the live remote token/);
      assert.ok(!r.stderr.includes(token) && !r.stdout.includes(token));
      assert.deepEqual(fs.readdirSync(out), []);
    } finally {
      rmrf(remote);
      rmrf(proj);
      rmrf(out);
    }
  });

  it('never packages live job metadata, commands, job logs or idempotency results', () => {
    const remote = tmpDir('mcpc-release-remote-');
    const out = tmpDir('mcpc-release-out-');
    const proj = miniProject({ 'docs/keep.md': 'keep\n' });
    const id = 'j0mg1abcd0-0123456789abcdef';
    const put = (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
      fs.writeFileSync(path.join(proj, rel), content);
    };
    put(`docs/durable/jobs/${id}/job.json`, '{"command":"secret-cmd"}');
    put(`docs/durable/jobs/${id}/stdout.log`, 'job output');
    put(`docs/durable/idem/${'a'.repeat(64)}.json`, '{"result":"private"}');
    put('docs/durable/worker.json', '{}');
    put(`docs/copied/jobs/${id}/job.json`, '{}');
    put(`docs/copied/idem/${'b'.repeat(64)}.json`, '{}');
    put(`docs/copied/cancel.json`, '{}');
    try {
      const r = pack(['--project', proj, '--out', out], { MCP_COMMANDER_REMOTE_DIR: remote });
      assert.equal(r.status, 0, r.stderr);
      const archive = fs.readdirSync(out).find((f) => f.endsWith('.tar.gz'));
      const x = spawnSync('tar', ['-tzf', archive], { cwd: out, encoding: 'utf8' });
      const listed = x.stdout.trim().split('\n');
      assert.ok(listed.some((f) => f.endsWith('docs/keep.md')));
      for (const f of listed) assert.doesNotMatch(f, /durable|\/jobs\/j|\/idem\/|worker\.json|cancel\.json|job\.json|\.log$/, f);
    } finally {
      rmrf(remote);
      rmrf(proj);
      rmrf(out);
    }
  });

  it('aborts on private keys and refuses a stale dist/', () => {
    const remote = tmpDir('mcpc-release-remote-');
    const out = tmpDir('mcpc-release-out-');
    const key = ['-----BEGIN ', 'RSA PRIVATE KEY', '-----\nabc\n'].join('');
    const proj = miniProject({ 'docs/k.md': key });
    try {
      const r = pack(['--project', proj, '--out', out], { MCP_COMMANDER_REMOTE_DIR: remote });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /docs\/k\.md matches a secret pattern/);
      fs.rmSync(path.join(proj, 'docs', 'k.md'));
      fs.writeFileSync(path.join(proj, 'dist', 'version.js'), "export const VERSION = '1.0.0';\n");
      const stale = pack(['--project', proj, '--out', out], { MCP_COMMANDER_REMOTE_DIR: remote });
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /not built from version 9\.9\.9/);
    } finally {
      rmrf(remote);
      rmrf(proj);
      rmrf(out);
    }
  });
});
