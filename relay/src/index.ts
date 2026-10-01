import { DurableObject } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { authenticateBetaMcpRequest, handleMcpRequest, RelayError, type McpRelay, type RelayPayload } from "./mcp";
import { ACCESS_JWT_HEADER, accessConfig, authenticateAccessRequest, mcpAuthMode, verifyAccessJwt, type AccessEnv } from "./access-auth";
import { resolveAccessIdentityDevice } from "./access-registry";
import { resolveAgentAuthentication } from "./agent-auth";
import { handleEnrollment } from "./beta-enrollment";
import { BodyTooLargeError, readBoundedBody } from "./bounded-body";
import { recordAuditEvent, type D1DatabaseLike } from "./beta-registry";
import { betaRateGate, type BetaRateEnv } from "./beta-rate-limit";
import { isBetaDeviceId, isPersonalDeviceId } from "./beta-identity";
import { handleOAuthRoute, oauthConfig, verifyOAuthAccessToken, type OAuthEnv } from "./oauth";
import { hasValidIdempotencyKey, IDEMPOTENCY_REQUIRED, isToolApproved } from "./tool-policy";
import { handlePairClaim, handlePairStart, handlePairStatus } from "./pairing-http";

export { OAuthStore } from "./oauth-store";

interface Env extends OAuthEnv, AccessEnv, BetaRateEnv {
  DEVICE_RELAY: DurableObjectNamespace<DeviceRelay>;
  AGENT_PUBLIC_KEY_B64: string;
  CLIENT_PUBLIC_KEY_B64: string;
  AGENT_DEVICE_ID: string;
  CLIENT_DEVICE_ID: string;
  MCP_DEVICE_ID: string;
  MCP_BEARER_TOKEN?: string;
  OPENAI_APPS_CHALLENGE?: string;
  BETA_REGISTRY_ENABLED?: string;
  BETA_ENROLLMENT_ENABLED?: string;
  BETA_REGISTRY?: D1DatabaseLike;
  /** "fixed" (default) keeps the single owner device; "registry" routes Access identities through D1. */
  ACCESS_DEVICE_ROUTING?: string;
  /** Explicit opt-in for the account/device pairing endpoints. */
  PAIRING_ENABLED?: string;
  // Liveness alerting (see scheduled() below). Absent in tests/dry-run: alerting then
  // no-ops instead of throwing, so a missing binding never breaks agent-state bookkeeping.
  ALERT_EMAIL?: SendEmail;
  ALERT_FROM_ADDRESS?: string;
  ALERT_TO_ADDRESS?: string;
}

type RpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; status: number; error: string; retryAfter?: string };

type RpcPayload = RelayPayload;

type Pending = {
  connId: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type AgentAttachment = { role: "agent"; connId: string; connectedAt: number };

type RateBucket = "agent" | "client";

export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_PENDING = 8;
export const MAX_AGENT_MESSAGE_BYTES = 1024 * 1024;
const AUTH_SKEW_MS = 60_000;
export const NONCE_TTL_MS = 120_000;
const RATE_WINDOW_MS = 60_000;
export const MAX_AUTH_REQUESTS_PER_WINDOW = 240;
// The agent sends AGENT_PING every 30 s. The runtime answers it with AGENT_PONG through
// setWebSocketAutoResponse without waking the Durable Object, so an idle connection
// hibernates instead of being billed for duration around the clock. Liveness is read back
// with getWebSocketAutoResponseTimestamp. Both strings must match the agent byte for byte.
export const AGENT_PING = '{"type":"ping"}';
export const AGENT_PONG = '{"type":"pong"}';
// Two missed 30 s pings plus slack.
export const AGENT_STALE_MS = 75_000;
const AGENT_RPC_TIMEOUT_MS = 30_000;

// Liveness alerting (scheduled(), DeviceRelay.checkAndAlert()). A scheduled check runs
// roughly every 5 minutes (see wrangler.jsonc triggers.crons); requiring two consecutive
// unhealthy checks before alerting absorbs a single missed heartbeat around check time.
// While still down, a repeat email only goes out every ALERT_REPEAT_MS so a real outage
// does not spam an inbox every 5 minutes.
export const ALERT_MIN_CONSECUTIVE_UNHEALTHY = 2;
export const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

// Fixed codes that may be returned to signed-RPC and MCP clients, with their HTTP status.
// Any other string coming back from the agent is collapsed to "tool_failed".
const AGENT_ERROR_STATUS: Record<string, number> = {
  agent_timeout: 504,
  tool_timeout: 504,
  agent_busy: 503,
  mcp_unavailable: 502,
  agent_disconnected: 502,
  agent_socket_error: 502,
  agent_message_too_large: 502,
  result_too_large: 502,
  invalid_arguments: 400,
  tool_not_found: 502,
  unsupported_action: 400,
  tool_name_required: 400,
  tool_error: 502,
};

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...extraHeaders },
  });
}

function fromBase64(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authShapeOk(request: Request): boolean {
  const timestamp = request.headers.get("x-astra-timestamp");
  const nonce = request.headers.get("x-astra-nonce");
  const signature = request.headers.get("x-astra-signature");
  if (!timestamp || !nonce || !signature) return false;
  if (!/^\d{13}$/.test(timestamp)) return false;
  if (!/^[a-f0-9]{32,64}$/i.test(nonce)) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 256) return false;
  const at = Number(timestamp);
  return Number.isFinite(at) && Math.abs(Date.now() - at) <= AUTH_SKEW_MS;
}
async function readBodyBounded(request: Request): Promise<Uint8Array> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) {
    return new Uint8Array();
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_BODY_BYTES) {
      throw new BodyTooLargeError("request_too_large");
    }
  }

  return readBoundedBody(request.body, MAX_BODY_BYTES, { ignoreCancelErrors: true });
}
async function verifySignedRequest(
  request: Request,
  publicKeyB64: string | undefined,
  body: Uint8Array,
): Promise<boolean> {
  if (!publicKeyB64 || !authShapeOk(request)) return false;

  const timestamp = request.headers.get("x-astra-timestamp")!;
  const nonce = request.headers.get("x-astra-nonce")!;
  const signature = request.headers.get("x-astra-signature")!;
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", body));
  const url = new URL(request.url);
  const target = url.pathname + url.search;
  const canonical = [
    timestamp,
    nonce,
    request.method.toUpperCase(),
    target,
    bodyHash,
  ].join("\n");

  try {
    const key = await crypto.subtle.importKey(
      "spki",
      fromBase64(publicKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      fromBase64(signature),
      new TextEncoder().encode(canonical),
    );
  } catch {
    return false;
  }
}

async function handleMcpRoute(request: Request, env: Env): Promise<Response> {
  if (!isPersonalDeviceId(env.MCP_DEVICE_ID, env.BETA_REGISTRY_ENABLED === "true")) {
    return json({ error: "personal_device_id_reserved" }, 503);
  }

  // Authentication resolves the principal first. The MCP request cannot select a
  // device: operator, OAuth, and Access auth resolve to MCP_DEVICE_ID. Beta principals
  // are refused on this personal route; closed-beta routing is separate below.
  const registryRouting = env.ACCESS_DEVICE_ROUTING?.trim().toLowerCase() === "registry";

  const relay: McpRelay = async (payload, principal) => {
    const dynamicAccess = registryRouting && principal.kind === "access";
    if (principal.kind === "beta" || (!dynamicAccess && principal.deviceId !== env.MCP_DEVICE_ID)) {
      throw new RelayError("agent_unavailable");
    }
    const stub = env.DEVICE_RELAY.getByName(principal.deviceId);
    const outcome = await stub.mcpRpc(payload) as unknown as RpcOutcome;
    if (!outcome.ok) throw new RelayError(outcome.error);
    return outcome.result;
  };

  // Access mode fails closed on missing or malformed config and never falls back
  // to the static bearer or the Worker's own OAuth tokens.
  const mode = mcpAuthMode(env);
  if (mode === null) return json({ error: "service_unavailable" }, 503);
  if (mode === "access") {
    const access = accessConfig(env);
    if (!access) return json({ error: "service_unavailable" }, 503);

    if (registryRouting) {
      if (env.BETA_REGISTRY_ENABLED !== "true" || !env.BETA_REGISTRY) {
        return json({ error: "service_unavailable" }, 503);
      }
      return handleMcpRequest(request, env, relay, {
        authenticate: (req) => authenticateAccessRequest(
          req,
          access,
          undefined,
          undefined,
          (identity) => resolveAccessIdentityDevice(
            env.BETA_REGISTRY!,
            access.issuer,
            identity.subject,
          ),
        ),
      });
    }

    return handleMcpRequest(request, env, relay, {
      authenticate: (req) => authenticateAccessRequest(req, access, env.MCP_DEVICE_ID),
    });
  }

  const config = oauthConfig(env);
  return handleMcpRequest(request, env, relay, {
    resourceMetadataUrl: config?.resourceMetadataUrl,
    verifyAccessToken: (token) => verifyOAuthAccessToken(env, token),
  });
}

async function handleBetaMcpRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (env.BETA_REGISTRY_ENABLED !== "true" || !env.BETA_REGISTRY) {
    return json({ error: "not_found" }, 404);
  }
  const limited = await betaRateGate(request, env, "mcp");
  if (limited) return limited;

  const relay: McpRelay = async (payload, principal) => {
    if (principal.kind !== "beta") throw new RelayError("agent_unavailable");
    const stub = env.DEVICE_RELAY.getByName(principal.deviceId);
    const outcome = await stub.mcpRpc(payload) as unknown as RpcOutcome;
    if (!outcome.ok) throw new RelayError(outcome.error);
    return outcome.result;
  };

  return handleMcpRequest(request, env, relay, {
    auditTool: (principal, name, outcome, durationMs) => {
      const pending = recordAuditEvent(env.BETA_REGISTRY!, {
        eventId: crypto.randomUUID(), ownerId: principal.ownerId, deviceId: principal.deviceId,
        toolName: name, outcome, durationMs, createdAt: new Date().toISOString(),
      }).catch(() => { /* Metadata audit is best effort and never logs errors/payloads. */ });
      if (ctx) ctx.waitUntil(pending);
    },
    authenticate: async (req) => {
      const principal = await authenticateBetaMcpRequest(req, env);
      // Even an incorrectly provisioned registry row cannot target a personal device.
      return principal?.kind === "beta"
        && ![env.AGENT_DEVICE_ID, env.CLIENT_DEVICE_ID, env.MCP_DEVICE_ID].includes(principal.deviceId)
        ? principal : null;
    },
  }).catch(() => json({ error: "service_unavailable" }, 503));
}

// ---- Liveness alert email (plain RFC 5322 message, no library) --------------------

function utf8ToBase64(str: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

function alertEncodeSubject(str: string): string {
  return `=?UTF-8?B?${utf8ToBase64(str)}?=`;
}

function alertEncodeBodyB64(str: string): string {
  const b64 = utf8ToBase64(str);
  return (b64.match(/.{1,76}/g) ?? [b64]).join("\r\n");
}

function buildAlertRawEmail(
  kind: "down" | "recovered",
  state: { lastSeen: number | null; socketPresent: boolean; mcpHealthy: boolean },
  from: string,
  to: string,
): string {
  const now = new Date();
  const subject = kind === "down"
    ? "Astra Bridge: Mac agent is not responding"
    : "Astra Bridge: Mac agent is back online";
  const lastSeenLine = state.lastSeen === null
    ? "The agent has not connected since this Worker was deployed."
    : `Last seen: ${new Date(state.lastSeen).toISOString()} (${Math.round((Date.now() - state.lastSeen) / 1000)}s ago)`;
  const bodyText = [
    kind === "down"
      ? "The Astra Bridge relay no longer sees a live connection from the Mac agent (at least two scheduled checks in a row)."
      : "The Astra Bridge relay sees a live connection from the Mac agent again.",
    "",
    `Time: ${now.toISOString()}`,
    `socketPresent: ${state.socketPresent}`,
    `mcpHealthy: ${state.mcpHealthy}`,
    lastSeenLine,
    "",
    kind === "down"
      ? "If this is unexpected, check that the Mac is awake, logged in and the agent LaunchAgent is running."
      : "No action needed.",
  ].join("\n");

  return [
    `From: Astra Bridge <${from}>`,
    `To: ${to}`,
    `Subject: ${alertEncodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    `Date: ${now.toUTCString()}`,
    ``,
    alertEncodeBodyB64(bodyText),
  ].join("\r\n");
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/beta/enroll") return handleEnrollment(request, env);

    if (url.pathname === "/pair/start" || url.pathname === "/pair/status" || url.pathname === "/pair/claim") {
      if (env.PAIRING_ENABLED !== "true" || env.BETA_REGISTRY_ENABLED !== "true" || !env.BETA_REGISTRY) {
        return json({ error: "not_found" }, 404);
      }
      const limited = await betaRateGate(request, env, url.pathname === "/pair/status" ? "status" : "enroll");
      if (limited) return limited;

      if (url.pathname === "/pair/start") {
        if (!env.BETA_REGISTRY.batch) return json({ error: "service_unavailable" }, 503);
        return handlePairStart(request, env.BETA_REGISTRY);
      }
      if (url.pathname === "/pair/status") {
        return handlePairStatus(request, env.BETA_REGISTRY);
      }

      if (!env.BETA_REGISTRY.batch) return json({ error: "service_unavailable" }, 503);
      const access = accessConfig(env);
      if (!access) return json({ error: "service_unavailable" }, 503);
      const assertion = request.headers.get(ACCESS_JWT_HEADER)?.trim() ?? "";
      const identity = await verifyAccessJwt(assertion, access);
      if (!identity) return json({ error: "unauthorized" }, 401);
      return handlePairClaim(request, env.BETA_REGISTRY, {
        issuer: access.issuer,
        subject: identity.subject,
        email: identity.email,
      });
    }

    // Readiness only, authenticated by the enrolled agent key. No client key or MCP token.
    const betaStatus = url.pathname.match(/^\/beta\/device\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})\/status$/);
    if (betaStatus) {
      if (env.BETA_REGISTRY_ENABLED !== "true" || !env.BETA_REGISTRY) return json({ error: "not_found" }, 404);
      const limited = await betaRateGate(request, env, "status");
      if (limited) return limited;
      if (request.method !== "GET" || url.protocol !== "https:" || url.search) return json({ error: "bad_request" }, 400);
      if (!authShapeOk(request)) return json({ error: "unauthorized" }, 401);
      try {
        const deviceId = betaStatus[1];
        if (!isBetaDeviceId(deviceId) || [env.AGENT_DEVICE_ID, env.CLIENT_DEVICE_ID, env.MCP_DEVICE_ID].includes(deviceId)) return json({ error: "unauthorized" }, 403);
        const auth = await resolveAgentAuthentication(env, deviceId);
        if (!auth?.beta || !(await verifySignedRequest(request, auth.publicKeyB64, new Uint8Array()))) return json({ error: "unauthorized" }, 403);
        // DeviceRelay applies its existing rate limit and durable nonce replay check.
        const forwarded = new URL(request.url);
        forwarded.pathname = `/v1/device/${deviceId}/status`;
        return await env.DEVICE_RELAY.getByName(deviceId).fetch(new Request(forwarded, { headers: request.headers }));
      } catch { return json({ error: "service_unavailable" }, 503); }
    }

    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
      }
      return json({ ok: true, service: "astra-bridge-relay" });
    }

    if (url.pathname === "/.well-known/openai-apps-challenge") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
      }
      const challenge = env.OPENAI_APPS_CHALLENGE;
      if (!challenge || challenge.length > 1024 || /[\r\n]/.test(challenge)) {
        return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
      }
      return new Response(request.method === "HEAD" ? null : challenge, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/mcp") {
      return handleMcpRoute(request, env);
    }

    if (url.pathname === "/beta/mcp") {
      return handleBetaMcpRoute(request, env, ctx);
    }

    // The Worker's own owner-secret OAuth server exists only in static mode. In
    // Access mode Cloudflare Access is the authorization server, so these routes 404.
    if (mcpAuthMode(env) === "static") {
      const oauth = await handleOAuthRoute(request, env, url.pathname);
      if (oauth) return oauth;
    }

    const match = url.pathname.match(/^\/v1\/device\/([^/]+)\/(connect|rpc|status)$/);
    if (!match) return json({ error: "not_found" }, 404);

    let deviceId: string;
    try {
      deviceId = decodeURIComponent(match[1]);
    } catch {
      return json({ error: "invalid_device_id" }, 400);
    }
    if (!/^[a-zA-Z0-9._-]{1,96}$/.test(deviceId)) {
      return json({ error: "invalid_device_id" }, 400);
    }

    const action = match[2];
    const expectedMethod = action === "rpc" ? "POST" : "GET";
    if (request.method !== expectedMethod) {
      return json({ error: "method_not_allowed" }, 405, { Allow: expectedMethod });
    }

    // Legacy status/RPC remains personal-only. Agent connect may resolve a beta
    // device through the opt-in registry, but only after the request has a valid
    // signature shape so anonymous traffic cannot cause registry lookups.
    if (action !== "connect" && (!isPersonalDeviceId(env.CLIENT_DEVICE_ID, env.BETA_REGISTRY_ENABLED === "true") || deviceId !== env.CLIENT_DEVICE_ID)) {
      return json({ error: "device_not_authorized" }, 403);
    }

    if (!authShapeOk(request)) return json({ error: "unauthorized" }, 401);
    let body: Uint8Array;
    try {
      body = await readBodyBounded(request);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return json({ error: "request_too_large" }, 413);
      }
      return json({ error: "bad_request_body" }, 400);
    }

    let publicKey: string | undefined;
    if (action === "connect") {
      // The connect path also performs registry reads and needs the same pre-D1 gate.
      if (isBetaDeviceId(deviceId) && env.BETA_REGISTRY_ENABLED === "true") {
        const limited = await betaRateGate(request, env, "connect");
        if (limited) return limited;
      }
      let auth;
      try { auth = await resolveAgentAuthentication(env, deviceId); }
      catch { return json({ error: "service_unavailable" }, 503); }
      if (!auth) return json({ error: "device_not_authorized" }, 403);
      publicKey = auth.publicKeyB64;
    } else {
      publicKey = env.CLIENT_PUBLIC_KEY_B64;
    }
    if (!(await verifySignedRequest(request, publicKey, body))) {
      return json({ error: "unauthorized" }, 401);
    }

    if (action === "connect" && request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_required" }, 426);
    }

    const id = env.DEVICE_RELAY.idFromName(deviceId);
    const stub = env.DEVICE_RELAY.get(id);
    const forwarded = request.method === "GET"
      ? new Request(request)
      : new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body,
        });
    return stub.fetch(forwarded);
  },

  // Fires on the wrangler.jsonc triggers.crons schedule. Reads the same connected/heartbeat
  // state the /status route already tracks (no extra round trip to the Mac) and emails the
  // owner on a down/recovered transition. Never touches the tool allowlist, OAuth, or the
  // client-facing rate limits above — this is an internal RPC call on the Durable Object,
  // not an MCP or signed-RPC request.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.MCP_DEVICE_ID) return;
    const id = env.DEVICE_RELAY.idFromName(env.MCP_DEVICE_ID);
    const stub = env.DEVICE_RELAY.get(id);
    ctx.waitUntil(
      stub.checkAndAlert().catch((err) => {
        console.error("scheduled checkAndAlert failed", String(err));
      }),
    );
  },
};
export class DeviceRelay extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(AGENT_PING, AGENT_PONG));
  }

  async fetch(request: Request): Promise<Response> {
    if (!(await this.acceptNonce(request))) {
      return json({ error: "replay_detected" }, 409);
    }

    const url = new URL(request.url);
    const action = url.pathname.split("/").pop();
    // The agent has its own bucket so a runaway client cannot block agent reconnects.
    if (!(await this.acceptRate(action === "connect" ? "agent" : "client"))) {
      return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
    }

    if (action === "connect") return this.connectAgent();
    if (action === "status") return this.status();
    if (action === "rpc") return this.rpc(request);
    return json({ error: "not_found" }, 404);
  }

  /**
   * One storage key per nonce, kept until it can no longer pass the timestamp check
   * (timestamp + NONCE_TTL_MS > timestamp + AUTH_SKEW_MS), so request volume can
   * never evict a still-valid nonce. The alarm prunes expired entries.
   */
  private async acceptNonceValues(nonce: string, at: number): Promise<boolean> {
    if (!nonce || !Number.isFinite(at)) return false;

    const key = `nonce:${nonce}`;
    if ((await this.ctx.storage.get<number>(key)) !== undefined) return false;