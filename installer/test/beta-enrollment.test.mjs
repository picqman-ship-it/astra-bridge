import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { generateKeyPairSync, verify, createHash } from "node:crypto";
import { createContext } from "../lib/context.mjs";
import { betaInstallOptions as rawBetaInstallOptions, enrollBeta, probeBetaStatus, promptInvite, readInviteFile as rawReadInviteFile, recoverPendingBetaIdentity, signEnrollment, takeInvite } from "../lib/beta-enrollment.mjs";
import { assertTrustedBetaRelay } from "../lib/beta-trust.mjs";
import { writeState, readState } from "../lib/state.mjs";
import { parseArgs } from "../astra-macos.mjs";
import { makeSandbox, prerequisitesBuilt, tmpDir } from "./helpers.mjs";

const TOKEN = "abi1_" + "a".repeat(64);
const DEVICE = "beta-00000000-0000-4000-8000-000000000001";
const BASE = "https://astra-bridge-relay.example-sub.workers.dev";
const trust = origin => assertTrustedBetaRelay(origin, BASE);
const betaInstallOptions = (ctx, opts) => rawBetaInstallOptions(ctx, opts, { trust });
const readInviteFile = (file, url) => rawReadInviteFile(file, url, { trust });
function fixture(t) {
  const home = tmpDir("astra-beta-test-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ctx = createContext({ repoDir: path.join(home, "checkout"), env: { HOME: home, ASTRA_BETA_INVITE: TOKEN } });
  fs.mkdirSync(ctx.astraHome, { mode: 0o700 });
  const key = generateKeyPairSync("ed25519");
  const keyFile = path.join(ctx.astraHome, "agent-private.pem");
  fs.writeFileSync(keyFile, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const publicKey = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const output = [];
  const ui = { interactive: false, ok: value => output.push(value), release() {} };
  return { ctx, key, keyFile, output, ui, s: { keys: { agent: publicKey, client: "never send" } }, opts: { betaEnroll: true, relayUrl: BASE, deviceId: DEVICE } };
}

test("beta options force skip-cloudflare/file-only and generate stable public device identity", t => {
  const { ctx } = fixture(t);
  const opts = betaInstallOptions(ctx, { betaEnroll: true, relayUrl: BASE });
  assert.equal(opts.skipCloudflare, true);
  assert.equal(opts.fileOnly, true);
  assert.match(opts.deviceId, /^beta-[a-f0-9-]{36}$/);
  for (const flag of ["enableTerminal", "enableGui", "email", "accountId", "teamDomain", "policyAud", "workerName", "redeploy", "replaceExistingWorker", "noNetworkChecks"]) {
    assert.throws(() => betaInstallOptions(ctx, { betaEnroll: true, relayUrl: BASE, [flag]: true }));
  }
  for (const relayUrl of ["http://relay.example", "https://relay.example/?secret=x", "https://user:pass@relay.example", "https://relay.example/path"]) {
    assert.throws(() => betaInstallOptions(ctx, { betaEnroll: true, relayUrl }));
  }
});

test("personal installation is refused before any credentials or config are changed", t => {
  const { ctx } = fixture(t);
  fs.mkdirSync(path.dirname(ctx.personalConfig), { recursive: true });
  fs.writeFileSync(ctx.personalConfig, "owner configuration must stay exact");
  assert.throws(() => betaInstallOptions(ctx, { betaEnroll: true, relayUrl: BASE }), /personal installation/);
  assert.equal(fs.readFileSync(ctx.personalConfig, "utf8"), "owner configuration must stay exact");
  const owner = { skipCloudflare: true };
  assert.equal(betaInstallOptions(ctx, owner), owner);
});

test("invite removed from all child environments and not accepted/reflected in argv", t => {
  const { ctx } = fixture(t);
  assert.equal(ctx.childEnv.ASTRA_BETA_INVITE, undefined);
  assert.equal(takeInvite(ctx), TOKEN);
  assert.equal(ctx.env.ASTRA_BETA_INVITE, undefined);
  for (const args of [[TOKEN], ["--invite", TOKEN], ["--beta-invite=" + TOKEN], ["--unknown=" + TOKEN], ["--device-id", TOKEN]]) {
    assert.throws(() => parseArgs(args), error => !error.message.includes(TOKEN));
  }
  assert.equal(parseArgs(["--beta-enroll"]).opts.betaEnroll, true);
});

test("enrollment sends only agent public material over HTTPS; saves no secret or client key", async t => {
  const { ctx, opts, ui, s, output } = fixture(t);
  let calls = 0;
  await enrollBeta(ctx, opts, ui, s, TOKEN, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(String(url), BASE + "/beta/enroll");
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    const sent = JSON.parse(init.body);
    assert.equal(sent.version, 1);
    assert.equal(sent.deviceId, opts.deviceId);
    assert.equal(sent.agentPublicKeyB64, s.keys.agent);
    assert.deepEqual(Object.keys(sent).sort(), ["agentPublicKeyB64", "deviceId", "proof", "version"]);
    assert.equal(typeof sent.proof, "string");
    return Response.json({ ok: true }, { status: 201 });
  } });
  assert.equal(calls, 1);
  const state = fs.readFileSync(ctx.stateFile, "utf8");
  assert.ok(!state.includes(TOKEN));
  assert.ok(!state.includes("never send"));
  assert.ok(!output.join(" ").includes(TOKEN));
  assert.equal(readState(ctx).betaEnrollment.registered, true);
  assert.equal(fs.existsSync(ctx.personalConfig), false);
  assert.equal(fs.statSync(ctx.stateFile).mode & 0o777, 0o600);
  assert.throws(() => betaInstallOptions(ctx, {}), /beta installation/);
});

test("failed enrollment and server reflection are redacted; public pending state permits retry", async t => {
  const { ctx, opts, ui, s } = fixture(t);
  for (const fetchImpl of [async () => { throw new Error(TOKEN); }, async () => Response.json({ error: TOKEN }, { status: 403 }), async () => Response.json({ ok: true, bearer: TOKEN }, { status: 201 })]) {
    await assert.rejects(enrollBeta(ctx, opts, ui, s, TOKEN, { fetchImpl, probe: async () => ({ ok: false }) }), error => !error.message.includes(TOKEN));
  }
  assert.equal(readState(ctx).betaEnrollment.registered, false);
  assert.ok(!fs.readFileSync(ctx.stateFile, "utf8").includes(TOKEN));
});

test("lost enrollment response and rerun recover with agent signature without replaying invite", async t => {
  const { ctx, opts, ui, s } = fixture(t);
  await assert.rejects(enrollBeta(ctx, opts, ui, s, TOKEN, { fetchImpl: async () => { throw new Error("lost response"); } }));
  await enrollBeta(ctx, opts, ui, s, undefined, {
    probe: async () => ({ ok: true, agentConnected: false, mcpHealthy: false }),
    fetchImpl: async () => { throw new Error("must not enroll again"); },
    prompt: async () => { throw new Error("must not ask for a token again"); },
  });
  assert.equal(readState(ctx).betaEnrollment.registered, true);
  await assert.rejects(enrollBeta(ctx, opts, ui, s, TOKEN, { probe: async () => ({ ok: false }) }), /could not be verified/);
  assert.throws(() => betaInstallOptions(ctx, { ...opts, deviceId: "changed" }));
  assert.throws(() => betaInstallOptions(ctx, { ...opts, relayUrl: "https://other.example" }));
  await assert.rejects(enrollBeta(ctx, opts, ui, { keys: { agent: "changed" } }, TOKEN), /key changed/);
});

test("beta readiness probe signs only a status request with agent key and follows no redirect", async t => {
  const { key, keyFile } = fixture(t);
  const result = await probeBetaStatus(BASE, DEVICE, keyFile, { fetchImpl: async (url, init) => {
    assert.equal(url.pathname, `/beta/device/${DEVICE}/status`);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, undefined);
    const headers = init.headers;
    const canonical = [headers["X-Astra-Timestamp"], headers["X-Astra-Nonce"], "GET", url.pathname, createHash("sha256").update("").digest("hex")].join("\n");
    assert.ok(verify(null, Buffer.from(canonical), key.publicKey, Buffer.from(headers["X-Astra-Signature"], "base64")));
    return Response.json({ ok: true, agentConnected: true, mcpHealthy: true });
  } });
  assert.equal(result.ok && result.agentConnected && result.mcpHealthy, true);
});

test("oversize responses fail closed and exception output is redacted", async t => {
  const { ctx, opts, ui, s, keyFile } = fixture(t);
  await assert.rejects(enrollBeta(ctx, opts, ui, s, TOKEN, { fetchImpl: async () => new Response("x".repeat(2049)) }), /not confirmed/);
  const result = await probeBetaStatus(BASE, DEVICE, keyFile, { fetchImpl: async () => { throw new Error(TOKEN); } });
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test("hidden prompt never echoes secret and restores terminal on enter/cancel", async () => {
  for (const ending of ["\n", "\u0003"]) {
    const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    let text = "";
    const output = { write: value => { text += value; } };
    const pending = promptInvite({ interactive: true, release() {} }, input, output);
    input.write(TOKEN + ending);
    if (ending === "\n") assert.equal(await pending, TOKEN);
    else await assert.rejects(pending, /cancelled/);
    assert.equal(input.isRaw, false);
    assert.ok(!text.includes(TOKEN));
    input.destroy();
  }
});

test("relay-bound invite file requires exact origin, private permissions, bounded regular file and no symlink", t => {
  const { ctx } = fixture(t);
  const file = path.join(ctx.home, "invite.json");
  const artifact = { version: 1, relayOrigin: BASE, invite: TOKEN };
  fs.writeFileSync(file, JSON.stringify(artifact), { mode: 0o600 });
  assert.deepEqual(readInviteFile(file), { invite: TOKEN, relayUrl: BASE });
  assert.deepEqual(readInviteFile(file, BASE + "/"), { invite: TOKEN, relayUrl: BASE });
  assert.throws(() => readInviteFile(file, "https://other.example"), /matching relay/);
  fs.chmodSync(file, 0o644); assert.throws(() => readInviteFile(file)); fs.chmodSync(file, 0o600);
  fs.symlinkSync(file, file + ".link"); assert.throws(() => readInviteFile(file + ".link"));
  for (const data of [{ ...artifact, version: 2 }, { ...artifact, relayOrigin: BASE + "/path" }, { ...artifact, extra: true },
    { ...artifact, invite: "bad" }, { ...artifact, relayOrigin: "http://relay.example" }]) {
    fs.writeFileSync(file, JSON.stringify(data)); assert.throws(() => readInviteFile(file), error => !error.message.includes(TOKEN));
  }
  fs.writeFileSync(file, "x".repeat(2049)); assert.throws(() => readInviteFile(file));
  assert.equal(parseArgs(["--beta-enroll", "--invite-file", file]).opts.inviteFile, file);
  assert.throws(() => parseArgs(["--beta-enroll", "--device-id", "my-mac"]), /generated/);
  assert.equal(parseArgs(["--device-id", DEVICE]).opts.deviceId, DEVICE);
});

test("unconfirmed relay/device identity can be corrected with generated IDs; confirmed identity stays pinned", async t => {
  const { ctx, s, opts, ui } = fixture(t);
  await assert.rejects(enrollBeta(ctx, opts, ui, s, TOKEN, { fetchImpl: async () => Response.json({}, { status: 403 }) }), /already have been used/);
  writeState(ctx, { betaEnrollment: { ...readState(ctx).betaEnrollment, relayUrl: "https://typo.example" } });
  const correction = betaInstallOptions(ctx, { betaEnroll: true, relayUrl: BASE });
  assert.equal(correction.relayUrl, BASE);
  assert.equal(correction.deviceId, opts.deviceId, "old ID retained for signed recovery");
  const corrected = await recoverPendingBetaIdentity(ctx, correction, ui, s, { probe: async () => ({ status: 403 }) });
  assert.notEqual(corrected.deviceId, opts.deviceId);
  const reset = betaInstallOptions(ctx, { betaEnroll: true, resetPendingIdentity: true });
  assert.equal(reset.deviceId, corrected.deviceId);
  assert.throws(() => betaInstallOptions(ctx, { betaEnroll: true, deviceId: DEVICE }), /cannot use owner/);
  writeState(ctx, { betaEnrollment: { ...readState(ctx).betaEnrollment, registered: true } });
  assert.throws(() => betaInstallOptions(ctx, { betaEnroll: true, relayUrl: "https://correct.example" }), /confirmed/);
  assert.throws(() => betaInstallOptions(ctx, { betaEnroll: true, resetPendingIdentity: true }), /unconfirmed/);
  assert.equal(betaInstallOptions(ctx, { betaEnroll: true }).deviceId, corrected.deviceId);
});

test("status probe preserves 409/429 without trusting reflected body and unreadable key fails immediately", async t => {
  const { keyFile } = fixture(t);
  for (const status of [409, 429]) {
    const result = await probeBetaStatus(BASE, DEVICE, keyFile, { fetchImpl: async () => new Response(TOKEN, { status }) });
    assert.equal(result.ok, false); assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
  fs.rmSync(keyFile);
  assert.deepEqual(await probeBetaStatus(BASE, DEVICE, keyFile, { fetchImpl() { assert.fail("unreadable key cannot request"); } }),
    { ok: false, failure: "configuration", error: "beta_agent_key_unreadable" });
});

test("full fingerprint is displayed and PoP never enters saved state", async t => {
  const { ctx, opts, ui, s, key, output } = fixture(t);
  await enrollBeta(ctx, opts, ui, s, TOKEN, { fetchImpl: async () => Response.json({ ok: true }, { status: 201 }) });
  const fp = createHash("sha256").update(Buffer.from(s.keys.agent, "base64")).digest("hex");
  assert.ok(output.some(line => line.includes(fp)));
  assert.ok(output.some(line => line.includes(DEVICE)));
  const proof = signEnrollment(BASE, TOKEN, DEVICE, s.keys.agent, key.privateKey).proof;
  assert.ok(!fs.readFileSync(ctx.stateFile, "utf8").includes(proof));
});

// Same fixture prerequisites as the existing installer suite: current compiled
// commander configuration code, fake launchctl and an in-process fake relay.
// These tests never start the WebSocket agent; live socket verification is separate.
assert.equal(prerequisitesBuilt(), true, "beta e2e prerequisites are mandatory; run installer test preparation");
const args = ["--beta-enroll", "--legacy-invite", "--relay-url", BASE, "--skip-deps", "--yes", "--non-interactive"];

test("beta installer e2e: no email/login/deploy, file-only, agent readiness and idempotent registration", t => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  let r = sb.run(args, { ASTRA_BETA_INVITE: TOKEN }, { network: true });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Beta device setup complete/);
  assert.doesNotMatch(r.out, /Your email|--email|PRIVATE KEY/);
  assert.ok(!r.out.includes(TOKEN));
  assert.doesNotMatch(sb.calls(), /wrangler/);
  assert.equal(fs.existsSync(sb.personal), false);
  const config = JSON.parse(fs.readFileSync(path.join(sb.remoteDir, "remote.json"), "utf8"));
  assert.equal(config.trustedTerminal, false); assert.equal(config.trustedGui, false);
  const state = fs.readFileSync(path.join(sb.astraHome, "install-state.json"), "utf8");
  assert.ok(!state.includes(TOKEN));
  assert.ok(!fs.readFileSync(sb.plist, "utf8").includes(TOKEN));
  r = sb.run(args, {}, { network: true });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /existing beta registration verified/);
  r = sb.run(["doctor", "--offline"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /device registration/);
  assert.doesNotMatch(r.out, /personal config.*missing/);
  r = sb.run(["--enable-terminal", "--skip-deps", "--yes", "--non-interactive"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sb.remoteDir, "remote.json"), "utf8")).trustedTerminal, false);
});

test("beta installer e2e recovers lost response without a second invite or Cloudflare login", t => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  sb.flag("lose-enroll-response");
  let r = sb.run(args, { ASTRA_BETA_INVITE: TOKEN }, { network: true });
  assert.equal(r.status, 1, r.out);
  r = sb.run(args, {}, { network: true });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(sb.calls(), /wrangler/);
});

test("beta installer e2e cannot complete when signed readiness is rejected", t => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  fs.writeFileSync(path.join(sb.state, "status.json"), JSON.stringify({ ok: false, status: 403 }));
  const r = sb.run(args, { ASTRA_BETA_INVITE: TOKEN }, { network: true });
  assert.equal(r.status, 1, r.out);
  assert.doesNotMatch(r.out, /Beta device setup complete/);
  assert.doesNotMatch(sb.calls(), /wrangler/);
  const state = JSON.parse(fs.readFileSync(path.join(sb.astraHome, "install-state.json"), "utf8"));
  assert.ok(state.runtime.pending);
  assert.equal(state.betaEnrollment.registered, true, "registration alone is not runtime readiness");
});

test("invite-file e2e is relay-bound, secret-free, reduces unsafe remote config and gives beta uninstall guidance", t => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  const file = path.join(sb.state, "invite.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, relayOrigin: BASE, invite: TOKEN }), { mode: 0o600 });
  const fileArgs = ["--beta-enroll", "--invite-file", file, "--skip-deps", "--yes", "--non-interactive"];
  let r = sb.run([...fileArgs, "--relay-url", "https://wrong.example"], {}, { network: true });
  assert.equal(r.status, 1); assert.match(r.out, /matching relay origin/);
  r = sb.run(fileArgs, {}, { network: true }); assert.equal(r.status, 0, r.out);
  const configFile = path.join(sb.remoteDir, "remote.json");
  const original = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const extra = path.join(sb.state, "extra-root"); fs.mkdirSync(extra);
  fs.writeFileSync(configFile, JSON.stringify({ ...original, roots: [...original.roots, extra], trustedTerminal: true, trustedGui: true }));
  r = sb.run(["--beta-enroll", "--skip-deps", "--yes", "--non-interactive"], {}, { network: true });
  assert.equal(r.status, 0, r.out);
  const reduced = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.deepEqual(reduced.roots, original.roots); assert.equal(reduced.trustedTerminal, false); assert.equal(reduced.trustedGui, false);
  const state = fs.readFileSync(path.join(sb.astraHome, "install-state.json"), "utf8");
  for (const content of [r.out, state, sb.calls(), fs.readFileSync(sb.plist, "utf8"), fs.readFileSync(configFile, "utf8")]) assert.ok(!content.includes(TOKEN));
  const beta = JSON.parse(state).betaEnrollment;
  for (const command of [["uninstall", "--dry-run"], ["uninstall", "--purge", "--dry-run"]]) {
    r = sb.run(command); assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes(beta.deviceId));
    assert.ok(r.out.includes(createHash("sha256").update(Buffer.from(beta.agentPublicKeyB64, "base64")).digest("hex")));
    assert.match(r.out, /does not revoke|does NOT revoke/); assert.match(r.out, /--beta-enroll --invite-file/);
    assert.doesNotMatch(r.out, /generate new keys and redeploy|Settings → Delete/);
  }
  r = sb.run(["uninstall", "--purge", "--yes", "--non-interactive"]);
  assert.equal(r.status, 0, r.out); assert.doesNotMatch(r.out, /generate new keys and redeploy/);
});

test("uninstall never invents a fingerprint for missing or invalid saved beta keys, including pending rotation", t => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  const installed = sb.run(args, { ASTRA_BETA_INVITE: TOKEN }, { network: true });
  assert.equal(installed.status, 0, installed.out);
  const stateFile = path.join(sb.astraHome, "install-state.json");
  const original = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  for (const key of [undefined, "", "not-a-key", Buffer.alloc(44).toString("base64")]) {
    const state = { ...original, betaEnrollment: { ...original.betaEnrollment,
      registered: false, rotationRequired: key === undefined, agentPublicKeyB64: key } };
    const saved = JSON.stringify(state);
    fs.writeFileSync(stateFile, saved);
    for (const command of [["uninstall", "--dry-run"], ["uninstall", "--purge", "--dry-run"]]) {
      const result = sb.run(command);
      assert.equal(result.status, 0, result.out);
      assert.ok(result.out.includes(state.betaEnrollment.deviceId));
      assert.match(result.out, /fingerprint unavailable/);
      if (key === undefined) assert.match(result.out, /pending key rotation/);
      assert.doesNotMatch(result.out, /agent SHA-256|\b[a-f0-9]{64}\b/);
      assert.match(result.out, /operator to revoke device/);
      assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
    }
  }
});

test("environment invite requires explicit warned compatibility opt-in", t => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  const r = sb.run(["--beta-enroll", "--relay-url", BASE, "--skip-deps", "--yes", "--non-interactive"], { ASTRA_BETA_INVITE: TOKEN }, { network: true });
  assert.equal(r.status, 1); assert.match(r.out, /legacy exposure risk/); assert.ok(!r.out.includes(TOKEN));
});
