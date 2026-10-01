import "../../relay/test/source-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPublicKey, generateKeyPairSync, verify, createHash } from "node:crypto";
import { createContext } from "../lib/context.mjs";
import { betaInstallOptions, enrollBeta, probeBetaStatus, readInviteFile, recoverPendingBetaIdentity } from "../lib/beta-enrollment.mjs";
import { assertTrustedBetaRelay } from "../lib/beta-trust.mjs";
import { pinBetaRelease } from "../pin-beta-release.mjs";
import { readState, writeState } from "../lib/state.mjs";
import { validateDeviceId } from "../lib/validate.mjs";
import { interpret } from "../lib/wrangler-config.mjs";
import { makeSandbox, tmpDir } from "./helpers.mjs";
import { sqliteRegistry } from "../../relay/test/enrollment-sqlite.mjs";
import { createInvite, revokeDevice } from "../../relay/scripts/beta-invite.mjs";
const { redeemEnrollmentInvite } = await import("../../relay/src/beta-enrollment.ts");
const BASE = "https://astra-bridge-relay.example-sub.workers.dev";
const ID = "beta-00000000-0000-4000-8000-000000000002";
const TOKEN = "abi1_" + "a".repeat(64);
const trust = origin => assertTrustedBetaRelay(origin, BASE);
function fixture(t) {
  const home = tmpDir("astra-finalfix-"); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ctx = createContext({ repoDir: path.join(home, "checkout"), env: { HOME: home } });
  fs.mkdirSync(ctx.astraHome, { mode: 0o700 });
  const pair = generateKeyPairSync("ed25519");
  const keyFile = path.join(ctx.astraHome, "agent-private.pem");
  fs.writeFileSync(keyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const s = { keys: { agent: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") } };
  const ui = { ok() {}, warn() {} };
  const opts = { betaEnroll: true, relayUrl: BASE, deviceId: ID };
  return { ctx, keyFile, pair, s, ui, opts };
}

for (const [status, message] of [[403, /already have been used/], [404, /enrollment is closed/], [429, /rate-limited/], [503, /temporarily unavailable/], [500, /not confirmed/]]) {
  test(`enrollment ${status} gives status-specific advice and never reads/refects error body`, async t => {
    const { ctx, opts, ui, s } = fixture(t);
    await assert.rejects(enrollBeta(ctx, opts, ui, s, TOKEN, { fetchImpl: async () => ({ status,
      body: { async cancel() {} }, json() { assert.fail("read untrusted error body"); } }) }), error => {
      assert.match(error.message, message); assert.ok(!error.message.includes(TOKEN));
      if (status !== 403) assert.doesNotMatch(error.message, /already have been used|revocation/);
      return true;
    });
  });
}
for (const failure of [new TypeError(TOKEN), new DOMException(TOKEN, "TimeoutError")]) test(`enrollment ${failure.name} remains unknown/recoverable without false theft signal`, async t => {
  const { ctx, opts, ui, s } = fixture(t);
  await assert.rejects(enrollBeta(ctx, opts, ui, s, TOKEN, { fetchImpl: async () => { throw failure; } }), error => {
    assert.match(error.message, /re-run to recover/); assert.doesNotMatch(error.message, /already have been used/);
    assert.ok(!error.message.includes(TOKEN)); return true;
  });
});

for (const mode of ["reset", "correction", "revoked-reset"]) test(`committed-response-loss ${mode}: signed old-ID recovery or fresh unique agent key`, async t => {
  const { ctx, opts, ui, s, keyFile } = fixture(t);
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  db.exec("INSERT INTO users VALUES ('tester', 'Tester', 'active', '2026-01-01')");
  const invite = createInvite({ ownerId: "tester" }); db.exec(invite.sql);
  await assert.rejects(enrollBeta(ctx, opts, ui, s, invite.token, { fetchImpl: async (url, init) => {
    assert.equal(await redeemEnrollmentInvite(registry, invite.token, JSON.parse(init.body), [], Date.now(), BASE), true);
    throw new TypeError("response lost AFTER commit");
  } }), /not confirmed/);
  const oldPrivate = fs.readFileSync(keyFile, "utf8"); const oldPublic = s.keys.agent;
  assert.equal(db.prepare("SELECT count(*) n FROM devices").get().n, 1);
  if (mode === "correction") writeState(ctx, { betaEnrollment: { ...readState(ctx).betaEnrollment, relayUrl: "https://typo.example" } });
  if (mode === "revoked-reset") db.exec(revokeDevice({ ownerId: "tester", deviceId: ID }));
  let probes = 0;
  const probe = (base, deviceId, file) => probeBetaStatus(base, deviceId, file, { fetchImpl: async (url, init) => {
    probes++; assert.equal(deviceId, ID); assert.equal(base, BASE);
    const record = db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId);
    const h = init.headers;
    const canonical = [h["X-Astra-Timestamp"], h["X-Astra-Nonce"], "GET", url.pathname, createHash("sha256").update("").digest("hex")].join("\n");
    assert.equal(verify(null, Buffer.from(canonical), createPublicKey({ key: Buffer.from(record.agent_public_key_b64, "base64"), format: "der", type: "spki" }), Buffer.from(h["X-Astra-Signature"], "base64")), true);
    return record.status === "active" ? Response.json({ ok: true }) : new Response(null, { status: 403 });
  } });
  const requested = betaInstallOptions(ctx, { betaEnroll: true, relayUrl: BASE, resetPendingIdentity: mode !== "correction" }, { trust });
  const resolved = await recoverPendingBetaIdentity(ctx, requested, ui, s, { probe });
  assert.equal(probes, 1);
  if (mode !== "revoked-reset") {
    assert.equal(resolved.deviceId, ID); assert.equal(readState(ctx).betaEnrollment.registered, true);
    assert.equal(s.keys.agent, oldPublic); assert.equal(fs.readFileSync(keyFile, "utf8"), oldPrivate);
    assert.throws(() => betaInstallOptions(ctx, { betaEnroll: true, resetPendingIdentity: true }, { trust }), /unconfirmed/);
  } else {
    assert.notEqual(resolved.deviceId, ID); assert.notEqual(s.keys.agent, oldPublic);
    assert.notEqual(fs.readFileSync(keyFile, "utf8"), oldPrivate);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(readState(ctx).betaEnrollment.agentPublicKeyB64, s.keys.agent);
    const fresh = createInvite({ ownerId: "tester" }); db.exec(fresh.sql);
    await enrollBeta(ctx, resolved, ui, s, fresh.token, { probe: async () => ({ ok: false, status: 403 }), fetchImpl: async (url, init) => {
      assert.equal(await redeemEnrollmentInvite(registry, fresh.token, JSON.parse(init.body), [], Date.now(), BASE), true);
      return Response.json({ ok: true }, { status: 201 });
    } });
    assert.equal(db.prepare("SELECT count(*) n FROM devices").get().n, 2);
    assert.equal(db.prepare("SELECT agent_public_key_b64 FROM devices WHERE device_id = ?").get(ID).agent_public_key_b64, oldPublic);
  }
});

test("unknown status preserves pending identity/key; interrupted rotation clears stale public identity and resumes", async t => {
  const { ctx, opts, ui, s, keyFile } = fixture(t);
  const original = fs.readFileSync(keyFile, "utf8");
  writeState(ctx, { betaEnrollment: { ...opts, registered: false, agentPublicKeyB64: s.keys.agent } });
  for (const status of [undefined, 429, 503, 409]) {
    await assert.rejects(recoverPendingBetaIdentity(ctx, { ...opts, resetPendingIdentity: true }, ui, s, { probe: async () => ({ status }) }), /retry later/);
    assert.equal(fs.readFileSync(keyFile, "utf8"), original);
  }
  writeState(ctx, { betaEnrollment: { relayUrl: BASE, deviceId: ID, registered: false, rotationRequired: true, previousDeviceId: "beta-00000000-0000-4000-8000-000000000003" } });
  await recoverPendingBetaIdentity(ctx, opts, ui, s, { probe() { assert.fail("must finish rotation before network"); } });
  assert.notEqual(fs.readFileSync(keyFile, "utf8"), original);
  assert.equal(readState(ctx).betaEnrollment.rotationRequired, false);
});

test("release trust template fails closed; deterministic pin rejects forged artifacts and legacy relay overrides", t => {
  const { ctx } = fixture(t);
  const file = path.join(ctx.home, "invite.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, relayOrigin: BASE, invite: TOKEN }), { mode: 0o600 });
  assert.throws(() => readInviteFile(file), /pinned/);
  assert.throws(() => betaInstallOptions(ctx, { betaEnroll: true, legacyInvite: true, relayUrl: BASE }), /not trusted/);
  assert.deepEqual(readInviteFile(file, undefined, { trust }), { invite: TOKEN, relayUrl: BASE });
  fs.writeFileSync(file, JSON.stringify({ version: 1, relayOrigin: "https://attacker.example", invite: TOKEN }));
  assert.throws(() => readInviteFile(file, undefined, { trust }), /pinned/);
  assert.throws(() => betaInstallOptions(ctx, { betaEnroll: true, legacyInvite: true, relayUrl: "https://attacker.example" }, { trust }), /not trusted/);
  const outputs = [];
  for (const name of ["release-a", "release-b"]) {
    const root = path.join(ctx.home, name); fs.mkdirSync(path.join(root, "installer/lib"), { recursive: true });
    const target = path.join(root, "installer/lib/beta-trust.mjs");
    fs.copyFileSync(new URL("../lib/beta-trust.mjs", import.meta.url), target);
    pinBetaRelease(root, BASE); outputs.push(fs.readFileSync(target, "utf8"));
    assert.throws(() => pinBetaRelease(root, "https://attacker.example"), /already pinned/);
  }
  assert.equal(outputs[0], outputs[1]); assert.ok(outputs[0].includes(JSON.stringify(BASE)));
  assert.throws(() => pinBetaRelease(new URL("../..", import.meta.url).pathname, BASE), /checkout/);
});

test("forged invite e2e is refused before key creation, launchctl or enrollment", t => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  const file = path.join(sb.state, "forged.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, relayOrigin: "https://attacker.example", invite: TOKEN }), { mode: 0o600 });
  const res = sb.run(["--beta-enroll", "--invite-file", file, "--skip-deps", "--yes", "--non-interactive"], {}, { network: true });
  assert.equal(res.status, 1); assert.match(res.out, /pinned/);
  assert.equal(fs.existsSync(path.join(sb.astraHome, "agent-private.pem")), false);
  assert.doesNotMatch(sb.calls(), /launchctl|wrangler/); assert.ok(!res.out.includes(TOKEN));
});

test("personal legacy beta IDs validate when disabled and doctor exposes future reservation", t => {
  assert.equal(validateDeviceId("beta-existing"), "beta-existing");
  assert.throws(() => validateDeviceId("beta-existing", true), /reserved/);
  const data = { vars: { AGENT_DEVICE_ID: "beta-existing", CLIENT_DEVICE_ID: "beta-existing", MCP_DEVICE_ID: "beta-existing" } };
  assert.equal(interpret(data).values.deviceId, "beta-existing");
  assert.match(interpret({ vars: { ...data.vars, BETA_REGISTRY_ENABLED: "true" } }).problems.join(" "), /reserved/);
  const sb = makeSandbox(); t.after(sb.cleanup);
  const r = sb.run(["--device-id", "beta-existing", "--skip-cloudflare", "--no-network-checks", "--skip-deps", "--yes", "--non-interactive"]);
  assert.doesNotMatch(r.out, /prefix is reserved/);
  const doctor = sb.run(["doctor", "--offline"]);
  assert.match(doctor.out, /legacy personal beta- ID preserved/);
});
