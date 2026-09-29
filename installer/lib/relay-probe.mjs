// Network checks against your deployed relay. They send no secrets: /healthz and the Access
// probe are anonymous, and the status probe carries only an Ed25519 signature made with
// ~/.astra-bridge/client-private.pem (the same scheme as relay/src/smoke.mjs). `fetchImpl` is
// injectable for tests.

import fs from "node:fs";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";

const TIMEOUT_MS = 8000;

async function timedFetch(fetchImpl, url, init = {}) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS) });
}

function reason(err) {
  const cause = err?.cause?.code ?? err?.cause?.message;
  return String(cause ?? err?.name ?? err?.message ?? err).slice(0, 120);
}

/** GET /healthz → { ok, status?, error? }. ok only for the relay's own JSON answer. */
export async function probeHealth(base, { fetchImpl = fetch } = {}) {
  try {
    const res = await timedFetch(fetchImpl, new URL("/healthz", base), { redirect: "manual" });
    let body = null;
    try {
      body = await res.json();
    } catch {}
    const ok = res.status === 200 && body?.ok === true && body?.service === "astra-bridge-relay";
    return { ok, status: res.status, error: ok ? undefined : `unexpected answer (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, error: reason(err) };
  }
}

/** The relay's signed-request headers (see verifySignedRequest in relay/src/index.ts). */
export function signedHeaders(privateKey, method, target, body = Buffer.alloc(0), now = Date.now()) {
  const timestamp = String(now);
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [timestamp, nonce, method.toUpperCase(), target, bodyHash].join("\n");
  return {
    "X-Astra-Timestamp": timestamp,
    "X-Astra-Nonce": nonce,
    "X-Astra-Signature": sign(null, Buffer.from(canonical), privateKey).toString("base64"),
  };
}

/**
 * Signed GET /v1/device/<id>/status → { ok, status?, agentConnected?, mcpHealthy?,
 * lastSeenAgeMs?, error? }. A 401/403 here means the Worker's CLIENT_PUBLIC_KEY_B64 or
 * CLIENT_DEVICE_ID does not match this Mac.
 */
export async function probeAgentStatus(base, deviceId, clientKeyFile, { fetchImpl = fetch } = {}) {
  let key;
  try {
    key = createPrivateKey(fs.readFileSync(clientKeyFile));
  } catch {
    return { ok: false, error: `cannot read ${clientKeyFile}` };
  }
  const target = `/v1/device/${encodeURIComponent(deviceId)}/status`;
  try {
    const res = await timedFetch(fetchImpl, new URL(target, base), { headers: signedHeaders(key, "GET", target), redirect: "manual" });
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (res.status !== 200 || body?.ok !== true) {
      const code = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: code };
    }
    return {
      ok: true,
      status: 200,
      agentConnected: body.agentConnected === true,
      mcpHealthy: body.mcpHealthy === true,
      lastSeenAgeMs: typeof body.lastSeenAgeMs === "number" ? body.lastSeenAgeMs : null,
    };
  } catch (err) {
    return { ok: false, error: reason(err) };
  }
}

/**
 * Classifies the answer to an anonymous POST /mcp.
 *
 *   verified        Cloudflare Access answered with its Managed OAuth 401 challenge
 *                   (WWW-Authenticate pointing at Access's OAuth metadata): the edge protects
 *                   /mcp and MCP clients such as ChatGPT can start the OAuth login.
 *   no-managed-oauth Access redirected to its browser login page: /mcp is protected, but
 *                   Managed OAuth is off, so ChatGPT cannot log in.
 *   not-configured  the Worker itself answered 503: its TEAM_DOMAIN / POLICY_AUD are missing,
 *                   so /mcp fails closed.
 *   not-protected   the Worker itself answered 401: its Access settings are present, but no
 *                   Access application sits in front of /mcp (the Worker still refuses the
 *                   request, since it verifies Access's signed assertion itself).
 *   unknown         anything else.
 *
 * `expectedTeamHost` (e.g. "myteam.cloudflareaccess.com") is compared with the team seen in a
 * login redirect when there is one.
 */
export function classifyAccess({ status, headers }, { expectedTeamHost } = {}) {
  const h = (name) => headers.get(name) ?? "";
  const challenge = h("www-authenticate");
  const location = h("location");
  // Access points at /.well-known/cloudflare-access-protected-resource/... (relay/README.md). The
  // Worker's own static-mode challenge points at /.well-known/oauth-protected-resource instead,
  // so it can never be mistaken for Access.
  if (status === 401 && /cloudflare-?access/i.test(challenge)) {
    return { state: "verified", detail: "Cloudflare Access answers /mcp with its Managed OAuth challenge" };
  }
  if ([301, 302, 303, 307].includes(status) && /\.cloudflareaccess\.com\/cdn-cgi\/access\/login/i.test(location)) {
    let team = "";
    try {
      team = new URL(location).hostname;
    } catch {}
    const mismatch = expectedTeamHost && team && team !== expectedTeamHost;
    return {
      state: mismatch ? "wrong-team" : "no-managed-oauth",
      detail: mismatch
        ? `Access redirects /mcp to team ${team}, but TEAM_DOMAIN is ${expectedTeamHost}`
        : "Access protects /mcp but redirects to its browser login: turn on Managed OAuth for the application",
    };
  }
  if (status === 503) return { state: "not-configured", detail: "the Worker answered 503: TEAM_DOMAIN / POLICY_AUD are not set in the deployed config (fails closed)" };
  if (status === 401 && !challenge) {
    return { state: "not-protected", detail: "the Worker itself answered 401: no Cloudflare Access application protects <host>/mcp yet (the Worker still refuses unauthenticated requests)" };
  }
  return { state: "unknown", detail: `unexpected answer HTTP ${status}${challenge ? ` (WWW-Authenticate: ${challenge.slice(0, 80)})` : ""}` };
}

export async function probeAccess(base, { expectedTeamHost, fetchImpl = fetch } = {}) {
  try {
    const res = await timedFetch(fetchImpl, new URL("/mcp", base), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "astra-bridge-doctor", version: "0" } } }),
    });
    try {
      await res.arrayBuffer();
    } catch {}
    return classifyAccess(res, { expectedTeamHost });
  } catch (err) {
    return { state: "unreachable", detail: reason(err) };
  }
}
