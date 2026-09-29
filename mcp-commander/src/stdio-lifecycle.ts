import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Resolves once everything already written to stdout has reached the pipe, or after `timeoutMs`
 * (a client that stopped reading must not keep us alive).
 *
 * FIX: pipes are asynchronous on macOS, and process.exit() drops whatever is still queued. When
 * the client closed stdin (the MCP way to ask for shutdown) while a large reply was still being
 * written, the client got a truncated, unparseable JSON line on stdout.
 */
function flushStdout(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdout.writableLength || process.stdout.destroyed) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    // Writes complete in order, so this callback runs after all earlier data was flushed.
    process.stdout.write('', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface StdioTarget {
  server: McpServer;
  /** Stops children and searches (called first on exit). */
  shutdown: () => Promise<void>;
  /** Waits for replies to requests already received. */
  drain: (timeoutMs: number) => Promise<void>;
}

/** Serves `target` over stdin/stdout until the client goes away or a signal arrives, then exits. */
export async function serveStdio(target: StdioTarget, label: string, readyMessage: string): Promise<void> {
  const transport = new StdioServerTransport();

  let exiting = false;
  const exit = async (code: number) => {
    if (exiting) return;
    exiting = true;
    try {
      // Children and searches go first, so tool calls still running return promptly; then the
      // replies to every request already received are written before we exit.
      await target.shutdown();
      await target.drain(2000);
    } finally {
      await flushStdout(2000);
      process.exit(code);
    }
  };

  // The client closing our stdin is the normal way an stdio MCP server is told to stop;
  // the SDK transport does not react to it, so child processes would otherwise be orphaned.
  process.stdin.on('end', () => void exit(0));
  process.stdin.on('close', () => void exit(0));
  process.on('SIGINT', () => void exit(0));
  process.on('SIGTERM', () => void exit(0));
  process.on('SIGHUP', () => void exit(0));
  // The SDK transport closes itself on a fatal read error (e.g. a message over its 10MB buffer
  // limit) and then pauses stdin, so neither a reply nor stdin 'end' would ever come again: the
  // server and its child processes lingered forever. Shut down instead.
  target.server.server.onerror = (err) => {
    console.error(`[${label}] transport error:`, err instanceof Error ? err.message : err);
  };
  target.server.server.onclose = () => void exit(1);
  process.on('uncaughtException', (err) => {
    console.error(`[${label}] uncaught exception:`, err);
  });
  process.on('unhandledRejection', (err) => {
    console.error(`[${label}] unhandled rejection:`, err);
  });

  await target.server.connect(transport);
  console.error(`[${label}] ${readyMessage}`);
}
