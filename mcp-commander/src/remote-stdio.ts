#!/usr/bin/env node
import './bootstrap.js';
import { EX_CONFIG, parseRemoteArgs, rejectExtraArgs } from './remote/cli.js';
import { loadRemoteConfig } from './remote/config.js';
import { RemoteRuntime } from './remote/runtime.js';
import { RemoteSetupError } from './remote/secrets.js';
import { serveStdio } from './stdio-lifecycle.js';
import { VERSION } from './version.js';

const LABEL = 'mcp-commander-remote-stdio';
const USAGE =
  'mcp-commander-remote-stdio — the remote tool policy (roots, no config edits, terminal only in\n' +
  'trusted-terminal mode) over stdio, for an outbound tunnel client that spawns MCP servers.\n\n' +
  'Usage: mcp-commander-remote-stdio [--remote-dir <dir>]\n\n' +
  'Authentication is the spawning tunnel client\'s job; this process has no network listener.\n';

async function main(): Promise<void> {
  const { remoteDir, rest } = parseRemoteArgs(process.argv.slice(2), USAGE);
  rejectExtraArgs(rest, USAGE);
  let cfg;
  try {
    cfg = loadRemoteConfig(remoteDir);
  } catch (err) {
    if (!(err instanceof RemoteSetupError)) throw err;
    console.error(`[${LABEL}] refusing to start: ${err.message}`);
    process.exit(EX_CONFIG);
  }
  const runtime = new RemoteRuntime(cfg);
  const commander = runtime.createServer(() => 'stdio');
  await serveStdio(
    { server: commander.server, shutdown: () => runtime.shutdown(), drain: (ms) => commander.drain(ms) },
    LABEL,
    `${VERSION} ready (roots: ${cfg.roots.length}, trustedTerminal: ${cfg.trustedTerminal})`,
  );
}

main().catch((err) => {
  console.error(`[${LABEL}] fatal: ${err instanceof Error ? err.name : 'error'}`);
  process.exit(1);
});
