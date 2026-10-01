import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { sqliteRegistry } from "./enrollment-sqlite.mjs";
import {
  PAIR_TTL_MS,
  claimPairingSession,
  createPairingSession,
  pairingPreview,
  pairingProofMessage,
  pairingStatus,
  validatePairStart,
} from "../.test-tmp/pairing.mjs";
import { resolveAccessIdentityDevice } from "../.test-tmp/access-registry.mjs";

const ORIGIN = "https://relay.example";
const NOW = 1_800_000_000_000;
const DEVICE = "beta-11111111-2222-4333-8444-555555555555";

async function registration({ deviceId = DEVICE, requestId = randomUUID(), keys = generateKeyPairSync("ed25519") } = {}) {
  const agentPublicKeyB64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const message = await pairingProofMessage(ORIGIN, requestId, deviceId, agentPublicKeyB64);
  const proof = sign(null, Buffer.from(message), keys.privateKey).toString("base64");
  return {
    keys,
    body: { version: 1, requestId, deviceId, agentPublicKeyB64, proof },
  };
}

test("pair-start proof validates possession of the exact Mac key and context", async () => {
  const { body } = await registration();
  assert.deepEqual(await validatePairStart(body, ORIGIN), body);
  assert.equal(await validatePairStart({ ...body, deviceId: "beta-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, ORIGIN), null);
  assert.equal(await validatePairStart({ ...body, requestId: randomUUID() }, ORIGIN), null);
  assert.equal(await validatePairStart({ ...body, extra: true }, ORIGIN), null);
  assert.equal(await validatePairStart(body, "http://relay.example"), null);
});

test("one-time pairing stores only the secret hash, claims one file-only Mac, and routes the identity", async () => {
  const { db, registry } = sqliteRegistry();
  db.exec("PRAGMA foreign_keys = ON");
  const { body } = await registration();
  const valid = await validatePairStart(body, ORIGIN);
  const session = await createPairingSession(registry, valid, NOW);
  assert.ok(session);
  assert.equal(session.deviceId, DEVICE);
  assert.equal(session.expiresAtMs, NOW + PAIR_TTL_MS);

  const stored = db.prepare("SELECT * FROM pairing_sessions").get();
  assert.equal(stored.device_id, DEVICE);
  assert.equal(stored.status, "pending");
  assert.notEqual(stored.secret_hash, session.secret);
  assert.equal(JSON.stringify(stored).includes(session.secret), false);

  const preview = await pairingPreview(registry, session.secret, NOW + 1);
  assert.equal(preview.deviceId, DEVICE);
  assert.equal(preview.status, "pending");
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);

  const identity = {
    issuer: "https://team.cloudflareaccess.com",
    subject: "subject-01",
    email: "tester@example.com",
  };
  const claimed = await claimPairingSession(registry, session.secret, identity, NOW + 2);
  assert.ok(claimed);
  assert.equal(claimed.deviceId, DEVICE);

  const device = db.prepare("SELECT owner_id, terminal_enabled, status FROM devices WHERE device_id = ?").get(DEVICE);
  assert.equal(device.owner_id, claimed.ownerId);
  assert.equal(device.terminal_enabled, 0);
  assert.equal(device.status, "active");

  assert.deepEqual(
    await resolveAccessIdentityDevice(registry, identity.issuer, identity.subject),
    { ownerId: claimed.ownerId, deviceId: DEVICE, terminalEnabled: false },
  );
  assert.deepEqual(await pairingStatus(registry, session.secret, NOW + 3), { status: "claimed", deviceId: DEVICE });

  const identityRow = db.prepare("SELECT issuer, subject, owner_id, email, status FROM user_identities").get();
  assert.equal(identityRow.issuer, identity.issuer);
  assert.equal(identityRow.subject, identity.subject);
  assert.equal(identityRow.owner_id, claimed.ownerId);
  assert.equal(identityRow.email, identity.email);
  assert.equal(identityRow.status, "active");

  db.close();
});

test("one identity cannot silently acquire a second active Mac", async () => {
  const { db, registry } = sqliteRegistry();
  const identity = {
    issuer: "https://team.cloudflareaccess.com",
    subject: "subject-02",
    email: "tester2@example.com",
  };

  const first = await registration({ deviceId: "beta-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
  const firstSession = await createPairingSession(registry, await validatePairStart(first.body, ORIGIN), NOW);
  assert.ok(await claimPairingSession(registry, firstSession.secret, identity, NOW + 1));

  const second = await registration({ deviceId: "beta-01234567-89ab-4cde-8f01-23456789abcd" });
  const secondSession = await createPairingSession(registry, await validatePairStart(second.body, ORIGIN), NOW + 2);
  assert.ok(secondSession);
  assert.equal(await claimPairingSession(registry, secondSession.secret, identity, NOW + 3), null);
  assert.equal((db.prepare("SELECT count(*) AS n FROM devices WHERE status = 'active'").get()).n, 1);
  assert.deepEqual(await pairingStatus(registry, secondSession.secret, NOW + 4), {
    status: "pending",
    deviceId: second.body.deviceId,
  });
  db.close();
});

test("expired, invalid and replayed pairing material fails closed", async () => {
  const { db, registry } = sqliteRegistry();
  const { body } = await registration();
  const session = await createPairingSession(registry, await validatePairStart(body, ORIGIN), NOW);
  assert.ok(session);

  assert.deepEqual(await pairingStatus(registry, session.secret, NOW + PAIR_TTL_MS), {
    status: "expired",
    deviceId: DEVICE,
  });
  assert.equal(await pairingPreview(registry, session.secret, NOW + PAIR_TTL_MS), null);
  assert.equal(await claimPairingSession(registry, session.secret, {
    issuer: "https://team.cloudflareaccess.com",
    subject: "subject-expired",
    email: "expired@example.com",
  }, NOW + PAIR_TTL_MS), null);

  assert.equal(await createPairingSession(registry, body, NOW + 10), null, "same request id must not create a second session");

  const retry = await registration({ deviceId: DEVICE });
  const retried = await createPairingSession(registry, await validatePairStart(retry.body, ORIGIN), NOW + PAIR_TTL_MS + 1);
  assert.ok(retried, "a fresh signed request may retry the same still-unpaired Mac after expiry");
  assert.notEqual(retried.secret, session.secret);

  assert.equal(await pairingStatus(registry, "ap1_" + "0".repeat(64), NOW), null);
  db.close();
});
