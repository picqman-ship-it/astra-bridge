#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BLOCKED_COMMANDS, defaultShell } from '../config.js';
import { EX_CONFIG, parseRemoteArgs } from './cli.js';
import { DEFAULT_PORT, loadRemoteConfig, parseRemoteConfig, remotePaths } from './config.js';
import { assertPrivateDir, BearerToken, generateToken, RemoteSetupError, tokenWeakness } from './secrets.js';

/**
 * Creates (or checks) the remote configuration directory:
 *   <remote-dir>/          0700
 *   <remote-dir>/token     0600  random 256-bit bearer token, never printed
 *   <remote-dir>/remote.json 0600
 *   <remote-dir>/logs/     0700
 * Idempotent: an existing valid token and remote.json are kept unless asked otherwise.
 */

const USAGE =
  'Usage: node dist/remote/setup.js [--remote-dir <dir>] --root <dir> [--root <dir> ...]\n' +
  '                                 [--protect <dir> ...] [--port <n>] [--trusted-terminal] [--trusted-gui]\n' +
  '                                 [--rotate-token] [--replace-config]\n\n' +
  '  --root <dir>         directory the remote file/search tools may use (repeatable; required for a new config)\n' +
  '  --protect <dir>      extra location no root may be, contain or sit inside, e.g. the code of a program\n' +
  '                       that runs this server (repeatable; written to remote.json "protectedPaths")\n' +
  `  --port <n>           loopback port (default ${DEFAULT_PORT})\n` +
  '  --trusted-terminal   also expose shell/process tools (arbitrary code execution as you)\n' +
  '  --trusted-gui        also expose the macOS GUI tools (read and operate app windows; needs Accessibility)\n' +
  '  --rotate-token       replace the existing token (clients must be given the new one)\n' +
  '  --replace-config     overwrite an existing remote.json\n';

function ensurePrivateDir(dir: string, label: string): void {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else if (st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) && st.uid === process.getuid?.()) {
    fs.chmodSync(dir, 0o700);
  }
  assertPrivateDir(dir, label);
}

/** Writes via an exclusive 0600 temp file + rename, so no reader ever sees a partial or wider file. */
function writePrivate(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function tokenIsUsable(file: string): boolean {
  try {
    BearerToken.fromFile(file);
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  process.umask(0o077);
  const { remoteDir, rest } = parseRemoteArgs(process.argv.slice(2), USAGE);
  const roots: string[] = [];
  const protect: string[] = [];
  let port = DEFAULT_PORT;
  let trusted = false;
  let gui = false;
  let rotate = false;
  let replace = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--root') roots.push(path.resolve(rest[++i] ?? ''));
    else if (a === '--protect') protect.push(path.resolve(rest[++i] ?? ''));
    else if (a === '--port') port = Number(rest[++i]);
    else if (a === '--trusted-terminal') trusted = true;
    else if (a === '--trusted-gui') gui = true;
    else if (a === '--rotate-token') rotate = true;
    else if (a === '--replace-config') replace = true;
    else {
      process.stderr.write(`Unknown argument: ${a}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('--port must be an integer between 1 and 65535\n');
    process.exit(2);
  }

  const p = remotePaths(remoteDir);
  ensurePrivateDir(p.dir, 'Remote config directory');
  ensurePrivateDir(p.logDir, 'Log directory');

  const configExists = fs.existsSync(p.file);
  let configAction = 'kept existing';
  if (!configExists || replace) {
    if (!roots.length) {
      process.stderr.write(`No remote.json yet: pass at least one --root <dir>.\n\n${USAGE}`);
      process.exit(2);
    }
    const cfg = {
      schemaVersion: 1,
      host: '127.0.0.1',
      port,
      roots,
      trustedTerminal: trusted,
      trustedGui: gui,
      allowedOrigins: [],
      blockedCommands: DEFAULT_BLOCKED_COMMANDS,
      defaultShell: defaultShell(),
      ...(protect.length ? { protectedPaths: protect } : {}),
    };
    const text = JSON.stringify(cfg, null, 2) + '\n';
    parseRemoteConfig(text, p.dir); // refuse before writing anything the server would reject
    writePrivate(p.file, text);
    configAction = configExists ? 'replaced' : 'created';
  } else if (roots.length || trusted || gui || protect.length) {
    process.stderr.write('remote.json exists and was not changed (use --replace-config to rewrite it).\n');
  }

  const tokenExists = fs.existsSync(p.tokenFile);
  let tokenAction = 'kept existing';
  if (rotate || !tokenExists || !tokenIsUsable(p.tokenFile)) {
    const token = generateToken();
    if (tokenWeakness(token)) throw new Error('generated token failed validation'); // cannot happen with 32 random bytes
    writePrivate(p.tokenFile, `${token}\n`);
    tokenAction = tokenExists ? 'replaced' : 'created';
  }

  // Validate exactly what the server will load.
  const loaded = loadRemoteConfig(p.dir);
  BearerToken.fromFile(loaded.tokenFile);
  process.stdout.write(
    [
      `Remote config directory: ${p.dir} (0700)`,
      `Token file: ${p.tokenFile} (0600, ${tokenAction}; value not shown)`,
      `Config: ${p.file} (0600, ${configAction})`,
      `Listen: http://${loaded.host}:${loaded.port}/mcp`,
      `Roots: ${loaded.roots.join(', ')}`,
      `Trusted terminal: ${loaded.trustedTerminal ? 'ON — shell/process tools exposed' : 'off'}`,
      `Trusted GUI: ${loaded.trustedGui ? 'ON — app-window tools exposed (grant Accessibility to Node when macOS asks)' : 'off'}`,
      'Next: npm run remote:doctor',
      '',
    ].join('\n'),
  );
}

try {
  main();
} catch (err) {
  if (err instanceof RemoteSetupError) {
    process.stderr.write(`Setup failed: ${err.message}\n`);
    process.exit(EX_CONFIG);
  }
  process.stderr.write(`Setup failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}\n`);
  process.exit(1);
}
