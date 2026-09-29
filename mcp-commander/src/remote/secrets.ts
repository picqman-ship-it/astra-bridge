import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Owner-only secret files for the remote entrypoint.
 *
 * The bearer token lives in a file (never argv, URL, environment or logs). Anything unexpected —
 * a symlink, another owner, group/other permission bits, a short or low-variety token — is a
 * startup error: there is no fallback and no unauthenticated mode.
 */

/** 32 random bytes as base64url = 43 characters. */
export const TOKEN_MIN_LENGTH = 43;
const TOKEN_MAX_LENGTH = 512;
const TOKEN_MIN_DISTINCT = 16;
const TOKEN_CHARSET = /^[A-Za-z0-9_-]+$/;

export class RemoteSetupError extends Error {}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function describeMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

/**
 * Checks that `p` is a real directory (not a symlink) owned by us with no group/other access.
 */
export function assertPrivateDir(p: string, label: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    throw new RemoteSetupError(`${label} ${p} is missing or unreadable (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
  if (st.isSymbolicLink()) throw new RemoteSetupError(`${label} ${p} must not be a symbolic link.`);
  if (!st.isDirectory()) throw new RemoteSetupError(`${label} ${p} is not a directory.`);
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) throw new RemoteSetupError(`${label} ${p} is not owned by the current user.`);
  if (st.mode & 0o077) {
    throw new RemoteSetupError(`${label} ${p} has mode ${describeMode(st.mode)}; it must be 0700 (chmod 700).`);
  }
}

/**
 * Reads a regular file owned by us with no group/other access. Returns its content.
 */
export function readPrivateFile(p: string, label: string, maxBytes: number): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    throw new RemoteSetupError(`${label} ${p} is missing or unreadable (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
  if (st.isSymbolicLink()) throw new RemoteSetupError(`${label} ${p} must not be a symbolic link.`);
  if (!st.isFile()) throw new RemoteSetupError(`${label} ${p} is not a regular file.`);
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) throw new RemoteSetupError(`${label} ${p} is not owned by the current user.`);
  if (st.mode & 0o077) {
    throw new RemoteSetupError(`${label} ${p} has mode ${describeMode(st.mode)}; it must be 0600 (chmod 600).`);
  }
  if (st.size > maxBytes) throw new RemoteSetupError(`${label} ${p} is larger than ${maxBytes} bytes.`);
  // O_NOFOLLOW refuses a symlink swapped in after the lstat; re-checking the opened descriptor
  // makes the checks apply to the file actually read, not to whatever the path named earlier.
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) throw new RemoteSetupError(`${label} ${p} changed while it was being opened.`);
    if (uid !== undefined && fst.uid !== uid) throw new RemoteSetupError(`${label} ${p} is not owned by the current user.`);
    if (fst.mode & 0o077) throw new RemoteSetupError(`${label} ${p} has mode ${describeMode(fst.mode)}; it must be 0600 (chmod 600).`);
    const buf = Buffer.alloc(maxBytes + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (fst.size > maxBytes || n > maxBytes) throw new RemoteSetupError(`${label} ${p} is larger than ${maxBytes} bytes.`);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Why a token string is unacceptable, or null when it is fine. The token itself is never echoed. */
export function tokenWeakness(token: string): string | null {
  if (token.length < TOKEN_MIN_LENGTH) return `shorter than ${TOKEN_MIN_LENGTH} characters`;
  if (token.length > TOKEN_MAX_LENGTH) return `longer than ${TOKEN_MAX_LENGTH} characters`;
  if (!TOKEN_CHARSET.test(token)) return 'contains characters outside A-Z a-z 0-9 _ -';
  if (new Set(token).size < TOKEN_MIN_DISTINCT) return `uses fewer than ${TOKEN_MIN_DISTINCT} distinct characters`;
  return null;
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * A loaded bearer token. Only a SHA-256 digest is kept, and comparison hashes the candidate first,
 * so it takes the same time whatever its length or content.
 */
export class BearerToken {
  private readonly digest: Buffer;

  private constructor(token: string) {
    this.digest = crypto.createHash('sha256').update(token, 'utf8').digest();
  }

  static fromFile(p: string): BearerToken {
    const raw = readPrivateFile(p, 'Token file', 4096);
    const token = raw.trim();
    const weak = tokenWeakness(token);
    if (weak) throw new RemoteSetupError(`Token in ${p} is not acceptable: ${weak}. Re-run the remote setup to create a new one.`);
    return new BearerToken(token);
  }

  /** Test helper: never used by the entrypoint. */
  static fromString(token: string): BearerToken {
    const weak = tokenWeakness(token);
    if (weak) throw new RemoteSetupError(`Token is not acceptable: ${weak}.`);
    return new BearerToken(token);
  }

  matches(candidate: string): boolean {
    const d = crypto.createHash('sha256').update(candidate, 'utf8').digest();
    return crypto.timingSafeEqual(d, this.digest);
  }

  /** Checks an Authorization header value ("Bearer <token>"). */
  matchesHeader(header: string | string[] | undefined): boolean {
    if (typeof header !== 'string') return false;
    const m = /^Bearer ([A-Za-z0-9_-]{1,512})$/i.exec(header.trim());
    // Still hash something so a malformed header costs the same as a wrong token.
    return this.matches(m ? m[1] : '') && m !== null;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }
}
