import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import worker, {
  AGENT_PING,
  AGENT_PONG,
  AGENT_STALE_MS,
  ALERT_MIN_CONSECUTIVE_UNHEALTHY,
  ALERT_REPEAT_MS,
  DeviceRelay,
  MAX_AUTH_REQUESTS_PER_WINDOW,
  MAX_BODY_BYTES,
  MAX_PENDING,
  NONCE_TTL_MS,
} from "../.test-tmp/index.mjs";

const TOKEN = "relay-test-token-which-is-long-enough-for-the-bearer-check";
const DEVICE = "test-device";
const GATED = new Set([
  "create_directory", "write_file", "edit_block", "move_file", "start_process",
  "interact_with_process", "force_terminate", "kill_process", "job_start",
]);
const REVIEWED = [
  "get_config", "read_file", "read_multiple_files", "write_file", "create_directory",
  "list_directory", "move_file", "get_file_info", "start_search", "get_more_search_results",
  "stop_search", "list_searches", "edit_block", "start_process", "read_process_output",
  "interact_with_process", "force_terminate", "list_sessions", "list_processes", "kill_process",
  "get_recent_tool_calls", "get_usage_stats", "job_start", "job_status", "job_list",
  "job_logs", "job_cancel",
];
// Downstream advertises two extra tools the relay has not reviewed.
const DOWNSTREAM_TOOLS = [...REVIEWED, "set_config_value", "future_unreviewed_tool"].map((name) => ({
  name,
  description: `tool ${name}`,
  inputSchema: {
    type: "object",
    properties: GATED.has(name) ? { idempotencyKey: { type: "string" } } : {},
  },
}));

// ---------------------------------------------------------------------------
// Fake Durable Object runtime

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async get(key) {
    return structuredClone(this.map.get(key));
  }
  async put(keyOrEntries, value) {
    if (typeof keyOrEntries === "string") this.map.set(keyOrEntries, structuredClone(value));
    else for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, structuredClone(v));
  }
  async delete(keys) {
    if (!Array.isArray(keys)) return this.map.delete(keys);
    assert.ok(keys.length <= 128, "storage.delete accepts at most 128 keys");
    let n = 0;
    for (const key of keys) if (this.map.delete(key)) n += 1;
    return n;
  }
  async list({ prefix = "" } = {}) {
    return new Map([...this.map].filter(([k]) => k.startsWith(prefix)).sort());
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at) {
    this.alarm = at;
  }
}

class FakeSocket {
  constructor() {
    this.sent = [];
    this.closed = null;
    this.gone = false;
    this.throwOnSend = false;
    this.onRpc = null;
  }
  send(data) {
    if (this.throwOnSend) throw new Error("WebSocket is closed");
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (msg.type === "rpc") this.onRpc?.(msg);
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  rpcs() {
    return this.sent.filter((m) => m.type === "rpc");
  }
}

class FakeCtx {
  constructor() {
    this.storage = new FakeStorage();
    this.sockets = [];
    this.autoResponse = null;
  }
  acceptWebSocket(ws, tags) {
    ws.tags = tags;
    this.sockets.push(ws);
  }
  getWebSockets(tag) {
    return this.sockets.filter((ws) => !ws.gone && ws.tags.includes(tag));
  }
  setWebSocketAutoResponse(pair) {
    this.autoResponse = pair ?? null;
  }
  // The runtime records when it last auto-responded on a socket; tests set ws.autoResponseAt.
  getWebSocketAutoResponseTimestamp(ws) {
    return ws.autoResponseAt ?? null;
  }
}

// What the runtime does when the agent's ping matches the auto-response request:
// answer without invoking the Durable Object and record the time on that socket.
function runtimeAutoRespond(ctx, ws, at = new Date()) {
  assert.ok(ctx.autoResponse, "auto-response must be configured");
  ws.autoResponseAt = at;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function newRelay() {
  const ctx = new FakeCtx();
  const relay = new DeviceRelay(ctx, {});
  return { relay, ctx };
}

async function connectAgent(relay, { healthy = true, respond } = {}) {
  const ws = new FakeSocket();
  await relay.attachAgentSocket(ws);
  if (healthy !== null) await heartbeat(relay, ws, healthy);
  if (respond) {
    ws.onRpc = (msg) => {
      setImmediate(async () => {
        const reply = await respond(msg.payload);
        await relay.webSocketMessage(ws, JSON.stringify({ type: "rpc_result", id: msg.id, ...reply }));
      });
    };
  }
  return ws;
}

async function heartbeat(relay, ws, mcpHealthy) {
  await relay.webSocketMessage(ws, JSON.stringify({ type: "heartbeat", mcpHealthy }));
}

async function disconnect(relay, ws) {
  ws.gone = true;
  await relay.webSocketClose(ws, 1006, "", false);
}

function commanderAgent(payload) {
  if (payload.action === "tools/list") return { result: { tools: DOWNSTREAM_TOOLS } };
  return { result: { content: [{ type: "text", text: `ran:${payload.name}` }] } };
}

// ---------------------------------------------------------------------------
// Worker wiring

function makeEnv(relays, clientKeyB64) {
  // Records the device whose Durable Object is actually invoked; creating a stub
  // alone does not contact the object.
  const names = [];
  const relayFor = (name) => {
    const invoke = () => {
      names.push(name);
      if (!relays.has(name)) relays.set(name, newRelay());
      return relays.get(name).relay;
    };
    return {
      fetch: (request) => invoke().fetch(request),
      mcpRpc: (payload) => invoke().mcpRpc(payload),
      checkAndAlert: () => invoke().checkAndAlert(),
    };
  };
  return {
    names,
    env: {
      DEVICE_RELAY: {
        getByName: relayFor,
        idFromName: (name) => ({ name }),
        get: (id) => relayFor(id.name),
      },
      AGENT_PUBLIC_KEY_B64: clientKeyB64 ?? "",
      CLIENT_PUBLIC_KEY_B64: clientKeyB64 ?? "",
      AGENT_DEVICE_ID: DEVICE,
      CLIENT_DEVICE_ID: DEVICE,
      MCP_DEVICE_ID: DEVICE,
      MCP_BEARER_TOKEN: TOKEN,
    },
  };
}

function mcpRequest(message, { token = TOKEN, url = "https://relay.example/mcp", headers = {}, body } = {}) {
  const init = {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: body ?? JSON.stringify(message),
  };
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request(url, init);
}

let rpcId = 0;
function toolsCall(name, args) {
  rpcId += 1;
  return { jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } };
}

function streamOf(totalBytes, chunkBytes = 16 * 1024) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const n = Math.min(chunkBytes, totalBytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
  });
}

test("worker /mcp rejects missing and wrong bearer tokens before touching the relay", async () => {
  const relays = new Map();
  const { env, names } = makeEnv(relays);
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  assert.equal((await worker.fetch(mcpRequest(init, { token: null }), env)).status, 401);
  assert.equal((await worker.fetch(mcpRequest(init, { token: "x".repeat(40) }), env)).status, 401);
  assert.equal(names.length, 0);
  assert.equal(relays.size, 0);
});

test("worker /mcp lists only reviewed tools, marks idempotencyKey required, and stays on MCP_DEVICE_ID", async () => {
  const relays = new Map([[DEVICE, newRelay()]]);
  await connectAgent(relays.get(DEVICE).relay, { respond: commanderAgent });
  const { env, names } = makeEnv(relays);

  const response = await worker.fetch(mcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { deviceId: "someone-else" } },
    { url: "https://relay.example/mcp?deviceId=someone-else", headers: { "x-astra-device": "someone-else" } },
  ), env);
  assert.equal(response.status, 200);
  const { result } = await response.json();
  const listed = result.tools.map((t) => t.name).sort();
  assert.deepEqual(listed, [...REVIEWED].sort());
  assert.ok(!listed.includes("set_config_value"));
  assert.ok(!listed.includes("future_unreviewed_tool"));
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.required?.includes("idempotencyKey") ?? false, GATED.has(tool.name), tool.name);
  }
  assert.deepEqual([...new Set(names)], [DEVICE]);
  assert.equal(relays.size, 1);
});

test("worker /mcp enforces the idempotency gate and the allowlist before the agent sees the call", async () => {
  const relays = new Map([[DEVICE, newRelay()]]);
  const ws = await connectAgent(relays.get(DEVICE).relay, { respond: commanderAgent });
  const { env } = makeEnv(relays);

  let body = await (await worker.fetch(mcpRequest(toolsCall("write_file", { path: "/tmp/x", content: "y" })), env)).json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /idempotency_key_required/);

  body = await (await worker.fetch(mcpRequest(toolsCall("write_file", { path: "/tmp/x", content: "y", idempotencyKey: "short" })), env)).json();
  assert.match(body.result.content[0].text, /idempotency_key_required/);

  body = await (await worker.fetch(mcpRequest(toolsCall("set_config_value", { key: "allowedDirectories", value: ["/"] })), env)).json();
  assert.match(body.result.content[0].text, /not approved/);
  assert.equal(ws.rpcs().length, 0, "nothing forwarded yet");

  body = await (await worker.fetch(mcpRequest(toolsCall("write_file", {
    path: "/tmp/x", content: "y", idempotencyKey: "write-0001",
  })), env)).json();
  assert.equal(body.result.content[0].text, "ran:write_file");
  assert.equal(ws.rpcs().length, 1);
  assert.equal(ws.rpcs()[0].payload.arguments.idempotencyKey, "write-0001");

  body = await (await worker.fetch(mcpRequest(toolsCall("job_cancel", { jobId: "j1" })), env)).json();
  assert.equal(body.result.content[0].text, "ran:job_cancel", "tools without an idempotencyKey schema are not gated");
});

test("worker /mcp bounds actual body bytes and rejects batches", async () => {
  const relays = new Map();
  const { env } = makeEnv(relays);
  // Chunked body with no Content-Length: the byte counter must stop it.
  const chunked = await worker.fetch(mcpRequest(undefined, { body: streamOf(64 * 1024 + 1) }), env);
  assert.equal(chunked.status, 413);
  const declared = await worker.fetch(mcpRequest(undefined, {
    body: "{}", headers: { "content-length": String(10 * 1024 * 1024) },
  }), env);
  assert.equal(declared.status, 413);
  const batch = await worker.fetch(mcpRequest([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]), env);
  assert.equal(batch.status, 400);
  const wrongType = await worker.fetch(mcpRequest(undefined, { body: "{}", headers: { "content-type": "text/plain" } }), env);
  assert.equal(wrongType.status, 415);
  assert.equal(relays.size, 0);
});

test("worker /mcp fails closed for beta principals until closed-beta routing exists", async () => {
  const relays = new Map([[DEVICE, newRelay()]]);
  const ws = await connectAgent(relays.get(DEVICE).relay, { respond: commanderAgent });
  const { env, names } = makeEnv(relays);
  const betaToken = "beta-token-which-is-long-enough-to-be-a-high-entropy-secret";
  // Worst case: a registry row binds a beta token to the personal device's ID.
  env.BETA_REGISTRY_ENABLED = "true";
  env.BETA_REGISTRY = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({ owner_id: "user-other", device_id: DEVICE, terminal_enabled: 1 }),
        run: async () => ({}),
      }),
    }),
  };

  const response = await worker.fetch(mcpRequest(toolsCall("get_config", {}), { token: betaToken }), env);
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /\(agent_unavailable\)/);
  assert.equal(names.length, 0, "the Durable Object was never invoked");
  assert.equal(ws.rpcs().length, 0);

  // The personal bearer still works with the same env.
  const personal = await (await worker.fetch(mcpRequest(toolsCall("get_config", {})), env)).json();
  assert.equal(personal.result.content[0].text, "ran:get_config");
});

test("downstream failures reach MCP clients only as fixed codes", async () => {
  const relays = new Map([[DEVICE, newRelay()]]);
  let reply = { error: "EACCES: open '/Users/alice/.ssh/id_ed25519' at Object.openSync (node:fs:573)" };
  await connectAgent(relays.get(DEVICE).relay, { respond: () => reply });
  const { env } = makeEnv(relays);

  let text = (await (await worker.fetch(mcpRequest(toolsCall("get_config", {})), env)).json()).result.content[0].text;
  assert.match(text, /\(tool_failed\)/);
  assert.doesNotMatch(text, /Users|ssh|node:fs/);

  reply = { error: "invalid_arguments" };
  text = (await (await worker.fetch(mcpRequest(toolsCall("get_config", {})), env)).json()).result.content[0].text;
  assert.match(text, /\(invalid_arguments\)/);
});

// ---------------------------------------------------------------------------
// DeviceRelay: health, heartbeat, and socket lifecycle

test("status reflects heartbeat and MCP health, not mere socket existence", async (t) => {
  const { relay } = newRelay();
  const status = async () => (await relay.status()).json();

  const ws = await connectAgent(relay, { healthy: null });
  let s = await status();
  assert.equal(s.socketPresent, true);
  assert.equal(s.agentConnected, false, "no heartbeat yet");
  assert.equal((await relay.mcpRpc({ action: "tools/list" })).error, "agent_unavailable");

  await heartbeat(relay, ws, false);
  s = await status();
  assert.equal(s.mcpHealthy, false);
  assert.equal(s.agentConnected, false);
  assert.equal((await relay.mcpRpc({ action: "tools/list" })).error, "agent_unavailable");
  assert.equal(ws.rpcs().length, 0);

  await heartbeat(relay, ws, true);
  s = await status();
  assert.equal(s.agentConnected, true);
  assert.ok(ws.sent.some((m) => m.type === "heartbeat_ack"), "heartbeat is acknowledged");

  const now = Date.now();
  t.mock.method(Date, "now", () => now + AGENT_STALE_MS + 1_000);
  s = await status();
  assert.equal(s.agentConnected, false, "stale heartbeat");
  assert.ok(s.lastSeenAgeMs > AGENT_STALE_MS);
});

// ---------------------------------------------------------------------------
// Hibernation-friendly liveness: runtime auto-response ping/pong

test("the relay registers the exact ping/pong auto-response the agent sends", () => {
  const { ctx } = newRelay();
  assert.equal(ctx.autoResponse.request, AGENT_PING);
  assert.equal(ctx.autoResponse.response, AGENT_PONG);
  // The agent hard-codes the same strings; keep them in lockstep.
  assert.equal(AGENT_PING, '{"type":"ping"}');
  assert.equal(AGENT_PONG, '{"type":"pong"}');
});

test("auto-responded pings keep the agent healthy without waking the object", async (t) => {
  const { relay, ctx } = newRelay();
  const ws = await connectAgent(relay);
  const writesBefore = [...ctx.storage.map.keys()].length;
  const start = Date.now();

  // Ten minutes pass with only runtime-answered pings (no state message, no storage write).
  const later = start + 10 * 60_000;
  runtimeAutoRespond(ctx, ws, new Date(later - 5_000));
  t.mock.method(Date, "now", () => later);

  const s = await (await relay.status()).json();
  assert.equal(s.agentConnected, true, "fresh auto-response counts as seen");
  assert.ok(s.lastSeenAgeMs <= 5_000);
  assert.equal([...ctx.storage.map.keys()].length, writesBefore, "no new storage keys");
});

test("a Mac that stops pinging goes stale even though its socket still looks open", async (t) => {
  const { relay, ctx } = newRelay();
  const ws = await connectAgent(relay);
  const start = Date.now();
  runtimeAutoRespond(ctx, ws, new Date(start));

  // Half-open socket: no close event ever arrives, the pings just stop (sleep, network loss).
  t.mock.method(Date, "now", () => start + AGENT_STALE_MS + 1_000);
  const s = await (await relay.status()).json();
  assert.equal(s.socketPresent, true);
  assert.equal(s.agentConnected, false);
  assert.equal((await relay.checkAndAlert()).healthy, false, "alerting sees the same staleness");
});

test("a replaced socket's auto-responses do not keep the new connection alive", async (t) => {
  const { relay, ctx } = newRelay();
  const old = await connectAgent(relay);
  const current = await connectAgent(relay);
  const start = Date.now();
  runtimeAutoRespond(ctx, old, new Date(start + AGENT_STALE_MS));

  t.mock.method(Date, "now", () => start + AGENT_STALE_MS + 1_000);
  const s = await (await relay.status()).json();
  assert.equal(s.agentConnected, false, "only the current socket's pings count");
  assert.equal(current.autoResponseAt, undefined);
});

test("a ping that reaches the object anyway is answered and counts as seen", async (t) => {
  const { relay } = newRelay();
  const ws = await connectAgent(relay);
  const start = Date.now();
  t.mock.method(Date, "now", () => start + AGENT_STALE_MS - 1_000);

  await relay.webSocketMessage(ws, AGENT_PING);
  assert.ok(ws.sent.some((m) => m.type === "pong"), "pong sent");

  t.mock.method(Date, "now", () => start + AGENT_STALE_MS + 10_000);
  const s = await (await relay.status()).json();
  assert.equal(s.agentConnected, true, "fallback ping refreshed lastSeen");
});

test("a socket from the previous deployment is adopted only when no current connection exists", async () => {
  const { relay, ctx } = newRelay();
  const legacy = new FakeSocket();
  ctx.acceptWebSocket(legacy, ["agent"]);
  legacy.serializeAttachment({ role: "agent", connectedAt: 1 });
  await heartbeat(relay, legacy, true);
  assert.equal((await (await relay.status()).json()).agentConnected, true);

  const current = await connectAgent(relay);
  const stray = new FakeSocket();
  ctx.acceptWebSocket(stray, ["agent"]);
  stray.serializeAttachment({ role: "agent", connectedAt: 1 });
  await heartbeat(relay, stray, false);
  assert.equal(stray.attachment.connId, undefined, "not adopted while a current socket exists");
  assert.equal((await (await relay.status()).json()).agentConnected, true);
  assert.ok(current.attachment.connId);
});

test("an rpc_result does not mark local MCP healthy", async () => {
  const { relay } = newRelay();
  const ws = await connectAgent(relay, { respond: () => ({ error: "mcp_unavailable" }) });
  const outcome = await relay.mcpRpc({ action: "tools/list" });
  assert.equal(outcome.error, "mcp_unavailable");
  await heartbeat(relay, ws, false);
  await relay.webSocketMessage(ws, JSON.stringify({ type: "rpc_result", id: "unknown", result: {} }));
  assert.equal((await (await relay.status()).json()).mcpHealthy, false);
});

test("a replaced socket's late close or heartbeat does not affect the new connection", async () => {
  const { relay } = newRelay();
  const oldWs = await connectAgent(relay);
  let release;
  const newWs = await connectAgent(relay, {
    respond: () => new Promise((resolve) => { release = () => resolve({ result: { tools: [] } }); }),
  });
  assert.equal(oldWs.closed?.code, 1012);

  const call = relay.mcpRpc({ action: "tools/list" });
  while (!release) await tick();
  assert.equal(newWs.rpcs().length, 1);
  assert.equal(oldWs.rpcs().length, 0);

  await heartbeat(relay, oldWs, false);
  await disconnect(relay, oldWs);
  assert.equal((await (await relay.status()).json()).agentConnected, true);

  release();
  const outcome = await call;
  assert.equal(outcome.ok, true);
});

test("pending requests per device are capped and rejected when the agent disconnects", async () => {
  const { relay } = newRelay();
  const ws = await connectAgent(relay);
  const calls = Array.from({ length: MAX_PENDING }, () => relay.mcpRpc({ action: "tools/list" }));
  while (ws.rpcs().length < MAX_PENDING) await tick();

  const excess = await relay.mcpRpc({ action: "tools/list" });
  assert.equal(excess.status, 429);
  assert.equal(excess.error, "too_many_pending_requests");
  assert.equal(ws.rpcs().length, MAX_PENDING);

  await disconnect(relay, ws);
  for (const outcome of await Promise.all(calls)) {
    assert.equal(outcome.error, "agent_disconnected");
  }
  assert.equal(relay.pending.size, 0);
});

test("a send failure after the health check is reported as 503 and leaves nothing pending", async () => {
  const { relay } = newRelay();
  const ws = await connectAgent(relay);
  ws.throwOnSend = true;
  const outcome = await relay.mcpRpc({ action: "tools/list" });
  assert.deepEqual(outcome, { ok: false, status: 503, error: "agent_send_failed" });
  assert.equal(relay.pending.size, 0);
});

test("oversized agent frames close that socket and fail only its requests", async () => {
  const { relay } = newRelay();
  const ws = await connectAgent(relay);
  const call = relay.mcpRpc({ action: "tools/list" });
  while (ws.rpcs().length < 1) await tick();
  await relay.webSocketMessage(ws, "x".repeat(1024 * 1024 + 1));
  assert.equal(ws.closed?.code, 1009);
  assert.equal((await call).error, "agent_message_too_large");
});

test("a silent agent times out with a sanitized 504", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { relay } = newRelay();
  const ws = await connectAgent(relay);
  const call = relay.mcpRpc({ action: "tools/list" });
  while (ws.rpcs().length < 1) await tick();
  t.mock.timers.tick(30_000);
  assert.deepEqual(await call, { ok: false, status: 504, error: "agent_timeout" });
  assert.equal(relay.pending.size, 0);
});

test("the relay refuses unreviewed or excluded tools and malformed payloads itself", async () => {
  const { relay } = newRelay();
  const ws = await connectAgent(relay, { respond: commanderAgent });
  assert.equal((await relay.mcpRpc({ action: "tools/call", name: "set_config_value", arguments: {} })).status, 403);
  assert.equal((await relay.mcpRpc({ action: "tools/call", name: "future_unreviewed_tool" })).status, 403);
  assert.equal((await relay.mcpRpc({ action: "tools/call", name: "read_file", arguments: "x" })).status, 400);
  assert.equal((await relay.mcpRpc({ action: "resources/list" })).status, 400);
  assert.equal((await relay.mcpRpc(null)).status, 400);
  assert.equal(ws.rpcs().length, 0);
});

// ---------------------------------------------------------------------------
// Replay and rate limits

test("more than 512 valid nonces cannot evict a still-valid nonce; expiry pruning is batched", async (t) => {
  const { relay, ctx } = newRelay();
  const start = Date.now();
  const nonces = Array.from({ length: 700 }, () => randomBytes(16).toString("hex"));
  for (const nonce of nonces) assert.equal(await relay.acceptNonceValues(nonce, start), true);
  assert.equal(await relay.acceptNonceValues(nonces[0], start), false, "first nonce still remembered");
  assert.notEqual(ctx.storage.alarm, null);

  // Within the TTL the alarm keeps everything.
  t.mock.method(Date, "now", () => start + NONCE_TTL_MS - 1);
  await relay.alarm();
  assert.equal(await relay.acceptNonceValues(nonces[0], start), false);

  // After the TTL (well past the 60 s timestamp window) entries are pruned.
  const fresh = randomBytes(16).toString("hex");
  await relay.acceptNonceValues(fresh, start + NONCE_TTL_MS + 1);
  Date.now.mock.mockImplementation(() => start + NONCE_TTL_MS + 2);
  await relay.alarm();
  const remaining = [...(await ctx.storage.list({ prefix: "nonce:" })).keys()];
  assert.deepEqual(remaining, [`nonce:${fresh}`]);
});

test("the agent reconnect bucket is separate from the client request bucket", async () => {
  const { relay } = newRelay();
  for (let i = 0; i < MAX_AUTH_REQUESTS_PER_WINDOW; i += 1) {
    assert.equal(await relay.acceptRate("client"), true);
  }
  assert.equal(await relay.acceptRate("client"), false);
  assert.equal((await relay.mcpRpc({ action: "tools/list" })).error, "rate_limited");
  assert.equal(await relay.acceptRate("agent"), true);
});

// ---------------------------------------------------------------------------
// Legacy signed RPC path

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

function signedHeaders(privateKey, method, target, body = Buffer.alloc(0)) {
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = [timestamp, nonce, method, target, hash].join("\n");
  return {
    "x-astra-timestamp": timestamp,
    "x-astra-nonce": nonce,
    "x-astra-signature": sign(null, Buffer.from(canonical), privateKey).toString("base64"),
  };
}

test("signed path counts actual body bytes before signature verification", async () => {
  const { privateKey, publicB64 } = keyPair();
  const relays = new Map();
  const { env } = makeEnv(relays, publicB64);
  const path = `/v1/device/${DEVICE}/rpc`;
  const headers = signedHeaders(privateKey, "POST", path);

  const chunked = await worker.fetch(new Request(`https://relay.example${path}`, {
    method: "POST", headers, body: streamOf(MAX_BODY_BYTES + 1, 64 * 1024), duplex: "half",
  }), env);
  assert.equal(chunked.status, 413);

  const declared = await worker.fetch(new Request(`https://relay.example${path}`, {
    method: "POST", headers: { ...headers, "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}",
  }), env);
  assert.equal(declared.status, 413);
  assert.equal(relays.size, 0);

  const malformed = await worker.fetch(new Request("https://relay.example/v1/device/%E0%A4%A/status"), env);
  assert.equal(malformed.status, 400);
});

test("signed path end to end: status, replay, allowlist, and sanitized errors", async () => {
  const { privateKey, publicB64 } = keyPair();
  const relays = new Map([[DEVICE, newRelay()]]);
  await connectAgent(relays.get(DEVICE).relay, {
    respond: (payload) => payload.name === "read_file"
      ? { error: "ENOENT: no such file '/Users/alice/private.txt'" }
      : commanderAgent(payload),
  });
  const { env } = makeEnv(relays, publicB64);

  const statusPath = `/v1/device/${DEVICE}/status`;
  const statusHeaders = signedHeaders(privateKey, "GET", statusPath);
  const status = await worker.fetch(new Request(`https://relay.example${statusPath}`, { headers: statusHeaders }), env);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).agentConnected, true);
  const replay = await worker.fetch(new Request(`https://relay.example${statusPath}`, { headers: statusHeaders }), env);
  assert.equal(replay.status, 409);

  const rpc = async (payload) => {
    const path = `/v1/device/${DEVICE}/rpc`;
    const body = Buffer.from(JSON.stringify(payload));
    return worker.fetch(new Request(`https://relay.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(privateKey, "POST", path, body) },
      body,
    }), env);
  };

  const listed = await rpc({ action: "tools/list" });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).result.tools.length, DOWNSTREAM_TOOLS.length);

  const unapproved = await rpc({ action: "tools/call", name: "set_config_value", arguments: {} });
  assert.equal(unapproved.status, 403);

  const noKey = await rpc({ action: "tools/call", name: "write_file", arguments: { path: "/tmp/x", content: "" } });
  assert.equal(noKey.status, 400);
  assert.equal((await noKey.json()).error, "idempotency_key_required");

  const failed = await rpc({ action: "tools/call", name: "read_file", arguments: { path: "/tmp/x" } });
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "tool_failed" });
});


test("domain verification challenge is exact, disabled by default, and method-safe", async () => {
  const relays = new Map();
  const { env } = makeEnv(relays);
  const url = "https://relay.example/.well-known/openai-apps-challenge";

  let response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, 404);

  env.OPENAI_APPS_CHALLENGE = "verify_exact_token_123";
  response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "verify_exact_token_123");
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("access-control-allow-origin"), null);

  response = await worker.fetch(new Request(url, { method: "HEAD" }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");

  response = await worker.fetch(new Request(url, { method: "POST" }), env);
  assert.equal(response.status, 405);
});

// ---------------------------------------------------------------------------
// Liveness alerting (checkAndAlert / scheduled())

function fakeSeb() {
  const sent = [];
  return { sent, send: async (msg) => { sent.push(msg); } };
}

function rawEmailSubject(raw) {
  const match = raw.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=$/m);
  assert.ok(match, "expected an RFC 2047 base64 Subject header");
  return Buffer.from(match[1], "base64").toString("utf8");
}

function withAlertEnv(relay) {
  const seb = fakeSeb();
  Object.assign(relay.env, {
    ALERT_EMAIL: seb,
    ALERT_FROM_ADDRESS: "alerts@example.com",
    ALERT_TO_ADDRESS: "owner@example.com",
  });
  return seb;
}

test("checkAndAlert: healthy agent never alerts", async () => {
  const { relay } = newRelay();
  const seb = withAlertEnv(relay);
  await connectAgent(relay);

  const result = await relay.checkAndAlert();
  assert.deepEqual(result, { healthy: true, alerted: null });
  assert.equal(seb.sent.length, 0);
});

test("checkAndAlert: requires two consecutive unhealthy checks before the first email", async () => {
  const { relay, ctx } = newRelay();
  const seb = withAlertEnv(relay);
  const ws = await connectAgent(relay);
  await disconnect(relay, ws);
  assert.equal((await ctx.storage.get("agentMcpHealthy")), false);

  const first = await relay.checkAndAlert();
  assert.equal(first.healthy, false);
  assert.equal(first.alerted, null, "single miss must not alert yet");
  assert.equal(seb.sent.length, 0);

  assert.ok(ALERT_MIN_CONSECUTIVE_UNHEALTHY >= 2);
  let last;
  for (let i = 1; i < ALERT_MIN_CONSECUTIVE_UNHEALTHY; i += 1) last = await relay.checkAndAlert();
  assert.equal(last.alerted, "down");
  assert.equal(seb.sent.length, 1);
  assert.equal(seb.sent[0].from, "alerts@example.com");
  assert.equal(seb.sent[0].to, "owner@example.com");
  assert.equal(rawEmailSubject(seb.sent[0].raw), "Astra Bridge: Mac agent is not responding");

  // Still down on the next check, but within the repeat cooldown: no second email.
  const again = await relay.checkAndAlert();
  assert.equal(again.alerted, null);
  assert.equal(seb.sent.length, 1);
});

test("checkAndAlert: sends exactly one recovery email after an active alert", async () => {
  const { relay } = newRelay();
  const seb = withAlertEnv(relay);
  const ws = await connectAgent(relay);
  await disconnect(relay, ws);
  for (let i = 0; i < ALERT_MIN_CONSECUTIVE_UNHEALTHY; i += 1) await relay.checkAndAlert();
  assert.equal(seb.sent.length, 1);

  await connectAgent(relay);
  const recovered = await relay.checkAndAlert();
  assert.equal(recovered.healthy, true);
  assert.equal(recovered.alerted, "recovered");
  assert.equal(seb.sent.length, 2);
  assert.equal(rawEmailSubject(seb.sent[1].raw), "Astra Bridge: Mac agent is back online");

  // Healthy again afterwards must not re-send.
  const stillHealthy = await relay.checkAndAlert();
  assert.equal(stillHealthy.alerted, null);
  assert.equal(seb.sent.length, 2);
});

test("checkAndAlert: repeats the down email after the cooldown elapses, not before", async () => {
  const { relay, ctx } = newRelay();
  const seb = withAlertEnv(relay);
  const ws = await connectAgent(relay);
  await disconnect(relay, ws);
  for (let i = 0; i < ALERT_MIN_CONSECUTIVE_UNHEALTHY; i += 1) await relay.checkAndAlert();
  assert.equal(seb.sent.length, 1);

  await relay.checkAndAlert();
  assert.equal(seb.sent.length, 1, "still within cooldown");

  await ctx.storage.put("alertLastSentAt", Date.now() - (ALERT_REPEAT_MS + 1000));
  const repeated = await relay.checkAndAlert();
  assert.equal(repeated.alerted, "down");
  assert.equal(seb.sent.length, 2);
});

test("checkAndAlert: a missing/misconfigured alert channel never throws or blocks bookkeeping", async () => {
  const { relay } = newRelay(); // no ALERT_EMAIL/ALERT_FROM_ADDRESS/ALERT_TO_ADDRESS set
  const ws = await connectAgent(relay);
  await disconnect(relay, ws);

  for (let i = 0; i < ALERT_MIN_CONSECUTIVE_UNHEALTHY; i += 1) {
    await assert.doesNotReject(relay.checkAndAlert());
  }
});

test("checkAndAlert: a throwing send() is swallowed, not propagated", async () => {
  const { relay } = newRelay();
  Object.assign(relay.env, {
    ALERT_EMAIL: { send: async () => { throw new Error("smtp down"); } },
    ALERT_FROM_ADDRESS: "alerts@example.com",
    ALERT_TO_ADDRESS: "owner@example.com",
  });
  const ws = await connectAgent(relay);
  await disconnect(relay, ws);

  let result;
  for (let i = 0; i < ALERT_MIN_CONSECUTIVE_UNHEALTHY; i += 1) {
    result = await relay.checkAndAlert(); // throws the test itself if checkAndAlert rejects
  }
  assert.equal(result.alerted, "down", "bookkeeping still records the alert attempt");
});

test("scheduled() checks the configured MCP_DEVICE_ID's Durable Object via RPC, not fetch", async () => {
  const relays = new Map();
  const { env, names } = makeEnv(relays);
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };

  await worker.scheduled({}, env, ctx);
  assert.deepEqual(names, [DEVICE]);
  await Promise.all(waited);

  const { relay } = relays.get(DEVICE);
  const state = await relay.checkAndAlert();
  assert.equal(state.healthy, false, "no agent ever connected in this test");
});

test("scheduled() no-ops without throwing when MCP_DEVICE_ID is unset", async () => {
  const { env } = makeEnv(new Map());
  delete env.MCP_DEVICE_ID;
  const ctx = { waitUntil: () => { throw new Error("must not be called"); } };
  await assert.doesNotReject(worker.scheduled({}, env, ctx));
});
