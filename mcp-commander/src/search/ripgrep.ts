import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ripgrep integration: locating the binary, building argv, and running it with line-buffered,
 * UTF-8-safe output handling.
 */

// ---------------------------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------------------------

let cache: { key: string; value: string | null } | null = null;

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fromPathEnv(): string | null {
  const names = process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function wellKnownLocations(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\ripgrep\\rg.exe',
      'C:\\Program Files (x86)\\ripgrep\\rg.exe',
      path.join(home, 'scoop', 'apps', 'ripgrep', 'current', 'rg.exe'),
      path.join(home, '.cargo', 'bin', 'rg.exe'),
    ];
  }
  return ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg', path.join(home, '.cargo', 'bin', 'rg')];
}

async function fromVscodeRipgrep(): Promise<string | null> {
  try {
    // Optional dependency: a variable specifier keeps TypeScript from requiring it at build time.
    const specifier = '@vscode/ripgrep';
    const mod = (await import(specifier)) as { rgPath?: unknown };
    const rgPath = typeof mod.rgPath === 'string' ? mod.rgPath : null;
    if (!rgPath || !fs.existsSync(rgPath)) return null;
    if (process.platform !== 'win32' && !isExecutableFile(rgPath)) {
      try {
        fs.chmodSync(rgPath, 0o755);
      } catch {
        /* read-only install: fall through to the check below */
      }
    }
    return isExecutableFile(rgPath) ? rgPath : null;
  } catch {
    return null;
  }
}

/**
 * Finds a ripgrep binary, or null when none is available (callers then use the built-in engine).
 * Order: $MCP_COMMANDER_RG (a path, or 'none' to force the built-in engine) > @vscode/ripgrep >
 * an executable `rg` on $PATH > common install locations. Cached per $MCP_COMMANDER_RG value.
 */
export async function resolveRipgrepPath(): Promise<string | null> {
  const env = process.env.MCP_COMMANDER_RG?.trim() ?? '';
  if (cache && cache.key === env) return cache.value;
  let value: string | null = null;
  if (env.toLowerCase() === 'none') {
    value = null;
  } else {
    if (env && isExecutableFile(env)) value = env;
    value ??= await fromVscodeRipgrep();
    value ??= fromPathEnv();
    value ??= wellKnownLocations().find(isExecutableFile) ?? null;
  }
  cache = { key: env, value };
  return value;
}

export function clearRipgrepCache(): void {
  cache = null;
}

/** Called when a resolved binary could not be spawned, so later searches go straight to the fallback. */
export function markRipgrepUnusable(rgPath: string): void {
  if (cache && cache.value === rgPath) cache = { key: cache.key, value: null };
}

// ---------------------------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------------------------

export interface RgFilesArgOptions {
  root: string;
  includeHidden: boolean;
  /** filePattern globs, passed as `-g` in order (rg: last match wins, `!` excludes). */
  fileGlobs: string[];
}

export interface RgContentArgOptions extends RgFilesArgOptions {
  pattern: string;
  ignoreCase: boolean;
  contextLines: number;
  literalSearch: boolean;
}

/**
 * filePattern globs, then the directories the built-in engine always skips: .git (only needed
 * with --hidden) and node_modules. They come last so they win over the filePattern globs; rg does
 * not apply globs to the search root itself, so a `path` inside node_modules still works.
 */
function globArgs(opts: RgFilesArgOptions): string[] {
  const out: string[] = [];
  for (const g of opts.fileGlobs) out.push('-g', g);
  if (opts.includeHidden) out.push('-g', '!.git');
  out.push('-g', '!node_modules');
  return out;
}

export function buildContentArgs(opts: RgContentArgOptions): string[] {
  return [
    '--no-config',
    '--json',
    '--line-number',
    '--max-columns',
    '1000',
    '--max-columns-preview',
    ...(opts.literalSearch ? ['-F'] : []),
    ...(opts.contextLines > 0 ? ['-C', String(opts.contextLines)] : []),
    opts.ignoreCase ? '-i' : '-s',
    ...(opts.includeHidden ? ['--hidden'] : []),
    ...globArgs(opts),
    '--',
    opts.pattern,
    opts.root,
  ];
}

export function buildFilesArgs(opts: RgFilesArgOptions): string[] {
  return [
    '--no-config',
    '--files',
    ...(opts.includeHidden ? ['--hidden'] : []),
    ...globArgs(opts),
    '--',
    opts.root,
  ];
}

// ---------------------------------------------------------------------------------------------
// --json parsing
// ---------------------------------------------------------------------------------------------

interface RgData {
  text?: string;
  bytes?: string;
}

function decodeData(d: RgData | undefined | null): { text: string; buf?: Buffer } | null {
  if (!d) return null;
  if (typeof d.text === 'string') return { text: d.text };
  if (typeof d.bytes === 'string') {
    const buf = Buffer.from(d.bytes, 'base64');
    return { text: buf.toString('utf8'), buf };
  }
  return null;
}

export type RgEvent =
  | { kind: 'match' | 'context'; file: string; line: number; text: string; col?: number }
  | { kind: 'summary'; searches: number }
  | { kind: 'other' };

/** Converts a UTF-8 byte offset within `text` to a UTF-16 index. */
function byteOffsetToIndex(text: string, byteOffset: number, buf?: Buffer): number {
  const bytes = buf ?? Buffer.from(text, 'utf8');
  return bytes.subarray(0, Math.max(0, Math.min(byteOffset, bytes.length))).toString('utf8').length;
}

/** Parses one --json line; returns null for blank or malformed lines. */
export function parseRgJsonLine(line: string): RgEvent | null {
  if (!line.trim()) return null;
  let msg: { type?: string; data?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  const data = msg.data ?? {};
  if (msg.type === 'match' || msg.type === 'context') {
    const file = decodeData(data.path as RgData);
    const lines = decodeData(data.lines as RgData);
    if (!file || !lines) return null;
    const text = lines.text.replace(/\r?\n$/, '');
    const event: RgEvent = {
      kind: msg.type,
      file: file.text,
      line: typeof data.line_number === 'number' ? data.line_number : 0,
      text,
    };
    const subs = data.submatches as Array<{ start?: number }> | undefined;
    // Only long lines are windowed around the match, so only they need the byte->char conversion.
    if (msg.type === 'match' && text.length > 200 && subs?.length && typeof subs[0].start === 'number') {
      event.col = byteOffsetToIndex(text, subs[0].start, lines.buf);
    }
    return event;
  }
  if (msg.type === 'summary') {
    const stats = (data.stats ?? {}) as { searches?: number };
    return { kind: 'summary', searches: typeof stats.searches === 'number' ? stats.searches : 0 };
  }
  return { kind: 'other' };
}

// ---------------------------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------------------------

export interface RgRunHandlers {
  /** One complete stdout line (without the newline). */
  onLine: (line: string) => void;
  /** Called after each stdout chunk has been processed (lets callers kill once a cap is hit). */
  onChunkEnd?: () => void;
  /** Process ended (after the final partial line was delivered). */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string; stderrLines: string[] }) => void;
  /** The binary could not be started at all (also for spawn failures that throw). */
  onSpawnError: (err: Error, hadOutput: boolean) => void;
  /**
   * A stdout line longer than the line limit was dropped instead of being delivered (one JSON
   * event for a file with a line of hundreds of MB would not even fit in a string). `head` is
   * the line's beginning, `length` its full length in UTF-16 units.
   */
  onLongLine?: (head: string, length: number) => void;
}

export interface RgHandle {
  kill: () => void;
  /** null when spawn() threw. */
  readonly child: ChildProcess | null;
}

export interface RgRunOptions {
  /** Longest stdout line delivered to onLine (UTF-16 units); longer ones go to onLongLine. */
  maxLineChars?: number;
}

const MAX_STDERR = 64 * 1024;
/** 64 Mi chars: far above any real line of code, far below V8's string length limit. */
export const MAX_LINE_CHARS = 64 * 1024 * 1024;
const LONG_LINE_HEAD = 4096;

/** Strips rg's `rg: ` prefix and drops blank lines. */
function stderrLinesOf(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^rg: /, '').trimEnd())
    .filter((l) => l.trim() !== '');
}

export function runRipgrep(
  rgPath: string,
  args: string[],
  cwd: string,
  handlers: RgRunHandlers,
  opts: RgRunOptions = {},
): RgHandle {
  const maxLine = opts.maxLineChars ?? MAX_LINE_CHARS;
  let child: ChildProcess;
  try {
    child = spawn(rgPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // Some failures (E2BIG for a huge pattern, ENOMEM, ...) throw instead of emitting 'error'.
    // Report them asynchronously, exactly like an 'error' event.
    const error = err instanceof Error ? err : new Error(String(err));
    process.nextTick(() => handlers.onSpawnError(error, false));
    return { child: null, kill: () => {} };
  }
  let stderr = '';
  let hadOutput = false;
  let exited = false;
  let killTimer: NodeJS.Timeout | null = null;

  // Attach 'error' first: a spawn failure must never become an unhandled 'error' event.
  child.on('error', (err) => {
    if (exited) return;
    exited = true;
    if (killTimer) clearTimeout(killTimer);
    handlers.onSpawnError(err, hadOutput);
  });

  const handle: RgHandle = {
    child,
    kill: () => {
      if (exited || child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      // rg exits on SIGTERM immediately; SIGKILL is only a safety net.
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 2000);
        killTimer.unref();
      }
    },
  };
  // EMFILE / ENFILE: no stdio pipes were created; the 'error' event reports the failure.
  if (!child.stdout || !child.stderr) return handle;

  // The unfinished current line, kept as pieces: re-scanning or re-concatenating a growing
  // buffer on every chunk would make a single long line (minified bundles, dumps) quadratic.
  let parts: string[] = [];
  let partsLen = 0;
  let skipping = false; // the current line exceeded maxLine; the rest of it is dropped
  let skippedHead = '';
  let skippedLen = 0;

  const append = (piece: string): void => {
    if (skipping) {
      skippedLen += piece.length;
      return;
    }
    if (partsLen + piece.length > maxLine) {
      skipping = true;
      skippedHead = '';
      for (const p of [...parts, piece]) {
        skippedHead += p.slice(0, LONG_LINE_HEAD - skippedHead.length);
        if (skippedHead.length >= LONG_LINE_HEAD) break;
      }
      skippedLen = partsLen + piece.length;
      parts = [];
      partsLen = 0;
      return;
    }
    parts.push(piece);
    partsLen += piece.length;
  };

  const endLine = (lastPiece: string): void => {
    append(lastPiece);
    if (skipping) {
      skipping = false;
      const head = skippedHead;
      skippedHead = '';
      handlers.onLongLine?.(head, skippedLen);
      return;
    }
    const line = parts.length === 1 ? parts[0] : parts.join('');
    parts = [];
    partsLen = 0;
    handlers.onLine(line);
  };

  child.stdout.setEncoding('utf8'); // StringDecoder: multi-byte characters never split across chunks
  child.stdout.on('data', (chunk: string) => {
    hadOutput = true;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf('\n', start);
      if (nl === -1) break;
      endLine(chunk.slice(start, nl));
      start = nl + 1;
    }
    if (start < chunk.length) append(chunk.slice(start));
    handlers.onChunkEnd?.();
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length);
  });

  child.on('close', (code, signal) => {
    if (exited) return;
    exited = true;
    if (killTimer) clearTimeout(killTimer);
    if (parts.length || skipping) endLine(''); // a final line without a newline
    handlers.onExit({ code, signal, stderr, stderrLines: stderrLinesOf(stderr) });
  });

  return handle;
}
