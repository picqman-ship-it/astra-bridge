import "./source-loader.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { generateKeyPairSync } from "node:crypto";
import { sqliteRegistry } from "./enrollment-sqlite.mjs";
import { createInvite, revokeInvite } from "../scripts/beta-invite.mjs";
import { betaId, rateBindings, signEnrollment, ORIGIN } from "./beta-test-helpers.mjs";
const { redeemEnrollmentInvite: redeem, handleEnrollment, validateRegistration, MAX_ENROLLMENT_BODY } = await import("../src/beta-enrollment.ts");
const { hashBearerToken, resolveActiveBetaDevice, resolveBetaBearerHash, isToolAllowedForPrincipal } = await import("../src/beta-registry.ts");
const { resolveAgentAuthentication } = await import("../src/agent-auth.ts");

const NOW = 1_800_000_000_000;
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const registration = { deviceId: betaId("mac-a"), agentPublicKeyB64: publicKey };
const signed = (invite, value) => ({ ...signEnrollment(ORIGIN, invite, value.deviceId, value.agentPublicKeyB64, keys.privateKey), ...value });
const redeemEnrollmentInvite = (db, invite, value, reserved, now) => redeem(db, invite, signed(invite, value), reserved, now, ORIGIN);
function fixture(t, file) {
  const { db, registry } = sqliteRegistry(file);
  t.after(() => db.close());
  for (const id of ["alice", "bob"]) db.prepare("INSERT INTO users VALUES (?, ?, 'active', ?)").run(id, id, new Date(NOW).toISOString());
  const invite = createInvite({ ownerId: "alice", now: NOW });
  db.exec(invite.sql);
  return { db, registry, invite };
}
function env(registry) {
  return { ...rateBindings(), BETA_REGISTRY: registry, BETA_REGISTRY_ENABLED: "true", BETA_ENROLLMENT_ENABLED: "true",
    AGENT_DEVICE_ID: "personal-agent", CLIENT_DEVICE_ID: "personal-client", MCP_DEVICE_ID: "personal-mcp" };
}
function request(invite, body = registration, overrides = {}) {
  return new Request("https://relay.example/beta/enroll", {
    method: "POST", headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
    body: JSON.stringify(body ? signed(invite, body) : body), ...overrides,
  });
}

test("success registers only public material for the grant owner; file-only and no MCP bearer minted", async t => {
  const { db, registry, invite } = fixture(t);
  assert.equal(await redeemEnrollmentInvite(registry, invite.token, registration, [], NOW), true);
  const device = await resolveActiveBetaDevice(registry, registration.deviceId);
  assert.equal(device.ownerId, "alice");
  assert.equal(device.agentPublicKeyB64, publicKey);
  assert.equal(device.terminalEnabled, false);
  for (const name of ["start_process", "job_start", "list_windows", "inspect_ui", "press_element", "set_element_value"]) {
    assert.equal(isToolAllowedForPrincipal(name, device), false, name);
  }
  assert.equal(isToolAllowedForPrincipal("read_file", device), true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM access_tokens").get().n, 0);
  assert.equal(await resolveBetaBearerHash(registry, await hashBearerToken(invite.token), NOW), null);
  const row = db.prepare("SELECT * FROM enrollment_invites").get();
  assert.equal(row.invite_hash, invite.hash);
  assert.ok(!JSON.stringify(row).includes(invite.token));
});

for (const [name, mutate, time] of [
  ["expiry at exact boundary", () => {}, NOW + 3600000],
  ["expiry after boundary", () => {}, NOW + 3600001],
  ["not yet valid", () => {}, NOW - 1],
  ["revoked", (db, invite) => db.exec(revokeInvite({ ownerId: "alice", hash: invite.hash, now: NOW })), NOW],
  ["disabled user", db => db.exec("UPDATE users SET status = 'disabled' WHERE user_id = 'alice'"), NOW],
  ["revoked user", db => db.exec("UPDATE users SET status = 'revoked' WHERE user_id = 'alice'"), NOW],
]) test(`${name} fails closed without inserting a device`, async t => {
  const { db, registry, invite } = fixture(t);
  mutate(db, invite);
  assert.equal(await redeemEnrollmentInvite(registry, invite.token, registration, [], time), false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM devices").get().n, 0);
});

test("same and different-device replays fail; no state reset", async t => {
  const { registry, invite } = fixture(t);
  assert.equal(await redeemEnrollmentInvite(registry, invite.token, registration, [], NOW), true);
  assert.equal(await redeemEnrollmentInvite(registry, invite.token, registration, [], NOW), false);
  assert.equal(await redeemEnrollmentInvite(registry, invite.token, { ...registration, deviceId: "other" }, [], NOW), false);
});

test("parallel double-use across independent SQLite connections consumes invite exactly once", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-enrollment-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "registry.sqlite");
  const { db, invite } = fixture(t, file);
  const barrier = new SharedArrayBuffer(4);
  const workers = [betaId("race-a"), betaId("race-b")].map(deviceId => new Worker(new URL("./enrollment-race-worker.mjs", import.meta.url), {
    workerData: { file, barrier, invite: invite.token, registration: signed(invite.token, { ...registration, deviceId }), now: NOW, origin: ORIGIN },
  }));
  t.after(() => Promise.all(workers.map(w => w.terminate())));
  await Promise.all(workers.map(w => once(w, "message")));
  const results = Promise.all(workers.map(w => once(w, "message")));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0);
  assert.deepEqual((await results).flat().sort(), [false, true]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM devices").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM enrollment_invites WHERE redeemed_at_ms IS NOT NULL").get().n, 1);
});

test("duplicate device rolls back invite claim and preserves existing owner, key and permissions", async t => {
  const { db, registry, invite } = fixture(t);
  db.prepare("INSERT INTO devices VALUES (?, 'bob', 'unchanged-key', 'active', 1, '2026-01-01', NULL)").run(registration.deviceId);
  await assert.rejects(redeemEnrollmentInvite(registry, invite.token, registration, [], NOW));
  assert.equal(db.prepare("SELECT redeemed_at_ms FROM enrollment_invites").get().redeemed_at_ms, null);
  assert.equal(db.prepare("SELECT agent_public_key_b64 FROM devices").get().agent_public_key_b64, "unchanged-key");
  assert.equal(db.prepare("SELECT owner_id FROM devices").get().owner_id, "bob");
  assert.equal(db.prepare("SELECT terminal_enabled FROM devices").get().terminal_enabled, 1);
  assert.equal(await redeemEnrollmentInvite(registry, invite.token, { ...registration, deviceId: betaId("new-device") }, [], NOW), true);
});

test("insert constraint failure rolls back claim, even after a successful UPDATE", async t => {
  const { db, registry, invite } = fixture(t);
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  await assert.rejects(redeemEnrollmentInvite(registry, invite.token, registration, [], NOW));
  assert.equal(db.prepare("SELECT redemption_id FROM enrollment_invites").get().redemption_id, null);
});

test("cross-user authorization cannot be selected by the request or revoke helper", async t => {
  const { db, registry, invite } = fixture(t);
  db.exec(revokeInvite({ ownerId: "bob", hash: invite.hash, now: NOW }));
  assert.equal(db.prepare("SELECT revoked_at_ms FROM enrollment_invites").get().revoked_at_ms, null);
  for (const extra of [{ ownerId: "bob" }, { terminal_enabled: 1 }, { clientPublicKeyB64: publicKey }, { privateKey: "secret" }]) {
    assert.equal(await redeemEnrollmentInvite(registry, invite.token, { ...registration, ...extra }, [], NOW), false);
  }
  assert.equal(await redeemEnrollmentInvite(registry, invite.token, registration, [], NOW), true);
  const bob = createInvite({ ownerId: "bob", now: NOW }); db.exec(bob.sql);
  await assert.rejects(redeemEnrollmentInvite(registry, bob.token, registration, [], NOW));
  assert.equal((await resolveActiveBetaDevice(registry, registration.deviceId)).ownerId, "alice");
});

test("malformed ids, keys, extra fields, noncanonical base64 and invite formats are rejected", async t => {
  const { registry, invite } = fixture(t);
  for (const deviceId of ["", "../x", "-leading", "x".repeat(97), 123, "a\nb"]) {
    assert.equal(await redeemEnrollmentInvite(registry, invite.token, { ...registration, deviceId }, [], NOW), false);
  }
  for (const agentPublicKeyB64 of ["", "PRIVATE KEY", publicKey + "\n", publicKey.slice(0, -1), Buffer.alloc(44).toString("base64"), 4]) {
    assert.equal(await validateRegistration(signed(invite.token, { ...registration, agentPublicKeyB64 }), ORIGIN, invite.token), null);
  }
  for (const value of [null, [], "string", {}, { ...registration, ownerId: "bob" }]) assert.equal(await validateRegistration(value, ORIGIN, invite.token), null);
  for (const token of ["", invite.token.toUpperCase(), invite.token + " ", "abi1_" + "0".repeat(63)]) {
    assert.equal(await redeemEnrollmentInvite(registry, token, registration, [], NOW), false);
  }
});

test("all personal device IDs are reserved and original personal key resolution is unchanged", async t => {
  const { registry, invite } = fixture(t);
  const reserved = ["personal-agent", "personal-client", "personal-mcp"];
  for (const deviceId of reserved) assert.equal(await redeemEnrollmentInvite(registry, invite.token, { ...registration, deviceId }, reserved, NOW), false);
  const ownerEnv = { ...env(registry), AGENT_PUBLIC_KEY_B64: "personal-key" };
  assert.deepEqual(await resolveAgentAuthentication(ownerEnv, "personal-agent"), { deviceId: "personal-agent", publicKeyB64: "personal-key", beta: false });
  assert.equal(await resolveAgentAuthentication({ ...ownerEnv, AGENT_PUBLIC_KEY_B64: "" }, "personal-agent"), null);
});

test("missing transactional adapter fails closed without even preparing a statement", async () => {
  assert.equal(await redeemEnrollmentInvite({ prepare() { throw new Error("must not run"); } }, "abi1_" + "a".repeat(64), registration, [], NOW), false);
});

test("route success returns only ok; errors never reflect secrets or database messages", async t => {
  const { db, registry } = fixture(t);
  const liveInvite = createInvite({ ownerId: "alice" }); db.exec(liveInvite.sql);
  const response = await handleEnrollment(request(liveInvite.token), env(registry));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });
  const replay = await handleEnrollment(request(liveInvite.token), env(registry));
  assert.equal(replay.status, 403);
  assert.deepEqual(await replay.json(), { error: "enrollment_denied" });
  const broken = { ...registry, async batch() { throw new Error(liveInvite.token + " PRIVATE KEY DB DETAILS"); } };
  const denied = await handleEnrollment(request(liveInvite.token), env(broken));
  assert.equal(await denied.text(), '{"error":"enrollment_denied"}');
});

test("route is opt-in, HTTPS-only, bounded and rejects unauthenticated/malformed requests", async t => {
  const { registry, invite } = fixture(t);
  for (const overrides of [{ BETA_REGISTRY_ENABLED: "false" }, { BETA_ENROLLMENT_ENABLED: undefined }, { BETA_REGISTRY: undefined }]) {
    assert.equal((await handleEnrollment(request(invite.token), { ...env(registry), ...overrides })).status, 404);
  }
  assert.equal((await handleEnrollment(new Request("https://relay.example/beta/enroll", { method: "POST", headers: { "content-type": "application/json" } }), env(registry))).status, 401);
  for (const url of ["http://relay.example/beta/enroll", "https://relay.example/beta/enroll?invite=secret"]) {
    assert.equal((await handleEnrollment(new Request(url, request(invite.token)), env(registry))).status, 400);
  }
  assert.equal((await handleEnrollment(request(invite.token, null, { body: "{" }), env(registry))).status, 403);
  assert.equal((await handleEnrollment(request(invite.token, null, { body: "x".repeat(1025) }), env(registry))).status, 413);
  assert.equal((await handleEnrollment(request(invite.token, null, { body: "{}", headers: { authorization: `Bearer ${invite.token}`, "content-type": "application/json", "content-length": "2048" } }), env(registry))).status, 413);
});

test("enrollment accepts an exact-boundary streamed registration", async t => {
  const { db, registry } = fixture(t);
  const invite = createInvite({ ownerId: "alice" }); db.exec(invite.sql);
  const json = JSON.stringify(signed(invite.token, registration));
  const bytes = new TextEncoder().encode(json.padEnd(MAX_ENROLLMENT_BODY));
  assert.equal(bytes.byteLength, MAX_ENROLLMENT_BODY);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 17)); controller.enqueue(bytes.subarray(17)); controller.close();
  } });
  const response = await handleEnrollment(request(invite.token, null, { body, duplex: "half" }), env(registry));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(body.locked, false);
});

test("enrollment bounds actual streamed bytes, cancels/releases and preserves error mapping", async () => {
  const token = "abi1_" + "a".repeat(64);
  const registry = { prepare() { assert.fail("body rejection must precede D1"); }, batch() { assert.fail("must not redeem"); } };
  for (const declared of [undefined, "1"]) {
    for (const cancelFails of [false, true]) {
      let cancelled = 0;
      let reads = 0;
      const body = new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(reads === 1 ? MAX_ENROLLMENT_BODY : 1)); },
        cancel() { cancelled++; if (cancelFails) throw new Error("private cancellation details"); },
      }, { highWaterMark: 0 });
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      if (declared !== undefined) headers["content-length"] = declared;
      const response = await handleEnrollment(request(token, null, { body, headers, duplex: "half" }), env(registry));
      assert.equal(response.status, cancelFails ? 403 : 413);
      assert.deepEqual(await response.json(), { error: "enrollment_denied" });
      assert.equal(cancelled, 1); assert.equal(reads, 2); assert.equal(body.locked, false);
    }
  }
});

test("enrollment rejects malformed UTF-8 and read failures without leaking details", async () => {
  const token = "abi1_" + "a".repeat(64);
  const registry = { prepare() { assert.fail("must not query D1"); }, batch() { assert.fail("must not redeem"); } };
  for (const chunks of [[new Uint8Array([0xc3]), new Uint8Array([0x28])], [new Uint8Array([0xc3])], null]) {
    const body = new ReadableStream({ start(controller) {
      if (!chunks) { controller.error(new Error(token + " private read details")); return; }
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    } });
    const response = await handleEnrollment(request(token, null, { body, duplex: "half" }), env(registry));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "enrollment_denied" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.locked, false);
  }
});

test("enrollment UTF-8 rejection is fatal even when replacement decoding would yield a valid registration", async t => {
  const { db, registry } = fixture(t);
  const invite = createInvite({ ownerId: "alice" }); db.exec(invite.sql);
  const value = signed(invite.token, registration);
  // JSON's later version member would hide the malformed earlier value if decoding were lossy.
  const bytes = Buffer.concat([Buffer.from('{"version":"'), Buffer.from([0xc3]),
    Buffer.from('",' + JSON.stringify(value).slice(1))]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), value);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(bytes); controller.close();
  } });
  const response = await handleEnrollment(request(invite.token, null, { body, duplex: "half" }), env(registry));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "enrollment_denied" });
  assert.equal(body.locked, false);
  assert.equal(db.prepare("SELECT count(*) n FROM devices").get().n, 0);
  assert.equal(db.prepare("SELECT redeemed_at_ms FROM enrollment_invites WHERE invite_hash = ?").get(invite.hash).redeemed_at_ms, null);
});

test("operator issuance enforces short TTL, active owner, and never places the token in SQL", t => {
  const { db, invite } = fixture(t);
  assert.ok(!invite.sql.includes(invite.token));
  assert.match(invite.token, /^abi1_[a-f0-9]{64}$/);
  for (const ttlSeconds of [0, 59, 86401, Infinity, 1.2]) assert.throws(() => createInvite({ ownerId: "alice", ttlSeconds }));
  assert.throws(() => createInvite({ ownerId: "a'; DROP TABLE users;--" }));
  db.exec("UPDATE users SET status = 'disabled' WHERE user_id = 'bob'");
  db.exec(createInvite({ ownerId: "bob", now: NOW }).sql);
  assert.equal(db.prepare("SELECT count(*) AS n FROM enrollment_invites").get().n, 1);
  assert.throws(() => db.prepare("INSERT INTO enrollment_invites (invite_hash, owner_id, created_at_ms, expires_at_ms) VALUES (?, 'alice', 0, 86400001)").run("f".repeat(64)));
});

test("operator CLI writes private output files, emits no secret and never overwrites existing output", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-invite-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "invite");
  const script = new URL("../scripts/beta-invite.mjs", import.meta.url);
  const run = args => spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8" });
  const result = run(["create", "--owner", "alice", "--relay-origin", ORIGIN, "--out", out]);
  assert.equal(result.status, 0);
  const artifact = JSON.parse(fs.readFileSync(path.join(out, "invite.json"), "utf8"));
  const token = artifact.invite;
  assert.equal(artifact.relayOrigin, ORIGIN); assert.equal(artifact.version, 1);
  assert.match(token, /^abi1_[a-f0-9]{64}$/);
  assert.ok(!result.stdout.includes(token)); assert.ok(!result.stderr.includes(token));
  assert.ok(!fs.readFileSync(path.join(out, "registry.sql"), "utf8").includes(token));
  assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  for (const name of ["registry.sql", "invite.json"]) assert.equal(fs.statSync(path.join(out, name)).mode & 0o777, 0o600);
  assert.equal(run(["create", "--owner", "alice", "--out", out]).status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "invite.json"), "utf8")).invite, token);
  const denied = run(["--invite", token]);
  assert.equal(denied.status, 1); assert.ok(!denied.stderr.includes(token));
});
