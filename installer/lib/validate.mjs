// Validation of the few values the installer collects locally. Each validator returns the
// normalized value or throws an Error whose message can be shown to the user as-is.
//
// The device-id rule is the agent's (relay/src/agent-lib.mjs) and the Worker's; the Access
// rules mirror relay/src/access-auth.ts, and test/validate.test.mjs checks they stay in sync.

export const DEVICE_ID_RE = /^[a-zA-Z0-9._-]{1,96}$/;
export const TEAM_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
export const POLICY_AUD_RE = /^[A-Za-z0-9]{32,128}$/;
// Cloudflare Worker names: lowercase letters, digits and dashes, not starting/ending with a dash.
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Template values that must be replaced before a value counts as configured. */
export function isPlaceholder(value) {
  return typeof value !== "string" || value.trim() === "" || /REPLACE_WITH_|<your-|<[a-z-]+>|\bexample\.com\b/i.test(value);
}

export function validateDeviceId(raw, betaEnabled = false) {
  const v = String(raw ?? "").trim();
  if (!DEVICE_ID_RE.test(v)) throw new Error("device id must be 1-96 characters of letters, digits, '.', '_' or '-' (for example my-mac)");
  if (betaEnabled && /^beta-/i.test(v)) throw new Error("the beta- prefix is reserved when BETA_REGISTRY_ENABLED=true");
  return v;
}

export function validateEmail(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) throw new Error("enter one email address, for example you@yourdomain.com");
  if (isPlaceholder(v)) throw new Error("use your real email address, not the example one");
  return v;
}

export function validateWorkerName(raw) {
  const v = String(raw ?? "").trim();
  if (!WORKER_NAME_RE.test(v)) throw new Error("worker name must be 1-63 lowercase letters, digits or '-', not starting or ending with '-'");
  return v;
}

/**
 * The relay's public origin: https only, a plain DNS host, no port, path, query, fragment or
 * credentials (the agent pins exactly this host). Returns the origin without a trailing slash.
 */
export function normalizeRelayUrl(raw) {
  const v = String(raw ?? "").trim();
  let url;
  try {
    url = new URL(v);
  } catch {
    throw new Error("relay URL must look like https://astra-bridge-relay.<your-subdomain>.workers.dev");
  }
  if (url.protocol !== "https:") throw new Error("relay URL must use https://");
  if (url.username || url.password || url.search || url.hash || url.port) {
    throw new Error("relay URL must not contain credentials, a port, a query or a fragment");
  }
  if (url.pathname !== "/") throw new Error("relay URL must be the bare origin (no path such as /mcp)");
  const labels = url.hostname.split(".");
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL_RE.test(l))) throw new Error(`relay host ${url.hostname} is not a valid DNS name`);
  if (isPlaceholder(v)) throw new Error("relay URL still contains a placeholder");
  return url.origin;
}

/** Accepts "team", "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com[/]". */
export function normalizeTeamDomain(raw) {
  let v = String(raw ?? "").trim().toLowerCase();
  if (!v) throw new Error("team domain is required");
  if (!v.includes(".") && !v.includes("/")) v = `${v}.cloudflareaccess.com`;
  let url;
  try {
    url = new URL(v.includes("://") ? v : `https://${v}`);
  } catch {
    throw new Error("team domain must look like https://<team>.cloudflareaccess.com");
  }
  const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password && !url.port;
  if (url.protocol !== "https:" || !bare || !TEAM_HOST_RE.test(url.hostname)) {
    throw new Error("team domain must look like https://<team>.cloudflareaccess.com (Zero Trust → Settings → Team name and domain)");
  }
  return url.origin;
}

export function validatePolicyAud(raw) {
  const v = String(raw ?? "").trim();
  if (!POLICY_AUD_RE.test(v)) {
    throw new Error("the Application Audience (AUD) tag is 32-128 letters/digits (usually 64 hex characters); copy it from the Access application's overview");
  }
  return v;
}

/** An Ed25519 SPKI public key in base64 DER, the form keygen prints and the Worker imports. */
export function validatePublicKeyB64(raw) {
  const v = String(raw ?? "").trim();
  const der = /^[A-Za-z0-9+/]+={0,2}$/.test(v) ? Buffer.from(v, "base64") : null;
  // 12-byte Ed25519 SPKI header (30 2a 30 05 06 03 2b 65 70 03 21 00) + 32-byte key.
  if (!der || der.length !== 44 || der.subarray(0, 12).toString("hex") !== "302a300506032b6570032100") {
    throw new Error("not an Ed25519 public key in base64 SPKI form");
  }
  return v;
}
