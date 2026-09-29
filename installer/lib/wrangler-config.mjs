// The personal Worker config (relay/wrangler.personal.jsonc, gitignored), created from the
// committed template relay/wrangler.jsonc. Only the values below are ever written; every other
// line of the file, including comments and settings the user added, is left untouched.

import fs from "node:fs";
import { parseJsonc, setStringProperty } from "./jsonc.mjs";
import { writeFileAtomic } from "./util.mjs";
import {
  isPlaceholder,
  normalizeRelayUrl,
  normalizeTeamDomain,
  validateDeviceId,
  validateEmail,
  validatePolicyAud,
  validatePublicKeyB64,
  validateWorkerName,
} from "./validate.mjs";

export const FIELDS = {
  workerName: ["name"],
  agentKey: ["vars", "AGENT_PUBLIC_KEY_B64"],
  clientKey: ["vars", "CLIENT_PUBLIC_KEY_B64"],
  agentDeviceId: ["vars", "AGENT_DEVICE_ID"],
  clientDeviceId: ["vars", "CLIENT_DEVICE_ID"],
  mcpDeviceId: ["vars", "MCP_DEVICE_ID"],
  oauthIssuer: ["vars", "OAUTH_ISSUER"],
  oauthResource: ["vars", "OAUTH_RESOURCE"],
  authMode: ["vars", "MCP_AUTH_MODE"],
  teamDomain: ["vars", "TEAM_DOMAIN"],
  policyAud: ["vars", "POLICY_AUD"],
  allowedEmails: ["vars", "ACCESS_ALLOWED_EMAILS"],
};

function get(data, path) {
  return path.reduce((obj, key) => (obj && typeof obj === "object" ? obj[key] : undefined), data);
}

/** Returns `fn(raw)` or null when the value is a placeholder or invalid. */
function valid(fn, raw) {
  if (isPlaceholder(raw)) return null;
  try {
    return fn(raw);
  } catch {
    return null;
  }
}

/**
 * Reads the personal config and interprets it. `values` holds each managed field only when it
 * is a real, valid value (placeholders and invalid values are null), so callers can tell
 * "configured" from "still to do" without re-validating.
 */
export function readPersonalConfig(file) {
  if (!fs.existsSync(file)) return { exists: false };
  const text = fs.readFileSync(file, "utf8");
  let data;
  try {
    data = parseJsonc(text);
  } catch (err) {
    return { exists: true, text, error: `cannot parse ${file}: ${err.message}` };
  }
  return { exists: true, text, data, ...interpret(data) };
}

export function interpret(data) {
  const raw = Object.fromEntries(Object.entries(FIELDS).map(([k, p]) => [k, get(data, p)]));
  const deviceIds = [raw.agentDeviceId, raw.clientDeviceId, raw.mcpDeviceId];
  const deviceId = valid(validateDeviceId, raw.agentDeviceId);
  const relayUrl = valid(normalizeRelayUrl, raw.oauthIssuer);
  const values = {
    workerName: valid(validateWorkerName, raw.workerName),
    agentKey: valid(validatePublicKeyB64, raw.agentKey),
    clientKey: valid(validatePublicKeyB64, raw.clientKey),
    deviceId,
    relayUrl,
    authMode: typeof raw.authMode === "string" ? raw.authMode.trim().toLowerCase() : "",
    teamDomain: valid(normalizeTeamDomain, raw.teamDomain),
    policyAud: valid(validatePolicyAud, raw.policyAud),
    email: valid((v) => {
      const list = String(v).split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length !== 1) throw new Error("one owner email");
      return validateEmail(list[0]);
    }, raw.allowedEmails),
  };
  const problems = [];
  if (deviceId && deviceIds.some((d) => d !== deviceId)) {
    problems.push("AGENT_DEVICE_ID, CLIENT_DEVICE_ID and MCP_DEVICE_ID differ; they must be the same device id");
  }
  if (relayUrl && raw.oauthResource !== `${relayUrl}/mcp`) {
    problems.push(`OAUTH_RESOURCE should be ${relayUrl}/mcp`);
  }
  return { raw, values, problems, accessConfigured: Boolean(values.teamDomain && values.policyAud) };
}

/**
 * Applies `updates` ({ workerName, agentKey, clientKey, deviceId, relayUrl, email, teamDomain,
 * policyAud }; undefined = leave as is) to the JSONC text and returns the new text. Values are
 * validated here as well, so nothing unvalidated can reach the file.
 */
export function applyUpdates(text, updates) {
  let out = text;
  const set = (path, value) => {
    out = setStringProperty(out, path, value);
  };
  if (updates.workerName !== undefined) set(FIELDS.workerName, validateWorkerName(updates.workerName));
  if (updates.agentKey !== undefined) set(FIELDS.agentKey, validatePublicKeyB64(updates.agentKey));
  if (updates.clientKey !== undefined) set(FIELDS.clientKey, validatePublicKeyB64(updates.clientKey));
  if (updates.deviceId !== undefined) {
    const id = validateDeviceId(updates.deviceId);
    for (const p of [FIELDS.agentDeviceId, FIELDS.clientDeviceId, FIELDS.mcpDeviceId]) set(p, id);
  }
  if (updates.relayUrl !== undefined) {
    const origin = normalizeRelayUrl(updates.relayUrl);
    set(FIELDS.oauthIssuer, origin);
    set(FIELDS.oauthResource, `${origin}/mcp`);
  }
  if (updates.email !== undefined) set(FIELDS.allowedEmails, validateEmail(updates.email));
  if (updates.teamDomain !== undefined) set(FIELDS.teamDomain, normalizeTeamDomain(updates.teamDomain));
  if (updates.policyAud !== undefined) set(FIELDS.policyAud, validatePolicyAud(updates.policyAud));
  // The result must still be valid JSONC holding exactly what was asked for.
  const check = interpret(parseJsonc(out)).values;
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && !check[k]) throw new Error(`internal error: ${k} did not round-trip`);
  }
  return out;
}

/** Writes the personal config 0600 (it holds your email and device id; no secrets). */
export function writePersonalConfig(file, text) {
  writeFileAtomic(file, text, 0o600);
}
