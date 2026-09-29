// One version everywhere: package.json, package-lock.json, src/version.ts and the compiled build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { load, ROOT } from './helpers.js';

it('package.json, package-lock.json, source and build agree on the version', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const src = /VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'src', 'version.ts'), 'utf8'))?.[1];
  const { VERSION } = await load('version.js');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(src, pkg.version);
  assert.equal(VERSION, pkg.version);
  assert.deepEqual(lock.packages[''].bin, pkg.bin);
});
