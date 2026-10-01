import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coerceConfigValue, DEFAULT_BLOCKED_COMMANDS, defaultConfigDir, defaultShell, type ConfigKey, type ConfigSource, type ServerConfig } from '../config.js';
import { isWithin } from '../security/paths.js';
import { assertPrivateDir, readPrivateFile, RemoteSetupError } from './secrets.js';

/**
 * Configuration of the remote (HTTP / remote-stdio) entrypoints.
 *
 * It lives in its own owner-only directory, separate from the local ~/.mcp-commander/config.json,
 * is read once at startup (restart to apply changes) and is validated strictly: an unknown key, a
 * wrong type, a non-loopback address or an over-broad root stops the server instead of widening
 * access. Nothing reachable over MCP can change it.
 */

export const REMOTE_CONFIG_FILE = 'remote.json';
export const TOKEN_FILE = 'token';
export const LOG_DIR = 'logs';
export const AUDIT_FILE = 'audit.jsonl';
/** Private job queue, job logs and idempotency records (see durable.ts). Never inside a root. */
export const DURABLE_DIR = 'durable';
export const DEFAULT_PORT = 8765;

export interface RemoteLimits {
  /** Largest accepted POST body. */
  maxBodyBytes: number;
  /** Concurrent MCP sessions; the least recently used idle one is evicted when full. */
  maxSessions: number;
  /** A session with no POST/DELETE activity for this long is closed. */
  sessionIdleMs: number;
  /** Open TCP connections. */
  maxConnections: number;
  /** Time allowed to receive request headers. */
  headersTimeoutMs: number;
  /** Time allowed to receive a whole request (not the response). */
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
}

/** Durable jobs (trusted-terminal mode only). */
export interface JobLimits {
  /** Jobs running at the same time; the rest wait in the queue. */
  maxConcurrent: number;
  /** Jobs waiting to start; job_start is refused beyond this. */
  maxQueued: number;
  /** Per job and per stream (stdout, stderr): output beyond this is counted but not stored. */
  maxLogBytes: number;
  /** Timeout applied when job_start gives none. */
  defaultTimeoutSec: number;
  /** Job records kept on disk. Never deleted automatically; job_start is refused when full. */
  maxJobRecords: number;
  /** The worker exits after this long with nothing queued or running. */
  workerIdleExitMs: number;
}

/** Records behind the optional idempotencyKey of mutating tools. */
export interface IdempotencyLimits {
  /** Keys kept on disk. Never deleted automatically; new keys are refused when full. */
  maxKeys: number;
  /** Largest recorded tool result replayed on a retry (larger results are stored truncated). */
  maxResultBytes: number;
}

export interface RemoteConfig {
  dir: string;
  file: string;
  tokenFile: string;
  logDir: string;
  auditFile: string;
  durableDir: string;
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  /** Realpath'd directories the file and search tools may touch (never empty). */
  roots: string[];
  /** Exposes shell/process tools. Grants arbitrary code execution as this user. */
  trustedTerminal: boolean;
  /**
   * Exposes the macOS GUI tools (list_windows, inspect_ui, press_element, set_element_value).
   * They read and operate every app window this user can see, far outside the roots, so this is a
   * grant of the same order as trustedTerminal. Also needs Accessibility permission on the Mac.
   */
  trustedGui: boolean;
  blockedCommands: string[];
  defaultShell: string;
  fileReadLineLimit: number;
  fileWriteLineLimit: number;
  limits: RemoteLimits;
  audit: { maxBytes: number; maxFiles: number };
  jobs: JobLimits;
  idempotency: IdempotencyLimits;
}

export const DEFAULT_JOB_LIMITS: JobLimits = {
  maxConcurrent: 2,
  maxQueued: 32,
  maxLogBytes: 4 * 1024 * 1024,
  defaultTimeoutSec: 3600,
  maxJobRecords: 1000,
  workerIdleExitMs: 30_000,
};

const JOB_RANGES: Record<keyof JobLimits, [number, number]> = {
  maxConcurrent: [1, 16],
  maxQueued: [1, 1024],
  maxLogBytes: [4 * 1024, 256 * 1024 * 1024],
  defaultTimeoutSec: [1, 7 * 24 * 3600],
  maxJobRecords: [4, 100_000],
  workerIdleExitMs: [500, 24 * 3600 * 1000],
};

export const DEFAULT_IDEMPOTENCY: IdempotencyLimits = { maxKeys: 10_000, maxResultBytes: 256 * 1024 };

const IDEMPOTENCY_RANGES: Record<keyof IdempotencyLimits, [number, number]> = {
  maxKeys: [2, 1_000_000],
  maxResultBytes: [1024, 4 * 1024 * 1024],
};

export const DEFAULT_LIMITS: RemoteLimits = {
  maxBodyBytes: 4 * 1024 * 1024,
  maxSessions: 16,
  sessionIdleMs: 30 * 60 * 1000,
  maxConnections: 32,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 60_000,
  keepAliveTimeoutMs: 5_000,
};

const LIMIT_RANGES: Record<keyof RemoteLimits, [number, number]> = {
  maxBodyBytes: [1024, 16 * 1024 * 1024],
  maxSessions: [1, 256],
  sessionIdleMs: [1000, 24 * 60 * 60 * 1000],
  maxConnections: [1, 1024],
  headersTimeoutMs: [1000, 120_000],
  requestTimeoutMs: [1000, 600_000],
  keepAliveTimeoutMs: [1000, 120_000],
};

const DEFAULT_AUDIT = { maxBytes: 1024 * 1024, maxFiles: 3 };
const AUDIT_RANGES = { maxBytes: [16 * 1024, 64 * 1024 * 1024], maxFiles: [1, 20] } as const;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'host', 'port', 'allowedHosts', 'allowedOrigins', 'roots', 'trustedTerminal', 'trustedGui',
  'blockedCommands', 'defaultShell', 'fileReadLineLimit', 'fileWriteLineLimit', 'limits', 'audit',
  'jobs', 'idempotency', 'protectedPaths',
]);

export function defaultRemoteDir(): string {
  return process.env.MCP_COMMANDER_REMOTE_DIR || path.join(os.homedir(), '.mcp-commander-remote');
}

export function remotePaths(dir: string) {
  const abs = path.resolve(dir);
  return {
    dir: abs,
    file: path.join(abs, REMOTE_CONFIG_FILE),
    tokenFile: path.join(abs, TOKEN_FILE),
    logDir: path.join(abs, LOG_DIR),
    auditFile: path.join(abs, LOG_DIR, AUDIT_FILE),
    durableDir: path.join(abs, DURABLE_DIR),
  };
}

/** An optional object of bounded integers, e.g. "jobs": { "maxConcurrent": 2 }. */
function intSection<T extends object>(raw: unknown, name: string, defaults: T, ranges: Record<keyof T, [number, number]>): T {
  const value = raw ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  const out = { ...defaults };
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!(k in ranges)) fail(`unknown ${name} key "${k}".`);
    const key = k as keyof T;
    (out as Record<keyof T, number>)[key] = intIn(v, `${name}.${k}`, ranges[key]);
  }
  return out;
}

function fail(msg: string): never {
  throw new RemoteSetupError(`Invalid ${REMOTE_CONFIG_FILE}: ${msg}`);
}

function intIn(value: unknown, name: string, [min, max]: readonly [number, number]): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function stringList(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) {
    fail(`${name} must be an array of non-empty strings.`);
  }
  if (value.length > max) fail(`${name} has more than ${max} entries.`);
  return value.map((v: string) => v.trim());
}

/**
 * The canonical spelling of `p`: symlinks resolved and, on a case- and normalization-insensitive
 * filesystem (APFS, the macOS default), the case and Unicode form stored on disk. It must be
 * fs.realpathSync.native: the JS fs.realpathSync keeps the caller's spelling, so a root written
 * "~/.aſtra-bridge" (U+017F, which APFS folds to "s" but toLowerCase() does not) opened the
 * protected ~/.astra-bridge while comparing as a different path. A path that does not exist (yet)
 * keeps its missing tail after the realpath of its deepest existing ancestor, and a dangling
 * symlink is followed, so the guard sits where the directory would appear.
 */
function realDir(p: string): string {
  const missing: string[] = [];
  let current = path.resolve(p);
  let hops = 0;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch {
      let target: string | undefined;
      try {
        if (hops < 40 && fs.lstatSync(current).isSymbolicLink()) target = path.resolve(path.dirname(current), fs.readlinkSync(current));
      } catch {
        /* does not exist */
      }
      if (target !== undefined) {
        hops++;
        current = target;
        continue;
      }
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing.reverse());
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Device and inode of an existing path: the filesystem's own notion of "the same directory". */
function fileId(p: string): string | undefined {
  try {
    const st = fs.statSync(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/** Where macOS firmlinks (/Users, /private, /usr/local, /opt, /Applications …) really lead. */
const DATA_VOLUME = '/System/Volumes/Data';

/**
 * Every spelling of the canonical path `p`: itself and, on macOS, its firmlink twin. realpath does
 * not resolve firmlinks, so /System/Volumes/Data/Users/x/.ssh is /Users/x/.ssh (same device and
 * inode) under another name, and /System/Volumes/Data contains every home directory without
 * containing "/Users/x" as a string. The twin is derived from the deepest existing ancestor, so a
 * protected location that does not exist yet gets one too.
 */
function spellings(p: string): string[] {
  if (process.platform !== 'darwin') return [p];
  let existing = p;
  while (fileId(existing) === undefined && path.dirname(existing) !== existing) existing = path.dirname(existing);
  const twin = isWithin(existing, DATA_VOLUME) ? existing.slice(DATA_VOLUME.length) || '/' : path.join(DATA_VOLUME, existing);
  const id = fileId(existing);
  return id !== undefined && fileId(twin) === id ? [p, path.join(twin, path.relative(existing, p))] : [p];
}

/** A root, a protected location or the home directory, compared by every spelling and by identity. */
interface Place {
  spelled: string[];
  /** Device/inode of the place itself, when it exists. */
  id?: string;
  /** Device/inode of each existing directory from the place up to "/", along every spelling. */
  lineage: Set<string>;
}

function place(canonical: string): Place {
  const spelled = spellings(canonical);
  const lineage = new Set<string>();
  for (const s of spelled) {
    for (let cur = s; ; cur = path.dirname(cur)) {
      const id = fileId(cur);
      if (id !== undefined) lineage.add(id);
      if (path.dirname(cur) === cur) break;
    }
  }
  return { spelled, id: fileId(canonical), lineage };
}

/**
 * `inner` is `outer` or inside it: by canonical path under any spelling, or because
 * `outer`'s device/inode is `inner` or one of its
 * ancestors (another mount or alias of the same directory, e.g. a Linux bind mount).
 */
function placeWithin(inner: Place, outer: Place): boolean {
  if (inner.spelled.some((i) => outer.spelled.some((o) => isWithin(i, o)))) return true;
  return outer.id !== undefined && inner.lineage.has(outer.id);
}

/** This installation (dist/, scripts/, node_modules/ …): two levels above dist/remote/config.js. */
const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Extra protected locations: absolute paths separated by path.delimiter (":"). */
export const PROTECTED_PATHS_ENV = 'MCP_COMMANDER_PROTECTED_PATHS';

function extraProtectedPaths(): string[] {
  const out: string[] = [];
  for (const entry of (process.env[PROTECTED_PATHS_ENV] ?? '').split(path.delimiter)) {
    if (entry.trim() === '') continue;
    // A stray space would silently protect a different (non-existent) path.
    if (entry !== entry.trim() || !path.isAbsolute(entry)) {
      throw new RemoteSetupError(
        `Invalid ${PROTECTED_PATHS_ENV}: entry ${JSON.stringify(entry)} must be an absolute path without surrounding spaces (entries are separated by "${path.delimiter}").`,
      );
    }
    out.push(entry);
  }
  return out;
}

/**
 * Optional "protectedPaths" in remote.json: the same kind of extra locations as the environment
 * variable, but seen by every process that loads this config (HTTP service, stdio server, setup,
 * doctor, job worker). Remote clients can never edit remote.json.
 */
function configProtectedPaths(value: unknown): string[] {
  if (value === undefined) return [];
  // Checked before stringList(), which trims: a stray space must be refused, not silently fixed.
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v !== v.trim()) {
        fail(`protectedPaths entry ${JSON.stringify(v)} must be an absolute path without surrounding spaces.`);
      }
    }
  }
  const list = stringList(value, 'protectedPaths', 32);
  for (const entry of list) {
    if (!path.isAbsolute(entry)) fail(`protectedPaths entry ${JSON.stringify(entry)} must be an absolute path without surrounding spaces.`);
  }
  return list;
}

/**
 * Places a remote root must neither be, contain, nor be inside: writing there would let a remote
 * client change its own permissions (remote/local config, LaunchAgents), reach credentials (SSH
 * keys; ~/.astra-bridge, the Astra Bridge agent/client private keys), or replace the code the
 * service runs on its next start (this installation; Node's prefix, e.g. /usr/local for Homebrew,
 * which also holds the libraries Node loads). A process that spawns this server adds its own
 * locations (e.g. its code directory) through MCP_COMMANDER_PROTECTED_PATHS; a relative entry
 * stops the server. Not exhaustive: roots should be a dedicated workspace.
 */
export function protectedPaths(remoteDir: string, extra: readonly string[] = []): string[] {
  const home = os.homedir();
  const nodePrefix = (p: string) => path.dirname(path.dirname(p));
  return [
    remoteDir,
    defaultConfigDir(),
    INSTALL_DIR,
    nodePrefix(process.execPath),
    nodePrefix(realDir(process.execPath)),
    path.join(home, 'Library', 'LaunchAgents'),
    path.join(home, '.ssh'),
    path.join(home, '.claude'),
    path.join(home, '.config'),
    path.join(home, '.astra-bridge'),
    ...extraProtectedPaths(),
    ...extra,
  ].map(realDir);
}

/** Validates and realpaths the configured roots. */
export function validateRoots(value: unknown, remoteDir: string, extraProtected: readonly string[] = []): string[] {
  const list = stringList(value, 'roots', 32);
  if (list.length === 0) fail('roots must list at least one directory (an empty list is never "everything" here).');
  const home = place(realDir(os.homedir()));
  const guarded = protectedPaths(remoteDir, extraProtected).map((g) => ({ path: g, place: place(g) }));
  const out: string[] = [];
  for (const entry of list) {
    if (!path.isAbsolute(entry)) fail(`root ${JSON.stringify(entry)} must be an absolute path.`);
    let real: string;
    try {
      // .native: the on-disk case and Unicode form (see realDir), so the stored root and every
      // comparison below use the one spelling the filesystem itself reports.
      real = fs.realpathSync.native(entry);
    } catch {
      fail(`root ${entry} does not exist.`);
    }
    if (!fs.statSync(real).isDirectory()) fail(`root ${entry} is not a directory.`);
    if (path.dirname(real) === real) fail(`root ${entry} is the filesystem root.`);
    const root = place(real);
    // The home directory holds shell startup files, keychains and app settings: writing there is
    // code execution on the next login shell. A root must be a narrower directory. (Also catches
    // /System/Volumes/Data, /System …, which hold the home directory under its firmlink twin.)
    if (placeWithin(home, root)) fail(`root ${entry} is the home directory or contains it; choose a narrower directory.`);
    for (const g of guarded) {
      if (placeWithin(root, g.place) || placeWithin(g.place, root)) fail(`root ${entry} overlaps protected location ${g.path}.`);
    }
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

function validHostEntry(h: string): boolean {
  return /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/.test(h);
}

function validOrigin(o: string): boolean {
  try {
    const u = new URL(o);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o;
  } catch {
    return false;
  }
}

/** Parses and validates remote.json content. `dir` is the (already checked) remote directory. */
export function parseRemoteConfig(raw: string, dir: string): RemoteConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`not valid JSON (${(err as Error).message}).`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('the file must contain a JSON object.');
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!TOP_LEVEL_KEYS.has(key)) fail(`unknown key "${key}".`);
  if (obj.schemaVersion !== 1) fail('schemaVersion must be 1.');

  const host = obj.host ?? '127.0.0.1';
  if (typeof host !== 'string' || !LOOPBACK_HOSTS.has(host)) {
    fail('host must be "127.0.0.1" or "::1": the server only listens on loopback. Reach it through an outbound tunnel.');
  }
  const port = intIn(obj.port ?? DEFAULT_PORT, 'port', [1, 65535]);

  const defaultHosts = host === '::1' ? [`[::1]:${port}`, `localhost:${port}`] : [`127.0.0.1:${port}`, `localhost:${port}`];
  const allowedHosts = obj.allowedHosts === undefined ? defaultHosts : stringList(obj.allowedHosts, 'allowedHosts', 16).map((h) => h.toLowerCase());
  for (const h of allowedHosts) if (!validHostEntry(h)) fail(`allowedHosts entry ${JSON.stringify(h)} is not a host[:port] (no wildcards).`);
  if (allowedHosts.length === 0) fail('allowedHosts must not be empty.');

  const allowedOrigins = obj.allowedOrigins === undefined ? [] : stringList(obj.allowedOrigins, 'allowedOrigins', 16);
  for (const o of allowedOrigins) if (!validOrigin(o)) fail(`allowedOrigins entry ${JSON.stringify(o)} must be an exact origin like https://example.com (no wildcards, paths or "null").`);

  if (obj.trustedTerminal !== undefined && typeof obj.trustedTerminal !== 'boolean') fail('trustedTerminal must be true or false.');
  if (obj.trustedGui !== undefined && typeof obj.trustedGui !== 'boolean') fail('trustedGui must be true or false.');

  const roots = validateRoots(obj.roots, dir, configProtectedPaths(obj.protectedPaths));

  const pref = <K extends ConfigKey>(key: K, fallback: ServerConfig[K]): ServerConfig[K] => {
    if (obj[key] === undefined) return fallback;
    if (key === 'blockedCommands' && !Array.isArray(obj[key])) fail('blockedCommands must be an array of strings.');
    try {
      return coerceConfigValue(key, obj[key]) as ServerConfig[K];
    } catch (err) {
      fail((err as Error).message);
    }
  };

  const limitsRaw = obj.limits ?? {};
  if (!limitsRaw || typeof limitsRaw !== 'object' || Array.isArray(limitsRaw)) fail('limits must be an object.');
  const limits = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(limitsRaw as Record<string, unknown>)) {
    if (!(k in LIMIT_RANGES)) fail(`unknown limits key "${k}".`);
    const key = k as keyof RemoteLimits;
    limits[key] = intIn(v, `limits.${key}`, LIMIT_RANGES[key]);
  }
  if (limits.headersTimeoutMs > limits.requestTimeoutMs) fail('limits.headersTimeoutMs must not exceed limits.requestTimeoutMs.');

  const auditRaw = obj.audit ?? {};
  if (!auditRaw || typeof auditRaw !== 'object' || Array.isArray(auditRaw)) fail('audit must be an object.');
  const audit = { ...DEFAULT_AUDIT };
  for (const [k, v] of Object.entries(auditRaw as Record<string, unknown>)) {
    if (k !== 'maxBytes' && k !== 'maxFiles') fail(`unknown audit key "${k}".`);
    audit[k] = intIn(v, `audit.${k}`, AUDIT_RANGES[k]);
  }
  const jobs = intSection(obj.jobs, 'jobs', DEFAULT_JOB_LIMITS, JOB_RANGES);
  const idempotency = intSection(obj.idempotency, 'idempotency', DEFAULT_IDEMPOTENCY, IDEMPOTENCY_RANGES);

  return {
    ...remotePaths(dir),
    host,
    port,
    allowedHosts,
    allowedOrigins,
    roots,
    trustedTerminal: obj.trustedTerminal === true,
    trustedGui: obj.trustedGui === true,
    blockedCommands: pref('blockedCommands', [...DEFAULT_BLOCKED_COMMANDS]),
    defaultShell: pref('defaultShell', defaultShell()),
    fileReadLineLimit: pref('fileReadLineLimit', 1000),
    fileWriteLineLimit: pref('fileWriteLineLimit', 50),
    limits,
    audit,
    jobs,
    idempotency,
  };
}

/**
 * Loads remote.json from an owner-only directory. Throws RemoteSetupError with a user-facing
 * message on any problem; callers must treat that as fatal.
 */
export function loadRemoteConfig(dir = defaultRemoteDir()): RemoteConfig {
  const paths = remotePaths(dir);
  assertPrivateDir(paths.dir, 'Remote config directory');
  const raw = readPrivateFile(paths.file, 'Remote config file', 256 * 1024);
  return parseRemoteConfig(raw, paths.dir);
}

/** The read-only ConfigSource the tools see in remote mode. */
export class RemoteConfigSource implements ConfigSource {
  readonly file: string;
  readonly loadError = null;
  private readonly values: ServerConfig;

  constructor(cfg: RemoteConfig) {
    this.file = cfg.file;
    this.values = {
      blockedCommands: [...cfg.blockedCommands],
      allowedDirectories: [...cfg.roots],
      defaultShell: cfg.defaultShell,
      fileReadLineLimit: cfg.fileReadLineLimit,
      fileWriteLineLimit: cfg.fileWriteLineLimit,
    };
  }

  get(): ServerConfig {
    return structuredClone(this.values);
  }

  getValue<K extends ConfigKey>(key: K): ServerConfig[K] {
    return structuredClone(this.values[key]);
  }

  set(): ServerConfig {
    throw new Error('Remote configuration is read-only over MCP. The owner edits remote.json on the Mac and restarts the service.');
  }
}
