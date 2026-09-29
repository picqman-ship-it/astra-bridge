#!/usr/bin/env node
// Repeatable snapshot packaging: a tar.gz of the working tree (source, compiled dist/, tests,
// scripts, docs, lockfile) plus a per-file SHA-256 manifest and a checksum for the archive.
//
// A snapshot is a copy of the files at one moment. It is NOT a Git commit and carries no history.
//
// Excluded: node_modules, release output, secrets (token files, remote.json, keys, .env), private
// run logs (*.log, *.jsonl), and any copy of the live durable state (durable/, job records,
// commands, job logs, idempotency results, worker state). Before packing, every file is scanned for the live remote token (if
// one exists; its value is never printed) and for private-key / API-key patterns; a hit aborts.
//
// Usage: node scripts/package-release.mjs [--out <dir>] [--project <dir>]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const project = path.resolve(argValue('--project') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const outDir = path.resolve(argValue('--out') ?? path.join(project, 'release'));

const INCLUDE = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', '.gitignore', 'src', 'native', 'test', 'scripts', 'docs', 'dist'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'release']);
const EXCLUDE = [
  /(^|\/)token$/, /(^|\/)remote\.json$/, /\.log$/, /\.jsonl(\.\d+)?$/, /(^|\/)\.env/, /\.(pem|key|p12)$/, /(^|\/)\.DS_Store$/, /\.tmp$/,
  // Live durable state (job records, commands, logs, idempotency results) never ships, wherever a copy ended up.
  /(^|\/)durable\//, /(^|\/)(jobs|jobkeys|idem|active)\/j?[0-9a-z]/, /(^|\/)(job|worker|cancel)\.json$/, /(^|\/)\.tmp-[0-9a-f]+$/,
];
const SECRET_PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/];

function fail(msg) {
  console.error(`[release] ${msg}`);
  process.exit(1);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
const version = pkg.version;
const distVersion = path.join(project, 'dist', 'version.js');
if (!fs.existsSync(distVersion) || !fs.readFileSync(distVersion, 'utf8').includes(`'${version}'`)) {
  fail(`dist/ is missing or not built from version ${version}; run npm run build first.`);
}

const files = [];
const excluded = [];
function walk(rel) {
  const abs = path.join(project, rel);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) return void excluded.push(`${rel} (symlink)`);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(rel))) return;
    for (const e of fs.readdirSync(abs).sort()) walk(path.join(rel, e));
    return;
  }
  if (!st.isFile()) return;
  if (EXCLUDE.some((re) => re.test(rel))) return void excluded.push(rel);
  files.push(rel);
}
for (const entry of INCLUDE) walk(entry);
if (!files.length) fail('nothing to package');

// Leak scan. The live token (if any) is compared, never printed.
const remoteDir = process.env.MCP_COMMANDER_REMOTE_DIR || path.join(os.homedir(), '.mcp-commander-remote');
let liveToken = null;
try {
  liveToken = fs.readFileSync(path.join(remoteDir, 'token'), 'utf8').trim() || null;
} catch {
  /* no token on this machine */
}
for (const rel of files) {
  const text = fs.readFileSync(path.join(project, rel), 'latin1');
  if (liveToken && text.includes(liveToken)) fail(`refusing to package: ${rel} contains the live remote token`);
  const hit = SECRET_PATTERNS.find((re) => re.test(text));
  if (hit) fail(`refusing to package: ${rel} matches a secret pattern (${hit.source.slice(0, 30)}…)`);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const name = `${pkg.name}-${version}`;
const archiveName = `${name}-${stamp}.tar.gz`;
fs.mkdirSync(outDir, { recursive: true });
const staging = fs.mkdtempSync(path.join(outDir, '.staging-'));
const top = path.join(staging, name);
try {
  const manifest = [];
  for (const rel of files) {
    const src = path.join(project, rel);
    const dst = path.join(top, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, fs.statSync(src).mode & 0o755);
    manifest.push(`${sha256(fs.readFileSync(src))}  ${rel.split(path.sep).join('/')}`);
  }
  fs.writeFileSync(path.join(top, 'MANIFEST.sha256'), manifest.join('\n') + '\n');
  fs.writeFileSync(
    path.join(top, 'SNAPSHOT.json'),
    JSON.stringify(
      {
        name: pkg.name,
        version,
        createdAt: new Date().toISOString(),
        kind: 'working-tree snapshot — not a Git commit, no history',
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        files: files.length,
        excluded,
        verify: 'shasum -a 256 -c MANIFEST.sha256',
        restore: 'see docs/remote-runbook.md, section "Snapshots and rollback"',
      },
      null,
      2,
    ) + '\n',
  );
  const archive = path.join(outDir, archiveName);
  const tar = spawnSync('tar', ['-czf', archive, '-C', staging, name], { env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8' });
  if (tar.status !== 0) fail(`tar failed: ${tar.stderr}`);
  const archiveSha = sha256(fs.readFileSync(archive));
  fs.writeFileSync(`${archive}.sha256`, `${archiveSha}  ${archiveName}\n`);
  console.log(`[release] ${archive}`);
  console.log(`[release] sha256 ${archiveSha}`);
  console.log(`[release] ${files.length} files, ${excluded.length} excluded; snapshot only (not Git history)`);
  console.log(`[release] verify: (cd ${outDir} && shasum -a 256 -c ${archiveName}.sha256)`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
