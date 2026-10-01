import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext } from "../lib/context.mjs";
import { metadataFile } from "../lib/install-metadata.mjs";
import { reduceRemoteConfig } from "../lib/offboarding.mjs";
import { preflight } from "../lib/install.mjs";
import { parseJsonc, setStringProperty } from "../lib/jsonc.mjs";
import { readPersonalConfig, interpret } from "../lib/wrangler-config.mjs";
import { AUD, makeSandbox, prerequisitesBuilt } from "./helpers.mjs";

const skip = prerequisitesBuilt() ? false : "build dependencies first";
const args = ["--non-interactive", "--skip-deps", "--yes", "--email", "owner@corp.test", "--team-domain", "myteam", "--policy-aud", AUD];
const ctx = (sb) => createContext({ repoDir: sb.repo, env: sb.env });
const setup = (sb, extra = []) => {
  const r = sb.run([...args, ...extra], {}, { network: true });
  assert.equal(r.status, 0, r.out);
};

test("existing comma-separated email allowlists survive rerun and pass doctor", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup); setup(sb);
  const list = " Owner@Corp.Test,second@corp.test ";
  fs.writeFileSync(sb.personal, setStringProperty(fs.readFileSync(sb.personal, "utf8"), ["vars", "ACCESS_ALLOWED_EMAILS"], list));
  const r = sb.run(["--non-interactive", "--skip-deps", "--yes"], {}, { network: true });
  assert.equal(r.status, 0, r.out);
  assert.equal(parseJsonc(fs.readFileSync(sb.personal, "utf8")).vars.ACCESS_ALLOWED_EMAILS, list);
  assert.equal(readPersonalConfig(sb.personal).values.email, "owner@corp.test,second@corp.test");
  const doctor = sb.run(["doctor", "--offline", "--json"]);
  const report = JSON.parse(doctor.out);
  assert.equal(report.checks.find((c) => c.name === "personal config").level, "pass");
  const bad = parseJsonc(fs.readFileSync(sb.personal, "utf8")); bad.vars.ACCESS_ALLOWED_EMAILS += ",not-an-email";
  assert.equal(interpret(bad).values.email, null);
});

test("device IDs and OAuth values must be exact, because the Worker compares them verbatim", (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  const data = parseJsonc(fs.readFileSync(path.join(sb.repo, "relay/wrangler.jsonc"), "utf8"));
  Object.assign(data.vars, { AGENT_DEVICE_ID: "my-mac", CLIENT_DEVICE_ID: "my-mac", MCP_DEVICE_ID: "my-mac",
    OAUTH_ISSUER: "https://relay.test.invalid", OAUTH_RESOURCE: "https://relay.test.invalid/mcp" });
  assert.deepEqual(interpret(data).problems, []);
  // Equal only after trimming: the Worker would refuse the agent (403) and route MCP elsewhere.
  Object.assign(data.vars, { AGENT_DEVICE_ID: " my-mac ", CLIENT_DEVICE_ID: "my-mac\n", MCP_DEVICE_ID: "\tmy-mac" });
  assert.match(interpret(data).problems.join(), /must be exactly "my-mac" \(the Worker compares them verbatim/);
  assert.doesNotMatch(interpret(data).problems.join(), /differ/);
  data.vars.CLIENT_DEVICE_ID = "other";
  assert.match(interpret(data).problems.join(), /DEVICE_ID.*differ/);
  Object.assign(data.vars, { OAUTH_ISSUER: " https://relay.test.invalid/ ", OAUTH_RESOURCE: " https://relay.test.invalid/mcp\n" });
  assert.equal(interpret(data).values.relayUrl, "https://relay.test.invalid");
  assert.match(interpret(data).problems.join(), /OAUTH_ISSUER should be exactly https:\/\/relay\.test\.invalid /);
  assert.match(interpret(data).problems.join(), /OAUTH_RESOURCE should be exactly https:\/\/relay\.test\.invalid\/mcp/);
  data.vars.OAUTH_RESOURCE = "https://elsewhere.test.invalid/mcp";
  assert.match(interpret(data).problems.join(), /OAUTH_RESOURCE/);
});

test("setup rewrites inexact device IDs and OAuth values, and doctor then passes", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup); setup(sb);
  const url = readPersonalConfig(sb.personal).values.relayUrl;
  let text = fs.readFileSync(sb.personal, "utf8");
  for (const [key, value] of [["AGENT_DEVICE_ID", " my-mac "], ["MCP_DEVICE_ID", "my-mac\n"], ["OAUTH_ISSUER", `${url}/`], ["OAUTH_RESOURCE", ` ${url}/mcp`]]) {
    text = setStringProperty(text, ["vars", key], value);
  }
  fs.writeFileSync(sb.personal, text);
  const check = () => JSON.parse(sb.run(["doctor", "--offline", "--json"]).out).checks.find((c) => c.name === "personal config");
  assert.equal(check().level, "fail");
  const r = sb.run(["--non-interactive", "--skip-deps", "--yes"], {}, { network: true });
  assert.equal(r.status, 0, r.out);
  const vars = parseJsonc(fs.readFileSync(sb.personal, "utf8")).vars;
  assert.deepEqual([vars.AGENT_DEVICE_ID, vars.CLIENT_DEVICE_ID, vars.MCP_DEVICE_ID, vars.OAUTH_ISSUER, vars.OAUTH_RESOURCE],
    ["my-mac", "my-mac", "my-mac", url, `${url}/mcp`]);
  assert.equal(check().level, "pass");
});

test("preflight GUI requirement follows post-reconfigure intent", async (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  fs.mkdirSync(sb.remoteDir); fs.writeFileSync(path.join(sb.remoteDir, "remote.json"), JSON.stringify({ trustedGui: true }));
  for (const [opts, want] of [[{}, true], [{ reconfigure: true }, false], [{ fileOnly: true }, false],
    [{ reconfigure: true, enableTerminal: true }, false], [{ reconfigure: true, enableGui: true }, true]]) {
    let actual;
    await preflight(ctx(sb), opts, { heading() {} }, {}, { check: (_, options) => { actual = options.needGui; return []; } });
    assert.equal(actual, want, JSON.stringify(opts));
  }
});

for (const [flag, value, detail] of [["--device-id", "bad/id", /device id/], ["--email", "invalid", /email address/],
  ["--worker-name", "UPPER", /worker name/], ["--relay-url", "http://relay.test.invalid", /https/],
  ["--team-domain", "https://evil.test", /team domain/], ["--policy-aud", "short", /Audience/]]) {
  test(`invalid ${flag} is an actionable CLI error before any side effects`, (t) => {
    const sb = makeSandbox(); t.after(sb.cleanup);
    const r = sb.run(["--non-interactive", flag, value]);
    assert.equal(r.status, 2, r.out);
    assert.ok(r.out.includes(flag)); assert.match(r.out, detail);
    assert.doesNotMatch(r.out, /unexpected error|\n\s+at /);
    assert.equal(sb.calls(), ""); assert.equal(fs.existsSync(sb.astraHome), false);
  });
}

for (const failure of ["logged-out", "lookup-error", "bootout-error"]) {
  test(`file-only revocation fails closed through ${failure}`, { skip }, (t) => {
    const sb = makeSandbox(); t.after(sb.cleanup); setup(sb, ["--enable-terminal", "--enable-gui"]);
    sb.flag(failure);
    if (failure === "lookup-error") {
      const state = JSON.parse(fs.readFileSync(ctx(sb).stateFile)); delete state.deploy;
      fs.writeFileSync(ctx(sb).stateFile, JSON.stringify(state));
    }
    const before = sb.calls().length;
    const r = sb.run([...args, "--file-only"]);
    assert.notEqual(r.status, 0, r.out);
    const config = JSON.parse(fs.readFileSync(ctx(sb).remoteConfigFile));
    // remote.json is reduced first in every case, so no later start (KeepAlive, login, a resume
    // without flags) regains the old tools.
    assert.equal(config.trustedTerminal, false); assert.equal(config.trustedGui, false);
    if (failure === "bootout-error") {
      assert.match(r.out, /agent shutdown is UNKNOWN; the running agent may keep its previous permissions\. remote\.json was already reduced/);
      assert.doesNotMatch(sb.calls().slice(before), /wrangler/);
    } else {
      assert.equal(sb.loaded(), false);
      assert.equal(sb.login(), false, "the old agent does not come back at the next login");
      const calls = sb.calls().slice(before);
      assert.ok(calls.indexOf("launchctl bootout") < calls.indexOf("launchctl disable"), calls);
      assert.ok(calls.indexOf("launchctl disable") < calls.indexOf("wrangler whoami"), calls);
    }
  });
}

for (const changed of ["config", "code", "plist", "key", "pid", "state"]) {
  test(`doctor detects unrecorded ${changed} drift without relying on pending`, { skip }, (t) => {
    const sb = makeSandbox(); t.after(sb.cleanup); setup(sb, ["--enable-terminal"]);
    const context = ctx(sb);
    if (changed === "config") {
      const config = JSON.parse(fs.readFileSync(context.remoteConfigFile)); config.trustedTerminal = false;
      fs.writeFileSync(context.remoteConfigFile, JSON.stringify(config));
    } else if (changed === "code") fs.appendFileSync(context.agentPath, "\n// changed after verification\n");
    else if (changed === "plist") fs.appendFileSync(sb.plist, "\n");
    else if (changed === "key") fs.renameSync(path.join(sb.astraHome, "client-private.pem"), path.join(sb.astraHome, "saved-key"));
    else if (changed === "state") fs.rmSync(context.stateFile);
    else {
      const state = JSON.parse(fs.readFileSync(context.stateFile)); state.runtime.pid++;
      fs.writeFileSync(context.stateFile, JSON.stringify(state));
    }
    const r = sb.run(["doctor", "--offline", "--json"]);
    assert.equal(r.status, 1, r.out);
    const checks = JSON.parse(r.out).checks;
    assert.equal(checks.find((c) => c.name === "runtime changes").level, "fail");
    const mode = checks.find((c) => c.name === "access mode");
    assert.equal(mode.level, "fail"); assert.doesNotMatch(mode.detail, /file-only/);
  });
}

for (const legacy of [false, true]) {
  test(`purge handles ${legacy ? "legacy" : "recorded"} partial setup without plist, preserving unrelated files`, { skip }, (t) => {
    const sb = makeSandbox(); t.after(sb.cleanup); sb.flag("logged-out");
    const r = sb.run(args); assert.equal(r.status, 3, r.out); assert.equal(fs.existsSync(sb.plist), false);
    if (legacy) fs.rmSync(metadataFile(ctx(sb)));
    const kept = path.join(sb.astraHome, "keep.txt"); fs.writeFileSync(kept, "keep");
    const dry = sb.run(["uninstall", "--purge", "--dry-run"]); assert.equal(dry.status, 0, dry.out);
    assert.ok(fs.existsSync(sb.personal));
    const purged = sb.run(["uninstall", "--purge", "--yes", "--non-interactive"]);
    assert.equal(purged.status, 0, purged.out);
    assert.equal(fs.existsSync(sb.personal), false);
    assert.equal(fs.existsSync(path.join(sb.astraHome, "agent-private.pem")), false);
    assert.equal(fs.readFileSync(kept, "utf8"), "keep");
    assert.doesNotMatch(purged.out, /wrangler delete.*-c|disable or delete it to cut access/);
    assert.match(purged.out, /does NOT revoke signed \/v1\/device RPC/);
  });
}

test("legacy partial purge refuses arbitrary custom paths, mismatched keys and symlinked configs", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup); sb.flag("logged-out");
  assert.equal(sb.run(args).status, 3); fs.rmSync(metadataFile(ctx(sb)));
  let r = sb.run(["uninstall", "--purge", "--yes"], { ASTRA_HOME: sb.home });
  assert.equal(r.status, 1, r.out); assert.ok(fs.existsSync(sb.personal));
  const content = fs.readFileSync(sb.personal, "utf8");
  fs.writeFileSync(sb.personal, setStringProperty(content, ["vars", "CLIENT_PUBLIC_KEY_B64"], "bad"));
  r = sb.run(["uninstall", "--purge", "--yes"]); assert.equal(r.status, 1, r.out);
  assert.ok(fs.existsSync(path.join(sb.astraHome, "agent-private.pem")));
  fs.renameSync(sb.personal, `${sb.personal}.saved`); fs.symlinkSync(`${sb.personal}.saved`, sb.personal);
  r = sb.run(["uninstall", "--purge", "--yes"]); assert.equal(r.status, 1, r.out);
  assert.ok(fs.existsSync(`${sb.personal}.saved`));
});

test("a partial-install inventory never grants ownership of pre-existing files or arbitrary metadata paths", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  fs.mkdirSync(sb.astraHome, { mode: 0o700 });
  const key = path.join(sb.astraHome, "agent-private.pem");
  const log = path.join(sb.astraHome, "agent.stderr.log");
  fs.writeFileSync(key, "unrelated key", { mode: 0o600 }); fs.writeFileSync(log, "unrelated log");
  const setupResult = sb.run(args); assert.equal(setupResult.status, 1, setupResult.out);
  const file = metadataFile(ctx(sb)); const saved = fs.readFileSync(file, "utf8");
  const data = JSON.parse(saved); data.partialFiles.push(log);
  fs.writeFileSync(file, JSON.stringify(data));
  const invalid = sb.run(["uninstall", "--purge", "--yes"]);
  assert.equal(invalid.status, 1, invalid.out); assert.match(invalid.out, /invalid partial-install cleanup inventory/);
  fs.writeFileSync(file, saved);
  const purged = sb.run(["uninstall", "--purge", "--yes"]); assert.equal(purged.status, 0, purged.out);
  assert.equal(fs.readFileSync(key, "utf8"), "unrelated key");
  assert.equal(fs.readFileSync(log, "utf8"), "unrelated log");
});

test("--file-only is applied before dependency steps that may need the network", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup); setup(sb, ["--enable-terminal", "--enable-gui"]);
  // npm answers --version (preflight) and fails everything else, like a download without network.
  const npm = path.join(sb.base, "bin", "npm");
  fs.writeFileSync(npm, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 10.9.0; exit 0; fi\necho "npm $*" >> "$FAKE_STATE_DIR/calls.log"\necho "npm ERR! network request failed" >&2\nexit 1\n', { mode: 0o755 });
  const before = sb.calls().length;
  const r = sb.run(["--non-interactive", "--yes", "--file-only"], { ASTRA_NPM: npm });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /npm ci failed|mcp-commander build failed/);
  const calls = sb.calls().slice(before);
  assert.ok(calls.includes("npm ") && calls.indexOf("launchctl disable") < calls.indexOf("npm "), calls);
  const config = JSON.parse(fs.readFileSync(ctx(sb).remoteConfigFile));
  assert.equal(config.trustedTerminal, false); assert.equal(config.trustedGui, false);
  assert.equal(sb.loaded(), false);
  assert.equal(sb.login(), false, "the old agent does not come back at the next login");
  // A resume without flags restarts the agent file-only; nothing brings terminal back.
  const resume = sb.run(args, {}, { network: true });
  assert.equal(resume.status, 0, resume.out);
  assert.equal(JSON.parse(fs.readFileSync(ctx(sb).remoteConfigFile)).trustedTerminal, false);
  assert.ok(sb.loaded()); assert.equal(sb.disabled(), false);
});

test("an unconfirmed durable-job shutdown keeps its evidence; the agent stays reduced, stopped and disabled", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup); setup(sb, ["--enable-terminal"]);
  const durable = path.join(sb.remoteDir, "durable"); fs.mkdirSync(durable, { mode: 0o700 });
  const worker = path.join(durable, "worker.json");
  fs.writeFileSync(worker, "{bad", { mode: 0o600 });
  const terminal = () => JSON.parse(fs.readFileSync(ctx(sb).remoteConfigFile)).trustedTerminal;
  const revoke = sb.run([...args, "--file-only"]);
  assert.equal(revoke.status, 1, revoke.out);
  assert.match(revoke.out, /agent stopped and disabled at login/);
  assert.match(revoke.out, /durable-job shutdown is UNCONFIRMED: .*worker\.json is malformed/);
  assert.equal(terminal(), false, "no later start regains terminal tools");
  assert.equal(sb.loaded(), false); assert.equal(sb.login(), false);
  // A resume without flags retries first, restarts file-only, and never reports success.
  const resume = sb.run(args, {}, { network: true });
  assert.equal(resume.status, 3, resume.out);
  assert.match(resume.out, /retrying it first/);
  assert.match(resume.out, /earlier durable-job shutdown is still UNCONFIRMED/);
  assert.doesNotMatch(resume.out, /Setup complete/);
  assert.equal(terminal(), false);
  // Terminal tools are refused before remote.json can change.
  const enable = sb.run([...args, "--enable-terminal"], {}, { network: true });
  assert.equal(enable.status, 1, enable.out);
  assert.match(enable.out, /terminal tools were not enabled; nothing was changed/);
  assert.equal(terminal(), false);
  const doctor = JSON.parse(sb.run(["doctor", "--offline", "--json"]).out);
  assert.equal(doctor.checks.find((c) => c.name === "durable jobs").level, "fail");
  // Uninstall stops early and keeps everything, but cannot come back at login.
  const stopped = sb.run(["uninstall", "--purge", "--yes"]);
  assert.equal(stopped.status, 1, stopped.out); assert.match(stopped.out, /shutdown is UNCONFIRMED/);
  for (const f of [sb.plist, sb.personal, path.join(sb.astraHome, "agent-private.pem"), worker]) assert.ok(fs.existsSync(f), f);
  assert.equal(sb.loaded(), false); assert.equal(sb.login(), false);
  // Once the owner resolves it (the corrupt record moved aside), the next run confirms and finishes.
  fs.renameSync(worker, path.join(sb.base, "worker.json.inspected"));
  const done = sb.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.out);
  assert.match(done.out, /durable jobs disabled and verified stopped \(0 queued cancelled, 0 process\(es\) stopped\)/);
  assert.equal(fs.existsSync(sb.plist), false);
  assert.equal(sb.disabled(), false, "the login block is lifted once nothing is left to load");
  const after = JSON.parse(sb.run(["doctor", "--offline", "--json"]).out);
  assert.equal(after.checks.find((c) => c.name === "durable jobs").level, "pass");
});

test("emergency key rotation (SECURITY.md): after uninstall, --file-only redeploys new keys before the agent starts", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup); setup(sb, ["--enable-terminal"]);
  const old = readPersonalConfig(sb.personal).values;
  assert.equal(sb.run(["uninstall", "--yes"]).status, 0);
  for (const f of ["agent-private.pem", "client-private.pem"]) fs.renameSync(path.join(sb.astraHome, f), path.join(sb.base, f));
  const before = sb.calls().length; const deploys = sb.deploys();
  const r = sb.run([...args, "--file-only"], {}, { network: true });
  assert.equal(r.status, 0, r.out);
  const calls = sb.calls().slice(before);
  assert.ok(calls.includes("wrangler deploy -c") && calls.indexOf("wrangler deploy -c") < calls.indexOf("launchctl bootstrap"), calls);
  assert.equal(sb.deploys(), deploys + 1);
  const now = readPersonalConfig(sb.personal).values;
  assert.notEqual(now.agentKey, old.agentKey); assert.notEqual(now.clientKey, old.clientKey);
  assert.equal(JSON.parse(fs.readFileSync(ctx(sb).remoteConfigFile)).trustedTerminal, false, "uninstall kept remote.json; --file-only turned terminal off");
});

test("the early remote.json reduction only ever removes access, and only from a file the agent would load", (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  const c = ctx(sb); fs.mkdirSync(sb.remoteDir, { mode: 0o700 });
  const write = (cfg, mode = 0o600) => { fs.rmSync(c.remoteConfigFile, { force: true }); fs.writeFileSync(c.remoteConfigFile, JSON.stringify(cfg), { mode }); };
  const read = () => JSON.parse(fs.readFileSync(c.remoteConfigFile, "utf8"));
  const both = { schemaVersion: 1, roots: ["/x"], trustedTerminal: true, trustedGui: true, limits: { maxSessions: 3 } };
  for (const [opts, terminal, gui] of [[{ fileOnly: true }, false, false], [{ reconfigure: true }, false, false],
    [{ reconfigure: true, enableTerminal: true }, true, false], [{ reconfigure: true, enableGui: true }, false, true], [{}, true, true]]) {
    write(both);
    reduceRemoteConfig(c, opts);
    assert.deepEqual([read().trustedTerminal, read().trustedGui], [terminal, gui], JSON.stringify(opts));
    assert.deepEqual(read().limits, { maxSessions: 3 }, "every other setting is kept");
  }
  write({ ...both, trustedTerminal: false, trustedGui: false });
  assert.equal(reduceRemoteConfig(c, { reconfigure: true, enableTerminal: true, enableGui: true }), null, "never adds access");
  assert.equal(read().trustedTerminal, false);
  write(both, 0o644);
  assert.equal(reduceRemoteConfig(c, { fileOnly: true }), "terminal and GUI tools off");
  assert.equal(fs.statSync(c.remoteConfigFile).mode & 0o777, 0o644, "the mode is kept (a refused file stays refused)");
  const target = path.join(sb.base, "elsewhere.json"); fs.writeFileSync(target, JSON.stringify(both));
  fs.rmSync(c.remoteConfigFile); fs.symlinkSync(target, c.remoteConfigFile);
  assert.equal(reduceRemoteConfig(c, { fileOnly: true }), null, "a symlink is never followed or replaced");
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).trustedTerminal, true);
  fs.rmSync(c.remoteConfigFile); fs.writeFileSync(c.remoteConfigFile, "{not json", { mode: 0o600 });
  assert.equal(reduceRemoteConfig(c, { fileOnly: true }), null);
  assert.equal(fs.readFileSync(c.remoteConfigFile, "utf8"), "{not json");
});

test("a checkout updated without a rebuild revokes safely and names the build command (no module-not-found)", { skip }, (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup); setup(sb, ["--enable-terminal"]);
  fs.mkdirSync(path.join(sb.remoteDir, "durable"), { mode: 0o700 });
  // This sandbox's own mcp-commander: the real sources, but a dist/ from before offboarding.js.
  const commander = path.join(sb.repo, "mcp-commander");
  const real = fs.realpathSync(commander);
  fs.rmSync(commander); fs.mkdirSync(commander);
  for (const e of fs.readdirSync(real)) if (e !== "dist") fs.symlinkSync(path.join(real, e), path.join(commander, e));
  fs.cpSync(path.join(real, "dist"), path.join(commander, "dist"), { recursive: true });
  fs.rmSync(path.join(commander, "dist", "remote", "offboarding.js"));
  for (const run of [[...args, "--file-only"], ["uninstall", "--yes"]]) {
    const r = sb.run(run);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /durable-job shutdown is UNCONFIRMED: recorded jobs were not touched because this checkout's mcp-commander build is older than its sources/);
    assert.match(r.out, /npm run build\), then re-run/);
    assert.doesNotMatch(r.out, /Cannot find module|unexpected error/);
  }
  assert.equal(JSON.parse(fs.readFileSync(ctx(sb).remoteConfigFile)).trustedTerminal, false);
  assert.ok(fs.existsSync(sb.plist));
  assert.equal(sb.loaded(), false); assert.equal(sb.login(), false);
});

test("uninstall without installation evidence refuses another setup's durable workers", (t) => {
  const sb = makeSandbox(); t.after(sb.cleanup);
  fs.mkdirSync(path.join(sb.remoteDir, "durable"), { recursive: true, mode: 0o700 });
  const r = sb.run(["uninstall", "--yes"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /refusing to signal another setup/);
  assert.deepEqual(fs.readdirSync(path.join(sb.remoteDir, "durable")), []);
});

test("unused installer containment export is gone", async () => {
  assert.equal("isWithin" in await import("../lib/util.mjs"), false);
});
