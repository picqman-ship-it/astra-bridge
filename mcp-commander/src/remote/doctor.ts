#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { parseRemoteArgs } from './cli.js';
import { loadRemoteConfig, type RemoteConfig } from './config.js';
import { JobStore } from './jobs.js';
import { launchctlEnv, plistPath, serviceState } from './launchagent.js';
import { remoteToolNames } from './policy.js';
import { probeHealth, probeMcp } from './probe.js';
import { BearerToken } from './secrets.js';

/**
 * Read-only diagnosis of the remote setup: build version, config, token file, audit log,
 * LaunchAgent state, health and an authenticated MCP handshake with the running server.
 * Changes nothing except opening (and deleting) one MCP session on a running server.
 */

type Level = 'pass' | 'warn' | 'fail';
interface Check {
  name: string;
  level: Level;
  detail: string;
}

const USAGE = 'Usage: node dist/remote/doctor.js [--remote-dir <dir>] [--json]\n';
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return newest;
}

function buildChecks(checks: Check[]): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string };
  checks.push({
    name: 'build version',
    level: pkg.version === VERSION ? 'pass' : 'fail',
    detail: `package.json ${pkg.version}, compiled ${VERSION}`,
  });
  const srcVersion = path.join(projectRoot, 'src', 'version.ts');
  if (fs.existsSync(srcVersion)) {
    const m = /VERSION = '([^']+)'/.exec(fs.readFileSync(srcVersion, 'utf8'));
    if (m && m[1] !== VERSION) checks.push({ name: 'source version', level: 'fail', detail: `src/version.ts ${m[1]} differs from compiled ${VERSION}; run npm run build` });
  }
  const distHttp = path.join(projectRoot, 'dist', 'http.js');
  const srcNewest = newestMtime(path.join(projectRoot, 'src'));
  const distTime = fs.existsSync(distHttp) ? fs.statSync(distHttp).mtimeMs : 0;
  checks.push({
    name: 'compiled output',
    level: distTime === 0 ? 'fail' : srcNewest > distTime + 1000 ? 'warn' : 'pass',
    detail: distTime === 0 ? 'dist/http.js missing; run npm run build' : srcNewest > distTime + 1000 ? 'src/ is newer than dist/; run npm run build' : 'dist/ is up to date with src/',
  });
  checks.push({ name: 'node', level: 'pass', detail: `${process.execPath} ${process.version}` });
}

/** Read-only look at the private job/idempotency state. Creates nothing. */
function durableChecks(cfg: RemoteConfig, checks: Check[]): void {
  const dir = cfg.durableDir;
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) {
    checks.push({ name: 'durable state', level: 'pass', detail: `${dir} not created yet (no jobs or idempotency keys used)` });
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0) {
    checks.push({ name: 'durable state', level: 'fail', detail: `${dir} must be a real 0700 directory; job and idempotency calls fail closed until fixed` });
    return;
  }
  const count = (sub: string, re: RegExp) => {
    try {
      return fs.readdirSync(path.join(dir, sub)).filter((f) => re.test(f)).length;
    } catch {
      return 0;
    }
  };
  const jobs = count('jobs', /^j[0-9a-z]+-[0-9a-f]{16}$/);
  const active = count('active', /^j[0-9a-z]+-[0-9a-f]{16}$/);
  const keys = count('idem', /\.json$/);
  const jobKeys = count('jobkeys', /\.json$/);
  const store = new JobStore(cfg);
  const health = store.workerHealth();
  const full = jobs >= cfg.jobs.maxJobRecords || keys >= cfg.idempotency.maxKeys;
  checks.push({
    name: 'durable state',
    level: full ? 'warn' : 'pass',
    detail:
      `${jobs}/${cfg.jobs.maxJobRecords} job records (${active} unfinished), ${jobKeys} job keys, ${keys}/${cfg.idempotency.maxKeys} idempotency keys` +
      (full ? ' — a store is full: new jobs/keys are refused until the owner archives old records' : ''),
  });
  checks.push({
    name: 'job worker',
    level: health.state === 'unresponsive' || (active > 0 && health.state !== 'running') ? 'warn' : 'pass',
    detail:
      health.state === 'absent'
        ? `not running${active ? ` with ${active} unfinished job(s); the next job call or server start launches it` : ' (started on demand)'}`
        : `${health.state}, pid ${health.pid}, heartbeat ${Math.round(health.heartbeatAgeMs / 1000)}s ago`,
  });
}

async function main(): Promise<number> {
  const { remoteDir, rest } = parseRemoteArgs(process.argv.slice(2), USAGE);
  const json = rest.includes('--json');
  const agentsIdx = rest.indexOf('--launch-agents-dir');
  const agentsDir = agentsIdx === -1 ? undefined : rest[agentsIdx + 1];
  const checks: Check[] = [];
  buildChecks(checks);

  let cfg: RemoteConfig | undefined;
  try {
    cfg = loadRemoteConfig(remoteDir);
    checks.push({
      name: 'remote config',
      level: 'pass',
      detail: `${cfg.file}: ${cfg.host}:${cfg.port}, ${cfg.roots.length} root(s), trustedTerminal=${cfg.trustedTerminal}, trustedGui=${cfg.trustedGui}`,
    });
  } catch (err) {
    checks.push({ name: 'remote config', level: 'fail', detail: (err as Error).message });
  }

  let tokenOk = false;
  if (cfg) {
    try {
      BearerToken.fromFile(cfg.tokenFile);
      tokenOk = true;
      checks.push({ name: 'token file', level: 'pass', detail: `${cfg.tokenFile}: owner-only, strong (value not shown)` });
    } catch (err) {
      checks.push({ name: 'token file', level: 'fail', detail: (err as Error).message });
    }
    const files = [cfg.auditFile, ...[1, 2, 3, 4, 5].map((i) => `${cfg!.auditFile}.${i}`)].filter((f) => fs.existsSync(f));
    const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    checks.push({ name: 'audit log', level: 'pass', detail: `${files.length} file(s), ${bytes} bytes (cap ${cfg.audit.maxBytes} x ${cfg.audit.maxFiles})` });
    durableChecks(cfg, checks);
  }

  let installed = false;
  try {
    const env = launchctlEnv(agentsDir);
    installed = fs.existsSync(plistPath(env));
    const st = serviceState(env);
    checks.push({
      name: 'launch agent',
      level: installed && !st.loaded ? 'fail' : installed ? 'pass' : 'warn',
      detail: installed
        ? `${plistPath(env)}; ${st.loaded ? `loaded, state=${st.state ?? '?'}${st.pid ? `, pid=${st.pid}` : ''}` : 'NOT loaded'}`
        : 'not installed (npm run service:install)',
    });
  } catch (err) {
    checks.push({ name: 'launch agent', level: 'warn', detail: (err as Error).message });
  }

  if (cfg) {
    const h = await probeHealth(cfg);
    const healthy = h.reachable && h.status === 200;
    checks.push({
      name: 'health',
      level: healthy ? 'pass' : installed ? 'fail' : 'warn',
      detail: h.reachable ? `HTTP ${h.status} ${h.body ?? ''}`.trim() : `nothing listening on ${cfg.host}:${cfg.port}`,
    });
    if (healthy && tokenOk) {
      const m = await probeMcp(cfg);
      if (!m.ok) {
        checks.push({ name: 'mcp handshake', level: 'fail', detail: m.error ?? 'failed' });
      } else {
        const expected = remoteToolNames(cfg.trustedTerminal, cfg.trustedGui).sort();
        const got = [...(m.tools ?? [])].sort();
        const toolsMatch = JSON.stringify(expected) === JSON.stringify(got);
        checks.push({
          name: 'running version',
          level: m.serverVersion === VERSION ? 'pass' : 'fail',
          detail: `server reports ${m.serverName} ${m.serverVersion}; this build is ${VERSION}${m.serverVersion === VERSION ? '' : ' — restart the service'}`,
        });
        const missing = expected.filter((t) => !got.includes(t));
        const extra = got.filter((t) => !expected.includes(t));
        checks.push({
          name: 'exposed tools',
          level: toolsMatch && !got.includes('set_config_value') ? 'pass' : 'fail',
          detail:
            `${got.length} tools${toolsMatch ? ' (exactly the configured set; no set_config_value)' : ` (expected ${expected.length}; restart the service after config changes or upgrades)`}` +
            (missing.length ? `; missing: ${missing.join(', ')}` : '') +
            (extra.length ? `; unexpected: ${extra.join(', ')}` : ''),
        });
      }
    }
  }

  const failed = checks.some((c) => c.level === 'fail');
  if (json) {
    process.stdout.write(JSON.stringify({ version: VERSION, ok: !failed, checks }, null, 2) + '\n');
  } else {
    for (const c of checks) console.log(`${c.level.toUpperCase().padEnd(4)}  ${c.name}: ${c.detail}`);
    console.log(failed ? '\nDoctor: problems found.' : '\nDoctor: no failures.');
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`doctor failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
