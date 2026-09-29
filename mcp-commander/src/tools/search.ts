import { z } from 'zod';
import { validatePath } from '../security/paths.js';
import {
  DEFAULT_MAX_RESULTS,
  MAX_CONTEXT_LINES,
  MAX_RESULTS_LIMIT,
  type SearchManager,
  type SearchResult,
  type SearchSession,
} from '../search/manager.js';
import { defineTool, errorResult, textResult, ToolError, type ToolContext, type ToolDef } from '../types.js';

/** How long start_search waits for the search to finish before returning a RUNNING snapshot. */
const INITIAL_WAIT_MS = 1500;
const INITIAL_RESULTS = 50;
const DISPLAY_MAX = 200;

/** Booleans that also accept "true"/"false" strings (models sometimes send those). */
function boolish(defaultValue: boolean) {
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

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;

/**
 * A result line's text for display: the full line (trailing whitespace dropped), at most 200
 * characters; on long lines the window is moved so the match stays visible.
 */
function snippet(r: SearchResult): string {
  let text = (r.text ?? '').trimEnd();
  let pre = !!r.cutStart;
  let post = !!r.cutEnd;
  if (text.length > DISPLAY_MAX) {
    let start = 0;
    const col = r.col;
    if (col !== undefined && col > DISPLAY_MAX - 50) start = Math.max(0, Math.min(col - 50, text.length - DISPLAY_MAX));
    if (start > 0 && isHighSurrogate(text.charCodeAt(start - 1))) start--;
    let end = Math.min(text.length, start + DISPLAY_MAX);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    pre = pre || start > 0;
    post = post || end < text.length;
    text = text.slice(start, end);
  }
  return `${pre ? '...' : ''}${text}${post ? '...' : ''}`;
}

export function formatResult(r: SearchResult): string {
  switch (r.type) {
    case 'file':
      return `📁 ${r.file}`;
    case 'dir':
      return `📂 ${r.file}/`;
    case 'match':
      return `📄 ${r.file}:${r.line} - ${snippet(r)}`;
    case 'context':
      return `   ${r.file}:${r.line}   ${snippet(r)}`;
  }
}

function totalText(s: SearchSession): string {
  const n = s.results.length;
  return s.contextCount > 0 ? `${n} (${s.matchCount} matches + ${s.contextCount} context lines)` : String(n);
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/** Lines explaining why a search ended early or what it could not search. */
function noteLines(s: SearchSession): string[] {
  const out: string[] = [];
  for (const n of s.notes) out.push(`ℹ️ ${n}`);
  if (s.limitReached) {
    out.push(
      `⚠️ Result limit reached (maxResults=${s.options.maxResults}); the search was stopped early. ` +
        'Narrow the pattern/path or raise maxResults to see more.',
    );
  }
  if (s.timedOut) out.push(`⏱️ Search timed out after ${s.timeoutMs}ms and was stopped; results may be incomplete.`);
  else if (s.status === 'stopped') out.push('⏹️ Search was stopped before it finished; results may be incomplete.');
  if (s.earlyTerminated) out.push('🎯 Stopped at the first file whose name equals the pattern (earlyTermination).');
  for (const w of s.warnings) out.push(`⚠️ ${w}`);
  return out;
}

function sessionErrorText(s: SearchSession): string {
  return `Search session ${s.id} encountered an error: ${s.error ?? 'unknown error'}`;
}

function describeStart(s: SearchSession): string {
  const o = s.options;
  let text =
    `Started ${o.searchType === 'content' ? 'content search' : 'file search'} session: ${s.id}\n` +
    `Pattern: "${o.pattern}"\n` +
    `Path: ${o.displayPath}\n` +
    `Status: ${s.isComplete ? 'COMPLETED' : 'RUNNING'}\n` +
    `Runtime: ${s.runtimeMs}ms\n` +
    `Engine: ${s.engine}\n` +
    `Total results: ${totalText(s)}\n\n`;
  const results = s.results;
  if (results.length > 0) {
    text += `Initial results:\n${results.slice(0, INITIAL_RESULTS).map(formatResult).join('\n')}\n`;
    if (results.length > INITIAL_RESULTS) {
      text +=
        `... and ${results.length - INITIAL_RESULTS} more results. ` +
        `Use get_more_search_results with sessionId ${s.id} and offset ${INITIAL_RESULTS}\n`;
    }
  } else if (s.isComplete) {
    text += 'No matches found.\n';
  }
  const footer = noteLines(s);
  footer.push(
    s.isComplete ? '✅ Search completed.' : '🔄 Search in progress. Use get_more_search_results to get more results.',
  );
  return `${text}\n${footer.join('\n')}`;
}

function describePage(s: SearchSession, offset: number, length: number): string {
  const all = s.results;
  const total = all.length;
  const complete = s.isComplete;
  let text =
    `Search session: ${s.id}\n` +
    `Status: ${complete ? 'COMPLETED' : 'IN PROGRESS'}\n` +
    `Runtime: ${seconds(s.runtimeMs)}s\n` +
    `Total results found: ${totalText(s)}\n`;

  const slice = offset < 0 ? all.slice(offset) : all.slice(offset, offset + length);
  const start = offset < 0 ? total - slice.length : offset;
  if (slice.length === 0) {
    text += `${!complete ? 'No results yet, search is still running...' : total === 0 ? 'No matches found.' : 'No results in this range.'}\n`;
  } else {
    text +=
      (offset < 0 ? `Showing last ${slice.length} results` : `Showing results ${start}-${start + slice.length - 1}`) +
      `\n\nResults:\n${slice.map(formatResult).join('\n')}\n`;
  }

  const footer: string[] = [];
  if (offset >= 0) {
    const next = offset + slice.length;
    if (next < total || !complete) {
      footer.push(`📖 More results available. Use get_more_search_results with offset: ${next}`);
    }
  }
  if (complete) footer.push(...noteLines(s), '✅ Search completed.');
  return footer.length ? `${text}\n${footer.join('\n')}` : text;
}

function statusBadge(s: SearchSession): string {
  switch (s.status) {
    case 'running':
      return '🔄 RUNNING';
    case 'completed':
      return '✅ COMPLETED';
    case 'error':
      return '❌ ERROR';
    case 'stopped':
      return '⏹️ STOPPED';
  }
}

/**
 * Applies the schema's defaults and coercions inside the handler too, so direct handler calls
 * (tests, other modules) behave exactly like calls that went through the MCP server.
 */
function parseArgs<S extends z.ZodRawShape>(shape: S, raw: unknown): z.objectOutputType<S, z.ZodTypeAny> {
  const result = z.object(shape).passthrough().safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`);
    throw new ToolError(`Invalid arguments: ${issues.join('; ')}`);
  }
  return result.data as z.objectOutputType<S, z.ZodTypeAny>;
}

const startSchema = {
  path: z.string().describe('Directory (or single file) to search. Absolute path recommended; ~ is expanded.'),
  pattern: z
    .string()
    .describe("files: name substring or glob (e.g. 'auth', '*.md'); content: regex, or exact text with literalSearch"),
  searchType: z
    .enum(['files', 'content'])
    .default('files')
    .describe("'files' = match file/directory names (default), 'content' = search inside files"),
  filePattern: z
    .string()
    .optional()
    .describe("Only consider files whose name matches one of these '|'-separated globs, e.g. '*.ts|*.js'"),
  ignoreCase: boolish(true).describe('Case-insensitive matching of pattern (default true)'),
  maxResults: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum total results (default ${DEFAULT_MAX_RESULTS}; values above ${MAX_RESULTS_LIMIT} are capped)`),
  includeHidden: boolish(false).describe('Include hidden files and directories (dot-names; default false)'),
  contextLines: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(`content only: lines of context before and after each match (default 0, max ${MAX_CONTEXT_LINES})`),
  timeout_ms: z.coerce
    .number()
    .int()
    .optional()
    .describe('Stop the search after this many milliseconds (optional; every search is stopped after 10 minutes)'),
  literalSearch: boolish(false).describe('content only: treat pattern as exact text, not a regex (default false)'),
  earlyTermination: boolish(false).describe(
    'files only: stop at the first file whose name equals the pattern exactly (default false)',
  ),
};

const sessionIdParam = z.string().describe('Session id returned by start_search (e.g. "search_1_1758800000000")');

const moreSchema = {
  sessionId: sessionIdParam,
  offset: z.coerce
    .number()
    .int()
    .default(0)
    .describe('First result to return (0-based, default 0); negative = the last |offset| results'),
  length: z.coerce.number().int().min(1).default(100).describe('Maximum number of results to return (default 100)'),
};

const stopSchema = { sessionId: sessionIdParam };

export function searchTools(ctx: ToolContext, search: SearchManager): ToolDef[] {
  return [
    defineTool({
      name: 'start_search',
      description:
        'Search for files by name or for text inside files, in the background. Uses ripgrep (or a built-in ' +
        'engine with the same rules when ripgrep is unavailable). Waits up to 1.5s, then returns the status, ' +
        'the first 50 results and a sessionId; page through the rest with get_more_search_results, cancel ' +
        'with stop_search.\n' +
        "searchType 'files' (default): pattern is a substring of the file or directory name (e.g. 'config'), " +
        "or a glob when it contains * ? [ ] { } (e.g. '*.test.ts'); a pattern containing '/' is matched against " +
        "the path relative to `path` (e.g. 'src/utils'). Matching directories are listed too. " +
        'earlyTermination stops at the first file whose name equals the pattern.\n' +
        "searchType 'content': pattern is a regular expression (Rust regex syntax; literalSearch for exact " +
        'text) matched per line; results are file:line - line text, plus contextLines lines around each match ' +
        `(0-${MAX_CONTEXT_LINES}).\n` +
        "filePattern narrows both modes to files whose name matches one of its '|'-separated globs, e.g. " +
        "'*.ts|*.tsx' ('!glob' excludes; a glob with '/' is relative to `path`; case-sensitive). " +
        'Respects .gitignore/.ignore; node_modules and .git directories are skipped (unless `path` is inside ' +
        'one); hidden files are skipped unless includeHidden; symlinks are not followed. ' +
        `maxResults caps the total number of results (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_LIMIT}); ` +
        'timeout_ms stops the search early (hard limit 10 minutes). Use absolute paths.',
      inputSchema: startSchema,
      annotations: { title: 'Start Search', readOnlyHint: true, openWorldHint: false },
      handler: async (raw) => {
        const args = parseArgs(startSchema, raw);
        const allowed = ctx.config.getValue('allowedDirectories');
        const root = await validatePath(args.path, allowed);
        const maxResults = Math.min(args.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT);
        const session = await search.start({
          root,
          displayPath: args.path,
          pattern: args.pattern,
          searchType: args.searchType,
          filePattern: args.filePattern,
          ignoreCase: args.ignoreCase,
          maxResults,
          includeHidden: args.includeHidden,
          contextLines: args.searchType === 'content' ? Math.min(args.contextLines, MAX_CONTEXT_LINES) : 0,
          timeoutMs: args.timeout_ms !== undefined && args.timeout_ms > 0 ? args.timeout_ms : undefined,
          literalSearch: args.literalSearch,
          earlyTermination: args.searchType === 'files' && args.earlyTermination,
        });
        await search.waitFor(session, INITIAL_WAIT_MS);
        if (session.status === 'error') return errorResult(sessionErrorText(session));
        return textResult(describeStart(session));
      },
    }),
    defineTool({
      name: 'get_more_search_results',
      description:
        'Read results of a search started with start_search, while it runs or after it finished. ' +
        'offset/length select a range (0-based; default 0 and 100); a negative offset returns the last ' +
        '|offset| results. Sessions are kept for 5 minutes after the last read.',
      inputSchema: moreSchema,
      annotations: { title: 'Get Search Results', readOnlyHint: true, openWorldHint: false },
      handler: (raw) => {
        const { sessionId, offset, length } = parseArgs(moreSchema, raw);
        const session = search.read(sessionId);
        if (!session) throw new ToolError(`Search session ${sessionId} not found`);
        if (session.status === 'error') return errorResult(sessionErrorText(session));
        return describePage(session, offset, length);
      },
    }),
    defineTool({
      name: 'stop_search',
      description:
        'Stop a running search started with start_search. Results found so far stay readable with ' +
        'get_more_search_results.',
      inputSchema: stopSchema,
      annotations: { title: 'Stop Search', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: (raw) => {
        const { sessionId } = parseArgs(stopSchema, raw);
        const outcome = search.stop(sessionId);
        if (outcome === 'not-found') throw new ToolError(`Search session ${sessionId} not found`);
        if (outcome === 'already-complete') return `Search session ${sessionId} had already completed.`;
        return `Search session ${sessionId} terminated successfully.`;
      },
    }),
    defineTool({
      name: 'list_searches',
      description:
        'List search sessions (running and recently finished) with type, pattern, status, runtime and result count.',
      inputSchema: {},
      annotations: { title: 'List Searches', readOnlyHint: true, openWorldHint: false },
      handler: () => {
        const sessions = search.list();
        if (sessions.length === 0) return 'No active searches.';
        const blocks = sessions.map(
          (s) =>
            `Session: ${s.id}\n` +
            `  Type: ${s.options.searchType}\n` +
            `  Pattern: "${s.options.pattern}"\n` +
            `  Status: ${statusBadge(s)}\n` +
            `  Runtime: ${seconds(s.runtimeMs)}s\n` +
            `  Results: ${s.results.length}\n`,
        );
        return `Search sessions (${sessions.length}):\n\n${blocks.join('\n')}`.trimEnd();
      },
    }),
  ] as ToolDef[];
}
