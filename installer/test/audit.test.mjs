import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { resolveAccount, ownsDeployment } from "../lib/account.mjs";
import { createContext } from "../lib/context.mjs";
import { agent, verifyCompletion } from "../lib/install.mjs";
import { createLaunchd } from "../lib/launchd.mjs";
import { uninstall } from "../lib/uninstall.mjs";
import { metadataFile } from "../lib/install-metadata.mjs";
import { inspectKeyDir, inspectKeys } from "../lib/keys.mjs";
import { readState, treeHash } from "../lib/state.mjs";
import { buildFingerprint, commanderBuildReason } from "../lib/deps.mjs";
import { nativeFingerprint } from "../../mcp-commander/scripts/native-fingerprint.mjs";
import { classifyAccess, probeAccess } from "../lib/relay-probe.mjs";
import { parseJsonc, setTopLevelString } from "../lib/jsonc.mjs";
import { readPersonalConfig, personalConfigProblem } from "../lib/wrangler-config.mjs";
import { createUi } from "../lib/ui.mjs";
import { Checkpoint, InstallerError, shQuote } from "../lib/util.mjs";
import { AUD, FAKE_ACCOUNT, makeSandbox, prerequisitesBuilt, tmpDir } from "./helpers.mjs";

const skip = prerequisitesBuilt() ? false : "build mcp-commander and install relay dependencies first";
const ACCOUNT_B = "b".repeat(32);
const ARGS = ["--non-interactive", "--skip-deps", "--yes", "--email", "owner@corp.test", "--team-domain", "myteam", "--policy-aud", AUD];
const offline = [...ARGS, "--no-network-checks"];
const boots = (sb) => (sb.calls().match(/launchctl bootstrap/g) ?? []).length;
const context = (sb, extra = {}) => createContext({ repoDir: sb.repo, env: { ...sb.env, ...extra } });
const ui = () => createUi({ interactive: false, yes: true, out: new PassThrough() });
const stateFor = (ctx) => {
  const k = inspectKeys(ctx.astraHome);
  const personal = readPersonalConfig(ctx.personalConfig);
  return { personal, relayUrl: personal.values.relayUrl, keys: { agent: k.agent.publicKeyB64, client: k.client.publicKeyB64 } };
};
const healthy = { ok: true, agentConnected: true, mcpHealthy: true, lastSeenAgeMs: 0 };

function fakeLaunchd() {
  let loaded = true;
  let restarts = 0;
  let pid = 4242;
  return { target: "gui/501/test", status: () => ({ loaded, state: loaded ? "running" : "unloaded", pid }),
    bootout: () => { loaded = false; return { status: 0 }; }, waitUnloaded: async () => !loaded,
    enable: () => ({ status: 0 }), bootstrap: () => { loaded = true; restarts++; pid++; return { status: 0 }; },
    waitRunning: async () => ({ loaded, state: "running", pid }), restarts: () => restarts };
}

test("effective account precedence and account-scoped ownership fail closed", () => {
  const accounts = [{ id: FAKE_ACCOUNT }, { id: ACCOUNT_B }];
  assert.equal(resolveAccount({ accounts: [accounts[0]] }), FAKE_ACCOUNT);
  assert.equal(resolveAccount({ accounts, configured: ACCOUNT_B, remembered: FAKE_ACCOUNT }), ACCOUNT_B);
  assert.equal(resolveAccount({ accounts, configured: ACCOUNT_B, env: { CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT } }), FAKE_ACCOUNT);
  assert.equal(resolveAccount({ accounts, explicit: ACCOUNT_B, env: { CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT } }), ACCOUNT_B);
  assert.equal(resolveAccount({ accounts, env: { CF_ACCOUNT_ID: ACCOUNT_B } }), ACCOUNT_B);
  assert.equal(resolveAccount({ accounts }), null);
  assert.throws(() => resolveAccount({ accounts, explicit: "bad" }), InstallerError);
  assert.throws(() => resolveAccount({ accounts: [accounts[0]], remembered: ACCOUNT_B }), Checkpoint);
  const deployment = { worker: "relay", accountId: FAKE_ACCOUNT };
  assert.equal(ownsDeployment(deployment, FAKE_ACCOUNT, "relay"), true);
  for (const [record, account, worker] of [[deployment, ACCOUNT_B, "relay"], [deployment, FAKE_ACCOUNT, "other"], [{ worker: "relay" }, FAKE_ACCOUNT, "relay"]]) assert.equal(ownsDeployment(record, account, worker), false);
  const text = '// { comment\n{ /* another { */ "name": "relay", "vars": {} }';
  const pinned = setTopLevelString(text, "account_id", FAKE_ACCOUNT);
  assert.equal(parseJsonc(pinned).account_id, FAKE_ACCOUNT);
  assert.ok(pinned.includes("/* another { */"));
});

test("switching accounts rechecks ownership even with an unchanged Worker name; lookup and deploy use identical account/config", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  assert.equal(sb.run(offline).status, 3);
  assert.equal(sb.deploys(), 1);
  fs.writeFileSync(path.join(sb.state, "accounts.json"), JSON.stringify({ accounts: [{ id: FAKE_ACCOUNT }, { id: ACCOUNT_B }] }));
  sb.flag("worker-exists");
  let r = sb.run([...offline, "--account-id", ACCOUNT_B], { CLOUDFLARE_ENV: "dangerous", CF_ACCOUNT_ID: FAKE_ACCOUNT });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /not replacing the existing Worker/);
  assert.equal(sb.deploys(), 1);
  r = sb.run([...offline, "--account-id", ACCOUNT_B, "--replace-existing-worker"]);
  assert.equal(r.status, 3, r.out);
  assert.equal(sb.deploys(), 2);
  const state = readState(context(sb));
  assert.equal(state.deploy.accountId, ACCOUNT_B);
  assert.equal(parseJsonc(fs.readFileSync(path.join(sb.state, "deployed-config.jsonc"), "utf8")).account_id, ACCOUNT_B);
  const accountCalls = fs.readFileSync(path.join(sb.state, "accounts.log"), "utf8").split("\n").filter((l) => /^(deploy|deployments) /.test(l));
  assert.ok(accountCalls.every((l) => /account=[a-f0-9]{32} env=unset$/.test(l)));
  assert.ok(accountCalls.filter((l) => l.includes(ACCOUNT_B)).length >= 4);
  assert.match(sb.calls(), /deployments list --name .* --json -c .*wrangler.personal.jsonc --env/);
  assert.equal(sb.run(offline).status, 3);
  assert.equal(sb.deploys(), 2, "same effective account is cached");
  // Config account overrides an old remembered selection even without a command-line flag.
  const config = fs.readFileSync(sb.personal, "utf8");
  fs.writeFileSync(sb.personal, setTopLevelString(config, "account_id", FAKE_ACCOUNT));
  r = sb.run(offline);
  assert.match(r.out, /not replacing the existing Worker/);
  assert.equal(sb.deploys(), 2);
});

test("lookup errors and legacy deployment records never authorize replacing a Worker", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  sb.flag("lookup-error");
  const r = sb.run(offline);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Could not check/);
  assert.equal(sb.deploys(), 0);
  sb.flag("lookup-error", false); sb.flag("empty-deployments");
  const empty = sb.run(offline);
  assert.equal(empty.status, 3, empty.out);
  assert.match(empty.out, /not replacing the existing Worker/);
  assert.equal(sb.deploys(), 0);
  sb.flag("empty-deployments", false);
  assert.equal(sb.run(offline).status, 3);
  assert.equal(sb.deploys(), 1);
  const ctx = context(sb);
  const legacy = readState(ctx); delete legacy.deploy.accountId;
  fs.writeFileSync(ctx.stateFile, JSON.stringify(legacy));
  sb.flag("worker-exists");
  const legacyRun = sb.run(offline);
  assert.equal(legacyRun.status, 3, legacyRun.out);
  assert.match(legacyRun.out, /not replacing the existing Worker/);
  assert.equal(sb.deploys(), 1, "an old accountless record grants no ownership");
});

test("file-only revocation survives interruption before restart and is applied only after resumed verified restart", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  let r = sb.run([...ARGS, "--enable-terminal"], {}, { network: true });
  assert.equal(r.status, 0, r.out);
  const ctx = context(sb);
  const old = readState(ctx).runtime.applied;
  const before = boots(sb);
  // A login checkpoint interrupts the run after the on-disk permissions were revoked.
  sb.flag("logged-out");
  r = sb.run([...ARGS, "--file-only"]);
  assert.equal(r.status, 3, r.out);
  assert.equal(JSON.parse(fs.readFileSync(ctx.remoteConfigFile)).trustedTerminal, false);
  assert.match(r.out, /previous permissions until restart is verified/);
  assert.equal(readState(ctx).runtime.applied, old);
  assert.ok(readState(ctx).runtime.pending);
  assert.equal(boots(sb), before);
  sb.flag("logged-out", false);
  // Resume with no file-only flag: config no longer differs, but the running process still does.
  r = sb.run(ARGS, {}, { network: true });
  assert.equal(r.status, 0, r.out);
  assert.equal(boots(sb), before + 1);
  assert.notEqual(readState(ctx).runtime.applied, old);
  assert.equal(readState(ctx).runtime.pending, null);
});

test("offline restarts cannot mark config/key/code inputs applied; every interrupted attempt retries", { skip }, async (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  assert.equal(sb.run(ARGS, {}, { network: true }).status, 0);
  const ctx = context(sb);
  const original = readState(ctx).runtime.applied;
  const remote = JSON.parse(fs.readFileSync(ctx.remoteConfigFile));
  remote.trustedTerminal = true;
  fs.writeFileSync(ctx.remoteConfigFile, JSON.stringify(remote));
  const oldBoots = boots(sb);
  assert.equal(sb.run(offline).status, 3);
  assert.equal(readState(ctx).runtime.applied, original);
  assert.ok(readState(ctx).runtime.pending);
  assert.equal(sb.run(offline).status, 3);
  assert.equal(boots(sb), oldBoots + 2);
  assert.equal(sb.run(ARGS, {}, { network: true }).status, 0);
  const configured = readState(ctx).runtime.applied;
  fs.appendFileSync(ctx.agentPath, "\n// audit code-only change\n");
  assert.equal(sb.run(ARGS, {}, { network: true }).status, 0);
  assert.notEqual(readState(ctx).runtime.applied, configured);
  const changedCode = readState(ctx).runtime.applied;
  for (const name of ["agent-private.pem", "client-private.pem"]) fs.rmSync(path.join(ctx.astraHome, name));
  assert.equal(sb.run(ARGS, {}, { network: true }).status, 0);
  assert.notEqual(readState(ctx).runtime.applied, changedCode);
});

test("disconnected, unhealthy, rejected and non-running agents never verify runtime changes", { skip }, async (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  assert.equal(sb.run(offline).status, 3);
  const ctx = context(sb);
  for (const [status, Type] of [[{ ok: true, agentConnected: false, mcpHealthy: false }, Checkpoint],
    [{ ok: true, agentConnected: true, mcpHealthy: false }, Checkpoint],
    [{ ok: false, error: "timeout" }, Checkpoint],
    [{ ok: false, status: 401, error: "unauthorized" }, InstallerError],
    [{ ok: false, status: 403, error: "wrong device" }, InstallerError],
    [{ ok: false, failure: "configuration" }, InstallerError]]) {
    const launchd = fakeLaunchd();
    await assert.rejects(agent(ctx, {}, ui(), stateFor(ctx), { makeLaunchd: () => launchd, wait: async () => {}, probeStatus: async () => status }), Type);
    assert.ok(readState(ctx).runtime.pending);
    assert.equal(readState(ctx).runtime.applied, undefined);
  }
  const failed = fakeLaunchd();
  failed.waitRunning = async () => ({ loaded: true, state: "exited" });
  await assert.rejects(agent(ctx, {}, ui(), stateFor(ctx), { makeLaunchd: () => failed, probeStatus: async () => { throw new Error("must not probe"); } }), Checkpoint);
  const rejected = fakeLaunchd();
  await assert.rejects(agent(ctx, {}, ui(), stateFor(ctx), { makeLaunchd: () => rejected, probeStatus: async () => {
    fs.appendFileSync(path.join(ctx.astraHome, "agent.stderr.log"), "[astra-bridge-agent] websocket rejected status=401\n");
    return { ...healthy, agentConnected: false };
  } }), /authentication or configuration failure/);
  const success = fakeLaunchd();
  const s = stateFor(ctx);
  await agent(ctx, {}, ui(), s, { makeLaunchd: () => success, probeStatus: async () => healthy });
  assert.equal(s.agentVerified, true);
  assert.equal(readState(ctx).runtime.pending, null);
  assert.equal(success.restarts(), 1);
  s.accessVerified = true;
  await verifyCompletion(ctx, s, { makeLaunchd: () => success, probeStatus: async () => healthy });
  for (const status of [{ ...healthy, agentConnected: false }, { ...healthy, mcpHealthy: false }]) {
    await assert.rejects(verifyCompletion(ctx, s, { makeLaunchd: () => success, probeStatus: async () => status }), Checkpoint);
  }
  await assert.rejects(verifyCompletion(ctx, s, { makeLaunchd: () => success, probeStatus: async () => ({ ok: false, status: 401 }) }), InstallerError);
  fs.appendFileSync(ctx.remoteConfigFile, "\n");
  await assert.rejects(verifyCompletion(ctx, s, { makeLaunchd: () => success, probeStatus: async () => healthy }), /runtime changed/);
});

test("launchctl timeout, permission error, missing binary and ambiguous failures are UNKNOWN", async () => {
  for (const result of [{ status: null, error: "ETIMEDOUT" }, { status: null, error: "ENOENT" },
    { status: 1, stderr: "Operation not permitted" }, { status: 113, stderr: "Could not find domain" },
    { status: 1, stderr: "Could not find service" }]) {
    const launchd = createLaunchd({ launchctl: "/fake", uid: 501, label: "test", run: () => ({ stdout: "", stderr: "", ...result }) });
    assert.equal(launchd.status().loaded, null);
    assert.equal(launchd.status().state, "unknown");
    assert.equal(await launchd.waitUnloaded(0), false);
  }
  const missing = createLaunchd({ launchctl: "/fake", uid: 501, label: "test", run: () => ({ status: 113, stderr: 'Could not find service "test" in domain for user gui: 501', stdout: "" }) });
  assert.equal(missing.status().loaded, false);
  assert.equal(await missing.waitUnloaded(0), true);
});

test("uninstall and purge abort on inspection/stop failures, including errors after bootout", { skip }, async (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  assert.equal(sb.run(offline).status, 3);
  for (const flag of ["print-error", "bootout-error"]) {
    sb.flag(flag);
    for (const extra of [[], ["--purge"]]) {
      const r = sb.run(["uninstall", "--non-interactive", "--yes", ...extra]);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /UNKNOWN/);
      assert.ok(fs.existsSync(sb.plist));
      assert.ok(fs.existsSync(path.join(sb.astraHome, "agent-private.pem")));
    }
    sb.flag(flag, false);
  }
  const uncertain = fakeLaunchd();
  uncertain.waitUnloaded = async () => false;
  await assert.rejects(uninstall(context(sb), { purge: true }, ui(), { makeLaunchd: () => uncertain }), /shutdown was not confirmed/);
  assert.ok(fs.existsSync(sb.plist));
  assert.ok(fs.existsSync(sb.personal));
});

test("custom ASTRA_HOME and key-directory aliases are protected during setup, existing validation and reconfiguration", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  const custom = path.join(sb.home, "custom-keys");
  fs.mkdirSync(custom, { mode: 0o700 });
  const alias = path.join(sb.home, "alias"); fs.symlinkSync(custom, alias);
  for (const workspace of [custom, path.join(custom, "child"), alias]) {
    const r = sb.run([...offline, "--workspace", workspace], { ASTRA_HOME: custom });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /refused this configuration/);
    assert.ok(!fs.existsSync(path.join(sb.remoteDir, "remote.json")));
  }
  assert.equal(sb.run(offline, { ASTRA_HOME: custom }).status, 3);
  const remoteFile = path.join(sb.remoteDir, "remote.json");
  const remote = JSON.parse(fs.readFileSync(remoteFile)); remote.roots = [custom]; remote.protectedPaths = [sb.repo];
  fs.writeFileSync(remoteFile, JSON.stringify(remote));
  const invalid = sb.run(offline, { ASTRA_HOME: custom });
  assert.equal(invalid.status, 1, invalid.out);
  assert.match(invalid.out, /protected location/);
  const replacement = sb.run([...offline, "--reconfigure", "--workspace", custom], { ASTRA_HOME: custom });
  assert.equal(replacement.status, 1, replacement.out);
});

test("purge locates installed custom paths after overrides disappear, refuses mismatches, preserves unrelated files", { skip }, (t) => {
  const sb = makeSandbox({ homeName: "home with 'quotes $dollar `ticks`" }); t.after(sb.cleanup);
  const custom = path.join(sb.home, "custom keys ' $(echo nope)");
  const remote = path.join(sb.home, "custom remote");
  const env = { ASTRA_HOME: custom, ASTRA_COMMANDER_REMOTE_DIR: remote };
  let r = sb.run(offline, env); assert.equal(r.status, 3, r.out);
  fs.mkdirSync(sb.astraHome, { mode: 0o700 });
  const unrelated = path.join(sb.astraHome, "agent-private.pem"); fs.writeFileSync(unrelated, "not this installation");
  fs.writeFileSync(path.join(custom, "keep.txt"), "keep");
  const wrong = path.join(sb.home, "wrong"); fs.mkdirSync(wrong);
  r = sb.run(["uninstall", "--purge", "--yes", "--non-interactive"], { ASTRA_HOME: wrong });
  assert.equal(r.status, 1, r.out); assert.match(r.out, /ASTRA_HOME differs/);
  assert.ok(fs.existsSync(sb.plist));
  const original = fs.readFileSync(sb.plist, "utf8");
  fs.writeFileSync(sb.plist, original.replace("my-mac", "other-mac"));
  r = sb.run(["uninstall", "--purge", "--yes", "--non-interactive"]);
  assert.equal(r.status, 1, r.out); assert.match(r.out, /metadata mismatch/);
  fs.writeFileSync(sb.plist, original);
  fs.rmSync(metadataFile(context(sb))); // legacy installation: derive paths from its plist.
  r = sb.run(["uninstall", "--yes", "--non-interactive"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(sb.plist));
  r = sb.run(["uninstall", "--purge", "--yes", "--non-interactive"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(path.join(custom, "agent-private.pem")));
  assert.ok(!fs.existsSync(path.join(custom, "install-state.json")));
  assert.equal(fs.readFileSync(path.join(custom, "keep.txt"), "utf8"), "keep");
  assert.ok(fs.existsSync(path.join(remote, "remote.json")));
  assert.equal(fs.readFileSync(unrelated, "utf8"), "not this installation");
  assert.ok(!fs.existsSync(metadataFile(context(sb))));
});

test("unchanged personal config with loose permissions, links, wrong type/owner is diagnosed", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  assert.equal(sb.run(offline).status, 3);
  const content = fs.readFileSync(sb.personal, "utf8");
  fs.chmodSync(sb.personal, 0o644);
  for (const args of [offline, ["doctor", "--offline"]]) {
    const r = sb.run(args); assert.equal(r.status, 1, r.out); assert.match(r.out, /chmod 600/);
  }
  assert.equal(fs.readFileSync(sb.personal, "utf8"), content);
  fs.chmodSync(sb.personal, 0o600);
  const st = fs.lstatSync(sb.personal);
  assert.match(personalConfigProblem(sb.personal, st, st.uid + 1), /owned by another user/);
  fs.renameSync(sb.personal, `${sb.personal}.saved`); fs.symlinkSync(`${sb.personal}.saved`, sb.personal);
  assert.match(readPersonalConfig(sb.personal).error, /regular file/);
  fs.rmSync(sb.personal); fs.mkdirSync(sb.personal);
  assert.match(readPersonalConfig(sb.personal).error, /regular file/);
});

test("printed repair commands quote unusual paths as a single literal argument", (t) => {
  const root = tmpDir(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "key dir ' $(touch injected) `touch injected2` $HOME");
  fs.mkdirSync(dir, { mode: 0o755 });
  const problem = inspectKeyDir(dir).problems.join();
  assert.ok(problem.includes(`chmod 700 ${shQuote(dir)}`));
  const r = spawnSync("/bin/sh", ["-c", `set -- ${shQuote(dir)}; printf '%s' "$1"`], { cwd: root, encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin" } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, dir);
  assert.deepEqual(fs.readdirSync(root), [path.basename(dir)]);
});

test("native-only, build recipe, architecture, toolchain, config and output changes invalidate freshness", (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const d of ["src", "native", "scripts", "dist/native"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const files = { "package.json": "{}", "package-lock.json": "{}", "tsconfig.json": "{}", "src/x.ts": "source", "native/ax.swift": "swift", "scripts/build.mjs": "recipe", "dist/remote-stdio.js": "output", "dist/native/mcp-commander-ax": "native output" };
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  const identity = { arch: "arm64", toolchain: ["compiler", "Swift 6", "SDK"] };
  const stamp = { fingerprint: buildFingerprint(dir, identity), output: treeHash(path.join(dir, "dist"), { exclude: [".astra-bridge-build.json"] }) };
  fs.writeFileSync(path.join(dir, "dist", ".astra-bridge-build.json"), JSON.stringify(stamp));
  assert.equal(commanderBuildReason(dir, { identity, needGui: true }), null);
  for (const f of ["native/ax.swift", "scripts/build.mjs", "tsconfig.json", "package-lock.json", "dist/native/mcp-commander-ax"]) {
    fs.writeFileSync(path.join(dir, f), "changed");
    fs.utimesSync(path.join(dir, f), new Date(0), new Date(0));
    assert.ok(commanderBuildReason(dir, { identity }), f);
    fs.writeFileSync(path.join(dir, f), files[f]);
  }
  assert.ok(commanderBuildReason(dir, { identity: { ...identity, arch: "x64" } }));
  assert.ok(commanderBuildReason(dir, { identity: { ...identity, toolchain: ["new compiler"] } }));
  const native = { source: "swift", recipe: "recipe", compiler: "swiftc", version: "Swift 6", sdk: "/sdk", sdkVersion: "14", flags: ["-O"], arch: "arm64" };
  for (const update of [{ arch: "x64" }, { recipe: "new" }, { sdkVersion: "15" }, { compiler: "/other/swiftc" }, { flags: ["-Onone"] }, { source: "new swift" }]) assert.notEqual(nativeFingerprint(native), nativeFingerprint({ ...native, ...update }));
});

test("Access rejects arbitrary challenges, wrong resource/team/issuer and redirects; edge verification never implies authenticated readiness", async () => {
  const base = "https://relay.example.test";
  const team = "https://myteam.cloudflareaccess.com";
  const metadata = `${base}/.well-known/cloudflare-access-protected-resource/mcp`;
  const expected = { base, expectedTeamHost: "myteam.cloudflareaccess.com" };
  for (const challenge of ['Basic realm="cloudflare-access"', 'Bearer realm="cloudflare-access"',
    `Basic resource_metadata="${metadata}"`, `Bearer resource_metadata="http://relay.example.test/.well-known/cloudflare-access-protected-resource/mcp"`,
    `Bearer resource_metadata="https://evil.test/.well-known/cloudflare-access-protected-resource/mcp"`,
    `Bearer resource_metadata="${metadata}", resource_metadata="${metadata}"`,
    `Bearer resource_metadata="${metadata}", Basic realm="other"`,
    `Bearer resource_metadata="${metadata}?redirect=evil"`, `Bearer resource_metadata="${metadata}",`]) {
    assert.equal(classifyAccess({ status: 401, headers: new Headers({ "www-authenticate": challenge }) }, expected).state, "unknown", challenge);
  }
  const resource = { resource: `${base}/mcp`, protected: true, authorization_servers: [team], team_domain: expected.expectedTeamHost };
  const issuer = { issuer: team, authorization_endpoint: `${team}/cdn-cgi/access/oauth/authorization`, token_endpoint: `${team}/cdn-cgi/access/oauth/token`, registration_endpoint: `${team}/cdn-cgi/access/oauth/registration`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] };
  const probe = async (patchResource = {}, patchIssuer = {}, redirected = false) => {
    const seen = [];
    const result = await probeAccess(base, { expectedTeamHost: expected.expectedTeamHost, fetchImpl: async (url, init) => {
      seen.push(String(url)); assert.equal(init.redirect, "manual");
      if (String(url) === `${base}/mcp`) return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer realm="OAuth", resource_metadata="${metadata}"` } });
      if (String(url) === metadata) return Response.json({ ...resource, ...patchResource }, { status: redirected ? 302 : 200 });
      assert.equal(String(url), `${team}/.well-known/oauth-authorization-server`);
      return Response.json({ ...issuer, ...patchIssuer });
    } });
    return { ...result, seen };
  };
  const ready = await probe(); assert.equal(ready.state, "edge-protected"); assert.equal(ready.authenticated, false); assert.equal(ready.seen.length, 3);
  assert.equal((await probe({ resource: "https://evil.test" })).state, "invalid-metadata");
  const wrong = await probe({ authorization_servers: ["https://other.cloudflareaccess.com"] });
  assert.equal(wrong.state, "wrong-team"); assert.equal(wrong.seen.length, 2, "never follows an untrusted issuer");
  assert.equal((await probe({}, { issuer: "https://evil.test" })).state, "invalid-metadata");
  assert.equal((await probe({}, { token_endpoint: "https://evil.test/token" })).state, "invalid-metadata");
  assert.equal((await probe({ protected: false })).state, "invalid-metadata");
  assert.equal((await probe({}, { code_challenge_methods_supported: "S256" })).state, "invalid-metadata");
  assert.equal((await probe({}, {}, true)).state, "unreachable");
});
