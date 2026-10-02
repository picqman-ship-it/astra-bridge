import { readBoundedBody } from "./bounded-body";
import type { D1DatabaseLike } from "./beta-registry";
import {
  PAIR_CODE_PATTERN,
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
      // form-action 'self' also blocks a form POST from following a cross-origin
      // redirect (for example an expired Access session), so code/confirmation
      // bodies never leave this origin.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
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
    claimUrl: `${url.origin}/pair/claim`,
    claimCode: session.claimCode,
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
    if (url.search) {
      return html("Pairing unavailable", "<p>The pairing link is invalid.</p>", 400);
    }
    return html("Connect this Mac to Astra", `
<p>Signed in as <strong>${escapeHtml(identity.email)}</strong>.</p>
<p>Enter the one-time code displayed by the Astra installer on your Mac. Only use a code from an installation you started. Each code works once, so submit it a single time.</p>
<form method="post" action="/pair/claim" autocomplete="off">
<label>Mac pairing code <input name="code" type="password" autocomplete="off" spellcheck="false" required maxlength="36"></label>
<button type="submit">Review account and Mac</button>
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
  if (form.size === 1 && form.getAll("code").length === 1) {
    // Tolerate copy/paste whitespace and letter case. A malformed code never
    // reaches the registry, so it cannot consume the real one.
    const code = form.get("code")!.trim().toLowerCase();
    if (!PAIR_CODE_PATTERN.test(code)) {
      return html("Pairing unavailable", "<p>That is not a valid Astra pairing code. Check the code shown by the installer on your Mac and enter it again.</p>", 400);
    }
    const preview = await pairingPreview(registry, code, identity);
    if (!preview) return html("Pairing unavailable", "<p>The code was not accepted. Check that it matches the code currently shown by the installer on your Mac. A code works once and expires five minutes after it is shown; if it was already used or has expired, run account pairing again on the same Mac after its ten-minute pairing session ends.</p>", 409);
    return html("Confirm account and Mac", `
<p><strong>Astra account</strong><br>${escapeHtml(identity.email)}</p>
<p><strong>Identity provider</strong><br>${escapeHtml(identity.issuer)}</p>
<p><strong>Device</strong><br><code>${escapeHtml(preview.deviceId)}</code></p>
<p><strong>Mac key fingerprint (SHA-256)</strong><br><code>${escapeHtml(preview.fingerprint)}</code></p>
<p>Compare this device and fingerprint with the installer on your Mac. If the account or Mac is wrong, close this page and restart pairing.</p>
<p class="warning">Initial access is file-only within the folders allowed by your Mac. Terminal and GUI control are not enabled by this step.</p>
<form method="post" action="/pair/claim" autocomplete="off">
<input type="hidden" name="consent" value="${escapeHtml(preview.consent)}">
<label><input type="checkbox" name="scope" value="files-v1" required> I authorize this Astra account to access files on this Mac.</label>
<button type="submit">Connect this Mac</button>
</form>`);
  }
  if (form.size !== 2 || form.getAll("consent").length !== 1
    || form.getAll("scope").length !== 1 || form.get("scope") !== "files-v1") {
    return html("Pairing unavailable", "<p>The request is invalid.</p>", 400);
  }
  const result = await claimPairingSession(registry, form.get("consent")!, identity);
  if (!result) {
    return html("Could not connect Mac", "<p>The confirmation expired, was already used, or this account already has an active Mac. If you submitted it twice, the first submission may have succeeded; the installer on your Mac shows the result.</p>", 409);
  }
  return html("Mac connected", `
<p>Astra is now bound to this Mac.</p>
<p><strong>Device</strong><br><code>${escapeHtml(result.deviceId)}</code></p>
<p>You can close this page. The Mac installer will detect the completed pairing automatically.</p>`);
}
