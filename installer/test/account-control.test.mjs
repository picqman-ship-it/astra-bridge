import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../astra-macos.mjs";

test("permissions command is separate from install and accepts explicit capability changes", () => {
  assert.equal(parseArgs(["permissions", "--enable-terminal"]).command, "permissions");
  assert.equal(parseArgs(["permissions", "--enable-terminal"]).opts.enableTerminal, true);
  assert.equal(parseArgs(["permissions", "--enable-gui"]).opts.enableGui, true);
  assert.equal(parseArgs(["permissions", "--disable-terminal"]).opts.disableTerminal, true);
  assert.equal(parseArgs(["permissions", "--disable-gui"]).opts.disableGui, true);
  assert.equal(parseArgs(["permissions", "--file-only"]).opts.fileOnly, true);
});

test("permissions command rejects contradictory or unrelated enrollment flags", () => {
  assert.throws(() => parseArgs(["permissions", "--enable-terminal", "--disable-terminal"]));
  assert.throws(() => parseArgs(["permissions", "--enable-gui", "--disable-gui"]));
  assert.throws(() => parseArgs(["permissions", "--account-pair"]));
  assert.throws(() => parseArgs(["permissions", "--beta-enroll"]));
});

import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { loadCommanderConfig, runSetup } from "../lib/commander.mjs";
import { createContext } from "../lib/context.mjs";
import { changeAccountPermissions, permissionPlan } from "../lib/account-control.mjs";
import { readState, writeState } from "../lib/state.mjs";
import { makeSandbox, prerequisitesBuilt, tmpDir } from "./helpers.mjs";

const CONTROL_DEVICE = "beta-11111111-2222-4333-8444-555555555555";
const CONTROL_RELAY = "https://relay.example";
const ID_FP = "b".repeat(64);

function controlFixture(t, current = { terminalEnabled: false, guiEnabled: false }) {
  const home = tmpDir("astra-control-test-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ctx = createContext({ repoDir: path.join(home, "checkout"), env: { HOME: home } });
  fs.mkdirSync(ctx.astraHome, { recursive: true, mode: 0o700 });
  const agent = generateKeyPairSync("ed25519");
  const client = generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(ctx.astraHome, "agent-private.pem"), agent.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(path.join(ctx.astraHome, "client-private.pem"), client.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const agentPublicKeyB64 = agent.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const FP = createHash("sha256").update(Buffer.from(agentPublicKeyB64, "base64")).digest("hex");
  writeState(ctx, { accountPairing: { relayUrl: CONTROL_RELAY, deviceId: CONTROL_DEVICE, agentPublicKeyB64, registered: true } });
  let local = { ...current };
  let server = { ...current };
  let permissionRequest = null;
  const events = [];
  const ui = {
    warn: x => events.push(`warn:${x}`), write: x => events.push(`write:${x}`),
    heading: x => events.push(`heading:${x}`), info: x => events.push(`info:${x}`), ok: x => events.push(`ok:${x}`),
    danger: lines => { events.push("danger"); events.push(...lines.map(line => `danger:${line}`)); }, typed: async () => { events.push("typed"); return true; },
    confirm: async () => { events.push("confirm"); return true; },
  };
  const statusBody = () => ({ ok: true, deviceId: CONTROL_DEVICE, accountEmail: "owner@example.com",
    identityIssuer: "https://team.cloudflareaccess.com", identityFingerprint: ID_FP, agentFingerprint: FP,
    terminalEnabled: server.terminalEnabled, guiEnabled: server.guiEnabled });
  const deps = {
    loadConfig: async () => ({ exists: true, raw: { trustedTerminal: local.terminalEnabled, trustedGui: local.guiEnabled },
      cfg: { trustedTerminal: local.terminalEnabled, trustedGui: local.guiEnabled } }),
    updateConfig: async (_ctx, _raw, target) => {
      events.push(`local:${target.terminal ? 1 : 0}${target.gui ? 1 : 0}`);
      local = { terminalEnabled: Boolean(target.terminal), guiEnabled: Boolean(target.gui) };
      return {};
    },
    restart: async target => { events.push(`restart:${target.terminalEnabled ? 1 : 0}${target.guiEnabled ? 1 : 0}`); return true; },
    enableJobs: async () => events.push("enableJobs"),
    stopJobs: async () => events.push("stopJobs"),
    stopRuntime: async () => events.push("stopRuntime"),
    guiCheck: () => ({ ok: true }),
    request: async (action, options = {}) => {
      events.push(`server:${action}`);
      if (action === "status") return { status: 200, data: statusBody() };
      const body = options.body;
      if (action === "start") {
        permissionRequest = { ok: true, deviceId: CONTROL_DEVICE, requestId: body.requestId,
          status: "pending", accountEmail: "owner@example.com", identityIssuer: "https://team.cloudflareaccess.com",
          identityFingerprint: ID_FP, agentFingerprint: FP, previousTerminal: server.terminalEnabled, previousGui: server.guiEnabled,
          requestedTerminal: body.terminalEnabled, requestedGui: body.guiEnabled, terminalEnabled: server.terminalEnabled,
          guiEnabled: server.guiEnabled, expiresAtMs: Date.now() + 60_000 };
        return { status: 201, data: { ...permissionRequest } };
      }
      if (action === "request-status") return permissionRequest
        ? { status: 200, data: { ...permissionRequest, terminalEnabled: server.terminalEnabled, guiEnabled: server.guiEnabled } }
        : { status: 404, data: { error: "not_found" } };
      if (action === "apply") {
        server = { terminalEnabled: body.terminalEnabled, guiEnabled: body.guiEnabled };
        permissionRequest = { ...permissionRequest, status: "applied", terminalEnabled: server.terminalEnabled, guiEnabled: server.guiEnabled };
        return { status: 200, data: { ok: true, deviceId: CONTROL_DEVICE, requestId: body.requestId,
          status: "applied", terminalEnabled: server.terminalEnabled, guiEnabled: server.guiEnabled } };
      }
      if (action === "cancel") {
        permissionRequest = permissionRequest ? { ...permissionRequest, status: "cancelled" } : permissionRequest;
        return { status: 200, data: { ok: true, deviceId: CONTROL_DEVICE, requestId: body.requestId, status: "cancelled" } };
      }
      throw new Error(`unexpected action ${action}`);
    },
  };
  return { ctx, ui, deps, events, FP, setLocal: value => { local = { ...value }; }, setServer: value => { server = { ...value }; }, state: () => ({ local: { ...local }, server: { ...server } }) };
}

test("permission planning refuses mixed elevation/reduction and mismatched state except file-only", () => {
  assert.throws(() => permissionPlan(
    { terminalEnabled: true, guiEnabled: false }, { terminalEnabled: true, guiEnabled: false },
    { disableTerminal: true, enableGui: true },
  ), /mix permission elevation and reduction/);
  assert.throws(() => permissionPlan(
    { terminalEnabled: false, guiEnabled: false }, { terminalEnabled: true, guiEnabled: false },
    { enableGui: true },
  ), /differ/);
  assert.deepEqual(permissionPlan(
    { terminalEnabled: false, guiEnabled: false }, { terminalEnabled: true, guiEnabled: true }, { fileOnly: true },
  ).target, { terminalEnabled: false, guiEnabled: false });
});

test("terminal elevation verifies local runtime before server authority is enabled", async t => {
  const f = controlFixture(t);
  await changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps);
  assert.deepEqual(f.state(), {
    local: { terminalEnabled: true, guiEnabled: false }, server: { terminalEnabled: true, guiEnabled: false },
  });
  const i = name => f.events.indexOf(name);
  assert.ok(i("typed") > i("server:start"));
  assert.ok(i("enableJobs") > i("typed"));
  assert.ok(i("local:10") > i("enableJobs"));
  assert.ok(i("restart:10") > i("local:10"));
  assert.ok(i("server:apply") > i("restart:10"), f.events.join(" -> "));
});

test("terminal reduction removes server authority before local shutdown/config change", async t => {
  const f = controlFixture(t, { terminalEnabled: true, guiEnabled: false });
  await changeAccountPermissions(f.ctx, { disableTerminal: true }, f.ui, f.deps);
  assert.deepEqual(f.state(), {
    local: { terminalEnabled: false, guiEnabled: false }, server: { terminalEnabled: false, guiEnabled: false },
  });
  const i = name => f.events.indexOf(name);
  assert.ok(i("server:apply") > i("confirm"));
  assert.ok(i("stopJobs") > i("server:apply"));
  assert.ok(i("local:00") > i("stopJobs"));
  assert.ok(i("restart:00") > i("local:00"));
});

test("GUI elevation is refused before a server request when Accessibility is not ready", async t => {
  const f = controlFixture(t);
  f.deps.guiCheck = () => ({ ok: false, trusted: false });
  await assert.rejects(changeAccountPermissions(f.ctx, { enableGui: true }, f.ui, f.deps), /Accessibility is not ready/);
  assert.deepEqual(f.events.filter(x => x.startsWith("server:")), ["server:status"]);
});

test("failed server elevation rolls local permissions back and disables newly enabled jobs", async t => {
  const f = controlFixture(t);
  const baseRequest = f.deps.request;
  f.deps.request = async (action, options) => action === "apply"
    ? (f.events.push("server:apply"), { status: 409, data: { error: "control_denied" } })
    : baseRequest(action, options);
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /not applied/);
  assert.deepEqual(f.state().local, { terminalEnabled: false, guiEnabled: false });
  assert.equal(f.state().server.terminalEnabled, false);
  assert.ok(f.events.filter(x => x === "stopJobs").length >= 1);
  assert.ok(f.events.includes("restart:00"));
});


test("lost start response recovers the exact pending request instead of creating another grant", async t => {
  const f = controlFixture(t);
  const base = f.deps.request;
  let lost = false;
  f.deps.request = async (action, options) => {
    if (action === "start" && !lost) {
      lost = true;
      await base(action, options);
      throw new Error("synthetic lost start response");
    }
    return base(action, options);
  };
  await changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps);
  assert.deepEqual(f.state(), {
    local: { terminalEnabled: true, guiEnabled: false }, server: { terminalEnabled: true, guiEnabled: false },
  });
  assert.equal(f.events.filter(x => x === "server:start").length, 1);
  assert.ok(f.events.includes("server:request-status"));
});

test("lost apply response recovers applied server state without undoing verified local consent", async t => {
  const f = controlFixture(t);
  const base = f.deps.request;
  let lost = false;
  f.deps.request = async (action, options) => {
    if (action === "apply" && !lost) {
      lost = true;
      await base(action, options);
      throw new Error("synthetic lost apply response");
    }
    return base(action, options);
  };
  await changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps);
  assert.deepEqual(f.state(), {
    local: { terminalEnabled: true, guiEnabled: false }, server: { terminalEnabled: true, guiEnabled: false },
  });
  assert.equal(f.events.filter(x => x === "local:00").length, 0, f.events.join(" -> "));
  assert.ok(f.events.includes("server:request-status"));
});

test("unknown apply outcome rolls elevation back locally when signed request status is unavailable", async t => {
  const f = controlFixture(t);
  const base = f.deps.request;
  f.deps.request = async (action, options) => {
    if (action === "apply") throw new Error("synthetic unknown apply");
    if (action === "request-status") throw new Error("synthetic status unavailable");
    return base(action, options);
  };
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /synthetic unknown apply/);
  assert.deepEqual(f.state().local, { terminalEnabled: false, guiEnabled: false });
  assert.ok(f.events.includes("restart:00"));
});

test("GUI elevation rechecks Accessibility after restart before server authority is applied", async t => {
  const f = controlFixture(t);
  let checks = 0;
  f.deps.guiCheck = () => ({ ok: ++checks === 1 });
  await assert.rejects(changeAccountPermissions(f.ctx, { enableGui: true }, f.ui, f.deps), /Accessibility was not verified after restart/);
  assert.deepEqual(f.state(), {
    local: { terminalEnabled: false, guiEnabled: false }, server: { terminalEnabled: false, guiEnabled: false },
  });
  assert.equal(f.events.filter(x => x === "server:apply").length, 0);
  assert.ok(f.events.includes("restart:00"));
});


test("file-only repairs locally enabled permissions without a no-op server request", async t => {
  const f = controlFixture(t);
  f.setLocal({ terminalEnabled: true, guiEnabled: true });
  const base = f.deps.request;
  f.deps.request = async (action, options) => action === "start"
    ? (f.events.push("server:start"), { status: 409, data: { error: "control_conflict" } })
    : base(action, options);
  await changeAccountPermissions(f.ctx, { fileOnly: true }, f.ui, f.deps);
  assert.deepEqual(f.state(), { local: { terminalEnabled: false, guiEnabled: false }, server: { terminalEnabled: false, guiEnabled: false } });
  assert.equal(f.events.includes("server:start"), false);
  assert.ok(f.events.includes("stopJobs"));
  assert.ok(f.events.includes("restart:00"));
});

test("interrupted elevation cannot bypass local review through matching configured state", async t => {
  const f = controlFixture(t, { terminalEnabled: true, guiEnabled: false });
  writeState(f.ctx, { accountControl: { version: 1, pending: "local_elevation", terminalEnabled: true, guiEnabled: false } });
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /file-only/);
  assert.equal(f.events.some(event => event.startsWith("ok:")), false);
});

test("matching enabled configuration without a completed local review cannot count as active", async t => {
  const f = controlFixture(t, { terminalEnabled: true, guiEnabled: false });
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /file-only/);
  assert.equal(f.events.some(event => event.startsWith("ok:")), false);
});

test("unchanged file-only configuration still needs a verified running restart", async t => {
  const f = controlFixture(t);
  f.deps.restart = async () => { f.events.push("restart:00"); return false; };
  await assert.rejects(changeAccountPermissions(f.ctx, { fileOnly: true }, f.ui, f.deps), /restart/);
  assert.ok(f.events.includes("restart:00"));
});

test("server Mac fingerprint must match the locally decoded SPKI key before consent", async t => {
  const f = controlFixture(t);
  const base = f.deps.request;
  f.deps.request = async (action, options) => {
    const result = await base(action, options);
    if (action === "status") result.data.agentFingerprint = "c".repeat(64);
    return result;
  };
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /key|fingerprint/);
  assert.equal(f.events.includes("server:start"), false);
});

test("preview must match the current exact issuer and subject fingerprint", async t => {
  const f = controlFixture(t);
  const base = f.deps.request;
  f.deps.request = async (action, options) => {
    const result = await base(action, options);
    if (action === "start") result.data.identityFingerprint = "c".repeat(64);
    return result;
  };
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /preview/);
  assert.ok(f.events.includes("server:cancel"));
  assert.equal(f.events.includes("typed"), false);
});

test("expired preview is cancelled before typed consent or local configuration changes", async t => {
  const f = controlFixture(t);
  const base = f.deps.request;
  f.deps.request = async (action, options) => {
    const result = await base(action, options);
    if (action === "start") result.data.expiresAtMs = Date.now() - 1;
    return result;
  };
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /preview|expired/);
  assert.ok(f.events.includes("server:cancel"));
  assert.equal(f.events.includes("typed"), false);
});

test("local consent displays the exact identity fingerprint and remote-shell warning", async t => {
  const f = controlFixture(t);
  await changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps);
  assert.ok(f.events.includes(`info:identity SHA-256 (issuer + subject): ${ID_FP}`));
  assert.ok(f.events.some(event => event.startsWith("danger:") && /remote shell/i.test(event)));
  assert.ok(f.events.some(event => event.startsWith("danger:") && /GUI.*isolation|isolation.*GUI/i.test(event)));
});

test("interrupted consent cancels its pending request and never changes local config", async t => {
  const f = controlFixture(t);
  f.ui.typed = async () => { f.events.push("typed"); throw new Error("synthetic interrupted prompt"); };
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /interrupted prompt/);
  assert.ok(f.events.includes("server:cancel"));
  assert.equal(f.events.some(event => event.startsWith("local:")), false);
});

test("file-only revokes local control even when the permission service is unavailable", async t => {
  const f = controlFixture(t, { terminalEnabled: true, guiEnabled: true });
  f.deps.request = async action => { f.events.push(`server:${action}`); throw new Error("synthetic service unavailable"); };
  await assert.rejects(changeAccountPermissions(f.ctx, { fileOnly: true }, f.ui, f.deps), /unavailable|unverified/);
  assert.deepEqual(f.state().local, { terminalEnabled: false, guiEnabled: false });
  assert.ok(f.events.includes("restart:00"));
});

test("rejected reduction removes local authority and leaves server recovery explicit", async t => {
  const f = controlFixture(t, { terminalEnabled: true, guiEnabled: false });
  const base = f.deps.request;
  f.deps.request = async (action, options) => action === "apply"
    ? { status: 409, data: { error: "control_denied" } } : base(action, options);
  await assert.rejects(changeAccountPermissions(f.ctx, { disableTerminal: true }, f.ui, f.deps), /not applied|unverified/);
  assert.deepEqual(f.state().local, { terminalEnabled: false, guiEnabled: false });
  assert.ok(f.events.includes("server:cancel"));
  assert.ok(f.events.includes("restart:00"));
});

test("failed tracked-job shutdown still persists reduced local config and verifies restart", async t => {
  const f = controlFixture(t, { terminalEnabled: true, guiEnabled: false });
  f.deps.stopJobs = async () => { f.events.push("stopJobs"); throw new Error("synthetic shutdown unconfirmed"); };
  await assert.rejects(changeAccountPermissions(f.ctx, { disableTerminal: true }, f.ui, f.deps), /shutdown unconfirmed/);
  assert.deepEqual(f.state().local, { terminalEnabled: false, guiEnabled: false });
  assert.ok(f.events.includes("restart:00"));
});

test("final exact account identity drift rolls local elevation back", async t => {
  const f = controlFixture(t);
  const base = f.deps.request;
  let statusCalls = 0;
  f.deps.request = async (action, options) => {
    const result = await base(action, options);
    if (action === "status" && ++statusCalls > 1) result.data.identityFingerprint = "c".repeat(64);
    return result;
  };
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /final permission verification/);
  assert.deepEqual(f.state().local, { terminalEnabled: false, guiEnabled: false });
});

test("rolled-back elevation cancels its stale pending request", async t => {
  const f = controlFixture(t);
  f.deps.restart = async target => { f.events.push(`restart:${target.terminalEnabled ? 1 : 0}${target.guiEnabled ? 1 : 0}`); return !target.terminalEnabled; };
  await assert.rejects(changeAccountPermissions(f.ctx, { enableTerminal: true }, f.ui, f.deps), /restart/);
  assert.ok(f.events.includes("server:cancel"));
});


test("install command cannot restart an interrupted account permission transaction", t => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  fs.mkdirSync(sb.astraHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sb.astraHome, "install-state.json"), JSON.stringify({
    accountPairing: { registered: true, deviceId: CONTROL_DEVICE, relayUrl: "https://astra-bridge-relay.example-sub.workers.dev" },
    accountControl: { version: 1, pending: "elevation" },
  }), { mode: 0o600 });
  const result = sb.run(["--account-pair", "--non-interactive", "--yes", "--skip-deps"], {}, { network: true });
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /interrupted permission change.*permissions --file-only/s);
  assert.equal(sb.calls(), "", "installer must stop before launchd or Cloudflare work");
});


test("failed file-only restart invokes runtime shutdown after persisting config off", async t => {
  const f = controlFixture(t);
  f.setLocal({ terminalEnabled: true, guiEnabled: false });
  f.deps.restart = async () => false;
  await assert.rejects(changeAccountPermissions(f.ctx, { fileOnly: true }, f.ui, f.deps), /restart/);
  assert.deepEqual(f.state().local, { terminalEnabled: false, guiEnabled: false });
  assert.ok(f.events.indexOf("stopRuntime") > f.events.indexOf("local:00"));
  assert.ok(readState(f.ctx).accountControl.pending);
});

test("synthetic signed HTTP control runs real config updates and fake launchd readiness", async t => {
  assert.ok(prerequisitesBuilt(), "compiled commander and relay dependencies are mandatory");
  const f = controlFixture(t);
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const ctx = createContext({ repoDir: sb.repo, env: sb.env });
  fs.mkdirSync(ctx.astraHome, { recursive: true, mode: 0o700 });
  for (const file of ["agent-private.pem", "client-private.pem"]) fs.copyFileSync(path.join(f.ctx.astraHome, file), path.join(ctx.astraHome, file));
  const paired = readState(f.ctx).accountPairing;
  writeState(ctx, { accountPairing: paired });
  const workspace = path.join(sb.home, "remote-workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const setup = runSetup(ctx, { workspace });
  assert.equal(setup.status, 0, setup.stderr);
  const initialConfig = JSON.parse(fs.readFileSync(ctx.remoteConfigFile, "utf8"));
  const oldFetch = globalThis.fetch;
  const oldFakeState = process.env.FAKE_STATE_DIR;
  process.env.FAKE_STATE_DIR = sb.state;
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldFakeState === undefined) delete process.env.FAKE_STATE_DIR; else process.env.FAKE_STATE_DIR = oldFakeState;
  });
  const publicKey = createPublicKey({ key: Buffer.from(paired.agentPublicKeyB64, "base64"), type: "spki", format: "der" });
  const nonces = new Set();
  const base = f.deps.request;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, CONTROL_RELAY);
    assert.equal(url.search, "");
    assert.ok(["error", "manual"].includes(init.redirect));
    const payload = init.body ?? Buffer.alloc(0);
    const headers = init.headers;
    const canonical = [headers["X-Astra-Timestamp"], headers["X-Astra-Nonce"], init.method ?? "GET", url.pathname,
      createHash("sha256").update(payload).digest("hex")].join("\n");
    assert.equal(verify(null, Buffer.from(canonical), publicKey, Buffer.from(headers["X-Astra-Signature"], "base64")), true);
    assert.equal(nonces.has(headers["X-Astra-Nonce"]), false);
    nonces.add(headers["X-Astra-Nonce"]);
    if (url.pathname === `/beta/device/${CONTROL_DEVICE}/status`) {
      return Response.json({ ok: true, agentConnected: true, mcpHealthy: true });
    }
    const action = url.pathname.split("/").at(-1);
    assert.ok(["status", "start", "apply", "cancel"].includes(action));
    if (action === "apply" && JSON.parse(payload).terminalEnabled) {
      assert.equal(readState(ctx).accountControl.pending, "elevation", "runtime verification must not clear consent transaction");
      assert.equal(readState(ctx).runtime.pending, null);
    }
    const result = await base(action, payload.length ? { body: JSON.parse(payload) } : {});
    return Response.json(result.data, { status: result.status });
  };
  await changeAccountPermissions(ctx, { enableTerminal: true }, f.ui);
  let cfg = await loadCommanderConfig(ctx);
  assert.equal(cfg.cfg.trustedTerminal, true);
  assert.equal(cfg.cfg.trustedGui, false);
  assert.deepEqual(cfg.raw.roots, initialConfig.roots);
  assert.deepEqual(cfg.raw.blockedCommands, initialConfig.blockedCommands);
  assert.equal(readState(ctx).accountControl.pending, null);
  assert.equal(readState(ctx).runtime.pending, null);
  assert.ok(sb.calls().includes("launchctl bootstrap"));
  await changeAccountPermissions(ctx, { fileOnly: true }, f.ui);
  cfg = await loadCommanderConfig(ctx);
  assert.equal(cfg.cfg.trustedTerminal, false);
  assert.equal(cfg.cfg.trustedGui, false);
  assert.equal(readState(ctx).accountControl.pending, null);
  assert.equal(readState(ctx).runtime.pending, null);
  assert.equal(fs.statSync(ctx.remoteConfigFile).mode & 0o777, 0o600);
});


test("no-op file-only always stops stale tracked jobs even when both configurations are off", async t => {
  const f = controlFixture(t);
  f.deps.stopJobs = async () => { f.events.push("stopJobs"); throw new Error("synthetic stale tracked jobs unconfirmed"); };
  await assert.rejects(changeAccountPermissions(f.ctx, { fileOnly: true }, f.ui, f.deps), /stale tracked jobs unconfirmed/);
  assert.ok(f.events.includes("stopJobs"));
  assert.ok(f.events.includes("restart:00"));
  assert.ok(readState(f.ctx).accountControl.pending);
});

test("server file-only reduction always stops stale tracked jobs with local flags already off", async t => {
  const f = controlFixture(t);
  f.setServer({ terminalEnabled: true, guiEnabled: false });
  f.deps.stopJobs = async () => { f.events.push("stopJobs"); throw new Error("synthetic stale tracked jobs unconfirmed"); };
  await assert.rejects(changeAccountPermissions(f.ctx, { fileOnly: true }, f.ui, f.deps), /stale tracked jobs unconfirmed/);
  assert.ok(f.events.includes("stopJobs"));
  assert.deepEqual(f.state().server, { terminalEnabled: false, guiEnabled: false });
  assert.ok(f.events.includes("restart:00"));
});
