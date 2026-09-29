import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CommanderServer } from '../server.js';
import { sessionTag } from './audit.js';
import type { RemoteConfig } from './config.js';
import { RemoteRuntime } from './runtime.js';
import type { BearerToken } from './secrets.js';

/**
 * Streamable HTTP entrypoint (MCP 2025-03-26+ transport) on plain node:http.
 *
 * Every request passes, in order: Host allowlist → Origin allowlist (browsers are refused unless
 * their exact origin is listed; there are no CORS headers at all) → path/method → bearer token →
 * content type and bounded body → session lookup. Nothing about a session is revealed before the
 * token is checked. Error bodies are fixed strings; internal errors are logged by class only.
 *
 * Sessions: POST initialize (no Mcp-Session-Id) creates one; later requests must carry its id.
 * DELETE closes it. A session with no POST/DELETE activity for limits.sessionIdleMs is closed (an
 * open GET notification stream does not keep it alive). When maxSessions is reached, the least
 * recently used session with no request in flight is closed to make room; if all are busy, 503.
 * Closing a session never stops processes: those belong to the RemoteRuntime (see runtime.ts).
 */

interface SessionEntry {
  id?: string;
  transport: StreamableHTTPServerTransport;
  commander: CommanderServer;
  lastActive: number;
  active: number;
  closed: boolean;
}

export interface RemoteHttpServer {
  server: http.Server;
  runtime: RemoteRuntime;
  port: number;
  url: string;
  sessionCount(): number;
  /** Stops accepting requests, stops owned processes, closes sessions. Idempotent. */
  close(): Promise<void>;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, extra);
}

/** application/json, optionally with charset=utf-8 and nothing else. */
export function isJsonMediaType(value: string | undefined): boolean {
  if (!value) return false;
  const [type, ...params] = value.split(';').map((p) => p.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.every((p) => p === '' || p === 'charset=utf-8' || p === 'charset="utf-8"');
}

type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; code: number; message: string };

function readJsonBody(req: http.IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.resolve({ ok: false, status: 413, code: -32000, message: 'Payload too large' });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: BodyResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413, code: -32000, message: 'Payload too large' });
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => finish({ ok: false, status: 400, code: -32700, message: 'Parse error' }));
    req.on('aborted', () => finish({ ok: false, status: 400, code: -32700, message: 'Parse error' }));
    req.on('end', () => {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return finish({ ok: false, status: 400, code: -32700, message: 'Parse error: body is not UTF-8' });
      }
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, status: 400, code: -32700, message: 'Parse error: Invalid JSON' });
      }
    });
  });
}

export async function startRemoteHttpServer(
  cfg: RemoteConfig,
  token: BearerToken,
  runtime: RemoteRuntime = new RemoteRuntime(cfg),
): Promise<RemoteHttpServer> {
  const sessions = new Map<string, SessionEntry>();
  const pending = new Set<SessionEntry>();
  const allowedHosts = new Set(cfg.allowedHosts.map((h) => h.toLowerCase()));
  const allowedOrigins = new Set(cfg.allowedOrigins);
  const limits = cfg.limits;
  let closing: Promise<void> | null = null;

  const closeEntry = (entry: SessionEntry, reason: string) => {
    if (entry.closed) return;
    entry.closed = true;
    pending.delete(entry);
    if (entry.id) {
      sessions.delete(entry.id);
      runtime.audit.write({ event: 'session_close', session: sessionTag(entry.id), reason });
    }
    // Closes the transport too (its onclose re-enters here and returns early).
    entry.commander.server.close().catch(() => {});
  };

  const evictOne = (): boolean => {
    let victim: SessionEntry | undefined;
    for (const e of sessions.values()) {
      if (e.active === 0 && (!victim || e.lastActive < victim.lastActive)) victim = e;
    }
    if (!victim) return false;
    closeEntry(victim, 'evicted');
    return true;
  };

  const sweepEvery = Math.min(60_000, Math.max(250, Math.floor(limits.sessionIdleMs / 4)));
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const e of sessions.values()) {
      if (e.active === 0 && now - e.lastActive > limits.sessionIdleMs) closeEntry(e, 'idle');
    }
  }, sweepEvery);
  sweeper.unref();

  const track = async (entry: SessionEntry, run: () => Promise<void>) => {
    entry.active++;
    entry.lastActive = Date.now();
    try {
      await run();
    } finally {
      entry.active--;
      entry.lastActive = Date.now();
    }
  };

  const newSession = async (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => {
    if (sessions.size + pending.size >= limits.maxSessions && !evictOne()) {
      return rpcError(res, 503, -32000, 'Too many active sessions; retry later', { 'Retry-After': '30' });
    }
    const entry = {} as SessionEntry;
    entry.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      maxRequestBodySize: limits.maxBodyBytes,
      onsessioninitialized: (id) => {
        entry.id = id;
        pending.delete(entry);
        sessions.set(id, entry);
        runtime.audit.write({ event: 'session_open', session: sessionTag(id) });
      },
    });
    entry.transport.onclose = () => closeEntry(entry, 'closed');
    entry.commander = runtime.createServer(() => entry.id);
    entry.lastActive = Date.now();
    entry.active = 0;
    entry.closed = false;
    pending.add(entry);
    await entry.commander.server.connect(entry.transport);
    await track(entry, () => entry.transport.handleRequest(req, res, body));
    if (!entry.id) closeEntry(entry, 'init_failed');
  };

  const handleMcp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      return rpcError(res, 405, -32000, 'Method not allowed', { Allow: 'GET, POST, DELETE' });
    }
    if (!token.matchesHeader(req.headers.authorization)) {
      runtime.audit.write({ event: 'auth_failed', status: 'denied' });
      return rpcError(res, 401, -32001, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="mcp-commander"' });
    }
    const sidHeader = req.headers['mcp-session-id'];
    if (Array.isArray(sidHeader)) return rpcError(res, 400, -32000, 'Bad Request: one Mcp-Session-Id header expected');

    let body: unknown;
    if (method === 'POST') {
      if (!isJsonMediaType(req.headers['content-type'])) {
        return rpcError(res, 415, -32000, 'Unsupported Media Type: Content-Type must be application/json');
      }
      const parsed = await readJsonBody(req, limits.maxBodyBytes);
      if (!parsed.ok) return rpcError(res, parsed.status, parsed.code, parsed.message, parsed.status === 413 ? { Connection: 'close' } : {});
      body = parsed.value;
      if (!sidHeader) {
        if (isInitializeRequest(body)) return newSession(req, res, body);
        return rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      }
    } else if (!sidHeader) {
      return rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    }

    const entry = SESSION_ID.test(sidHeader) ? sessions.get(sidHeader) : undefined;
    if (!entry || entry.closed) return rpcError(res, 404, -32001, 'Session not found');
    if (method === 'GET') {
      entry.lastActive = Date.now();
      return entry.transport.handleRequest(req, res);
    }
    return track(entry, () => entry.transport.handleRequest(req, res, body));
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!allowedHosts.has(host)) return sendJson(res, 403, { error: 'Forbidden' });
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin)) return sendJson(res, 403, { error: 'Forbidden' });

      const rawUrl = req.url ?? '/';
      const q = rawUrl.indexOf('?');
      const pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
      if (pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
        return sendJson(res, closing ? 503 : 200, { status: closing ? 'stopping' : 'ok' });
      }
      if (pathname !== '/mcp') return sendJson(res, 404, { error: 'Not found' });
      // Credentials never travel in URLs; a query string is refused outright.
      if (q !== -1) return rpcError(res, 400, -32000, 'Bad Request: query parameters are not accepted');
      if (closing) return rpcError(res, 503, -32000, 'Server is shutting down');
      await handleMcp(req, res);
    } catch (err) {
      console.error(`[mcp-commander-remote] request failed (${err instanceof Error ? err.name : 'error'})`);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error');
      else res.end();
    }
  };

  const server = http.createServer(
    {
      maxHeaderSize: 16 * 1024,
      headersTimeout: limits.headersTimeoutMs,
      requestTimeout: limits.requestTimeoutMs,
      keepAliveTimeout: limits.keepAliveTimeoutMs,
      requireHostHeader: true,
    },
    (req, res) => void handler(req, res),
  );
  server.maxConnections = limits.maxConnections;
  server.maxHeadersCount = 64;
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const hostForUrl = cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;

  const close = () => {
    closing ??= (async () => {
      clearInterval(sweeper);
      server.close();
      // Stopping processes first makes running tool calls return, so their replies can be sent.
      await runtime.shutdown();
      const all = [...sessions.values(), ...pending];
      await Promise.all(all.map((e) => e.commander.drain(2000)));
      for (const e of all) closeEntry(e, 'shutdown');
      server.closeAllConnections();
    })();
    return closing;
  };

  return {
    server,
    runtime,
    port,
    url: `http://${hostForUrl}:${port}/mcp`,
    sessionCount: () => sessions.size,
    close,
  };
}
