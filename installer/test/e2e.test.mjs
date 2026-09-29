// End-to-end runs of installer/astra-macos.mjs in a sandbox (see helpers.mjs): temporary HOME,
// a copy of the checkout, fake launchctl and wrangler. Nothing real is installed or deployed.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { parseJsonc } from "../lib/jsonc.mjs";
import { AUD, makeSandbox, prerequisitesBuilt } from "./helpers.mjs";

const skip = prerequisitesBuilt() ? false : "needs mcp-commander built and relay dependencies installed (see installer/README.md)";
const BASE = ["--non-interactive", "--skip-deps", "--no-network-checks"];
const mode = (p) => fs.statSync(p).mode & 0o777;

test("full guided install in a sandbox: file-only, keys, personal config, deploy, agent, Access checkpoint", { skip }, (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  // 1. Non-interactive without an email: stops at a checkpoint naming the flag, after the local steps.
  let r = sb.run([...BASE, "--yes"]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /--email/);
  assert.equal(sb.deploys(), 0);

  // 2. With an email: runs through deploy and the agent, then pauses at the Access dashboard step.
  r = sb.run([...BASE, "--yes", "--email", "Owner@Corp.Test"]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Cloudflare Access is not configured yet/);
  assert.match(r.out, /--team-domain/);
  assert.match(r.out, /Path: mcp/);

  // mcp-commander: file-only, workspace root, the whole checkout protected.
  const remote = JSON.parse(fs.readFileSync(path.join(sb.remoteDir, "remote.json"), "utf8"));
  assert.equal(remote.trustedTerminal, false);
  assert.equal(remote.trustedGui, false);
  assert.deepEqual(remote.roots, [path.join(sb.home, "remote-workspace")]);
  assert.ok(remote.protectedPaths.includes(sb.repo), "the checkout is a protected path");
  assert.equal(mode(path.join(sb.remoteDir, "remote.json")), 0o600);
  assert.equal(mode(path.join(sb.home, "remote-workspace")), 0o700);

  // Keys: created by keygen, private, never printed.
  assert.equal(mode(sb.astraHome), 0o700);
  for (const f of ["agent-private.pem", "client-private.pem"]) assert.equal(mode(path.join(sb.astraHome, f)), 0o600);
  assert.ok(!r.out.includes("PRIVATE KEY"));

  // Personal config: real values, Access still fail-closed; template untouched.
  const personal = parseJsonc(fs.readFileSync(sb.personal, "utf8"));
  assert.equal(mode(sb.personal), 0o600);
  assert.match(personal.vars.AGENT_PUBLIC_KEY_B64, /^MCowBQYDK2VwAyEA/);
  assert.equal(personal.vars.ACCESS_ALLOWED_EMAILS, "owner@corp.test");
  assert.equal(personal.vars.MCP_DEVICE_ID, "my-mac");
  assert.equal(personal.vars.OAUTH_ISSUER, "https://astra-bridge-relay.example-sub.workers.dev");
  assert.equal(personal.vars.POLICY_AUD, "REPLACE_WITH_ACCESS_AUD");
  const template = parseJsonc(fs.readFileSync(path.join(sb.repo, "relay", "wrangler.jsonc"), "utf8"));
  assert.equal(template.vars.AGENT_PUBLIC_KEY_B64, "REPLACE_WITH_AGENT_PUBLIC_KEY_B64");

  // Deploy happened once, after an existence check and a dry run.
  assert.equal(sb.deploys(), 1);
  assert.match(sb.calls(), /wrangler deployments list --name astra-bridge-relay --json/);
  assert.match(sb.calls(), /wrangler deploy -c .*wrangler\.personal\.jsonc --dry-run/);

  // Agent: plist in the sandbox LaunchAgents, pointing at this checkout and a real Node; loaded.
  const plist = fs.readFileSync(sb.plist, "utf8");
  assert.ok(plist.includes(`<string>${path.join(sb.repo, "relay", "src", "agent.mjs")}</string>`));
  assert.ok(plist.includes("<string>https://astra-bridge-relay.example-sub.workers.dev</string>"));
  assert.ok(!/\/Cellar\//.test(plist), "no versioned Homebrew path");
  assert.ok(!plist.includes("PRIVATE"));
  assert.match(sb.calls(), /launchctl bootstrap gui\/\d+ .*com\.example\.astra-bridge-agent\.plist/);
  const state = JSON.parse(fs.readFileSync(path.join(sb.astraHome, "install-state.json"), "utf8"));
  assert.equal(state.deploy.worker, "astra-bridge-relay");
  assert.equal(mode(path.join(sb.astraHome, "install-state.json")), 0o600);

  // 3. Resume with the Access values: saved, redeployed; not claimed as verified.
  r = sb.run([...BASE, "--yes", "--team-domain", "myteam", "--policy-aud", AUD]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Access is NOT verified/);
  assert.match(r.out, /setup is not finished/);
  assert.equal(sb.deploys(), 2);
  const deployed = parseJsonc(fs.readFileSync(path.join(sb.state, "deployed-config.jsonc"), "utf8"));
  assert.equal(deployed.vars.TEAM_DOMAIN, "https://myteam.cloudflareaccess.com");
  assert.equal(deployed.vars.POLICY_AUD, AUD);
  const bootstraps = (sb.calls().match(/launchctl bootstrap/g) ?? []).length;

  // 4. Idempotent: nothing changed, so no deploy and no agent restart.
  r = sb.run([...BASE, "--yes"]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /is deployed and unchanged/);
  assert.match(r.out, /agent running/);
  assert.equal(sb.deploys(), 2);
  assert.equal((sb.calls().match(/launchctl bootstrap/g) ?? []).length, bootstraps);

  // 5. Doctor: read-only, passes offline; fails on a loose key mode without leaking the key.
  r = sb.run(["doctor", "--offline"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS  agent key/);
  assert.match(r.out, /PASS  launchd: running/);
  assert.ok(!r.out.includes("owner@corp.test"), "doctor output omits the owner email");
  const json = JSON.parse(sb.run(["doctor", "--offline", "--json"]).out);
  assert.equal(json.ok, true);
  fs.chmodSync(path.join(sb.astraHome, "client-private.pem"), 0o644);
  r = sb.run(["doctor", "--offline"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /FAIL  client key: .*chmod 600/);
  const pem = fs.readFileSync(path.join(sb.astraHome, "client-private.pem"), "utf8");
  const body = pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
  assert.ok(!r.out.includes(body) && !r.out.includes("PRIVATE KEY"));
  // The installer refuses to continue with a readable key instead of silently fixing it.
  r = sb.run([...BASE, "--yes"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /chmod 600/);
  fs.chmodSync(path.join(sb.astraHome, "client-private.pem"), 0o600);

  // 6. Terminal opt-in is explicit, warned about, and restarts the agent so it takes effect.
  r = sb.run([...BASE, "--yes", "--enable-terminal"]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /ANY command as your macOS user/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sb.remoteDir, "remote.json"), "utf8")).trustedTerminal, true);
  assert.ok((sb.calls().match(/launchctl bootstrap/g) ?? []).length > bootstraps, "agent restarted");
  r = sb.run(["doctor", "--offline"]);
  assert.match(r.out, /WARN  access mode: TERMINAL ON/);
  r = sb.run([...BASE, "--yes", "--file-only"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sb.remoteDir, "remote.json"), "utf8")).trustedTerminal, false);

  // 7. Uninstall keeps keys and config; --purge deletes only the listed Astra Bridge files.
  fs.writeFileSync(path.join(sb.astraHome, "my-notes.txt"), "keep me");
  r = sb.run(["uninstall", "--non-interactive"]);
  assert.equal(r.status, 3, "needs --yes when not interactive");
  assert.ok(fs.existsSync(sb.plist));
  r = sb.run(["uninstall", "--dry-run"]);
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(sb.plist));
  r = sb.run(["uninstall", "--non-interactive", "--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(sb.plist));
  assert.match(sb.calls(), /launchctl bootout/);
  assert.ok(fs.existsSync(path.join(sb.astraHome, "agent-private.pem")));
  assert.ok(fs.existsSync(sb.personal));
  r = sb.run(["uninstall", "--purge", "--non-interactive"]);
  assert.equal(r.status, 3, "purge needs --yes too");
  assert.ok(fs.existsSync(path.join(sb.astraHome, "agent-private.pem")));
  r = sb.run(["uninstall", "--purge", "--non-interactive", "--yes"]);
  assert.equal(r.status, 0, r.out);
  for (const f of ["agent-private.pem", "client-private.pem", "install-state.json"]) assert.ok(!fs.existsSync(path.join(sb.astraHome, f)), f);
  assert.ok(!fs.existsSync(sb.personal));
  assert.equal(fs.readFileSync(path.join(sb.astraHome, "my-notes.txt"), "utf8"), "keep me", "unrelated files stay");
  assert.ok(fs.existsSync(path.join(sb.remoteDir, "remote.json")), "mcp-commander config stays");
  assert.ok(fs.existsSync(path.join(sb.home, "remote-workspace")), "the workspace stays");
});

test("safety stops: not logged in, an existing Worker, unsafe workspace, real launchctl with a fake HOME", { skip }, (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);
  const args = [...BASE, "--yes", "--email", "owner@corp.test"];

  sb.flag("logged-out");
  let r = sb.run(args);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /npx wrangler login/);
  sb.flag("logged-out", false);

  // A Worker of that name exists and this Mac never deployed it: never overwritten without consent.
  sb.flag("worker-exists");
  r = sb.run(args);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /--replace-existing-worker/);
  assert.equal(sb.deploys(), 0);
  r = sb.run([...args, "--worker-name", "astra-bridge-relay-2"]);
  assert.equal(sb.deploys(), 0, "the other name exists too in this fake account");
  r = sb.run([...args, "--replace-existing-worker"]);
  assert.equal(sb.deploys(), 1, r.out);
  sb.flag("worker-exists", false);

  // mcp-commander's root guards still apply: the home folder or this checkout are refused.
  const other = makeSandbox();
  t.after(other.cleanup);
  for (const ws of [other.home, path.join(other.repo, "relay"), path.join(other.home, ".ssh", "a", "b")]) {
    r = other.run([...args, "--workspace", ws]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /refused this configuration/);
    assert.ok(!fs.existsSync(path.join(other.remoteDir, "remote.json")));
  }
  assert.ok(!fs.existsSync(path.join(other.home, ".ssh")), "folders created for a refused workspace are removed again");

  // The real launchctl must never load a plist from a sandbox HOME.
  r = sb.run(["uninstall", "--non-interactive", "--yes"], { ASTRA_LAUNCHCTL: "" });
  assert.equal(r.status, 1);
  assert.match(r.out, /refusing to run the real launchctl/);
  assert.ok(fs.existsSync(sb.plist), "nothing was removed");
});

test("another agent for the same relay and device stops the install; one for another device does not", { skip }, (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);
  const agents = path.dirname(sb.plist);
  fs.mkdirSync(agents, { recursive: true });
  const otherFile = path.join(agents, "com.someone.astra-bridge-agent.plist");
  const otherPlist = (device) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.someone.astra-bridge-agent</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/Users/x/old/relay/src/agent.mjs</string></array>
<key>EnvironmentVariables</key><dict>
<key>ASTRA_RELAY_URL</key><string>https://astra-bridge-relay.example-sub.workers.dev</string>
<key>ASTRA_DEVICE_ID</key><string>${device}</string>
</dict></dict></plist>
`;
  fs.writeFileSync(otherFile, otherPlist("my-mac"));
  const args = [...BASE, "--yes", "--email", "owner@corp.test"];
  let r = sb.run(args);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /already runs an agent for device "my-mac"/);
  assert.match(r.out, /launchctl bootout gui\/\d+\/com\.someone\.astra-bridge-agent/);
  assert.ok(!fs.existsSync(sb.plist), "ours is not installed next to it");
  assert.equal(fs.readFileSync(otherFile, "utf8"), otherPlist("my-mac"), "the other agent is never modified");

  fs.writeFileSync(otherFile, otherPlist("old-mac"));
  r = sb.run(args);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /different relay or device, so it is left alone/);
  assert.ok(fs.existsSync(sb.plist));
  r = sb.run(["doctor", "--offline"]);
  assert.match(r.out, /WARN  other agent: com\.someone\.astra-bridge-agent/);
});

test("the personal config must be gitignored before personal values are written", { skip }, (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);
  const git = (...a) => spawnSync("/usr/bin/git", ["-C", sb.repo, ...a], { encoding: "utf8" });
  if (git("init", "-q").status !== 0) return t.skip("git unavailable");
  fs.writeFileSync(path.join(sb.repo, "relay", ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(sb.repo, ".gitignore"), "node_modules\n");
  const r = sb.run([...BASE, "--yes", "--email", "owner@corp.test", "--skip-cloudflare"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not ignored by git/);
  assert.ok(!fs.existsSync(sb.personal));
});

test("usage errors: unknown options, secrets on the command line, contradictory modes", () => {
  const sb = { run: (args) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, "..", "astra-macos.mjs"), ...args], { encoding: "utf8" }) };
  for (const args of [["--bogus"], ["--token", "x"], ["--file-only", "--enable-terminal"], ["doctor", "--email", "a@b.cd"], ["--account-id", "nope"], ["frobnicate"]]) {
    const r = sb.run(args);
    assert.equal(r.status, 2, args.join(" "));
  }
  assert.equal(sb.run(["--help"]).status, 0);
});

test("install-macos.sh wrapper: refuses non-macOS-ready environments before running Node code", () => {
  const script = path.resolve(import.meta.dirname, "..", "..", "install-macos.sh");
  const noNode = spawnSync("/bin/sh", [script, "--help"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/tmp" } });
  if (!fs.existsSync("/usr/local/bin/node") && !fs.existsSync("/opt/homebrew/bin/node")) {
    assert.equal(noNode.status, 1);
    assert.match(noNode.stderr, /nodejs\.org/);
  } else {
    assert.equal(noNode.status, 1);
    assert.match(noNode.stderr, /this shell does not see it/);
  }
  const ok = spawnSync("/bin/sh", [script, "--help"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Usage:/);
});
