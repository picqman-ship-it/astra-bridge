import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RemoteConfig } from './config.js';
import { readPrivateFile } from './secrets.js';

/** Local checks against a running remote server. Never print the token. */

function baseUrl(cfg: RemoteConfig): string {
  return `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}`;
}

export function probeHealth(cfg: RemoteConfig, timeoutMs = 3000): Promise<{ reachable: boolean; status?: number; body?: string }> {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl(cfg)}/healthz`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d.slice(0, 1024)));
      res.on('end', () => resolve({ reachable: true, status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ reachable: false }));
  });
}

export interface McpProbe {
  ok: boolean;
  serverName?: string;
  serverVersion?: string;
  tools?: string[];
  error?: string;
}

/** Initializes an authenticated MCP session, lists tools, then deletes the session. */
export async function probeMcp(cfg: RemoteConfig, timeoutMs = 10_000): Promise<McpProbe> {
  const token = readPrivateFile(cfg.tokenFile, 'Token file', 4096).trim();
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl(cfg)}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mcp-commander-doctor', version: '1' });
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs).unref());
  try {
    await Promise.race([client.connect(transport), timer]);
    const info = client.getServerVersion();
    const { tools } = await Promise.race([client.listTools(), timer]);
    await transport.terminateSession().catch(() => {});
    return { ok: true, serverName: info?.name, serverVersion: info?.version, tools: tools.map((t) => t.name) };
  } catch (err) {
    // SDK errors can echo response bodies; keep only a short, token-free description.
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.replaceAll(token, '[redacted]').slice(0, 200) };
  } finally {
    await client.close().catch(() => {});
  }
}
