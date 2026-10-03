import { APPROVED_TOOL_NAMES } from "./tool-policy";
import { isBetaDeviceId } from "./beta-identity";
import { canonicalAgentKey } from "./ed25519-validation";

export type D1StatementLike = {
  bind: (...values: unknown[]) => D1StatementLike;
  first: <T>() => Promise<T | null>;
  run: () => Promise<unknown>;
};

export type D1DatabaseLike = {
  prepare: (query: string) => D1StatementLike;
  // Required for enrollment. Older read-only adapters remain valid but cannot enroll.
  batch?: (statements: D1StatementLike[]) => Promise<{ success: boolean; results?: unknown[] }[]>;
};

export type BetaPrincipal = {
  ownerId: string;
  deviceId: string;
  terminalEnabled: boolean;
  guiEnabled: boolean;
};

export type BetaAgentDevice = {
  ownerId: string;
  deviceId: string;
  agentPublicKeyB64: string;
  terminalEnabled: boolean;
  guiEnabled: boolean;
};

export type AuditEvent = {
  eventId: string;
  ownerId: string;
  deviceId: string;
  toolName: string;
  outcome: "allowed" | "denied" | "succeeded" | "failed";
  durationMs?: number;
  createdAt: string;
};

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ACTIVE_STATUSES = new Set(["active"]);

// Every new beta file capability requires explicit review here. Control telemetry
// can expose command arguments and is intentionally absent.
export const BETA_FILE_ONLY_TOOLS = new Set([
  "get_config", "read_file", "read_multiple_files", "write_file", "create_directory",
  "list_directory", "move_file", "get_file_info", "start_search", "get_more_search_results",
  "stop_search", "list_searches", "edit_block",
]);

// Used by tool-policy tests to require control scope for the process/job/GUI family.
// Beta file-only authorization uses BETA_FILE_ONLY_TOOLS, not this classification.
export const TERMINAL_TOOL_NAMES = new Set([
  "start_process", "read_process_output", "interact_with_process", "force_terminate",
  "list_sessions", "list_processes", "kill_process", "get_recent_tool_calls",
  "job_start", "job_status", "job_list", "job_logs", "job_cancel",
]);

export const GUI_TOOL_NAMES = new Set([
  "list_windows", "inspect_ui", "press_element", "set_element_value",
]);

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

export function isActiveStatus(value: unknown): value is "active" {
  return typeof value === "string" && ACTIVE_STATUSES.has(value);
}

export function isValidExpiration(value: unknown, now = Date.now()): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export async function hashBearerToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isToolAllowedForPrincipal(
  name: string,
  principal: Pick<BetaPrincipal, "terminalEnabled" | "guiEnabled">,
): boolean {
  if (!APPROVED_TOOL_NAMES.has(name)) return false;
  if (BETA_FILE_ONLY_TOOLS.has(name)) return true;
  // Preserve the reviewed beta.2 file-only allowlist; usage telemetry remains
  // available only with terminal consent even though its OAuth scope is read.
  if (name === "get_usage_stats") return principal.terminalEnabled;
  if (TERMINAL_TOOL_NAMES.has(name)) return principal.terminalEnabled;
  if (GUI_TOOL_NAMES.has(name)) return principal.guiEnabled;
  return false;
}

type PrincipalRow = {
  owner_id: string;
  device_id: string;
  terminal_enabled: number;
};

type BearerPrincipalRow = PrincipalRow & { gui_enabled: number };
type AgentRow = PrincipalRow & { agent_public_key_b64: string };

function validPrincipalRow(row: PrincipalRow | null): row is PrincipalRow {
  return row !== null
    && isOpaqueId(row.owner_id)
    && isBetaDeviceId(row.device_id)
    && (row.terminal_enabled === 0 || row.terminal_enabled === 1);
}

/** Resolves only active, unexpired tokens whose user and device are active. */
export async function resolveBetaBearerHash(
  registry: D1DatabaseLike,
  tokenHash: string,
  now = Date.now(),
): Promise<BetaPrincipal | null> {
  if (!isSha256Hex(tokenHash)) return null;
  const nowIso = new Date(now).toISOString();
  const row = await registry.prepare(`
    SELECT t.owner_id, t.device_id,
      COALESCE(p.terminal_enabled, d.terminal_enabled, 0) AS terminal_enabled,
      CASE WHEN p.device_id IS NULL THEN d.terminal_enabled ELSE p.gui_enabled END AS gui_enabled
    FROM access_tokens AS t
    JOIN users AS u ON u.user_id = t.owner_id
    JOIN devices AS d ON d.device_id = t.device_id AND d.owner_id = t.owner_id
    LEFT JOIN device_control_permissions AS p ON p.device_id=d.device_id AND p.owner_id=d.owner_id
    WHERE t.token_hash = ?
      AND t.status = 'active' AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > ?)
      AND u.status = 'active'
      AND d.status = 'active' AND d.revoked_at IS NULL
      AND (p.device_id IS NULL OR (p.agent_public_key_b64=d.agent_public_key_b64
        AND EXISTS (SELECT 1 FROM user_identities i WHERE i.owner_id=d.owner_id
          AND i.issuer=p.identity_issuer AND i.subject=p.identity_subject AND i.email=p.identity_email AND i.status='active')
        AND (SELECT COUNT(*) FROM user_identities i2 WHERE i2.owner_id=d.owner_id AND i2.status='active')=1))
    LIMIT 1
  `).bind(tokenHash, nowIso).first<BearerPrincipalRow>();
  if (!validPrincipalRow(row) || (row.gui_enabled !== 0 && row.gui_enabled !== 1)) return null;
  return { ownerId: row.owner_id, deviceId: row.device_id, terminalEnabled: row.terminal_enabled === 1, guiEnabled: row.gui_enabled === 1 };
}

/** Resolves an active beta device to the public key used for agent signatures. */
export async function resolveActiveBetaDevice(
  registry: D1DatabaseLike,
  deviceId: string,
): Promise<BetaAgentDevice | null> {
  if (!isBetaDeviceId(deviceId)) return null;
  const row = await registry.prepare(`
    SELECT d.owner_id, d.device_id, d.agent_public_key_b64, d.terminal_enabled
    FROM devices AS d
    JOIN users AS u ON u.user_id = d.owner_id
    WHERE d.device_id = ?
      AND d.status = 'active' AND d.revoked_at IS NULL
      AND u.status = 'active'
    LIMIT 1
  `).bind(deviceId).first<AgentRow>();
  if (!validPrincipalRow(row) || !canonicalAgentKey(row.agent_public_key_b64)) {
    return null;
  }
  return {
    ownerId: row.owner_id,
    deviceId: row.device_id,
    agentPublicKeyB64: row.agent_public_key_b64,
    terminalEnabled: row.terminal_enabled === 1,
    guiEnabled: row.terminal_enabled === 1,
  };
}

/** Writes a deliberately metadata-only audit row. Callers cannot pass payloads. */
export async function recordAuditEvent(registry: D1DatabaseLike, event: AuditEvent): Promise<void> {
  if (!isOpaqueId(event.eventId) || !isOpaqueId(event.ownerId) || !isOpaqueId(event.deviceId)
    || (!APPROVED_TOOL_NAMES.has(event.toolName) && event.toolName !== "unapproved_tool") || !isValidExpiration(event.createdAt, 0)
    || (event.durationMs !== undefined && (!Number.isInteger(event.durationMs) || event.durationMs < 0))) {
    throw new Error("invalid_audit_event");
  }
  await registry.prepare(`
    INSERT INTO audit_events (event_id, owner_id, device_id, tool_name, outcome, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.eventId,
    event.ownerId,
    event.deviceId,
    event.toolName,
    event.outcome,
    event.durationMs ?? null,
    event.createdAt,
  ).run();
}
