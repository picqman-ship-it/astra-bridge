import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { McpPrincipal } from "./mcp";
import { OAUTH_SCOPES, SCOPE_READ, SCOPE_WRITE } from "./tool-policy";

/**
 * Cloudflare Access (Managed OAuth) origin validation for /mcp.
 *
 * In Access mode Cloudflare Access is the authorization server: it authenticates
 * the owner, issues the OAuth tokens the MCP client holds, and forwards each
 * allowed request with a signed `Cf-Access-Jwt-Assertion`. The Worker trusts only
 * that header, and only after verifying its signature against the team JWKS, the
 * team issuer, and the application AUD tag.
 */

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
export const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";
const MAX_ACCESS_JWT_LENGTH = 8 * 1024;
const CLOCK_TOLERANCE_SECONDS = 60;
const TEAM_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const POLICY_AUD_PATTERN = /^[A-Za-z0-9]{32,128}$/;

export type McpAuthMode = "static" | "access";

export type AccessEnv = {
  /** "static" (default when unset) or "access". Any other value fails closed. */
  MCP_AUTH_MODE?: string;
  /** Team domain, e.g. https://<team>.cloudflareaccess.com. Also the JWT issuer. */
  TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag of the Access application protecting /mcp. */
  POLICY_AUD?: string;
  /** Optional comma-separated owner allowlist, enforced in addition to the Access policy. */
  ACCESS_ALLOWED_EMAILS?: string;
};

export type AccessConfig = {
  issuer: string;
  audience: string;
  certsUrl: string;
  allowedEmails: ReadonlySet<string> | null;
};

/** Unset keeps the existing static-bearer deployment unchanged; unknown values return null. */
export function mcpAuthMode(env: AccessEnv): McpAuthMode | null {
  if (env.MCP_AUTH_MODE === undefined) return "static";
  if (typeof env.MCP_AUTH_MODE !== "string") return null;
  const mode = env.MCP_AUTH_MODE.trim().toLowerCase();
  if (mode === "static") return "static";
  if (mode === "access") return "access";
  return null;
}

/**
 * Issuer and audience come only from Worker config. TEAM_DOMAIN may be given with
 * or without the https:// scheme but must be a bare *.cloudflareaccess.com origin.
 */
export function accessConfig(env: AccessEnv): AccessConfig | null {
  const raw = env.TEAM_DOMAIN?.trim();
  const audience = env.POLICY_AUD?.trim();
  if (!raw || !audience || !POLICY_AUD_PATTERN.test(audience)) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const bare = parsed.pathname === "/" && !parsed.search && !parsed.hash
    && !parsed.username && !parsed.password && !parsed.port;
  if (parsed.protocol !== "https:" || !bare || !TEAM_HOST.test(parsed.hostname)) return null;

  let allowedEmails: Set<string> | null = null;
  if (env.ACCESS_ALLOWED_EMAILS !== undefined && env.ACCESS_ALLOWED_EMAILS.trim() !== "") {
    allowedEmails = new Set(env.ACCESS_ALLOWED_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
    if (allowedEmails.size === 0) return null;
  }

  return {
    issuer: parsed.origin,
    audience,
    certsUrl: `${parsed.origin}${ACCESS_CERTS_PATH}`,
    allowedEmails,
  };
}

// One remote key set per team, reused across requests in the isolate. jose caches
// the keys (10 min) and refetches on an unknown kid, which covers key rotation.
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function remoteAccessKeys(config: AccessConfig): JWTVerifyGetKey {
  let keys = remoteKeySets.get(config.certsUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(config.certsUrl), { timeoutDuration: 5_000 });
    remoteKeySets.set(config.certsUrl, keys);
  }
  return keys;
}

export type AccessIdentity = { email: string; subject: string };

export type AccessDevicePrincipal = {
  ownerId: string;
  deviceId: string;
  terminalEnabled: boolean;
  guiEnabled: boolean;
};

export type AccessPrincipalResolver = (
  identity: AccessIdentity,
) => Promise<AccessDevicePrincipal | null>;

/**
 * Verifies an Access JWT and returns the user identity, or null for any failure.
 * Service-token assertions carry no email and are refused: this is owner-only.
 * Errors are swallowed on purpose so no verification detail reaches a client.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  getKey: JWTVerifyGetKey = remoteAccessKeys(config),
): Promise<AccessIdentity | null> {
  if (!token || token.length > MAX_ACCESS_JWT_LENGTH) return null;
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp", "sub"],
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    if (!email || !subject) return null;
    if (config.allowedEmails && !config.allowedEmails.has(email)) return null;
    return { email, subject };
  } catch {
    return null;
  }
}

/**
 * Resolves an /mcp request to the owner principal. Only the signed assertion
 * header is read: Authorization, Cf-Access-Authenticated-User-Email, and the
 * CF_Authorization cookie are ignored, so a caller-supplied bearer is never a
 * substitute for Access.
 */
export async function authenticateAccessRequest(
  request: Request,
  config: AccessConfig,
  deviceId: string | undefined,
  getKey?: JWTVerifyGetKey,
  resolvePrincipal?: AccessPrincipalResolver,
): Promise<McpPrincipal | null> {
  const token = request.headers.get(ACCESS_JWT_HEADER)?.trim();
  if (!token) return null;
  const identity = await verifyAccessJwt(token, config, getKey);
  if (!identity) return null;

  const resolved = resolvePrincipal
    ? await resolvePrincipal(identity)
    : deviceId
      ? { ownerId: "owner", deviceId, terminalEnabled: true, guiEnabled: true }
      : null;
  if (!resolved) return null;

  return {
    kind: "access",
    ...resolved,
    scopes: (resolved.terminalEnabled || resolved.guiEnabled) ? OAUTH_SCOPES : [SCOPE_READ, SCOPE_WRITE],
  };
}
