import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { detectPrompt } from './prompt.js';
import type { SpawnSpec } from './shell.js';
import { groupExists, processTable, signalGroups, trackDescendantGroups, type JobGroups } from './tree.js';

/**
 * Terminal sessions: child processes started by start_process, their merged output and the
 * read cursor the model advances through it.
 *
 * Fixes relative to Desktop Commander:
 *  - the read cursor is an absolute character offset, so text appended to an already-read
 *    partial line is never lost (the original's line-index cursor dropped it);
 *  - sessions are finalized on 'close' (all stdio flushed), not 'exit';
 *  - output is decoded with a streaming UTF-8 decoder (no split multibyte characters) and ANSI
 *    escapes are stripped on ingest, also when a sequence is split across chunks;
 *  - POSIX children get their own process group, so terminating a session also kills the
 *    pipelines and background jobs it started, and shutdown() leaves no orphans;
 *  - terminating escalates SIGINT -> EOF -> SIGTERM -> SIGKILL, so REPLs and interactive shells
 *    (which catch SIGINT) exit cleanly on EOF instead of always being SIGKILLed after 1s, and it
 *    also signals the process groups a job-control shell moved its jobs into (no orphans);
 *  - stdin write errors (EPIPE) can never crash the server.
 */

const isWindows = process.platform === 'win32';

export const MAX_BUFFER_CHARS = 10 * 1024 * 1024;
export const COMPLETED_TAIL_CHARS = 1024 * 1024;
export const MAX_COMPLETED_SESSIONS = 100;
/** Output must be quiet this long before a prompt-shaped last line counts as "waiting for input". */
export const QUIET_MS = 100;
/**
 * After the direct child exits, 'close' normally follows within milliseconds. If it has not come
 * this long after 'exit' (and output is quiet), a background process holds the output pipe open
 * and the command itself counts as finished for the wait phases.
 */
export const EXIT_GRACE_MS = 250;
/** How long terminate() waits after each escalation step before taking the next one. */
export const TERMINATE_STEP_MS = 1000;
/** How much of the last unterminated line is kept for prompt detection (prompts are <= 200 chars). */
const TAIL_KEEP = 512;
/** Longest escape sequence held back while waiting for the rest of it to arrive. */
const MAX_ESCAPE_CARRY = 4096;

// ---------------------------------------------------------------------------------------------
// Text cleanup
// ---------------------------------------------------------------------------------------------

/* eslint-disable no-control-regex */
/** CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings, other ESC sequences, 8-bit CSI. */
const ANSI_SOURCE =
  '\\x1b\\[[0-?]*[ -/]*[@-~]' +
  '|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)' +
  '|\\x1b[PX^_][^\\x1b]*\\x1b\\\\' +
  '|\\x1b[ -/]*[0-~]' +
  '|\\x9b[0-?]*[ -/]*[@-~]';
const ANSI_RE = new RegExp(ANSI_SOURCE, 'g');
const ANSI_AT_RE = new RegExp(ANSI_SOURCE, 'y');
/**
 * An escape sequence that has started but not finished at the end of the text: a lone ESC, a
 * CSI still in its parameter/intermediate bytes, an OSC/DCS/SOS/PM/APC string without its
 * terminator yet (possibly ending in the ESC of ESC-backslash), or ESC + intermediates.
 */
const INCOMPLETE_AT_RE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b\n]*\x1b?|[PX^_][^\x1b\n]*\x1b?|[ -/]*)$/y;
/** C0 controls other than \t \n \r (ESC is handled above), plus DEL. */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/**
 * Backspace erases the character before it, as on a terminal: man/groff overstrikes ("N\bN" for
 * bold, "_\bx" for underline) come out as plain text instead of "NNAAMMEE", and \b spinners
 * collapse to their last frame. A backspace at the start of a line has nothing to erase.
 */
function applyBackspaces(s: string): string {
  if (!s.includes('\b')) return s;
  const out: string[] = [];
  for (const ch of s) {
    if (ch !== '\b') out.push(ch);
    else if (out.length && out[out.length - 1] !== '\n' && out[out.length - 1] !== '\r') out.pop();
  }
  return out.join('');
}

export function stripAnsi(text: string): string {
  return applyBackspaces(text.replace(ANSI_RE, '').replace(/\x1b/g, '')).replace(CONTROL_RE, '');
}

/** Index where an unfinished escape sequence at the end of `s` starts, or -1. */
export function incompleteEscapeStart(s: string): number {
  let i = s.indexOf('\x1b', Math.max(0, s.length - MAX_ESCAPE_CARRY));
  while (i !== -1) {
    INCOMPLETE_AT_RE.lastIndex = i;
    if (INCOMPLETE_AT_RE.test(s)) return i;
    ANSI_AT_RE.lastIndex = i;
    const next = ANSI_AT_RE.test(s) ? ANSI_AT_RE.lastIndex : i + 1;
    i = s.indexOf('\x1b', next);
  }
  return -1;
}

/**
 * Per-stream cleaner: strips escape sequences and normalizes CRLF, holding back an escape
 * sequence (or a '\r') cut off at the end of a chunk until the next chunk completes it.
 */
export class StreamCleaner {
  private carry = '';

  push(chunk: string): string {
    let s = this.carry + chunk;
    this.carry = '';
    const esc = incompleteEscapeStart(s);
    if (esc !== -1) {
      this.carry = s.slice(esc);
      s = s.slice(0, esc);
    }
    if (s.endsWith('\r')) {
      this.carry = '\r' + this.carry;
      s = s.slice(0, -1);
    }
    return this.clean(s);
  }

  /** End of stream: whatever is held back is emitted (an unfinished escape is dropped). */
  flush(): string {
    let s = this.carry;
    this.carry = '';
    if (!s) return '';
    const esc = incompleteEscapeStart(s);
    if (esc !== -1) s = s.slice(0, esc);
    return this.clean(s);
  }

  private clean(s: string): string {
    return stripAnsi(s).replace(/\r\n/g, '\n');
  }
}

// ---------------------------------------------------------------------------------------------
// Line helpers (a "line" is text up to and including '\n'; a trailing unterminated piece is a
// line too, and a final '\n' does not start an extra empty line)
// ---------------------------------------------------------------------------------------------

export function countNewlines(s: string, from = 0, to = s.length): number {
  let n = 0;
  let i = s.indexOf('\n', from);
  while (i !== -1 && i < to) {
    n++;
    i = s.indexOf('\n', i + 1);
  }
  return n;
}

export function countLines(s: string, from = 0): number {
  if (from >= s.length) return 0;
  return countNewlines(s, from) + (s.endsWith('\n') ? 0 : 1);
}

/** Index just past the first `max` lines of s[from..], and how many lines that is. */
export function advanceLines(s: string, from: number, max: number): { end: number; lines: number } {
  let pos = from;
  let lines = 0;
  while (lines < max && pos < s.length) {
    const nl = s.indexOf('\n', pos);
    lines++;
    if (nl === -1) {
      pos = s.length;
      break;
    }
    pos = nl + 1;
  }
  return { end: pos, lines };
}

export function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (s.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * Text as a model should see it: without the final newline, and with carriage-return
 * overwrites (progress bars) collapsed to what a terminal would finally show on that line.
 */
export function displayText(s: string): string {
  const body = s.endsWith('\n') ? s.slice(0, -1) : s;
  if (!body.includes('\r')) return body;
  return body
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r').filter((p) => p !== '');
      return parts.length ? parts[parts.length - 1] : '';
    })
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Output buffer
// ---------------------------------------------------------------------------------------------

/**
 * Append-only text with absolute character accounting. Offsets handed out (cursor, snapshots)
 * stay valid after eviction: `evictedChars` is the absolute offset of the first retained char.
 */
export class OutputBuffer {
  private text = '';
  private pending: string[] = [];
  private pendingChars = 0;
  private tail = '';
  evictedChars = 0;
  evictedLines = 0;

  constructor(readonly cap: number = MAX_BUFFER_CHARS) {}

  /** Absolute offset of the first retained character. */
  get start(): number {
    return this.evictedChars;
  }

  /** Absolute offset just past the last character ever appended. */
  get end(): number {
    return this.evictedChars + this.text.length + this.pendingChars;
  }

  append(s: string): void {
    if (!s) return;
    this.pending.push(s);
    this.pendingChars += s.length;
    const nl = s.lastIndexOf('\n');
    this.tail = nl === -1 ? this.tail + s : s.slice(nl + 1);
    if (this.tail.length > TAIL_KEEP) this.tail = this.tail.slice(-TAIL_KEEP);
    if (this.text.length + this.pendingChars > this.cap) {
      // Evict a little more than needed so a steady stream does not re-slice on every chunk.
      this.shrinkTo(this.cap - Math.floor(this.cap / 10));
    }
  }

  /** The retained text (flattened on demand; appends are O(1)). */
  retained(): string {
    if (this.pending.length) {
      this.text += this.pending.join('');
      this.pending = [];
      this.pendingChars = 0;
    }
    return this.text;
  }

  /** The last unterminated line (after the last '\n' and the last '\r'); '' after a newline. */
  lastLine(): string {
    const cr = this.tail.lastIndexOf('\r');
    return cr === -1 ? this.tail : this.tail.slice(cr + 1);
  }

  /** Evicts the oldest whole lines until at most maxChars remain (mid-line only for a giant line). */
  shrinkTo(maxChars: number): void {
    const t = this.retained();
    if (t.length <= maxChars) return;
    const excess = t.length - Math.max(0, maxChars);
    let cut = excess > 0 ? t.indexOf('\n', excess - 1) : -1;
    cut = cut === -1 ? excess : cut + 1;
    this.evictedLines += countNewlines(t, 0, cut);
    this.evictedChars += cut;
    this.text = t.slice(cut);
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

export interface ReadSlice {
  /** Raw text returned (may end with '\n'). */
  text: string;
  /** Number of lines in `text`. */
  lines: number;
  /** 0-based index (in the retained buffer) of the line `text` starts in. */
  fromLine: number;
  /** Lines in the retained buffer. */
  totalLines: number;
  /** Lines after the returned text. */
  remainingLines: number;
  /** Absolute offset just past `text`. */
  end: number;
  /** True when the requested start had already been evicted (unread output was lost). */
  lostEvicted: boolean;
}

export class Session {
  readonly pid: number;
  readonly command: string;
  readonly shell: string;
  readonly cwd: string;
  readonly startTime = Date.now();
  readonly buffer: OutputBuffer;
  /** Absolute offset of the first character the model has not seen yet. */
  cursor = 0;
  /** Buffer end (absolute offset) when input was last written to stdin; null before any input. */
  inputAt: number | null = null;
  lastOutputAt = Date.now();
  endTime: number | null = null;
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  /** 'exit' seen: the direct child is gone, but a background process may still hold stdout. */
  exited = false;
  exitedAt: number | null = null;
  /** 'close' seen: process gone and all of its output has been read. */
  closed = false;
  error: string | null = null;
  child: ChildProcess | null;
  private waiters = new Set<() => void>();

  constructor(child: ChildProcess, pid: number, opts: { command: string; shell: string; cwd: string; cap: number }) {
    this.child = child;
    this.pid = pid;
    this.command = opts.command;
    this.shell = opts.shell;
    this.cwd = opts.cwd;
    this.buffer = new OutputBuffer(opts.cap);
  }

  get runtimeMs(): number {
    return (this.endTime ?? Date.now()) - this.startTime;
  }

  ingest(text: string): void {
    if (!text) return;
    this.buffer.append(text);
    this.lastOutputAt = Date.now();
    this.notify();
  }

  /**
   * True when the direct child exited a while ago but the session is not closed, because a
   * background process it started still holds stdout/stderr open.
   */
  exitSettled(): boolean {
    if (!this.exited || this.closed || this.exitedAt === null) return false;
    const now = Date.now();
    return now - this.exitedAt >= EXIT_GRACE_MS && now - this.lastOutputAt >= QUIET_MS;
  }

  /** The detected prompt when the process sits at an input prompt after >= QUIET_MS of quiet. */
  waitingPrompt(): string | null {
    // Once input was sent, a prompt printed before it has been answered: only output that came
    // after the input can show the next prompt.
    return this.promptSince(this.inputAt);
  }

  /**
   * Like waitingPrompt(), but only output after absolute offset `from` can show the prompt
   * (null: any output). Input is not echoed (no TTY), so a new prompt may continue an older
   * prompt's line ("val: >>> ", "$ $ ") — only its new part counts.
   */
  promptSince(from: number | null): string | null {
    if (this.exited) return null; // nothing is left to read stdin (a prompt-shaped last line is stale)
    const fresh = from === null ? Infinity : this.buffer.end - from;
    if (fresh <= 0) return null;
    if (Date.now() - this.lastOutputAt < QUIET_MS) return null;
    const line = this.buffer.lastLine();
    return detectPrompt(fresh < line.length ? line.slice(-fresh) : line);
  }

  notify(): void {
    for (const w of [...this.waiters]) w();
  }

  /**
   * Resolves true as soon as `pred()` holds (checked on every output chunk / state change and
   * every `tickMs`), or with the final value of `pred()` after `timeoutMs`. All timers are
   * cleared on resolution.
   */
  waitUntil(pred: () => boolean, timeoutMs: number, tickMs = 50): Promise<boolean> {
    if (pred()) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      let interval: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearInterval(interval);
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(value);
      };
      const check = () => {
        if (pred()) finish(true);
      };
      this.waiters.add(check);
      interval = setInterval(check, tickMs);
      timer = setTimeout(() => finish(pred()), timeoutMs);
    });
  }

  /** Up to `maxLines` lines starting at absolute offset `from` (clamped to retained output). */
  readFrom(from: number, maxLines: number): ReadSlice {
    const t = this.buffer.retained();
    const lostEvicted = from < this.buffer.start;
    const startIdx = Math.min(t.length, Math.max(0, from - this.buffer.start));
    const { end, lines } = advanceLines(t, startIdx, Math.max(0, maxLines));
    return {
      text: t.slice(startIdx, end),
      lines,
      fromLine: countNewlines(t, 0, startIdx),
      totalLines: countLines(t),
      remainingLines: countLines(t, end),
      end: this.buffer.start + end,
      lostEvicted,
    };
  }

  /** Drops references that are only needed while the process runs. */
  release(): void {
    this.child = null;
    this.waiters.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------------------------

export interface TerminalManagerOptions {
  /** Per-session buffer cap in chars (default 10M). */
  maxBufferChars?: number;
  /** Chars of output kept once a session completes (default 1M). */
  completedTailChars?: number;
  /** Completed sessions remembered (default 100; oldest evicted). */
  maxCompleted?: number;
}

export interface StartOptions extends SpawnSpec {
  command: string;
  /** Shell as given by the user/config, for display. */
  shell: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** What terminate() did, in order: 'EOF' = closed the session's stdin. */
export type TerminateStep = 'SIGINT' | 'EOF' | 'SIGTERM' | 'SIGKILL';

export async function pollUntil(pred: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const noop = () => {};
const LINGER_CHECK_MS = 2000;

export class TerminalManager {
  private readonly active = new Map<number, Session>();
  private readonly completed = new Map<number, Session>();
  /**
   * Completed sessions whose process group still has live members — processes whose output was
   * redirected away from our pipes (`npm run dev > log 2>&1 &`), so 'close' came while they run.
   * Kept so force_terminate and shutdown() can still stop them; dropped once the group is gone
   * (checked every LINGER_CHECK_MS), so a recycled process-group id is never signalled.
   */
  private readonly lingering = new Map<number, Session>();
  private lingerTimer: NodeJS.Timeout | null = null;
  /** terminate() runs in progress, so concurrent calls on one session share a single escalation. */
  private readonly terminating = new WeakMap<Session, Promise<TerminateStep[]>>();
  private readonly maxBufferChars: number;
  private readonly completedTailChars: number;
  private readonly maxCompleted: number;
  private shuttingDown = false;

  constructor(opts: TerminalManagerOptions = {}) {
    this.maxBufferChars = opts.maxBufferChars ?? MAX_BUFFER_CHARS;
    this.completedTailChars = opts.completedTailChars ?? COMPLETED_TAIL_CHARS;
    this.maxCompleted = opts.maxCompleted ?? MAX_COMPLETED_SESSIONS;
  }

  /** Spawns the process and registers its session. Rejects (with the OS message) if it cannot start. */
  async start(opts: StartOptions): Promise<Session> {
    if (this.shuttingDown) throw new Error('the server is shutting down');
    let child: ChildProcess;
    try {
      child = spawn(opts.file, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !isWindows, // own process group: we can signal the whole tree with kill(-pid)
        windowsHide: true,
        windowsVerbatimArguments: opts.windowsVerbatimArguments,
      });
    } catch (err) {
      throw new Error((err as Error).message);
    }

    let session: Session | null = null;
    let spawnError: Error | null = null;
    child.on('error', (err) => {
      spawnError ??= err;
      if (session) {
        session.error ??= err.message;
        session.notify();
      }
    });

    const pid = child.pid;
    if (pid === undefined) {
      // spawn() reports ENOENT/EACCES asynchronously; wait for that 'error' to get the reason.
      await pollUntil(() => spawnError !== null, 2000, 5);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      throw new Error(spawnError ? (spawnError as Error).message : 'the process could not be spawned (no PID)');
    }

    const s = new Session(child, pid, {
      command: opts.command,
      shell: opts.shell,
      cwd: opts.cwd,
      cap: this.maxBufferChars,
    });
    session = s;
    this.completed.delete(pid); // an OS-reused pid supersedes the old completed entry
    this.lingering.delete(pid);
    this.active.set(pid, s);

    child.stdin?.on('error', noop); // EPIPE when the process closed stdin must not crash us
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const cleaner = new StreamCleaner();
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => s.ingest(cleaner.push(chunk)));
      stream.on('end', () => s.ingest(cleaner.flush()));
      stream.on('error', noop);
    }
    child.on('exit', (code, signal) => {
      s.exited = true;
      s.exitedAt = Date.now();
      s.exitCode = code;
      s.signal = signal;
      s.notify();
    });
    child.on('close', (code, signal) => this.finalize(s, code, signal));
    return s;
  }

  private finalize(s: Session, code: number | null, signal: NodeJS.Signals | null): void {
    if (s.closed) return;
    s.closed = true;
    s.exited = true;
    s.exitedAt ??= Date.now();
    s.exitCode = code;
    s.signal = signal;
    s.endTime = Date.now();
    s.buffer.shrinkTo(this.completedTailChars);
    if (this.active.get(s.pid) === s) this.active.delete(s.pid);
    this.completed.delete(s.pid);
    this.completed.set(s.pid, s);
    while (this.completed.size > this.maxCompleted) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
    if (this.groupAlive(s)) this.linger(s);
    s.notify();
    s.release();
  }

  private linger(s: Session): void {
    this.lingering.set(s.pid, s);
    if (this.lingerTimer) return;
    this.lingerTimer = setInterval(() => {
      for (const [pid, l] of this.lingering) if (!this.groupAlive(l)) this.lingering.delete(pid);
      if (!this.lingering.size && this.lingerTimer) {
        clearInterval(this.lingerTimer);
        this.lingerTimer = null;
      }
    }, LINGER_CHECK_MS);
    this.lingerTimer.unref();
  }

  /** A completed session whose process group still has live members (see `lingering`). */
  getLingering(pid: number): Session | undefined {
    const s = this.lingering.get(pid);
    if (s && !this.groupAlive(s)) {
      this.lingering.delete(pid);
      return undefined;
    }
    return s;
  }

  /** Active session first, then completed. */
  get(pid: number): Session | undefined {
    return this.active.get(pid) ?? this.completed.get(pid);
  }

  getActive(pid: number): Session | undefined {
    return this.active.get(pid);
  }

  listActive(): Session[] {
    return [...this.active.values()];
  }

  /** Completed sessions, most recently finished first. */
  listCompleted(): Session[] {
    return [...this.completed.values()].reverse();
  }

  /** Writes to the session's stdin. Throws when stdin is no longer writable. */
  write(s: Session, data: string): void {
    const stdin = s.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable || s.closed) {
      throw new Error('its stdin is closed');
    }
    stdin.write(data);
    s.inputAt = s.buffer.end;
  }

  /** Sends `sig` to the session's whole process group (Windows: taskkill /T /F). */
  signal(s: Session, sig: NodeJS.Signals): void {
    if (isWindows) {
      execFile('taskkill', ['/PID', String(s.pid), '/T', '/F'], { windowsHide: true }, noop);
      return;
    }
    try {
      process.kill(-s.pid, sig);
    } catch {
      try {
        s.child?.kill(sig);
      } catch {
        /* already gone */
      }
    }
  }

  /** True while any process of the session's process group is still alive (POSIX only). */
  groupAlive(s: Session): boolean {
    return !isWindows && groupExists(s.pid);
  }

  private gone(s: Session): boolean {
    return s.closed && !this.groupAlive(s);
  }

  /**
   * Stops the session's process group, escalating while anything in it is still alive: SIGINT;
   * then EOF on stdin (REPLs and interactive shells catch SIGINT, but exit cleanly on EOF and run
   * their atexit/finally code); then SIGTERM; then SIGKILL. Each signal also goes to the process
   * groups of the session's descendants (a job-control shell's jobs; see tree.ts). Waits up to
   * TERMINATE_STEP_MS after each step (2s after SIGKILL). When the process sat at an input prompt
   * and shows a fresh one after the SIGINT, it caught it, so EOF follows at once. EOF is skipped
   * when the direct child has already exited (nothing reads that stdin any more). Concurrent
   * calls share one run. Resolves with the steps taken, once everything is gone (or gave up).
   */
  terminate(s: Session): Promise<TerminateStep[]> {
    let run = this.terminating.get(s);
    if (!run) {
      run = this.escalate(s).finally(() => this.terminating.delete(s));
      this.terminating.set(s, run);
    }
    return run;
  }

  private async escalate(s: Session): Promise<TerminateStep[]> {
    const jobs: JobGroups = new Map();
    const send = async (sig: NodeJS.Signals) => {
      if (!isWindows) {
        const table = await processTable(); // taskkill /T already walks the tree on Windows
        if (table) trackDescendantGroups(s.pid, table, jobs);
      }
      this.signal(s, sig);
      signalGroups(jobs, sig);
    };
    const gone = () => this.gone(s) && [...jobs.keys()].every((pgid) => !groupExists(pgid));
    const steps: TerminateStep[] = ['SIGINT'];
    const atPrompt = s.waitingPrompt() !== null;
    const mark = s.buffer.end;
    await send('SIGINT');
    await s.waitUntil(() => gone() || (atPrompt && s.promptSince(mark) !== null), TERMINATE_STEP_MS);
    if (gone()) return steps;
    const stdin = s.child?.stdin;
    if (!s.exited && stdin?.writable) {
      steps.push('EOF');
      stdin.end();
      if (await s.waitUntil(gone, TERMINATE_STEP_MS)) return steps;
    }
    steps.push('SIGTERM');
    await send('SIGTERM');
    if (await s.waitUntil(gone, TERMINATE_STEP_MS)) return steps;
    steps.push('SIGKILL');
    await send('SIGKILL');
    await s.waitUntil(gone, 2000);
    return steps;
  }

  /**
   * Kills the process group of every active session, and of completed sessions whose group is
   * still alive, plus the groups a job-control shell moved its jobs into: SIGTERM, then SIGKILL
   * after 1s.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.lingerTimer) clearInterval(this.lingerTimer);
    this.lingerTimer = null;
    const sessions = [...this.listActive(), ...[...this.lingering.keys()].map((pid) => this.getLingering(pid))].filter(
      (s): s is Session => s !== undefined,
    );
    if (!sessions.length) return;
    const jobs: JobGroups = new Map();
    const table = isWindows ? null : await processTable();
    if (table) for (const s of sessions) trackDescendantGroups(s.pid, table, jobs);
    for (const s of sessions) this.signal(s, 'SIGTERM');
    signalGroups(jobs, 'SIGTERM');
    const allGone = () => sessions.every((s) => this.gone(s)) && [...jobs.keys()].every((pgid) => !groupExists(pgid));
    if (await pollUntil(allGone, 1000)) return;
    for (const s of sessions) if (!this.gone(s)) this.signal(s, 'SIGKILL');
    signalGroups(jobs, 'SIGKILL');
    await pollUntil(allGone, 1000);
  }
}
