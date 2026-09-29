import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  exposeApprovedTool,
  isToolApproved,
  OAUTH_SCOPES,
  requiredScope,
  type OAuthScope,
} from "./tool-policy";
import {
  hashBearerToken,
  isToolAllowedForPrincipal,
  resolveBetaBearerHash,
  type BetaPrincipal,
  type D1DatabaseLike,
} from "./beta-registry";
import { equalSecret } from "./secrets";

export const MCP_PATH = "/mcp";
export const MCP_MAX_BODY_BYTES = 64 * 1024;

export type RelayPayload =
  | { action: "tools/list" }
  | { action: "tools/call"; name: string; arguments?: Record<string, unknown> };

export type McpPrincipal = BetaPrincipal & {
  kind: "personal" | "oauth" | "access" | "beta";
  scopes: readonly OAuthScope[];
};

export type McpRelay = (payload: RelayPayload, principal: McpPrincipal) => Promise<unknown>;

export type McpAuthOptions = {
  /** Absolute RFC 9728 metadata URL advertised in every Bearer challenge. */
  resourceMetadataUrl?: string;
  /** Resolves an OAuth access token to its granted scopes, or null (fail closed). */
  verifyAccessToken?: (token: string) => Promise<readonly OAuthScope[] | null>;
  /**
   * Replaces bearer authentication entirely (Cloudflare Access mode). The
   * Authorization header is then never read, and a 401 carries no Bearer
   * challenge because the origin is not the authorization server.
   */
  authenticate?: (request: Request) => Promise<McpPrincipal | null>;
};

type McpEnv = {
  MCP_BEARER_TOKEN?: string;
  MCP_DEVICE_ID?: string;
  BETA_REGISTRY_ENABLED?: string;
  BETA_REGISTRY?: D1DatabaseLike;
};

/** Relay failure carrying a fixed error code; only codes in PUBLIC_ERROR_HINTS reach clients. */
export class RelayError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// Fixed, non-sensitive codes a client may see. Anything else becomes "tool_failed".
const PUBLIC_ERROR_HINTS: Record<string, string> = {
  idempotency_key_required:
    "This tool requires an idempotencyKey argument (unique string, 8-200 chars). Reuse the same key only to retry the same action.",
  tool_not_approved: "Tool is not approved.",
  invalid_arguments: "The downstream tool rejected the arguments.",
  tool_not_found: "The downstream tool is not available.",
  rate_limited: "Rate limited; retry later.",
  too_many_pending_requests: "Too many requests in flight; retry shortly.",
  agent_busy: "The Mac agent is busy; retry shortly.",
  agent_unavailable: "The Mac agent is offline or unhealthy.",
  mcp_unavailable: "The Mac's local MCP server is unavailable.",
  agent_send_failed: "The Mac agent connection dropped before the request was sent.",
  agent_disconnected:
    "The Mac agent disconnected before replying; the outcome is unknown. Retry mutating tools only with the same idempotencyKey.",
  agent_timeout:
    "The Mac agent did not reply in time; the outcome is unknown. Retry mutating tools only with the same idempotencyKey.",
  tool_timeout:
    "The tool did not finish in time; the outcome is unknown. Retry mutating tools only with the same idempotencyKey.",
  result_too_large: "The tool result exceeded the relay size limit.",
  request_too_large: "The tool request exceeded the relay size limit.",
};

export function publicErrorCode(err: unknown): string {
  const code = err instanceof RelayError ? err.code : "";
  return code in PUBLIC_ERROR_HINTS ? code : "tool_failed";
}

function toolError(code: string) {
  const hint = PUBLIC_ERROR_HINTS[code] ?? "Tool request failed.";
  return { content: [{ type: "text", text: `Tool request failed (${code}). ${hint}` }], isError: true };
}

function hasRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function bearerToken(request: Request): Promise<string | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const candidate = authorization.slice("Bearer ".length);
  return candidate.length >= 32 ? candidate : null;
}

/**
 * The personal operator bearer is intentionally checked first and resolves to the
 * existing fixed MCP device with every scope. OAuth access tokens resolve to the
 * same owner device with only their granted scopes. D1 is consulted only when both
 * beta opt-ins exist.
 */
export async function authenticateMcpRequest(
  request: Request,
  env: McpEnv,
  auth: McpAuthOptions = {},
): Promise<McpPrincipal | null> {
  const candidate = await bearerToken(request);
  if (!candidate) return null;
  if (env.MCP_BEARER_TOKEN && env.MCP_BEARER_TOKEN.length >= 32
    && await equalSecret(candidate, env.MCP_BEARER_TOKEN)) {
    if (!env.MCP_DEVICE_ID) return null;
    return {
      kind: "personal", ownerId: "personal", deviceId: env.MCP_DEVICE_ID, terminalEnabled: true, scopes: OAUTH_SCOPES,
    };
  }
  if (auth.verifyAccessToken) {
    const scopes = await auth.verifyAccessToken(candidate);
    if (scopes) {
      if (!env.MCP_DEVICE_ID || scopes.length === 0) return null;
      return { kind: "oauth", ownerId: "owner", deviceId: env.MCP_DEVICE_ID, terminalEnabled: true, scopes };
    }
  }
  if (env.BETA_REGISTRY_ENABLED !== "true" || !env.BETA_REGISTRY) return null;
  const beta = await resolveBetaBearerHash(env.BETA_REGISTRY, await hashBearerToken(candidate));
  return beta ? { kind: "beta", ...beta, scopes: OAUTH_SCOPES } : null;
}

/**
 * RFC 6750 / RFC 9728 challenge. Parameter values are fixed strings, scope names
 * and the configured metadata URL; request data never reaches the header.
 */
export function bearerChallenge(
  auth: McpAuthOptions,
  params: { error?: "invalid_token" | "insufficient_scope"; description?: string; scopes?: readonly string[] } = {},
): string {
  const parts = ['realm="astra-bridge"'];
  if (params.error) parts.push(`error="${params.error}"`);
  if (params.description) parts.push(`error_description="${params.description}"`);
  if (auth.resourceMetadataUrl) parts.push(`resource_metadata="${auth.resourceMetadataUrl}"`);
  parts.push(`scope="${(params.scopes ?? OAUTH_SCOPES).join(" ")}"`);
  return `Bearer ${parts.join(", ")}`;
}

function hasScope(principal: McpPrincipal, name: string): boolean {
  const scope = requiredScope(name);
  return scope !== null && principal.scopes.includes(scope);
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function protocolError(status: number, message: string, code = -32000, headers: Record<string, string> = {}): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

type BodyRead = { ok: true; text: string } | { ok: false; status: number; message: string };

/**
 * Counts actual bytes while streaming and stops at the limit; Content-Length is only
 * an early reject, never trusted as the size.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<BodyRead> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= maxBytes)) {
    return { ok: false, status: 413, message: "Payload Too Large" };
  }
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel("request too large").catch(() => {});
        return { ok: false, status: 413, message: "Payload Too Large" };
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return { ok: false, status: 400, message: "Bad request body" };
  } finally {
    reader.releaseLock();
  }
  return { ok: true, text: text + decoder.decode() };
}

/**
 * Tool-level step-up challenge. The requested scope set keeps what the caller
 * already holds, because scopes are not hierarchical.
 */
function insufficientScope(name: string, principal: McpPrincipal, auth: McpAuthOptions) {
  const scope = requiredScope(name)!;
  const scopes = OAUTH_SCOPES.filter((item) => item === scope || principal.scopes.includes(item));
  return {
    content: [{ type: "text", text: `This tool requires the ${scope} scope, which this authorization did not grant.` }],
    isError: true,
    _meta: {
      "mcp/www_authenticate": [bearerChallenge(auth, {
        error: "insufficient_scope",
        description: `The ${scope} scope is required`,
        scopes,
      })],
    },
  };
}

function createServer(relay: McpRelay, principal: McpPrincipal, auth: McpAuthOptions): Server {
  const server = new Server(
    { name: "astra-bridge-relay", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let result: unknown;
    try {
      result = await relay({ action: "tools/list" }, principal);
    } catch (err) {
      throw new McpError(ErrorCode.InternalError, `Tool list unavailable (${publicErrorCode(err)})`);
    }
    if (!hasRecord(result) || !Array.isArray(result.tools)) {
      throw new McpError(ErrorCode.InternalError, "Tool list unavailable (tool_failed)");
    }
    // Unreviewed downstream tools are dropped rather than failing the whole listing.
    const tools = result.tools
      .filter(hasRecord)
      .map(exposeApprovedTool)
      .filter((tool): tool is Record<string, unknown> => tool !== null);
    return {
      tools: tools.filter((tool) => isToolAllowedForPrincipal(tool.name as string, principal)
        && hasScope(principal, tool.name as string)),
    } as any;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!isToolApproved(request.params.name)) return toolError("tool_not_approved");
    if (!isToolAllowedForPrincipal(request.params.name, principal)) {
      return { content: [{ type: "text", text: "Tool is not enabled for this device." }], isError: true };
    }
    if (!hasScope(principal, request.params.name)) return insufficientScope(request.params.name, principal, auth);
    try {
      const result = await relay({
        action: "tools/call",
        name: request.params.name,
        arguments: request.params.arguments,
      }, principal);
      if (!hasRecord(result) || !Array.isArray(result.content)) throw new RelayError("tool_failed");
      return result;
    } catch (err) {
      return toolError(publicErrorCode(err));
    }
  });

  return server;
}

/**
 * Stateless Streamable HTTP: every request gets a fresh MCP server/transport,
 * so no MCP session ID or client identity is persisted in the Worker.
 */
export async function handleMcpRequest(
  request: Request,
  env: McpEnv,
  relay: McpRelay,
  auth: McpAuthOptions = {},
): Promise<Response> {
  const principal = auth.authenticate
    ? await auth.authenticate(request)
    : await authenticateMcpRequest(request, env, auth);
  if (!principal) {
    if (auth.authenticate) return protocolError(401, "Unauthorized");
    // RFC 6750 §3.1: a request with no credentials gets no error code.
    const presented = request.headers.has("authorization");
    return protocolError(401, "Unauthorized", -32000, {
      "www-authenticate": bearerChallenge(auth, presented
        ? { error: "invalid_token", description: "The access token is invalid or expired" }
        : {}),
    });
  }
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  }

  // Reject non-JSON before reading any body; the SDK re-validates the headers.
  const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return protocolError(415, "Unsupported Media Type: Content-Type must be application/json");
  }

  const body = await readBoundedText(request, MCP_MAX_BODY_BYTES);
  if (!body.ok) return protocolError(body.status, body.message);
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.text);
  } catch {
    return protocolError(400, "Parse error: Invalid JSON", -32700);
  }
  // JSON-RPC batches would fan one HTTP request out into many relay calls; MCP
  // 2025-06-18 removed batching, so reject them outright.
  if (Array.isArray(parsedBody)) {
    return protocolError(400, "Batch requests are not supported", -32600);
  }

  const server = createServer(relay, principal, auth);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });
  await server.connect(transport);
  try {
    return withNoStore(await transport.handleRequest(request, { parsedBody }));
  } finally {
    await transport.close();
    await server.close();
  }
}
