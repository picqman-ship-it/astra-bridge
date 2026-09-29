import assert from "node:assert/strict";
import test from "node:test";
import { authenticateMcpRequest, handleMcpRequest, MCP_MAX_BODY_BYTES } from "../.test-tmp/mcp.mjs";
import { hashBearerToken, resolveActiveBetaDevice, resolveBetaBearerHash } from "../.test-tmp/beta-registry.mjs";

const TOKEN = "test-token-which-is-long-enough-to-be-a-high-entropy-secret";
const TOOL_NAMES = [
  "get_config", "read_file", "read_multiple_files", "write_file", "create_directory",
  "list_directory", "move_file", "get_file_info", "start_search", "get_more_search_results",
  "stop_search", "list_searches", "edit_block", "start_process", "read_process_output",
  "interact_with_process", "force_terminate", "list_sessions", "list_processes", "kill_process",
  "get_recent_tool_calls", "get_usage_stats", "job_start", "job_status", "job_list",
  "job_logs", "job_cancel",
];
const tools = TOOL_NAMES.map((name) => ({
  name,
  description: `Deterministic test tool ${name}`,
  inputSchema: {
    type: "object",
    properties: ["create_directory", "write_file", "edit_block", "move_file", "start_process", "interact_with_process", "force_terminate", "kill_process", "job_start"].includes(name)
      ? { idempotencyKey: { type: "string" } }
      : {},
  },
}));

function request(message, options = {}) {
  const headers = new Headers({
    authorization: `Bearer ${TOKEN}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...options.headers,
  });
  return new Request("https://relay.example/mcp", {
    method: options.method ?? "POST",
    headers,
    body: options.body ?? (message === undefined ? undefined : JSON.stringify(message)),
  });
}

function mcpEnv(overrides = {}) {
  return { MCP_BEARER_TOKEN: TOKEN, MCP_DEVICE_ID: "test-device", ...overrides };
}

async function call(message, relay, options, env = mcpEnv()) {
  return handleMcpRequest(request(message, options), env, relay);
}

test("MCP rejects missing bearer token without leaking credentials", async () => {
  const response = await handleMcpRequest(
    new Request("https://relay.example/mcp", { method: "POST" }),
    mcpEnv(),
    async () => ({ tools }),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized" }, id: null,
  });
  assert.equal(response.headers.has("access-control-allow-origin"), false);
});

test("MCP enforces POST, JSON content type, and bounded request bodies", async () => {
  const relay = async () => ({ tools });
  assert.equal((await call(undefined, relay, { method: "GET" })).status, 405);
  assert.equal((await call({ jsonrpc: "2.0" }, relay, {
    headers: { "content-type": "text/plain" },
  })).status, 415);
  assert.equal((await call(undefined, relay, { body: "{not-json" })).status, 400);
  assert.equal((await call(undefined, relay, {
    body: "x".repeat(MCP_MAX_BODY_BYTES + 1),
  })).status, 413);
});

test("MCP supports initialize and notifications/initialized statelessly", async () => {
  const relay = async () => ({ tools });
  const initialized = await call({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }, relay);
  assert.equal(initialized.status, 200);
  const body = await initialized.json();
  assert.equal(body.result.serverInfo.name, "astra-bridge-relay");
  assert.equal(body.result.capabilities.tools !== undefined, true);

  const notification = await call({ jsonrpc: "2.0", method: "notifications/initialized" }, relay);
  assert.equal(notification.status, 202);
});

test("MCP tools/list and tools/call delegate through the relay contract", async () => {
  const calls = [];
  const relay = async (payload) => {
    calls.push(payload);
    if (payload.action === "tools/list") return { tools };
    return { content: [{ type: "text", text: `called:${payload.name}` }] };
  };

  const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, relay);
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody.result.tools.length, 27);
  for (const tool of listedBody.result.tools) {
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations.openWorldHint, "boolean");
  }

  const called = await call({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "get_config", arguments: { value: "safe" } },
  }, relay);
  assert.equal(called.status, 200);
  assert.equal((await called.json()).result.content[0].text, "called:get_config");
  assert.deepEqual(calls, [
    { action: "tools/list" },
    { action: "tools/call", name: "get_config", arguments: { value: "safe" } },
  ]);
});

test("MCP converts downstream failures into a sanitized tool result", async () => {
  const response = await call({
    jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_config" },
  }, async () => {
    throw new Error("private downstream detail");
  });
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /tool_failed/);
});


test("MCP rejects tools that are not in the reviewed allowlist", async () => {
  let delegated = false;
  const result = await call({
    jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "future_unreviewed_tool", arguments: {} },
  }, async () => { delegated = true; return { content: [] }; });
  const body = await result.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /\(tool_not_approved\)/);
  assert.equal(delegated, false);
});

class MockRegistry {
  constructor({ users, devices, tokens }) {
    this.users = users;
    this.devices = devices;
    this.tokens = tokens;
  }

  prepare(sql) {
    let values = [];
    return {
      bind: (...bound) => { values = bound; return this.prepareBound(sql, () => values); },
      first: async () => null,
      run: async () => ({}),
    };
  }

  prepareBound(sql, values) {
    return {
      bind: (...bound) => { throw new Error(`bound twice: ${bound.length}`); },
      first: async () => {
        const bound = values();
        if (sql.includes("FROM access_tokens")) {
          const [hash, now] = bound;
          const token = this.tokens.find((entry) => entry.token_hash === hash);
          const device = token && this.devices.find((entry) => entry.device_id === token.device_id && entry.owner_id === token.owner_id);
          const user = token && this.users.find((entry) => entry.user_id === token.owner_id);
          if (!token || !device || !user || token.status !== "active" || token.revoked_at || user.status !== "active"
            || device.status !== "active" || device.revoked_at || (token.expires_at && token.expires_at <= now)) return null;
          return { owner_id: token.owner_id, device_id: token.device_id, terminal_enabled: device.terminal_enabled };
        }
        if (sql.includes("FROM devices")) {
          const [deviceId] = bound;
          const device = this.devices.find((entry) => entry.device_id === deviceId);
          const user = device && this.users.find((entry) => entry.user_id === device.owner_id);
          if (!device || !user || device.status !== "active" || device.revoked_at || user.status !== "active") return null;
          return { ...device };
        }
        return null;
      },
      run: async () => ({}),
    };
  }
}

async function betaFixture() {
  const tokenA = "beta-token-a-which-is-long-enough-to-be-a-high-entropy-secret";
  const tokenB = "beta-token-b-which-is-long-enough-to-be-a-high-entropy-secret";
  const [hashA, hashB] = await Promise.all([hashBearerToken(tokenA), hashBearerToken(tokenB)]);
  const registry = new MockRegistry({
    users: [
      { user_id: "user-alpha", status: "active" },
      { user_id: "user-bravo", status: "active" },
    ],
    devices: [
      { device_id: "device-alpha", owner_id: "user-alpha", status: "active", revoked_at: null, terminal_enabled: 0, agent_public_key_b64: "alpha-key" },
      { device_id: "device-bravo", owner_id: "user-bravo", status: "active", revoked_at: null, terminal_enabled: 1, agent_public_key_b64: "bravo-key" },
    ],
    tokens: [
      { token_hash: hashA, owner_id: "user-alpha", device_id: "device-alpha", status: "active", revoked_at: null, expires_at: null },
      { token_hash: hashB, owner_id: "user-bravo", device_id: "device-bravo", status: "active", revoked_at: null, expires_at: null },
    ],
  });
  return { registry, tokenA, tokenB, hashA, hashB };
}

test("a beta token hash resolves only its bound active device", async () => {
  const { registry, hashA, hashB } = await betaFixture();
  assert.deepEqual(await resolveBetaBearerHash(registry, hashA), {
    ownerId: "user-alpha", deviceId: "device-alpha", terminalEnabled: false,
  });
  assert.deepEqual(await resolveBetaBearerHash(registry, hashB), {
    ownerId: "user-bravo", deviceId: "device-bravo", terminalEnabled: true,
  });
  assert.equal((await resolveActiveBetaDevice(registry, "device-alpha")).agentPublicKeyB64, "alpha-key");
});

test("revoked or expired beta tokens and devices are denied", async () => {
  const { registry, hashA } = await betaFixture();
  registry.tokens[0].revoked_at = "2026-09-27T00:00:00.000Z";
  assert.equal(await resolveBetaBearerHash(registry, hashA), null);
  registry.tokens[0].revoked_at = null;
  registry.tokens[0].expires_at = "2000-01-01T00:00:00.000Z";
  assert.equal(await resolveBetaBearerHash(registry, hashA), null);
  registry.tokens[0].expires_at = null;
  registry.devices[0].status = "revoked";
  assert.equal(await resolveBetaBearerHash(registry, hashA), null);
  assert.equal(await resolveActiveBetaDevice(registry, "device-alpha"), null);
});

test("synthetic beta users cannot cross devices", async () => {
  const { registry, tokenA, tokenB } = await betaFixture();
  const [principalA, principalB] = await Promise.all([
    authenticateMcpRequest(request(undefined, { headers: { authorization: `Bearer ${tokenA}` } }), mcpEnv({ BETA_REGISTRY_ENABLED: "true", BETA_REGISTRY: registry })),
    authenticateMcpRequest(request(undefined, { headers: { authorization: `Bearer ${tokenB}` } }), mcpEnv({ BETA_REGISTRY_ENABLED: "true", BETA_REGISTRY: registry })),
  ]);
  assert.equal(principalA.deviceId, "device-alpha");
  assert.equal(principalA.ownerId, "user-alpha");
  assert.equal(principalB.deviceId, "device-bravo");
  assert.equal(principalB.ownerId, "user-bravo");
  assert.notEqual(principalA.deviceId, principalB.deviceId);
});

test("terminal-disabled beta principals filter and block process and durable-command tools", async () => {
  const { registry, tokenA } = await betaFixture();
  const env = mcpEnv({ MCP_BEARER_TOKEN: "personal-token-which-is-long-enough-to-be-a-high-entropy-secret", BETA_REGISTRY_ENABLED: "true", BETA_REGISTRY: registry });
  const betaRequest = (message) => new Request("https://relay.example/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  const calls = [];
  const relay = async (payload) => { calls.push(payload); return payload.action === "tools/list" ? { tools } : { content: [] }; };
  const listed = await handleMcpRequest(betaRequest({ jsonrpc: "2.0", id: 21, method: "tools/list", params: {} }), env, relay);
  const listedNames = (await listed.json()).result.tools.map((tool) => tool.name);
  for (const name of ["start_process", "read_process_output", "interact_with_process", "force_terminate", "list_sessions", "list_processes", "kill_process", "job_start", "job_status", "job_list", "job_logs", "job_cancel"]) {
    assert.equal(listedNames.includes(name), false, name);
  }
  const blocked = await handleMcpRequest(betaRequest({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "job_start", arguments: {} } }), env, relay);
  const body = await blocked.json();
  assert.equal(body.result.isError, true);
  assert.equal(body.result.content[0].text, "Tool is not enabled for this device.");
  assert.deepEqual(calls, [{ action: "tools/list" }]);
});

test("beta disabled preserves personal auth and ignores a registry binding", async () => {
  const { registry } = await betaFixture();
  const principals = [];
  const relay = async (_payload, principal) => { principals.push(principal); return { tools }; };
  const message = { jsonrpc: "2.0", id: 30, method: "tools/list", params: {} };
  const baseline = await handleMcpRequest(request(message), mcpEnv(), relay);
  const disabled = await handleMcpRequest(request(message), mcpEnv({ BETA_REGISTRY_ENABLED: "false", BETA_REGISTRY: registry }), relay);
  assert.deepEqual(await disabled.json(), await baseline.json());
  const personal = {
    kind: "personal", ownerId: "personal", deviceId: "test-device", terminalEnabled: true,
    scopes: ["astra.read", "astra.write", "astra.control"],
  };
  assert.deepEqual(principals, [personal, personal]);
});
