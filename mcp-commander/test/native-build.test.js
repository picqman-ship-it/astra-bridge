import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { nativeFingerprint } from '../scripts/native-fingerprint.mjs';
import { ROOT, tmpDir, rmrf } from './helpers.js';

test('native build executes again for source, recipe or architecture changes and pins its target', { skip: process.platform !== 'darwin' }, (t) => {
  const root = tmpDir('mcpc-native-build-');
  t.after(() => rmrf(root));
  for (const d of ['bin', 'scripts', 'native', 'home']) fs.mkdirSync(path.join(root, d));
  for (const name of ['build-native.mjs', 'native-fingerprint.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  const source = path.join(root, 'native', 'ax-helper.swift');
  fs.writeFileSync(source, '// fake native source');
  const compiler = path.join(root, 'bin', 'swiftc');
  const log = path.join(root, 'compile.log');
  fs.writeFileSync(path.join(root, 'bin', 'xcrun'), `#!/bin/sh
if [ "$FAKE_NO_SWIFT" = 1 ]; then exit 1; fi
case "$1" in
  --find) printf '%s\\n' "$FAKE_SWIFTC" ;;
  --show-sdk-path) printf '/fake/sdk\\n' ;;
  --show-sdk-version) printf '14\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(compiler, `#!/bin/sh
if [ "$1" = '--version' ]; then printf 'Swift test\\n'; exit 0; fi
printf '%s\\n' "$*" >> "$FAKE_COMPILE_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; printf 'fake binary\\n' > "$1"; exit 0; fi
  shift
done
exit 1
`, { mode: 0o755 });
  const env = { PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`, HOME: path.join(root, 'home'),
    FAKE_SWIFTC: compiler, FAKE_COMPILE_LOG: log, MACOSX_DEPLOYMENT_TARGET: '12.0' };
  const build = () => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-native.mjs')], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(log, 'utf8').trim().split('\n');
  };
  assert.equal(build().length, 1);
  assert.equal(build().length, 1, 'identical inputs reuse the binary');
  fs.appendFileSync(source, '\n// native-only change');
  assert.equal(build().length, 2, 'native-only edit recompiles');
  fs.appendFileSync(path.join(root, 'scripts', 'build-native.mjs'), '\n// recipe change\n');
  assert.equal(build().length, 3, 'build recipe edit recompiles');
  const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  const flags = ['-O', '-target', `${otherArch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx12.0`, '-sdk', '/fake/sdk', '-framework', 'ApplicationServices', '-framework', 'AppKit'];
  const recipe = Buffer.concat(['build-native.mjs', 'native-fingerprint.mjs'].map((f) => fs.readFileSync(path.join(root, 'scripts', f))));
  const previous = nativeFingerprint({ source: fs.readFileSync(source), recipe, compiler, version: 'Swift test\n', sdk: '/fake/sdk', sdkVersion: '14\n', flags, arch: otherArch });
  fs.writeFileSync(path.join(root, 'dist', 'native', 'mcp-commander-ax.sha256'), `${previous}\n`);
  const rebuilt = build();
  assert.equal(rebuilt.length, 4, 'a binary cached for another CPU must be rebuilt');
  const target = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  assert.ok(rebuilt.every((line) => line.includes(`-target ${target}-apple-macosx12.0`)));
  env.FAKE_NO_SWIFT = '1';
  assert.equal(build().length, 4, 'missing compiler cannot claim a fresh helper');
  assert.equal(fs.existsSync(path.join(root, 'dist', 'native', 'mcp-commander-ax')), false);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'native', 'mcp-commander-ax.sha256')), false);
});
