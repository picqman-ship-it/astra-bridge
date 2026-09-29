import { accessSync, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../types.js';
import { FileGlobs, NameMatcher, splitFilePatterns, toSlash } from './glob.js';
import {
  buildContentArgs,
  buildFilesArgs,
  markRipgrepUnusable,
  parseRgJsonLine,
  resolveRipgrepPath,
  runRipgrep,
} from './ripgrep.js';
import { buildContentRegex, searchContent, walkFiles, type ContentSink, type WalkControl } from './walker.js';

/**
 * Search sessions: a search runs in the background (ripgrep child process, or the built-in
 * walker) and its results accumulate in a bounded array that tools page through.
 */

export type SearchType = 'files' | 'content';
export type SearchStatus = 'running' | 'completed' | 'error' | 'stopped';
export type SearchEngine = 'ripgrep' | 'built-in';
export type StopReason = 'user' | 'timeout' | 'limit' | 'early' | 'shutdown';

export interface SearchResult {
  type: 'file' | 'dir' | 'match' | 'context';
  /** Absolute path (for 'dir': the directory, without a trailing slash). */
  file: string;
  line?: number;
  /** The line's text without its newline (possibly a window of a very long line). */
  text?: string;
  /** 'match': index of the first match within `text`, when known. */
  col?: number;
  /** `text` was cut at its start / end when stored. */
  cutStart?: boolean;
  cutEnd?: boolean;
}

export interface SearchOptions {
  /** Absolute, validated path to search (directory or file). */
  root: string;
  /** The path as the caller gave it (echoed in output). */
  displayPath: string;
  pattern: string;
  searchType: SearchType;
  filePattern?: string;
  ignoreCase: boolean;
  maxResults: number;
  includeHidden: boolean;
  contextLines: number;
  timeoutMs?: number;
  literalSearch: boolean;
  earlyTermination: boolean;
}

export const DEFAULT_MAX_RESULTS = 5000;
export const MAX_RESULTS_LIMIT = 50000;
export const MAX_CONTEXT_LINES = 10;
export const HARD_TIMEOUT_MS = 10 * 60 * 1000;
export const RETENTION_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
/** Longest stored line text; display truncates further (200 chars). */
const STORED_TEXT_MAX = 400;
/** Absolute ceiling on stored entries per session (matches + context + dirs). */
const HARD_RESULT_CAP = 200_000;
/** Completed sessions beyond this many are dropped, oldest first. */
const MAX_SESSIONS = 100;
/**
 * Spawn failures that say nothing about the ripgrep binary (resource limits, a pattern too long
 * for the command line): the search falls back to the built-in engine, later ones still use rg.
 */
const TRANSIENT_SPAWN_ERRORS = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM', 'E2BIG', 'ENAMETOOLONG']);

/** rg runs with the search root as its cwd, so a root that cannot be entered makes spawn fail. */
function canEnter(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The file named in the beginning of an rg --json event (for a dropped, overlong line). */
function pathInJsonHead(head: string): string | null {
  const m = /"path":\{"(text|bytes)":"((?:[^"\\]|\\.)*)"/.exec(head);
  if (!m) return null;
  try {
    const value = JSON.parse(`"${m[2]}"`) as string;
    return m[1] === 'bytes' ? Buffer.from(value, 'base64').toString('utf8') : value;
  } catch {
    return null;
  }
}

function safeSlice(text: string, start: number, end: number): string {
  // Never split a surrogate pair.
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) start--;
  if (end < text.length && end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Stores at most STORED_TEXT_MAX chars, keeping the match inside the window. */
function storedLine(type: 'match' | 'context', file: string, line: number, text: string, col?: number): SearchResult {
  if (text.length <= STORED_TEXT_MAX) return { type, file, line, text, ...(col !== undefined ? { col } : {}) };
  let start = 0;
  if (col !== undefined && col > STORED_TEXT_MAX - 250) start = Math.max(0, col - 100);
  const end = Math.min(text.length, start + STORED_TEXT_MAX);
  const window = safeSlice(text, start, end);
  const realStart = start > 0 && isLowSurrogate(text.charCodeAt(start)) ? start - 1 : start;
  return {
    type,
    file,
    line,
    text: window,
    ...(col !== undefined ? { col: col - realStart } : {}),
    cutStart: realStart > 0,
    cutEnd: realStart + window.length < text.length,
  };
}

/** Keeps engine error text short: a huge pattern would otherwise be echoed back in full. */
function clipMessage(text: string, max = 1000): string {
  if (text.length <= max) return text;
  return `${safeSlice(text, 0, max - 300)} … ${safeSlice(text, text.length - 280, text.length)}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SearchSession implements ContentSink {
  readonly id: string;
  readonly options: SearchOptions;
  engine: SearchEngine;
  readonly results: SearchResult[] = [];
  /** Matches (content) or file + dir hits (files). */
  matchCount = 0;
  contextCount = 0;
  status: SearchStatus = 'running';
  error?: string;
  /** Problems worth showing (unreadable files, etc.). */
  readonly warnings: string[] = [];
  /** Informational lines (engine fallback). */
  readonly notes: string[] = [];
  readonly startTime = Date.now();
  endTime?: number;
  lastReadTime = Date.now();
  limitReached = false;
  timedOut = false;
  earlyTerminated = false;
  stopReason?: StopReason;
  readonly timeoutMs: number;
  readonly done: Promise<void>;

  /** Directory results are derived from file paths, so both engines report the same dirs. */
  readonly rootDir: string;
  private readonly matcher: NameMatcher | null;
  /** files mode: filePattern globs, which directory hits must satisfy too. */
  private readonly dirGlobs: FileGlobs | null;
  private readonly seenDirs = new Set<string>();
  private capped = false;
  private lastMatch: { file: string; line: number } | null = null;
  private failCount = 0;
  private firstFailure: string | null = null;
  private resolveDone!: () => void;
  private timer: NodeJS.Timeout | null = null;
  /** Engine-specific termination (kills rg; the walker stops by polling `status`). */
  kill: () => void = () => {};

  constructor(id: string, options: SearchOptions, engine: SearchEngine, rootIsDir: boolean) {
    this.id = id;
    this.options = options;
    this.engine = engine;
    this.rootDir = rootIsDir ? options.root : path.dirname(options.root);
    this.matcher = options.searchType === 'files' ? new NameMatcher(options.pattern, options.ignoreCase) : null;
    let dirGlobs: FileGlobs | null = null;
    if (this.matcher && rootIsDir) {
      try {
        const globs = splitFilePatterns(options.filePattern);
        if (globs.length) dirGlobs = new FileGlobs(globs);
      } catch {
        dirGlobs = null; // an invalid glob fails the engine itself, with its own message
      }
    }
    this.dirGlobs = dirGlobs;
    this.timeoutMs =
      options.timeoutMs && options.timeoutMs > 0 ? Math.min(options.timeoutMs, HARD_TIMEOUT_MS) : HARD_TIMEOUT_MS;
    this.done = new Promise<void>((resolve) => (this.resolveDone = resolve));
  }

  get isComplete(): boolean {
    return this.status !== 'running';
  }

  get runtimeMs(): number {
    return (this.endTime ?? Date.now()) - this.startTime;
  }

  armTimeout(onTimeout: () => void): void {
    this.timer = setTimeout(onTimeout, this.timeoutMs);
    this.timer.unref();
  }

  private push(result: SearchResult): void {
    this.results.push(result);
    if (this.results.length >= HARD_RESULT_CAP) this.capped = true;
  }

  // ----- files mode -------------------------------------------------------------------------

  /** A file listed by the engine. Returns false once the engine should stop. */
  addFile(abs: string): boolean {
    if (this.status !== 'running' || !this.matcher) return false;
    const rel = toSlash(path.relative(this.rootDir, abs));
    const parts = rel.split('/');
    let dirRel = '';
    for (let i = 0; i < parts.length - 1; i++) {
      dirRel = dirRel ? `${dirRel}/${parts[i]}` : parts[i];
      if (this.seenDirs.has(dirRel)) continue;
      this.seenDirs.add(dirRel);
      if (this.matcher.matches(dirRel, parts[i], true) && (!this.dirGlobs || this.dirGlobs.acceptsDir(dirRel))) {
        this.push({ type: 'dir', file: path.join(this.rootDir, dirRel) });
        this.matchCount++;
        if (this.matchCount >= this.options.maxResults || this.capped) {
          this.capped = true;
          this.requestStop('limit');
          return false;
        }
      }
    }
    const name = parts[parts.length - 1];
    if (this.matcher.matches(rel, name, false)) {
      this.push({ type: 'file', file: abs });
      this.matchCount++;
      if (this.options.earlyTermination && this.matcher.isExact(rel, name)) {
        this.requestStop('early');
        return false;
      }
      if (this.matchCount >= this.options.maxResults || this.capped) {
        this.capped = true;
        this.requestStop('limit');
        return false;
      }
    }
    return true;
  }

  // ----- content mode -----------------------------------------------------------------------

  addMatch(file: string, line: number, text: string, col?: number): boolean {
    if (this.status !== 'running') return false;
    if (this.capped) {
      this.requestStop('limit');
      return false;
    }
    this.push(storedLine('match', file, line, text, col));
    this.matchCount++;
    if (this.matchCount >= this.options.maxResults || this.capped) {
      // Keep the trailing context of this last match, then stop.
      this.capped = true;
      this.lastMatch = { file, line };
      if (this.options.contextLines === 0) this.requestStop('limit');
      return false;
    }
    return true;
  }

  addContext(file: string, line: number, text: string): void {
    if (this.status !== 'running') return;
    if (this.capped) {
      const last = this.lastMatch;
      const ctx = this.options.contextLines;
      if (!last || file !== last.file || line <= last.line || line > last.line + ctx) {
        this.requestStop('limit');
        return;
      }
      this.results.push(storedLine('context', file, line, text));
      this.contextCount++;
      if (line === last.line + ctx) this.requestStop('limit');
      return;
    }
    this.push(storedLine('context', file, line, text));
    this.contextCount++;
  }

  wantsMore(): boolean {
    return this.status === 'running' && !this.capped;
  }

  /** True once the cap has been hit (the engine may still be draining trailing context). */
  get isCapped(): boolean {
    return this.capped;
  }

  // ----- lifecycle --------------------------------------------------------------------------

  addFailure(message: string): void {
    this.failCount++;
    this.firstFailure ??= message;
  }

  addFailures(messages: string[]): void {
    for (const m of messages) this.addFailure(m);
  }

  requestStop(reason: StopReason): void {
    if (this.status !== 'running') return;
    this.stopReason ??= reason;
    this.finish();
  }

  /**
   * Ends the session (idempotent). An engine error becomes the session error only when there
   * are no results; otherwise it is kept as a warning next to the results.
   */
  finish(outcome: { error?: string } = {}): void {
    if (this.status !== 'running') return;
    this.endTime = Date.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const reason = this.stopReason;
    if (reason === 'user' || reason === 'shutdown' || reason === 'timeout') {
      this.status = 'stopped';
      if (reason === 'timeout') this.timedOut = true;
    } else if (outcome.error && this.results.length === 0) {
      this.status = 'error';
      this.error = clipMessage(outcome.error);
    } else {
      this.status = 'completed';
      if (outcome.error) this.warnings.push(clipMessage(outcome.error));
    }
    if (reason === 'limit' || this.capped) this.limitReached = true;
    if (reason === 'early') this.earlyTerminated = true;
    if (this.failCount > 0 && this.status !== 'error') {
      this.warnings.push(
        `Some files could not be searched: ${clipMessage(this.firstFailure ?? '')}` +
          (this.failCount > 1 ? ` (and ${this.failCount - 1} more)` : ''),
      );
    }
    try {
      this.kill();
    } catch {
      /* ignore */
    }
    this.resolveDone();
  }
}

export class SearchManager {
  private readonly sessions = new Map<string, SearchSession>();
  private counter = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly rgPathOption: string | null | undefined;
  private readonly rgMaxLineChars: number | undefined;

  /**
   * rgPath: a ripgrep binary to use; null forces the built-in engine; undefined auto-resolves.
   * rgMaxLineChars: longest ripgrep output line processed (tests lower it).
   */
  constructor(opts: { rgPath?: string | null; rgMaxLineChars?: number } = {}) {
    this.rgPathOption = opts.rgPath;
    this.rgMaxLineChars = opts.rgMaxLineChars;
  }

  private async ripgrepPath(): Promise<string | null> {
    if (this.rgPathOption === null) return null;
    if (typeof this.rgPathOption === 'string') return this.rgPathOption;
    return resolveRipgrepPath();
  }

  /** Starts a search and returns its session immediately (use waitFor to await results). */
  async start(options: SearchOptions): Promise<SearchSession> {
    let rootIsDir: boolean;
    try {
      rootIsDir = (await fs.stat(options.root)).isDirectory();
    } catch {
      throw new ToolError(`Path not found: ${options.displayPath}`);
    }
    const rgPath = await this.ripgrepPath();
    const id = `search_${++this.counter}_${Date.now()}`;
    const session = new SearchSession(id, options, rgPath ? 'ripgrep' : 'built-in', rootIsDir);
    this.sessions.set(id, session);
    this.prune();
    this.ensureCleanup();
    session.armTimeout(() => session.requestStop('timeout'));
    if (rgPath) this.runRipgrep(session, rgPath, rootIsDir);
    else this.runBuiltin(session, rootIsDir);
    return session;
  }

  /** Resolves when the session completes or `ms` pass, whichever is first. */
  async waitFor(session: SearchSession, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([session.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    if (timer) clearTimeout(timer);
  }

  get(id: string): SearchSession | undefined {
    return this.sessions.get(id);
  }

  /** Like get(), but marks the session as read (keeps it from being cleaned up). */
  read(id: string): SearchSession | undefined {
    const s = this.sessions.get(id);
    if (s) s.lastReadTime = Date.now();
    return s;
  }

  stop(id: string): 'stopped' | 'already-complete' | 'not-found' {
    const s = this.sessions.get(id);
    if (!s) return 'not-found';
    if (s.isComplete) return 'already-complete';
    s.requestStop('user');
    return 'stopped';
  }

  list(): SearchSession[] {
    return [...this.sessions.values()];
  }

  /** Stops overdue searches and forgets completed sessions nobody has read for RETENTION_MS. */
  cleanup(now = Date.now()): void {
    for (const [id, s] of this.sessions) {
      if (!s.isComplete) {
        if (now - s.startTime >= s.timeoutMs) s.requestStop('timeout');
        continue;
      }
      const lastTouched = Math.max(s.lastReadTime, s.endTime ?? 0);
      if (now - lastTouched > RETENTION_MS) this.sessions.delete(id);
    }
  }

  /** Kills every running search and clears timers. */
  shutdown(): void {
    for (const s of this.sessions.values()) s.requestStop('shutdown');
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private ensureCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  private prune(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    for (const [id, s] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      if (s.isComplete) this.sessions.delete(id);
    }
  }

  // ----- engines ----------------------------------------------------------------------------

  private runRipgrep(session: SearchSession, rgPath: string, rootIsDir: boolean): void {
    const o = session.options;
    const fileGlobs = rootIsDir ? splitFilePatterns(o.filePattern) : [];
    const base = { root: o.root, includeHidden: o.includeHidden, fileGlobs };
    const content = o.searchType === 'content';
    const args = content
      ? buildContentArgs({
          ...base,
          pattern: o.pattern,
          ignoreCase: o.ignoreCase,
          contextLines: o.contextLines,
          literalSearch: o.literalSearch,
        })
      : buildFilesArgs(base);
    // cwd = the search root, so rg anchors slash-containing globs (e.g. 'src/*.ts') to it.
    const cwd = session.rootDir;
    let listed = 0;
    let summarySearches: number | null = null;

    const handle = runRipgrep(rgPath, args, cwd, {
      onLine: (line) => {
        if (session.status !== 'running') return;
        if (!content) {
          if (!line) return;
          listed++;
          session.addFile(path.resolve(cwd, line));
          return;
        }
        const ev = parseRgJsonLine(line);
        if (!ev) return;
        if (ev.kind === 'match') session.addMatch(path.resolve(cwd, ev.file), ev.line, ev.text, ev.col);
        else if (ev.kind === 'context') session.addContext(path.resolve(cwd, ev.file), ev.line, ev.text);
        else if (ev.kind === 'summary') summarySearches = ev.searches;
      },
      onChunkEnd: () => {
        // Cap reached and this chunk's trailing context consumed: no need for more output.
        if (session.status === 'running' && session.isCapped) session.requestStop('limit');
      },
      onExit: ({ code, signal, stderrLines }) => {
        if (session.status !== 'running') return;
        if (code === 0 || code === 1) {
          session.finish();
          return;
        }
        const stderrText = stderrLines.join('\n');
        if (code === 2) {
          // rg exits 2 for any error. It searched something if it listed files, found
          // matches, reports completed searches, or complains about a path inside the root
          // (the root itself was readable: like the built-in engine, that is only a warning);
          // otherwise the whole search failed (bad regex, bad glob, unreadable root) and
          // stderr says why.
          const inside = session.rootDir.endsWith(path.sep) ? session.rootDir : session.rootDir + path.sep;
          const searched =
            (content ? session.results.length > 0 || (summarySearches ?? 0) > 0 : listed > 0) ||
            stderrLines.some((l) => l.startsWith(inside));
          if (searched) {
            session.addFailures(stderrLines);
            session.finish();
          } else {
            session.finish({ error: stderrText || 'ripgrep failed (exit code 2)' });
          }
          return;
        }
        session.finish({
          error: `ripgrep exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})${stderrText ? `: ${stderrText}` : ''}`,
        });
      },
      onSpawnError: (err, hadOutput) => {
        if (session.status !== 'running') return;
        if (hadOutput) {
          session.finish({ error: `ripgrep failed: ${err.message}` });
          return;
        }
        // Fall back instead of failing the search. Only a failure of the binary itself (not a
        // root that cannot be entered, not a resource limit) keeps later searches off ripgrep.
        session.engine = 'built-in';
        if (!canEnter(cwd)) {
          session.notes.push('ripgrep cannot run in the search directory (it cannot be entered); used the built-in engine.');
        } else if (TRANSIENT_SPAWN_ERRORS.has((err as NodeJS.ErrnoException).code ?? '')) {
          session.notes.push(`ripgrep could not be started for this search (${err.message}); used the built-in engine.`);
        } else {
          markRipgrepUnusable(rgPath);
          session.notes.push(`ripgrep (${rgPath}) could not be started (${err.message}); used the built-in engine.`);
        }
        this.runBuiltin(session, rootIsDir);
      },
      onLongLine: (head, length) => {
        if (session.status !== 'running') return;
        const size = length >= 1024 * 1024 ? `${Math.round(length / (1024 * 1024))} MB` : `${Math.ceil(length / 1024)} KB`;
        const file = content ? pathInJsonHead(head) : null;
        session.addFailure(`${file ?? 'ripgrep output'}: a line of about ${size} is too long to report; skipped`);
      },
    }, { maxLineChars: this.rgMaxLineChars });
    session.kill = () => handle.kill();
  }

  private runBuiltin(session: SearchSession, rootIsDir: boolean): void {
    const o = session.options;
    const ctl: WalkControl = {
      stopped: () => session.status !== 'running',
      warn: (m) => session.addFailure(m),
    };
    const walkOpts = {
      root: o.root,
      includeHidden: o.includeHidden,
      fileGlobs: rootIsDir ? splitFilePatterns(o.filePattern) : [],
    };
    session.kill = () => {}; // cooperative: the walker polls session.status
    const task =
      o.searchType === 'files'
        ? walkFiles(walkOpts, ctl, (abs) => {
            session.addFile(abs);
          })
        : (async () => {
            const regex = buildContentRegex(o.pattern, { literal: o.literalSearch, ignoreCase: o.ignoreCase });
            await searchContent({ ...walkOpts, regex, contextLines: o.contextLines }, ctl, session);
          })();
    task.then(
      () => session.finish(),
      (err) => session.finish({ error: messageOf(err) }),
    );
  }
}
