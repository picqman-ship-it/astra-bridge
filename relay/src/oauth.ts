import { MCP_PATH, readBoundedText } from "./mcp";
import {
  ACCESS_TOKEN_PATTERN,
  CODE_PATTERN,
  OWNER_SECRET_MIN_LENGTH,
  OWNER_SUBJECT,
  REFRESH_TOKEN_PATTERN,
  type CodeBinding,
  type OAuthStore,
  type TokenOutcome,
} from "./oauth-store";
import { isOAuthScope, OAUTH_SCOPES, type OAuthScope } from "./tool-policy";

// The only client this personal build accepts. ChatGPT identifies itself with a
// Client ID Metadata Document URL; the redirect URI is pinned rather than fetched.
export const CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
export const CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const PROTECTED_RESOURCE_PATHS = [
  "/.well-known/oauth-protected-resource",
  `/.well-known/oauth-protected-resource${MCP_PATH}`,
];
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
export const OAUTH_MAX_BODY_BYTES = 8 * 1024;
const MAX_STATE_LENGTH = 1024;
const MAX_OWNER_SECRET_LENGTH = 1024;

const SCOPE_LABELS: Record<OAuthScope, string> = {
  "astra.read": "Read files, search, and view configuration",
  "astra.write": "Create, edit, and move files",
  "astra.control": "Run and control shell processes and durable jobs",
};

export type OAuthEnv = {
  OAUTH_ISSUER?: string;
  OAUTH_RESOURCE?: string;
  OAUTH_OWNER_SECRET?: string;
  OAUTH_STORE?: DurableObjectNamespace<OAuthStore>;
};

export type OAuthConfig = {
  issuer: string;
  resource: string;
  resourceMetadataUrl: string;
};

/**
 * Issuer and resource come only from Worker config, never from the request Host.
 * The issuer must be a bare https origin and the resource exactly issuer + /mcp.
 */
export function oauthConfig(env: OAuthEnv): OAuthConfig | null {
  const issuer = env.OAUTH_ISSUER;
  if (!issuer || env.OAUTH_RESOURCE !== `${issuer}${MCP_PATH}`) return null;
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.origin !== issuer) return null;
  return {
    issuer,
    resource: env.OAUTH_RESOURCE,
    resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource${MCP_PATH}`,
  };
}

/** OAuth grants are live only with valid config, the store binding, and the owner secret. */
function oauthStore(env: OAuthEnv): DurableObjectStub<OAuthStore> | null {
  if (!oauthConfig(env) || !env.OAUTH_STORE) return null;
  if (!env.OAUTH_OWNER_SECRET || env.OAUTH_OWNER_SECRET.length < OWNER_SECRET_MIN_LENGTH) return null;
  return env.OAUTH_STORE.getByName(OWNER_SUBJECT);
}

export function protectedResourceMetadata(config: OAuthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Astra Bridge (personal)",
  };
}

export function authorizationServerMetadata(config: OAuthConfig) {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${config.issuer}${TOKEN_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...OAUTH_SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

/**
 * Verifies an OAuth access token for /mcp. Fails closed on any mismatch in
 * format, store state, audience, client, subject, or scope values.
 */
export async function verifyOAuthAccessToken(env: OAuthEnv, token: string): Promise<OAuthScope[] | null> {
  // Format first: operator or garbage bearers never reach the Durable Object.
  if (!ACCESS_TOKEN_PATTERN.test(token)) return null;
  const config = oauthConfig(env);
  const store = oauthStore(env);
  if (!config || !store) return null;
  const grant = await store.verifyAccessToken(token);
  if (!grant || grant.resource !== config.resource || grant.clientId !== CHATGPT_CLIENT_ID
    || grant.subject !== OWNER_SUBJECT || grant.expiresAt <= Date.now()) {
    return null;
  }
  const scopes = grant.scopes.filter(isOAuthScope);
  return scopes.length === grant.scopes.length && scopes.length > 0 ? scopes : null;
}

// ---------------------------------------------------------------------------
// Responses

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

function methodNotAllowed(allow: string): Response {
  return jsonResponse({ error: "method_not_allowed" }, 405, { allow });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(status: number, title: string, body: string, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">`
    + `<title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}`
    + `label{display:block;margin:.4rem 0}input[type=password]{width:100%;padding:.4rem;font:inherit}`
    + `button{margin:1rem .5rem 0 0;padding:.4rem 1rem;font:inherit}.error{color:#a00}code{word-break:break-all}</style>`
    + `</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { ...HTML_HEADERS, ...headers } });
}

function errorPage(status: number, message: string, headers: Record<string, string> = {}): Response {
  return page(status, "Authorization error", `<p class="error">${escapeHtml(message)}</p>`, headers);
}

/** Every authorization redirect, success or error, carries the exact issuer (RFC 9207). */
function authorizationRedirect(config: OAuthConfig, params: Record<string, string | undefined>): Response {
  const target = new URL(CHATGPT_REDIRECT_URI);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) target.searchParams.set(key, value);
  }
  target.searchParams.set("iss", config.issuer);
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

// ---------------------------------------------------------------------------
// Authorization request validation

type AuthorizeRequest = {
  state?: string;
  codeChallenge: string;
  resource: string;
  scopes: OAuthScope[];
};

type AuthorizeValidation =
  | { kind: "ok"; request: AuthorizeRequest }
  // The client or redirect URI cannot be trusted: never redirect (RFC 6749 §4.1.2.1).
  | { kind: "fatal"; message: string }
  | { kind: "redirect"; error: string; description: string; state?: string };

const AUTHORIZE_PARAMS = [
  "response_type", "client_id", "redirect_uri", "state", "scope",
  "code_challenge", "code_challenge_method", "resource",
];

function single(params: URLSearchParams, name: string): string | undefined | null {
  const values = params.getAll(name);
  if (values.length > 1) return null;
  return values[0];
}

export function parseScopes(value: string | undefined): OAuthScope[] | null {
  if (value === undefined) return [...OAUTH_SCOPES];
  const items = value.split(" ");
  if (items.some((item) => !isOAuthScope(item))) return null;
  const scopes = OAUTH_SCOPES.filter((scope) => items.includes(scope));
  return scopes.length > 0 ? scopes : null;
}

/** Validates every OAuth parameter; used for GET and again, from scratch, for POST. */
function validateAuthorize(params: URLSearchParams, config: OAuthConfig): AuthorizeValidation {
  if (single(params, "client_id") !== CHATGPT_CLIENT_ID) {
    return { kind: "fatal", message: "Unknown or missing client_id." };
  }
  if (single(params, "redirect_uri") !== CHATGPT_REDIRECT_URI) {
    return { kind: "fatal", message: "The redirect_uri is not registered for this client." };
  }

  // A duplicated or oversized state is not echoed back.
  const rawState = single(params, "state");
  const stateOk = rawState !== null && (rawState === undefined || rawState.length <= MAX_STATE_LENGTH);
  const state = stateOk ? rawState ?? undefined : undefined;
  const fail = (error: string, description: string): AuthorizeValidation => ({ kind: "redirect", error, description, state });
  if (!stateOk) return fail("invalid_request", "Invalid state parameter");
  if (AUTHORIZE_PARAMS.some((name) => params.getAll(name).length > 1)) {
    return fail("invalid_request", "Duplicate parameter");
  }
  if (params.get("response_type") !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported");
  }
  if (params.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return fail("invalid_request", "Invalid code_challenge");
  }
  if (params.get("resource") !== config.resource) {
    return fail("invalid_target", "Unknown or missing resource");
  }
  const scopes = parseScopes(params.get("scope") ?? undefined);
  if (!scopes) return fail("invalid_scope", "Unsupported scope");
  return { kind: "ok", request: { state, codeChallenge, resource: config.resource, scopes } };
}

function consentForm(request: AuthorizeRequest, message?: string): string {
  const hidden: Record<string, string | undefined> = {
    response_type: "code",
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: CHATGPT_REDIRECT_URI,
    state: request.state,
    scope: request.scopes.join(" "),
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    resource: request.resource,
  };
  const fields = Object.entries(hidden)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("");
  const scopes = request.scopes
    .map((scope) => `<label><input type="checkbox" name="granted_scope" value="${scope}" checked> `
      + `<code>${scope}</code> ${escapeHtml(SCOPE_LABELS[scope])}</label>`)
    .join("");
  return `${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}`
    + `<p><strong>ChatGPT</strong> (chatgpt.com) is requesting access to <code>${escapeHtml(request.resource)}</code>.</p>`
    + `<p>This grants remote control of the owner's Mac within the scopes below.</p>`
    + `<form method="post" action="${AUTHORIZE_PATH}">${fields}<fieldset><legend>Scopes</legend>${scopes}</fieldset>`
    + `<label>Owner secret <input type="password" name="owner_secret" autocomplete="off" required></label>`
    + `<button type="submit" name="decision" value="approve">Authorize</button>`
    + `<button type="submit" name="decision" value="deny" formnovalidate>Deny</button></form>`;
}

async function handleAuthorize(request: Request, env: OAuthEnv, config: OAuthConfig): Promise<Response> {
  if (request.method === "GET") {
    const validation = validateAuthorize(new URL(request.url).searchParams, config);
    if (validation.kind === "fatal") return errorPage(400, validation.message);
    if (validation.kind === "redirect") {
      return authorizationRedirect(config, {
        error: validation.error, error_description: validation.description, state: validation.state,
      });
    }
    if (!oauthStore(env)) return errorPage(503, "Authorization is not available.");
    return page(200, "Authorize Astra Bridge", consentForm(validation.request));
  }

  if (request.method !== "POST") return methodNotAllowed("GET, POST");
  // No cookies are used, but a foreign page must still not drive the form.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== config.issuer) return errorPage(403, "Cross-origin request rejected.");
  const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") return errorPage(415, "Unsupported form encoding.");
  const body = await readBoundedText(request, OAUTH_MAX_BODY_BYTES);
  if (!body.ok) return errorPage(body.status, "Invalid request body.");
  const form = new URLSearchParams(body.text);

  // Hidden fields are untrusted input: revalidate everything from scratch.
  const validation = validateAuthorize(form, config);
  if (validation.kind === "fatal") return errorPage(400, validation.message);
  if (validation.kind === "redirect") {
    return authorizationRedirect(config, {
      error: validation.error, error_description: validation.description, state: validation.state,
    });
  }
  const authorize = validation.request;

  const decision = single(form, "decision");
  if (decision === "deny") {
    return authorizationRedirect(config, {
      error: "access_denied", error_description: "The owner denied the request", state: authorize.state,
    });
  }
  if (decision !== "approve") return errorPage(400, "Invalid decision.");

  const granted = form.getAll("granted_scope");
  const scopes = authorize.scopes.filter((scope) => granted.includes(scope));
  if (scopes.length === 0 || granted.length !== scopes.length) {
    return page(400, "Authorize Astra Bridge", consentForm(authorize, "Select at least one of the requested scopes."));
  }

  const secret = single(form, "owner_secret");
  if (typeof secret !== "string" || secret.length === 0 || secret.length > MAX_OWNER_SECRET_LENGTH) {
    return page(401, "Authorize Astra Bridge", consentForm(authorize, "Owner secret was not accepted."));
  }

  const store = oauthStore(env);
  if (!store) return errorPage(503, "Authorization is not available.");
  const binding: CodeBinding = {
    clientId: CHATGPT_CLIENT_ID,
    redirectUri: CHATGPT_REDIRECT_URI,
    resource: authorize.resource,
    scopes,
    codeChallenge: authorize.codeChallenge,
  };
  const outcome = await store.authorizeOwner(secret, binding);
  if (!outcome.ok) {
    if (outcome.error === "rate_limited") {
      return errorPage(429, "Too many failed attempts. Try again later.", {
        "retry-after": String(outcome.retryAfterSeconds),
      });
    }
    return page(401, "Authorize Astra Bridge", consentForm(authorize, "Owner secret was not accepted."));
  }
  return authorizationRedirect(config, { code: outcome.code, state: authorize.state });
}

// ---------------------------------------------------------------------------
// Token endpoint

function tokenError(error: string, status = 400): Response {
  return jsonResponse({ error }, status, { pragma: "no-cache" });
}

function tokenSuccess(outcome: TokenOutcome): Response {
  if (!outcome.ok) return tokenError(outcome.error);
  return jsonResponse({
    access_token: outcome.tokens.accessToken,
    token_type: "Bearer",
    expires_in: outcome.tokens.expiresIn,
    refresh_token: outcome.tokens.refreshToken,
    scope: outcome.tokens.scopes.join(" "),
  }, 200, { pragma: "no-cache" });
}

async function handleToken(request: Request, env: OAuthEnv, config: OAuthConfig): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") return tokenError("invalid_request");
  // token_endpoint_auth_method is "none": any client authentication is a different method.
  if (request.headers.has("authorization")) return tokenError("invalid_client", 401);
  const body = await readBoundedText(request, OAUTH_MAX_BODY_BYTES);
  if (!body.ok) return tokenError("invalid_request", body.status === 413 ? 413 : 400);
  const form = new URLSearchParams(body.text);
  for (const name of new Set(form.keys())) {
    if (form.getAll(name).length > 1) return tokenError("invalid_request");
  }
  if (form.has("client_secret")) return tokenError("invalid_client", 401);
  if (form.get("client_id") !== CHATGPT_CLIENT_ID) return tokenError("invalid_client", 401);

  const store = oauthStore(env);
  if (!store) return tokenError("temporarily_unavailable", 503);

  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const codeVerifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) return tokenError("invalid_request");
    if (form.get("redirect_uri") !== CHATGPT_REDIRECT_URI) return tokenError("invalid_grant");
    if (form.get("resource") !== config.resource) return tokenError("invalid_target");
    if (!CODE_PATTERN.test(code)) return tokenError("invalid_grant");
    return tokenSuccess(await store.exchangeCode({
      code, codeVerifier, clientId: CHATGPT_CLIENT_ID, redirectUri: CHATGPT_REDIRECT_URI, resource: config.resource,
    }));
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    const resource = form.get("resource") ?? undefined;
    if (resource !== undefined && resource !== config.resource) return tokenError("invalid_target");
    const rawScope = form.get("scope");
    const scopes = rawScope === null ? undefined : parseScopes(rawScope);
    if (scopes === null) return tokenError("invalid_scope");
    if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) return tokenError("invalid_grant");
    return tokenSuccess(await store.refreshTokens({
      refreshToken, clientId: CHATGPT_CLIENT_ID, resource, scopes,
    }));
  }

  return tokenError(grantType ? "unsupported_grant_type" : "invalid_request");
}

// ---------------------------------------------------------------------------
// Routing

/** Returns null for paths that are not OAuth endpoints. No response carries CORS headers. */
export async function handleOAuthRoute(request: Request, env: OAuthEnv, pathname: string): Promise<Response | null> {
  const isMetadata = PROTECTED_RESOURCE_PATHS.includes(pathname) || pathname === AUTHORIZATION_SERVER_PATH;
  if (!isMetadata && pathname !== AUTHORIZE_PATH && pathname !== TOKEN_PATH) return null;

  const config = oauthConfig(env);
  if (!config) return jsonResponse({ error: "not_found" }, 404);

  if (isMetadata) {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    const metadata = pathname === AUTHORIZATION_SERVER_PATH
      ? authorizationServerMetadata(config)
      : protectedResourceMetadata(config);
    return jsonResponse(metadata, 200, { "cache-control": "public, max-age=300" });
  }
  if (pathname === AUTHORIZE_PATH) return handleAuthorize(request, env, config);
  return handleToken(request, env, config);
}
