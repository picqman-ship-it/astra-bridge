import "./source-loader.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import worker from "../.test-tmp/index.mjs";
import { authenticateBetaMcpRequest, authenticateMcpRequest } from "../.test-tmp/mcp.mjs";
import { betaId, ORIGIN, rateBindings, signEnrollment } from "./beta-test-helpers.mjs";
import { signedHeaders } from "../../installer/lib/relay-probe.mjs";
import { createInvite, authorizeConnector, inspectInvite, revokeInvite, revokeDevice } from "../scripts/beta-invite.mjs";
import { sqliteRegistry } from "./enrollment-sqlite.mjs";
const { validateRegistration, redeemEnrollmentInvite } = await import("../src/beta-enrollment.ts");
const { canonicalNonSmallOrderPoint } = await import("../src/ed25519-validation.ts");
const token = "abi1_" + "a".repeat(64);
const key = generateKeyPairSync("ed25519");
const pub = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const id = betaId("proof");
const reg = () => signEnrollment(ORIGIN, token, id, pub, key.privateKey);

test("PoP v1 interoperates with Node signer and binds origin, invite, UUID and key", async () => {
  const body = reg();
  assert.deepEqual(await validateRegistration(body, ORIGIN, token), body);
  // Independent construction locks the byte-level contract, including no final newline.
  const message = ["astra-beta-enroll-v1", ORIGIN, createHash("sha256").update(token).digest("hex"), id, pub].join("\n");
  assert.equal(body.proof, sign(null, Buffer.from(message), key.privateKey).toString("base64"));
  for (const changed of [{ ...body, version: 2 }, { ...body, deviceId: betaId("other") },
    { ...body, agentPublicKeyB64: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64") },
    { ...body, proof: Buffer.alloc(64).toString("base64") }, { ...body, ownerId: "other" },
    { deviceId: id, agentPublicKeyB64: pub }, { ...body, proof: body.proof.slice(0, -3) + "B==" }]) {
    assert.equal(await validateRegistration(changed, ORIGIN, token), null);
  }
  assert.equal(await validateRegistration(body, "https://other.example", token), null);
  assert.equal(await validateRegistration(body, ORIGIN, "abi1_" + "b".repeat(64)), null);
  assert.equal(await redeemEnrollmentInvite({ batch() { assert.fail("must not reach D1"); }, prepare() { assert.fail("must not reach D1"); } }, token, { ...body, version: 0 }, [], Date.now(), ORIGIN), false);
});

test("all eight small-order points, sign aliases and all y >= p encodings are refused", async () => {
  const small = ["00".repeat(32), "01" + "00".repeat(31), "ec" + "ff".repeat(30) + "7f",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"];
  for (let n = 0xed; n <= 0xff; n++) small.push(n.toString(16) + "ff".repeat(30) + "7f");
  for (const hex of small) for (const signBit of [0, 0x80]) {
    const raw = Buffer.from(hex, "hex"); raw[31] |= signBit;
    assert.equal(canonicalNonSmallOrderPoint(raw), false, raw.toString("hex"));
    const weak = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]).toString("base64");
    const forged = Buffer.alloc(64); forged[0] = 1; // Identity R, S=0 universal forgery on permissive verifiers.
    assert.equal(await validateRegistration({ ...reg(), agentPublicKeyB64: weak, proof: forged.toString("base64") }, ORIGIN, token), null);
  }
  for (const name of ["my-mac", "beta-user", "beta-00000000-0000-1000-8000-000000000000", "beta-00000000-0000-4000-0000-000000000000"]) {
    assert.equal(await validateRegistration(signEnrollment(ORIGIN, token, name, pub, key.privateKey), ORIGIN, token), null);
  }
});

test("beta authenticator never reads personal bearer, device or OAuth credentials", async () => {
  let reads = 0;
  const env = { BETA_REGISTRY_ENABLED: "true", BETA_REGISTRY: { prepare() { reads++; return { bind() { return this; }, async first() { return { owner_id: "tester", device_id: id, terminal_enabled: 0, gui_enabled: 0 }; } }; } } };
  for (const name of ["MCP_BEARER_TOKEN", "MCP_DEVICE_ID", "OAUTH_OWNER_SECRET"]) Object.defineProperty(env, name, { get() { assert.fail(`read personal ${name}`); } });
  const request = new Request(ORIGIN + "/beta/mcp", { headers: { authorization: "Bearer " + "synthetic-personal-looking-token".repeat(2) } });
  const principal = await authenticateBetaMcpRequest(request, env);
  assert.equal(principal.deviceId, id); assert.equal(reads, 1);
  assert.deepEqual(principal.scopes, ["astra.read", "astra.write"]);
  assert.equal(await authenticateMcpRequest(request, { BETA_REGISTRY_ENABLED: "true", BETA_REGISTRY: { prepare() { assert.fail("personal must not consult beta D1"); } } }), null);
});

for (const route of ["enroll", "status", "mcp", "connect"]) test(`${route}: provider rate gate fails closed before D1 and DO`, async () => {
  let databaseCalls = 0;
  const pathname = route === "status" ? `/beta/device/${id}/status` : route === "connect" ? `/v1/device/${id}/connect` : `/beta/${route}`;
  const req = () => new Request(ORIGIN + pathname, { method: ["enroll", "mcp"].includes(route) ? "POST" : "GET",
    headers: { ...signedHeaders(key.privateKey, "GET", pathname), "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": "forged", authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(["enroll", "mcp"].includes(route) ? { body: JSON.stringify(reg()) } : {}) });
  const base = { ...rateBindings(), BETA_REGISTRY_ENABLED: "true", BETA_ENROLLMENT_ENABLED: "true",
    BETA_REGISTRY: { batch() { databaseCalls++; throw new Error("unexpected D1 batch"); }, prepare() { databaseCalls++; throw new Error("unexpected D1 prepare"); } },
    DEVICE_RELAY: { getByName() { assert.fail("DO"); } }, AGENT_DEVICE_ID: "personal", CLIENT_DEVICE_ID: "personal", MCP_DEVICE_ID: "personal" };
  const shared = route === "enroll" ? "BETA_ENROLL_GLOBAL_RATE" : route === "mcp" ? "BETA_MCP_GLOBAL_RATE" : "BETA_AGENT_GLOBAL_RATE";
  for (const name of Object.keys(rateBindings())) {
    assert.equal((await worker.fetch(req(), { ...base, [name]: undefined })).status, 503);
  }
  for (const result of [null, {}, { success: "true" }]) {
    assert.equal((await worker.fetch(req(), { ...base, [shared]: { limit: async () => result } })).status, 503);
  }
  assert.equal((await worker.fetch(req(), { ...base, [shared]: { limit() { throw new Error("private"); } } })).status, 503);
  const calls = [];
  const limiter = route === "enroll" ? "BETA_ENROLL_RATE" : route === "mcp" ? "BETA_MCP_RATE" : "BETA_REQUEST_RATE";
  const response = await worker.fetch(req(), { ...base,
    [shared]: { async limit({ key }) { calls.push(key); return { success: true }; } },
    [limiter]: { async limit({ key }) { calls.push(key); return { success: false }; } },
  });
  assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(calls, [`${route}:192.0.2.1`]);
  assert.equal(databaseCalls, 0, "error handling must not hide a pre-admission D1 call");
});

test("connect rejects misprovisioned rows for every reserved personal ID before registry or DO access", async t => {
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  db.exec("INSERT INTO users VALUES ('tester', 'Tester', 'active', '2026-01-01')");
  const env = { ...rateBindings(), BETA_REGISTRY_ENABLED: "true", AGENT_DEVICE_ID: "personal-agent", CLIENT_DEVICE_ID: "personal-client", MCP_DEVICE_ID: "personal-mcp", AGENT_PUBLIC_KEY_B64: pub,
    BETA_REGISTRY: { ...registry, prepare() { assert.fail("reserved ID queried registry"); } }, DEVICE_RELAY: { idFromName() { assert.fail("reserved beta connect reached DO"); } } };
  for (const deviceId of [env.AGENT_DEVICE_ID, env.CLIENT_DEVICE_ID, env.MCP_DEVICE_ID]) {
    const impostor = generateKeyPairSync("ed25519");
    db.prepare("INSERT INTO devices VALUES (?, 'tester', ?, 'active', 0, '2026-01-01', NULL)")
      .run(deviceId, impostor.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    const target = `/v1/device/${deviceId}/connect`;
    const response = await worker.fetch(new Request(ORIGIN + target, { headers: { ...signedHeaders(impostor.privateKey, "GET", target), upgrade: "websocket" } }), env);
    assert.ok([401, 403].includes(response.status));
  }
  for (const route of ["/mcp", `/v1/device/${id}/status`, `/v1/device/${id}/connect`]) {
    const response = await worker.fetch(new Request(ORIGIN + route, { headers: signedHeaders(key.privateKey, "GET", route) }), { ...env, BETA_REGISTRY_ENABLED: "true", AGENT_DEVICE_ID: id, CLIENT_DEVICE_ID: id, MCP_DEVICE_ID: id });
    assert.ok([403, 503].includes(response.status));
  }
});

test("enrollment flooding consumes only the configured pre-D1 budget and never keys on credentials", async () => {
  const { betaRateGate } = await import("../src/beta-rate-limit.ts");
  const calls = []; let admitted = 0;
  const env = { ...rateBindings(), BETA_ENROLL_RATE: { async limit({ key }) { calls.push(key); return { success: calls.length <= 5 }; } } };
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await betaRateGate(new Request(ORIGIN + "/beta/enroll", { headers: { authorization: `Bearer synthetic-${attempt}`, "x-forwarded-for": String(attempt) } }), env, "enroll");
    if (!response) admitted++;
    else assert.equal(response.status, 429);
  }
  assert.equal(admitted, 5);
  assert.ok(calls.every(key => key === "enroll:unknown"));
  const blocked = await betaRateGate(new Request(ORIGIN), { ...rateBindings(), BETA_ENROLL_GLOBAL_RATE: { async limit() { return { success: false }; } } }, "enroll");
  assert.equal(blocked.status, 429);
});

test("unique agent key constraint rolls back a fresh invite for another device", async t => {
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  db.exec("INSERT INTO users VALUES ('tester', 'Tester', 'active', '2026-01-01')");
  const first = createInvite({ ownerId: "tester" }); db.exec(first.sql);
  const second = createInvite({ ownerId: "tester" }); db.exec(second.sql);
  assert.equal(await redeemEnrollmentInvite(registry, first.token, signEnrollment(ORIGIN, first.token, id, pub, key.privateKey), [], Date.now(), ORIGIN), true);
  await assert.rejects(redeemEnrollmentInvite(registry, second.token, signEnrollment(ORIGIN, second.token, betaId("duplicate-key"), pub, key.privateKey), [], Date.now(), ORIGIN), /UNIQUE/);
  assert.equal(db.prepare("SELECT redeemed_at_ms FROM enrollment_invites WHERE invite_hash = ?").get(second.hash).redeemed_at_ms, null);
  assert.equal(db.prepare("SELECT count(*) n FROM devices").get().n, 1);
});

test("connector helper requires confirmed redemption identity, blocks unexpected devices and consumed revoke revokes tokens", async t => {
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  db.exec("INSERT INTO users VALUES ('tester', 'Tester', 'active', '2026-01-01')");
  const invite = createInvite({ ownerId: "tester" }); db.exec(invite.sql);
  assert.equal(await redeemEnrollmentInvite(registry, invite.token, signEnrollment(ORIGIN, invite.token, id, pub, key.privateKey), [], Date.now(), ORIGIN), true);
  const inspect = inspectInvite({ ownerId: "tester", hash: invite.hash });
  const record = db.prepare(inspect.split(";")[0]).get();
  const fingerprint = createHash("sha256").update(Buffer.from(pub, "base64")).digest("hex");
  assert.equal(record.redeemed_device_id, id);
  for (const changes of [{ deviceId: betaId("attacker") }, { fingerprint: "0".repeat(64) }, { record: { ...record, revoked_at_ms: Date.now() } }]) {
    assert.throws(() => authorizeConnector({ record, deviceId: id, fingerprint, ...changes }));
  }
  const connector = authorizeConnector({ record, deviceId: id, fingerprint });
  assert.ok(!connector.sql.includes(connector.token));
  db.prepare("INSERT INTO devices VALUES (?, 'tester', 'unexpected-key', 'active', 0, '2026-01-01', NULL)").run(betaId("attacker"));
  assert.equal(db.prepare(connector.sql).all().length, 0);
  db.exec(revokeDevice({ ownerId: "tester", deviceId: betaId("attacker") }));
  assert.equal(db.prepare(connector.sql).all()[0].device_id, id);
  const revoked = revokeInvite({ ownerId: "tester", hash: invite.hash });
  assert.equal(db.prepare(revoked.split(";")[0]).get().redeemed_device_id, id);
  db.exec(revoked);
  assert.equal(db.prepare("SELECT status FROM devices WHERE device_id = ?").get(id).status, "revoked");
  assert.equal(db.prepare("SELECT status FROM access_tokens").get().status, "revoked");
  const second = authorizeConnector({ record, deviceId: id, fingerprint });
  assert.equal(db.prepare(second.sql).all().length, 0, "stale inspection cannot authorize revoked invite");
});

test("beta example defaults enrollment off and declares the official rate binding shape", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../wrangler.beta.example.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(config.vars.BETA_ENROLLMENT_ENABLED, "false");
  assert.deepEqual(config.ratelimits.map(b => [b.name, b.simple.limit, b.simple.period]), [
    ["BETA_ENROLL_RATE", 5, 60], ["BETA_REQUEST_RATE", 120, 60], ["BETA_MCP_RATE", 1200, 60],
    ["BETA_ENROLL_GLOBAL_RATE", 60, 60], ["BETA_AGENT_GLOBAL_RATE", 600, 60], ["BETA_MCP_GLOBAL_RATE", 6000, 60],
  ]);
  assert.equal(new Set(config.ratelimits.map(b => b.namespace_id)).size, 6);
});
