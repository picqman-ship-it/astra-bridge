#!/usr/bin/env node
// Compiles the macOS Accessibility helper (native/ax-helper.swift -> dist/native/mcp-commander-ax).
//
// Runs as the last step of `npm run build`. Not macOS: nothing to do. No Swift compiler (Xcode
// Command Line Tools missing): a warning, and the GUI tools report that the helper is missing; the
// rest of the server is unaffected. A compile error in the source fails the build.
// The binary is rebuilt only when the source (or compiler) changed; a .sha256 stamp records that.
import { spawnSync } from 'node:child_process';
import { nativeFingerprint } from './native-fingerprint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native', 'ax-helper.swift');
const outDir = path.join(root, 'dist', 'native');
const out = path.join(outDir, 'mcp-commander-ax');
const stamp = `${out}.sha256`;
const log = (msg) => process.stderr.write(`[build-native] ${msg}\n`);

if (process.platform !== 'darwin') {
  log(`skipped: the GUI helper is macOS-only (platform ${process.platform})`);
  process.exit(0);
}

const swiftc = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
const compiler = swiftc.status === 0 ? swiftc.stdout.trim() : null;
if (!compiler) {
  // Never leave a binary from an older source/toolchain/CPU looking current.
  fs.rmSync(out, { force: true });
  fs.rmSync(stamp, { force: true });
  log('WARNING: swiftc not found (install the Xcode Command Line Tools: xcode-select --install). GUI tools will report the helper as missing.');
  process.exit(0);
}
// The Command Line Tools' swiftc does not always find its SDK on its own ("unable to load standard library").
const sdkRes = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
const sdk = sdkRes.status === 0 ? sdkRes.stdout.trim() : '';
const version = spawnSync(compiler, ['--version'], { encoding: 'utf8' }).stdout ?? '';
const sdkVersion = spawnSync('xcrun', ['--show-sdk-version'], { encoding: 'utf8' }).stdout ?? '';
const targetArch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
if (!targetArch) throw new Error(`unsupported native architecture: ${process.arch}`);
const flags = ['-O', '-target', `${targetArch}-apple-macosx${process.env.MACOSX_DEPLOYMENT_TARGET || '12.0'}`,
  ...(sdk ? ['-sdk', sdk] : []), '-framework', 'ApplicationServices', '-framework', 'AppKit'];
const hash = nativeFingerprint({ source: fs.readFileSync(source),
  recipe: Buffer.concat([fs.readFileSync(fileURLToPath(import.meta.url)), fs.readFileSync(new URL('./native-fingerprint.mjs', import.meta.url))]),
  compiler, version, sdk, sdkVersion, flags });

if (fs.existsSync(out) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === hash) {
  log('up to date');
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
const tmp = `${out}.${process.pid}.tmp`;
const res = spawnSync(compiler, [...flags, '-o', tmp, source], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
if (res.status !== 0) {
  fs.rmSync(tmp, { force: true });
  log(`FAILED: swiftc exited with ${res.status ?? res.signal}`);
  process.exit(1);
}
fs.chmodSync(tmp, 0o755);
fs.renameSync(tmp, out);
fs.writeFileSync(stamp, `${hash}\n`);
log(`built ${path.relative(root, out)}`);
