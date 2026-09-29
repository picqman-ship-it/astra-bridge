import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConfigManager, type ConfigSource } from './config.js';
import { CallHistory } from './history.js';
import { SearchManager } from './search/manager.js';
import { TerminalManager } from './terminal/manager.js';
import { configTools } from './tools/config-tools.js';
import { editTools } from './tools/edit.js';
import { filesystemTools } from './tools/filesystem.js';
import { guiTools } from './tools/gui.js';
import { historyTools } from './tools/history-tools.js';
import { processTools } from './tools/process.js';
import { searchTools } from './tools/search.js';
import { terminalTools } from './tools/terminal.js';
import { errorResult, textResult, type ToolContext, type ToolDef, type ToolResult } from './types.js';
import { VERSION } from './version.js';

export const SERVER_NAME = 'mcp-commander';

/** History tools read the history itself; recording their calls would only add noise. */
const NOT_RECORDED = new Set(['get_recent_tool_calls']);

// Keep diagnostics and cleanup available, but never start new work with broken settings.
const CONFIG_ERROR_ALLOWED = new Set([
  'get_config', 'read_process_output', 'force_terminate', 'stop_search',
  'list_sessions', 'list_searches', 'get_recent_tool_calls', 'get_usage_stats',
]);

/** Metadata about one finished tool call (never its arguments or result). */
export interface ToolCallEvent {
  tool: string;
  ok: boolean;
  durationMs: number;
}

export interface CommanderServerOptions {
  configDir?: string;
  /** Use this configuration instead of a ConfigManager on configDir. */
  config?: ConfigSource;
  /** Shared services (remote sessions share one set); created per server when omitted. */
  history?: CallHistory;
  terminal?: TerminalManager;
  search?: SearchManager;
  /** Filters/wraps the tool list before registration (the remote entrypoint's policy). */
  selectTools?: (tools: ToolDef[]) => ToolDef[];
  /** Called after every tool call with metadata only. */
  onToolCall?: (event: ToolCallEvent) => void;
  instructions?: string;
}

const DEFAULT_INSTRUCTIONS =
  'mcp-commander gives you a terminal (long-running process sessions you can talk to), ' +
  'file reading/writing with line offsets, surgical edits (edit_block), and ripgrep-based search. ' +
  'Prefer absolute paths. Write large files in chunks (write_file mode "append"). On macOS, list_windows / inspect_ui / ' +
  'press_element / set_element_value operate app windows semantically through Accessibility (no coordinate clicks).';

export interface CommanderServer {
  server: McpServer;
  config: ConfigSource;
  history: CallHistory;
  terminal: TerminalManager;
  search: SearchManager;
  tools: ToolDef[];
  /** Kills child processes and searches. Safe to call more than once. */
  shutdown: () => Promise<void>;
  /**
   * Resolves once every tool call already received has returned and its reply was handed to the
   * transport, or after `timeoutMs`. Call after shutdown(), which makes running calls finish fast.
   */
  drain: (timeoutMs: number) => Promise<void>;
}

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

function normalizeResult(value: ToolResult | string): ToolResult {
  return typeof value === 'string' ? textResult(value) : value;
}

export function createCommanderServer(opts: CommanderServerOptions = {}): CommanderServer {
  const config = opts.config ?? new ConfigManager(opts.configDir);
  const history = opts.history ?? new CallHistory();
  const terminal = opts.terminal ?? new TerminalManager();
  const search = opts.search ?? new SearchManager();

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS },
  );

  const ctx: ToolContext = {
    config,
    getClientInfo: () => server.server.getClientVersion(),
  };

  const allTools: ToolDef[] = [
    ...configTools(ctx),
    ...filesystemTools(ctx),
    ...searchTools(ctx, search),
    ...editTools(ctx),
    ...terminalTools(ctx, terminal),
    ...processTools(ctx),
    ...guiTools(ctx),
    ...historyTools(ctx, history),
  ] as ToolDef[];
  const tools = opts.selectTools ? opts.selectTools(allTools) : allTools;

  const inFlight = new Set<Promise<unknown>>();
  const seen = new Set<string>();
  for (const def of tools) {
    if (seen.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
    seen.add(def.name);

    const known = Object.keys(def.inputSchema);
    // passthrough: unknown keys reach the handler wrapper so we can tell the model they were
    // ignored, instead of silently dropping them (and the schema honestly says they're allowed).
    const inputSchema = z.object(def.inputSchema).passthrough();
    // FIX: MCP makes tools/call `arguments` optional, but the SDK validates it as sent, so a
    // client omitting it (even for get_config, which takes nothing) got "Required". Treat a
    // missing arguments object as {}.
    const safeParseAsync = inputSchema.safeParseAsync.bind(inputSchema);
    inputSchema.safeParseAsync = (data, params) => safeParseAsync(data ?? {}, params);

    const runTool = async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const started = Date.now();
      const args = { ...(rawArgs ?? {}) };
      const unknown = Object.keys(args).filter((k) => !known.includes(k));
      for (const k of unknown) delete args[k];

      let result: ToolResult;
      try {
        config.get(); // Refresh settings before checking the error state.
        if (config.loadError && !CONFIG_ERROR_ALLOWED.has(def.name)) {
          throw new Error(`Configuration is unusable; new work is blocked. ${config.loadError}. Repair or recreate ${config.file} directly, or restart with a writable --config-dir; then retry.`);
        }
        result = normalizeResult(await def.handler(args as never));
      } catch (err) {
        result = errorResult(err instanceof Error ? err.message : String(err));
      }
      if (unknown.length) {
        result = {
          ...result,
          content: [
            {
              type: 'text',
              text:
                `You sent parameters not supported by this tool, which were ignored: ${unknown.join(', ')}. ` +
                `Supported parameters for ${def.name}: ${known.join(', ') || '(none)'}.`,
            },
            ...result.content,
          ],
        };
      }
      const durationMs = Date.now() - started;
      if (!NOT_RECORDED.has(def.name)) history.add(def.name, rawArgs, result, durationMs);
      try {
        opts.onToolCall?.({ tool: def.name, ok: !result.isError, durationMs });
      } catch {
        /* auditing must never change a tool result */
      }
      return result;
    };

    server.registerTool(
      def.name,
      { description: def.description, inputSchema, annotations: def.annotations },
      ((rawArgs: Record<string, unknown>) => {
        const call = runTool(rawArgs);
        inFlight.add(call);
        const done = () => void inFlight.delete(call);
        call.then(done, done);
        return call;
      }) as never,
    );
  }

  let shutDown: Promise<void> | null = null;
  const shutdown = () => {
    shutDown ??= (async () => {
      search.shutdown();
      await terminal.shutdown();
    })();
    return shutDown;
  };

  // FIX: on stdin EOF index.ts exited as soon as shutdown() returned, so replies to requests the
  // client had already sent (e.g. `cat requests.jsonl | mcp-commander`) were never written.
  const drain = async (timeoutMs: number) => {
    await nextMacrotask(); // requests already read from stdin reach their handlers first
    if (inFlight.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
      ]);
      clearTimeout(timer);
    }
    await nextMacrotask(); // the SDK sends each reply a few microtasks after the handler returns
  };

  return { server, config, history, terminal, search, tools, shutdown, drain };
}
