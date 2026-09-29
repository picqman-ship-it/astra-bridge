#!/usr/bin/env node
import './bootstrap.js';
import fs from 'node:fs';
import { EX_CONFIG, parseRemoteArgs, rejectExtraArgs } from './remote/cli.js';
import { loadRemoteConfig } from './remote/config.js';
import { startRemoteHttpServer } from './remote/http-server.js';
import { BearerToken, RemoteSetupError } from './remote/secrets.js';
import { VERSION } from './version.js';

const LABEL = '[mcp-commander-remote]';
const USAGE =
  'mcp-commander-http — mcp-commander over Streamable HTTP on loopback, bearer-token protected\n\n' +
  'Usage: mcp-commander-http [--remote-dir <dir>]\n\n' +
  '  --remote-dir <dir>  owner-only directory with remote.json and token\n' +
  '                      (default ~/.mcp-commander-remote, or $MCP_COMMANDER_REMOTE_DIR)\n\n' +
  'Create it with: node dist/remote/setup.js --root <dir>\n';

/**
 * Under the LaunchAgent, stderr is a log file launchd opened for us and never rotates. Only
 * lifecycle lines go there, but keep it bounded across restarts anyway.
 */
function boundServiceLog(): void {
  if (process.env.MCP_COMMANDER_SERVICE !== '1') return;
  try {
    const st = fs.fstatSync(2);
    if (st.isFile() && st.size > 1024 * 1024) fs.ftruncateSync(2, 0);
  } catch {
    /* not a file: nothing to bound */
  }
}

async function main(): Promise<void> {
  const { remoteDir, rest } = parseRemoteArgs(process.argv.slice(2), USAGE);
  rejectExtraArgs(rest, USAGE);
  boundServiceLog();

  let cfg;
  let token;
  try {
    cfg = loadRemoteConfig(remoteDir);
    token = BearerToken.fromFile(cfg.tokenFile);
  } catch (err) {
    if (!(err instanceof RemoteSetupError)) throw err;
    console.error(`${LABEL} refusing to start: ${err.message}`);
    process.exit(EX_CONFIG);
  }

  const handle = await startRemoteHttpServer(cfg, token);
  handle.runtime.audit.write({ event: 'service_start' });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`${LABEL} ${signal}: stopping (interactive processes are terminated; durable jobs keep running in the job worker)`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await handle.close();
      handle.runtime.audit.write({ event: 'service_stop', reason: signal });
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGHUP', () => void stop('SIGHUP'));
  process.on('uncaughtException', (err) => console.error(`${LABEL} uncaught exception (${err.name})`));
  process.on('unhandledRejection', () => console.error(`${LABEL} unhandled rejection`));

  console.error(
    `${LABEL} ${VERSION} listening on ${handle.url} (roots: ${cfg.roots.length}, trustedTerminal: ${cfg.trustedTerminal})`,
  );
}

main().catch((err) => {
  const code = (err as NodeJS.ErrnoException)?.code;
  console.error(`${LABEL} fatal: ${code ?? (err instanceof Error ? err.name : 'error')}`);
  process.exit(1);
});
