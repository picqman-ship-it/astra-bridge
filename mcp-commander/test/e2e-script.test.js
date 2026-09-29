// The Claude E2E script's own guarantees, checked with a fake `claude` binary (no model is
// invoked): default model, strict model verification from event metadata, no fallback flag,
// bounded overall timeout with process-group cleanup, and temp-dir cleanup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ROOT, rmrf, tmpDir, waitFor } from './helpers.js';
import { alive } from './remote-helpers.js';

const SCRIPT = path.join(ROOT, 'scripts', 'e2e-claude.mjs');

const FAKE = `// fake claude
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const dir = process.env.FAKE_CLAUDE_DIR;
fs.writeFileSync(dir + '/argv.json', JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_CLAUDE_MODE;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const model = mode === 'mismatch' ? 'claude-sonnet-5' : 'claude-opus-5-5';
if (mode === 'hang') {
  const g = spawn('sleep', ['1000'], { stdio: 'ignore' });
  fs.writeFileSync(dir + '/grandchild.pid', String(g.pid));
  setInterval(() => {}, 1000);
} else {
  if (mode !== 'none') emit({ type: 'system', subtype: 'init', model, mcp_servers: [], tools: [] });
  emit({ type: 'assistant', message: { ...(mode === 'none' ? {} : { model }), content: [{ type: 'text', text: 'hi' }] } });
  if (mode === 'mixed') emit({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', content: [] } });
  emit({ type: 'result', result: 'DIGEST=nope', ...(mode === 'none' ? {} : { modelUsage: { [mode === 'dated' ? model + '-20260901' : model]: {} } }) });
}
`;

describe('e2e-claude.mjs (fake claude, no model invoked)', () => {
  let dir;
  let bin;
  before(() => {
    dir = tmpDir('mcpc-fake-claude-');
    bin = path.join(dir, 'claude');
    // CommonJS body behind a sh launcher, independent of any package.json "type".
    fs.writeFileSync(path.join(dir, 'claude.cjs'), FAKE.split('\n').slice(1).join('\n'));
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'claude.cjs')}" "$@"\n`, { mode: 0o755 });
  });
  after(() => rmrf(dir));

  const run = (mode, extra = []) =>
    spawnSync(process.execPath, [SCRIPT, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_DIR: dir },
      timeout: 60_000,
    });
  const workdir = (out) => /\[e2e\] workdir=(\S+)/.exec(out)?.[1];

  it('defaults to claude-opus-5-5, passes no fallback model and confirms the model from metadata', () => {
    const r = run('match');
    const argv = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'));
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5-5');
    assert.ok(!argv.some((a) => /fallback/i.test(a)));
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    assert.deepEqual(settings.availableModels, ['claude-opus-5-5']);
    assert.equal(settings.switchModelsOnFlag, false);
    assert.match(r.stdout, /PASS {2}model confirmed in init event \(claude-opus-5-5\)/);
    assert.match(r.stdout, /PASS {2}every assistant message reports the requested model/);
    assert.match(r.stdout, /PASS {2}result modelUsage lists only the requested model/);
    // The fake does no real work, so the task checks fail and the run fails overall.
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(workdir(r.stdout)), false, 'temp workdir removed');
  });

  it('accepts a dated snapshot of the same model id', () => {
    const r = run('dated');
    assert.match(r.stdout, /PASS {2}result modelUsage lists only the requested model/);
  });

  it('fails on a different model', () => {
    const r = run('mismatch');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL {2}model confirmed in init event/);
    assert.match(r.stdout, /MODEL MISMATCH: claude-sonnet-5/);
  });

  it('fails when another model appears alongside the requested one', () => {
    const r = run('mixed');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL {2}every assistant message reports the requested model/);
    assert.match(r.stdout, /MODEL MISMATCH: claude-haiku-4-5-20251001/);
  });

  it('fails when no model metadata is returned', () => {
    const r = run('none');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL {2}model confirmed in init event/);
    assert.match(r.stdout, /FAIL {2}every assistant message reports the requested model/);
    assert.match(r.stdout, /FAIL {2}result modelUsage lists only the requested model/);
  });

  it('enforces the overall timeout and kills the whole process group', async () => {
    const started = Date.now();
    const r = run('hang', ['--timeout-ms', '1500']);
    assert.equal(r.status, 1);
    assert.ok(Date.now() - started < 30_000);
    assert.match(r.stdout, /overall timeout \(1500 ms\)/);
    assert.match(r.stdout, /FAIL {2}finished within the overall timeout/);
    const gpid = Number(fs.readFileSync(path.join(dir, 'grandchild.pid'), 'utf8'));
    await waitFor(() => !alive(gpid), { timeout: 10_000 });
    assert.equal(fs.existsSync(workdir(r.stdout)), false);
  });
});
