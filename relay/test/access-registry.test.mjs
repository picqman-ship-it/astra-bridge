import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { resolveAccessIdentityDevice } from "../.test-tmp/access-registry.mjs";
import { createPairingSession, pairingPreview, claimPairingSession } from "../.test-tmp/pairing.mjs";
import { sqliteRegistry } from "./enrollment-sqlite.mjs";

const DEVICE = "beta-11111111-2222-4333-8444-555555555555";

function fakeRegistry(row) {
  const calls = [];
  const statement = {
    bind: (...values) => {
      calls.push({ type: "bind", values });
      return statement;
    },
    first: async () => row,
    run: async () => ({ success: true }),
  };
  return {
    calls,
    registry: {
      prepare: (sql) => {
        calls.push({ type: "prepare", sql });
        return statement;
      },
    },
  };
}

test("resolves one active identity to one beta device", async () => {
  const { registry, calls } = fakeRegistry({
    owner_id: "user-01",
    device_id: DEVICE,
    terminal_enabled: 1,
    gui_enabled: 0,
  });
  assert.deepEqual(
    await resolveAccessIdentityDevice(
      registry,
      "https://team.cloudflareaccess.com",
      "subject-01",
    ),
    { ownerId: "user-01", deviceId: DEVICE, terminalEnabled: true, guiEnabled: false },
  );
  assert.deepEqual(
    calls.find((entry) => entry.type === "bind").values,
    ["https://team.cloudflareaccess.com", "subject-01"],
  );
});

test("file-only identity resolves without control permission", async () => {
  const { registry } = fakeRegistry({
    owner_id: "user-02",
    device_id: DEVICE,
    terminal_enabled: 0,
    gui_enabled: 0,
  });
  assert.deepEqual(
    await resolveAccessIdentityDevice(registry, "issuer", "subject"),
    { ownerId: "user-02", deviceId: DEVICE, terminalEnabled: false, guiEnabled: false },
  );
});

test("invalid identity inputs fail before touching D1", async () => {
  for (const [issuer, subject] of [
    ["", "subject"],
    ["issuer", ""],
    ["x".repeat(513), "subject"],
    ["issuer", "x".repeat(513)],
  ]) {
    const { registry, calls } = fakeRegistry(null);
    assert.equal(await resolveAccessIdentityDevice(registry, issuer, subject), null);
    assert.deepEqual(calls, []);
  }
});

test("a subject accepted by pairing at the SQLite code-point limit routes to its Mac", async t => {
  const { db, registry } = sqliteRegistry();
  t.after(() => db.close());
  const identity = {
    issuer: "https://team.cloudflareaccess.com",
    subject: "😀".repeat(512),
    email: "alice@example.com",
  };
  const agentPublicKeyB64 = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "der" }).toString("base64");
  const now = Date.now();
  const session = await createPairingSession(registry, {
    requestId: randomUUID(), deviceId: DEVICE, agentPublicKeyB64,
  }, now);
  const review = await pairingPreview(registry, session.claimCode, identity, now);
  assert.ok(review);
  const claimed = await claimPairingSession(registry, review.consent, identity, now);
  assert.ok(claimed);
  assert.equal(db.prepare("SELECT length(subject) n FROM user_identities").get().n, 512);
  assert.deepEqual(await resolveAccessIdentityDevice(registry, identity.issuer, identity.subject), {
    ownerId: claimed.ownerId, deviceId: DEVICE, terminalEnabled: false, guiEnabled: false,
  });
});

test("invalid or non-beta rows fail closed", async () => {
  for (const row of [
    null,
    { owner_id: "", device_id: DEVICE, terminal_enabled: 1, gui_enabled: 0 },
    { owner_id: "user", device_id: "personal-mac", terminal_enabled: 1, gui_enabled: 0 },
    { owner_id: "user", device_id: DEVICE, terminal_enabled: 2, gui_enabled: 0 },
    { owner_id: "user", device_id: DEVICE, terminal_enabled: 0, gui_enabled: 2 },
  ]) {
    const { registry } = fakeRegistry(row);
    assert.equal(await resolveAccessIdentityDevice(registry, "issuer", "subject"), null);
  }
});

test("identity code-point overflow and control characters fail before touching D1", async () => {
  for (const value of ["😀".repeat(513), "a\u0000b", "a\u001fb", "a\u007fb", null, undefined, 42]) {
    for (const [issuer, subject] of [[value, "subject"], ["issuer", value]]) {
      const { registry, calls } = fakeRegistry(null);
      assert.equal(await resolveAccessIdentityDevice(registry, issuer, subject), null);
      assert.deepEqual(calls, []);
    }
  }
});

test("issuer and subject use the same SQLite code-point bound", async () => {
  const { registry, calls } = fakeRegistry({
    owner_id: "user-03", device_id: DEVICE, terminal_enabled: 0, gui_enabled: 0,
  });
  const issuer = "😀".repeat(512);
  const subject = "😀".repeat(512);
  assert.ok(await resolveAccessIdentityDevice(registry, issuer, subject));
  assert.deepEqual(calls.find(entry => entry.type === "bind").values, [issuer, subject]);
});

test("query requires one active device and active identity/user/device state", async () => {
  const { registry, calls } = fakeRegistry(null);
  await resolveAccessIdentityDevice(registry, "issuer", "subject");
  const sql = calls.find((entry) => entry.type === "prepare").sql;
  assert.match(sql, /i\.status = 'active'/);
  assert.match(sql, /u\.status = 'active'/);
  assert.match(sql, /d\.status = 'active'/);
  assert.match(sql, /COUNT\(\*\)/);
  assert.match(sql, /= 1/);
});
