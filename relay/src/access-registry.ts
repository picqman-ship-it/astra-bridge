import { isBetaDeviceId } from "./beta-identity";
import type { BetaPrincipal, D1DatabaseLike } from "./beta-registry";

const MAX_ISSUER_LENGTH = 512;
const MAX_SUBJECT_LENGTH = 512;

type AccessDeviceRow = {
  owner_id: string;
  device_id: string;
  terminal_enabled: number;
};

function validIdentityPart(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max;
}

function validRow(row: AccessDeviceRow | null): row is AccessDeviceRow {
  return row !== null
    && typeof row.owner_id === "string" && row.owner_id.length > 0
    && isBetaDeviceId(row.device_id)
    && (row.terminal_enabled === 0 || row.terminal_enabled === 1);
}

/**
 * Resolve one authenticated external identity to exactly one active Astra device.
 *
 * The identity subject is authoritative and scoped by issuer. Email is deliberately
 * not used for authorization because it can change. The query fails closed when the
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
    SELECT d.owner_id, d.device_id, d.terminal_enabled
    FROM user_identities AS i
    JOIN users AS u ON u.user_id = i.owner_id
    JOIN devices AS d ON d.owner_id = i.owner_id
    WHERE i.issuer = ?
      AND i.subject = ?
      AND i.status = 'active'
      AND u.status = 'active'
      AND d.status = 'active'
      AND d.revoked_at IS NULL
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
  };
}
