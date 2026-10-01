import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Path sandboxing for the file and search tools (not the terminal — a shell can reach any path,
 * exactly as in Desktop Commander; this is documented, not hidden).
 *
 * Differences from the original that close real holes:
 *  - allowed directories are realpath'd too, so symlinked roots (/tmp -> /private/tmp) work;
 *  - comparison uses the filesystem's canonical spelling, never platform-wide case folding;
 *  - symlinks inside an allowed dir that point outside it are rejected, because we compare
 *    the *resolved* target, never the requested spelling.
 */

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function comparable(p: string): string {
  let out = path.normalize(p);
  if (out.length > 1 && out.endsWith(path.sep) && !/^[A-Za-z]:\\$/.test(out)) out = out.slice(0, -1);
  return out;
}

/**
 * Resolves symlinks for a path that may not exist yet: realpath the deepest existing
 * ancestor and re-append the missing tail.
 */
export async function resolveReal(absolute: string): Promise<string> {
  return (await resolveRealDetailed(absolute)).real;
}

/**
 * resolveReal plus, when the final component of `absolute` is a dangling symlink, that link's
 * first-hop target (used only to make the denial message explain why the path was refused).
 */
async function resolveRealDetailed(absolute: string): Promise<{ real: string; danglingTarget?: string }> {
  const missing: string[] = [];
  let current = absolute;
  let hops = 0;
  let danglingTarget: string | undefined;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return { real: missing.length ? path.join(real, ...[...missing].reverse()) : real, danglingTarget };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      // FIX: a *dangling* symlink makes realpath fail with ENOENT. Treating it as a missing
      // component returned the link's own location, so a write through it would create the
      // link's target, possibly outside the allowed directories. Follow the link by hand instead.
      const link = await fs.lstat(current).then((st) => st.isSymbolicLink(), () => false);
      if (link) {
        if (++hops > 40) {
          throw Object.assign(new Error(`Too many levels of symbolic links: ${absolute}`), { code: 'ELOOP' });
        }
        const target = path.resolve(path.dirname(current), await fs.readlink(current));
        if (hops === 1 && missing.length === 0) danglingTarget = target;
        current = target;
        continue;
      }
      const parent = path.dirname(current);
      if (parent === current) return { real: absolute, danglingTarget };
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function isWithin(child: string, parent: string): boolean {
  const c = comparable(child);
  const p = comparable(parent);
  if (c === p) return true;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

export class PathNotAllowedError extends Error {}

/**
 * Validates `requested` against `allowedDirectories` and returns the absolute, symlink-resolved
 * path the tool should operate on. An empty list (or one containing "/") means no restriction.
 */
export async function validatePath(requested: string, allowedDirectories: string[]): Promise<string> {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new Error('Path must be a non-empty string.');
  }
  const absolute = path.resolve(expandHome(requested.trim()));
  const { real: resolved, danglingTarget } = await resolveRealDetailed(absolute);

  // Non-string entries cannot come from ConfigManager (it validates), but never let one crash
  // or widen the check.
  const dirs = allowedDirectories.filter((d) => typeof d === 'string').map((d) => d.trim()).filter(Boolean);
  if (dirs.length === 0 || dirs.includes('/')) return resolved;

  for (const dir of dirs) {
    const dirAbs = path.resolve(expandHome(dir));
    const dirReal = await resolveReal(dirAbs).catch(() => dirAbs);
    if (isWithin(resolved, dirReal)) return resolved;
  }
  // Same wording as files/guard.ts uses for links, so a dangling link's denial says why.
  const why = danglingTarget ? ` (a symbolic link to ${danglingTarget})` : '';
  throw new PathNotAllowedError(
    `Path not allowed: ${requested}${why}. Must be within one of these directories: ${dirs.join(', ')}`,
  );
}
