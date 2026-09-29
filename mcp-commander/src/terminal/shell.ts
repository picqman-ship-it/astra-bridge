import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../security/paths.js';

const isWindows = process.platform === 'win32';

/** What to hand to child_process.spawn for one command line. */
export interface SpawnSpec {
  file: string;
  args: string[];
  /** cmd.exe only: pass the command line through untouched (no \" escaping). */
  windowsVerbatimArguments?: boolean;
}

export type ShellSource = 'argument' | 'config' | 'environment' | 'fallback';

/** Lowercased basename without a Windows executable extension: '/usr/bin/Bash.EXE' -> 'bash'. */
export function shellName(shell: string): string {
  const base = shell.split(/[\\/]/).pop() ?? shell;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

/**
 * Shell resolution order: explicit argument > config.defaultShell > $SHELL ($COMSPEC on
 * Windows) > /bin/sh (cmd.exe on Windows). Empty strings count as "not given".
 */
export function resolveShell(
  arg: string | undefined,
  configDefault: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { shell: string; source: ShellSource } {
  if (arg && arg.trim()) return { shell: arg.trim(), source: 'argument' };
  if (configDefault && configDefault.trim()) return { shell: configDefault.trim(), source: 'config' };
  const fromEnv = isWindows ? env.COMSPEC : env.SHELL;
  if (fromEnv && fromEnv.trim()) return { shell: fromEnv.trim(), source: 'environment' };
  return { shell: isWindows ? 'cmd.exe' : '/bin/sh', source: 'fallback' };
}

/**
 * argv for running `command` through `shell`:
 *  - bash / zsh:  [shell, '-l', '-c', cmd]   (login shell, so the user's PATH setup applies)
 *  - fish:        [shell, '-l', '-c', cmd]
 *  - pwsh:        [shell, '-Login', '-Command', cmd]
 *  - powershell:  [shell, '-NoProfile', '-Command', cmd]
 *  - cmd:         [shell, '/c', cmd] with windowsVerbatimArguments
 *  - anything else (sh, dash, ksh, ...): [shell, '-c', cmd]
 */
export function shellSpawnArgs(shell: string, command: string): SpawnSpec {
  const name = shellName(shell);
  if (name.includes('bash') || name.includes('zsh')) return { file: shell, args: ['-l', '-c', command] };
  if (name.includes('fish')) return { file: shell, args: ['-l', '-c', command] };
  if (name === 'pwsh' || name.startsWith('pwsh-')) return { file: shell, args: ['-Login', '-Command', command] };
  if (name === 'powershell') return { file: shell, args: ['-NoProfile', '-Command', command] };
  if (name === 'cmd') return { file: shell, args: ['/c', command], windowsVerbatimArguments: true };
  return { file: shell, args: ['-c', command] };
}

/**
 * POSIX: the same spawn with the command's stderr on its stdout pipe, via
 * `/bin/sh -c 'exec "$0" "$@" 2>&1' <file> <args...>` (exec keeps the PID). stdout and stderr on
 * two pipes are read in whatever order the event loop sees them, which reorders interleaved lines
 * ("out1 out2 err1" for out1/err1/out2) and puts a REPL prompt written to stderr ahead of the
 * result just printed on stdout (python3 -i). One pipe keeps the order they were written in, as a
 * terminal does.
 */
export function withStderrOnStdout(spec: SpawnSpec): SpawnSpec {
  if (isWindows || !isExecutableFile('/bin/sh')) return spec;
  return { file: '/bin/sh', args: ['-c', 'exec "$0" "$@" 2>&1', spec.file, ...spec.args] };
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!isWindows) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsCandidates(p: string, env: NodeJS.ProcessEnv): string[] {
  if (!isWindows || path.extname(p)) return [p];
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [p, ...exts.map((e) => p + e.toLowerCase()), ...exts.map((e) => p + e)];
}

/**
 * Resolves an executable the way a shell would: a path (absolute, or containing a separator,
 * relative to the server's cwd) must exist and be executable; a bare name is searched on PATH.
 * Returns the absolute path, or null when nothing runnable was found.
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const trimmed = expandHome(name.trim());
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed) || /[\\/]/.test(trimmed)) {
    const abs = path.resolve(trimmed);
    return windowsCandidates(abs, env).find(isExecutableFile) ?? null;
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of windowsCandidates(path.join(dir, trimmed), env)) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/** Windows: a PATHEXT without .EXE makes every bare command name fail to resolve. */
function repairedPathExt(current: string | undefined): string {
  if (!current || !current.trim()) return STANDARD_PATHEXT;
  const entries = current.split(';').map((e) => e.trim()).filter(Boolean);
  if (entries.some((e) => e.toUpperCase() === '.EXE')) return current;
  const seen = new Set<string>();
  return [...STANDARD_PATHEXT.split(';'), ...entries]
    .filter((e) => (seen.has(e.toUpperCase()) ? false : (seen.add(e.toUpperCase()), true)))
    .join(';');
}

/**
 * Environment for child processes: the server's env plus a TERM (so programs that consult it
 * behave), and pagers disabled — there is no TTY, and `git log` / `man` must not block on `less`.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    TERM: base.TERM || 'xterm-256color',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
  };
  if (isWindows) env.PATHEXT = repairedPathExt(base.PATHEXT);
  return env;
}
