import { ToolError } from '../types.js';

export function errnoCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

const FULL_DISK_ACCESS_HINT =
  'On macOS this can also mean the app running this server lacks access to a protected location: ' +
  'grant it in System Settings > Privacy & Security > Full Disk Access.';

export function permissionDenied(p: string): ToolError {
  return new ToolError(`Permission denied: ${p}${process.platform === 'darwin' ? `\n${FULL_DISK_ACCESS_HINT}` : ''}`);
}

/**
 * Turns a Node fs error into a user-facing ToolError that names the path the caller passed.
 * Unknown errors are returned unchanged (their message already names the syscall and path).
 */
export function mapFsError(err: unknown, p: string, notFound = `File not found: ${p}`): Error {
  if (err instanceof ToolError) return err;
  switch (errnoCode(err)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new ToolError(notFound);
    case 'EACCES':
    case 'EPERM':
      return permissionDenied(p);
    case 'ELOOP':
      return new ToolError(`Too many levels of symbolic links: ${p}`);
    case 'ENAMETOOLONG':
      return new ToolError(`Path is too long: ${p}`);
    case 'EISDIR':
      return new ToolError(`Is a directory: ${p}`);
    default:
      return err instanceof Error ? err : new Error(String(err));
  }
}
