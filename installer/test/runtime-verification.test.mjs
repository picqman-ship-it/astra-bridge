import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";
import { createContext } from "../lib/context.mjs";
import { doctor } from "../lib/doctor.mjs";
import { agent } from "../lib/install.mjs";
import { inspectKeys } from "../lib/keys.mjs";
import { runtimeFingerprint, readState, writeState } from "../lib/state.mjs";
import { newestInputCtime, parseProcessStart, processStartTime, runtimeInputs, verifyRuntime } from "../lib/runtime-verification.mjs";
import { run } from "../lib/util.mjs";
import { createUi } from "../lib/ui.mjs";
import { readPersonalConfig } from "../lib/wrangler-config.mjs";
import { AUD, makeSandbox, tmpDir } from "./helpers.mjs";

const START = Date.UTC(2026, 0, 1, 12);
const BEFORE = BigInt(START - 2000) * 1_000_000n;
const healthy = { ok: true, agentConnected: true, mcpHealthy: true };
const running = (pid = 5252) => ({ loaded: true, state: "running", pid });
const formatStart = (ms) => {
  const d = new Date(ms);
  return `${d.toUTCString().slice(0, 3)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, " ")} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}\n`;
};

function evidence({ start = START, times = new Map(), ps, realCtimes = false } = {}) {
  return {
    now: () => Math.max(Date.now(), start),
    run(cmd, args, opts) {
      if (cmd !== "/bin/ps") return run(cmd, args, opts);
      assert.deepEqual(args, ["-p", "5252", "-o", "lstart="]);
      assert.equal(opts.env.LC_ALL, "C"); assert.equal(opts.env.TZ, "UTC0");
      return ps ? ps() : { status: 0, stdout: formatStart(start) };
    },
    fsImpl: {
      ...fs,
      lstatSync(file, opts) {
        const st = fs.lstatSync(file, opts);
        if (!realCtimes) st.ctimeNs = times.has(file) ? times.get(file) : BEFORE;
        return st;
      },
    },
  };
}

function fixture(t) {
  const base = tmpDir("runtime-proof-"); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ctx = createContext({ repoDir: path.join(base, "checkout"), env: { HOME: path.join(base, "home") } });
  for (const dir of [ctx.astraHome, ctx.commanderRemoteDir, ctx.launchAgentsDir, path.dirname(ctx.agentPath), path.dirname(ctx.commanderEntry)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ["agent", "client"]) fs.writeFileSync(path.join(ctx.astraHome, `${name}-private.pem`), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  for (const file of [ctx.remoteConfigFile, ctx.agentPath, ctx.commanderEntry, ...[ctx.relayDir, ctx.commanderDir].map(d => path.join(d, "package-lock.json"))]) fs.writeFileSync(file, "{}");
  // A local executable symlink exercises link and resolved-binary ctimes without touching Node.
  const node = path.join(base, "node"); fs.symlinkSync(process.execPath, node);
  const plistFile = path.join(ctx.launchAgentsDir, "test.plist");
  const plist = `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>ProgramArguments</key><array><string>${node}</string><string>${ctx.agentPath}</string></array>
    <key>WorkingDirectory</key><string>${ctx.relayDir}</string>
    <key>EnvironmentVariables</key><dict><key>ASTRA_COMMANDER_ENTRY</key><string>${ctx.commanderEntry}</string></dict>
  </dict></plist>`;
  fs.writeFileSync(plistFile, plist);
  const runtime = { applied: runtimeFingerprint(ctx, plist), pid: 4242, pending: null };
  writeState(ctx, { runtime });
  const input = { plist, plistFile, runtime, status: running() };
  return { ctx, input, node, base };
}

test("ps start parsing is strict, UTC, single-line, and validates calendar and weekday", () => {
  assert.equal(parseProcessStart("Thu Jan  1 12:00:00 2026\n"), START);
  for (const text of ["", "STARTED\nThu Jan  1 12:00:00 2026", "Thu Jan  1 12:00:00 2026\nThu Jan  1 12:00:00 2026",
    "Fri Jan  1 12:00:00 2026", "Thu Jan 32 12:00:00 2026", "Thu Jan  1 24:00:00 2026", "Thu Jan  1 12:00:60 2026",
    "Sun Feb 29 12:00:00 2026", "Thu Jan  1 12:00:00 2026 UTC", "jeu. janv. 1 12:00:00 2026", "Thu Jan  1 12:00:00 1970 extra"]) assert.equal(parseProcessStart(text), null, text);
  assert.throws(() => processStartTime(5252, { ...evidence(), now: () => START - 1 }), /cannot be established/);
});

test("same PID retains strict fingerprint/pending checks without consulting ps or ctimes", t => {
  const { ctx, input } = fixture(t);
  input.status = running(4242);
  const options = evidence({ ps() { assert.fail("same PID must not need ps"); } });
  options.fsImpl.lstatSync = () => { assert.fail("same PID must not need ctimes"); };
  assert.deepEqual(verifyRuntime(ctx, input, options), { ok: true, restarted: false });
  input.runtime.pending = "restart required"; assert.equal(verifyRuntime(ctx, input, options).ok, false);
  input.runtime.pending = null; fs.appendFileSync(ctx.remoteConfigFile, " ");
  assert.equal(verifyRuntime(ctx, input, options).ok, false);
});

test("new PID passes only with a complete applied record and inputs strictly before process start", t => {
  const { ctx, input } = fixture(t);
  assert.deepEqual(verifyRuntime(ctx, input, evidence()), { ok: true, restarted: true });
  for (const pending of [undefined, "restart", true, 0, ""]) {
    assert.equal(verifyRuntime(ctx, { ...input, runtime: { ...input.runtime, pending } }, evidence()).ok, false);
  }
  assert.equal(verifyRuntime(ctx, { ...input, runtime: { ...input.runtime, pending: false } }, evidence()).ok, true);
  for (const status of [{ loaded: false }, { loaded: null }, { ...running(), state: "waiting" },
    ...[undefined, 0, -1, 1.5, "5252", Infinity, 0x80000000].map(pid => ({ ...running(), pid }))]) {
    assert.equal(verifyRuntime(ctx, { ...input, status }, evidence()).ok, false);
  }
  assert.equal(verifyRuntime(ctx, { ...input, runtime: { ...input.runtime, pid: undefined } }, evidence()).ok, false);
});

for (const which of ["plist", "config", "agent key", "client key", "identity state", "key directory", "relay source", "relay directory", "commander build", "commander directory", "relay lock", "commander lock", "node link", "node binary"]) {
  test(`changed/reverted ${which} ctime after process start fails even with matching fingerprint`, t => {
    const { ctx, input, node } = fixture(t);
    const files = { plist: input.plistFile, config: ctx.remoteConfigFile, "agent key": path.join(ctx.astraHome, "agent-private.pem"),
      "client key": path.join(ctx.astraHome, "client-private.pem"), "identity state": ctx.stateFile, "key directory": ctx.astraHome,
      "relay source": ctx.agentPath, "relay directory": path.dirname(ctx.agentPath), "commander build": ctx.commanderEntry,
      "commander directory": path.dirname(ctx.commanderEntry), "relay lock": path.join(ctx.relayDir, "package-lock.json"),
      "commander lock": path.join(ctx.commanderDir, "package-lock.json"), "node link": node, "node binary": fs.realpathSync(process.execPath) };
    const changed = fs.realpathSync(path.dirname(files[which])) + path.sep + path.basename(files[which]);
    const times = new Map([[changed, BigInt(START + 1000) * 1_000_000n]]);
    assert.equal(runtimeFingerprint(ctx, input.plist), input.runtime.applied);
    assert.equal(verifyRuntime(ctx, input, evidence({ times })).ok, false);
  });
}

test("real content change then revert restores fingerprint and mtime but ctime still rejects", t => {
  const { ctx, input } = fixture(t);
  const start = Math.floor(Date.now() / 1000) * 1000;
  const old = fs.statSync(ctx.remoteConfigFile);
  const contents = fs.readFileSync(ctx.remoteConfigFile);
  fs.appendFileSync(ctx.remoteConfigFile, "changed");
  assert.equal(verifyRuntime(ctx, input, evidence({ start })).ok, false);
  fs.writeFileSync(ctx.remoteConfigFile, contents);
  fs.utimesSync(ctx.remoteConfigFile, old.atime, old.mtime);
  assert.equal(runtimeFingerprint(ctx, input.plist), input.runtime.applied);
  const ctime = fs.statSync(ctx.remoteConfigFile, { bigint: true }).ctimeNs;
  assert.ok(ctime >= BigInt(start) * 1_000_000n);
  assert.equal(verifyRuntime(ctx, input, evidence({ start, times: new Map([[ctx.remoteConfigFile, ctime]]) })).ok, false);
});

for (const offset of [0n, 1n, 999_999_999n]) test(`same-second ctime ambiguity at offset ${offset} fails`, t => {
  const { ctx, input } = fixture(t);
  assert.equal(verifyRuntime(ctx, input, evidence({ times: new Map([[ctx.remoteConfigFile, BigInt(START) * 1_000_000n + offset]]) })).ok, false);
});

test("unavailable/ambiguous/changing process evidence and missing ctime fail closed", t => {
  const { ctx, input } = fixture(t);
  for (const result of [{ status: 1, stdout: "" }, { status: null, error: "EPERM" }, { status: 0, stdout: "unknown" }, { status: 0, stdout: "" }]) {
    assert.throws(() => verifyRuntime(ctx, input, evidence({ ps: () => result })), /process start/);
  }
  assert.throws(() => verifyRuntime(ctx, input, evidence({ times: new Map([[ctx.remoteConfigFile, undefined]]) })), /ctime/);
  let n = 0;
  assert.equal(verifyRuntime(ctx, input, evidence({ ps: () => ({ status: 0, stdout: formatStart(START + n++ * 1000) }) })).ok, false);
});

test("ctime traversal covers nested/deleted entries, intermediate symlinks, missing paths, cycles and bounds", t => {
  const { ctx, input, base } = fixture(t);
  const root = path.dirname(ctx.agentPath);
  const nested = path.join(root, "nested"); fs.mkdirSync(nested);
  const file = path.join(nested, "input"); fs.writeFileSync(file, "before");
  const changed = BigInt(START + 1000) * 1_000_000n;
  assert.equal(verifyRuntime(ctx, input, evidence()).ok, false, "added file changes fingerprint");
  fs.rmSync(file);
  assert.equal(runtimeFingerprint(ctx, input.plist), input.runtime.applied, "empty directories do not change old content hash");
  assert.equal(verifyRuntime(ctx, input, evidence({ times: new Map([[nested, changed]]) })).ok, false);
  const alias = path.join(base, "source-link"); fs.symlinkSync(root, alias);
  assert.equal(newestInputCtime([{ file: path.join(alias, "agent.mjs") }], evidence({ times: new Map([[alias, changed]]) })), changed);
  const nestedAlias = path.join(base, "nested-link"); fs.symlinkSync(nested, nestedAlias);
  assert.equal(newestInputCtime([{ file: `${nestedAlias}/../agent.mjs` }], evidence({ times: new Map([[nestedAlias, changed]]) })), changed,
    "resolve symlinks before '..', retaining the link ctime");
  const inventory = runtimeInputs(ctx, input.plist, input.plistFile);
  assert.throws(() => newestInputCtime(inventory, { maxEntries: 1 }), /limit/);
  assert.throws(() => newestInputCtime(inventory, { maxDepth: 0 }), /depth/);
  fs.symlinkSync(root, path.join(nested, "cycle"));
  assert.throws(() => newestInputCtime([{ file: root, directory: true, recursive: true }]), /cycle/);
  fs.rmSync(path.join(nested, "cycle"));
  assert.throws(() => newestInputCtime([{ file: path.join(base, "missing") }]), /ENOENT/);
  fs.rmSync(ctx.stateFile);
  assert.throws(() => verifyRuntime(ctx, input, evidence()), /ENOENT/);
});

test("fingerprinting uses the plist Node and ignores doctor's executable identity", t => {
  const { ctx, input } = fixture(t);
  const otherDoctor = { ...ctx, execPath: "/missing/doctor-node" };
  assert.equal(runtimeFingerprint(otherDoctor, input.plist), input.runtime.applied);
  const calls = [];
  const changedNode = (cmd, args, opts) => {
    calls.push(cmd);
    return cmd === fs.realpathSync(process.execPath) ? { status: 0, stdout: '["v99.0.0","arm64","darwin"]' } : run(cmd, args, opts);
  };
  assert.notEqual(runtimeFingerprint(otherDoctor, input.plist, { run: changedNode }), input.runtime.applied);
  assert.ok(calls.includes(fs.realpathSync(process.execPath)));
  assert.throws(() => runtimeFingerprint(ctx, input.plist, { run: (cmd, args, opts) => cmd === "/usr/bin/plutil" ? run(cmd, args, opts) : { status: 1 } }), /Node runtime identity/);
});

const args = ["--non-interactive", "--skip-deps", "--yes", "--email", "owner@corp.test", "--team-domain", "myteam", "--policy-aud", AUD];
function installed(t) {
  const sb = makeSandbox(); t.after(sb.cleanup);
  const r = sb.run(args, {}, { network: true }); assert.equal(r.status, 0, r.out);
  const ctx = createContext({ repoDir: sb.repo, env: sb.env });
  const plist = fs.readFileSync(sb.plist, "utf8");
  const newest = newestInputCtime(runtimeInputs(ctx, plist, sb.plist));
  const start = (Number(newest / 1_000_000_000n) + 2) * 1000;
  return { sb, ctx, options: evidence({ start, realCtimes: true }) };
}

test("install -> safe new PID: doctor PASS, file-only authority PASS, and all saved files remain unchanged", async t => {
  const { sb, ctx, options } = installed(t);
  const files = [ctx.stateFile, ctx.remoteConfigFile, sb.plist, ...["agent", "client"].map(n => path.join(ctx.astraHome, `${n}-private.pem`))];
  const before = files.map(f => [fs.readFileSync(f), fs.statSync(f).ctimeMs]);
  const result = await doctor({ ...ctx, execPath: "/unrelated/doctor-node" }, { offline: true, makeLaunchd: () => ({ status: () => running() }), runtimeOptions: options });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.checks.find(c => c.name === "runtime changes").level, "pass");
  assert.equal(result.checks.find(c => c.name === "access mode").level, "pass");
  assert.deepEqual(files.map(f => [fs.readFileSync(f), fs.statSync(f).ctimeMs]), before);
  assert.equal(readState(ctx).runtime.pid, 4242, "doctor never adopts the new PID");
  const unavailable = await doctor(ctx, { offline: true, makeLaunchd: () => ({ status: () => running() }), runtimeOptions: evidence({ ps: () => ({ status: 1 }) }) });
  assert.equal(unavailable.checks.find(c => c.name === "access mode").level, "fail");
  let calls = 0;
  const changed = await doctor(ctx, { offline: true, makeLaunchd: () => ({ status: () => running(calls++ ? 6262 : 5252) }), runtimeOptions: options });
  assert.equal(changed.checks.find(c => c.name === "runtime changes").level, "fail");
  const original = fs.readFileSync(ctx.remoteConfigFile);
  fs.appendFileSync(ctx.remoteConfigFile, " ");
  const drift = await doctor(ctx, { offline: true, makeLaunchd: () => ({ status: () => running() }), runtimeOptions: options });
  assert.equal(drift.checks.find(c => c.name === "runtime changes").level, "fail");
  fs.writeFileSync(ctx.remoteConfigFile, original);
  for (const offset of [0, 1000]) {
    const reverted = await doctor(ctx, { offline: true, makeLaunchd: () => ({ status: () => running() }),
      runtimeOptions: evidence({ times: new Map([[ctx.remoteConfigFile, BigInt(START + offset) * 1_000_000n]]) }) });
    assert.equal(reverted.checks.find(c => c.name === "runtime changes").level, "fail");
    assert.equal(reverted.checks.find(c => c.name === "access mode").level, "fail");
  }
});

test("installer adopts a safe PID only after healthy readiness, without restarting; failed/skipped probes retain saved PID", async t => {
  const { sb, ctx, options } = installed(t);
  const k = inspectKeys(ctx.astraHome);
  const personal = readPersonalConfig(ctx.personalConfig);
  const state = () => ({ personal, relayUrl: personal.values.relayUrl, keys: { agent: k.agent.publicKeyB64, client: k.client.publicKeyB64 } });
  const ui = createUi({ interactive: false, yes: true, out: new PassThrough() });
  const dependencies = { makeLaunchd: () => ({ status: () => running() }), runtimeOptions: options, wait: async () => {} };
  const before = fs.readFileSync(ctx.stateFile, "utf8");
  await agent(ctx, { noNetworkChecks: true }, ui, state(), { ...dependencies, probeStatus: async () => { assert.fail("skipped"); } });
  assert.equal(fs.readFileSync(ctx.stateFile, "utf8"), before);
  for (const status of [{ ok: false, status: 403 }, { ok: true, agentConnected: true, mcpHealthy: false }]) {
    await assert.rejects(agent(ctx, {}, ui, state(), { ...dependencies, probeStatus: async () => status }));
    assert.equal(fs.readFileSync(ctx.stateFile, "utf8"), before);
  }
  let probes = 0;
  await agent(ctx, {}, ui, state(), { ...dependencies, probeStatus: async () => {
    probes++; assert.equal(readState(ctx).runtime.pid, 4242); return healthy;
  } });
  assert.equal(probes, 1); assert.equal(readState(ctx).runtime.pid, 5252);
  assert.equal(readState(ctx).runtime.pending, null);
  assert.equal((sb.calls().match(/launchctl bootstrap/g) ?? []).length, 1);
});

test("installer refuses PID churn and change/revert during the readiness probe", async t => {
  for (const mutation of ["pid", "revert"]) {
    const { ctx, options } = installed(t);
    const personal = readPersonalConfig(ctx.personalConfig);
    const runtime = readState(ctx).runtime;
    let pid = 5252;
    await assert.rejects(agent(ctx, {}, createUi({ interactive: false, yes: true, out: new PassThrough() }), { personal, relayUrl: personal.values.relayUrl }, {
      runtimeOptions: options, makeLaunchd: () => ({ status: () => running(pid) }), probeStatus: async () => {
        if (mutation === "pid") pid = 6262;
        else {
          const original = fs.readFileSync(ctx.remoteConfigFile);
          fs.appendFileSync(ctx.remoteConfigFile, " "); fs.writeFileSync(ctx.remoteConfigFile, original);
          // Deterministic ordering: only the changed file's observed ctime is after ps start.
          const read = options.fsImpl.lstatSync;
          options.fsImpl.lstatSync = (file, opts) => { const st = read(file, opts); if (file === ctx.remoteConfigFile) st.ctimeNs = BigInt(options.now() + 1000) * 1_000_000n; return st; };
        }
        return healthy;
      },
    }), /changed/);
    assert.deepEqual(readState(ctx).runtime, runtime);
  }
});

test("beta reboot doctor passes read-only; resume without invite preserves identity and sends zero new enrollment POSTs", async t => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  const invite = path.join(sb.state, "invite.json");
  fs.writeFileSync(invite, JSON.stringify({ version: 1, relayOrigin: "https://astra-bridge-relay.example-sub.workers.dev", invite: "abi1_" + "a".repeat(64) }), { mode: 0o600 });
  const betaArgs = ["--beta-enroll", "--skip-deps", "--yes", "--non-interactive"];
  let r = sb.run([...betaArgs, "--invite-file", invite], {}, { network: true });
  assert.equal(r.status, 0, r.out);
  const ctx = createContext({ repoDir: sb.repo, env: sb.env });
  const before = readState(ctx);
  const privateKey = fs.readFileSync(path.join(ctx.astraHome, "agent-private.pem"));
  const clientKey = fs.readFileSync(path.join(ctx.astraHome, "client-private.pem"));
  const enrollments = () => (sb.calls().match(/network POST \/beta\/enroll/g) ?? []).length;
  assert.equal(enrollments(), 1);
  fs.rmSync(invite);
  fs.writeFileSync(path.join(sb.state, "pid"), "5252");
  const newest = newestInputCtime(runtimeInputs(ctx, fs.readFileSync(sb.plist, "utf8"), sb.plist));
  const runtimeOptions = evidence({ start: (Number(newest / 1_000_000_000n) + 2) * 1000, realCtimes: true });
  const result = await doctor(ctx, { offline: true, makeLaunchd: () => ({ status: () => running() }), runtimeOptions });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(readState(ctx), before);
  const unavailable = await doctor(ctx, { offline: true, makeLaunchd: () => ({ status: () => running() }), runtimeOptions: evidence({ ps: () => ({ status: 1 }) }) });
  assert.deepEqual(unavailable.checks.find(c => c.name === "runtime changes").fix, ["./install-macos.sh --beta-enroll"]);
  r = sb.run(betaArgs, {}, { network: true });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /existing beta registration verified/);
  assert.equal(enrollments(), 1, "resume must send zero new enroll POSTs");
  assert.deepEqual(readState(ctx).betaEnrollment, before.betaEnrollment);
  assert.deepEqual(fs.readFileSync(path.join(ctx.astraHome, "agent-private.pem")), privateKey);
  assert.deepEqual(fs.readFileSync(path.join(ctx.astraHome, "client-private.pem")), clientKey);
  assert.equal(readState(ctx).runtime.pid, 5252);
  assert.equal(readState(ctx).runtime.pending, null);
  assert.doesNotMatch(sb.calls(), /wrangler/);
});
