#!/usr/bin/env node
// Offline operator helper: produces reviewable SQL; never contacts Cloudflare.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRelayUrl } from "../../installer/lib/validate.mjs";

const opaque = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const betaDevice = /^beta-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = value => createHash("sha256").update(value).digest("hex");
export function createInvite({ ownerId, ttlSeconds = 3600, now = Date.now() }) {
  if (!opaque.test(ownerId ?? "") || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400
    || !Number.isSafeInteger(now)) throw new Error("invalid invite options");
  const token = `abi1_${randomBytes(32).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const expiresAt = now + ttlSeconds * 1000;
  // Owner id and hash are strictly validated before interpolation. No secret in SQL.
  const sql = `INSERT INTO enrollment_invites (invite_hash, owner_id, created_at_ms, expires_at_ms)
SELECT '${hash}', user_id, ${now}, ${expiresAt} FROM users
WHERE user_id = '${ownerId}' AND status = 'active'
RETURNING invite_hash, owner_id, expires_at_ms;\n`;
  return { token, hash, expiresAt, sql };
}

export function revokeInvite({ ownerId, hash, now = Date.now() }) {
  if (!opaque.test(ownerId ?? "") || !/^[a-f0-9]{64}$/.test(hash ?? "") || !Number.isSafeInteger(now)) throw new Error("invalid revoke options");
  return `UPDATE enrollment_invites SET revoked_at_ms = ${now}
WHERE invite_hash = '${hash}' AND owner_id = '${ownerId}' AND revoked_at_ms IS NULL
RETURNING invite_hash, owner_id, redeemed_at_ms, redeemed_device_id;
UPDATE devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, '${new Date(now).toISOString()}')
WHERE owner_id = '${ownerId}' AND device_id IN
  (SELECT redeemed_device_id FROM enrollment_invites WHERE invite_hash = '${hash}' AND owner_id = '${ownerId}' AND revoked_at_ms IS NOT NULL)
RETURNING device_id, agent_public_key_b64, status;
UPDATE access_tokens SET status = 'revoked', revoked_at = COALESCE(revoked_at, '${new Date(now).toISOString()}')
WHERE owner_id = '${ownerId}' AND device_id IN
  (SELECT redeemed_device_id FROM enrollment_invites WHERE invite_hash = '${hash}' AND owner_id = '${ownerId}' AND revoked_at_ms IS NOT NULL)
RETURNING device_id, status;\n`;
}

export function inspectInvite({ ownerId, hash }) {
  if (!opaque.test(ownerId ?? "") || !/^[a-f0-9]{64}$/.test(hash ?? "")) throw new Error("invalid inspection options");
  return `SELECT i.invite_hash, i.owner_id, i.redeemed_at_ms, i.redeemed_device_id, i.revoked_at_ms,
d.agent_public_key_b64, d.status AS device_status FROM enrollment_invites i
LEFT JOIN devices d ON d.device_id = i.redeemed_device_id AND d.owner_id = i.owner_id
WHERE i.invite_hash = '${hash}' AND i.owner_id = '${ownerId}';
SELECT device_id, agent_public_key_b64, status FROM devices WHERE owner_id = '${ownerId}';\n`;
}

/** Consumes a single inspection row, plus tester-confirmed identity. Never selects by owner alone.
 * Rechecks the exact row/key at execution and refuses any unexpected active device.
 */
export function authorizeConnector({ record, deviceId, fingerprint, now = Date.now() }) {
  if (!record || !opaque.test(record.owner_id ?? "") || !/^[a-f0-9]{64}$/.test(record.invite_hash ?? "")
    || !betaDevice.test(deviceId ?? "") || deviceId !== record.redeemed_device_id
    || !Number.isSafeInteger(record.redeemed_at_ms) || record.revoked_at_ms !== null || record.device_status !== "active"
    || !/^[A-Za-z0-9+/]{59}=$/.test(record.agent_public_key_b64 ?? "") || !/^[a-f0-9]{64}$/.test(fingerprint ?? "")
    || sha256(Buffer.from(record.agent_public_key_b64, "base64")) !== fingerprint || !Number.isSafeInteger(now)) {
    throw new Error("confirmed identity does not match redeemed invite");
  }
  const token = `abm1_${randomBytes(32).toString("hex")}`;
  const sql = `INSERT INTO access_tokens (token_hash, owner_id, device_id, label, status, expires_at, created_at)
SELECT '${sha256(token)}', i.owner_id, i.redeemed_device_id, 'confirmed-beta-connector', 'active',
'${new Date(now + 7 * 86400000).toISOString()}', '${new Date(now).toISOString()}'
FROM enrollment_invites i JOIN devices d ON d.device_id = i.redeemed_device_id AND d.owner_id = i.owner_id
JOIN users u ON u.user_id = i.owner_id
WHERE i.invite_hash = '${record.invite_hash}' AND i.owner_id = '${record.owner_id}'
AND i.redeemed_device_id = '${deviceId}' AND i.redeemed_at_ms = ${record.redeemed_at_ms} AND i.revoked_at_ms IS NULL
AND d.agent_public_key_b64 = '${record.agent_public_key_b64}' AND d.status = 'active' AND d.revoked_at IS NULL
AND u.status = 'active' AND d.terminal_enabled = 0
AND NOT EXISTS (SELECT 1 FROM devices other WHERE other.owner_id = i.owner_id AND other.device_id != d.device_id AND other.status = 'active' AND other.revoked_at IS NULL)
RETURNING owner_id, device_id;\n`;
  return { token, sql, ownerId: record.owner_id, deviceId, fingerprint };
}

export function revokeDevice({ ownerId, deviceId, now = Date.now() }) {
  if (!opaque.test(ownerId ?? "") || !betaDevice.test(deviceId ?? "") || !Number.isSafeInteger(now)) throw new Error("invalid device revoke options");
  return `UPDATE devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, '${new Date(now).toISOString()}') WHERE owner_id = '${ownerId}' AND device_id = '${deviceId}' RETURNING device_id, agent_public_key_b64, status;
UPDATE access_tokens SET status = 'revoked', revoked_at = COALESCE(revoked_at, '${new Date(now).toISOString()}') WHERE owner_id = '${ownerId}' AND device_id = '${deviceId}' RETURNING device_id, status;\n`;
}

function safeOutputDirectory(out) {
  const target = path.resolve(out);
  const parent = fs.realpathSync(path.dirname(target));
  const repo = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
  if (parent === repo || parent.startsWith(repo + path.sep)) throw new Error("output inside repository");
  // Also refuse other git checkouts, including worktrees and symlinked parents.
  for (let dir = parent;; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) throw new Error("output inside git checkout");
    if (dir === path.dirname(dir)) break;
  }
  return path.join(parent, path.basename(target));
}

export function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv;
    const opts = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!["--owner", "--out", "--ttl-seconds", "--hash", "--relay-origin", "--record", "--device-id", "--fingerprint"].includes(rest[i]) || !rest[i + 1]
        || Object.hasOwn(opts, rest[i])) throw new Error("invalid options");
      opts[rest[i]] = rest[i + 1];
    }
    if (!opts["--out"]) throw new Error("output directory required");
    opts["--out"] = safeOutputDirectory(opts["--out"]);
    let sql, token, artifact, connector;
    if (command === "create" && !opts["--hash"]) {
      const relayOrigin = normalizeRelayUrl(opts["--relay-origin"]);
      ({ sql, token } = createInvite({ ownerId: opts["--owner"], ttlSeconds: opts["--ttl-seconds"] === undefined ? 3600 : Number(opts["--ttl-seconds"]) }));
      artifact = JSON.stringify({ version: 1, relayOrigin, invite: token }) + "\n";
    } else if (command === "revoke" && !opts["--ttl-seconds"]) {
      sql = revokeInvite({ ownerId: opts["--owner"], hash: opts["--hash"] });
    } else if (command === "inspect") {
      sql = inspectInvite({ ownerId: opts["--owner"], hash: opts["--hash"] });
    } else if (command === "revoke-device") {
      sql = revokeDevice({ ownerId: opts["--owner"], deviceId: opts["--device-id"] });
    } else if (command === "authorize") {
      connector = authorizeConnector({ record: JSON.parse(fs.readFileSync(opts["--record"], "utf8")),
        deviceId: opts["--device-id"], fingerprint: opts["--fingerprint"] });
      sql = connector.sql;
    } else throw new Error("invalid command");
    // A fresh directory prevents accidental overwrite or following an output symlink.
    fs.mkdirSync(opts["--out"], { mode: 0o700 });
    fs.writeFileSync(path.join(opts["--out"], "registry.sql"), sql, { mode: 0o600, flag: "wx" });
    if (artifact) fs.writeFileSync(path.join(opts["--out"], "invite.json"), artifact, { mode: 0o600, flag: "wx" });
    if (connector) {
      const { ownerId, deviceId, fingerprint, token: bearer } = connector;
      fs.writeFileSync(path.join(opts["--out"], "connector-token.json"),
        JSON.stringify({ version: 1, ownerId, deviceId, agentFingerprintSha256: fingerprint, bearer }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      process.stdout.write(`Connector bound owner: ${ownerId}; device: ${deviceId}; agent SHA-256: ${fingerprint}. Deliver only to the tester who confirmed this exact identity.\n`);
    }
    process.stdout.write("Prepared offline SQL. No database changes made. Review registry.sql on the operator machine. Issuance requires exactly one returned identity row before secret delivery. Consumed invite revocation also revokes its redeemed device and connector tokens; verify every result.\n");
    return 0;
  } catch {
    process.stderr.write("Invite preparation failed. Commands: create --owner ID --relay-origin HTTPS_ORIGIN [--ttl-seconds 3600]; inspect/revoke --owner ID --hash SHA256; authorize --record INSPECTION_ROW_JSON --device-id ID --fingerprint SHA256; revoke-device --owner ID --device-id ID. All require --out NEW_DIR. Secrets are never accepted in argv.\n");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
