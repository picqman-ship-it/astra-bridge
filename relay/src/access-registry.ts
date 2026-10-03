import { isBetaDeviceId } from "./beta-identity";
import { isOpaqueId, type BetaPrincipal, type D1DatabaseLike } from "./beta-registry";

const MAX_ISSUER_LENGTH = 512;
const MAX_SUBJECT_LENGTH = 512;

type AccessDeviceRow = {
  owner_id: string;
  device_id: string;
  terminal_enabled: number;
  gui_enabled: number;
};

// Match pairing validation and SQLite length(): count code points and reject
// control characters, including NUL, where SQLite length() stops counting.
function validIdentityPart(value: unknown, max: number): value is string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const length = [...value].length;
  return length > 0 && length <= max;
}

function validRow(row: AccessDeviceRow | null): row is AccessDeviceRow {
  return row !== null
    && isOpaqueId(row.owner_id)
    && isBetaDeviceId(row.device_id)
    && (row.terminal_enabled === 0 || row.terminal_enabled === 1)
    && (row.gui_enabled === 0 || row.gui_enabled === 1);
}

/**
 * Resolve one authenticated external identity to exactly one active Astra device.
 *
 * The identity subject is authoritative and scoped by issuer. Email never selects
 * the route, but changed reviewed identity metadata invalidates a control overlay.
 * The query fails closed when the
 * owner has zero or multiple active devices; multi-device selection is a later product
 * feature and must never silently pick an arbitrary machine.
 */
export async function resolveAccessIdentityDevice(
  registry: D1DatabaseLike,
  issuer: string,
  subject: string,
): Promise<BetaPrincipal | null> {
  if (!validIdentityPart(issuer, MAX_ISSUER_LENGTH) || !validIdentityPart(subject, MAX_SUBJECT_LENGTH)) {
    return null;
  }

  const row = await registry.prepare(`
    SELECT d.owner_id, d.device_id,
      COALESCE(p.terminal_enabled, d.terminal_enabled, 0) AS terminal_enabled,
      COALESCE(p.gui_enabled, 0) AS gui_enabled
    FROM user_identities AS i
    JOIN users AS u ON u.user_id = i.owner_id
    JOIN devices AS d ON d.owner_id = i.owner_id
    LEFT JOIN device_control_permissions AS p ON p.device_id=d.device_id AND p.owner_id=d.owner_id
    WHERE i.issuer = ?
      AND i.subject = ?
      AND i.status = 'active'
      AND u.status = 'active'
      AND d.status = 'active'
      AND d.revoked_at IS NULL
      AND (p.device_id IS NULL OR (p.agent_public_key_b64=d.agent_public_key_b64
        AND p.identity_issuer=i.issuer AND p.identity_subject=i.subject AND p.identity_email=i.email
        AND (SELECT COUNT(*) FROM user_identities i2 WHERE i2.owner_id=d.owner_id AND i2.status='active')=1))
      AND (
        SELECT COUNT(*)
        FROM devices AS d2
        WHERE d2.owner_id = i.owner_id
          AND d2.status = 'active'
          AND d2.revoked_at IS NULL
      ) = 1
    LIMIT 1
  `).bind(issuer, subject).first<AccessDeviceRow>();

  if (!validRow(row)) return null;
  return {
    ownerId: row.owner_id,
    deviceId: row.device_id,
    terminalEnabled: row.terminal_enabled === 1,
    guiEnabled: row.gui_enabled === 1,
  };
}
