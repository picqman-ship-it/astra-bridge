import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { agentConfig } from "../src/agent-lib.mjs";
import { parseArgs, resolveValues, renderPlist, readTemplate } from "../scripts/install-agent.mjs";

const DEVICE = "beta-11111111-2222-4333-8444-555555555555";
const keys = generateKeyPairSync("ed25519");
const publicKeyB64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const agentFingerprint = createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex");
const CONTROL_TOOLS = ["start_process", "read_process_output", "interact_with_process", "force_terminate",
  "list_sessions", "list_processes", "kill_process", "get_recent_tool_calls", "get_usage_stats",
  "job_start", "job_status", "job_list", "job_logs", "job_cancel", "list_windows", "inspect_ui",
  "press_element", "set_element_value"];
const FILE_TOOLS = ["get_config", "read_file", "read_multiple_files", "write_file", "create_directory",
  "list_directory", "move_file", "get_file_info", "start_search", "get_more_search_results",
  "stop_search", "list_searches", "edit_block"];
function state(origin = "https://relay.example") {
  return {
    accountPairing: { registered: true, deviceId: DEVICE, relayUrl: origin, agentPublicKeyB64: publicKeyB64 },
    accountControl: { version: 1, deviceId: DEVICE, relayUrl: origin, agentFingerprint,
      accountEmail: "alice@example.com", identityIssuer: "https://team.cloudflareaccess.com",
      identityFingerprint: "d".repeat(64), terminalEnabled: true, guiEnabled: false,
      pending: null, verifiedAt: "2026-10-03T00:00:00.000Z" },
  };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-account-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t, initial = state()) {
  const { createAccountControlPolicy } = await import("../src/account-control-policy.mjs");
  const dir = temporary(t);
  const stateFile = path.join(dir, "install-state.json");
  const remoteDir = path.join(dir, "remote");
  fs.mkdirSync(remoteDir);
  const save = value => fs.writeFileSync(stateFile, JSON.stringify(value));
  const config = value => fs.writeFileSync(path.join(remoteDir, "remote.json"), JSON.stringify(value));
  save(initial);
  config({ trustedTerminal: true, trustedGui: false });
  const policy = createAccountControlPolicy({ stateFile, commanderRemoteDir: remoteDir, deviceId: DEVICE,
    relayOrigin: "https://relay.example", agentPublicKeyB64: publicKeyB64 });
  return { dir, stateFile, save, config, policy };
}

test("account control LaunchAgent carries an explicit validated non-secret state path", t => {
  const home = temporary(t);
  const stateFile = path.join(home, ".astra-bridge", "install-state.json");
  const flags = parseArgs(["--relay-url", "https://relay.example", "--device-id", DEVICE,
    "--account-control-state", stateFile]);
  const resolved = resolveValues(flags, {}, home);
  const plist = renderPlist(readTemplate().text, resolved.values);
  assert.ok(plist.includes("<key>ASTRA_ACCOUNT_CONTROL_STATE_FILE</key>"));
  assert.ok(plist.includes(stateFile));
  const config = agentConfig({ ASTRA_RELAY_URL: "https://relay.example", ASTRA_RELAY_HOST: "relay.example",
    ASTRA_DEVICE_ID: DEVICE, ASTRA_ACCOUNT_CONTROL_STATE_FILE: stateFile },
  { homedir: home, execPath: process.execPath });
  assert.equal(config.accountControlStateFile, stateFile);
  for (const value of ["", "relative/install-state.json", "/bad\nstate"]) {
    assert.throws(() => agentConfig({ ASTRA_RELAY_URL: "https://relay.example", ASTRA_RELAY_HOST: "relay.example",
      ASTRA_DEVICE_ID: DEVICE, ASTRA_ACCOUNT_CONTROL_STATE_FILE: value },
    { homedir: home, execPath: process.execPath }), /state.*absolute|state.*control|state.*required/i);
  }
});

test("completed exact local account review permits only its configured control family", async t => {
  const f = await fixture(t);
  assert.ok(f.policy.allows("start_process"));
  assert.ok(f.policy.allows("get_recent_tool_calls"));
  assert.ok(!f.policy.allows("inspect_ui"));
  assert.ok(!f.policy.allows("unknown_tool"));
  for (const name of FILE_TOOLS) assert.ok(f.policy.allows(name), name);
  const gui = state();
  gui.accountControl.terminalEnabled = false;
  gui.accountControl.guiEnabled = true;
  f.save(gui); f.config({ trustedTerminal: false, trustedGui: true });
  assert.ok(f.policy.allows("inspect_ui"));
  for (const name of CONTROL_TOOLS.filter(name => !["list_windows", "inspect_ui", "press_element", "set_element_value"].includes(name))) {
    assert.ok(!f.policy.allows(name), name);
  }
});

test("pending transaction denies every control and telemetry tool but retains file operations", async t => {
  const initial = state(); initial.accountControl.pending = "elevation";
  const f = await fixture(t, initial);
  for (const name of CONTROL_TOOLS) assert.ok(!f.policy.allows(name), name);
  for (const name of FILE_TOOLS) assert.ok(f.policy.allows(name), name);
  assert.deepEqual(f.policy.filterTools({ tools: FILE_TOOLS.concat(CONTROL_TOOLS).map(name => ({ name })) }).tools
    .map(tool => tool.name), FILE_TOOLS);
});

test("state completion and later interruption take effect without agent restart", async t => {
  const initial = state(); initial.accountControl.pending = "elevation";
  const f = await fixture(t, initial);
  assert.ok(!f.policy.allows("start_process"));
  f.save(state());
  assert.ok(f.policy.allows("start_process"));
  const interrupted = state(); interrupted.accountControl.pending = "server_reduction_unverified";
  f.save(interrupted);
  assert.ok(!f.policy.allows("start_process"));
});

test("missing malformed and absent completed review fail closed even at a new startup", async t => {
  const f = await fixture(t);
  for (const value of [{}, { accountPairing: state().accountPairing }, { accountControl: state().accountControl }]) {
    f.save(value);
    assert.ok(!f.policy.allows("start_process"));
    assert.ok(f.policy.allows("read_file"));
  }
  fs.writeFileSync(f.stateFile, "{");
  assert.ok(!f.policy.allows("start_process"));
  fs.rmSync(f.stateFile);
  assert.ok(!f.policy.allows("start_process"));
  const { createAccountControlPolicy } = await import("../src/account-control-policy.mjs");
  const reboot = createAccountControlPolicy({ stateFile: f.stateFile, commanderRemoteDir: path.join(f.dir, "remote"),
    deviceId: DEVICE, relayOrigin: "https://relay.example", agentPublicKeyB64: publicKeyB64 });
  assert.ok(!reboot.allows("start_process"));
  assert.ok(reboot.allows("read_file"));
});

test("registered binding review metadata and local permission drift deny control", async t => {
  const f = await fixture(t);
  for (const change of [
    value => { value.accountPairing.registered = false; },
    value => { value.accountPairing.deviceId = "other"; },
    value => { value.accountPairing.agentPublicKeyB64 = "other"; },
    value => { value.accountPairing.relayUrl = "https://other.example"; },
    value => { value.accountControl.deviceId = "other"; },
    value => { value.accountControl.relayUrl = "https://other.example"; },
    value => { value.accountControl.agentFingerprint = "e".repeat(64); },
    value => { value.accountControl.accountEmail = "a\u0000b"; },
    value => { value.accountControl.identityIssuer = "http://team.cloudflareaccess.com"; },
    value => { value.accountControl.identityFingerprint = ""; },
    value => { value.accountControl.verifiedAt = ""; },
    value => { delete value.accountControl.pending; },
  ]) {
    const changed = state(); change(changed); f.save(changed);
    assert.ok(!f.policy.allows("start_process"));
  }
  f.save(state()); f.config({ trustedTerminal: true, trustedGui: true });
  assert.ok(!f.policy.allows("start_process"));
  f.config({ trustedTerminal: false, trustedGui: false });
  assert.ok(!f.policy.allows("start_process"));
});

test("unmarked personal and invited-beta agents keep their existing local policy", async t => {
  const { createAccountControlPolicy } = await import("../src/account-control-policy.mjs");
  const policy = createAccountControlPolicy({ stateFile: null });
  for (const name of FILE_TOOLS.concat(CONTROL_TOOLS)) assert.ok(policy.allows(name));
});

test("Mac account file/control allowlists match the reviewed relay allowlists", async () => {
  const policy = await import("../src/account-control-policy.mjs");
  const relay = await import("../.test-tmp/beta-registry.mjs");
  assert.deepEqual([...policy.ACCOUNT_FILE_TOOLS].sort(), [...relay.BETA_FILE_ONLY_TOOLS].sort());
  assert.deepEqual([...policy.ACCOUNT_TERMINAL_TOOLS].sort(),
    [...relay.TERMINAL_TOOL_NAMES, "get_usage_stats"].sort());
  assert.deepEqual([...policy.ACCOUNT_GUI_TOOLS].sort(), [...relay.GUI_TOOL_NAMES].sort());
});

test("live agent restart with pending account consent blocks control locally and completion opens it", { timeout: 20000 }, async t => {
  const dir = temporary(t);
  const certFile = path.join(dir, "cert.pem"), tlsKeyFile = path.join(dir, "tls.pem");
  const certified = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", tlsKeyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  assert.equal(certified.status, 0);
  const keyFile = path.join(dir, "agent-private.pem"), stateFile = path.join(dir, "install-state.json");
  fs.writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "remote.json"), JSON.stringify({ trustedTerminal: true, trustedGui: false }));
  const calledFile = path.join(dir, "called.jsonl"), entry = path.join(dir, "synthetic-mcp.mjs");
  fs.writeFileSync(entry, [
    'import fs from "node:fs";',
    "import { Server } from " + JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js")) + ";",
    "import { StdioServerTransport } from " + JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js")) + ";",
    "import { ListToolsRequestSchema, CallToolRequestSchema } from " + JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js")) + ";",
    'const s = new Server({name:"synthetic",version:"1"}, {capabilities:{tools:{}}});',
    's.setRequestHandler(ListToolsRequestSchema, async () => ({tools:["read_file","start_process","inspect_ui","get_recent_tool_calls","job_logs"].map(name => ({name,inputSchema:{type:"object"}}))}));',
    "s.setRequestHandler(CallToolRequestSchema, async req => { fs.appendFileSync(" + JSON.stringify(calledFile) +
      ', JSON.stringify(req.params.name)+"\\n"); return {content:[{type:"text",text:"synthetic "+req.params.name}]}; });',
    "await s.connect(new StdioServerTransport());",
  ].join("\n"));
  const server = https.createServer({ key: fs.readFileSync(tlsKeyFile), cert: fs.readFileSync(certFile) });
  const wss = new WebSocketServer({ server });
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "localhost", resolve));
  const origin = "https://localhost:" + server.address().port;
  const initial = state(origin); initial.accountControl.pending = "elevation";
  fs.writeFileSync(stateFile, JSON.stringify(initial));
  const pending = new Map(); let seq = 0;
  const connected = new Promise(resolve => wss.once("connection", socket => {
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "ping") socket.send('{"type":"pong"}');
      if (frame.type === "heartbeat") socket.send('{"type":"heartbeat_ack"}');
      if (frame.type === "rpc_result") pending.get(frame.id)?.(frame);
    });
    resolve(socket);
  }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/agent.mjs", import.meta.url))], {
    env: { ...process.env, ASTRA_RELAY_URL: origin, ASTRA_RELAY_HOST: "localhost", ASTRA_DEVICE_ID: DEVICE,
      ASTRA_AGENT_KEY_FILE: keyFile, ASTRA_COMMANDER_ENTRY: entry, ASTRA_COMMANDER_REMOTE_DIR: dir,
      ASTRA_ACCOUNT_CONTROL_STATE_FILE: stateFile, NODE_EXTRA_CA_CERTS: certFile },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = []; child.stderr.on("data", data => stderr.push(data.toString()));
  t.after(async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); } });
  const socket = await Promise.race([connected, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("agent connection timeout: " + stderr.join(""))), 6000);
    timer.unref();
  })]);
  const rpc = payload => new Promise((resolve, reject) => {
    const id = "policy-" + (++seq);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC timeout")); }, 6000);
    pending.set(id, frame => { clearTimeout(timer); pending.delete(id); resolve(frame); });
    socket.send(JSON.stringify({ type: "rpc", id, payload }));
  });
  const control = await rpc({ action: "tools/call", name: "start_process", arguments: { command: "synthetic" } });
  assert.equal(control.error, "tool_error", "pending consent must stop RPC before local MCP call");
  const list = await rpc({ action: "tools/list" });
  assert.deepEqual(list.result.tools.map(tool => tool.name), ["read_file"]);
  const file = await rpc({ action: "tools/call", name: "read_file" });
  assert.ok(file.result.content[0].text.includes("synthetic read_file"));
  fs.writeFileSync(stateFile, JSON.stringify(state(origin)));
  const completed = await rpc({ action: "tools/call", name: "start_process", arguments: { command: "synthetic" } });
  assert.ok(completed.result.content[0].text.includes("synthetic start_process"));
  fs.rmSync(stateFile);
  const missing = await rpc({ action: "tools/call", name: "job_logs" });
  assert.equal(missing.error, "tool_error");
  assert.deepEqual(fs.readFileSync(calledFile, "utf8").trim().split("\n").map(value => JSON.parse(value)),
    ["read_file", "start_process"]);
});
