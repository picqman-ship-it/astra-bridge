import fs from 'node:fs/promises';
import path from 'node:path';
import { z, type ZodRawShape } from 'zod';
import { checkCommand, commandName, runsInteractiveShell, type CommandCheck } from '../security/commands.js';
import { expandHome, validatePath } from '../security/paths.js';
import {
  QUIET_MS,
  advanceLines,
  countLines,
  displayText,
  splitLines,
  type Session,
  type TerminalManager,
  type TerminateStep,
} from '../terminal/manager.js';
import { childEnv, findExecutable, resolveShell, shellSpawnArgs, withStderrOnStdout } from '../terminal/shell.js';
import { defineTool, errorResult, ToolError, type ToolContext, type ToolDef } from '../types.js';

// ---------------------------------------------------------------------------------------------
// Shared helpers (also used by tools/process.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Validates and defaults raw arguments against a raw shape. The SDK already does this for real
 * MCP calls; doing it again here keeps handlers correct when called directly (tests, other code).
 */
export function parseArgs<S extends ZodRawShape>(shape: S, raw: unknown): z.infer<z.ZodObject<S>> {
  const result = z.object(shape).safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`);
    throw new ToolError(`Invalid arguments: ${issues.join('; ')}`);
  }
  return result.data;
}

/** Booleans that also accept "true"/"false" strings (models sometimes send those). */
export function boolish(defaultValue: boolean) {
  return z
    .preprocess((v) => {
      if (typeof v !== 'string') return v;
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no') return false;
      return v;
    }, z.boolean())
    .default(defaultValue);
}

/** One-line, length-capped rendering of a command for listings. */
export function truncateCommand(command: string, max: number): string {
  const oneLine = command.replace(/\s*\r?\n\s*/g, ' ↵ ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function blockedMessage(what: string, check: CommandCheck): string {
  return `Command not allowed: ${what} (${check.blocked ? `blocked: ${check.blocked}` : check.reason ?? 'rejected'})`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/** "exited with code 0" / "terminated by signal SIGKILL" */
function exitPhrase(s: Session): string {
  if (s.signal) return `terminated by signal ${s.signal}`;
  if (s.exitCode !== null) return `exited with code ${s.exitCode}`;
  return s.error ? `failed: ${s.error}` : 'exited';
}

/** ['SIGINT', 'EOF', 'SIGKILL'] -> "SIGINT, EOF on stdin and SIGKILL" */
function stepsPhrase(steps: readonly TerminateStep[]): string {
  const names = steps.map((x) => (x === 'EOF' ? 'EOF on stdin' : x));
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function waitingLine(s: Session, prompt: string): string {
  return `🔄 Process ${s.pid} is waiting for input (detected: "${prompt}")`;
}

/** Explains a session whose shell is gone but whose output pipe a background process keeps open. */
function backgroundNote(s: Session): string {
  if (!s.exited || s.closed) return '';
  const how = s.signal ? `was terminated by signal ${s.signal}` : `exited with code ${s.exitCode}`;
  return ` (its shell ${how}, but a background process still holds the output open)`;
}

function evictionWarning(s: Session): string {
  if (s.buffer.evictedLines <= 0) return '';
  return (
    `\n[WARNING: output exceeded the session buffer limit; the ${s.buffer.evictedLines} earliest lines were ` +
    'evicted and cannot be read. Line numbers and totals refer to the retained buffer only]'
  );
}

/** Warning line (with trailing newline) when unread output starting at `from` was already evicted. */
function lostWarning(s: Session, from: number): string {
  const lost = s.buffer.start - from;
  if (lost <= 0) return '';
  return (
    `[WARNING: output exceeded the session buffer limit; ${lost} chars of unread output were evicted ` +
    'before they could be read]\n'
  );
}

function collapseLines(lines: string[]): string {
  return displayText(lines.join('\n') + (lines.length ? '\n' : ''));
}

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const pidParam = z.coerce.number().int().describe('PID of the session, as returned by start_process');

const startShape = {
  command: z.string().describe('Command line to run, e.g. "npm test", "ls -la | head", "python3 -i"'),
  timeout_ms: z.coerce
    .number()
    .int()
    .min(0)
    .max(600000)
    .default(10000)
    .describe(
      'Max ms to wait for the process to exit or show an input prompt before returning (default 10000, max 600000). ' +
        'The process is NOT killed when this expires.',
    ),
  shell: z
    .string()
    .optional()
    .describe(
      'Shell to run the command with (path, or name on PATH). Default: config defaultShell, then $SHELL ' +
        '(%COMSPEC% on Windows), then /bin/sh (cmd.exe).',
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory (absolute or ~/...). Default: the server's current directory. " +
        'Must be inside allowedDirectories when that list is set.',
    ),
};

const readShape = {
  pid: pidParam,
  timeout_ms: z.coerce
    .number()
    .int()
    .min(0)
    .max(60000)
    .default(5000)
    .describe('offset=0 only: max ms to wait for new output when there is none yet (default 5000, max 60000)'),
  offset: z.coerce
    .number()
    .int()
    .default(0)
    .describe(
      '0 (default) = output not read yet (advances the read position); >0 = start at this 0-based line of the ' +
        'retained output; <0 = the last |offset| lines. Non-zero offsets do not move the read position.',
    ),
  length: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Max lines to return (default: config fileReadLineLimit, 1000)'),
};

const interactShape = {
  pid: pidParam,
  input: z
    .string()
    .describe('Text to send to stdin; a newline is appended if missing. Multi-line input is sent as-is.'),
  timeout_ms: z.coerce
    .number()
    .int()
    .min(0)
    .max(600000)
    .default(8000)
    .describe('Max ms to wait for the response (default 8000, max 600000). The process is not killed.'),
  wait_for_prompt: boolish(true).describe(
    'true (default): wait until the process shows its next prompt, exits, or timeout_ms passes, and return the ' +
      'output. false: send and return immediately.',
  ),
};

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

export function terminalTools(ctx: ToolContext, terminal: TerminalManager): ToolDef[] {
  const blockedList = () => ctx.config.getValue('blockedCommands');
  const lineLimit = () => ctx.config.getValue('fileReadLineLimit');

  const startProcess = defineTool({
    name: 'start_process',
    description:
      'Start a command in a new terminal session and wait up to timeout_ms for it to exit or to show an input prompt. ' +
      'The process keeps running in the background after that; its PID identifies the session for ' +
      'read_process_output, interact_with_process and force_terminate. Returns the initial output (merged ' +
      'stdout+stderr, ANSI codes stripped, capped at fileReadLineLimit lines) and a status line: exited with ' +
      'its code, waiting for input (with the detected prompt), or still running. ' +
      'There is no TTY: to drive a REPL or shell, start it in interactive mode (python3 -i, node -i, bash -i) so ' +
      'it prints prompts. bash/zsh/fish run as login shells (<shell> -l -c <command>). ' +
      'Commands that use a name in blockedCommands (e.g. sudo), including inside sh -c or $(...), are refused.',
    inputSchema: startShape,
    annotations: { title: 'Start Terminal Process', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (raw) => {
      const args = parseArgs(startShape, raw);
      const command = args.command;
      if (!command.trim()) return errorResult('command must not be empty');

      const blocked = blockedList();
      const check = checkCommand(command, blocked);
      if (!check.allowed) return errorResult(blockedMessage(command, check));

      const { shell, source } = resolveShell(args.shell, ctx.config.getValue('defaultShell'));
      if (source === 'argument') {
        const name = commandName(shell);
        if (blocked.some((b) => b.trim().toLowerCase() === name)) {
          return errorResult(`Shell not allowed: ${shell} (blocked: ${name})`);
        }
      }
      const shellPath = findExecutable(shell);
      if (!shellPath) {
        if (source === 'argument') {
          return errorResult(`Shell not found: ${shell} (not an existing executable path and not found on PATH)`);
        }
        const from = source === 'config' ? 'config defaultShell' : source === 'environment' ? 'the SHELL/COMSPEC variable' : 'the built-in default';
        return errorResult(`Failed to start process: shell not found: ${shell} (from ${from}); pass the shell parameter`);
      }

      let cwd = process.cwd();
      if (args.cwd && args.cwd.trim()) {
        const requested = args.cwd.trim();
        const allowed = ctx.config.getValue('allowedDirectories');
        if (allowed.length) await validatePath(requested, allowed);
        const abs = path.resolve(expandHome(requested));
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          return errorResult(`cwd does not exist: ${requested}`);
        }
        if (!stat.isDirectory()) return errorResult(`cwd is not a directory: ${requested}`);
        cwd = abs;
      }

      let session: Session;
      try {
        session = await terminal.start({
          ...withStderrOnStdout(shellSpawnArgs(shellPath, command)),
          command,
          shell,
          cwd,
          env: childEnv(),
        });
      } catch (err) {
        return errorResult(`Failed to start process: ${(err as Error).message}`);
      }
      const s = session;
      await s.waitUntil(
        () => s.closed || s.error !== null || s.exitSettled() || s.waitingPrompt() !== null,
        args.timeout_ms,
        50,
      );

      const lost = lostWarning(s, s.cursor);
      const slice = s.readFrom(s.cursor, lineLimit());
      s.cursor = slice.end;
      let output = slice.lines ? displayText(slice.text) : '';
      if (!output.trim()) output = '(no output yet)';
      output = lost + output;
      if (slice.remainingLines > 0) {
        output += `\n[... ${slice.remainingLines} more lines. Use read_process_output to continue]`;
      }

      let status: string;
      const prompt = s.waitingPrompt();
      if (s.closed) status = `\n✅ Process ${exitPhrase(s)} (runtime: ${seconds(s.runtimeMs)})`;
      else if (prompt) status = `\n${waitingLine(s, prompt)}`;
      else if (s.error) status = `\n❌ Process error: ${s.error}`;
      else {
        status =
          `\n⏳ Process is still running${backgroundNote(s)}. Use read_process_output to get more output, ` +
          'interact_with_process to send input, or force_terminate to stop it.';
      }
      return `Process started with PID ${s.pid} (shell: ${shell})\nInitial output:\n${output}${status}`;
    },
  });

  const readProcessOutput = defineTool({
    name: 'read_process_output',
    description:
      'Read output from a session started by start_process (running or recently completed). ' +
      'offset=0 (default) returns output you have not read yet and advances the read position; if there is none ' +
      'and the process is running (not sitting at an input prompt), it waits up to timeout_ms for more. ' +
      'offset>0 reads from that 0-based line of the retained output and offset<0 reads the last |offset| lines ' +
      '(neither moves the read position). ' +
      'Returns at most `length` lines (default fileReadLineLimit) under a [Reading ...] header, followed by the ' +
      'process state: completed with exit code, waiting for input, or still running.',
    inputSchema: readShape,
    annotations: { title: 'Read Process Output', readOnlyHint: true },
    handler: async (raw) => {
      const args = parseArgs(readShape, raw);
      const s = terminal.get(args.pid);
      if (!s) return errorResult(`No session found for PID ${args.pid}`);
      const limit = args.length ?? lineLimit();

      let header: string;
      let body: string;
      if (args.offset === 0) {
        // Nothing new: wait for more — unless the process sits at an input prompt, where nothing
        // will arrive before it gets input.
        if (!s.closed && s.buffer.end <= s.cursor && args.timeout_ms > 0 && s.waitingPrompt() === null) {
          const deadline = Date.now() + args.timeout_ms;
          const arrived = await s.waitUntil(() => s.closed || s.buffer.end > s.cursor, args.timeout_ms);
          if (arrived && !s.closed) {
            // Something arrived: give the burst a moment to finish so it comes back in one piece.
            await s.waitUntil(() => s.closed || Date.now() - s.lastOutputAt >= QUIET_MS, deadline - Date.now(), 25);
          }
        }
        const lost = lostWarning(s, s.cursor);
        const slice = s.readFrom(s.cursor, limit);
        s.cursor = slice.end;
        header =
          slice.remainingLines > 0
            ? `[Reading ${slice.lines} new lines from line ${slice.fromLine} (total: ${slice.totalLines} lines, ${slice.remainingLines} remaining)]`
            : `[Reading ${slice.lines} new lines (total: ${slice.totalLines} lines)]`;
        body = lost + (slice.lines ? displayText(slice.text) : '(No new output)');
      } else {
        const lines = splitLines(s.buffer.retained());
        const start = args.offset > 0 ? args.offset : Math.max(0, lines.length + args.offset);
        const chunk = lines.slice(start, start + limit);
        header =
          args.offset > 0
            ? `[Reading ${chunk.length} lines from line ${start} (total: ${lines.length} lines, ${Math.max(0, lines.length - start - chunk.length)} remaining)]`
            : `[Reading last ${chunk.length} lines (total: ${lines.length} lines)]`;
        body = chunk.length ? collapseLines(chunk) : '(No output in requested range)';
      }

      let state: string;
      if (s.closed) {
        state = s.signal
          ? `\n✅ Process terminated by signal ${s.signal} (runtime: ${seconds(s.runtimeMs)})`
          : `\n✅ Process completed with exit code ${s.exitCode} (runtime: ${seconds(s.runtimeMs)})`;
      } else {
        const prompt = s.waitingPrompt();
        state = prompt ? `\n${waitingLine(s, prompt)}` : `\n⏳ Process ${s.pid} is still running${backgroundNote(s)}`;
      }
      return `${header}${evictionWarning(s)}\n\n${body}${state}`;
    },
  });

  const interactWithProcess = defineTool({
    name: 'interact_with_process',
    description:
      "Send input to a running session's stdin (newline appended if missing) and return its response: the output " +
      'produced until the process shows its next input prompt, exits, or timeout_ms passes. Use it for REPLs ' +
      '(python3 -i, node -i, psql, mysql, ...) and interactive shells (bash -i) started with start_process. ' +
      'Output is returned verbatim, including any earlier output you had not read yet; the trailing prompt is ' +
      'reported in the status line instead of the output (capped at fileReadLineLimit lines). ' +
      'For shell sessions the input is checked against blockedCommands. wait_for_prompt=false only sends the input.',
    inputSchema: interactShape,
    annotations: { title: 'Send Input to Process', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (raw) => {
      const args = parseArgs(interactShape, raw);
      const pid = args.pid;
      const s = terminal.getActive(pid);
      if (!s) {
        return errorResult(
          `No active session for PID ${pid} (it may have exited; use read_process_output to see its final output)`,
        );
      }
      if (runsInteractiveShell(s.command)) {
        const check = checkCommand(args.input, blockedList());
        if (!check.allowed) return errorResult(blockedMessage(args.input, check));
      }

      const snapshot = s.buffer.end;
      const readFrom = Math.min(s.cursor, snapshot);
      try {
        terminal.write(s, args.input.endsWith('\n') ? args.input : `${args.input}\n`);
      } catch (err) {
        return errorResult(`Failed to send input to process ${pid}: ${(err as Error).message}`);
      }
      if (!args.wait_for_prompt) {
        return `✅ Input sent to process ${pid}. Use read_process_output to get the response.`;
      }

      await s.waitUntil(
        () => s.closed || s.exitSettled() || (s.buffer.end > snapshot && s.waitingPrompt() !== null),
        args.timeout_ms,
        50,
      );
      const exited = s.closed || s.exitSettled();
      const prompt = !exited && s.buffer.end > snapshot ? s.waitingPrompt() : null;

      const all = s.buffer.retained();
      const startAbs = Math.max(readFrom, s.buffer.start);
      let out = all.slice(startAbs - s.buffer.start);
      if (prompt) {
        const nl = out.lastIndexOf('\n');
        out = nl === -1 ? '' : out.slice(0, nl + 1); // the prompt goes into the status line
      }
      const { end } = advanceLines(out, 0, lineLimit());
      const hidden = countLines(out, end);
      s.cursor = hidden > 0 ? startAbs + end : s.buffer.end;

      const lost = lostWarning(s, readFrom);
      const body = (lost + displayText(out.slice(0, end))).replace(/\n$/, '');
      let text = body.trim()
        ? `✅ Input executed in process ${pid}:\n\n📤 Output:\n${body}`
        : `✅ Input executed in process ${pid}.\n📭 (No output produced)`;
      if (hidden > 0) text += `\n[... ${hidden} more lines. Use read_process_output to continue]`;

      let status: string;
      if (exited) {
        status = `✅ Process ${exitPhrase(s)}`;
        if (!s.closed) {
          status +=
            ' (a background process it started still holds its output open; read_process_output shows more, ' +
            'force_terminate stops it)';
        }
      } else if (prompt) status = waitingLine(s, prompt);
      else {
        status =
          `⏱️ No prompt detected within ${args.timeout_ms}ms — the process may still be working. ` +
          'Use read_process_output to get more output.';
      }
      return `${text}\n\n${status}`;
    },
  });

  const forceShape = { pid: pidParam };
  const forceTerminate = defineTool({
    name: 'force_terminate',
    description:
      'Stop a running session started by start_process: sends SIGINT to its whole process group (the command and ' +
      'everything it started, including jobs a shell moved to their own process group); while anything is still ' +
      'alive it then closes stdin (EOF, so REPLs and shells exit cleanly), sends SIGTERM and finally SIGKILL, ' +
      'waiting up to 1s after each step (2s after SIGKILL) (Windows: taskkill /T /F). ' +
      'Also stops background processes a finished session left running (e.g. `server > log 2>&1 &`). ' +
      'Its output stays readable with read_process_output.',
    inputSchema: forceShape,
    annotations: { title: 'Force Terminate Process', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (raw) => {
      const { pid } = parseArgs(forceShape, raw);
      const s = terminal.getActive(pid);
      if (!s) {
        // The session's output closed, but processes it started with their output redirected
        // (`server > log 2>&1 &`) still run in its process group: stop those.
        const bg = terminal.getLingering(pid);
        if (!bg) return errorResult(`No active session found for PID ${pid}`);
        const steps = await terminal.terminate(bg);
        if (terminal.groupAlive(bg)) {
          return `Sent ${stepsPhrase(steps)} to the processes session ${pid} left running, but some are still alive`;
        }
        const how = bg.signal ? `was terminated by signal ${bg.signal}` : `exited with code ${bg.exitCode}`;
        return `Session ${pid} ${how} earlier; terminated the background processes it left running`;
      }
      const steps = await terminal.terminate(s);
      if (!s.closed) {
        return (
          `Sent ${stepsPhrase(steps)} to session ${pid}, but its output is still held open ` +
          '(a process outside its process group may be keeping it alive)'
        );
      }
      const how = s.signal ? `signal ${s.signal}` : `exit code ${s.exitCode}`;
      return `Successfully terminated session ${pid} (${how})`;
    },
  });

  const listSessions = defineTool({
    name: 'list_sessions',
    description:
      'List terminal sessions started with start_process: active ones (PID, running or waiting for input, runtime, ' +
      'command) and the 10 most recently completed (exit code or signal).',
    inputSchema: {},
    annotations: { title: 'List Terminal Sessions', readOnlyHint: true },
    handler: () => {
      const active = terminal.listActive();
      const done = terminal.listCompleted().slice(0, 10);
      if (!active.length && !done.length) return 'No active sessions';
      const parts: string[] = [];
      if (active.length) {
        const lines = active.map(
          (s) =>
            `PID: ${s.pid}, Status: ${s.waitingPrompt() ? 'waiting for input' : 'running'}, ` +
            `Runtime: ${Math.round(s.runtimeMs / 1000)}s, Command: ${truncateCommand(s.command, 80)}`,
        );
        parts.push(`Active sessions:\n${lines.join('\n')}`);
      } else {
        parts.push('No active sessions');
      }
      if (done.length) {
        const lines = done.map(
          (s) =>
            `PID: ${s.pid}, Exit: ${s.signal ?? s.exitCode ?? 'unknown'}` +
            `${terminal.getLingering(s.pid) ? ' (processes it started are still running; force_terminate stops them)' : ''}, ` +
            `Runtime: ${Math.round(s.runtimeMs / 1000)}s, Command: ${truncateCommand(s.command, 80)}`,
        );
        parts.push(`Recently completed:\n${lines.join('\n')}`);
      }
      return parts.join('\n\n');
    },
  });

  return [startProcess, readProcessOutput, interactWithProcess, forceTerminate, listSessions] as unknown as ToolDef[];
}
