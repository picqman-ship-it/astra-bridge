import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Private on-disk state of the remote entrypoints: the durable job queue and the idempotency
 * records. Everything lives below <remote-dir>/durable (0700), which config validation keeps
 * outside every exposed root.
 *
 * Rules every writer follows:
 *  - a record is written to a fresh temp file (O_CREAT|O_EXCL, 0600, fsync) and then renamed over
 *    its final name (replace) or hard-linked to it (create-only claim, fails if it exists), so a
 *    reader never sees half a record and two claimants can never both win;
 *  - every byte is written (short writes are continued) and the file and its directory are fsynced;
 *    a directory fsync failure other than "not supported by this filesystem" is an error;
 *  - reads refuse symlinks and anything that is not a regular 0600 file owned by us;
 *  - any error (EACCES, ENOSPC, EIO, a malformed record...) is thrown to the caller, which refuses
 *    the action instead of guessing.
 */

export class DurableStateError extends Error {}

/**
 * In-process fault injection for tests (disk full, permission denied, crash windows). Nothing
 * reachable over MCP, the command line or the environment sets it; production never does.
 */
export const faults: { beforeWrite?: (file: string) => void } = {};

const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** JSON with object keys sorted at every level: equal values give equal strings. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function describe(err: unknown): string {
  const code = errCode(err);
  return code ? `${code}` : err instanceof Error ? err.message : String(err);
}

/**
 * Creates `dir` (one level, mode 0700) if it is missing, then checks it is a real directory owned
 * by us with no group/other access. The parent must already have been checked.
 */
export function ensurePrivateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (errCode(err) !== 'EEXIST') throw new DurableStateError(`Cannot create private state directory ${dir} (${describe(err)}).`);
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    throw new DurableStateError(`Private state directory ${dir} is unreadable (${describe(err)}).`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new DurableStateError(`Private state path ${dir} is not a real directory (symlinks are refused).`);
  if (uid !== undefined && st.uid !== uid) throw new DurableStateError(`Private state directory ${dir} is not owned by the current user.`);
  if (st.mode & 0o077) throw new DurableStateError(`Private state directory ${dir} has mode ${(st.mode & 0o777).toString(8)}; it must be 0700.`);
}

/** Writes all of `buf` (a write may be short). */
export function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off, null);
    if (n <= 0) throw Object.assign(new Error('write made no progress'), { code: 'EIO' });
    off += n;
  }
}

/** Writes `data` to a new temp file next to `file`, completely and fsynced; returns the temp path. */
function writeTemp(file: string, data: string | Buffer): string {
  faults.beforeWrite?.(file);
  const tmp = path.join(path.dirname(file), `.tmp-${crypto.randomBytes(8).toString('hex')}`);
  let fd: number | undefined;
  try {
    // O_EXCL: never follows or reuses an existing path (a planted symlink makes this fail).
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    writeAll(fd, buf);
    fs.fsyncSync(fd);
    if (fs.fstatSync(fd).size !== buf.length) throw Object.assign(new Error('size mismatch after write'), { code: 'EIO' });
    fs.closeSync(fd);
    fd = undefined;
    return tmp;
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw new DurableStateError(`Cannot write private state ${file} (${describe(err)}).`);
  }
}

/** Filesystems that cannot fsync a directory say so with one of these; anything else is a failure. */
const DIR_FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR']);

/** Makes a rename/link in `dir` durable. Throws on a real I/O error (EIO, ENOSPC...). */
function syncDir(dir: string): void {
  let fd: number;
  try {
    fd = fs.openSync(dir, 'r');
  } catch (err) {
    throw new DurableStateError(`Cannot open ${dir} to make a write durable (${describe(err)}).`);
  }
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    if (!DIR_FSYNC_UNSUPPORTED.has(errCode(err) ?? '')) {
      throw new DurableStateError(`Cannot make a write in ${dir} durable (${describe(err)}); the state may not survive a crash.`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Thrown when a record was published (renamed/linked into place) but could not be made durable.
 * The caller must not act on it, and knows the record may exist.
 */
export class UnsyncedRecordError extends DurableStateError {
  readonly published = true;
}

/** Atomically replaces `file` with `data` (rename replaces a symlink itself, never its target). */
export function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = writeTemp(file, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new DurableStateError(`Cannot write private state ${file} (${describe(err)}).`);
  }
  try {
    syncDir(path.dirname(file));
  } catch (err) {
    throw new UnsyncedRecordError((err as Error).message);
  }
}

/**
 * Atomically creates `file` with `data` unless it already exists. Returns false when it existed.
 * Exactly one of any number of concurrent callers (in any process) gets true.
 */
export function createExclusive(file: string, data: string | Buffer): boolean {
  const tmp = writeTemp(file, data);
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (errCode(err) === 'EEXIST') return false;
    throw new DurableStateError(`Cannot create private state ${file} (${describe(err)}).`);
  }
  fs.rmSync(tmp, { force: true });
  try {
    syncDir(path.dirname(file));
  } catch (err) {
    throw new UnsyncedRecordError((err as Error).message);
  }
  return true;
}

/** Reads a regular 0600 file we own (no symlinks), at most `maxBytes`. Returns null when missing. */
export function readPrivate(file: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    if (errCode(err) === 'ELOOP') throw new DurableStateError(`Private state ${file} is a symbolic link; refusing.`);
    throw new DurableStateError(`Cannot read private state ${file} (${describe(err)}).`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new DurableStateError(`Private state ${file} is not a regular file.`);
    if (uid !== undefined && st.uid !== uid) throw new DurableStateError(`Private state ${file} is not owned by the current user.`);
    if (st.mode & 0o077) {
      throw new DurableStateError(`Private state ${file} has mode ${(st.mode & 0o777).toString(8)}; it must be 0600 (group/other access refused).`);
    }
    if (st.size > maxBytes) throw new DurableStateError(`Private state ${file} is larger than ${maxBytes} bytes; refusing.`);
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > maxBytes) throw new DurableStateError(`Private state ${file} is larger than ${maxBytes} bytes; refusing.`);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads and parses a JSON record. Missing → null; unreadable or malformed → DurableStateError. */
export function readJson<T>(file: string, maxBytes = 1024 * 1024): T | null {
  const buf = readPrivate(file, maxBytes);
  if (buf === null) return null;
  try {
    const value = JSON.parse(buf.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as T;
  } catch {
    throw new DurableStateError(`Private state ${file} is malformed (not a JSON object); refusing to act on it. Inspect or move it aside manually.`);
  }
}

export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === 'EPERM';
  }
}

/**
 * The identity of a running process: its process group and start time as `ps` reports them
 * ("<pgid> <lstart>"), or null when it is not running. A PID can be reused by an unrelated
 * process; PID + start time cannot (within the 1s resolution of lstart), so signals and liveness
 * decisions about recorded PIDs compare this, never the bare PID.
 */
export function processIdentity(pid: number): string | null {
  const r = readIdentity(pid);
  return r.known ? r.identity : null;
}

/** Like processIdentity, but tells "not running" (known, null) apart from "ps failed" (unknown). */
function readIdentity(pid: number): { known: true; identity: string | null } | { known: false } {
  if (!isAlive(pid)) return { known: true, identity: null };
  try {
    const out = execFileSync('ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.trim().replace(/\s+/g, ' ');
    return { known: true, identity: line || null };
  } catch {
    // ps exits non-zero for a PID that vanished meanwhile; anything else is an unknown answer.
    return isAlive(pid) ? { known: false } : { known: true, identity: null };
  }
}

let selfIdentity: string | null | undefined;
/** processIdentity(process.pid), computed once. */
export function ownIdentity(): string | null {
  if (selfIdentity === undefined) selfIdentity = processIdentity(process.pid);
  return selfIdentity;
}

/**
 * Whether the process recorded as (pid, identity) still runs:
 *  - 'same': the PID runs and has the recorded identity;
 *  - 'gone': confirmed not running (no such PID, or the PID now belongs to a different process);
 *  - 'unknown': the PID runs but its identity could not be confirmed (none recorded, or ps failed).
 * Only 'gone' may ever authorize taking over someone else's work; 'unknown' never does.
 */
export type ProcessStatus = 'same' | 'gone' | 'unknown';

export function processStatus(pid: number | undefined, identity: string | null | undefined): ProcessStatus {
  if (!pid) return 'gone';
  if (!isAlive(pid)) return 'gone';
  if (!identity) return 'unknown';
  const r = readIdentity(pid);
  if (!r.known) return 'unknown';
  return r.identity === identity ? 'same' : 'gone';
}

/** True when `pid` still runs and is verifiably the same process that was recorded as `identity`. */
export function sameProcess(pid: number | undefined, identity: string | null | undefined): boolean {
  return processStatus(pid, identity) === 'same';
}

interface LockOwner {
  pid: number;
  identity: string | null;
  nonce: string;
  at: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Creates `file` with its complete content in one step (temp file + link); false if it exists. */
function linkNew(file: string, content: string): boolean {
  faults.beforeWrite?.(file);
  const tmp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  let fd: number;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch (err) {
    throw new DurableStateError(`Cannot create lock ${file} (${describe(err)}).`);
  }
  try {
    try {
      writeAll(fd, Buffer.from(content, 'utf8'));
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (errCode(err) === 'EEXIST') return false;
    throw new DurableStateError(`Cannot create lock ${file} (${describe(err)}).`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readOwner(file: string): LockOwner | 'missing' | 'malformed' {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return errCode(err) === 'ENOENT' ? 'missing' : 'malformed';
  }
  try {
    const o = JSON.parse(raw) as LockOwner;
    if (typeof o?.pid === 'number' && typeof o.nonce === 'string' && typeof o.at === 'number') {
      return { pid: o.pid, identity: typeof o.identity === 'string' ? o.identity : null, nonce: o.nonce, at: o.at };
    }
  } catch {
    /* fall through */
  }
  return 'malformed';
}

/**
 * A cross-process mutex on one lock file. The lock file is created complete in one step (temp +
 * link), holding the owner's PID, process identity and a nonce.
 *
 * A lock is only ever taken away from an owner that is CONFIRMED gone: its PID does not exist, or
 * now belongs to a different process (other start time). A live owner is never robbed, however old
 * the lock (a slow or suspended owner may still be inside its critical section); an owner whose
 * identity cannot be confirmed, and a malformed lock file, are never broken automatically — the
 * caller times out and the error names the file for manual recovery.
 *
 * Breaking is serialized by a second create-only file (<lock>.break) and re-checks that the lock
 * still holds the dead owner it inspected before removing it: nobody but a breaker removes a lock
 * whose owner is dead, and breakers exclude each other, so a fresh lock is never removed. A
 * breaker that dies inside that tiny window leaves <lock>.break behind; that too needs manual
 * removal (fail closed).
 *
 * Correctness of idempotency claims does not depend on this lock: those use createExclusive.
 * The lock serializes queue/capacity decisions and job state transitions.
 */
export class FileLock {
  private readonly breakFile: string;
  private lastIdentityCheck = new Map<string, number>();

  constructor(
    readonly file: string,
    /** Owner identity (ps) is checked only for locks older than this; younger ones are just awaited. */
    private readonly checkAfterMs = 2000,
  ) {
    this.breakFile = `${file}.break`;
  }

  private ownerGone(owner: LockOwner): boolean {
    if (!isAlive(owner.pid)) return true; // cheap, and certain (ESRCH)
    if (owner.pid === process.pid) return false;
    if (Date.now() - owner.at < this.checkAfterMs || !owner.identity) return false;
    const last = this.lastIdentityCheck.get(owner.nonce) ?? 0;
    if (Date.now() - last < 1000) return false;
    this.lastIdentityCheck.set(owner.nonce, Date.now());
    return processStatus(owner.pid, owner.identity) === 'gone';
  }

  /** Removes the lock iff it still belongs to the (confirmed gone) owner `dead`. */
  private breakDead(dead: LockOwner): void {
    const me = { pid: process.pid, identity: ownIdentity(), nonce: crypto.randomBytes(12).toString('hex'), at: Date.now() };
    if (!linkNew(this.breakFile, JSON.stringify(me))) return; // another breaker is at work (or died: manual)
    try {
      const now = readOwner(this.file);
      if (typeof now === 'object' && now.nonce === dead.nonce) fs.rmSync(this.file, { force: true });
    } finally {
      const b = readOwner(this.breakFile);
      if (typeof b === 'object' && b.nonce === me.nonce) fs.rmSync(this.breakFile, { force: true });
    }
  }

  async acquire(timeoutMs = 10_000): Promise<() => void> {
    const owner: LockOwner = { pid: process.pid, identity: ownIdentity(), nonce: crypto.randomBytes(12).toString('hex'), at: 0 };
    const deadline = Date.now() + timeoutMs;
    let wait = 5;
    let blocker: LockOwner | 'missing' | 'malformed' = 'missing';
    for (;;) {
      owner.at = Date.now();
      if (linkNew(this.file, JSON.stringify(owner))) {
        return () => {
          const cur = readOwner(this.file);
          if (typeof cur === 'object' && cur.nonce === owner.nonce) fs.rmSync(this.file, { force: true });
        };
      }
      blocker = readOwner(this.file);
      if (typeof blocker === 'object' && this.ownerGone(blocker)) {
        this.breakDead(blocker);
        // A leftover breaker may refuse recovery: still honor the deadline and yield below.
      }
      if (Date.now() > deadline) {
        const why =
          blocker === 'malformed'
            ? 'the lock file is malformed, so it is never broken automatically'
            : typeof blocker === 'object'
              ? `held by PID ${blocker.pid}, which is running or could not be confirmed gone`
              : 'it kept being taken';
        throw new DurableStateError(
          `Timed out waiting for the state lock ${this.file} (${why}). Nothing was done. If no mcp-commander ` +
            `process or job worker is running, remove ${this.file} (and ${this.breakFile} if present) manually.`,
        );
      }
      await sleep(wait);
      wait = Math.min(50, wait * 2);
    }
  }

  async with<T>(fn: () => T | Promise<T>, timeoutMs?: number): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
