import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileGlobs, IgnoreRules, toSlash, type RuleMatch } from './glob.js';

/**
 * The built-in search engine, used when no ripgrep binary is available. It mirrors ripgrep's
 * traversal rules so both engines return the same results:
 *  - symlinks are not followed (and not listed), special files are skipped;
 *  - `.git` and `node_modules` are always skipped;
 *  - filePattern globs work like `rg -g` (they take precedence over ignore files and hiding);
 *  - .rgignore / .ignore files apply everywhere, .gitignore (+ .git/info/exclude and the global
 *    excludes file) only inside a git repository, deepest directory first, last rule wins;
 *  - dot-entries are skipped unless includeHidden.
 * Content search skips files over 10 MB and binary files (a NUL byte in the first 8 KB). Like
 * ripgrep, a file starting with a UTF-16 byte-order mark is decoded as UTF-16, other files as UTF-8.
 * The walk is async and yields to the event loop every few milliseconds, and it polls the
 * caller's stop flag so a search can be cancelled promptly.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const YIELD_EVERY_MS = 8;
const READ_BATCH = 16;
const PREFETCH_MAX_BYTES = 512 * 1024;

export interface WalkControl {
  /** Hard stop (stop_search, timeout, shutdown, result cap reached): abandon the walk now. */
  stopped(): boolean;
  /** Non-fatal problem (unreadable directory or file). */
  warn(message: string): void;
}

export interface WalkOptions {
  /** Absolute, symlink-resolved search root (a directory or a single file). */
  root: string;
  includeHidden: boolean;
  /** filePattern globs (already split). Ignored when the root is a file, as with rg. */
  fileGlobs: string[];
}

// ---------------------------------------------------------------------------------------------
// Ignore files
// ---------------------------------------------------------------------------------------------

interface DirIgnores {
  dir: string;
  hasGit: boolean;
  rgignore: IgnoreRules | null;
  ignore: IgnoreRules | null;
  gitignore: IgnoreRules | null;
  gitExclude: IgnoreRules | null;
  parent: DirIgnores | null;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function loadDirIgnores(dir: string, names: Set<string> | null, parent: DirIgnores | null): Promise<DirIgnores> {
  const has = async (name: string) => (names ? names.has(name) : exists(path.join(dir, name)));
  const load = async (name: string) => {
    if (!(await has(name))) return null;
    const text = await readText(path.join(dir, name));
    return text === null ? null : IgnoreRules.fromText(dir, text);
  };
  const hasGit = await has('.git');
  let gitExclude: IgnoreRules | null = null;
  if (hasGit) {
    const text = await readText(path.join(dir, '.git', 'info', 'exclude'));
    if (text !== null) gitExclude = IgnoreRules.fromText(dir, text);
  }
  return {
    dir,
    hasGit,
    rgignore: await load('.rgignore'),
    ignore: await load('.ignore'),
    gitignore: await load('.gitignore'),
    gitExclude,
    parent,
  };
}

/** core.excludesFile from the user's git config, else git's default global ignore file. */
async function loadGlobalGitignore(base: string): Promise<IgnoreRules | null> {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  let file: string | null = null;
  for (const cfg of [path.join(home, '.gitconfig'), path.join(xdg, 'git', 'config')]) {
    const text = await readText(cfg);
    const m = text?.match(/^\s*excludesfile\s*=\s*(.+?)\s*$/im);
    if (m) {
      let value = m[1].replace(/^"(.*)"$/, '$1');
      if (value === '~' || value.startsWith('~/')) value = path.join(home, value.slice(1));
      file = value;
      break;
    }
  }
  file ??= path.join(xdg, 'git', 'ignore');
  const text = await readText(file);
  return text === null ? null : IgnoreRules.fromText(base, text);
}

function relTo(base: string, abs: string): string {
  return toSlash(path.relative(base, abs));
}

/** The ignore crate's precedence: .rgignore > .ignore > .gitignore > git exclude > global. */
function matchIgnores(chain: DirIgnores, abs: string, isDir: boolean, global: IgnoreRules | null): RuleMatch {
  let anyGit = false;
  for (let d: DirIgnores | null = chain; d; d = d.parent) {
    if (d.hasGit) {
      anyGit = true;
      break;
    }
  }
  let custom: RuleMatch = null;
  let ignore: RuleMatch = null;
  let gi: RuleMatch = null;
  let ex: RuleMatch = null;
  let sawGit = false;
  for (let d: DirIgnores | null = chain; d; d = d.parent) {
    const rel = d.rgignore || d.ignore || (anyGit && !sawGit && (d.gitignore || d.gitExclude)) ? relTo(d.dir, abs) : '';
    if (custom === null && d.rgignore) custom = d.rgignore.match(rel, isDir);
    if (ignore === null && d.ignore) ignore = d.ignore.match(rel, isDir);
    if (anyGit && !sawGit) {
      if (gi === null && d.gitignore) gi = d.gitignore.match(rel, isDir);
      if (ex === null && d.gitExclude) ex = d.gitExclude.match(rel, isDir);
    }
    sawGit = sawGit || d.hasGit;
  }
  let result = custom ?? ignore ?? gi ?? ex;
  if (result === null && anyGit && global) result = global.match(relTo(global.base, abs), isDir);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------------------------

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

class Yielder {
  private last = Date.now();
  async maybe(): Promise<void> {
    if (Date.now() - this.last >= YIELD_EVERY_MS) {
      await yieldNow();
      this.last = Date.now();
    }
  }
}

function errorText(err: unknown, p: string): string {
  const e = err as NodeJS.ErrnoException;
  const reason =
    e.code === 'EACCES' || e.code === 'EPERM' ? 'Permission denied' : e.code === 'ENOENT' ? 'No such file or directory' : e.message;
  return `${p}: ${reason}${e.code ? ` (${e.code})` : ''}`;
}

/**
 * Lists the files under `opts.root` that rg --files would list, calling `onFile` for each
 * (awaited, so the consumer controls back-pressure). A file root yields just that file.
 */
export async function walkFiles(
  opts: WalkOptions,
  ctl: WalkControl,
  onFile: (abs: string) => void | Promise<void>,
): Promise<void> {
  const rootStat = await fs.stat(opts.root);
  if (!rootStat.isDirectory()) {
    if (rootStat.isFile()) await onFile(opts.root);
    return;
  }
  const overrides = new FileGlobs(opts.fileGlobs);
  const global = await loadGlobalGitignore(opts.root);

  // Ignore files in the root's ancestors apply too (rg's default "parents" behaviour).
  const ancestors: string[] = [];
  for (let d = path.dirname(opts.root); ; d = path.dirname(d)) {
    ancestors.unshift(d);
    if (path.dirname(d) === d) break;
  }
  let chain: DirIgnores | null = null;
  for (const dir of ancestors) chain = await loadDirIgnores(dir, null, chain);

  const yielder = new Yielder();

  const visit = async (dir: string, parent: DirIgnores | null): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // An unreadable root means nothing was searched: that is an error, not a warning.
      if (dir === opts.root) throw new Error(errorText(err, dir));
      ctl.warn(errorText(err, dir));
      return;
    }
    if (ctl.stopped()) return;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const here = await loadDirIgnores(dir, new Set(entries.map((e) => e.name)), parent);

    for (const entry of entries) {
      if (ctl.stopped()) return;
      const name = entry.name;
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue; // symlinks, FIFOs, sockets, devices
      if (name === '.git' || name === 'node_modules') continue;
      const abs = path.join(dir, name);
      const rel = relTo(opts.root, abs);

      const ov = overrides.match(rel, isDir);
      if (ov === 'exclude') continue;
      if (ov !== 'include') {
        const ig = matchIgnores(here, abs, isDir, global);
        if (ig === 'ignore') continue;
        if (ig !== 'whitelist' && !opts.includeHidden && name.startsWith('.')) continue;
      }

      if (isDir) await visit(abs, here);
      else await onFile(abs);
      if (ctl.stopped()) return;
      await yielder.maybe();
    }
  };

  await visit(opts.root, chain);
}

// ---------------------------------------------------------------------------------------------
// Content search
// ---------------------------------------------------------------------------------------------

export interface ContentSink {
  /** Returns false once the result cap is reached (the engine then only drains trailing context). */
  addMatch(file: string, line: number, text: string, col: number): boolean;
  addContext(file: string, line: number, text: string): void;
  /** False once no further files are wanted (cap reached or stopped). */
  wantsMore(): boolean;
}

export interface ContentOptions extends WalkOptions {
  regex: RegExp;
  contextLines: number;
}

/**
 * Builds the per-line regex. Unicode mode is preferred (\p{..}, astral characters) but patterns
 * with escapes that are only legal outside it (e.g. `\-`, `\"`) still work.
 * Throws `regex parse error: ...` for an invalid pattern, like ripgrep.
 */
export function buildContentRegex(pattern: string, opts: { literal: boolean; ignoreCase: boolean }): RegExp {
  let source = opts.literal ? pattern.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&') : pattern;
  let flags = opts.ignoreCase ? 'i' : '';
  // Rust-style leading inline flags, e.g. '(?i)todo', which JS only supports as flags.
  const inline = opts.literal ? null : /^\(\?([ims]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    for (const f of new Set(inline[1])) if (!flags.includes(f)) flags += f;
  }
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    try {
      return new RegExp(source, flags);
    } catch (err) {
      throw new Error(`regex parse error: ${(err as Error).message}`);
    }
  }
}

type ScanOutcome = 'continue' | 'stop';

async function scanText(
  file: string,
  text: string,
  opts: ContentOptions,
  sink: ContentSink,
  ctl: WalkControl,
  yielder: Yielder,
  quick: RegExp | null,
): Promise<ScanOutcome> {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (quick) {
    quick.lastIndex = 0;
    if (!quick.test(text)) return 'continue'; // cheap whole-file reject (false positives only)
  }

  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const ctx = opts.contextLines;
  const regex = opts.regex;
  let lastEmitted = -1;
  let afterRemaining = 0;
  let draining = false;

  for (let i = 0; i < lines.length; i++) {
    if ((i & 1023) === 1023) {
      if (ctl.stopped()) return 'stop';
      await yielder.maybe();
      if (ctl.stopped()) return 'stop';
    }
    const line = lines[i];
    const m = regex.exec(line);
    if (m) {
      if (draining) return 'stop';
      for (let j = Math.max(lastEmitted + 1, i - ctx); j < i; j++) sink.addContext(file, j + 1, stripCr(lines[j]));
      const more = sink.addMatch(file, i + 1, stripCr(line), m.index);
      lastEmitted = i;
      afterRemaining = ctx;
      if (!more) {
        if (ctx === 0) return 'stop';
        draining = true;
      }
    } else if (afterRemaining > 0) {
      sink.addContext(file, i + 1, stripCr(line));
      lastEmitted = i;
      afterRemaining--;
      if (draining && afterRemaining === 0) return 'stop';
    }
  }
  return draining ? 'stop' : 'continue';
}

/**
 * A file's text, decoded the way ripgrep's default encoding detection does: a UTF-16 LE/BE
 * byte-order mark selects UTF-16 (whose ASCII text is full of NUL bytes, so the binary check
 * runs on the decoded text), anything else is UTF-8. Returns null for binary content when
 * `binaryCheck` is set.
 */
function decodeFile(buf: Buffer, binaryCheck: boolean): string | null {
  let encoding: 'utf-16le' | 'utf-16be' | null = null;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) encoding = 'utf-16le';
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) encoding = 'utf-16be';
  if (!encoding) {
    if (binaryCheck && buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
    return buf.toString('utf8');
  }
  const text = new TextDecoder(encoding, { ignoreBOM: true }).decode(buf.subarray(2));
  if (binaryCheck && text.slice(0, BINARY_SNIFF_BYTES).includes('\0')) return null;
  return text;
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Content search over the files walkFiles lists. */
export async function searchContent(opts: ContentOptions, ctl: WalkControl, sink: ContentSink): Promise<void> {
  const yielder = new Yielder();
  // Whole-file pre-check. Anchors and \b behave the same at line boundaries in both forms, but a
  // lookaround would see the neighbouring lines, so patterns with one are only tested per line.
  const quick = /\(\?<?[=!]/.test(opts.regex.source)
    ? null
    : new RegExp(opts.regex.source, opts.regex.flags.includes('m') ? opts.regex.flags : `${opts.regex.flags}m`);
  const rootStat = await fs.stat(opts.root);
  const explicitFile = !rootStat.isDirectory();
  let batch: string[] = [];
  let done = false;

  const flush = async (): Promise<void> => {
    const files = batch;
    batch = [];
    if (done || files.length === 0) return;
    // Small files are read concurrently; big ones one at a time, so a batch never holds more
    // than READ_BATCH * PREFETCH_MAX_BYTES + MAX_FILE_BYTES in memory.
    const contents = await Promise.all(
      files.map(async (file): Promise<Buffer | 'later' | null> => {
        try {
          const st = await fs.stat(file);
          if (st.size > MAX_FILE_BYTES) {
            if (explicitFile) ctl.warn(`${file}: larger than 10 MB, not searched by the built-in engine`);
            return null;
          }
          return st.size > PREFETCH_MAX_BYTES ? 'later' : await fs.readFile(file);
        } catch (err) {
          ctl.warn(errorText(err, file));
          return null;
        }
      }),
    );
    for (let k = 0; k < files.length; k++) {
      if (done || ctl.stopped() || !sink.wantsMore()) {
        done = true;
        return;
      }
      let buf = contents[k];
      contents[k] = null;
      if (buf === 'later') {
        try {
          buf = await fs.readFile(files[k]);
        } catch (err) {
          ctl.warn(errorText(err, files[k]));
          buf = null;
        }
        if (done || ctl.stopped()) return;
      }
      if (!buf) continue;
      const text = decodeFile(buf, !explicitFile);
      if (text === null) continue;
      const outcome = await scanText(files[k], text, opts, sink, ctl, yielder, quick);
      if (outcome === 'stop') {
        done = true;
        return;
      }
      await yielder.maybe();
    }
  };

  await walkFiles(
    opts,
    { stopped: () => done || ctl.stopped() || !sink.wantsMore(), warn: (m) => ctl.warn(m) },
    async (file) => {
      batch.push(file);
      if (batch.length >= READ_BATCH) await flush();
    },
  );
  await flush();
}
