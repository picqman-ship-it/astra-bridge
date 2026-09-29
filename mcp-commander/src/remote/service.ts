#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EX_CONFIG, parseRemoteArgs } from './cli.js';
import { loadRemoteConfig, type RemoteConfig } from './config.js';
import { buildPlist, defaultPathEnv, install, launchctlEnv, launchdAvailable, plistPath, serviceState, uninstall, type LaunchctlEnv } from './launchagent.js';
import { probeHealth } from './probe.js';
import { BearerToken, RemoteSetupError } from './secrets.js';

const USAGE =
  'Usage: node dist/remote/service.js <install|status|uninstall|print> [--remote-dir <dir>]\n\n' +
  '  install    validate the remote config, write ~/Library/LaunchAgents/local.mcp-commander.remote.plist\n' +
  '             and (re)load it (idempotent; a running instance is stopped gracefully first)\n' +
  '  status     plist, launchd state and /healthz\n' +
  '  uninstall  stop the agent (its processes are terminated) and remove the plist; config and token stay\n' +
  '  print      show the plist install would write (no changes)\n';

const here = path.dirname(fileURLToPath(import.meta.url));
const HTTP_ENTRY = path.resolve(here, '..', 'http.js');

function expectedPlist(cfg: RemoteConfig): string {
  return buildPlist({
    nodePath: process.execPath,
    entry: HTTP_ENTRY,
    remoteDir: cfg.dir,
    logFile: path.join(cfg.logDir, 'service.log'),
    pathEnv: defaultPathEnv(process.execPath),
  });
}

function loadValidated(remoteDir: string): RemoteConfig {
  const cfg = loadRemoteConfig(remoteDir);
  BearerToken.fromFile(cfg.tokenFile);
  return cfg;
}

async function waitHealthy(cfg: RemoteConfig, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const h = await probeHealth(cfg, 1000);
    if (h.reachable && h.status === 200) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function status(env: LaunchctlEnv, remoteDir: string): Promise<number> {
  const file = plistPath(env);
  const present = fs.existsSync(file);
  console.log(`plist: ${present ? file : 'not installed'}`);
  let cfg: RemoteConfig | undefined;
  try {
    cfg = loadRemoteConfig(remoteDir);
  } catch (err) {
    console.log(`config: INVALID — ${(err as Error).message}`);
  }
  if (present && cfg) console.log(`plist matches this build: ${fs.readFileSync(file, 'utf8') === expectedPlist(cfg) ? 'yes' : 'no (re-run install)'}`);
  const st = serviceState(env);
  console.log(`launchd: ${st.loaded ? `loaded, state=${st.state ?? '?'}${st.pid ? `, pid=${st.pid}` : ''}, last exit=${st.lastExitCode ?? '?'}` : 'not loaded'}`);
  if (cfg) {
    const h = await probeHealth(cfg);
    console.log(`health: ${h.reachable ? `HTTP ${h.status}` : 'not reachable'}`);
    return st.loaded && h.status === 200 ? 0 : 1;
  }
  return 1;
}

async function main(): Promise<number> {
  const { remoteDir, rest } = parseRemoteArgs(process.argv.slice(2), USAGE);
  let agentsDir: string | undefined;
  const cmds: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--launch-agents-dir') agentsDir = rest[++i];
    else cmds.push(rest[i]);
  }
  const cmd = cmds[0];
  if (cmds.length !== 1 || !['install', 'status', 'uninstall', 'print'].includes(cmd)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const env = launchctlEnv(agentsDir);

  if (cmd === 'print') {
    process.stdout.write(expectedPlist(loadValidated(remoteDir)));
    return 0;
  }
  if (cmd === 'status') return status(env, remoteDir);
  if (!launchdAvailable(env)) {
    console.error('launchd is not available (macOS only).');
    return 1;
  }
  if (cmd === 'uninstall') {
    for (const line of await uninstall(env)) console.log(line);
    console.log('Config, token and logs were left in place.');
    return 0;
  }
  // install
  const cfg = loadValidated(remoteDir);
  if (!fs.existsSync(HTTP_ENTRY)) {
    console.error(`${HTTP_ENTRY} is missing; run npm run build first.`);
    return 1;
  }
  for (const line of await install(env, expectedPlist(cfg))) console.log(line);
  const healthy = await waitHealthy(cfg, 15_000);
  console.log(healthy ? `service healthy on http://${cfg.host}:${cfg.port}/healthz` : 'service did not become healthy within 15s; see npm run remote:doctor');
  return healthy ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof RemoteSetupError) {
      console.error(`Refusing: ${err.message}`);
      process.exit(EX_CONFIG);
    }
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
