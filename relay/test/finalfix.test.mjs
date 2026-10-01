import "./source-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import worker from "../.test-tmp/index.mjs";
import { betaId, ORIGIN, rateBindings, signEnrollment } from "./beta-test-helpers.mjs";
import { signedHeaders } from "../../installer/lib/relay-probe.mjs";
import { sqliteRegistry } from "./enrollment-sqlite.mjs";
import { createInvite, inspectInvite, revokeInvite, revokeDevice } from "../scripts/beta-invite.mjs";
const { betaClientKey, betaRateGate } = await import("../src/beta-rate-limit.ts");
const { canonicalSignature } = await import("../src/ed25519-validation.ts");
const { validateRegistration, redeemEnrollmentInvite } = await import("../src/beta-enrollment.ts");
const pair = generateKeyPairSync("ed25519");
const pub = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const id = betaId("finalfix");

test("client keys: strict IPv4, canonical IPv6 /64, mapped IPv4 and one bounded unknown bucket", () => {
  for (const ip of ["192.0.2.1", "0.0.0.0", "255.255.255.255"]) assert.equal(betaClientKey(ip), ip);
  for (const ip of ["2001:db8:1234:abcd::1", "2001:DB8:1234:ABCD:ffff:ffff:ffff:ffff", "2001:0db8:1234:abcd:0:0:192.0.2.1"]) {
    assert.equal(betaClientKey(ip), "2001:0db8:1234:abcd/64");
  }
  assert.notEqual(betaClientKey("2001:db8:1234:abce::1"), betaClientKey("2001:db8:1234:abcd::1"));
  assert.equal(betaClientKey("::1"), "0000:0000:0000:0000/64");
  for (const ip of ["::ffff:192.0.2.1", "0:0:0:0:0:ffff:c000:201"]) assert.equal(betaClientKey(ip), "192.0.2.1");
  for (const ip of [null, "", " ", "192.00.2.1", "256.0.0.1", "127.1", "0xc0000201", "192.0.2.1:80", "a".repeat(500),
    "2001:db8:::1", "2001:db8::1::2", "1:2:3:4:5:6:7:8:9", "[::1]", "fe80::1%en0", "::ffff:999.1.1.1", "192.0.2.1,192.0.2.2", "::1/path"]) {
    assert.equal(betaClientKey(ip), "unknown", String(ip));
  }
});

for (const route of ["enroll", "status", "connect", "mcp"]) test(`${route}: client first, malformed client cannot charge shared, both gates before D1`, async () => {
  const client = route === "enroll" ? "BETA_ENROLL_RATE" : route === "mcp" ? "BETA_MCP_RATE" : "BETA_REQUEST_RATE";
  const shared = route === "enroll" ? "BETA_ENROLL_GLOBAL_RATE" : route === "mcp" ? "BETA_MCP_GLOBAL_RATE" : "BETA_AGENT_GLOBAL_RATE";
  const cls = ["status", "connect"].includes(route) ? "agent" : route;
  const target = route === "status" ? `/beta/device/${id}/status` : route === "connect" ? `/v1/device/${id}/connect` : `/beta/${route}`;
  const req = () => new Request(ORIGIN + target, { method: ["enroll", "mcp"].includes(route) ? "POST" : "GET",
    headers: { ...signedHeaders(pair.privateKey, "GET", target), "cf-connecting-ip": "2001:db8:1:2::3", "x-forwarded-for": "192.0.2.8" } });
  for (const result of [false, null, {}, { success: 1 }, { success: "false" }, { success: false }, "throw"]) {
    let databaseCalls = 0, sharedCalls = 0;
    const env = { ...rateBindings(), BETA_REGISTRY_ENABLED: "true", BETA_ENROLLMENT_ENABLED: "true", AGENT_DEVICE_ID: "personal",
      BETA_REGISTRY: { batch() { databaseCalls++; throw new Error("unexpected D1 batch"); }, prepare() { databaseCalls++; throw new Error("unexpected D1 read"); } },
      [client]: { async limit() { if (result === "throw") throw new Error("private"); return result; } },
      [shared]: { limit() { sharedCalls++; throw new Error("unexpected shared charge"); } } };
    assert.equal((await worker.fetch(req(), env)).status, result?.success === false ? 429 : 503);
    assert.equal(databaseCalls, 0); assert.equal(sharedCalls, 0);
  }
  const calls = [];
  const env = { ...rateBindings(),
    [client]: { async limit({ key }) { calls.push(key); return { success: true }; } },
    [shared]: { async limit({ key }) { calls.push(key); return { success: true }; } } };
  assert.equal(await betaRateGate(req(), env, route), null);
  assert.deepEqual(calls, [`${route}:2001:0db8:0001:0002/64`, `beta:${cls}`]);
});

test("enrollment flood cannot consume agent or MCP shared capacity; rejected clients do not amplify", async () => {
  const counts = new Map();
  const limited = max => ({ async limit({ key }) { counts.set(key, (counts.get(key) ?? 0) + 1); return { success: counts.get(key) <= max }; } });
  const env = { ...rateBindings(), BETA_ENROLL_RATE: limited(2), BETA_ENROLL_GLOBAL_RATE: limited(1),
    BETA_AGENT_GLOBAL_RATE: limited(2), BETA_MCP_GLOBAL_RATE: limited(1) };
  for (let i = 0; i < 20; i++) {
    const req = new Request(ORIGIN, { headers: { "cf-connecting-ip": `2001:db8:1:2::${i.toString(16)}`, "x-forwarded-for": String(i) } });
    const res = await betaRateGate(req, env, "enroll");
    assert.equal(res?.status ?? 200, i === 0 ? 200 : 429);
  }
  assert.equal(counts.get("beta:enroll"), 2);
  for (const route of ["status", "connect", "mcp"]) assert.equal(await betaRateGate(new Request(ORIGIN), env, route), null);
  assert.equal(counts.get("beta:agent"), 2); assert.equal(counts.get("beta:mcp"), 1);
});

test("identity public key with R=B,S=1 passes signature canonicality but enrollment rejects the key", async () => {
  const signature = Buffer.from("58" + "66".repeat(31) + "01" + "00".repeat(31), "hex");
  assert.equal(canonicalSignature(signature), true, "key validation must carry this protection");
  const weak = Buffer.from("302a300506032b657003210001" + "00".repeat(31), "hex").toString("base64");
  const token = "abi1_" + "a".repeat(64);
  const registration = { ...signEnrollment(ORIGIN, token, id, pub, pair.privateKey), agentPublicKeyB64: weak, proof: signature.toString("base64") };
  assert.equal(await validateRegistration(registration, ORIGIN, token), null);
});

test("stored malformed, noncanonical and small-order keys fail closed on signed status and connect", async t => {
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  db.exec("INSERT INTO users VALUES ('tester', 'Tester', 'active', '2026-01-01')");
  db.prepare("INSERT INTO devices VALUES (?, 'tester', ?, 'active', 0, '2026-01-01', NULL)").run(id, pub);
  const point = hex => Buffer.from("302a300506032b6570032100" + hex, "hex").toString("base64");
  const invalid = ["malformed", point("01" + "00".repeat(31)), point("ed" + "ff".repeat(30) + "7f"),
    point("00".repeat(31) + "80"), "A" + pub.slice(1), pub.slice(0, -2) + "B="];
  const env = { ...rateBindings(), BETA_REGISTRY_ENABLED: "true", AGENT_DEVICE_ID: "personal", BETA_REGISTRY: registry,
    DEVICE_RELAY: { getByName() { assert.fail("bad key reached DO"); }, idFromName() { assert.fail("bad key reached DO"); } } };
  for (const bad of invalid) {
    db.prepare("UPDATE devices SET agent_public_key_b64 = ?").run(bad);
    for (const target of [`/beta/device/${id}/status`, `/v1/device/${id}/connect`]) {
      const headers = signedHeaders(pair.privateKey, "GET", target);
      headers["X-Astra-Signature"] = Buffer.from("58" + "66".repeat(31) + "01" + "00".repeat(31), "hex").toString("base64");
      assert.equal((await worker.fetch(new Request(ORIGIN + target, { headers }), env)).status, 403);
    }
  }
});

test("personal beta-* IDs work only while registry flag is disabled, including missing D1 with flag true", async () => {
  for (const deviceId of ["beta-existing-mac", id]) for (const enabled of [undefined, "false", "true"]) {
    const stub = { async fetch() { return Response.json({ ok: true }); }, async mcpRpc() { return { ok: true, result: { tools: [] } }; } };
    const env = { ...rateBindings(), BETA_REGISTRY_ENABLED: enabled, AGENT_DEVICE_ID: deviceId, CLIENT_DEVICE_ID: deviceId,
      MCP_DEVICE_ID: deviceId, AGENT_PUBLIC_KEY_B64: pub, CLIENT_PUBLIC_KEY_B64: pub, MCP_BEARER_TOKEN: "synthetic-personal-token".repeat(2),
      DEVICE_RELAY: { idFromName: n => n, get: () => stub, getByName: () => stub } };
    for (const action of ["status", "connect"]) {
      const target = `/v1/device/${deviceId}/${action}`;
      const res = await worker.fetch(new Request(ORIGIN + target, { headers: { ...signedHeaders(pair.privateKey, "GET", target), upgrade: "websocket" } }), env);
      assert.equal(res.status, enabled === "true" ? 403 : 200);
    }
    const res = await worker.fetch(new Request(ORIGIN + "/mcp", { method: "POST", headers: { authorization: `Bearer ${env.MCP_BEARER_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env);
    assert.equal(res.status, enabled === "true" ? 503 : 200);
    if (enabled === "true") assert.equal((await res.json()).error, "personal_device_id_reserved");
  }
});

test("operator connector artifacts label exact owner/device/fingerprint, redact stdout and preserve revoke times", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-finalfix-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  const run = args => spawnSync(process.execPath, [new URL("../scripts/beta-invite.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" });
  for (const owner of ["alice", "bob"]) {
    db.prepare("INSERT INTO users VALUES (?, 'Tester', 'active', '2026-01-01')").run(owner);
    const key = generateKeyPairSync("ed25519"); const publicKey = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const deviceId = betaId(owner); const invite = createInvite({ ownerId: owner }); db.exec(invite.sql);
    assert.equal(await redeemEnrollmentInvite(registry, invite.token, signEnrollment(ORIGIN, invite.token, deviceId, publicKey, key.privateKey), [], Date.now(), ORIGIN), true);
    const record = db.prepare(inspectInvite({ ownerId: owner, hash: invite.hash }).split(";")[0]).get();
    const file = path.join(dir, owner + ".json"); fs.writeFileSync(file, JSON.stringify(record));
    const fp = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
    const out = path.join(dir, owner);
    const result = run(["authorize", "--record", file, "--device-id", deviceId, "--fingerprint", fp, "--out", out]);
    assert.equal(result.status, 0, result.stderr);
    const artifact = JSON.parse(fs.readFileSync(path.join(out, "connector-token.json"), "utf8"));
    assert.deepEqual([artifact.ownerId, artifact.deviceId, artifact.agentFingerprintSha256], [owner, deviceId, fp]);
    for (const label of [owner, deviceId, fp]) assert.ok(result.stdout.includes(label));
    assert.ok(!result.stdout.includes(artifact.bearer)); assert.ok(!result.stderr.includes(artifact.bearer));
    assert.equal(fs.statSync(path.join(out, "connector-token.json")).mode & 0o777, 0o600);
    db.exec(fs.readFileSync(path.join(out, "registry.sql"), "utf8"));
    const at = Date.now(); db.exec(revokeInvite({ ownerId: owner, hash: invite.hash, now: at }));
    db.exec(revokeInvite({ ownerId: owner, hash: invite.hash, now: at + 1000 }));
    db.exec(revokeDevice({ ownerId: owner, deviceId, now: at + 2000 }));
    for (const table of ["devices", "access_tokens"]) assert.equal(db.prepare(`SELECT revoked_at FROM ${table} WHERE owner_id = ?`).get(owner).revoked_at, new Date(at).toISOString());
  }
  const inside = new URL("../.test-tmp/forbidden-secret-output", import.meta.url).pathname;
  assert.equal(run(["create", "--owner", "alice", "--relay-origin", ORIGIN, "--out", inside]).status, 1);
  assert.equal(fs.existsSync(inside), false);
  fs.symlinkSync(path.dirname(inside), path.join(dir, "linked-parent"));
  assert.equal(run(["create", "--owner", "alice", "--relay-origin", ORIGIN, "--out", path.join(dir, "linked-parent", "secret")]).status, 1);
});
