import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ConcurrencyGate } from "../src/agent-lib.mjs";
import {
  checkWorkspaceOwnership,
  createDemoExecutor,
  handleRpcMessage,
  recordWorkspaceOwnership,
  resolveDemoConnection,
  resolveDemoPaths,
  signedHeaders,
} from "../src/demo-agent-lib.mjs";
import { CommandRefused, parseDemoCommand } from "../src/demo-commands.mjs";
import { DemoRuntime, LIMITS, SEED_FILES } from "../src/demo-runtime.mjs";
import { DEMO_IDEMPOTENT_TOOLS, DEMO_TOOL_NAMES, DEMO_TOOLS } from "../src/demo-tools.mjs";
import { IDEMPOTENCY_REQUIRED, TOOL_SAFETY, exposeApprovedTool } from "../.test-tmp/tool-policy.mjs";
import worker, { DeviceRelay } from "../.test-tmp/index.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const SECRET = "TOP-SECRET-OUTSIDE-THE-SANDBOX";
let keySeq = 0;
const key = (label = "k") => `${label}-key-${String(++keySeq).padStart(4, "0")}`;
const textOf = (r) => r.content.map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

/** A fresh sandbox next to an "outside" directory holding a secret the demo must never reveal. */
async function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "astra-demo-test-"));
  const root = path.join(base, "workspace");
  const stateDir = path.join(base, "state");
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), `${SECRET}\n`);
  let rt = await DemoRuntime.create({ root, stateDir });
  const seen = [];
  const env = {
    base,
    root,
    stateDir,
    outside,
    get rt() { return rt; },
    async call(name, args) {
      const r = await rt.callTool(name, args);
      seen.push(textOf(r));
      return r;
    },
    async restart() {
      await rt.close();
      rt = await DemoRuntime.create({ root, stateDir, seed: false });
    },
    seen,
  };
  t.after(async () => {
    await rt.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return env;
}

function assertNoHostPaths(env, texts) {
  const forbidden = [env.base, fs.realpathSync(env.base), os.homedir(), SECRET, "/Users/", "/private/var/"];
  for (const text of texts) {
    for (const needle of forbidden) assert.ok(!text.includes(needle), `result leaked ${needle}: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Descriptors

test("demo exposes exactly the 31 reviewed tool names with the production idempotency set", () => {
  assert.equal(DEMO_TOOLS.length, 31);
  assert.deepEqual([...DEMO_TOOL_NAMES].sort(), Object.keys(TOOL_SAFETY).sort());
  assert.deepEqual([...DEMO_IDEMPOTENT_TOOLS].sort(), [...IDEMPOTENCY_REQUIRED].sort());
  for (const tool of DEMO_TOOLS) {
    const exposed = exposeApprovedTool(structuredClone(tool));
    assert.ok(exposed, `${tool.name} must survive the relay's exposeApprovedTool`);
    assert.equal(exposed.inputSchema.required.includes("idempotencyKey"), IDEMPOTENCY_REQUIRED.has(tool.name), tool.name);
    assert.equal(tool.inputSchema.type, "object");
    for (const req of tool.inputSchema.required) assert.ok(req in tool.inputSchema.properties, `${tool.name}.${req}`);
  }
});

test("demo input schemas keep the production parameter names", () => {
  // Parameter names of mcp-commander's remote tools (transcribed; idempotencyKey added on gated tools).
  const expected = {
    get_config: [],
    read_file: ["path", "offset", "length", "isUrl"],
    read_multiple_files: ["paths"],
    write_file: ["path", "content", "mode"],
    create_directory: ["path"],
    list_directory: ["path", "depth"],
    move_file: ["source", "destination"],
    get_file_info: ["path"],
    start_search: ["path", "pattern", "searchType", "filePattern", "ignoreCase", "maxResults", "includeHidden",
      "contextLines", "timeout_ms", "literalSearch", "earlyTermination"],
    get_more_search_results: ["sessionId", "offset", "length"],
    stop_search: ["sessionId"],
    list_searches: [],
    edit_block: ["file_path", "old_string", "new_string", "expected_replacements"],
    list_windows: ["app", "includeMinimized", "limit", "timeoutMs"],
    inspect_ui: ["app", "windowId", "windowTitle", "windowIndex", "ref", "path", "role", "name", "identifier", "maxDepth", "maxElements", "includeValues", "timeoutMs"],
    press_element: ["ref", "app", "windowId", "windowTitle", "windowIndex", "role", "name", "identifier", "path", "timeoutMs"],
    set_element_value: ["ref", "app", "windowId", "windowTitle", "windowIndex", "role", "name", "identifier", "path", "timeoutMs", "value"],
    start_process: ["command", "timeout_ms", "shell", "cwd"],
    read_process_output: ["pid", "timeout_ms", "offset", "length"],
    interact_with_process: ["pid", "input", "timeout_ms", "wait_for_prompt"],
    force_terminate: ["pid"],
    list_sessions: [],
    list_processes: ["filter", "limit"],
    kill_process: ["pid", "signal"],
    get_recent_tool_calls: ["maxResults", "toolName", "since"],
    get_usage_stats: [],
    job_start: ["command", "cwd", "shell", "timeoutSeconds", "label"],
    job_status: ["jobId"],
    job_list: ["state", "limit"],
    job_logs: ["jobId", "stream", "offset", "length"],
    job_cancel: ["jobId", "wait_ms"],
  };
  for (const tool of DEMO_TOOLS) {
    const props = Object.keys(tool.inputSchema.properties).filter((p) => p !== "idempotencyKey").sort();
    assert.deepEqual(props, [...expected[tool.name]].sort(), tool.name);
    assert.equal("idempotencyKey" in tool.inputSchema.properties, IDEMPOTENCY_REQUIRED.has(tool.name), tool.name);
  }
});

test("descriptors and demo sources carry no personal paths, live endpoints, or secrets", () => {
  const descriptorText = JSON.stringify(DEMO_TOOLS);
  const sources = ["demo-tools.mjs", "demo-runtime.mjs", "demo-commands.mjs", "demo-search-worker.mjs", "demo-agent-lib.mjs", "demo-agent.mjs"]
    .map((f) => fs.readFileSync(path.join(SRC, f), "utf8"));
  for (const text of [descriptorText, ...sources]) {
    for (const needle of [os.homedir(), "/Users/", "/home/", "workers.dev", "cloudflareaccess.com", "@gmail.com", "PRIVATE KEY-----", "mcp-commander-remote"]) {
      assert.ok(!text.includes(needle), `found ${needle}`);
    }
  }
  // No shell or process spawning anywhere in the demo agent.
  for (const text of sources) {
    assert.ok(!/child_process|execSync|spawn\(|\bexec\(/.test(text), "demo sources must not spawn processes");
    assert.ok(!/\bfetch\(|node:http|node:https|node:net\b|node:dns/.test(text), "demo sources must not do network I/O");
  }
});

// ---------------------------------------------------------------------------------------------
// Configuration

test("demo config has no live defaults and never points into ~/.astra-bridge", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "astra-demo-home-"));
  try {
    fs.mkdirSync(path.join(home, ".astra-bridge"));
    fs.writeFileSync(path.join(home, ".astra-bridge", "agent-private.pem"), "not a key");

    const defaults = resolveDemoPaths({}, { homedir: home });
    assert.equal(defaults.workspace, path.join(home, ".astra-bridge-demo", "workspace"));
    assert.equal(defaults.stateDir, path.join(home, ".astra-bridge-demo", "state"));
    assert.equal(defaults.keyFile, path.join(home, ".astra-bridge-demo", "agent-private.pem"));

    const personalKey = path.join(home, ".astra-bridge", "agent-private.pem");
    assert.throws(() => resolveDemoPaths({ ASTRA_AGENT_KEY_FILE: personalKey }, { homedir: home }), /\.astra-bridge/);
    assert.throws(() => resolveDemoPaths({ ASTRA_DEMO_WORKSPACE: path.join(home, ".astra-bridge", "w") }, { homedir: home }), /\.astra-bridge/);
    assert.throws(() => resolveDemoPaths({ ASTRA_DEMO_STATE_DIR: path.join(home, ".astra-bridge") }, { homedir: home }), /\.astra-bridge/);
    assert.throws(() => resolveDemoPaths({ ASTRA_DEMO_WORKSPACE: home }, { homedir: home }), /home directory/);
    assert.throws(() => resolveDemoPaths({ ASTRA_DEMO_WORKSPACE: "/" }, { homedir: home }), /root/);
    assert.throws(() => resolveDemoPaths({ ASTRA_DEMO_WORKSPACE: "relative/ws" }, { homedir: home }), /absolute/);
    const ws = path.join(home, "ws");
    assert.throws(() => resolveDemoPaths({ ASTRA_DEMO_WORKSPACE: ws, ASTRA_AGENT_KEY_FILE: path.join(ws, "k.pem") }, { homedir: home }), /key file/);
    assert.throws(() => resolveDemoPaths({ ASTRA_DEMO_WORKSPACE: ws, ASTRA_DEMO_STATE_DIR: path.join(ws, "state") }, { homedir: home }), /state/);

    // A symlinked demo directory that really is the personal directory is caught too.
    fs.symlinkSync(path.join(home, ".astra-bridge"), path.join(home, ".astra-bridge-demo"));
    assert.throws(() => resolveDemoPaths({}, { homedir: home }), /\.astra-bridge/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  assert.throws(() => resolveDemoConnection({}), /ASTRA_RELAY_URL is required/);
  assert.throws(() => resolveDemoConnection({ ASTRA_RELAY_URL: "https://review.example" }), /ASTRA_DEVICE_ID is required/);
  assert.throws(() => resolveDemoConnection({ ASTRA_RELAY_URL: "http://review.example", ASTRA_DEVICE_ID: "d" }), /https/);
  assert.throws(() => resolveDemoConnection({
    ASTRA_RELAY_URL: "https://evil.example", ASTRA_RELAY_HOST: "review.example", ASTRA_DEVICE_ID: "d",
  }), /host/);
  assert.throws(() => resolveDemoConnection({ ASTRA_RELAY_URL: "https://review.example", ASTRA_DEVICE_ID: "a/b" }), /invalid/);
  const ok = resolveDemoConnection({ ASTRA_RELAY_URL: "https://review.example", ASTRA_DEVICE_ID: "astra-review-demo" });
  assert.equal(ok.relayBase.hostname, "review.example");
  assert.equal(ok.deviceId, "astra-review-demo");
});

test("demo refuses to serve an existing directory it did not create", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "astra-demo-own-"));
  try {
    const ws = path.join(base, "ws");
    const state = path.join(base, "state");
    assert.equal(checkWorkspaceOwnership(ws, state), "seed");
    fs.mkdirSync(ws);
    assert.equal(checkWorkspaceOwnership(ws, state), "seed");
    fs.writeFileSync(path.join(ws, "personal-notes.txt"), "x");
    assert.throws(() => checkWorkspaceOwnership(ws, state), /did not create/);
    recordWorkspaceOwnership(ws, state);
    assert.equal(checkWorkspaceOwnership(ws, state), "existing");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Sandbox

test("seeded fixture contains only the harmless review files", async (t) => {
  const env = await setup(t);
  assert.deepEqual(Object.keys(SEED_FILES).sort(), ["README.txt", "project/sample.txt"]);
  const listing = textOf(await env.call("list_directory", { path: "/demo-workspace" }));
  assert.equal(listing, "[DIR] project\n[FILE] project/sample.txt\n[FILE] README.txt");
  const readme = textOf(await env.call("read_file", { path: "/demo-workspace/README.txt" }));
  assert.match(readme, /Astra Bridge review workspace/);
});

test("path traversal outside the sandbox is refused for every file tool", async (t) => {
  const env = await setup(t);
  const escapes = [
    "/demo-workspace/../outside/secret.txt",
    "../outside/secret.txt",
    "/demo-workspace/project/../../outside/secret.txt",
    path.join(env.outside, "secret.txt"),
    "/etc/passwd",
    "~/secret.txt",
    "file:///etc/passwd",
    "/demo-workspaceX/secret.txt",
  ];
  for (const p of escapes) {
    for (const [name, args] of [
      ["read_file", { path: p }],
      ["get_file_info", { path: p }],
      ["list_directory", { path: p }],
      ["start_search", { path: p, pattern: "secret" }],
      ["write_file", { path: p, content: "x", mode: "rewrite", idempotencyKey: key() }],
      ["create_directory", { path: `${p}-dir`, idempotencyKey: key() }],
      ["edit_block", { file_path: p, old_string: "TOP", new_string: "X", idempotencyKey: key() }],
      ["move_file", { source: p, destination: "/demo-workspace/stolen.txt", idempotencyKey: key() }],
      ["move_file", { source: "/demo-workspace/README.txt", destination: p, idempotencyKey: key() }],
    ]) {
      const r = await env.call(name, args);
      assert.equal(r.isError, true, `${name} ${p}`);
    }
  }
  const multi = textOf(await env.call("read_multiple_files", { paths: escapes }));
  assert.equal((multi.match(/Error - /g) ?? []).length, escapes.length);
  assert.equal(fs.readFileSync(path.join(env.outside, "secret.txt"), "utf8"), `${SECRET}\n`);
  assert.deepEqual(fs.readdirSync(env.outside), ["secret.txt"]);
  assert.ok(fs.existsSync(path.join(env.root, "README.txt")));
  assert.ok(!fs.existsSync(path.join(env.root, "stolen.txt")));
  assertNoHostPaths(env, env.seen);
});

test("symlinks cannot escape the sandbox", async (t) => {
  const env = await setup(t);
  fs.symlinkSync(env.outside, path.join(env.root, "escape-dir"));
  fs.symlinkSync(path.join(env.outside, "secret.txt"), path.join(env.root, "escape-file"));
  fs.symlinkSync(path.join(env.outside, "created-by-link.txt"), path.join(env.root, "dangling"));
  fs.symlinkSync(path.join(env.root, "project"), path.join(env.root, "inside-link"));

  const denied = [
    ["read_file", { path: "/demo-workspace/escape-file" }],
    ["read_file", { path: "/demo-workspace/escape-dir/secret.txt" }],
    ["list_directory", { path: "/demo-workspace/escape-dir" }],
    ["start_search", { path: "/demo-workspace/escape-dir", pattern: "secret" }],
    ["write_file", { path: "/demo-workspace/escape-dir/new.txt", content: "x", idempotencyKey: key() }],
    ["write_file", { path: "/demo-workspace/escape-file", content: "x", mode: "append", idempotencyKey: key() }],
    ["write_file", { path: "/demo-workspace/dangling", content: "x", idempotencyKey: key() }],
    ["create_directory", { path: "/demo-workspace/escape-dir/sub", idempotencyKey: key() }],
    ["edit_block", { file_path: "/demo-workspace/escape-file", old_string: "TOP", new_string: "X", idempotencyKey: key() }],
    ["move_file", { source: "/demo-workspace/escape-dir/secret.txt", destination: "/demo-workspace/s.txt", idempotencyKey: key() }],
    ["move_file", { source: "/demo-workspace/README.txt", destination: "/demo-workspace/escape-dir/README.txt", idempotencyKey: key() }],
    ["start_process", { command: "pwd", cwd: "/demo-workspace/escape-dir", idempotencyKey: key() }],
  ];
  for (const [name, args] of denied) {
    const r = await env.call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  const multi = textOf(await env.call("read_multiple_files", { paths: ["/demo-workspace/escape-file"] }));
  assert.match(multi, /Error - Access denied/);

  // Searching the whole sandbox neither follows the links nor finds the secret.
  const search = textOf(await env.call("start_search", { path: "/demo-workspace", pattern: "TOP-SECRET", searchType: "content" }));
  assert.match(search, /No matches found/);

  // The link itself may be described, without revealing where it points.
  const info = textOf(await env.call("get_file_info", { path: "/demo-workspace/escape-file" }));
  assert.match(info, /isSymbolicLink: true/);
  assert.match(info, /symlinkTarget: \(outside the demo workspace/);

  // A link that stays inside works.
  const inside = textOf(await env.call("read_file", { path: "/demo-workspace/inside-link/sample.txt" }));
  assert.match(inside, /Sample project notes/);

  assert.deepEqual(fs.readdirSync(env.outside), ["secret.txt"]);
  assert.equal(fs.readFileSync(path.join(env.outside, "secret.txt"), "utf8"), `${SECRET}\n`);
  assertNoHostPaths(env, env.seen);
});

test("read_file URL mode is refused by demo policy without any network request", async (t) => {
  const env = await setup(t);
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error("network used"); };
  try {
    for (const args of [
      { path: "https://example.com/" },
      { path: "HTTP://example.com/x" },
      { path: "/demo-workspace/README.txt", isUrl: true },
      { path: "https://example.com/", isUrl: "true" },
    ]) {
      const r = await env.call("read_file", args);
      assert.equal(r.isError, true);
      assert.match(textOf(r), /Demo policy: URL fetching is disabled/);
    }
    const multi = textOf(await env.call("read_multiple_files", { paths: ["https://example.com/"] }));
    assert.match(multi, /Error - URLs are not supported/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0);
});

// ---------------------------------------------------------------------------------------------
// Commands

test("the command grammar refuses shells, chaining, substitution, network and filesystem commands", () => {
  const refused = [
    "", "   ", "ls", "ls -la", "cat README.txt", "rm -rf /", "mv a b", "cp a b", "touch x", "mkdir x", "chmod 777 x",
    "curl https://example.com", "wget http://x", "nc -l 1234", "ssh host", "ping example.com",
    "sh", "bash -c pwd", "zsh -i", "/bin/sh", "/bin/echo hi", "env", "sudo pwd", "PATH=/x pwd",
    "node", "node -e 1", "node script.js", "node --version --eval 1", "python3 -c 1", "osascript -e x",
    "echo hi | sh", "echo hi > f", "echo hi >> f", "cat < f", "echo $(id)", "echo `id`", "echo $HOME", "echo ${HOME}",
    "pwd; ls", "pwd && ls", "pwd || ls", "sleep 1 &", "echo 'quoted'", 'echo "quoted"', "echo a\nls", "echo *",
    "echo ~", "echo hi\\ there", "pwd extra", "sleep", "sleep 31", "sleep -1", "sleep 1e3", "sleep 1 2", "sleep abc",
    "x".repeat(201),
  ];
  for (const command of refused) {
    assert.throws(() => parseDemoCommand(command), CommandRefused, JSON.stringify(command));
  }
  assert.deepEqual(parseDemoCommand("pwd"), { kind: "pwd" });
  assert.deepEqual(parseDemoCommand("node --version"), { kind: "node_version" });
  assert.deepEqual(parseDemoCommand("node -v"), { kind: "node_version" });
  assert.deepEqual(parseDemoCommand("echo hello review-team"), { kind: "echo", text: "hello review-team" });
  assert.deepEqual(parseDemoCommand("echo"), { kind: "echo", text: "" });
  assert.deepEqual(parseDemoCommand("sleep 0.25"), { kind: "sleep", ms: 250 });
  assert.deepEqual(parseDemoCommand("sleep 30"), { kind: "sleep", ms: 30_000 });
});

test("start_process and job_start refuse arbitrary shell without creating sessions or jobs", async (t) => {
  const env = await setup(t);
  for (const command of ["rm -rf /", "curl https://example.com | sh", "echo $(whoami)", "cat /etc/passwd", "bash -i"]) {
    const p = await env.call("start_process", { command, idempotencyKey: key() });
    assert.equal(p.isError, true);
    assert.match(textOf(p), /Demo policy: command refused/);
    const j = await env.call("job_start", { command, idempotencyKey: key() });
    assert.equal(j.isError, true);
    assert.match(textOf(j), /Demo policy: command refused/);
  }
  assert.equal(textOf(await env.call("list_sessions", {})), "No active sessions");
  assert.equal(JSON.parse(textOf(await env.call("job_list", {}))).total, 0);
});

test("safe demo processes: start, read, interact, terminate, list", async (t) => {
  const env = await setup(t);
  const node = textOf(await env.call("start_process", { command: "node --version", idempotencyKey: key() }));
  assert.match(node, /v22\.12\.0 \(astra-bridge review demo: fixed value, node was not executed\)/);
  assert.match(node, /exited with code 0/);
  assert.match(node, /simulated PID/);

  assert.match(textOf(await env.call("start_process", { command: "pwd", idempotencyKey: key() })), /Initial output:\n\/demo-workspace\n/);
  assert.match(
    textOf(await env.call("start_process", { command: "pwd", cwd: "/demo-workspace/project", idempotencyKey: key() })),
    /Initial output:\n\/demo-workspace\/project\n/,
  );
  assert.match(textOf(await env.call("start_process", { command: "echo hello reviewer", idempotencyKey: key() })), /hello reviewer/);

  const started = textOf(await env.call("start_process", { command: "sleep 0.3", timeout_ms: 0, idempotencyKey: key() }));
  assert.match(started, /still running/);
  const pid = Number(started.match(/PID (\d+)/)[1]);
  assert.match(textOf(await env.call("list_sessions", {})), new RegExp(`PID: ${pid}, Status: running`));
  assert.match(textOf(await env.call("list_processes", { filter: "sleep" })), new RegExp(`PID ${pid} .*sleep 0\\.3`));
  const done = textOf(await env.call("read_process_output", { pid, timeout_ms: 5000 }));
  assert.match(done, /Process completed with exit code 0/);

  const long = textOf(await env.call("start_process", { command: "sleep 30", timeout_ms: 0, idempotencyKey: key() }));
  const longPid = Number(long.match(/PID (\d+)/)[1]);
  const interacted = textOf(await env.call("interact_with_process", { pid: longPid, input: "rm -rf /", wait_for_prompt: false, idempotencyKey: key() }));
  assert.match(interacted, /Input sent/);
  const waited = textOf(await env.call("interact_with_process", { pid: longPid, input: "hello", timeout_ms: 50, idempotencyKey: key() }));
  assert.match(waited, /input was not executed/);
  assert.match(textOf(await env.call("force_terminate", { pid: longPid, idempotencyKey: key() })), /Successfully terminated/);
  assert.match(textOf(await env.call("read_process_output", { pid: longPid })), /terminated by signal SIGINT/);
  assert.equal((await env.call("force_terminate", { pid: longPid, idempotencyKey: key() })).isError, true);

  const killable = textOf(await env.call("start_process", { command: "sleep 30", timeout_ms: 0, idempotencyKey: key() }));
  const killPid = Number(killable.match(/PID (\d+)/)[1]);
  assert.match(textOf(await env.call("kill_process", { pid: killPid, signal: "SIGKILL", idempotencyKey: key() })), /Successfully terminated/);
  assert.equal((await env.call("kill_process", { pid: 1, idempotencyKey: key() })).isError, true);
  assert.equal((await env.call("kill_process", { pid: process.pid, idempotencyKey: key() })).isError, true);
  assert.match(textOf(await env.call("list_processes", {})), /no simulated processes are running/);
  assertNoHostPaths(env, env.seen);
});

// ---------------------------------------------------------------------------------------------
// Files, search, edit

test("positive file flow: write, read back, append, info, directory, move, multi-read", async (t) => {
  const env = await setup(t);
  const note = "/demo-workspace/review-note.txt";
  assert.match(textOf(await env.call("write_file", { path: note, content: "Reviewed by the review team.\n", idempotencyKey: key() })), /Successfully wrote to \/demo-workspace\/review-note\.txt \(1 line\)/);
  assert.match(textOf(await env.call("read_file", { path: note })), /\[Reading 1 lines from start \(total: 1 lines, 0 remaining\)\]\n\nReviewed by the review team\./);

  const noMode = await env.call("write_file", { path: note, content: "overwrite", idempotencyKey: key() });
  assert.equal(noMode.isError, true);
  assert.match(textOf(noMode), /Write rejected to prevent accidental data loss/);

  await env.call("write_file", { path: note, content: "Second line.\n", mode: "append", idempotencyKey: key() });
  assert.equal(fs.readFileSync(path.join(env.root, "review-note.txt"), "utf8"), "Reviewed by the review team.\nSecond line.\n");
  assert.match(textOf(await env.call("get_file_info", { path: note })), /lineCount: 2/);
  assert.match(textOf(await env.call("read_file", { path: note, offset: -1 })), /Second line\./);

  assert.match(textOf(await env.call("create_directory", { path: "/demo-workspace/notes/2026", idempotencyKey: key() })), /Successfully created directory/);
  assert.match(textOf(await env.call("create_directory", { path: "notes/2026", idempotencyKey: key() })), /already exists/);
  assert.match(textOf(await env.call("move_file", { source: note, destination: "/demo-workspace/notes/2026/note.txt", idempotencyKey: key() })), /Successfully moved/);
  assert.match(textOf(await env.call("list_directory", { path: "/demo-workspace/notes", depth: 3 })), /\[FILE\] 2026\/note\.txt/);
  const overwrite = await env.call("move_file", { source: "/demo-workspace/README.txt", destination: "/demo-workspace/project/sample.txt", idempotencyKey: key() });
  assert.match(textOf(overwrite), /Destination already exists/);

  const multi = await env.call("read_multiple_files", { paths: ["/demo-workspace/README.txt", "/demo-workspace/notes/2026/note.txt", "/demo-workspace/missing.txt"] });
  assert.match(multi.content[0].text, /README\.txt: text\/plain \(text\)\n.*note\.txt: text\/plain \(text\)\n.*missing\.txt: Error - No such file/);
  assert.equal(multi.content.length, 3);
  assert.match(textOf(await env.call("get_config", {})), /"roots": \[\n\s+"\/demo-workspace"\n\s+\]/);
  assertNoHostPaths(env, env.seen);
});

test("search: content and file-name search, paging, listing, stopping", async (t) => {
  const env = await setup(t);
  const content = textOf(await env.call("start_search", { path: "/demo-workspace", pattern: "oauth", searchType: "content" }));
  assert.match(content, /Status: COMPLETED/);
  assert.match(content, /📄 \/demo-workspace\/project\/sample\.txt:3 - The relay authenticates ChatGPT with OAuth 2\.1 and PKCE\./);
  assert.match(content, /📄 \/demo-workspace\/README\.txt:9 - - search this folder for OAuth/);
  const sessionId = content.match(/session: (search_\S+)/)[1];

  const page = textOf(await env.call("get_more_search_results", { sessionId, offset: 1, length: 1 }));
  assert.match(page, /Showing results 1-1/);
  assert.match(textOf(await env.call("list_searches", {})), new RegExp(`Session: ${sessionId}`));
  assert.match(textOf(await env.call("stop_search", { sessionId })), /had already completed/);

  const files = textOf(await env.call("start_search", { path: "/demo-workspace", pattern: "*.txt" }));
  assert.match(files, /📁 \/demo-workspace\/README\.txt/);
  assert.match(files, /📁 \/demo-workspace\/project\/sample\.txt/);
  const literal = textOf(await env.call("start_search", { path: "/demo-workspace", pattern: "2.1 and", searchType: "content", literalSearch: true, contextLines: 1 }));
  assert.match(literal, /1 matches \+ 2 context lines/);
  assert.equal((await env.call("get_more_search_results", { sessionId: "search_999_1" })).isError, true);
  assert.equal((await env.call("start_search", { path: "/demo-workspace", pattern: "(", searchType: "content" })).isError, true);
});

test("search: a catastrophic regex is stopped by the deadline instead of stalling the agent", async (t) => {
  const env = await setup(t);
  fs.writeFileSync(path.join(env.root, "redos.txt"), `${"a".repeat(40)}!\n`);
  const started = Date.now();
  const r = textOf(await env.call("start_search", { path: "/demo-workspace", pattern: "(a+)+$", searchType: "content", timeout_ms: 200 }));
  assert.ok(Date.now() - started < 1400, "start_search returned promptly");
  assert.match(r, /timed out/);
});

test("edit_block replaces exact text and refuses ambiguous or missing matches", async (t) => {
  const env = await setup(t);
  const file = "/demo-workspace/project/sample.txt";
  const edited = textOf(await env.call("edit_block", {
    file_path: file,
    old_string: "TODO: replace this line during the edit_block review test.",
    new_string: "DONE: edited by the review demo.",
    idempotencyKey: key(),
  }));
  assert.match(edited, /Successfully applied 1 edit to \/demo-workspace\/project\/sample\.txt/);
  assert.match(fs.readFileSync(path.join(env.root, "project", "sample.txt"), "utf8"), /DONE: edited by the review demo\./);

  await env.call("write_file", { path: "/demo-workspace/dup.txt", content: "x\ny\nx\n", idempotencyKey: key() });
  const ambiguous = await env.call("edit_block", { file_path: "/demo-workspace/dup.txt", old_string: "x", new_string: "z", idempotencyKey: key() });
  assert.equal(ambiguous.isError, true);
  assert.match(textOf(ambiguous), /found 2 \(lines 1, 3\)/);
  assert.match(textOf(await env.call("edit_block", { file_path: "/demo-workspace/dup.txt", old_string: "x", new_string: "z", expected_replacements: 2, idempotencyKey: key() })), /Successfully applied 2 edits/);
  assert.equal(fs.readFileSync(path.join(env.root, "dup.txt"), "utf8"), "z\ny\nz\n");
  assert.equal((await env.call("edit_block", { file_path: "/demo-workspace/dup.txt", old_string: "nope", new_string: "z", idempotencyKey: key() })).isError, true);
  assert.equal((await env.call("edit_block", { file_path: "/demo-workspace/dup.txt", old_string: "", new_string: "z", idempotencyKey: key() })).isError, true);
});

// ---------------------------------------------------------------------------------------------
// Jobs

test("durable job lifecycle: start, status, list, logs, cancel, queue, restart", async (t) => {
  const env = await setup(t);
  const echo = JSON.parse(textOf(await env.call("job_start", { command: "echo job finished", label: "echo job", idempotencyKey: key() })));
  assert.equal(echo.deduplicated, false);
  assert.equal(echo.simulated, true);
  await waitFor(async () => JSON.parse(textOf(await env.call("job_status", { jobId: echo.jobId }))).state === "succeeded");
  const logs = await env.call("job_logs", { jobId: echo.jobId });
  assert.equal(JSON.parse(logs.content[0].text).endOfLog, true);
  assert.equal(logs.content[1].text, "job finished\n");

  const slow = JSON.parse(textOf(await env.call("job_start", { command: "sleep 0.3", idempotencyKey: key() })));
  assert.equal(slow.state, "running");
  const status = JSON.parse(textOf(await env.call("job_status", { jobId: slow.jobId })));
  assert.equal(status.state, "running");
  assert.ok(status.startedAt);
  const finished = await waitFor(async () => {
    const s = JSON.parse(textOf(await env.call("job_status", { jobId: slow.jobId })));
    return s.state === "succeeded" && s;
  });
  assert.equal(finished.exitCode, 0);
  assert.ok(finished.elapsedMs >= 250);

  // At most two run at once; the third waits queued and can be cancelled before it starts.
  const a = JSON.parse(textOf(await env.call("job_start", { command: "sleep 30", idempotencyKey: key() })));
  const b = JSON.parse(textOf(await env.call("job_start", { command: "sleep 30", idempotencyKey: key() })));
  const c = JSON.parse(textOf(await env.call("job_start", { command: "sleep 30", idempotencyKey: key() })));
  assert.deepEqual([a.state, b.state, c.state], ["running", "running", "queued"]);
  assert.equal(JSON.parse(textOf(await env.call("job_cancel", { jobId: c.jobId }))).action, "cancelled_before_start");
  const cancelled = JSON.parse(textOf(await env.call("job_cancel", { jobId: a.jobId })));
  assert.equal(cancelled.action, "cancelled");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(JSON.parse(textOf(await env.call("job_cancel", { jobId: a.jobId }))).action, "already_finished");

  const timed = JSON.parse(textOf(await env.call("job_start", { command: "sleep 5", timeoutSeconds: 1, idempotencyKey: key() })));
  assert.equal(timed.state, "running");

  const list = JSON.parse(textOf(await env.call("job_list", {})));
  assert.equal(list.total, 6);
  assert.equal(JSON.parse(textOf(await env.call("job_list", { state: "cancelled" }))).total, 2);
  assert.equal((await env.call("job_status", { jobId: "j0-0000000000000000" })).isError, true);
  assert.equal((await env.call("job_status", { jobId: "../../etc" })).isError, true);

  // Durable: after a restart, unfinished jobs are reported interrupted and never re-run.
  await env.restart();
  const after = JSON.parse(textOf(await env.call("job_status", { jobId: b.jobId })));
  assert.equal(after.state, "interrupted");
  assert.match(after.reason, /not re-run/);
  assert.equal(JSON.parse(textOf(await env.call("job_status", { jobId: echo.jobId }))).state, "succeeded");
  assert.equal(JSON.parse(textOf(await env.call("job_list", {}))).total, 6);
  assertNoHostPaths(env, env.seen);
});

// ---------------------------------------------------------------------------------------------
// Idempotency

test("every gated tool requires an 8-200 character idempotencyKey before acting", async (t) => {
  const env = await setup(t);
  for (const name of DEMO_IDEMPOTENT_TOOLS) {
    for (const bad of [undefined, "", "short7!", "x".repeat(201), 12345678, "bad\nkey-123"]) {
      const r = await env.call(name, { path: "/demo-workspace/x", content: "x", command: "pwd", pid: 41000, idempotencyKey: bad });
      assert.equal(r.isError, true, `${name} ${bad}`);
      assert.match(textOf(r), /idempotency_key_required/);
    }
  }
  assert.ok(!fs.existsSync(path.join(env.root, "x")));
  assert.equal(textOf(await env.call("list_sessions", {})), "No active sessions");
  const min = await env.call("create_directory", { path: "/demo-workspace/min", idempotencyKey: "12345678" });
  const max = await env.call("create_directory", { path: "/demo-workspace/max", idempotencyKey: "k".repeat(200) });
  assert.ok(!min.isError && !max.isError);
});

test("same key and payload replays without acting again; same key with a different payload is refused", async (t) => {
  const env = await setup(t);
  const k = key("append");
  const args = { path: "/demo-workspace/log.txt", content: "one entry\n", mode: "append", idempotencyKey: k };
  const first = await env.call("write_file", args);
  const second = await env.call("write_file", { ...args });
  assert.ok(!first.isError);
  assert.equal(second.content[0].text, first.content[0].text);
  assert.match(textOf(second), /idempotent replay/);
  assert.equal(fs.readFileSync(path.join(env.root, "log.txt"), "utf8"), "one entry\n");

  const different = await env.call("write_file", { ...args, content: "other entry\n" });
  assert.equal(different.isError, true);
  assert.match(textOf(different), /already used for a different call \(same tool, different arguments\)/);
  const otherTool = await env.call("create_directory", { path: "/demo-workspace/d", idempotencyKey: k });
  assert.match(textOf(otherTool), /already used for a different call \(tool write_file\)/);
  assert.equal(fs.readFileSync(path.join(env.root, "log.txt"), "utf8"), "one entry\n");
  assert.ok(!fs.existsSync(path.join(env.root, "d")));

  // Coerced forms of the same request count as the same request.
  const pk = key("proc");
  const p1 = textOf(await env.call("start_process", { command: "echo once", timeout_ms: 1000, idempotencyKey: pk }));
  const p2 = textOf(await env.call("start_process", { command: "echo once", timeout_ms: "1000", idempotencyKey: pk }));
  assert.equal(p1.match(/PID (\d+)/)[1], p2.match(/PID (\d+)/)[1]);

  // job_start: the same key returns the same job; a different request is refused.
  const jk = key("job");
  const j1 = JSON.parse(textOf(await env.call("job_start", { command: "sleep 0.1", idempotencyKey: jk })));
  const j2 = JSON.parse(textOf(await env.call("job_start", { command: "sleep 0.1", idempotencyKey: jk })));
  assert.equal(j2.jobId, j1.jobId);
  assert.equal(j2.deduplicated, true);
  const j3 = await env.call("job_start", { command: "sleep 0.2", idempotencyKey: jk });
  assert.equal(j3.isError, true);
  assert.equal(JSON.parse(textOf(await env.call("job_list", {}))).total, 1);

  // Replays survive a restart of the demo agent.
  await env.restart();
  const replay = await env.call("write_file", { ...args });
  assert.match(textOf(replay), /idempotent replay/);
  assert.equal(fs.readFileSync(path.join(env.root, "log.txt"), "utf8"), "one entry\n");
});

// ---------------------------------------------------------------------------------------------
// Bounds and leakage

test("output, writes and the workspace are bounded", async (t) => {
  const env = await setup(t);
  const line = `${"0123456789".repeat(4)}\n`;
  const chunk = line.repeat(1200); // 49,200 characters per call
  await env.call("write_file", { path: "/demo-workspace/big.txt", content: chunk, idempotencyKey: key() });
  for (let i = 0; i < 4; i += 1) {
    const r = await env.call("write_file", { path: "/demo-workspace/big.txt", content: chunk, mode: "append", idempotencyKey: key() });
    assert.ok(!r.isError, textOf(r));
  }
  const big = await env.call("read_file", { path: "/demo-workspace/big.txt", length: 5000 });
  assert.ok(big.content[0].text.length <= LIMITS.resultChars + 100);
  assert.match(big.content[0].text, /demo output truncated/);

  const tooLarge = await env.call("write_file", { path: "/demo-workspace/huge.txt", content: "x".repeat(LIMITS.writeChars + 1), idempotencyKey: key() });
  assert.match(textOf(tooLarge), /Content too large/);
  // 5 x 49,200 bytes are stored; one more chunk would cross the 256 KiB per-file limit.
  const overFile = await env.call("write_file", { path: "/demo-workspace/big.txt", content: chunk, mode: "append", idempotencyKey: key() });
  assert.match(textOf(overFile), /file size limit/);

  // Fill the sandbox on disk up to three entries below the cap, then grow it through the tools.
  fs.mkdirSync(path.join(env.root, "many"));
  const present = () => fs.readdirSync(env.root, { recursive: true }).length;
  for (let i = present(); i < LIMITS.workspaceEntries - 3; i += 1) fs.mkdirSync(path.join(env.root, "many", `d${i}`));
  const created = [];
  for (let i = 0; i < 5; i += 1) {
    created.push(await env.call("create_directory", { path: `/demo-workspace/more/e${i}`, idempotencyKey: key() }));
  }
  assert.deepEqual(created.map((r) => !!r.isError), [false, false, true, true, true]);
  assert.match(textOf(created[2]), /Demo workspace limit reached/);
  assert.equal(present(), LIMITS.workspaceEntries);
  const refusedWrite = await env.call("write_file", { path: "/demo-workspace/more/new.txt", content: "x", idempotencyKey: key() });
  assert.match(textOf(refusedWrite), /Demo workspace limit reached/);

  const gate = new ConcurrencyGate(1);
  const frame = await handleRpcMessage(
    JSON.stringify({ type: "rpc", id: "r1", payload: { action: "tools/call", name: "read_file", arguments: { path: "/demo-workspace/big.txt" } } }),
    createDemoExecutor(env.rt),
    gate,
    10_000,
  );
  assert.deepEqual(frame, { type: "rpc_result", id: "r1", error: "result_too_large" });
  assert.equal(gate.tryAcquire(), true, "the slot is released after an oversized result");
});

test("results never reveal host paths, including history, config and errors", async (t) => {
  const env = await setup(t);
  await env.call("get_config", {});
  await env.call("read_file", { path: "/demo-workspace/README.txt" });
  await env.call("read_file", { path: "/demo-workspace/nope.txt" });
  await env.call("get_file_info", { path: "/demo-workspace" });
  await env.call("list_directory", { path: "/demo-workspace", depth: 5 });
  await env.call("write_file", { path: "/demo-workspace/a/b.txt", content: "hi", idempotencyKey: key() });
  await env.call("start_process", { command: "pwd", idempotencyKey: key() });
  await env.call("job_start", { command: "pwd", idempotencyKey: key() });
  await env.call("start_search", { path: "/demo-workspace", pattern: "sample" });
  await env.call("get_usage_stats", {});
  const history = textOf(await env.call("get_recent_tool_calls", { maxResults: 100 }));
  assert.match(history, /"toolName": "get_config"/);
  assertNoHostPaths(env, env.seen);

  const unknown = await env.rt.callTool("set_config_value", { key: "allowedDirectories", value: [] }).catch((err) => err);
  assert.equal(unknown.message, "tool_not_found");
});

// ---------------------------------------------------------------------------------------------
// Protocol compatibility with the production relay

test("demo agent signatures use the relay's canonical form", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const target = "/v1/device/astra-review-demo/connect";
  const h = signedHeaders(privateKey, "get", target, Buffer.alloc(0), { now: 1_790_000_000_000, nonce: "ab".repeat(16) });
  assert.match(h["X-Astra-Timestamp"], /^\d{13}$/);
  assert.match(h["X-Astra-Nonce"], /^[a-f0-9]{32}$/);
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const canonical = ["1790000000000", "ab".repeat(16), "GET", target, emptyHash].join("\n");
  assert.ok(verify(null, Buffer.from(canonical), publicKey, Buffer.from(h["X-Astra-Signature"], "base64")));

  // The relay's own verifier accepts them (signed status route of a review Worker env).
  const device = "astra-review-demo";
  const publicB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const { env } = relayEnv(new Map(), device, publicB64);
  const statusPath = `/v1/device/${device}/status`;
  const ok = await worker.fetch(new Request(`https://review.example${statusPath}`, { headers: signedHeaders(privateKey, "GET", statusPath) }), env);
  assert.equal(ok.status, 200);
  const { privateKey: otherKey } = generateKeyPairSync("ed25519");
  const bad = await worker.fetch(new Request(`https://review.example${statusPath}`, { headers: signedHeaders(otherKey, "GET", statusPath) }), env);
  assert.equal(bad.status, 401);
});

test("the production relay serves the demo agent end to end over rpc/rpc_result frames", async (t) => {
  const env = await setup(t);
  const device = "astra-review-demo";
  const relays = new Map([[device, newRelay()]]);
  const { relay } = relays.get(device);
  const ws = new FakeSocket();
  await relay.attachAgentSocket(ws);
  await relay.webSocketMessage(ws, JSON.stringify({ type: "heartbeat", mcpHealthy: true }));
  const execute = createDemoExecutor(env.rt);
  const gate = new ConcurrencyGate(4);
  ws.onRpc = (msg) => setImmediate(async () => {
    const frame = await handleRpcMessage(JSON.stringify(msg), execute, gate, 1024 * 1024);
    await relay.webSocketMessage(ws, JSON.stringify(frame));
  });
  const { env: workerEnv } = relayEnv(relays, device);

  const mcp = async (method, params) => {
    const res = await worker.fetch(new Request("https://review.example/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${MCP_TOKEN}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), workerEnv);
    assert.equal(res.status, 200);
    return (await res.json()).result;
  };

  const listed = await mcp("tools/list", {});
  assert.deepEqual(listed.tools.map((x) => x.name).sort(), Object.keys(TOOL_SAFETY).sort());
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.required.includes("idempotencyKey"), IDEMPOTENCY_REQUIRED.has(tool.name), tool.name);
  }

  const noKey = await mcp("tools/call", { name: "write_file", arguments: { path: "/demo-workspace/r.txt", content: "x" } });
  assert.equal(noKey.isError, true);
  const wrote = await mcp("tools/call", { name: "write_file", arguments: { path: "/demo-workspace/r.txt", content: "via relay", idempotencyKey: key() } });
  assert.match(wrote.content[0].text, /Successfully wrote/);
  const read = await mcp("tools/call", { name: "read_file", arguments: { path: "/demo-workspace/r.txt" } });
  assert.match(read.content[0].text, /via relay/);
  const url = await mcp("tools/call", { name: "read_file", arguments: { path: "https://example.com" } });
  assert.equal(url.isError, true);
  assert.match(url.content[0].text, /Demo policy/);
  const blocked = await mcp("tools/call", { name: "set_config_value", arguments: { key: "x", value: "y" } });
  assert.equal(blocked.isError, true);

  // Non-rpc frames are ignored; unknown actions become fixed error codes.
  assert.equal(await handleRpcMessage("not json", execute, gate, 1024), null);
  assert.equal(await handleRpcMessage(JSON.stringify({ type: "heartbeat_ack" }), execute, gate, 1024), null);
  assert.deepEqual(await handleRpcMessage(JSON.stringify({ type: "rpc", id: "x", payload: { action: "shell" } }), execute, gate, 1024),
    { type: "rpc_result", id: "x", error: "unsupported_action" });
  assert.deepEqual(await handleRpcMessage(JSON.stringify({ type: "rpc", id: "y", payload: { action: "tools/call", name: "nope" } }), execute, gate, 1024),
    { type: "rpc_result", id: "y", error: "tool_not_found" });
  assertNoHostPaths(env, env.seen);
});

// ---------------------------------------------------------------------------------------------
// Minimal Durable Object fakes (same shape as test/relay.test.mjs)

const MCP_TOKEN = "review-demo-test-token-which-is-long-enough-for-the-bearer-check";

class FakeStorage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(k) { return structuredClone(this.map.get(k)); }
  async put(k, v) {
    if (typeof k === "string") this.map.set(k, structuredClone(v));
    else for (const [a, b] of Object.entries(k)) this.map.set(a, structuredClone(b));
  }
  async delete(keys) {
    if (!Array.isArray(keys)) return this.map.delete(keys);
    let n = 0;
    for (const k of keys) if (this.map.delete(k)) n += 1;
    return n;
  }
  async list({ prefix = "" } = {}) { return new Map([...this.map].filter(([k]) => k.startsWith(prefix)).sort()); }
  async getAlarm() { return this.alarm; }
  async setAlarm(at) { this.alarm = at; }
}

class FakeSocket {
  constructor() { this.sent = []; this.onRpc = null; this.gone = false; }
  send(data) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (msg.type === "rpc") this.onRpc?.(msg);
  }
  close() {}
  serializeAttachment(v) { this.attachment = structuredClone(v); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}

class FakeCtx {
  constructor() { this.storage = new FakeStorage(); this.sockets = []; }
  acceptWebSocket(ws, tags) { ws.tags = tags; this.sockets.push(ws); }
  getWebSockets(tag) { return this.sockets.filter((ws) => !ws.gone && ws.tags.includes(tag)); }
  setWebSocketAutoResponse(pair) { this.autoResponse = pair ?? null; }
  getWebSocketAutoResponseTimestamp(ws) { return ws.autoResponseAt ?? null; }
}

function newRelay() {
  const ctx = new FakeCtx();
  return { relay: new DeviceRelay(ctx, {}), ctx };
}

function relayEnv(relays, device, publicB64 = "") {
  const relayFor = (name) => {
    const invoke = () => {
      if (!relays.has(name)) relays.set(name, newRelay());
      return relays.get(name).relay;
    };
    return { fetch: (request) => invoke().fetch(request), mcpRpc: (payload) => invoke().mcpRpc(payload) };
  };
  return {
    env: {
      DEVICE_RELAY: { getByName: relayFor, idFromName: (name) => ({ name }), get: (id) => relayFor(id.name) },
      AGENT_PUBLIC_KEY_B64: publicB64,
      CLIENT_PUBLIC_KEY_B64: publicB64,
      AGENT_DEVICE_ID: device,
      CLIENT_DEVICE_ID: device,
      MCP_DEVICE_ID: device,
      MCP_BEARER_TOKEN: MCP_TOKEN,
    },
  };
}
