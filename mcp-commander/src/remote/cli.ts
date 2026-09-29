import { VERSION } from '../version.js';
import { defaultRemoteDir } from './config.js';

/** Exit code for configuration errors (sysexits EX_CONFIG). */
export const EX_CONFIG = 78;

/**
 * Parses the options shared by the remote commands. Unknown options are errors, and anything
 * that looks like a secret is refused: tokens are only ever read from the token file.
 */
export function parseRemoteArgs(argv: string[], usage: string): { remoteDir: string; rest: string[] } {
  let remoteDir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') {
      process.stderr.write(`mcp-commander ${VERSION}\n`);
      process.exit(0);
    } else if (a === '--help' || a === '-h') {
      process.stderr.write(usage);
      process.exit(0);
    } else if (/^--(token|bearer|secret|api-key|password)/i.test(a)) {
      process.stderr.write('Secrets are never accepted on the command line; the token is read from <remote-dir>/token.\n');
      process.exit(2);
    } else if (a === '--remote-dir') {
      remoteDir = argv[++i];
      if (!remoteDir) {
        process.stderr.write('--remote-dir needs a value\n');
        process.exit(2);
      }
    } else if (a.startsWith('--remote-dir=')) {
      remoteDir = a.slice('--remote-dir='.length);
    } else {
      rest.push(a);
    }
  }
  return { remoteDir: remoteDir || defaultRemoteDir(), rest };
}

export function rejectExtraArgs(rest: string[], usage: string): void {
  if (rest.length) {
    process.stderr.write(`Unknown argument: ${rest[0]}\n\n${usage}`);
    process.exit(2);
  }
}
