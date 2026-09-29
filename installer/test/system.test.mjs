import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createContext } from "../lib/context.mjs";
import { installReason, npmCi } from "../lib/deps.mjs";
import { KEY_FILES, inspectKeys, keyPresence } from "../lib/keys.mjs";
import { conflicts, createLaunchd, findOtherAgents } from "../lib/launchd.mjs";
import { isVersionedPath, stableNodePath } from "../lib/node-path.mjs";
import { checkPrereqs, parseVersion } from "../lib/prereqs.mjs";
import { classifyAccess, probeAccess, probeAgentStatus, probeHealth, signedHeaders } from "../lib/relay-probe.mjs";
import { lastAgentEvent } from "../lib/doctor.mjs";
import { parseDeployUrl } from "../lib/install.mjs";
import { REPO, tmpDir } from "./helpers.mjs";

function fakeRun(table) {
  return (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const hit = table[key];
    if (hit === undefined) return { status: 1, stdout: "", stderr: "", error: null };
    return typeof hit === "string" ? { status: 0, stdout: hit, stderr: "" } : hit;
  };
}

const GOOD_MAC = {
  "/usr/bin/sw_vers -productVersion": "14.6.1\n",
  "/usr/sbin/sysctl -n hw.optional.arm64": "1\n",
  "/usr/sbin/sysctl -n sysctl.proc_translated": "0\n",
  "npm --version": "10.9.0\n",
  "/usr/bin/xcode-select -p": "/Library/Developer/CommandLineTools\n",
  "/usr/bin/xcrun --find swiftc": "/Library/Developer/CommandLineTools/usr/bin/swiftc\n",
};

test("prerequisites: a supported Apple silicon Mac passes; blockers name the exact fix", () => {
  const ctx = { ...createContext(), npm: "npm", execPath: "/opt/homebrew/bin/node", repoDir: "/Users/x/astra-bridge" };
  const ok = checkPrereqs(ctx, { system: { platform: "darwin", arch: "arm64", nodeVersion: "22.12.0", uid: 501, run: fakeRun(GOOD_MAC) } });
  assert.deepEqual(ok.filter((c) => c.level !== "pass"), []);

  const old = checkPrereqs(ctx, {
    system: { platform: "darwin", arch: "x64", nodeVersion: "20.18.0", uid: 0, run: fakeRun({ ...GOOD_MAC, "/usr/bin/sw_vers -productVersion": "12.7\n", "/usr/sbin/sysctl -n sysctl.proc_translated": "1\n", "/usr/bin/xcode-select -p": { status: 2, stdout: "", stderr: "" } }) },
  });
  const by = Object.fromEntries(old.map((c) => [c.name, c]));
  assert.equal(by.user.level, "fail");
  assert.equal(by["macOS version"].level, "fail");
  assert.equal(by["Node.js"].level, "fail");
  assert.ok(by["Node.js"].fix.some((l) => l.includes("nodejs.org")));
  assert.equal(by.architecture.level, "warn");
  assert.match(by.architecture.detail, /Rosetta/);
  assert.equal(by["Xcode Command Line Tools"].level, "warn", "only the optional GUI tools need them");
  assert.ok(by["Xcode Command Line Tools"].fix.includes("Install them with: xcode-select --install"));

  const gui = checkPrereqs(ctx, { needGui: true, system: { platform: "darwin", arch: "arm64", nodeVersion: "22.1.0", uid: 501, run: fakeRun({ ...GOOD_MAC, "/usr/bin/xcode-select -p": { status: 2, stdout: "", stderr: "" } }) } });
  assert.equal(gui.find((c) => c.name === "Xcode Command Line Tools").level, "fail");

  const linux = checkPrereqs(ctx, { system: { platform: "linux", run: fakeRun({}) } });
  assert.equal(linux[0].level, "fail");
  assert.equal(parseVersion("v22.12.0").major, 22);
  assert.equal(parseVersion("garbage"), null);
});

test("stable Node path: a Homebrew Cellar binary is replaced by the stable symlink that resolves to it", () => {
  const base = tmpDir();
  try {
    const cellarBin = path.join(base, "homebrew", "Cellar", "node", "24.1.0", "bin");
    fs.mkdirSync(cellarBin, { recursive: true });
    const real = path.join(cellarBin, "node");
    fs.writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    fs.mkdirSync(path.join(base, "homebrew", "bin"));
    fs.symlinkSync("../Cellar/node/24.1.0/bin/node", path.join(base, "homebrew", "bin", "node"));
    fs.mkdirSync(path.join(base, "homebrew", "opt", "node", "bin"), { recursive: true });
    fs.symlinkSync(real, path.join(base, "homebrew", "opt", "node", "bin", "node"));
    const other = path.join(base, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "node"), "#!/bin/sh\n", { mode: 0o755 });

    // PATH first: the same binary under a stable name.
    let r = stableNodePath(real, { pathEnv: `${other}:${path.join(base, "homebrew", "bin")}`, extraCandidates: [] });
    assert.equal(r.path, path.join(base, "homebrew", "bin", "node"), "a different node earlier on PATH is skipped");
    assert.equal(r.stable, true);
    // Not on PATH: Homebrew's opt/<formula> link is derived from the Cellar path.
    r = stableNodePath(real, { pathEnv: "", extraCandidates: [] });
    assert.equal(r.path, path.join(base, "homebrew", "opt", "node", "bin", "node"));
    // Nothing stable points at it: keep execPath and say why.
    fs.rmSync(path.join(base, "homebrew", "opt"), { recursive: true });
    fs.rmSync(path.join(base, "homebrew", "bin"), { recursive: true });
    r = stableNodePath(real, { pathEnv: "", extraCandidates: [] });
    assert.equal(r.path, real);
    assert.equal(r.stable, false);
    assert.match(r.note, /re-run/);
    // A plain installed Node is already stable.
    assert.equal(stableNodePath(path.join(other, "node"), { pathEnv: other, extraCandidates: [] }).path, path.join(other, "node"));
    assert.ok(isVersionedPath("/Users/x/.nvm/versions/node/v22.1.0/bin/node"));
    assert.ok(!isVersionedPath("/usr/local/bin/node"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("keys: keygen output is inspected without exposing private keys; loose modes and partial pairs are caught", () => {
  const dir = path.join(tmpDir(), "keys");
  try {
    assert.equal(keyPresence(dir), "none");
    const gen = spawnSync(process.execPath, [path.join(REPO, "relay", "scripts", "keygen.mjs"), "--dir", dir], { encoding: "utf8" });
    assert.equal(gen.status, 0, gen.stderr);
    assert.ok(!gen.stdout.includes("PRIVATE KEY"));
    const k = inspectKeys(dir);
    assert.ok(k.dir.ok && k.agent.ok && k.client.ok, JSON.stringify(k));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    // Same public keys as keygen --print-public.
    const printed = spawnSync(process.execPath, [path.join(REPO, "relay", "scripts", "keygen.mjs"), "--dir", dir, "--print-public"], { encoding: "utf8" }).stdout;
    assert.ok(printed.includes(k.agent.publicKeyB64) && printed.includes(k.client.publicKeyB64));
    assert.ok(!JSON.stringify(k).includes("PRIVATE"), "inspection results carry no private material");

    fs.chmodSync(path.join(dir, KEY_FILES.client), 0o644);
    assert.match(inspectKeys(dir).client.problems.join(), /chmod 600/);
    fs.rmSync(path.join(dir, KEY_FILES.client));
    assert.equal(keyPresence(dir), "partial");
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("npm stamp: node_modules counts as installed only for the same lockfile and architecture", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    assert.equal(installReason(dir), "node_modules missing");
    fs.mkdirSync(path.join(dir, "node_modules"));
    assert.match(installReason(dir), /not installed by this installer/);
    const stamp = { lockSha256: "x", platform: process.platform, arch: process.arch };
    fs.writeFileSync(path.join(dir, "node_modules", ".astra-bridge-install.json"), JSON.stringify(stamp));
    assert.match(installReason(dir), /package-lock.json changed/);

    // npm ci through a fake npm: exact flags, same-Node PATH, NODE_ENV dropped, stamp only on success.
    const npm = path.join(dir, "fake-npm");
    fs.writeFileSync(npm, `#!/bin/sh\necho "$* NODE_ENV=\${NODE_ENV-unset} PWD=$PWD" > "${dir}/npm-args"\nmkdir -p node_modules\n[ -f "${dir}/fail" ] && exit 1\nexit 0\n`, { mode: 0o755 });
    const ctx = { ...createContext({ env: { PATH: "/usr/bin:/bin", NODE_ENV: "production" } }), npm };
    assert.equal(ctx.childEnv.NODE_ENV, undefined);
    assert.ok(ctx.childEnv.PATH.startsWith(`${path.dirname(process.execPath)}:`));
    assert.equal(npmCi(ctx, dir), true);
    assert.match(fs.readFileSync(path.join(dir, "npm-args"), "utf8"), /^ci --include=dev --no-audit --no-fund NODE_ENV=unset /);
    assert.equal(installReason(dir), null);
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3,"x":1}');
    assert.match(installReason(dir), /changed/);
    fs.writeFileSync(path.join(dir, "fail"), "");
    assert.equal(npmCi(ctx, dir), false);
    assert.match(installReason(dir), /changed/, "a failed install leaves the old stamp, so the next run retries");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launchd wrapper parses launchctl print; other Astra Bridge LaunchAgents are detected", () => {
  const calls = [];
  const out = "gui/501/com.example.astra-bridge-agent = {\n\tstate = running\n\tpid = 99\n\tlast exit code = (never exited)\n}\n";
  const launchd = createLaunchd({ launchctl: "/fake", uid: 501, label: "com.example.astra-bridge-agent", run: (cmd, args) => (calls.push(args), { status: 0, stdout: out, stderr: "" }) });
  assert.deepEqual(launchd.status(), { loaded: true, state: "running", pid: 99, lastExitCode: "(never exited)" });
  launchd.bootstrap("/p.plist");
  assert.deepEqual(calls.at(-1), ["bootstrap", "gui/501", "/p.plist"]);

  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "com.example.astra-bridge-agent.plist"), "<key>ASTRA_DEVICE_ID</key>");
    fs.writeFileSync(path.join(dir, "com.someone.astra-bridge-agent.plist"), "<key>Label</key>\n<string>com.someone.astra-bridge-agent</string><key>ASTRA_DEVICE_ID</key>");
    fs.writeFileSync(path.join(dir, "com.other.tool.plist"), "<key>Label</key><string>com.other.tool</string>");
    assert.deepEqual(findOtherAgents(dir, "com.example.astra-bridge-agent").map((a) => a.label), ["com.someone.astra-bridge-agent"]);
    const other = { relayUrl: "https://r.sub.workers.dev/", deviceId: "my-mac" };
    assert.equal(conflicts(other, "https://r.sub.workers.dev", "my-mac"), true);
    assert.equal(conflicts(other, "https://r.sub.workers.dev", "studio"), false);
    assert.equal(conflicts(other, "https://other.sub.workers.dev", "my-mac"), false);
    assert.equal(conflicts({ relayUrl: null, deviceId: null }, "https://r.sub.workers.dev", "my-mac"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wrangler deploy output: only this Worker's workers.dev URL is picked up", () => {
  const output = "Uploaded astra-bridge-relay\n  https://astra-bridge-relay.my-sub.workers.dev\n  https://<VERSION_PREFIX>-astra-bridge-relay.my-sub.workers.dev\n";
  assert.equal(parseDeployUrl(output, "astra-bridge-relay"), "https://astra-bridge-relay.my-sub.workers.dev");
  assert.equal(parseDeployUrl("https://other.my-sub.workers.dev", "astra-bridge-relay"), null);
});

test("agent log: the last meaningful event is reported with a cause", () => {
  assert.equal(lastAgentEvent("[astra-bridge-agent] connected\n").level, "pass");
  const rejected = lastAgentEvent("[astra-bridge-agent] connected\n[astra-bridge-agent] websocket rejected status=401\n[astra-bridge-agent] disconnected code=1006 uptimeMs=0 reason=\n");
  assert.equal(rejected.level, "warn", "the most recent line wins");
  assert.match(lastAgentEvent("[astra-bridge-agent] websocket rejected status=401\n").why, /agent key/);
  assert.equal(lastAgentEvent("[mcp-commander-remote-stdio] refusing to start: Invalid remote.json\n").level, "fail");
  assert.equal(lastAgentEvent("unrelated\n"), null);
});

test("Access classification distinguishes Access, the Worker's own answers and misconfiguration", () => {
  const H = (h) => new Headers(h);
  assert.equal(classifyAccess({ status: 401, headers: H({ "www-authenticate": 'Bearer resource_metadata="https://r.x.workers.dev/.well-known/cloudflare-access-protected-resource/mcp"' }) }).state, "verified");
  // The Worker's own static-mode challenge must never count as Access.
  assert.equal(classifyAccess({ status: 401, headers: H({ "www-authenticate": 'Bearer resource_metadata="https://r.x.workers.dev/.well-known/oauth-protected-resource/mcp"' }) }).state, "unknown");
  assert.equal(classifyAccess({ status: 401, headers: H({}) }).state, "not-protected");
  assert.equal(classifyAccess({ status: 503, headers: H({}) }).state, "not-configured");
  const login = "https://myteam.cloudflareaccess.com/cdn-cgi/access/login/r.x.workers.dev?kid=abc&redirect_url=%2Fmcp";
  assert.equal(classifyAccess({ status: 302, headers: H({ location: login }) }, { expectedTeamHost: "myteam.cloudflareaccess.com" }).state, "no-managed-oauth");
  assert.equal(classifyAccess({ status: 302, headers: H({ location: login }) }, { expectedTeamHost: "other.cloudflareaccess.com" }).state, "wrong-team");
  assert.equal(classifyAccess({ status: 200, headers: H({}) }).state, "unknown");
});

test("relay probes: health, signed status (verifiable signature) and Access, against a local server", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const dir = tmpDir();
  const keyFile = path.join(dir, "client-private.pem");
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    if (req.url === "/healthz") return res.end(JSON.stringify({ ok: true, service: "astra-bridge-relay" }));
    if (req.url === "/v1/device/my-mac/status") {
      const canonical = [req.headers["x-astra-timestamp"], req.headers["x-astra-nonce"], "GET", req.url, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"].join("\n");
      const ok = verify(null, Buffer.from(canonical), publicKey, Buffer.from(req.headers["x-astra-signature"], "base64"));
      res.statusCode = ok ? 200 : 401;
      return res.end(JSON.stringify(ok ? { ok: true, agentConnected: true, mcpHealthy: true, lastSeenAgeMs: 1200 } : { error: "unauthorized" }));
    }
    if (req.url === "/mcp") {
      res.statusCode = 401;
      res.setHeader("www-authenticate", 'Bearer resource_metadata="https://h/.well-known/cloudflare-access-protected-resource/mcp"');
      return res.end();
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = server.address().port;
  // The probes only ever build https URLs; route them to the local plain-http server.
  const fetchImpl = (url, init) => fetch(String(url).replace("https://relay.test", `http://127.0.0.1:${port}`), init);
  const base = "https://relay.test";

  assert.deepEqual((await probeHealth(base, { fetchImpl })).ok, true);
  const st = await probeAgentStatus(base, "my-mac", keyFile, { fetchImpl });
  assert.deepEqual(st, { ok: true, status: 200, agentConnected: true, mcpHealthy: true, lastSeenAgeMs: 1200 });
  assert.equal((await probeAccess(base, { fetchImpl })).state, "verified");
  assert.equal((await probeAgentStatus(base, "my-mac", path.join(dir, "missing.pem"), { fetchImpl })).ok, false);
  const unreachable = await probeHealth("https://relay.test", { fetchImpl: () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })) });
  assert.deepEqual(unreachable, { ok: false, error: "ENOTFOUND" });
  for (const r of seen) assert.ok(!JSON.stringify(r.headers).includes("PRIVATE"), "no key material on the wire");
  const h = signedHeaders(privateKey, "GET", "/x");
  assert.deepEqual(Object.keys(h), ["X-Astra-Timestamp", "X-Astra-Nonce", "X-Astra-Signature"]);
});

test("source release helper: the same commit gives byte-identical archives with only tracked files", (t) => {
  const git = spawnSync("/usr/bin/git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (git.status !== 0) return t.skip("not a git checkout");
  const a = tmpDir();
  const b = tmpDir();
  t.after(() => {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });
  const script = path.join(REPO, "installer", "build-source-release.sh");
  const one = spawnSync("/bin/sh", [script, "--out", a], { encoding: "utf8" });
  const two = spawnSync("/bin/sh", [script, "--out", b], { encoding: "utf8" });
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, two.stdout, "same checksum line twice");
  const [sum, file] = one.stdout.trim().split(/\s+/);
  assert.match(sum, /^[0-9a-f]{64}$/);
  assert.match(file, /^astra-bridge-[\w.]+-[0-9a-f]{12}\.tar\.gz$/);
  assert.equal(spawnSync("/usr/bin/shasum", ["-a", "256", "-c", `${file}.sha256`], { cwd: a }).status, 0);
  const list = spawnSync("/usr/bin/tar", ["-tzf", path.join(a, file)], { encoding: "utf8" }).stdout;
  assert.ok(list.includes("/relay/wrangler.jsonc"));
  assert.ok(!/node_modules|wrangler\.personal|\.pem$/m.test(list), "no dependencies, personal config or keys");
});
