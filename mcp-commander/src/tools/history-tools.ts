import { z } from 'zod';
import type { CallHistory } from '../history.js';
import { defineTool, type ToolContext } from '../types.js';

export function historyTools(_ctx: ToolContext, history: CallHistory) {
  return [
    defineTool({
      name: 'get_recent_tool_calls',
      description:
        'Get recent tool calls made to this server in this session (oldest first): arguments (long strings ' +
        'truncated), output summary, error flag and duration. Useful to recover context after a chat was cut off. ' +
        'History is kept in memory only (last 1000 calls) and is lost when the server restarts.',
      inputSchema: {
        maxResults: z.coerce.number().int().min(1).max(1000).optional().describe('Default 50'),
        toolName: z.string().optional().describe('Only calls to this tool'),
        since: z.string().optional().describe('ISO 8601 timestamp; only calls at or after it'),
      },
      annotations: { title: 'Get Recent Tool Calls', readOnlyHint: true },
      handler: ({ maxResults, toolName, since }) => {
        const calls = history.recent({ maxResults, toolName, since });
        return (
          `Tool Call History (${calls.length} results, ${history.size} total in memory)\n\n` +
          JSON.stringify(calls, null, 2)
        );
      },
    }),
    defineTool({
      name: 'get_usage_stats',
      description: 'Usage statistics for this server session: total/successful/failed calls and the most used tools.',
      inputSchema: {},
      annotations: { title: 'Get Usage Statistics', readOnlyHint: true },
      handler: () => {
        const s = history.stats();
        const uptimeMin = ((Date.now() - history.startedAt.getTime()) / 60000).toFixed(1);
        const rate = s.total ? ((s.ok / s.total) * 100).toFixed(1) : '0.0';
        const top = s.perTool.slice(0, 10).map(([n, c]) => `  • ${n}: ${c}`).join('\n') || '  • none';
        return (
          `📊 Usage Summary (this session, uptime ${uptimeMin} min)\n` +
          `• Total calls: ${s.total} (${s.ok} successful, ${s.failed} failed)\n` +
          `• Success rate: ${rate}%\n` +
          `• Unique tools used: ${s.perTool.length}\n` +
          `• Most used:\n${top}`
        );
      },
    }),
  ];
}
