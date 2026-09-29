import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * macOS user LaunchAgent for the HTTP entrypoint (gui/<uid> domain: runs while the owner is
 * logged in, no sudo). Nothing here runs unless the operator calls install/uninstall.
 */

export const LABEL = 'local.mcp-commander.remote';

export interface PlistOptions {
  label?: string;
  nodePath: string;
  entry: string;
  remoteDir: string;
  logFile: string;
  /** PATH for the service and every process it starts. */
  pathEnv: string;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function defaultPathEnv(nodePath: string): string {
  const dirs = [path.dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(dirs)].join(':');
}

export function buildPlist(o: PlistOptions): string {
  for (const [k, v] of Object.entries({ nodePath: o.nodePath, entry: o.entry, remoteDir: o.remoteDir, logFile: o.logFile })) {
    if (!path.isAbsolute(v)) throw new Error(`${k} must be an absolute path: ${v}`);
  }
  const env: Record<string, string> = {
    PATH: o.pathEnv,
    MCP_COMMANDER_REMOTE_DIR: o.remoteDir,
    MCP_COMMANDER_SERVICE: '1',
    LANG: 'en_US.UTF-8',
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(o.label ?? LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(o.nodePath)}</string>
      <string>${xml(o.entry)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(o.remoteDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ExitTimeOut</key>
    <integer>20</integer>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>${xml(o.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(o.logFile)}</string>
  </dict>
</plist>
`;
}

export interface LaunchctlEnv {
  /** launchctl binary; tests point this at a fake. */
  launchctl: string;
  agentsDir: string;
  uid: number;
  label: string;
}

export function launchctlEnv(agentsDirOverride?: string): LaunchctlEnv {
  const fake = process.env.MCP_COMMANDER_LAUNCHCTL;
  const agentsDir = agentsDirOverride ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
  // A test directory with the real launchctl would register a real service from a temp path.
  if (agentsDirOverride && !fake) throw new Error('--launch-agents-dir requires MCP_COMMANDER_LAUNCHCTL (test mode only).');
  return { launchctl: fake || '/bin/launchctl', agentsDir, uid: process.getuid?.() ?? 0, label: LABEL };
}

export function plistPath(env: LaunchctlEnv): string {
  return path.join(env.agentsDir, `${env.label}.plist`);
}

function run(env: LaunchctlEnv, args: string[]): { code: number; out: string } {
  const r = spawnSync(env.launchctl, args, { encoding: 'utf8', timeout: 20_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export interface ServiceState {
  loaded: boolean;
  state?: string;
  pid?: number;
  lastExitCode?: string;
}

export function serviceState(env: LaunchctlEnv): ServiceState {
  const r = run(env, ['print', `gui/${env.uid}/${env.label}`]);
  if (r.code !== 0) return { loaded: false };
  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(r.out)?.[1].trim();
  const pid = Number(field('pid'));
  return {
    loaded: true,
    state: field('state'),
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    lastExitCode: field('last exit code'),
  };
}

async function waitUnloaded(env: LaunchctlEnv, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!serviceState(env).loaded) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !serviceState(env).loaded;
}

/** Writes the plist and (re)loads it. Idempotent: an already loaded agent is stopped gracefully first. */
export async function install(env: LaunchctlEnv, plist: string): Promise<string[]> {
  const log: string[] = [];
  fs.mkdirSync(env.agentsDir, { recursive: true });
  const file = plistPath(env);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, plist, { mode: 0o644 });
  fs.chmodSync(tmp, 0o644); // independent of umask; launchd refuses group/world-writable plists
  fs.renameSync(tmp, file);
  log.push(previous === null ? `wrote ${file}` : previous === plist ? `unchanged ${file}` : `updated ${file}`);

  if (serviceState(env).loaded) {
    // bootout sends SIGTERM and waits up to ExitTimeOut before SIGKILL: owned processes are stopped.
    const r = run(env, ['bootout', `gui/${env.uid}/${env.label}`]);
    log.push(`bootout: exit ${r.code}`);
    if (!(await waitUnloaded(env, 30_000))) throw new Error('the previous service instance did not stop within 30s');
  }
  run(env, ['enable', `gui/${env.uid}/${env.label}`]);
  const r = run(env, ['bootstrap', `gui/${env.uid}`, file]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed (exit ${r.code}): ${r.out.trim().slice(0, 300)}`);
  log.push('bootstrap: ok');
  return log;
}

export async function uninstall(env: LaunchctlEnv): Promise<string[]> {
  const log: string[] = [];
  if (serviceState(env).loaded) {
    const r = run(env, ['bootout', `gui/${env.uid}/${env.label}`]);
    log.push(`bootout: exit ${r.code}`);
    if (!(await waitUnloaded(env, 30_000))) throw new Error('the service did not stop within 30s');
  } else {
    log.push('not loaded');
  }
  const file = plistPath(env);
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    log.push(`removed ${file}`);
  } else {
    log.push('no plist');
  }
  return log;
}

/** True when `launchctl` is the real one and this is macOS (install refuses otherwise). */
export function launchdAvailable(env: LaunchctlEnv): boolean {
  if (env.launchctl !== '/bin/launchctl') return true;
  return process.platform === 'darwin' && fs.existsSync('/bin/launchctl');
}
