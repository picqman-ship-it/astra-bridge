import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { createContext } from "../lib/context.mjs";
import {
  accountPairInstallOptions as rawAccountPairInstallOptions,
  pairAccount,
  signPairStart,
} from "../lib/account-pairing.mjs";
import { assertTrustedBetaRelay } from "../lib/beta-trust.mjs";
import { readState, writeState } from "../lib/state.mjs";
import { parseArgs } from "../astra-macos.mjs";
import { tmpDir } from "./helpers.mjs";

const BASE = "https://astra-bridge-relay.example-sub.workers.dev";
const DEVICE = "beta-00000000-0000-4000-8000-000000000001";
const TOKEN = "ap1_" + "a".repeat(64);
const trust = origin => assertTrustedBetaRelay(origin, BASE);
const accountPairInstallOptions = (ctx, opts) => rawAccountPairInstallOptions(ctx, opts, { trust, pinnedOrigin: BASE });

function fixture(t) {
  const home = tmpDir("astra-account-pair-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ctx = createContext({ repoDir: path.join(home, "checkout"), env: { HOME: home } });
  fs.mkdirSync(ctx.astraHome, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  fs.writeFileSync(
    path.join(ctx.astraHome, "agent-private.pem"),
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const agent = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const output = [];
  const ui = { ok: x => output.push(String(x)), info: x => output.push(String(x)) };
  return {
    ctx, keys, output, ui,
    s: { keys: { agent, client: "client-must-not-leak" } },
    opts: { accountPair: true, relayUrl: BASE, deviceId: DEVICE, fileOnly: true, skipCloudflare: true },
  };
}

test("CLI exposes account-pair as a separate generated-device enrollment mode", () => {
  assert.equal(parseArgs(["--account-pair"]).opts.accountPair, true);
  assert.throws(() => parseArgs(["--account-pair", "--beta-enroll"]), /separate enrollment modes/);
  assert.throws(() => parseArgs(["--account-pair", "--invite-file", "/tmp/invite.json"]), /cannot use beta invite/);
  assert.throws(() => parseArgs(["--account-pair", "--legacy-invite"]), /cannot use beta invite/);
  assert.throws(() => parseArgs(["--account-pair", "--reset-pending-identity"]), /cannot use beta invite/);
  assert.throws(() => parseArgs(["--account-pair", "--device-id", "chosen"]), /generated/);
});

test("account pairing options pin relay, force file-only and never allow owner/control setup", t => {
  const { ctx } = fixture(t);
  const opts = accountPairInstallOptions(ctx, { accountPair: true });
  assert.equal(opts.relayUrl, BASE);
  assert.equal(opts.skipCloudflare, true);
  assert.equal(opts.fileOnly, true);
  assert.match(opts.deviceId, /^beta-[a-f0-9-]{36}$/);

  for (const flag of ["enableTerminal", "enableGui", "redeploy", "replaceExistingWorker", "email",
    "accountId", "teamDomain", "policyAud", "workerName", "noNetworkChecks"]) {
    assert.throws(() => accountPairInstallOptions(ctx, { accountPair: true, [flag]: true }));
  }
  assert.throws(() => accountPairInstallOptions(ctx, { accountPair: true, betaEnroll: true }), /separate enrollment modes/);
  assert.throws(() => rawAccountPairInstallOptions(ctx, { accountPair: true, relayUrl: "https://evil.example" }, {
    trust, pinnedOrigin: BASE,
  }), /not trusted/);
});

test("pair-start proof is domain separated and signed by the Mac agent key", async t => {
  const { keys, s } = fixture(t);
  const requestId = "11111111-2222-4333-8444-555555555555";
  const body = signPairStart(BASE, requestId, DEVICE, s.keys.agent, keys.privateKey);
  assert.deepEqual(Object.keys(body).sort(), ["agentPublicKeyB64", "deviceId", "proof", "requestId", "version"]);
  const canonical = ["astra-pair-start-v1", BASE, requestId, DEVICE, s.keys.agent].join("\n");
  assert.equal(verify(null, Buffer.from(canonical), keys.publicKey, Buffer.from(body.proof, "base64")), true);
  const wrong = ["astra-pair-start-v1", "https://other.example", requestId, DEVICE, s.keys.agent].join("\n");
  assert.equal(verify(null, Buffer.from(wrong), keys.publicKey, Buffer.from(body.proof, "base64")), false);
});

test("installer account-pairing opens only validated claim URL, polls in memory, and saves no token", async t => {
  const { ctx, keys, ui, s, output } = fixture(t);
  const opts = accountPairInstallOptions(ctx, { accountPair: true, relayUrl: BASE });
  opts.deviceId = DEVICE;
  let now = 1_800_000_000_000;
  let statusCalls = 0;
  let opened = null;

  const fetchImpl = async (url, init) => {
    if (url.pathname === "/pair/start") {
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["content-type"], "application/json");
      const body = JSON.parse(init.body);
      assert.equal(body.deviceId, DEVICE);
      assert.equal(body.agentPublicKeyB64, s.keys.agent);
      const canonical = ["astra-pair-start-v1", BASE, body.requestId, DEVICE, s.keys.agent].join("\n");
      assert.equal(verify(null, Buffer.from(canonical), keys.publicKey, Buffer.from(body.proof, "base64")), true);
      return Response.json({
        ok: true,
        deviceId: DEVICE,
        expiresAtMs: now + 600_000,
        claimUrl: BASE + "/pair/claim?token=" + TOKEN,
        pairingToken: TOKEN,
      }, { status: 201 });
    }
    if (url.pathname === "/pair/status") {
      assert.equal(init.headers.authorization, "Bearer " + TOKEN);
      statusCalls++;
      return Response.json({ status: statusCalls === 1 ? "pending" : "claimed", deviceId: DEVICE });
    }
    throw new Error("unexpected request " + url);
  };

  await pairAccount(ctx, opts, ui, s, {
    fetchImpl,
    openBrowser: async url => { opened = url; return true; },
    wait: async () => { now += 2000; },
    clock: () => now,
    probe: async () => ({ ok: false, status: 403 }),
  });

  assert.equal(opened, BASE + "/pair/claim?token=" + TOKEN);
  assert.equal(statusCalls, 2);
  assert.equal(readState(ctx).accountPairing.registered, true);
  const state = fs.readFileSync(ctx.stateFile, "utf8");
  assert.equal(state.includes(TOKEN), false);
  assert.equal(state.includes("client-must-not-leak"), false);
  assert.equal(output.join(" ").includes(TOKEN), false);
  assert.equal(s.accountPaired, true);
  assert.equal(s.beta, true);
});

test("rerun recovers completed pairing by signed device status without creating another session", async t => {
  const { ctx, ui, s } = fixture(t);
  writeState(ctx, { accountPairing: {
    relayUrl: BASE, deviceId: DEVICE, agentPublicKeyB64: s.keys.agent, registered: false,
  } });
  const opts = accountPairInstallOptions(ctx, { accountPair: true, relayUrl: BASE });
  await pairAccount(ctx, opts, ui, s, {
    fetchImpl: async () => { throw new Error("must not call pair endpoints after signed recovery"); },
    openBrowser: async () => { throw new Error("must not open browser"); },
    probe: async () => ({ ok: true, status: 200, agentConnected: false, mcpHealthy: false }),
  });
  assert.equal(readState(ctx).accountPairing.registered, true);

  await pairAccount(ctx, opts, ui, s, {
    fetchImpl: async () => { throw new Error("must not start pairing"); },
    probe: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(readState(ctx).accountPairing.registered, true);
});

test("pairing rejects reflected/mismatched relay responses and never persists the short-lived secret", async t => {
  const { ctx, ui, s, output } = fixture(t);
  const opts = { accountPair: true, relayUrl: BASE, deviceId: DEVICE, fileOnly: true, skipCloudflare: true };
  let now = 1_800_000_000_000;

  for (const bad of [
    { ok: true, deviceId: DEVICE, expiresAtMs: now + 600_000, claimUrl: "https://evil.example/pair/claim?token=" + TOKEN, pairingToken: TOKEN },
    { ok: true, deviceId: DEVICE, expiresAtMs: now + 600_000, claimUrl: BASE + "/pair/claim?token=" + "ap1_" + "b".repeat(64), pairingToken: TOKEN },
    { ok: true, deviceId: "beta-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", expiresAtMs: now + 600_000, claimUrl: BASE + "/pair/claim?token=" + TOKEN, pairingToken: TOKEN },
    { ok: true, deviceId: DEVICE, expiresAtMs: now + 700_000, claimUrl: BASE + "/pair/claim?token=" + TOKEN, pairingToken: TOKEN },
  ]) {
    await assert.rejects(pairAccount(ctx, opts, ui, s, {
      fetchImpl: async url => {
        if (url.pathname === "/pair/start") return Response.json(bad, { status: 201 });
        throw new Error("unexpected");
      },
      clock: () => now,
      probe: async () => ({ ok: false, status: 403 }),
      openBrowser: async () => true,
    }), /invalid response/);
    assert.equal(fs.readFileSync(ctx.stateFile, "utf8").includes(TOKEN), false);
  }
  assert.equal(output.join(" ").includes(TOKEN), false);
});

test("agent public-key fingerprint remains stable and pairing state is non-secret", t => {
  const { s } = fixture(t);
  const fp = createHash("sha256").update(Buffer.from(s.keys.agent, "base64")).digest("hex");
  assert.match(fp, /^[a-f0-9]{64}$/);
});