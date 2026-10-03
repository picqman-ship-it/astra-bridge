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
import { applyControlPermissionRequest, cancelControlPermissionRequest, controlAgentFingerprint, controlIdentityFingerprint, controlPermissionRequestStatus, resolveControlDeviceState, startControlPermissionRequest, type ControlTarget } from "./control-permissions";

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
  /** Explicit opt-in for signed post-pairing terminal/GUI permission changes. */
  CONTROL_PERMISSIONS_ENABLED?: string;
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

function parseControlTargetBody(body: Uint8Array): { requestId: string; target: ControlTarget } | null {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(body)); } catch { return null; }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "guiEnabled,requestId,terminalEnabled,version"
    || value.version !== 1 || typeof value.requestId !== "string"
    || typeof value.terminalEnabled !== "boolean" || typeof value.guiEnabled !== "boolean") return null;
  return { requestId: value.requestId, target: { terminalEnabled: value.terminalEnabled, guiEnabled: value.guiEnabled } };
}

async function handleControlPermissionRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (env.CONTROL_PERMISSIONS_ENABLED !== "true" || env.BETA_REGISTRY_ENABLED !== "true" || !env.BETA_REGISTRY) {
    return json({ error: "not_found" }, 404);
  }
  if (mcpAuthMode(env) !== "access" || typeof env.ACCESS_DEVICE_ROUTING !== "string"
    || env.ACCESS_DEVICE_ROUTING.trim().toLowerCase() !== "registry") {
    return json({ error: "service_unavailable" }, 503);
  }
  const current = url.pathname.match(/^\/control\/device\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})\/(status|start|apply|cancel)$/);
  const requestStatus = url.pathname.match(/^\/control\/device\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})\/request\/([0-9a-f-]{36})\/status$/);
  if (!current && !requestStatus) return json({ error: "not_found" }, 404);
  const deviceId = (current ?? requestStatus)![1];
  if (!isBetaDeviceId(deviceId) || [env.AGENT_DEVICE_ID, env.CLIENT_DEVICE_ID, env.MCP_DEVICE_ID].includes(deviceId)) {
    return json({ error: "unauthorized" }, 403);
  }
  const action = requestStatus ? "request-status" : current![2];
  const expectedMethod = action === "status" || action === "request-status" ? "GET" : "POST";
  if (request.method !== expectedMethod || url.protocol !== "https:" || url.search) {
    return json({ error: "bad_request" }, 400, request.method !== expectedMethod ? { Allow: expectedMethod } : {});
  }
  if (!authShapeOk(request)) return json({ error: "unauthorized" }, 401);
  const limited = await betaRateGate(request, env, expectedMethod === "GET" ? "status" : "connect");
  if (limited) return limited;
  let body: Uint8Array;
  try { body = await readBodyBounded(request); }
  catch (err) { return json({ error: err instanceof BodyTooLargeError ? "request_too_large" : "bad_request" }, err instanceof BodyTooLargeError ? 413 : 400); }
  try {
    const auth = await resolveAgentAuthentication(env, deviceId);
    if (!auth?.beta || !(await verifySignedRequest(request, auth.publicKeyB64, body))) return json({ error: "unauthorized" }, 403);
    if (action === "status") {
      const state = await resolveControlDeviceState(env.BETA_REGISTRY, deviceId);
      if (!state || state.agentPublicKeyB64 !== auth.publicKeyB64) return json({ error: "unauthorized" }, 403);
      return json({ ok: true, deviceId, accountEmail: state.identityEmail, identityIssuer: state.identityIssuer,
        identityFingerprint: await controlIdentityFingerprint(state.identityIssuer, state.identitySubject),
        agentFingerprint: await controlAgentFingerprint(state.agentPublicKeyB64),
        terminalEnabled: state.terminalEnabled, guiEnabled: state.guiEnabled });
    }
    if (action === "request-status") {
      const status = await controlPermissionRequestStatus(env.BETA_REGISTRY, deviceId, requestStatus![2]);
      if (!status || status.agentPublicKeyB64 !== auth.publicKeyB64) return json({ error: "not_found" }, 404);
      return json({ ok: true, deviceId, requestId: status.requestId, status: status.status,
        accountEmail: status.identityEmail, identityIssuer: status.identityIssuer,
        identityFingerprint: status.identityFingerprint, agentFingerprint: status.agentFingerprint,
        previousTerminal: status.previousTerminal, previousGui: status.previousGui,
        requestedTerminal: status.requestedTerminal, requestedGui: status.requestedGui,
        terminalEnabled: status.terminalEnabled, guiEnabled: status.guiEnabled, expiresAtMs: status.expiresAtMs });
    }
    const parsed = parseControlTargetBody(body);
    if (!parsed) return json({ error: "bad_request" }, 400);
    if (action === "start") {
      const preview = await startControlPermissionRequest(env.BETA_REGISTRY, deviceId, auth.publicKeyB64, parsed.requestId, parsed.target);
      if (!preview) return json({ error: "control_conflict" }, 409);
      return json({ ok: true, deviceId, requestId: preview.requestId, status: preview.status,
        accountEmail: preview.identityEmail, identityIssuer: preview.identityIssuer,
        identityFingerprint: preview.identityFingerprint, agentFingerprint: preview.agentFingerprint,
        previousTerminal: preview.previousTerminal, previousGui: preview.previousGui,
        requestedTerminal: preview.requestedTerminal, requestedGui: preview.requestedGui, expiresAtMs: preview.expiresAtMs }, 201);
    }
    if (action === "apply") {
      const applied = await applyControlPermissionRequest(env.BETA_REGISTRY, deviceId, auth.publicKeyB64, parsed.requestId, parsed.target);
      if (!applied) return json({ error: "control_denied" }, 409);
      return json({ ok: true, deviceId, requestId: applied.requestId, status: applied.status,
        terminalEnabled: applied.terminalEnabled, guiEnabled: applied.guiEnabled });
    }
    const cancelled = await cancelControlPermissionRequest(env.BETA_REGISTRY, deviceId, auth.publicKeyB64, parsed.requestId);
    return cancelled ? json({ ok: true, deviceId, requestId: parsed.requestId, status: "cancelled" })
      : json({ error: "control_denied" }, 409);
  } catch {
    return json({ error: "service_unavailable" }, 503);
  }
}

async function handleMcpRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  // Only an omitted setting keeps legacy routing. A typo or incompatible auth
  // mode must never send a hosted user's command to the personal owner's Mac.
  const routing = env.ACCESS_DEVICE_ROUTING === undefined ? "fixed"
    : typeof env.ACCESS_DEVICE_ROUTING === "string" ? env.ACCESS_DEVICE_ROUTING.trim().toLowerCase() : null;
  const mode = mcpAuthMode(env);
  if ((routing !== "fixed" && routing !== "registry") || mode === null
    || (routing === "registry" && mode !== "access")) {
    return json({ error: "service_unavailable" }, 503);
  }
  const registryRouting = routing === "registry";
  if (!registryRouting && !isPersonalDeviceId(env.MCP_DEVICE_ID, env.BETA_REGISTRY_ENABLED === "true")) {
    return json({ error: "personal_device_id_reserved" }, 503);
  }
  const reserved = [env.AGENT_DEVICE_ID, env.CLIENT_DEVICE_ID, env.MCP_DEVICE_ID];
  const relay: McpRelay = async (payload, principal) => {
    if (registryRouting) {
      if (principal.kind !== "access" || !isBetaDeviceId(principal.deviceId) || reserved.includes(principal.deviceId)) {
        throw new RelayError("agent_unavailable");
      }
    } else if (principal.kind === "beta" || principal.deviceId !== env.MCP_DEVICE_ID) {
      throw new RelayError("agent_unavailable");
    }
    const stub = env.DEVICE_RELAY.getByName(principal.deviceId);
    const outcome = await stub.mcpRpc(payload) as unknown as RpcOutcome;
    if (!outcome.ok) throw new RelayError(outcome.error);
    return outcome.result;
  };

  if (mode === "access") {
    const access = accessConfig(env);
    if (!access) return json({ error: "service_unavailable" }, 503);
    if (registryRouting) {
      if (env.BETA_REGISTRY_ENABLED !== "true" || !env.BETA_REGISTRY) {
        return json({ error: "service_unavailable" }, 503);
      }
      // Hosted /mcp must retain the same pre-D1 limits as /beta/mcp.
      const limited = await betaRateGate(request, env, "mcp");
      if (limited) return limited;
      return handleMcpRequest(request, env, relay, {
        authenticate: (req) => authenticateAccessRequest(req, access, undefined, undefined, async (identity) => {
          const principal = await resolveAccessIdentityDevice(env.BETA_REGISTRY!, access.issuer, identity.subject);
          return principal && !reserved.includes(principal.deviceId) ? principal : null;
        }),
        auditTool: (principal, name, outcome, durationMs) => {
          const pending = recordAuditEvent(env.BETA_REGISTRY!, {
            eventId: crypto.randomUUID(), ownerId: principal.ownerId, deviceId: principal.deviceId,
            toolName: name, outcome, durationMs, createdAt: new Date().toISOString(),
          }).catch(() => { /* Best effort, metadata only; never log payloads or database errors. */ });
          if (ctx) ctx.waitUntil(pending);
        },
      }).catch(() => json({ error: "service_unavailable" }, 503));
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

    if (url.pathname.startsWith("/control/device/")) {
      return handleControlPermissionRoute(request, env, url);
    }

    if (url.pathname === "/pair/start" || url.pathname === "/pair/status" || url.pathname === "/pair/claim") {
      if (env.PAIRING_ENABLED !== "true" || env.BETA_REGISTRY_ENABLED !== "true" || !env.BETA_REGISTRY) {
        return json({ error: "not_found" }, 404);
      }
      if (mcpAuthMode(env) !== "access" || typeof env.ACCESS_DEVICE_ROUTING !== "string"
        || env.ACCESS_DEVICE_ROUTING.trim().toLowerCase() !== "registry") {
        return json({ error: "service_unavailable" }, 503);
      }
      const limited = await betaRateGate(request, env, url.pathname === "/pair/status" ? "status" : "enroll");
      if (limited) return limited;

      if (url.pathname === "/pair/start") {
        if (!env.BETA_REGISTRY.batch) return json({ error: "service_unavailable" }, 503);
        return handlePairStart(request, env.BETA_REGISTRY).catch(() => json({ error: "service_unavailable" }, 503));
      }
      if (url.pathname === "/pair/status") {
        return handlePairStatus(request, env.BETA_REGISTRY).catch(() => json({ error: "service_unavailable" }, 503));
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
      }).catch(() => json({ error: "service_unavailable" }, 503));
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
      return handleMcpRoute(request, env, ctx);
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
    await this.ctx.storage.put(key, at);

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + NONCE_TTL_MS);
    }
    return true;
  }

  private async acceptNonce(request: Request): Promise<boolean> {
    const nonce = request.headers.get("x-astra-nonce");
    const at = Number(request.headers.get("x-astra-timestamp"));
    return nonce ? this.acceptNonceValues(nonce, at) : false;
  }

  private async acceptRate(bucket: RateBucket): Promise<boolean> {
    const now = Date.now();
    const key = `rate:${bucket}`;
    const state = (await this.ctx.storage.get<{ start: number; count: number }>(key))
      ?? { start: now, count: 0 };

    if (now - state.start >= RATE_WINDOW_MS) {
      state.start = now;
      state.count = 0;
    }
    state.count += 1;
    await this.ctx.storage.put(key, state);
    return state.count <= MAX_AUTH_REQUESTS_PER_WINDOW;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<number>({ prefix: "nonce:" });
    const expired: string[] = [];
    let fresh = false;

    for (const [key, at] of entries) {
      if (at < now - NONCE_TTL_MS) expired.push(key);
      else fresh = true;
    }
    // storage.delete accepts at most 128 keys per call.
    for (let i = 0; i < expired.length; i += 128) {
      await this.ctx.storage.delete(expired.slice(i, i + 128));
    }
    if (fresh) await this.ctx.storage.setAlarm(now + NONCE_TTL_MS);
  }

  private async connectAgent(): Promise<Response> {
    const pair = new WebSocketPair();
    await this.attachAgentSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Each agent socket gets a connection ID stored in its attachment and as the current
   * ID in storage, so events from a replaced socket (whose close arrives later) cannot
   * mark the new connection down or fail requests sent on it. Both survive hibernation.
   */
  private async attachAgentSocket(server: WebSocket): Promise<void> {
    for (const ws of this.ctx.getWebSockets("agent")) {
      try { ws.close(1012, "replaced"); } catch {}
    }

    const connId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, ["agent"]);
    server.serializeAttachment({ role: "agent", connId, connectedAt: Date.now() } satisfies AgentAttachment);
    await this.ctx.storage.put({
      agentConnId: connId,
      agentLastSeen: Date.now(),
      // Unhealthy until the first heartbeat reports the local MCP server state.
      agentMcpHealthy: false,
    });
  }

  private connIdOf(ws: WebSocket): string | null {
    try {
      const attachment = ws.deserializeAttachment() as Partial<AgentAttachment> | null;
      return typeof attachment?.connId === "string" ? attachment.connId : null;
    } catch {
      return null;
    }
  }

  /**
   * A socket accepted by an earlier deployment has no connId. Adopt it only when no
   * current connection exists, so an upgrade cannot strand a live agent.
   */
  private async adoptLegacySocket(ws: WebSocket): Promise<string | null> {
    if (await this.currentAgent()) return null;
    const connId = crypto.randomUUID();
    ws.serializeAttachment({ role: "agent", connId, connectedAt: Date.now() } satisfies AgentAttachment);
    await this.ctx.storage.put("agentConnId", connId);
    return connId;
  }

  private async currentAgent(): Promise<{ ws: WebSocket; connId: string } | null> {
    const connId = await this.ctx.storage.get<string>("agentConnId");
    if (!connId) return null;
    for (const ws of this.ctx.getWebSockets("agent")) {
      if (this.connIdOf(ws) === connId) return { ws, connId };
    }
    return null;
  }

  private async agentState(): Promise<{
    healthy: boolean;
    socketCount: number;
    socketPresent: boolean;
    lastSeen: number | null;
    mcpHealthy: boolean;
  }> {
    const socketCount = this.ctx.getWebSockets("agent").length;
    const current = await this.currentAgent();
    const socketPresent = current !== null;
    // Pings answered by the runtime never reach this object, so the newest of the stored
    // time (connect, state message, rpc_result) and the current socket's last auto-response
    // is the real last-seen time. A replaced socket's pings do not count.
    const stored = (await this.ctx.storage.get<number>("agentLastSeen")) || 0;
    const pinged = current ? this.ctx.getWebSocketAutoResponseTimestamp(current.ws)?.getTime() ?? 0 : 0;
    const lastSeen = Math.max(stored, pinged) || null;
    const mcpHealthy = (await this.ctx.storage.get<boolean>("agentMcpHealthy")) === true;
    const healthy = socketPresent
      && mcpHealthy
      && lastSeen !== null
      && Date.now() - lastSeen <= AGENT_STALE_MS;
    return { healthy, socketCount, socketPresent, lastSeen, mcpHealthy };
  }

  private async status(): Promise<Response> {
    const state = await this.agentState();
    return json({
      ok: true,
      agentConnected: state.healthy,
      socketPresent: state.socketPresent,
      socketCount: state.socketCount,
      lastSeen: state.lastSeen,
      lastSeenAgeMs: state.lastSeen === null ? null : Date.now() - state.lastSeen,
      mcpHealthy: state.mcpHealthy,
      pending: this.pending.size,
    });
  }

  /**
   * Called only by the Worker's scheduled() handler via Durable Object RPC (never reachable
   * from a client request — it is not routed through fetch()). Reuses the same agentState()
   * the /status route already computes from the existing heartbeat bookkeeping, so this adds
   * no extra round trip to the Mac agent and no new client-facing surface.
   *
   * Debounce: requires ALERT_MIN_CONSECUTIVE_UNHEALTHY consecutive unhealthy checks before the
   * first "down" email (absorbs a single missed heartbeat around check time), then repeats at
   * most every ALERT_REPEAT_MS while still down, and sends exactly one "recovered" email the
   * first time it is healthy again after a "down" email actually went out. `alertSent` tracks
   * whether an email was actually sent for the current episode — separate from `consecutive
   * Unhealthy`, which tracks the episode itself — so a recovery within the debounce window
   * (never actually alerted) stays silent instead of firing a confusing "recovered" email.
   */
  async checkAndAlert(): Promise<{ healthy: boolean; alerted: "down" | "recovered" | null }> {
    const state = await this.agentState();
    const alertSent = (await this.ctx.storage.get<boolean>("alertSent")) === true;

    if (state.healthy) {
      const alerted = alertSent ? "recovered" : null;
      if (alerted) await this.sendAlertEmail(alerted, state);
      await this.ctx.storage.put({ alertConsecutiveUnhealthy: 0, alertSent: false });
      return { healthy: true, alerted };
    }

    const consecutiveUnhealthy =
      ((await this.ctx.storage.get<number>("alertConsecutiveUnhealthy")) ?? 0) + 1;
    const lastAlertSentAt = await this.ctx.storage.get<number>("alertLastSentAt");
    const dueForFirstAlert = !alertSent && consecutiveUnhealthy >= ALERT_MIN_CONSECUTIVE_UNHEALTHY;
    const dueForRepeat = alertSent
      && lastAlertSentAt !== undefined
      && Date.now() - lastAlertSentAt >= ALERT_REPEAT_MS;
    const alerted = dueForFirstAlert || dueForRepeat ? "down" : null;

    if (alerted) await this.sendAlertEmail(alerted, state);
    await this.ctx.storage.put({
      alertConsecutiveUnhealthy: consecutiveUnhealthy,
      ...(alerted ? { alertSent: true, alertLastSentAt: Date.now() } : {}),
    });
    return { healthy: false, alerted };
  }

  /** Never throws: a broken alert channel must not corrupt agentState/alert bookkeeping. */
  private async sendAlertEmail(
    kind: "down" | "recovered",
    state: { lastSeen: number | null; socketPresent: boolean; mcpHealthy: boolean },
  ): Promise<void> {
    const seb = this.env.ALERT_EMAIL;
    const from = this.env.ALERT_FROM_ADDRESS;
    const to = this.env.ALERT_TO_ADDRESS;
    if (!seb || !from || !to) return;
    try {
      await seb.send(new EmailMessage(from, to, buildAlertRawEmail(kind, state, from, to)));
    } catch (err) {
      console.error("alert email send failed", String(err));
    }
  }

  private validateRpcPayload(payload: unknown): RpcOutcome | null {
    if (!isRecord(payload)) {
      return { ok: false, status: 400, error: "unsupported_action" };
    }
    if (payload.action === "tools/list") return null;
    if (payload.action !== "tools/call") {
      return { ok: false, status: 400, error: "unsupported_action" };
    }
    if (!payload.name || typeof payload.name !== "string") {
      return { ok: false, status: 400, error: "tool_name_required" };
    }
    if (!isToolApproved(payload.name)) {
      return { ok: false, status: 403, error: "tool_not_approved" };
    }
    if (payload.arguments !== undefined && !isRecord(payload.arguments)) {
      return { ok: false, status: 400, error: "invalid_arguments" };
    }
    if (IDEMPOTENCY_REQUIRED.has(payload.name) && !hasValidIdempotencyKey(payload.arguments)) {
      return { ok: false, status: 400, error: "idempotency_key_required" };
    }
    return null;
  }

  private agentFailure(code: string): RpcOutcome {
    const error = code in AGENT_ERROR_STATUS ? code : "tool_failed";
    return {
      ok: false,
      status: AGENT_ERROR_STATUS[error] ?? 502,
      error,
      ...(error === "agent_busy" ? { retryAfter: "2" } : {}),
    };
  }

  private async executeRpc(payload: RpcPayload): Promise<RpcOutcome> {
    const invalid = this.validateRpcPayload(payload);
    if (invalid) return invalid;

    if (this.pending.size >= MAX_PENDING) {
      return { ok: false, status: 429, error: "too_many_pending_requests", retryAfter: "2" };
    }

    const state = await this.agentState();
    const agent = await this.currentAgent();
    if (!state.healthy || !agent) {
      return { ok: false, status: 503, error: "agent_unavailable" };
    }

    const id = crypto.randomUUID();
    const frame = JSON.stringify({ type: "rpc", id, payload });
    if (new TextEncoder().encode(frame).byteLength > MAX_AGENT_MESSAGE_BYTES) {
      return { ok: false, status: 413, error: "request_too_large" };
    }
    // Re-check after the awaits above: concurrent requests may have filled the slots.
    if (this.pending.size >= MAX_PENDING) {
      return { ok: false, status: 429, error: "too_many_pending_requests", retryAfter: "2" };
    }

    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("agent_timeout"));
      }, AGENT_RPC_TIMEOUT_MS);
      this.pending.set(id, { connId: agent.connId, resolve, reject, timer });
    });

    try {
      agent.ws.send(frame);
    } catch {
      // The socket closed between the health check and send; nothing reached the agent.
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      result.catch(() => {});
      return { ok: false, status: 503, error: "agent_send_failed" };
    }

    try {
      return { ok: true, result: await result };
    } catch (err) {
      return this.agentFailure(err instanceof Error ? err.message : "");
    }
  }

  async mcpRpc(payload: RpcPayload): Promise<RpcOutcome> {
    if (!(await this.acceptRate("client"))) {
      return { ok: false, status: 429, error: "rate_limited", retryAfter: "60" };
    }
    return this.executeRpc(payload);
  }

  private async rpc(request: Request): Promise<Response> {
    let payload: RpcPayload;
    try {
      payload = await request.json<RpcPayload>();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const outcome = await this.executeRpc(payload);
    if (outcome.ok) return json(outcome);
    return json(
      { error: outcome.error },
      outcome.status,
      outcome.retryAfter ? { "Retry-After": outcome.retryAfter } : {},
    );
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connId = this.connIdOf(ws) ?? await this.adoptLegacySocket(ws);
    const size = typeof message === "string"
      ? new TextEncoder().encode(message).byteLength
      : message.byteLength;
    if (size > MAX_AGENT_MESSAGE_BYTES) {
      try { ws.close(1009, "message too large"); } catch {}
      if (connId) this.rejectPending(connId, "agent_message_too_large");
      return;
    }
    if (!connId) return;

    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (raw === AGENT_PING) {
      // Normally answered by the runtime auto-response and never delivered here.
      if ((await this.ctx.storage.get<string>("agentConnId")) === connId) {
        await this.ctx.storage.put("agentLastSeen", Date.now());
      }
      try { ws.send(AGENT_PONG); } catch {}
      return;
    }
    let data: {
      type?: string;
      id?: string;
      result?: unknown;
      error?: string;
      mcpHealthy?: boolean;
    };
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(data)) return;

    const isCurrent = (await this.ctx.storage.get<string>("agentConnId")) === connId;
    if (data.type === "heartbeat") {
      // A heartbeat from a replaced socket must not overwrite the live connection's state.
      if (!isCurrent) return;
      await this.ctx.storage.put({
        agentLastSeen: Date.now(),
        agentMcpHealthy: data.mcpHealthy === true,
      });
      try { ws.send(JSON.stringify({ type: "heartbeat_ack", at: Date.now() })); } catch {}
      return;
    }

    if (data.type !== "rpc_result" || typeof data.id !== "string") return;
    // A result proves the socket is alive but says nothing about MCP health (it may
    // be an mcp_unavailable error), so only the heartbeat sets agentMcpHealthy.
    if (isCurrent) await this.ctx.storage.put("agentLastSeen", Date.now());

    const pending = this.pending.get(data.id);
    if (!pending || pending.connId !== connId) return;
    clearTimeout(pending.timer);
    this.pending.delete(data.id);

    if (data.error !== undefined) pending.reject(new Error(String(data.error)));
    else pending.resolve(data.result);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.agentGone(ws, "agent_disconnected");
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.agentGone(ws, "agent_socket_error");
  }

  private async agentGone(ws: WebSocket, reason: string): Promise<void> {
    const connId = this.connIdOf(ws);
    if (!connId) return;
    this.rejectPending(connId, reason);
    if ((await this.ctx.storage.get<string>("agentConnId")) === connId) {
      await this.ctx.storage.put({ agentLastSeen: 0, agentMcpHealthy: false });
    }
  }

  private rejectPending(connId: string, message: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.connId !== connId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}
