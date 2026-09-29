import { execFile } from 'node:child_process';

/**
 * Process-tree helpers for terminating sessions on POSIX. A session runs in its own process
 * group, but an interactive shell with job control (macOS bash as `sh -i` / `bash -i` turns it
 * on even without a TTY) moves every job into a group of its own, which kill(-sessionPid) never
 * reaches. These find those groups, like `taskkill /T` walks the tree on Windows.
 */

/** pid -> parent pid and process group id, for every process. */
export type ProcessTable = Map<number, { ppid: number; pgid: number }>;

/** Process groups found under a session: pgid -> the member pids seen in it. */
export type JobGroups = Map<number, Set<number>>;

/**
 * One `ps -A -o pid=,ppid=,pgid=` snapshot (macOS, the BSDs and procps all accept this form).
 * Resolves null when ps is missing or fails, so callers fall back to the session's own group.
 */
export function processTable(): Promise<ProcessTable | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,pgid='],
      { timeout: 2000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => {
        if (err) return resolve(null);
        const table: ProcessTable = new Map();
        for (const line of String(stdout).split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
          if (m) table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]) });
        }
        resolve(table.size ? table : null);
      },
    );
  });
}

/**
 * Adds to `known` the process groups of root's descendants other than root's own group, and
 * forgets remembered groups none of whose recorded members is still in them, so a recycled pgid
 * is never signalled. Remembered groups outlive the shell: once it is gone its jobs are
 * reparented, and walking from root no longer finds them.
 */
export function trackDescendantGroups(root: number, table: ProcessTable, known: JobGroups): void {
  for (const [pgid, pids] of known) {
    for (const pid of pids) if (table.get(pid)?.pgid !== pgid) pids.delete(pid);
    if (!pids.size) known.delete(pgid);
  }
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) {
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const skip = new Set([table.get(root)?.pgid ?? root, table.get(process.pid)?.pgid ?? -1]);
  const queue = [root];
  const seen = new Set(queue);
  while (queue.length) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
      const pgid = (table.get(child) as { pgid: number }).pgid;
      if (pgid <= 1 || skip.has(pgid)) continue;
      const members = known.get(pgid);
      if (members) members.add(child);
      else known.set(pgid, new Set([child]));
    }
  }
}

/** True while any process is in group `pgid` (EPERM counts: it exists, it is just not ours). */
export function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Sends `sig` to every tracked group; a group that is already gone is skipped silently. */
export function signalGroups(groups: JobGroups, sig: NodeJS.Signals): void {
  for (const pgid of groups.keys()) {
    try {
      process.kill(-pgid, sig);
    } catch {
      /* already gone */
    }
  }
}
