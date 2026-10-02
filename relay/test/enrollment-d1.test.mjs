// Actual local D1 runtime verification, in addition to the separate-connection SQLite race.
import "./source-loader.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { authorizeConnector, createInvite, revokeDevice, revokeInvite } from "../scripts/beta-invite.mjs";
import { betaId, ORIGIN, signEnrollment } from "./beta-test-helpers.mjs";
import { signedHeaders } from "../../installer/lib/relay-probe.mjs";
const { redeemEnrollmentInvite } = await import("../src/beta-enrollment.ts");
const { resolveAccessIdentityDevice } = await import("../.test-tmp/access-registry.mjs");
const now = 1800000000000;
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const registration = (invite, label) => signEnrollment(ORIGIN, invite, betaId(label), publicKey, keys.privateKey);
// D1 exec accepts one statement per line. Retain EVERY statement from each whole
// known migration/operator artifact, changing only comments/line formatting.
const execArtifact = (db, sql) => db.exec(sql.replace(/--[^\n]*/g, "").replace(/\s*\n\s*/g, " ").replace(/;\s*/g, ";\n").trim());
const MIGRATIONS = ["0001_closed_beta_registry.sql", "0002_beta_enrollment_invites.sql", "0003_beta_agent_key_unique.sql", "0004_access_identities.sql", "0005_pairing_sessions.sql", "0006_pairing_claim_marker.sql", "0007_pairing_consent.sql"];
async function applyMigration(db, name) {
  const sql = fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replace(/--[^\n]*/g, "");
  for (const statement of sql.split(";").filter(s => s.trim())) await db.prepare(statement).run();
}
async function fixture(t, { migrations = MIGRATIONS } = {}) {
  const bundle = await build({ stdin: {
    contents: `import { validateRegistration } from './beta-enrollment.ts'; export default { async fetch(r) {
      return Response.json({ valid: !!await validateRegistration(await r.json(), '${ORIGIN}', '${"abi1_" + "a".repeat(64)}') });
    } };`,
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts",
  }, bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent" });
  const mf = new Miniflare({ workers: [{ config: {
    name: "enrollment-test",
    compatibilityDate: "2026-09-27",
    manifest: { mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
    } },
    env: { BETA_REGISTRY: { type: "d1", id: "enrollment-test" } },
  } }] });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("BETA_REGISTRY");
  for (const name of migrations) await applyMigration(db, name);
  await db.prepare("INSERT INTO users VALUES ('tester', 'Tester', 'active', '2026-01-01')").run();
  const invite = createInvite({ ownerId: "tester", now }); await db.prepare(invite.sql).run();
  return { db, invite, mf };
}
test("local D1 batch concurrent redemption inserts exactly one file-only device", async t => {
  const { db, invite, mf } = await fixture(t);
  // Separate proxy handles submit independent concurrent requests to the same D1 primary.
  const second = await mf.getD1Database("BETA_REGISTRY");
  const results = await Promise.all([db, second].map((connection, i) => redeemEnrollmentInvite(connection, invite.token, registration(invite.token, String(i)), [], now, ORIGIN)));
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM devices").first()).n, 1);
  assert.equal((await db.prepare("SELECT terminal_enabled FROM devices").first()).terminal_enabled, 0);
});
test("local D1 duplicate device aborts whole batch and leaves invite unconsumed", async t => {
  const { db, invite } = await fixture(t);
  await db.prepare("INSERT INTO devices VALUES (?, 'tester', 'original-key', 'active', 0, '2026-01-01', NULL)").bind(betaId("duplicate")).run();
  await assert.rejects(redeemEnrollmentInvite(db, invite.token, registration(invite.token, "duplicate"), [], now, ORIGIN));
  assert.equal((await db.prepare("SELECT redeemed_at_ms FROM enrollment_invites").first()).redeemed_at_ms, null);
});

test("local D1 injected insert trigger rolls back invite claim", async t => {
  const { db, invite } = await fixture(t);
  await db.prepare("CREATE TRIGGER fail_insert BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT, 'injected'); END").run();
  await assert.rejects(redeemEnrollmentInvite(db, invite.token, registration(invite.token, "trigger"), [], now, ORIGIN));
  assert.equal((await db.prepare("SELECT redemption_id FROM enrollment_invites").first()).redemption_id, null);
  assert.equal((await db.prepare("SELECT count(*) n FROM devices").first()).n, 0);
});

for (const mode of ["expired", "future", "revoked", "disabled-owner"]) test(`local D1 ${mode} grant refuses redemption`, async t => {
  const { db, invite } = await fixture(t);
  if (mode === "revoked") await db.prepare("UPDATE enrollment_invites SET revoked_at_ms = ?").bind(now).run();
  if (mode === "disabled-owner") await db.prepare("UPDATE users SET status = 'disabled'").run();
  const at = mode === "expired" ? now + 3600000 : mode === "future" ? now - 1 : now;
  assert.equal(await redeemEnrollmentInvite(db, invite.token, registration(invite.token, mode), [], at, ORIGIN), false);
  assert.equal((await db.prepare("SELECT redeemed_at_ms FROM enrollment_invites").first()).redeemed_at_ms, null);
  assert.equal((await db.prepare("SELECT count(*) n FROM devices").first()).n, 0);
});

test("local D1 enforces owner binding and unique keys; consumed revoke reports and disables redeemed device", async t => {
  const { db, invite } = await fixture(t);
  await db.prepare("INSERT INTO users VALUES ('other', 'Other', 'active', '2026-01-01')").run();
  for (const sql of revokeInvite({ ownerId: "other", hash: invite.hash, now }).split(";").filter(s => s.trim())) await db.prepare(sql).run();
  assert.equal((await db.prepare("SELECT revoked_at_ms FROM enrollment_invites").first()).revoked_at_ms, null);
  assert.equal(await redeemEnrollmentInvite(db, invite.token, registration(invite.token, "owner"), [], now, ORIGIN), true);
  assert.equal((await db.prepare("SELECT owner_id FROM devices").first()).owner_id, "tester");
  const second = createInvite({ ownerId: "other", now }); await db.prepare(second.sql).run();
  await assert.rejects(redeemEnrollmentInvite(db, second.token, registration(second.token, "duplicate-key"), [], now, ORIGIN));
  assert.equal((await db.prepare("SELECT redeemed_at_ms FROM enrollment_invites WHERE invite_hash = ?").bind(second.hash).first()).redeemed_at_ms, null);
  const statements = revokeInvite({ ownerId: "tester", hash: invite.hash, now }).split(";").filter(s => s.trim());
  const rows = await db.prepare(statements[0]).all();
  assert.equal(rows.results[0].redeemed_device_id, betaId("owner"));
  assert.equal(rows.results[0].redeemed_at_ms, now);
  for (const sql of statements.slice(1)) await db.prepare(sql).run();
  assert.equal((await db.prepare("SELECT status FROM devices").first()).status, "revoked");
});

test("local D1 Access identity resolves exactly one active owned device and fails closed on ambiguity", async t => {
  const { db, invite } = await fixture(t);
  const deviceId = betaId("access-route");
  assert.equal(await redeemEnrollmentInvite(db, invite.token, registration(invite.token, "access-route"), [], now, ORIGIN), true);

  const issuer = "https://team.cloudflareaccess.com";
  const subject = "subject-access-01";
  await db.prepare(`
    INSERT INTO user_identities (issuer, subject, owner_id, email, status, created_at)
    VALUES (?, ?, 'tester', 'tester@example.com', 'active', '2026-01-01')
  `).bind(issuer, subject).run();

  assert.deepEqual(await resolveAccessIdentityDevice(db, issuer, subject), {
    ownerId: "tester",
    deviceId,
    terminalEnabled: false,
  });

  const secondId = betaId("access-route-2");
  await db.prepare(`
    INSERT INTO devices (device_id, owner_id, agent_public_key_b64, status, terminal_enabled, created_at, revoked_at)
    VALUES (?, 'tester', 'distinct-test-public-key', 'active', 0, '2026-01-02', NULL)
  `).bind(secondId).run();
  assert.equal(await resolveAccessIdentityDevice(db, issuer, subject), null, "multiple active devices must not be selected implicitly");

  await db.prepare("UPDATE devices SET status = 'revoked', revoked_at = '2026-01-03' WHERE device_id = ?").bind(secondId).run();
  assert.deepEqual(await resolveAccessIdentityDevice(db, issuer, subject), {
    ownerId: "tester",
    deviceId,
    terminalEnabled: false,
  });

  await db.prepare("UPDATE user_identities SET status = 'disabled' WHERE issuer = ? AND subject = ?").bind(issuer, subject).run();
  assert.equal(await resolveAccessIdentityDevice(db, issuer, subject), null);
});

test("local workerd verifier interoperates with installer PoP and rejects small-order forgeries", async t => {
  const { mf } = await fixture(t);
  const token = "abi1_" + "a".repeat(64);
  const body = registration(token, "workerd");
  const validate = async value => (await (await mf.dispatchFetch(ORIGIN + "/validate", { method: "POST", body: JSON.stringify(value) })).json()).valid;
  assert.equal(await validate(body), true);
  assert.equal(await validate({ ...body, deviceId: betaId("tampered") }), false);
  // R=B, S=1 is canonical: this regression specifically requires key validation.
  const canonicalForgery = Buffer.from("58" + "66".repeat(31) + "01" + "00".repeat(31), "hex");
  const identityKey = Buffer.from("302a300506032b657003210001" + "00".repeat(31), "hex").toString("base64");
  assert.equal(await validate({ ...body, agentPublicKeyB64: identityKey, proof: canonicalForgery.toString("base64") }), false);
  for (const hex of ["01" + "00".repeat(31), "00".repeat(32), "ec" + "ff".repeat(30) + "7f",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", "ed" + "ff".repeat(30) + "7f"]) {
    for (const sign of [0, 0x80]) {
      const point = Buffer.from(hex, "hex"); point[31] |= sign;
      const weak = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), point]).toString("base64");
      const signature = Buffer.alloc(64); signature[0] = 1;
      assert.equal(await validate({ ...body, agentPublicKeyB64: weak, proof: signature.toString("base64") }), false);
    }
  }
});

test("bundled Worker + migrated D1 + native local rate bindings: enroll/status/connect/MCP/audit/revoke/denied", { timeout: 60000 }, async t => {
  // Expose only Worker entrypoints; index.ts also exports non-handler test constants.
  const bundle = await build({ stdin: {
    contents: `export { default, DeviceRelay } from './index.ts';`,
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts",
  },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:*", "node:*"], logLevel: "silent" });
  const example = JSON.parse(fs.readFileSync(new URL("../wrangler.beta.example.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const env = {
    BETA_REGISTRY: { type: "d1", id: "whole-worker-test" },
    DEVICE_RELAY: { type: "durable-object", worker: "whole-worker-test", exportName: "DeviceRelay" },
    ...Object.fromEntries(Object.entries({ BETA_REGISTRY_ENABLED: "true", BETA_ENROLLMENT_ENABLED: "true",
      AGENT_DEVICE_ID: "personal", CLIENT_DEVICE_ID: "personal", MCP_DEVICE_ID: "personal" }).map(([name, value]) => [name, { type: "text", value }])),
    ...Object.fromEntries(example.ratelimits.map(binding => [binding.name, { type: "rate-limit", namespace: binding.namespace_id, simple: binding.simple }])),
  };
  const mf = new Miniflare({ workers: [{ config: {
    name: "whole-worker-test", compatibilityDate: "2026-09-27", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } },
    exports: { DeviceRelay: { type: "durable-object", storage: "sqlite" } }, env,
  } }] });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("BETA_REGISTRY");
  // Whole migration/operator artifacts go through D1 exec; no statement picking.
  for (const name of ["0001_closed_beta_registry.sql", "0002_beta_enrollment_invites.sql", "0003_beta_agent_key_unique.sql", "0004_access_identities.sql", "0005_pairing_sessions.sql", "0006_pairing_claim_marker.sql", "0007_pairing_consent.sql"]) {
    await execArtifact(db, fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.exec("INSERT INTO users VALUES ('tester', 'Tester', 'active', '2026-01-01');");
  const invite = createInvite({ ownerId: "tester" }); await execArtifact(db, invite.sql);
  const deviceId = betaId("whole-worker");
  const ip = { "cf-connecting-ip": "2001:db8:1:2::1234" };
  const send = (target, init = {}) => mf.dispatchFetch(ORIGIN + target, { ...init, headers: { ...ip, ...init.headers } });
  const enrollment = signEnrollment(ORIGIN, invite.token, deviceId, publicKey, keys.privateKey);
  assert.equal((await send("/beta/enroll", { method: "POST", headers: { authorization: `Bearer ${invite.token}`, "content-type": "application/json" }, body: JSON.stringify(enrollment) })).status, 201);
  const statusPath = `/beta/device/${deviceId}/status`;
  const status = () => send(statusPath, { headers: signedHeaders(keys.privateKey, "GET", statusPath) });
  const pending = await status(); assert.equal(pending.status, 200); assert.equal((await pending.json()).agentConnected, false);
  const connectPath = `/v1/device/${deviceId}/connect`;
  const connect = () => send(connectPath, { headers: { ...signedHeaders(keys.privateKey, "GET", connectPath), upgrade: "websocket" } });
  const connected = await connect(); assert.equal(connected.status, 101);
  const ws = connected.webSocket; assert.ok(ws); ws.accept(); t.after(() => { try { ws.close(); } catch {} });
  ws.addEventListener("message", event => {
    const frame = JSON.parse(event.data);
    if (frame.type === "rpc") ws.send(JSON.stringify({ type: "rpc_result", id: frame.id, result: { content: [{ type: "text", text: "synthetic file result" }] } }));
  });
  const heartbeat = new Promise(resolve => ws.addEventListener("message", event => {
    if (JSON.parse(event.data).type === "heartbeat_ack") resolve();
  }));
  ws.send(JSON.stringify({ type: "heartbeat", mcpHealthy: true })); await heartbeat;
  assert.equal((await (await status()).json()).agentConnected, true);
  const record = await db.prepare(`SELECT i.*, d.agent_public_key_b64, d.status AS device_status FROM enrollment_invites i JOIN devices d ON d.device_id = i.redeemed_device_id WHERE i.invite_hash = ?`).bind(invite.hash).first();
  const fingerprint = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
  const connector = authorizeConnector({ record, deviceId, fingerprint }); await execArtifact(db, connector.sql);
  assert.equal((await db.prepare("SELECT device_id FROM access_tokens").first()).device_id, deviceId);
  const mcp = () => send("/beta/mcp", { method: "POST", headers: { authorization: `Bearer ${connector.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/synthetic/workspace/file" } } }) });
  const result = await mcp(); assert.equal(result.status, 200); assert.ok((await result.text()).includes("synthetic file result"));
  let audit;
  for (let i = 0; i < 40; i++) {
    audit = await db.prepare("SELECT * FROM audit_events").first();
    if (audit) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(audit?.outcome, "succeeded"); assert.equal(audit.device_id, deviceId); assert.equal(audit.tool_name, "read_file");
  assert.ok(!JSON.stringify(audit).includes("/synthetic/workspace/file"));
  const revokedAt = Date.now();
  await execArtifact(db, revokeInvite({ ownerId: "tester", hash: invite.hash, now: revokedAt }));
  await execArtifact(db, revokeInvite({ ownerId: "tester", hash: invite.hash, now: revokedAt + 1000 }));
  assert.equal((await db.prepare("SELECT revoked_at FROM devices").first()).revoked_at, new Date(revokedAt).toISOString());
  assert.equal((await status()).status, 403); assert.equal((await connect()).status, 403); assert.equal((await mcp()).status, 401);
  // Exercise Miniflare's real local limit() interface through the actual route.
  // Provider location distribution/eventual counters remain a staging-only check.
  const results = [];
  for (let i = 0; i < 12; i++) results.push((await send("/beta/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
  assert.ok(results.includes(429), results.join(","));
  assert.equal((await status()).status, 403, "enroll exhaustion leaves agent class admitted");
  assert.equal((await mcp()).status, 401, "enroll exhaustion leaves MCP class admitted");
});
// Account pairing must preserve its transaction/rollback guarantees in real D1,
// not just a SQL-pattern mock or Node SQLite.
test("D1 account pairing: racing claimants, expiry and rollback preserve one owner", { timeout: 60000 }, async t => {
  const { db, mf } = await fixture(t);
  const { createPairingSession, claimPairingSession, pairingPreview, pairingStatus, PAIR_TTL_MS } = await import("../.test-tmp/pairing.mjs");
  const { signPairStart } = await import("../../installer/lib/account-pairing.mjs");
  const { randomUUID } = await import("node:crypto");
  const registration = signPairStart(ORIGIN, randomUUID(), betaId("account-race"), publicKey, keys.privateKey);
  const session = await createPairingSession(db, registration, now);
  assert.ok(session);
  const other = await mf.getD1Database("BETA_REGISTRY");
  const alice = { issuer: "https://accounts.cloudflareaccess.com", subject: "alice", email: "alice@example.com" };
  const bob = { ...alice, subject: "bob", email: "bob@example.com" };
  const reviews = await Promise.all([[db, alice], [other, bob]].map(([connection, identity]) => pairingPreview(connection, session.claimCode, identity, now)));
  assert.equal(reviews.filter(Boolean).length, 1, 'code review is single-use across accounts');
  const winner = reviews[0] ? alice : bob;
  const loser = reviews[0] ? bob : alice;
  const consent = reviews.find(Boolean).consent;
  assert.equal(await claimPairingSession(db, consent, loser, now + 1), null, 'account switch cannot confirm');
  assert.equal((await db.prepare('SELECT count(*) n FROM user_identities').first()).n, 0);
  const results = await Promise.all([db, other].map(connection => claimPairingSession(connection, consent, winner, now + 1)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await db.prepare("SELECT count(*) n FROM devices").first()).n, 1);
  assert.equal((await db.prepare("SELECT count(*) n FROM user_identities").first()).n, 1);
  assert.equal((await db.prepare("SELECT count(*) n FROM users").first()).n, 2, "fixture tester + exactly one successful claimant");
  assert.equal((await pairingStatus(db, session.secret, now + PAIR_TTL_MS)).status, "expired");

  const freshKey = generateKeyPairSync("ed25519");
  const freshPub = freshKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const next = await createPairingSession(db, signPairStart(ORIGIN, randomUUID(), betaId("account-rollback"), freshPub, freshKey.privateKey), now);
  assert.ok(next);
  const rollbackIdentity = { ...alice, subject: "rollback", email: "rollback@example.com" };
  const rollbackConsent = await pairingPreview(db, next.claimCode, rollbackIdentity, now);
  await db.prepare("CREATE TRIGGER account_fail_insert BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT, 'injected'); END").run();
  assert.equal(await claimPairingSession(db, rollbackConsent.consent, rollbackIdentity, now + 1), null);
  assert.equal((await pairingStatus(db, next.secret, now + 2)).status, "pending");
  assert.equal((await db.prepare("SELECT count(*) n FROM devices").first()).n, 1);
  assert.equal((await db.prepare("SELECT count(*) n FROM user_identities").first()).n, 1);
  assert.equal((await db.prepare("SELECT count(*) n FROM users").first()).n, 2);
  await db.prepare('DROP TRIGGER account_fail_insert').run();
  assert.ok(await claimPairingSession(db, rollbackConsent.consent, rollbackIdentity, now + 3), 'rollback leaves consent usable');
  assert.equal((await db.prepare("SELECT count(*) n FROM devices").first()).n, 2);
});

test('D1 simultaneous starts cannot create overlapping sessions for the same Mac', async t => {
  const { db, mf } = await fixture(t);
  const { createPairingSession, PAIR_TTL_MS } = await import('../.test-tmp/pairing.mjs');
  const { signPairStart } = await import('../../installer/lib/account-pairing.mjs');
  const { randomUUID } = await import('node:crypto');
  const other = await mf.getD1Database('BETA_REGISTRY');
  const start = device => signPairStart(ORIGIN, randomUUID(), device, publicKey, keys.privateKey);
  const results = await Promise.all([db, other].map(connection =>
    createPairingSession(connection, start(betaId('start-race')), now)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await createPairingSession(other, start(betaId('same-key-new-id')), now + 1), null);
  assert.equal((await db.prepare('SELECT count(*) n FROM pairing_sessions').first()).n, 1);
  assert.ok(await createPairingSession(other, start(betaId('start-race')), now + PAIR_TTL_MS));
});

// Migration 0007 must upgrade a POPULATED 0006 registry in the real D1 runtime:
// accounts/devices/identities/invites/sessions stay identical, legacy pending
// sessions never become browser credentials, and new pairings work afterwards.
test("D1 migration 0007 upgrades a populated 0006 registry without rewriting accounts", { timeout: 60000 }, async t => {
  const { db } = await fixture(t, { migrations: MIGRATIONS.slice(0, 6) });
  const { createPairingSession, claimPairingSession, pairingPreview, pairingStatus, PAIR_TTL_MS } = await import("../.test-tmp/pairing.mjs");
  const { signPairStart } = await import("../../installer/lib/account-pairing.mjs");
  const { randomUUID } = await import("node:crypto");
  const sha256 = value => createHash("sha256").update(value).digest("hex");
  const issuer = "https://accounts.cloudflareaccess.com";
  const legacyDevice = betaId("legacy-device");
  await db.prepare("INSERT INTO devices VALUES (?, 'tester', ?, 'active', 0, '2026-01-01', NULL)").bind(legacyDevice, publicKey).run();
  await db.prepare("INSERT INTO user_identities (issuer, subject, owner_id, email, status, created_at) VALUES (?, 'tester-subject', 'tester', 'tester@example.com', 'active', '2026-01-01')").bind(issuer).run();
  const pendingKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const legacyToken = "ap1_" + "d".repeat(64);
  await db.prepare("INSERT INTO pairing_sessions (secret_hash, request_id, device_id, agent_public_key_b64, status, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
    .bind(sha256(legacyToken), randomUUID(), betaId("legacy-pending"), pendingKey, now, now + PAIR_TTL_MS).run();
  await db.prepare("INSERT INTO pairing_sessions (secret_hash, request_id, device_id, agent_public_key_b64, status, created_at_ms, expires_at_ms, claimed_at_ms, owner_id, claim_id) VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?, 'tester', ?)")
    .bind(sha256("ap1_" + "c".repeat(64)), randomUUID(), legacyDevice, publicKey, now - 1000, now + PAIR_TTL_MS, now - 500, randomUUID()).run();
  const legacyColumns = "secret_hash, request_id, device_id, agent_public_key_b64, status, created_at_ms, expires_at_ms, claimed_at_ms, owner_id, claim_id";
  const snapshot = async () => Object.fromEntries(await Promise.all([
    ["users", "SELECT * FROM users ORDER BY user_id"],
    ["devices", "SELECT * FROM devices ORDER BY device_id"],
    ["identities", "SELECT * FROM user_identities ORDER BY issuer, subject"],
    ["invites", "SELECT * FROM enrollment_invites ORDER BY invite_hash"],
    ["sessions", `SELECT ${legacyColumns} FROM pairing_sessions ORDER BY secret_hash`],
  ].map(async ([name, sql]) => [name, (await db.prepare(sql).all()).results])));
  const before = await snapshot();
  assert.equal(before.sessions.length, 2);
  await applyMigration(db, "0007_pairing_consent.sql");
  assert.deepEqual(await snapshot(), before, "0007 changes no existing row");
  assert.deepEqual((await db.prepare("SELECT DISTINCT claim_code_hash, consent_hash, consent_scope FROM pairing_sessions").all()).results,
    [{ claim_code_hash: null, consent_hash: null, consent_scope: null }]);
  const alice = { issuer, subject: "alice", email: "alice@example.com" };
  assert.equal(await pairingPreview(db, legacyToken, alice, now), null, "legacy poll secret is not a browser code");
  assert.equal((await pairingStatus(db, legacyToken, now)).status, "pending", "legacy installer still sees its own session");
  assert.equal((await resolveAccessIdentityDevice(db, issuer, "tester-subject")).deviceId, legacyDevice);
  const fresh = generateKeyPairSync("ed25519");
  const freshPub = fresh.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const session = await createPairingSession(db, signPairStart(ORIGIN, randomUUID(), betaId("post-upgrade"), freshPub, fresh.privateKey), now);
  assert.ok(session, "fresh pairing starts on the upgraded registry");
  const review = await pairingPreview(db, session.claimCode, alice, now);
  assert.ok(await claimPairingSession(db, review.consent, alice, now + 1));
  assert.equal((await resolveAccessIdentityDevice(db, issuer, "alice")).deviceId, betaId("post-upgrade"));
});

test("D1 pairing: failed identity insert rolls back the account row; non-file scope cannot be stored", { timeout: 60000 }, async t => {
  const { db } = await fixture(t);
  const { createPairingSession, claimPairingSession, pairingPreview } = await import("../.test-tmp/pairing.mjs");
  const { signPairStart } = await import("../../installer/lib/account-pairing.mjs");
  const { randomUUID } = await import("node:crypto");
  const carol = { issuer: "https://accounts.cloudflareaccess.com", subject: "carol", email: "carol@example.com" };
  const session = await createPairingSession(db, signPairStart(ORIGIN, randomUUID(), betaId("identity-rollback"), publicKey, keys.privateKey), now);
  const { consent } = await pairingPreview(db, session.claimCode, carol, now);
  await db.prepare("CREATE TRIGGER identity_fail BEFORE INSERT ON user_identities BEGIN SELECT RAISE(ABORT, 'injected'); END").run();
  assert.equal(await claimPairingSession(db, consent, carol, now + 1), null);
  assert.equal((await db.prepare("SELECT count(*) n FROM users").first()).n, 1, "only the fixture tester remains");
  assert.equal((await db.prepare("SELECT count(*) n FROM devices").first()).n, 0);
  await db.prepare("DROP TRIGGER identity_fail").run();
  for (const change of ["consent_scope = 'terminal'", "consent_hash = 'not-a-hash'"]) {
    await assert.rejects(db.prepare(`UPDATE pairing_sessions SET ${change}`).run(), /CHECK constraint failed/, change);
  }
  assert.ok(await claimPairingSession(db, consent, carol, now + 2), "rollback leaves the reviewed confirmation usable");
  assert.equal((await db.prepare("SELECT terminal_enabled FROM devices").first()).terminal_enabled, 0);
});

// The whole hosted path in workerd, short of real Access/ChatGPT: Mac proof ->
// Access-authenticated code review -> explicit file-only consent -> Mac-side
// status + signed probe -> agent connect -> Access-authenticated MCP routed to
// THIS Mac only -> operator revoke artifact -> every surface fails closed.
test("bundled Worker in workerd: account pairing consent routes Access MCP to the paired Mac; revoke denies", { timeout: 90000 }, async t => {
  const { SignJWT, generateKeyPair, exportJWK } = await import("jose");
  const { signPairStart } = await import("../../installer/lib/account-pairing.mjs");
  const { randomUUID } = await import("node:crypto");
  const team = "https://pairing-e2e.cloudflareaccess.com";
  const aud = "b".repeat(64);
  const access = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(access.publicKey), kid: "pairing-e2e", alg: "RS256", use: "sig" };
  const assertion = (subject, email = "alice@example.com") => new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "pairing-e2e" }).setIssuer(team).setAudience(aud)
    .setSubject(subject).setIssuedAt().setExpirationTime("10m").sign(access.privateKey);
  const outbound = [];
  const bundle = await build({ stdin: {
    contents: `export { default, DeviceRelay } from './index.ts';`,
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts",
  },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:*", "node:*"], logLevel: "silent" });
  const example = JSON.parse(fs.readFileSync(new URL("../wrangler.beta.example.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const env = {
    BETA_REGISTRY: { type: "d1", id: "pairing-e2e" },
    DEVICE_RELAY: { type: "durable-object", worker: "pairing-e2e", exportName: "DeviceRelay" },
    ...Object.fromEntries(Object.entries({ BETA_REGISTRY_ENABLED: "true", PAIRING_ENABLED: "true", MCP_AUTH_MODE: "access",
      ACCESS_DEVICE_ROUTING: "registry", TEAM_DOMAIN: team, POLICY_AUD: aud,
      AGENT_DEVICE_ID: "personal", CLIENT_DEVICE_ID: "personal", MCP_DEVICE_ID: "personal" }).map(([name, value]) => [name, { type: "text", value }])),
    ...Object.fromEntries(example.ratelimits.map(binding => [binding.name, { type: "rate-limit", namespace: binding.namespace_id, simple: binding.simple }])),
  };
  const mf = new Miniflare({ workers: [{
    config: {
      name: "pairing-e2e", compatibilityDate: "2026-09-27", compatibilityFlags: ["nodejs_compat"],
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } },
      exports: { DeviceRelay: { type: "durable-object", storage: "sqlite" } }, env,
    },
    // The only permitted egress is the Access JWKS; anything else is recorded and refused.
    dev: { outboundService: { type: "fetcher", handler: request => {
      outbound.push(request.url);
      return request.url === `${team}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : new Response(null, { status: 502 });
    } } },
  }] });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("BETA_REGISTRY");
  for (const name of MIGRATIONS) await execArtifact(db, fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const deviceId = betaId("pairing-e2e");
  const mac = { "cf-connecting-ip": "203.0.113.10" };
  const browser = { "cf-connecting-ip": "198.51.100.20" };
  const send = (target, from, init = {}) => mf.dispatchFetch(ORIGIN + target, { ...init, headers: { ...from, ...init.headers } });

  const started = await send("/pair/start", mac, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(signPairStart(ORIGIN, randomUUID(), deviceId, publicKey, keys.privateKey)) });
  assert.equal(started.status, 201);
  const start = await started.json();
  assert.equal(start.claimUrl, ORIGIN + "/pair/claim");

  assert.equal((await send("/pair/claim", browser)).status, 401, "no verified Access assertion, no review");
  const alice = await assertion("alice-subject");
  const authed = { ...browser, "cf-access-jwt-assertion": alice };
  const entry = await send("/pair/claim", authed);
  assert.equal(entry.status, 200);
  for (const [name, value] of [["x-frame-options", "DENY"], ["cross-origin-opener-policy", "same-origin"], ["cache-control", "no-store"], ["referrer-policy", "no-referrer"]]) {
    assert.equal(entry.headers.get(name), value, name);
  }
  assert.ok(!(await entry.text()).includes(deviceId), "code entry page discloses no device");
  const form = { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" };
  const review = await send("/pair/claim", authed, { method: "POST", headers: form, body: new URLSearchParams({ code: start.claimCode }).toString() });
  assert.equal(review.status, 200);
  const reviewHtml = await review.text();
  assert.ok(reviewHtml.includes(deviceId));
  assert.ok(reviewHtml.includes(createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex")));
  assert.ok(!reviewHtml.includes(start.claimCode) && !reviewHtml.includes(start.pairingToken));
  const consent = reviewHtml.match(/name="consent" value="(ac1_[a-f0-9]{64})"/)[1];
  const confirmed = await send("/pair/claim", authed, { method: "POST", headers: form, body: new URLSearchParams({ consent, scope: "files-v1" }).toString() });
  assert.equal(confirmed.status, 200);
  const device = await db.prepare("SELECT owner_id, terminal_enabled, status FROM devices WHERE device_id = ?").bind(deviceId).first();
  assert.equal(device.terminal_enabled, 0); assert.equal(device.status, "active");

  const pairStatus = () => send("/pair/status", mac, { headers: { authorization: `Bearer ${start.pairingToken}` } });
  assert.deepEqual(await (await pairStatus()).json(), { status: "claimed", deviceId });
  const statusPath = `/beta/device/${deviceId}/status`;
  const signedStatus = () => send(statusPath, mac, { headers: signedHeaders(keys.privateKey, "GET", statusPath) });
  assert.equal((await signedStatus()).status, 200, "installer recovery probe verifies the paired device");

  const connectPath = `/v1/device/${deviceId}/connect`;
  const connected = await send(connectPath, mac, { headers: { ...signedHeaders(keys.privateKey, "GET", connectPath), upgrade: "websocket" } });
  assert.equal(connected.status, 101);
  const ws = connected.webSocket; assert.ok(ws); ws.accept(); t.after(() => { try { ws.close(); } catch {} });
  const rpcs = [];
  ws.addEventListener("message", event => {
    const frame = JSON.parse(event.data);
    if (frame.type === "rpc") {
      rpcs.push(frame);
      ws.send(JSON.stringify({ type: "rpc_result", id: frame.id, result: { content: [{ type: "text", text: "synthetic paired-mac result" }] } }));
    }
  });
  const heartbeat = new Promise(resolve => ws.addEventListener("message", event => {
    if (JSON.parse(event.data).type === "heartbeat_ack") resolve();
  }));
  ws.send(JSON.stringify({ type: "heartbeat", mcpHealthy: true })); await heartbeat;

  const mcp = (body, token = alice) => send("/mcp", browser, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    headers: { "cf-access-jwt-assertion": token, "content-type": "application/json", accept: "application/json, text/event-stream" } });
  const read = await mcp({ id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/synthetic/acceptance.txt" } } });
  assert.equal(read.status, 200);
  assert.ok((await read.text()).includes("synthetic paired-mac result"));
  assert.equal(rpcs.length, 1, "the Access call reached exactly the paired Mac");
  const denied = await mcp({ id: 2, method: "tools/call", params: { name: "start_process", arguments: { command: "true", idempotencyKey: "pairing-e2e-denied" } } });
  assert.equal((await denied.json()).result.isError, true);
  assert.equal(rpcs.length, 1, "terminal tool never reaches a file-only Mac");
  assert.equal((await mcp({ id: 3, method: "tools/list", params: {} }, await assertion("mallory-subject"))).status, 401,
    "same email, different verified subject has no route");

  for (const sql of revokeDevice({ ownerId: device.owner_id, deviceId }).split(";").filter(s => s.trim())) await db.prepare(sql).run();
  assert.equal((await mcp({ id: 4, method: "tools/list", params: {} })).status, 401);
  assert.deepEqual(await (await pairStatus()).json(), { status: "cancelled", deviceId });
  assert.equal((await signedStatus()).status, 403);
  assert.equal(rpcs.length, 1);
  assert.ok(outbound.length >= 1 && outbound.every(url => url === `${team}/cdn-cgi/access/certs`), outbound.join(","));
});
