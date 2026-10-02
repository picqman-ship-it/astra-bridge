import { hashBearerToken, type D1DatabaseLike } from "./beta-registry";
import { isBetaDeviceId } from "./beta-identity";
import { canonicalAgentKey, canonicalSignature } from "./ed25519-validation";

export const PAIR_SECRET_PATTERN = /^ap1_[a-f0-9]{64}$/;
export const PAIR_CODE_PATTERN = /^pc1_[a-f0-9]{32}$/;
export const PAIR_CONSENT_PATTERN = /^ac1_[a-f0-9]{64}$/;
export const PAIR_CLAIM_TTL_MS = 5 * 60 * 1000;
export const PAIR_REQUEST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PAIR_TTL_MS = 10 * 60 * 1000;

export type PairStartRegistration = {
  version: 1;
  requestId: string;
  deviceId: string;
  agentPublicKeyB64: string;
  proof: string;
};

export type PairIdentity = {
  issuer: string;
  subject: string;
  email: string;
};

export type PairSession = {
  secret: string;
  claimCode: string;
  deviceId: string;
  expiresAtMs: number;
};

type PairRow = {
  device_id: string;
  agent_public_key_b64: string;
  status: "pending" | "claimed" | "cancelled";
  expires_at_ms: number;
  owner_id: string | null;
};

function exactHttpsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newPairSecret(): string {
  return `ap1_${randomHex(32)}`;
}

export async function pairingProofMessage(
  origin: string,
  requestId: string,
  deviceId: string,
  agentPublicKeyB64: string,
): Promise<string> {
  if (!exactHttpsOrigin(origin) || !PAIR_REQUEST_PATTERN.test(requestId) || !isBetaDeviceId(deviceId)) {
    throw new Error("invalid_pair_context");
  }
  if (!canonicalAgentKey(agentPublicKeyB64)) throw new Error("invalid_pair_key");
  return ["astra-pair-start-v1", origin, requestId, deviceId, agentPublicKeyB64].join("\n");
}

export async function validatePairStart(
  value: unknown,
  origin: string,
): Promise<PairStartRegistration | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "agentPublicKeyB64,deviceId,proof,requestId,version"
    || row.version !== 1
    || typeof row.requestId !== "string" || !PAIR_REQUEST_PATTERN.test(row.requestId)
    || typeof row.deviceId !== "string" || !isBetaDeviceId(row.deviceId)
    || typeof row.agentPublicKeyB64 !== "string"
    || typeof row.proof !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(row.proof)) {
    return null;
  }

  try {
    const keyBytes = canonicalAgentKey(row.agentPublicKeyB64);
    if (!keyBytes) return null;
    const signature = Uint8Array.from(atob(row.proof), (c) => c.charCodeAt(0));
    if (btoa(String.fromCharCode(...signature)) !== row.proof || !canonicalSignature(signature)) return null;
    const publicKey = await crypto.subtle.importKey("spki", keyBytes, "Ed25519", false, ["verify"]);
    const message = await pairingProofMessage(origin, row.requestId, row.deviceId, row.agentPublicKeyB64);
    if (!await crypto.subtle.verify("Ed25519", publicKey, signature, new TextEncoder().encode(message))) return null;
    return {
      version: 1,
      requestId: row.requestId,
      deviceId: row.deviceId,
      agentPublicKeyB64: row.agentPublicKeyB64,
      proof: row.proof,
    };
  } catch {
    return null;
  }
}

export async function createPairingSession(
  registry: D1DatabaseLike,
  registration: PairStartRegistration,
  now = Date.now(),
): Promise<PairSession | null> {
  if (!Number.isSafeInteger(now)) return null;
  const secret = newPairSecret();
  const claimCode = `pc1_${randomHex(16)}`;
  const claimCodeHash = await hashBearerToken(claimCode);
  const secretHash = await hashBearerToken(secret);
  const expiresAtMs = now + PAIR_TTL_MS;

  try {
    await registry.prepare(`
      INSERT INTO pairing_sessions
        (secret_hash, request_id, device_id, agent_public_key_b64, status, created_at_ms, expires_at_ms, claim_code_hash)
      SELECT ?, ?, ?, ?, 'pending', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM devices WHERE device_id = ?)
        AND NOT EXISTS (SELECT 1 FROM devices WHERE agent_public_key_b64 = ?)
        AND NOT EXISTS (
          SELECT 1 FROM pairing_sessions WHERE status = 'pending' AND expires_at_ms > ?
            AND (device_id = ? OR agent_public_key_b64 = ?)
        )
    `).bind(
      secretHash,
      registration.requestId,
      registration.deviceId,
      registration.agentPublicKeyB64,
      now,
      expiresAtMs,
      claimCodeHash,
      registration.deviceId,
      registration.agentPublicKeyB64,
      now,
      registration.deviceId,
      registration.agentPublicKeyB64,
    ).run();

    const row = await registry.prepare(`
      SELECT device_id
      FROM pairing_sessions
      WHERE secret_hash = ? AND request_id = ? AND status = 'pending'
      LIMIT 1
    `).bind(secretHash, registration.requestId).first<{ device_id: string }>();
    return row?.device_id === registration.deviceId
      ? { secret, claimCode, deviceId: registration.deviceId, expiresAtMs }
      : null;
  } catch {
    return null;
  }
}

async function deterministicOwnerId(issuer: string, subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${issuer}\n${subject}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `usr_${hex.slice(0, 40)}`;
}

export async function claimPairingSession(
  registry: D1DatabaseLike,
  consent: string,
  identity: PairIdentity,
  now = Date.now(),
): Promise<{ ownerId: string; deviceId: string } | null> {
  if (!registry.batch || !PAIR_CONSENT_PATTERN.test(consent) || !Number.isSafeInteger(now)
    || !validIdentity(identity)) return null;

  // Recheck the reviewed identity, device/key snapshot, scope and expiry in
  // EVERY mutating statement of the atomic batch, not in a stale preflight read.
  const consentHash = await hashBearerToken(consent);
  const eligible = `consent_hash = ? AND consent_issuer = ? AND consent_subject = ?
      AND consent_email = ? AND consent_scope = 'files-v1' AND status = 'pending'
      AND consent_device_id = device_id AND consent_agent_public_key_b64 = agent_public_key_b64
      AND consent_created_at_ms <= ? AND consent_expires_at_ms > ?
      AND created_at_ms <= ? AND expires_at_ms > ?`;
  const consentValues = [consentHash, identity.issuer, identity.subject, identity.email, now, now, now, now];
  const ownerId = await deterministicOwnerId(identity.issuer, identity.subject);
  const nowIso = new Date(now).toISOString();
  const displayName = identity.email.slice(0, 160);

  // Each batch is atomic in D1. The fresh marker ties device creation to THIS
  // successful claim, never a previous request or another still-pending session.
  // Existing rows are skipped by explicit NOT EXISTS guards, not INSERT OR IGNORE:
  // OR IGNORE also swallows CHECK failures, which would commit a partial account.
  const claimId = crypto.randomUUID();
  try {
    const results = await registry.batch([
      registry.prepare(`
        INSERT INTO users (user_id, display_name, status, created_at)
        SELECT ?, ?, 'active', ?
        WHERE EXISTS (
          SELECT 1 FROM pairing_sessions WHERE ${eligible}
        )
        AND NOT EXISTS (SELECT 1 FROM users WHERE user_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM user_identities WHERE issuer = ? AND subject = ?
            AND (owner_id <> ? OR status <> 'active')
        )
        AND NOT EXISTS (
          SELECT 1 FROM devices WHERE owner_id = ? AND status = 'active' AND revoked_at IS NULL
        )
      `).bind(ownerId, displayName, nowIso, ...consentValues, ownerId,
        identity.issuer, identity.subject, ownerId, ownerId),
      registry.prepare(`
        INSERT INTO user_identities
          (issuer, subject, owner_id, email, status, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'active', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM pairing_sessions WHERE ${eligible}
        )
        AND EXISTS (SELECT 1 FROM users WHERE user_id = ? AND status = 'active')
        AND NOT EXISTS (SELECT 1 FROM user_identities WHERE issuer = ? AND subject = ?)
        AND NOT EXISTS (
          SELECT 1 FROM devices WHERE owner_id = ? AND status = 'active' AND revoked_at IS NULL
        )
      `).bind(identity.issuer, identity.subject, ownerId, identity.email, nowIso, nowIso,
        ...consentValues, ownerId, identity.issuer, identity.subject, ownerId),
      registry.prepare(`
        UPDATE pairing_sessions
        SET status = 'claimed', claimed_at_ms = ?, claim_id = ?, owner_id = ?
        WHERE ${eligible}
          AND EXISTS (SELECT 1 FROM users WHERE user_id = ? AND status = 'active')
          AND EXISTS (
            SELECT 1 FROM user_identities WHERE issuer = ? AND subject = ?
              AND owner_id = ? AND status = 'active'
          )
          AND NOT EXISTS (
            SELECT 1 FROM devices WHERE owner_id = ? AND status = 'active' AND revoked_at IS NULL
          )
        RETURNING device_id
      `).bind(now, claimId, ownerId, ...consentValues, ownerId,
        identity.issuer, identity.subject, ownerId, ownerId),
      registry.prepare(`
        INSERT INTO devices
          (device_id, owner_id, agent_public_key_b64, status, terminal_enabled, created_at)
        SELECT device_id, owner_id, agent_public_key_b64, 'active', 0, ?
        FROM pairing_sessions
        WHERE consent_hash = ? AND claim_id = ? AND status = 'claimed' AND owner_id = ?
        RETURNING device_id
      `).bind(nowIso, consentHash, claimId, ownerId),
    ]);
    if (results.length !== 4 || !results.every(result => result.success === true)) return null;
    const claimRows = results[2].results as Array<{ device_id?: unknown }> | undefined;
    const deviceRows = results[3].results as Array<{ device_id?: unknown }> | undefined;
    const deviceId = deviceRows?.length === 1 && isBetaDeviceId(deviceRows[0]?.device_id)
      ? deviceRows[0].device_id : null;
    return deviceId && claimRows?.length === 1 && claimRows[0]?.device_id === deviceId
      ? { ownerId, deviceId } : null;
  } catch {
    // Insert/unique-key failure rolls back the WHOLE batch, including the claim.
    // Response delivery can still fail after commit; recover using signed device status.
    return null;
  }
}

export async function pairingPreview(
  registry: D1DatabaseLike,
  code: string,
  identity: PairIdentity,
  now = Date.now(),
): Promise<{ deviceId: string; fingerprint: string; consent: string } | null> {
  if (!PAIR_CODE_PATTERN.test(code) || !Number.isSafeInteger(now) || !validIdentity(identity)) return null;
  const codeHash = await hashBearerToken(code);
  const consent = `ac1_${randomHex(32)}`;
  const consentHash = await hashBearerToken(consent);
  // UPDATE ... RETURNING consumes the code once, including under simultaneous
  // authenticated reviewers. No user/identity/device exists until confirmation.
  const row = await registry.prepare(`
    UPDATE pairing_sessions
    SET claim_code_hash = NULL, consent_hash = ?, consent_issuer = ?, consent_subject = ?,
      consent_email = ?, consent_scope = 'files-v1', consent_created_at_ms = ?,
      consent_device_id = device_id, consent_agent_public_key_b64 = agent_public_key_b64,
      consent_expires_at_ms = MIN(expires_at_ms, ?)
    WHERE claim_code_hash = ? AND consent_hash IS NULL AND status = 'pending'
      AND created_at_ms <= ? AND created_at_ms + ? > ? AND expires_at_ms > ?
    RETURNING device_id, agent_public_key_b64, status, expires_at_ms, owner_id
  `).bind(consentHash, identity.issuer, identity.subject, identity.email, now, now + PAIR_CLAIM_TTL_MS,
    codeHash, now, PAIR_CLAIM_TTL_MS, now, now).first<PairRow>();
  if (!row || !isBetaDeviceId(row.device_id) || !canonicalAgentKey(row.agent_public_key_b64)
    || !Number.isSafeInteger(row.expires_at_ms) || row.expires_at_ms <= now) return null;
  const keyBytes = canonicalAgentKey(row.agent_public_key_b64)!;
  const digest = await crypto.subtle.digest("SHA-256", keyBytes);
  const fingerprint = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { deviceId: row.device_id, fingerprint, consent };
}

// Mirrors the user_identities CHECKs (0004), so review never issues a confirmation
// that the claim batch cannot store. SQLite length() counts code points and stops
// at NUL, hence code-point counting and no control characters.
function boundedText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const length = [...value].length;
  return length >= min && length <= max;
}

function validIdentity(identity: PairIdentity): boolean {
  return !!identity && boundedText(identity.issuer, 1, 512) && exactHttpsOrigin(identity.issuer)
    && boundedText(identity.subject, 1, 512) && boundedText(identity.email, 3, 320);
}

export async function pairingStatus(
  registry: D1DatabaseLike,
  secret: string,
  now = Date.now(),
): Promise<{ status: "pending" | "claimed" | "cancelled" | "expired"; deviceId: string } | null> {
  if (!PAIR_SECRET_PATTERN.test(secret) || !Number.isSafeInteger(now)) return null;
  const secretHash = await hashBearerToken(secret);
  const row = await registry.prepare(`
    SELECT device_id, agent_public_key_b64, status, expires_at_ms, owner_id,
      EXISTS (
        SELECT 1 FROM devices d JOIN users u ON u.user_id = d.owner_id
        JOIN user_identities i ON i.owner_id = u.user_id
        WHERE d.device_id = pairing_sessions.device_id AND d.owner_id = pairing_sessions.owner_id
          AND d.agent_public_key_b64 = pairing_sessions.agent_public_key_b64
          AND d.status = 'active' AND d.revoked_at IS NULL AND u.status = 'active'
          AND i.issuer = pairing_sessions.consent_issuer AND i.subject = pairing_sessions.consent_subject
          AND i.status = 'active'
      ) AS active_binding
    FROM pairing_sessions
    WHERE secret_hash = ?
    LIMIT 1
  `).bind(secretHash).first<PairRow & { active_binding: number }>();
  if (!row || !isBetaDeviceId(row.device_id)) return null;
  if (row.expires_at_ms <= now) return { status: "expired", deviceId: row.device_id };
  if (row.status === 'claimed' && row.active_binding !== 1) return { status: 'cancelled', deviceId: row.device_id };
  return { status: row.status, deviceId: row.device_id };
}
