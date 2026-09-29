import type { ToolResult } from './types.js';

/**
 * In-memory call history for get_recent_tool_calls / get_usage_stats.
 *
 * Desktop Commander persists every call's full arguments (whole file contents included) to
 * plaintext logs that are never deleted. Here history lives only in memory and long string
 * arguments are truncated before they are stored.
 */
export interface CallRecord {
  timestamp: string;
  toolName: string;
  arguments: unknown;
  output: string;
  isError: boolean;
  durationMs: number;
}

const MAX_ENTRIES = 1000;
const MAX_ARG_STRING = 300;
const MAX_ARG_ITEMS = 50;
const MAX_OUTPUT_CHARS = 2000;

function capArgs(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_ARG_STRING
      ? `${value.slice(0, MAX_ARG_STRING)}… [${value.length - MAX_ARG_STRING} more chars]`
      : value;
  }
  if (value === null || typeof value !== 'object') return value;
  // FIX: past the depth limit the value used to be stored as-is, long strings and all.
  if (depth > 4) return Array.isArray(value) ? '[nested array]' : '[nested object]';
  if (Array.isArray(value)) {
    const out: unknown[] = value.slice(0, MAX_ARG_ITEMS).map((v) => capArgs(v, depth + 1));
    if (value.length > MAX_ARG_ITEMS) out.push(`… [${value.length - MAX_ARG_ITEMS} more items]`);
    return out;
  }
  const entries = Object.entries(value);
  const out = Object.fromEntries(entries.slice(0, MAX_ARG_ITEMS).map(([k, v]) => [k, capArgs(v, depth + 1)]));
  if (entries.length > MAX_ARG_ITEMS) out['…'] = `[${entries.length - MAX_ARG_ITEMS} more keys]`;
  return out;
}

function summarizeOutput(result: ToolResult): string {
  const text = result.content
    .map((c) => (c.type === 'text' ? c.text : `[${c.type} ${c.mimeType}]`))
    .join('\n');
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}… [${text.length - MAX_OUTPUT_CHARS} more chars]`
    : text;
}

export class CallHistory {
  private records: CallRecord[] = [];
  private counts = new Map<string, { ok: number; failed: number }>();
  readonly startedAt = new Date();

  add(toolName: string, args: unknown, result: ToolResult, durationMs: number): void {
    const isError = !!result.isError;
    this.records.push({
      timestamp: new Date().toISOString(),
      toolName,
      arguments: capArgs(args),
      output: summarizeOutput(result),
      isError,
      durationMs,
    });
    if (this.records.length > MAX_ENTRIES) this.records.shift();
    const c = this.counts.get(toolName) ?? { ok: 0, failed: 0 };
    if (isError) c.failed++;
    else c.ok++;
    this.counts.set(toolName, c);
  }

  recent(opts: { maxResults?: number; toolName?: string; since?: string } = {}): CallRecord[] {
    let out = this.records;
    if (opts.toolName) out = out.filter((r) => r.toolName === opts.toolName);
    if (opts.since) {
      const since = Date.parse(opts.since);
      if (Number.isNaN(since)) throw new Error(`Invalid "since" timestamp: ${opts.since}`);
      out = out.filter((r) => Date.parse(r.timestamp) >= since);
    }
    const limit = Math.min(Math.max(opts.maxResults ?? 50, 1), MAX_ENTRIES);
    return out.slice(-limit);
  }

  get size(): number {
    return this.records.length;
  }

  stats(): { total: number; ok: number; failed: number; perTool: [string, number][] } {
    let ok = 0;
    let failed = 0;
    const perTool: [string, number][] = [];
    for (const [name, c] of this.counts) {
      ok += c.ok;
      failed += c.failed;
      perTool.push([name, c.ok + c.failed]);
    }
    perTool.sort((a, b) => b[1] - a[1]);
    return { total: ok + failed, ok, failed, perTool };
  }
}
