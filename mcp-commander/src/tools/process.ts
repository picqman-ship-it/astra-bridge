import { execFile } from 'node:child_process';
import { z } from 'zod';
import { pollUntil } from '../terminal/manager.js';
import { defineTool, errorResult, type ToolContext, type ToolDef } from '../types.js';
import { parseArgs, truncateCommand } from './terminal.js';

const isWindows = process.platform === 'win32';

interface ProcInfo {
  pid: number;
  ppid: number | null;
  user: string | null;
  cpu: number | null;
  pmem: number | null;
  /** Resident memory in KiB. */
  rssKb: number | null;
  command: string;
}

function run(file: string, args: string[]): Promise<{ stdout: string; pid: number | undefined }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout), pid: child.pid })),
    );
  });
}

const PS_FORMAT = 'pid=,ppid=,pcpu=,pmem=,rss=,user=,args=';
const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s?(.*)$/;

async function listPosix(): Promise<ProcInfo[]> {
  // BSD/macOS spelling first (the spec'd form); procps (Linux) prefers -A.
  const variants = process.platform === 'linux'
    ? [['-A', '-ww', '-o', PS_FORMAT], ['-axww', '-o', PS_FORMAT]]
    : [['-axww', '-o', PS_FORMAT], ['-A', '-ww', '-o', PS_FORMAT]];
  let lastErr: unknown;
  for (const args of variants) {
    try {
      const { stdout, pid: psPid } = await run('ps', args);
      const out: ProcInfo[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = PS_LINE_RE.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid === psPid) continue; // the ps we just ran
        out.push({
          pid,
          ppid: Number(m[2]),
          cpu: Number(m[3]),
          pmem: Number(m[4]),
          rssKb: Number(m[5]),
          user: m[6],
          command: m[7].trim(),
        });
      }
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function listWindows(): Promise<ProcInfo[]> {
  const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH']);
  const out: ProcInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = (line.match(/"([^"]*)"/g) ?? []).map((f) => f.slice(1, -1));
    const pid = Number.parseInt(fields[1] ?? '', 10);
    if (!Number.isFinite(pid)) continue;
    const kb = Number.parseInt((fields[4] ?? '').replace(/[^\d]/g, ''), 10);
    out.push({
      pid,
      ppid: null,
      user: null,
      cpu: null,
      pmem: null,
      rssKb: Number.isFinite(kb) ? kb : null,
      command: fields[0] ?? '',
    });
  }
  return out;
}

function formatProc(p: ProcInfo): string {
  const mb = p.rssKb === null ? 'n/a' : `${(p.rssKb / 1024).toFixed(1)} MB`;
  const memory = p.pmem === null ? mb : `${mb} (${p.pmem}%)`;
  return (
    `PID: ${p.pid}, PPID: ${p.ppid ?? 'n/a'}, User: ${p.user ?? 'n/a'}, ` +
    `CPU: ${p.cpu === null ? 'n/a' : `${p.cpu}%`}, Memory: ${memory}, Command: ${truncateCommand(p.command, 200)}`
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'] as const;

const listShape = {
  filter: z
    .string()
    .optional()
    .describe('Only processes whose command line contains this text (case-insensitive)'),
  limit: z.coerce.number().int().min(1).max(2000).default(100).describe('Max processes to list (default 100, max 2000)'),
};

const killShape = {
  pid: z.coerce.number().int().describe('Process ID to signal'),
  signal: z
    .preprocess((v) => {
      if (typeof v !== 'string') return v;
      const s = v.trim().toUpperCase();
      return s.startsWith('SIG') ? s : `SIG${s}`;
    }, z.enum(SIGNALS))
    .default('SIGTERM')
    .describe('Signal to send: SIGTERM (default, polite), SIGINT, SIGHUP, or SIGKILL (cannot be caught)'),
};

export function processTools(_ctx: ToolContext): ToolDef[] {
  const listProcesses = defineTool({
    name: 'list_processes',
    description:
      'List running OS processes, busiest first: PID, parent PID, user, CPU %, resident memory, and command line ' +
      '(truncated to 200 chars). filter = case-insensitive substring of the command line; limit = max rows ' +
      '(default 100, max 2000).',
    inputSchema: listShape,
    annotations: { title: 'List Running Processes', readOnlyHint: true },
    handler: async (raw) => {
      const { filter, limit } = parseArgs(listShape, raw);
      let procs: ProcInfo[];
      try {
        procs = isWindows ? await listWindows() : await listPosix();
      } catch (err) {
        return errorResult(`Failed to list processes: ${(err as Error).message}`);
      }
      const needle = filter?.trim().toLowerCase();
      if (needle) procs = procs.filter((p) => p.command.toLowerCase().includes(needle));
      procs.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || (b.rssKb ?? 0) - (a.rssKb ?? 0) || a.pid - b.pid);
      const shown = procs.slice(0, limit);
      const sortedBy = isWindows ? 'memory' : 'CPU';
      const header = `Processes (showing ${shown.length} of ${procs.length}, sorted by ${sortedBy})`;
      if (!shown.length) return needle ? `${header}\nNo process command line contains "${filter!.trim()}"` : header;
      return `${header}\n${shown.map(formatProc).join('\n')}`;
    },
  });

  const killProcess = defineTool({
    name: 'kill_process',
    description:
      'Send a signal (default SIGTERM) to an OS process by PID, then report whether it exited within 1s. Refuses ' +
      'PIDs <= 1, this server itself and its parent (the MCP client). For sessions started with start_process, ' +
      'prefer force_terminate, which also stops the processes it spawned.',
    inputSchema: killShape,
    annotations: { title: 'Kill Process', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (raw) => {
      const { pid, signal } = parseArgs(killShape, raw);
      if (pid <= 1) {
        const why =
          pid === 1
            ? 'PID 1 is the init/launchd process'
            : pid === 0
              ? "PID 0 addresses this server's whole process group"
              : 'negative PIDs address whole process groups';
        return errorResult(`Refusing to signal PID ${pid}: ${why}`);
      }
      if (pid === process.pid) return errorResult(`Refusing to signal PID ${pid}: it is this MCP server itself`);
      if (pid === process.ppid) {
        return errorResult(`Refusing to signal PID ${pid}: it is the parent of this MCP server (the MCP client)`);
      }
      try {
        process.kill(pid, signal);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return errorResult(`No process with PID ${pid}`);
        if (code === 'EPERM') return errorResult(`Permission denied to signal PID ${pid}`);
        return errorResult(`Failed to signal PID ${pid}: ${(err as Error).message}`);
      }
      if (await pollUntil(() => !isAlive(pid), 1000, 25)) return `Successfully terminated process ${pid}`;
      const hint = signal === 'SIGKILL' ? '' : '. Use signal "SIGKILL" to force it';
      return `Sent ${signal} to process ${pid}, but it is still running${hint}`;
    },
  });

  return [listProcesses, killProcess] as unknown as ToolDef[];
}
