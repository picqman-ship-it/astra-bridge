import { hashBearerToken, type D1DatabaseLike } from "./beta-registry";
import { isBetaDeviceId } from "./beta-identity";
import { canonicalAgentKey, canonicalSignature } from "./ed25519-validation";
import { betaRateGate, type BetaRateEnv } from "./beta-rate-limit";
import { BodyTooLargeError, readBoundedBody } from "./bounded-body";

export const INVITE_PATTERN = /^abi1_[a-f0-9]{64}$/;
export const MAX_ENROLLMENT_BODY = 1024;
export type DeviceRegistration = { version: 1; deviceId: string; agentPublicKeyB64: string; proof: string };

/** Versioned, domain-separated proof: exact UTF-8 lines, no trailing newline. */
export async function enrollmentProofMessage(origin: string, invite: string, deviceId: string, key: string): Promise<string> {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:" || !INVITE_PATTERN.test(invite)) throw new Error("invalid_proof_context");
  return ["astra-beta-enroll-v1", origin, await hashBearerToken(invite), deviceId, key].join("\n");
}

/** Only canonical Ed25519 SPKI public keys; no PEM, private keys or extra fields. */
export async function validateRegistration(value: unknown, origin: string, invite: string): Promise<DeviceRegistration | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "agentPublicKeyB64,deviceId,proof,version" || row.version !== 1 || !isBetaDeviceId(row.deviceId)
    || typeof row.proof !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(row.proof)
    || typeof row.agentPublicKeyB64 !== "string" || !/^[A-Za-z0-9+/]{59}=$/.test(row.agentPublicKeyB64)) return null;
  try {
    const bytes = canonicalAgentKey(row.agentPublicKeyB64);
    if (!bytes) return null;
    const signature = Uint8Array.from(atob(row.proof), c => c.charCodeAt(0));
    if (btoa(String.fromCharCode(...signature)) !== row.proof || !canonicalSignature(signature)) return null;
    const key = await crypto.subtle.importKey("spki", bytes, "Ed25519", false, ["verify"]);
    const message = await enrollmentProofMessage(origin, invite, row.deviceId, row.agentPublicKeyB64);
    if (!await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(message))) return null;
    return { version: 1, deviceId: row.deviceId, agentPublicKeyB64: row.agentPublicKeyB64, proof: row.proof };
  } catch { return null; }
}

/** Authorization is an opaque grant; device identity remains an independent key/id pair.
 * No read-then-write decision: D1 batch is one transaction, including rollback on insert failure.
 * The unique per-attempt marker prevents a losing request from inserting from a previous claim.
 */
export async function redeemEnrollmentInvite(
  registry: D1DatabaseLike, invite: string, registration: unknown,
  reservedDeviceIds: readonly string[], now = Date.now(), origin = "",
): Promise<boolean> {
  if (!INVITE_PATTERN.test(invite) || !registry.batch || !Number.isSafeInteger(now)) return false;
  const device = await validateRegistration(registration, origin, invite);
  if (!device || reservedDeviceIds.includes(device.deviceId)) return false;
  const hash = await hashBearerToken(invite);
  const redemptionId = crypto.randomUUID();
  const results = await registry.batch([
    registry.prepare(`UPDATE enrollment_invites
      SET redeemed_at_ms = ?, redeemed_device_id = ?, redemption_id = ?
      WHERE invite_hash = ? AND revoked_at_ms IS NULL AND redeemed_at_ms IS NULL
        AND created_at_ms <= ? AND expires_at_ms > ?
        AND EXISTS (SELECT 1 FROM users WHERE user_id = enrollment_invites.owner_id AND status = 'active')
      RETURNING owner_id`).bind(now, device.deviceId, redemptionId, hash, now, now),
    registry.prepare(`INSERT INTO devices
      (device_id, owner_id, agent_public_key_b64, status, terminal_enabled, created_at)
      SELECT redeemed_device_id, owner_id, ?, 'active', 0, ? FROM enrollment_invites
      WHERE invite_hash = ? AND redemption_id = ? AND revoked_at_ms IS NULL
      RETURNING device_id`).bind(device.agentPublicKeyB64, new Date(now).toISOString(), hash, redemptionId),
  ]);
  return results.length === 2 && results.every(r => r.success)
    && results[0].results?.length === 1 && results[1].results?.length === 1;
}

type EnrollmentEnv = BetaRateEnv & {
  BETA_REGISTRY_ENABLED?: string;
  BETA_ENROLLMENT_ENABLED?: string;
  BETA_REGISTRY?: D1DatabaseLike;
  AGENT_DEVICE_ID?: string;
  CLIENT_DEVICE_ID?: string;
  MCP_DEVICE_ID?: string;
};

/** Exact route only; authorization secret is accepted solely in an HTTPS Authorization header. */
export async function handleEnrollment(request: Request, env: EnrollmentEnv): Promise<Response> {
  const reply = (status: number, ok = false) => Response.json(ok ? { ok: true } : { error: "enrollment_denied" }, {
    status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
  if (env.BETA_REGISTRY_ENABLED !== "true" || env.BETA_ENROLLMENT_ENABLED !== "true" || !env.BETA_REGISTRY?.batch) return reply(404);
  const limited = await betaRateGate(request, env, "enroll");
  if (limited) return limited;
  const url = new URL(request.url);
  if (request.method !== "POST" || url.protocol !== "https:" || url.search
    || request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return reply(400);
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !INVITE_PATTERN.test(auth.slice(7))) return reply(401);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ENROLLMENT_BODY)) return reply(413);
  try {
    if (!request.body) return reply(400);
    const bytes = await readBoundedBody(request.body, MAX_ENROLLMENT_BODY);
    const registration: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    const ok = await redeemEnrollmentInvite(env.BETA_REGISTRY, auth.slice(7), registration,
      [env.AGENT_DEVICE_ID, env.CLIENT_DEVICE_ID, env.MCP_DEVICE_ID].filter((v): v is string => typeof v === "string"), Date.now(), url.origin);
    return reply(ok ? 201 : 403, ok);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return reply(413);
    // Never reflect D1 errors, bodies, headers, or invite material, even in logs.
    return reply(403);
  }
}
