import fs from 'node:fs/promises';
import path from 'node:path';
import { expandHome, isWithin, PathNotAllowedError, resolveReal, validatePath } from '../security/paths.js';
import { ToolError } from '../types.js';

/**
 * Path checks the shared validatePath() cannot express on its own.
 */

function notAllowed(requested: string, dirs: string[]): PathNotAllowedError {
  return new PathNotAllowedError(
    `Path not allowed: ${requested}. Must be within one of these directories: ${dirs.join(', ')}`,
  );
}

/**
 * Like validatePath, but does NOT follow a final symlink: the parent directory is resolved and the
 * last component re-joined, so the result names the link itself (for move_file's source and
 * get_file_info's lstat). The allow-list check is the same as validatePath's, applied to that path.
 */
export async function validatePathNoFollow(requested: string, allowedDirectories: string[]): Promise<string> {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new Error('Path must be a non-empty string.');
  }
  const absolute = path.resolve(expandHome(requested.trim()));
  const parent = path.dirname(absolute);
  if (parent === absolute) return validatePath(requested, allowedDirectories); // filesystem root
  const candidate = path.join(await resolveReal(parent), path.basename(absolute));

  const dirs = allowedDirectories.map((d) => d.trim()).filter(Boolean);
  if (dirs.length === 0 || dirs.includes('/')) return candidate;
  for (const dir of dirs) {
    const dirAbs = path.resolve(expandHome(dir));
    const dirReal = await resolveReal(dirAbs).catch(() => dirAbs);
    if (isWithin(candidate, dirReal)) return candidate;
  }
  throw notAllowed(requested, dirs);
}

/**
 * validatePath() resolves a *dangling* final symlink to the link's own location, so writing to it
 * would silently create the link's target — possibly outside the allowed directories. This follows
 * such links by hand (validating every hop) and returns the path a write should really go to.
 */
export async function resolveWriteTarget(validPath: string, requested: string, allowedDirectories: string[]): Promise<string> {
  let current = validPath;
  for (let hops = 0; hops < 40; hops++) {
    let st;
    try {
      st = await fs.lstat(current);
    } catch {
      return current; // does not exist: the write creates a regular file here
    }
    if (!st.isSymbolicLink()) return current;
    const target = path.resolve(path.dirname(current), await fs.readlink(current));
    try {
      current = await validatePath(target, allowedDirectories);
    } catch (err) {
      if (err instanceof PathNotAllowedError) {
        const dirs = allowedDirectories.map((d) => d.trim()).filter(Boolean);
        throw new PathNotAllowedError(
          `Path not allowed: ${requested} (a symbolic link to ${target}). Must be within one of these directories: ${dirs.join(', ')}`,
        );
      }
      throw err;
    }
  }
  throw new ToolError(`Too many levels of symbolic links: ${requested}`);
}
