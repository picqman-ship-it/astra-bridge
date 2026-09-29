// scripts/reliability-smoke.mjs: runs against temp config only and prints one machine-readable
// JSON report whose `ok` matches its exit status.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { it } from 'node:test';
import { ROOT } from './helpers.js';

it('reliability smoke passes with a JSON report and exit status 0, leaving no worker behind', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reliability-smoke.mjs')], { encoding: 'utf8', timeout: 180_000 });
  const report = JSON.parse(r.stdout);
  assert.equal(report.name, 'reliability-smoke');
  assert.equal(report.ok, true, r.stderr.slice(-2000));
  assert.equal(r.status, 0);
  assert.equal(report.failed, 0);
  assert.equal(report.passed, report.total);
  assert.ok(report.total >= 20);
  assert.ok(report.durationMs < 150_000);
  assert.ok(report.checks.every((c) => typeof c.name === 'string' && c.ok === true));
  assert.ok(report.checks.some((c) => c.name === 'no worker or server left running for the temp dir'));
});
