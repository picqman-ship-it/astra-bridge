import { readBoundedBody } from "./bounded-body";
import type { D1DatabaseLike } from "./beta-registry";
import {
  PAIR_SECRET_PATTERN,
  claimPairingSession,
  createPairingSession,
  pairingPreview,
  pairingStatus,
  validatePairStart,
  type PairIdentity,
} from "./pairing";

const MAX_PAIR_START_BODY = 2048;
const MAX_PAIR_CLAIM_BODY = 1024;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { ...SECURITY_HEADERS, ...extra } });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function html(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.5}
.card{border:1px solid #d0d7de;border-radius:12px;padding:20px}
code{word-break:break-all}button{font:inherit;padding:10px 16px}
.warning{font-weight:600}
</style>
</head>
<body><main class="card"><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

async function boundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return null;
  if (!request.body) return "";
  try {
    const bytes = await readBoundedBody(request.body, maxBytes, { ignoreCancelErrors: true });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function bearerPairSecret(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const secret = header.slice(7);
  return PAIR_SECRET_PATTERN.test(secret) ? secret : null;
}

export async function handlePairStart(
  request: Request,
  registry: D1DatabaseLike,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  if (url.protocol !== "https:" || url.search) return json({ error: "bad_request" }, 400);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "unsupported_media_type" }, 415);
  }
  const raw = await boundedText(request, MAX_PAIR_START_BODY);
  if (raw === null) return json({ error: "request_too_large_or_invalid" }, 413);

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_request" }, 400); }
  const registration = await validatePairStart(body, url.origin);
  if (!registration) return json({ error: "pairing_denied" }, 403);

  const session = await createPairingSession(registry, registration);
  if (!session) return json({ error: "pairing_conflict" }, 409);
  return json({
    ok: true,
    deviceId: session.deviceId,
    expiresAtMs: session.expiresAtMs,
    claimUrl: `${url.origin}/pair/claim?token=${encodeURIComponent(session.secret)}`,
    pairingToken: session.secret,
  }, 201);
}

export async function handlePairStatus(
  request: Request,
  registry: D1DatabaseLike,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
  if (url.protocol !== "https:" || url.search) return json({ error: "bad_request" }, 400);
  const secret = bearerPairSecret(request);
  if (!secret) return json({ error: "unauthorized" }, 401);
  const status = await pairingStatus(registry, secret);
  return status ? json(status) : json({ error: "unauthorized" }, 401);
}

export async function handlePairClaim(
  request: Request,
  registry: D1DatabaseLike,
  identity: PairIdentity,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "https:") return html("Pairing unavailable", "<p>Secure HTTPS is required.</p>", 400);

  if (request.method === "GET") {
    if ([...url.searchParams.keys()].some((key) => key !== "token") || url.searchParams.getAll("token").length !== 1) {
      return html("Pairing unavailable", "<p>The pairing link is invalid.</p>", 400);
    }
    const secret = url.searchParams.get("token") ?? "";
    const preview = await pairingPreview(registry, secret);
    if (!preview || preview.status !== "pending") {
      return html("Pairing unavailable", "<p>This pairing request is invalid, expired, or already used.</p>", 410);
    }
    return html("Connect this Mac to Astra", `
<p>Confirm that this is the Mac you are pairing with your ChatGPT Astra plugin.</p>
<p><strong>Device</strong><br><code>${escapeHtml(preview.deviceId)}</code></p>
<p><strong>Mac key fingerprint (SHA-256)</strong><br><code>${escapeHtml(preview.fingerprint)}</code></p>
<p class="warning">Initial access is file-only. Terminal and GUI control are not enabled by this step.</p>
<form method="post" action="/pair/claim">
<input type="hidden" name="token" value="${escapeHtml(secret)}">
<button type="submit">Connect this Mac</button>
</form>`);
  }

  if (request.method !== "POST") {
    return html("Pairing unavailable", "<p>Method not allowed.</p>", 405);
  }
  if (url.search) return html("Pairing unavailable", "<p>The request is invalid.</p>", 400);
  if (request.headers.get("origin") !== url.origin) {
    return html("Pairing unavailable", "<p>The request origin could not be verified.</p>", 403);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return html("Pairing unavailable", "<p>The request format is invalid.</p>", 415);
  }
  const raw = await boundedText(request, MAX_PAIR_CLAIM_BODY);
  if (raw === null) return html("Pairing unavailable", "<p>The request is too large or invalid.</p>", 413);
  const form = new URLSearchParams(raw);
  if ([...form.keys()].some((key) => key !== "token") || form.getAll("token").length !== 1) {
    return html("Pairing unavailable", "<p>The request is invalid.</p>", 400);
  }
  const secret = form.get("token") ?? "";
  const result = await claimPairingSession(registry, secret, identity);
  if (!result) {
    return html("Could not connect Mac", "<p>The request expired, was already used, or this account already has an active Mac.</p>", 409);
  }
  return html("Mac connected", `
<p>Astra is now bound to this Mac.</p>
<p><strong>Device</strong><br><code>${escapeHtml(result.deviceId)}</code></p>
<p>You can close this page. The Mac installer will detect the completed pairing automatically.</p>`);
}