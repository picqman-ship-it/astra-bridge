import { canonicalAgentKey } from "./ed25519-validation";
import { isBetaDeviceId } from "./beta-identity";
import { isOpaqueId, type D1DatabaseLike } from "./beta-registry";

export const CONTROL_REQUEST_TTL_MS = 5 * 60 * 1000;
export const CONTROL_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ControlTarget = { terminalEnabled: boolean; guiEnabled: boolean };
export type ControlDeviceState = ControlTarget & {
  ownerId: string; deviceId: string; agentPublicKeyB64: string;
  identityIssuer: string; identitySubject: string; identityEmail: string;
};
export type ControlPreview = ControlDeviceState & {
  requestId: string; previousTerminal: boolean; previousGui: boolean;
  requestedTerminal: boolean; requestedGui: boolean; expiresAtMs: number;
  identityFingerprint: string; agentFingerprint: string; status: "pending" | "applied" | "cancelled" | "expired";
};

type StateRow = {
  owner_id: string; device_id: string; agent_public_key_b64: string; issuer: string; subject: string; email: string;
  terminal_enabled: number; gui_enabled: number;
};
type RequestRow = StateRow & {
  request_id: string; previous_terminal: number; previous_gui: number; previous_version: number; requested_terminal: number; requested_gui: number;
  status: "pending" | "applied" | "cancelled"; created_at_ms: number; expires_at_ms: number; applied_at_ms: number | null;
};

const boolInt = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const identityOk = (value: unknown, max = 512): value is string => typeof value === "string"
  && !/[\u0000-\u001f\u007f]/.test(value) && [...value].length > 0 && [...value].length <= max;
const emailOk = (value: unknown): value is string => identityOk(value, 320) && [...value].length >= 3;
const safeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function validState(row: StateRow | null): row is StateRow {
  return row !== null && isOpaqueId(row.owner_id) && isBetaDeviceId(row.device_id)
    && canonicalAgentKey(row.agent_public_key_b64) !== null
    && identityOk(row.issuer) && identityOk(row.subject) && emailOk(row.email)
    && boolInt(row.terminal_enabled) && boolInt(row.gui_enabled);
}

async function digestHex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function controlIdentityFingerprint(issuer: string, subject: string): Promise<string> {
  return digestHex(new TextEncoder().encode(`${issuer}\n${subject}`));
}

export async function controlAgentFingerprint(publicKeyB64: string): Promise<string> {
  return digestHex(Uint8Array.from(atob(publicKeyB64), c => c.charCodeAt(0)));
}

async function previewFromRow(row: RequestRow, now: number): Promise<ControlPreview | null> {
  if (!validState(row) || !CONTROL_REQUEST_ID.test(row.request_id)
    || !boolInt(row.previous_terminal) || !boolInt(row.previous_gui)
    || !safeInt(row.previous_version) || row.previous_version < 1
    || !boolInt(row.requested_terminal) || !boolInt(row.requested_gui)
    || !safeInt(row.created_at_ms) || !safeInt(row.expires_at_ms)) return null;
  const status = row.status === "pending" && row.expires_at_ms <= now ? "expired" : row.status;
  const [identityFingerprint, agentFingerprint] = await Promise.all([
    controlIdentityFingerprint(row.issuer, row.subject),
    controlAgentFingerprint(row.agent_public_key_b64),
  ]);
  return {
    ownerId: row.owner_id, deviceId: row.device_id, agentPublicKeyB64: row.agent_public_key_b64,
    identityIssuer: row.issuer, identitySubject: row.subject, identityEmail: row.email,
    terminalEnabled: row.terminal_enabled === 1, guiEnabled: row.gui_enabled === 1,
    requestId: row.request_id, previousTerminal: row.previous_terminal === 1, previousGui: row.previous_gui === 1,
    requestedTerminal: row.requested_terminal === 1, requestedGui: row.requested_gui === 1,
    expiresAtMs: row.expires_at_ms, identityFingerprint, agentFingerprint, status,
  };
}

export async function resolveControlDeviceState(registry: D1DatabaseLike, deviceId: string): Promise<ControlDeviceState | null> {
  if (!isBetaDeviceId(deviceId)) return null;
  const row = await registry.prepare(`
    SELECT d.owner_id, d.device_id, d.agent_public_key_b64, i.issuer, i.subject, i.email,
      COALESCE(p.terminal_enabled, d.terminal_enabled, 0) AS terminal_enabled,
      COALESCE(p.gui_enabled, 0) AS gui_enabled
    FROM devices AS d
    JOIN users AS u ON u.user_id = d.owner_id
    JOIN user_identities AS i ON i.owner_id = d.owner_id
    LEFT JOIN device_control_permissions AS p ON p.device_id = d.device_id AND p.owner_id = d.owner_id
    WHERE d.device_id = ? AND d.status = 'active' AND d.revoked_at IS NULL AND u.status = 'active'
      AND i.status = 'active' AND i.email IS NOT NULL
      AND (p.device_id IS NULL OR (p.agent_public_key_b64=d.agent_public_key_b64
        AND p.identity_issuer=i.issuer AND p.identity_subject=i.subject AND p.identity_email=i.email))
      AND (SELECT COUNT(*) FROM user_identities AS i2 WHERE i2.owner_id = d.owner_id AND i2.status = 'active') = 1
    LIMIT 1
  `).bind(deviceId).first<StateRow>();
  if (!validState(row)) return null;
  return {
    ownerId: row.owner_id, deviceId: row.device_id, agentPublicKeyB64: row.agent_public_key_b64,
    identityIssuer: row.issuer, identitySubject: row.subject, identityEmail: row.email,
    terminalEnabled: row.terminal_enabled === 1, guiEnabled: row.gui_enabled === 1,
  };
}

export async function startControlPermissionRequest(
  registry: D1DatabaseLike, deviceId: string, agentPublicKeyB64: string, requestId: string, target: ControlTarget, now = Date.now(),
): Promise<ControlPreview | null> {
  if (!registry.batch || !CONTROL_REQUEST_ID.test(requestId) || !safeInt(now) || !canonicalAgentKey(agentPublicKeyB64)) return null;
  const state = await resolveControlDeviceState(registry, deviceId);
  if (!state || state.agentPublicKeyB64 !== agentPublicKeyB64
    || (state.terminalEnabled === target.terminalEnabled && state.guiEnabled === target.guiEnabled)) return null;
  const expiresAtMs = now + CONTROL_REQUEST_TTL_MS;
  try {
    await registry.batch([
      registry.prepare(`UPDATE control_permission_requests SET status='cancelled'
        WHERE device_id=? AND status='pending' AND expires_at_ms <= ?`).bind(deviceId, now),
      registry.prepare(`INSERT INTO device_control_permissions
        (device_id, owner_id, agent_public_key_b64, identity_issuer, identity_subject, identity_email,
         terminal_enabled, gui_enabled, version, updated_at_ms)
        SELECT d.device_id, d.owner_id, d.agent_public_key_b64, i.issuer, i.subject, i.email, d.terminal_enabled, 0, 1, ?
        FROM devices d JOIN users u ON u.user_id=d.owner_id
        JOIN user_identities i ON i.owner_id=d.owner_id
        WHERE d.device_id=? AND d.owner_id=? AND d.agent_public_key_b64=?
          AND d.status='active' AND d.revoked_at IS NULL AND u.status='active'
          AND i.issuer=? AND i.subject=? AND i.email=? AND i.status='active'
          AND (SELECT COUNT(*) FROM user_identities i2 WHERE i2.owner_id=d.owner_id AND i2.status='active')=1
          AND NOT EXISTS (SELECT 1 FROM device_control_permissions WHERE device_id=d.device_id)`).bind(
            now, deviceId, state.ownerId, agentPublicKeyB64, state.identityIssuer, state.identitySubject, state.identityEmail),
      registry.prepare(`INSERT INTO control_permission_requests
        (request_id, owner_id, device_id, agent_public_key_b64, identity_issuer, identity_subject, identity_email,
         previous_terminal, previous_gui, previous_version, requested_terminal, requested_gui, status, created_at_ms, expires_at_ms)
        SELECT ?, d.owner_id, d.device_id, d.agent_public_key_b64, i.issuer, i.subject, i.email,
          p.terminal_enabled, p.gui_enabled, p.version, ?, ?, 'pending', ?, ?
        FROM devices d JOIN users u ON u.user_id=d.owner_id
        JOIN user_identities i ON i.owner_id=d.owner_id
        JOIN device_control_permissions p ON p.device_id=d.device_id AND p.owner_id=d.owner_id
        WHERE d.device_id=? AND d.owner_id=? AND d.agent_public_key_b64=?
          AND d.status='active' AND d.revoked_at IS NULL AND u.status='active'
          AND i.issuer=? AND i.subject=? AND i.email=? AND i.status='active'
          AND (SELECT COUNT(*) FROM user_identities i2 WHERE i2.owner_id=d.owner_id AND i2.status='active')=1
          AND p.agent_public_key_b64=d.agent_public_key_b64
          AND p.identity_issuer=i.issuer AND p.identity_subject=i.subject AND p.identity_email=i.email
          AND p.terminal_enabled=? AND p.gui_enabled=?`).bind(
          requestId, target.terminalEnabled ? 1 : 0, target.guiEnabled ? 1 : 0, now, expiresAtMs,
          deviceId, state.ownerId, agentPublicKeyB64, state.identityIssuer, state.identitySubject, state.identityEmail,
          state.terminalEnabled ? 1 : 0, state.guiEnabled ? 1 : 0),
    ]);
  } catch {
    return null;
  }
  return controlPermissionRequestStatus(registry, deviceId, requestId, now);
}

export async function controlPermissionRequestStatus(
  registry: D1DatabaseLike, deviceId: string, requestId: string, now = Date.now(),
): Promise<ControlPreview | null> {
  if (!isBetaDeviceId(deviceId) || !CONTROL_REQUEST_ID.test(requestId) || !safeInt(now)) return null;
  const row = await registry.prepare(`
    SELECT r.request_id, r.owner_id, r.device_id, r.agent_public_key_b64,
      r.identity_issuer AS issuer, r.identity_subject AS subject, r.identity_email AS email,
      r.previous_terminal, r.previous_gui, r.previous_version, r.requested_terminal, r.requested_gui,
      r.status, r.created_at_ms, r.expires_at_ms, r.applied_at_ms,
      COALESCE(p.terminal_enabled, d.terminal_enabled, 0) AS terminal_enabled, COALESCE(p.gui_enabled, 0) AS gui_enabled
    FROM control_permission_requests AS r
    JOIN devices AS d ON d.device_id=r.device_id AND d.owner_id=r.owner_id
    JOIN users AS u ON u.user_id=d.owner_id
    JOIN user_identities AS i ON i.owner_id=r.owner_id AND i.issuer=r.identity_issuer AND i.subject=r.identity_subject
    LEFT JOIN device_control_permissions AS p ON p.device_id=d.device_id AND p.owner_id=d.owner_id
    WHERE r.request_id=? AND r.device_id=?
      AND d.agent_public_key_b64=r.agent_public_key_b64 AND d.status='active' AND d.revoked_at IS NULL AND u.status='active'
      AND i.status='active' AND i.email=r.identity_email
      AND p.agent_public_key_b64=d.agent_public_key_b64
      AND p.identity_issuer=i.issuer AND p.identity_subject=i.subject AND p.identity_email=i.email
      AND (SELECT COUNT(*) FROM user_identities i2 WHERE i2.owner_id=r.owner_id AND i2.status='active')=1
    LIMIT 1
  `).bind(requestId, deviceId).first<RequestRow>();
  return row ? previewFromRow(row, now) : null;
}

export async function applyControlPermissionRequest(
  registry: D1DatabaseLike, deviceId: string, agentPublicKeyB64: string, requestId: string, target: ControlTarget, now = Date.now(),
): Promise<ControlPreview | null> {
  if (!registry.batch || !CONTROL_REQUEST_ID.test(requestId) || !safeInt(now)) return null;
  const existing = await controlPermissionRequestStatus(registry, deviceId, requestId, now);
  if (!existing || existing.agentPublicKeyB64 !== agentPublicKeyB64
    || existing.requestedTerminal !== target.terminalEnabled || existing.requestedGui !== target.guiEnabled) return null;
  if (existing.status === "applied") {
    return existing.terminalEnabled === target.terminalEnabled && existing.guiEnabled === target.guiEnabled ? existing : null;
  }
  if (existing.status !== "pending" || existing.expiresAtMs <= now) return null;
  try {
    // The migration trigger changes permissions in this same statement and aborts
    // the transition if any snapshot, identity, key, or active-device guard fails.
    const results = await registry.batch([
      registry.prepare(`UPDATE control_permission_requests SET status='applied', applied_at_ms=?
        WHERE request_id=? AND device_id=? AND owner_id=? AND agent_public_key_b64=?
          AND status='pending' AND created_at_ms<=? AND expires_at_ms>?
          AND requested_terminal=? AND requested_gui=?
        RETURNING device_id`).bind(
          now, requestId, deviceId, existing.ownerId, agentPublicKeyB64, now, now,
          target.terminalEnabled ? 1 : 0, target.guiEnabled ? 1 : 0),
    ]);
    const rows = results[0]?.results as Array<{device_id?: unknown}> | undefined;
    if (results.length !== 1 || results[0]?.success !== true || rows?.length !== 1 || rows[0]?.device_id !== deviceId) return null;
  } catch { return null; }
  return controlPermissionRequestStatus(registry, deviceId, requestId, now);
}

export async function cancelControlPermissionRequest(
  registry: D1DatabaseLike, deviceId: string, agentPublicKeyB64: string, requestId: string, now = Date.now(),
): Promise<boolean> {
  const existing = await controlPermissionRequestStatus(registry, deviceId, requestId, now);
  if (!existing || existing.agentPublicKeyB64 !== agentPublicKeyB64 || existing.status !== "pending") return false;
  try {
    await registry.prepare(`UPDATE control_permission_requests SET status='cancelled'
      WHERE request_id=? AND device_id=? AND status='pending'`).bind(requestId, deviceId).run();
    return (await controlPermissionRequestStatus(registry, deviceId, requestId, now))?.status === "cancelled";
  } catch { return false; }
}
