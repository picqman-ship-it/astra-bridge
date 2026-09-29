import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import worker, { OAuthStore } from "../.test-tmp/index.mjs";
import {
  ACCESS_TOKEN_TTL_MS,
  CLEANUP_BATCH,
  CODE_TTL_MS,
  MAX_TOKEN_FAMILIES,
  OWNER_MAX_FAILURES,
  OWNER_WINDOW_MS,
  REFRESH_TOKEN_TTL_MS,
} from "../.test-tmp/oauth-store.mjs";

const ISSUER = "https://relay.example";
const RESOURCE = `${ISSUER}/mcp`;
const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;
const CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const ALL_SCOPES = ["astra.read", "astra.write", "astra.control"];
const OWNER_SECRET = "owner-secret-for-tests-" + "s".repeat(40);
const OPERATOR_TOKEN = "operator-bearer-token-which-is-long-enough-for-the-check";
const DEVICE = "test-device";
// Request URLs deliberately use another host: identity must come from config only.
const BASE = "https://request-host.example";

const READ_TOOLS = [
  "get_config", "read_file", "read_multiple_files", "list_directory", "get_file_info",
  "start_search", "get_more_search_results", "list_searches", "get_usage_stats",
];
const WRITE_TOOLS = ["write_file", "create_directory", "move_file", "edit_block", "stop_search"];
const CONTROL_TOOLS = [
  "start_process", "read_process_output", "interact_with_process", "force_terminate", "list_sessions",
  "list_processes", "kill_process", "get_recent_tool_calls", "job_start", "job_status", "job_list",
  "job_logs", "job_cancel",
];
const GATED = new Set([
  "create_directory", "write_file", "edit_block", "move_file", "start_process",
  "interact_with_process", "force_terminate", "kill_process", "job_start",
]);
const DOWNSTREAM_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, ...CONTROL_TOOLS].map((name) => ({
  name,
  description: `tool ${name}`,
  inputSchema: { type: "object", properties: GATED.has(name) ? { idempotencyKey: { type: "string" } } : {} },
}));

// ---------------------------------------------------------------------------
// Fakes

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
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort();
    return new Map(keys.slice(0, limit).map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at) {
    this.alarm = at;
  }
}

// Models the runtime guarantee the store relies on: blockConcurrencyWhile callbacks
// never interleave with each other, even across non-storage awaits.
class FakeCtx {
  constructor() {
    this.storage = new FakeStorage();
    this.queue = Promise.resolve();
  }
  blockConcurrencyWhile(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }
}

function makeEnv({ ownerSecret = OWNER_SECRET, relayCalls = [] } = {}) {
  const ctx = new FakeCtx();
  const { storage } = ctx;
  const env = {
    AGENT_PUBLIC_KEY_B64: "",
    CLIENT_PUBLIC_KEY_B64: "",
    AGENT_DEVICE_ID: DEVICE,
    CLIENT_DEVICE_ID: DEVICE,
    MCP_DEVICE_ID: DEVICE,
    MCP_BEARER_TOKEN: OPERATOR_TOKEN,
    OAUTH_ISSUER: ISSUER,
    OAUTH_RESOURCE: RESOURCE,
    OAUTH_OWNER_SECRET: ownerSecret,
  };
  const store = new OAuthStore(ctx, env);
  const storeNames = [];
  env.OAUTH_STORE = { getByName: (name) => { storeNames.push(name); return store; } };
  env.DEVICE_RELAY = {
    getByName: (name) => ({
      mcpRpc: async (payload) => {
        relayCalls.push({ name, payload });
        if (payload.action === "tools/list") return { ok: true, result: { tools: DOWNSTREAM_TOOLS } };
        return { ok: true, result: { content: [{ type: "text", text: `ran:${payload.name}` }] } };
      },
    }),
  };
  return { env, storage, store, relayCalls, storeNames };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeParams(challenge, overrides = {}) {
  const params = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: "state-1234",
    scope: ALL_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...overrides,
  };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, item);
  }
  return search;
}

function getAuthorize(env, challenge, overrides) {
  return worker.fetch(new Request(`${BASE}/oauth/authorize?${authorizeParams(challenge, overrides)}`), env);
}

function postForm(env, path, form, headers = {}) {
  return worker.fetch(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form instanceof URLSearchParams ? form : new URLSearchParams(form),
  }), env);
}

function postAuthorize(env, challenge, { overrides, secret = OWNER_SECRET, granted = ALL_SCOPES, decision = "approve", headers } = {}) {
  const form = authorizeParams(challenge, overrides);
  if (secret !== undefined) form.set("owner_secret", secret);
  for (const scope of granted) form.append("granted_scope", scope);
  form.set("decision", decision);
  return postForm(env, "/oauth/authorize", form, headers);
}

function redirectParams(response) {
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  return location.searchParams;
}

async function issueCode(env, { granted = ALL_SCOPES, scope } = {}) {
  const { verifier, challenge } = pkce();
  const overrides = scope === undefined ? {} : { scope };
  const params = redirectParams(await postAuthorize(env, challenge, { granted, overrides }));
  return { code: params.get("code"), verifier };
}

function exchange(env, code, verifier, overrides = {}) {
  const form = {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    ...overrides,
  };
  for (const [key, value] of Object.entries(form)) if (value === undefined) delete form[key];
  return postForm(env, "/oauth/token", form);
}

function refresh(env, refreshToken, overrides = {}) {
  const form = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID, resource: RESOURCE, ...overrides };
  for (const [key, value] of Object.entries(form)) if (value === undefined) delete form[key];
  return postForm(env, "/oauth/token", form);
}

async function tokensFor(env, options) {
  const { code, verifier } = await issueCode(env, options);
  const response = await exchange(env, code, verifier);
  assert.equal(response.status, 200);
  return { code, verifier, body: await response.json() };
}

let rpcId = 0;
function mcp(env, method, params = {}, token) {
  rpcId += 1;
  return worker.fetch(new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  }), env);
}

async function listedNames(env, token) {
  const response = await mcp(env, "tools/list", {}, token);
  assert.equal(response.status, 200);
  return (await response.json()).result.tools.map((tool) => tool.name).sort();
}

// ---------------------------------------------------------------------------
// 1. Metadata

test("metadata endpoints publish the exact configured issuer and resource", async () => {
  const { env } = makeEnv();
  const expectedPrm = {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Astra Bridge (personal)",
  };
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await worker.fetch(new Request(`https://attacker.example${path}`, { headers: { host: "attacker.example" } }), env);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), expectedPrm, path);
  }

  const as = await (await worker.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`), env)).json();
  assert.deepEqual(as, {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ALL_SCOPES,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  });
  assert.equal("registration_endpoint" in as, false, "no dynamic client registration");

  const head = await worker.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
});

test("template wrangler.jsonc keeps the OAuth store and holds placeholders, not secrets", () => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  assert.match(config.vars.OAUTH_ISSUER, /<your-worker>/, "issuer is a placeholder to fill in");
  assert.equal(config.vars.OAUTH_RESOURCE, `${config.vars.OAUTH_ISSUER}/mcp`);
  assert.ok(config.durable_objects.bindings.some((b) => b.name === "OAUTH_STORE" && b.class_name === "OAuthStore"));
  assert.deepEqual(config.migrations.at(-1), { tag: "v2", new_sqlite_classes: ["OAuthStore"] });
  assert.equal("OAUTH_OWNER_SECRET" in config.vars, false);
  assert.equal("MCP_BEARER_TOKEN" in config.vars, false);
});

test("misconfigured issuer or resource disables every OAuth endpoint", async () => {
  for (const vars of [
    { OAUTH_ISSUER: "http://relay.example", OAUTH_RESOURCE: "http://relay.example/mcp" },
    { OAUTH_ISSUER: `${ISSUER}/`, OAUTH_RESOURCE: `${ISSUER}//mcp` },
    { OAUTH_ISSUER: ISSUER, OAUTH_RESOURCE: `${ISSUER}/other` },
    { OAUTH_ISSUER: undefined, OAUTH_RESOURCE: undefined },
  ]) {
    const { env } = makeEnv();
    Object.assign(env, vars);
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/oauth/token"]) {
      assert.equal((await worker.fetch(new Request(`${BASE}${path}`), env)).status, 404, `${path} ${vars.OAUTH_ISSUER}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Authorization request validation

test("authorize refuses to redirect for a wrong client_id or redirect_uri", async () => {
  const { env } = makeEnv();
  const { challenge } = pkce();
  for (const overrides of [
    { client_id: "https://evil.example/client.json" },
    { client_id: undefined },
    { client_id: [CLIENT_ID, CLIENT_ID] },
    { redirect_uri: "https://evil.example/callback" },
    { redirect_uri: `${REDIRECT_URI}/extra` },
    { redirect_uri: undefined },
  ]) {
    const response = await getAuthorize(env, challenge, overrides);
    assert.equal(response.status, 400, JSON.stringify(overrides));
    assert.equal(response.headers.has("location"), false);
    // POST gets the same treatment even with the correct owner secret.
    const posted = await postAuthorize(env, challenge, { overrides });
    assert.equal(posted.status, 400);
    assert.equal(posted.headers.has("location"), false);
  }
});

test("authorize redirects errors with state and exact iss for bad resource, PKCE, scope, or type", async () => {
  const { env } = makeEnv();
  const { challenge } = pkce();
  const cases = [
    [{ resource: "https://relay.example/other" }, "invalid_target"],
    [{ resource: undefined }, "invalid_target"],
    [{ resource: `${RESOURCE}/` }, "invalid_target"],
    [{ code_challenge_method: undefined }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: undefined }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ scope: "astra.read admin" }, "invalid_scope"],
    [{ scope: "" }, "invalid_scope"],
    [{ resource: [RESOURCE, RESOURCE] }, "invalid_request"],
  ];
  for (const [overrides, error] of cases) {
    const params = redirectParams(await getAuthorize(env, challenge, overrides));
    assert.equal(params.get("error"), error, JSON.stringify(overrides));
    assert.equal(params.get("state"), "state-1234");
    assert.equal(params.get("iss"), ISSUER);
    assert.equal(params.has("code"), false);
  }
});

test("a valid authorize GET renders a self-contained consent form", async () => {
  const { env } = makeEnv();
  const { challenge } = pkce();
  const response = await getAuthorize(env, challenge, { state: `<script>"x"</script>` });
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.doesNotMatch(html, /<script|<link|<img|<iframe|\ssrc=/i, "no scripts or external assets");
  assert.match(html, /&lt;script&gt;&quot;x&quot;&lt;\/script&gt;/, "state is escaped");
  assert.match(html, /name="owner_secret"/);
  assert.doesNotMatch(html, new RegExp(OWNER_SECRET));
  assert.doesNotMatch(html, new RegExp(DEVICE), "no internal device id");
});

// ---------------------------------------------------------------------------
// 3. Owner authentication and rate limiting

test("a wrong owner secret is denied without a redirect and is rate limited", async (t) => {
  const { env } = makeEnv();
  const { challenge } = pkce();
  for (let i = 0; i < OWNER_MAX_FAILURES; i += 1) {
    const response = await postAuthorize(env, challenge, { secret: `wrong-${i}-${"x".repeat(40)}` });
    assert.equal(response.status, 401);
    assert.equal(response.headers.has("location"), false);
    assert.doesNotMatch(await response.text(), /wrong-/, "the candidate is not echoed");
  }
  const locked = await postAuthorize(env, challenge);
  assert.equal(locked.status, 429, "even the correct secret is refused while locked");
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.equal(locked.headers.has("location"), false);

  const now = Date.now();
  t.mock.method(Date, "now", () => now + OWNER_WINDOW_MS + 1);
  const params = redirectParams(await postAuthorize(env, challenge));
  assert.ok(params.get("code"));
});

test("parallel owner guesses cannot exceed the failure budget", async () => {
  const { env } = makeEnv();
  const { challenge } = pkce();
  const statuses = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    postAuthorize(env, challenge, { secret: `guess-${i}-${"x".repeat(40)}` }).then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 401).length, OWNER_MAX_FAILURES);
  assert.equal(statuses.filter((s) => s === 429).length, 12 - OWNER_MAX_FAILURES);
});

test("POST revalidates hidden fields and rejects cross-origin or non-form submissions", async () => {
  const { env, storage } = makeEnv();
  const { challenge } = pkce();
  const tampered = redirectParams(await postAuthorize(env, challenge, { overrides: { resource: `${ISSUER}/other` } }));
  assert.equal(tampered.get("error"), "invalid_target");
  assert.equal(tampered.has("code"), false);

  const noPkce = redirectParams(await postAuthorize(env, challenge, { overrides: { code_challenge_method: "plain" } }));
  assert.equal(noPkce.get("error"), "invalid_request");

  const widened = await postAuthorize(env, challenge, { overrides: { scope: "astra.read" }, granted: ["astra.read", "astra.control"] });
  assert.equal(widened.status, 400, "cannot grant scopes that were not requested");

  const crossOrigin = await postAuthorize(env, challenge, { headers: { origin: "https://evil.example" } });
  assert.equal(crossOrigin.status, 403);

  const json = await worker.fetch(new Request(`${BASE}/oauth/authorize`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), env);
  assert.equal(json.status, 415);

  assert.equal([...storage.map.keys()].some((k) => k.startsWith("code:")), false, "no code was issued");

  const sameOrigin = await postAuthorize(env, challenge, { headers: { origin: ISSUER } });
  assert.ok(redirectParams(sameOrigin).get("code"));
});

test("authorization is unavailable without the owner secret configured", async () => {
  const { env } = makeEnv({ ownerSecret: "" });
  const { challenge } = pkce();
  assert.equal((await getAuthorize(env, challenge)).status, 503);
  assert.equal((await postAuthorize(env, challenge)).status, 503);
  const short = makeEnv({ ownerSecret: "too-short" });
  assert.equal((await postAuthorize(short.env, challenge, { secret: "too-short" })).status, 503);
});

// ---------------------------------------------------------------------------
// 4. Successful authorization and denial

test("successful authorization redirects with a code, the state, and the exact iss", async () => {
  const { env } = makeEnv();
  const { challenge } = pkce();
  const response = await postAuthorize(env, challenge);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const params = redirectParams(response);
  assert.match(params.get("code"), /^astra_ac_[A-Za-z0-9_-]{43}$/);
  assert.equal(params.get("state"), "state-1234");
  assert.equal(params.get("iss"), ISSUER);
  assert.deepEqual([...params.keys()].sort(), ["code", "iss", "state"]);

  const denied = redirectParams(await postAuthorize(env, challenge, { decision: "deny", secret: undefined }));
  assert.equal(denied.get("error"), "access_denied");
  assert.equal(denied.get("state"), "state-1234");
  assert.equal(denied.get("iss"), ISSUER);
  assert.equal(denied.has("code"), false);
});

// ---------------------------------------------------------------------------
// 5. Code exchange

test("the token endpoint enforces PKCE and burns a code on its first presentation", async () => {
  const { env } = makeEnv();
  const { code, verifier } = await issueCode(env);
  const wrong = await exchange(env, code, pkce().verifier);
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: "invalid_grant" });
  assert.equal((await exchange(env, code, verifier)).status, 400, "a failed attempt consumed the code");
});

test("a code is one-time; replay revokes the tokens it issued", async () => {
  const { env } = makeEnv();
  const { code, verifier, body } = await tokensFor(env);
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, ACCESS_TOKEN_TTL_MS / 1000);
  assert.equal(body.scope, ALL_SCOPES.join(" "));
  assert.match(body.access_token, /^astra_at_[A-Za-z0-9_-]{43}$/);
  assert.match(body.refresh_token, /^astra_rt_[A-Za-z0-9_-]{43}$/);
  assert.equal((await mcp(env, "tools/list", {}, body.access_token)).status, 200);

  const replay = await exchange(env, code, verifier);
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: "invalid_grant" });
  assert.equal((await mcp(env, "tools/list", {}, body.access_token)).status, 401);
  assert.equal((await refresh(env, body.refresh_token)).status, 400);
});

test("parallel exchanges of one code yield exactly one token set", async () => {
  const { env } = makeEnv();
  const { code, verifier } = await issueCode(env);
  const statuses = await Promise.all(Array.from({ length: 6 }, () => exchange(env, code, verifier).then((r) => r.status)));
  assert.deepEqual(statuses.sort(), [200, 400, 400, 400, 400, 400]);
});

test("the token endpoint binds the code to client, redirect, resource, and lifetime", async (t) => {
  const { env } = makeEnv();
  const expectations = [
    [{ redirect_uri: "https://evil.example/cb" }, 400, "invalid_grant"],
    [{ resource: `${ISSUER}/other` }, 400, "invalid_target"],
    [{ resource: undefined }, 400, "invalid_target"],
    [{ client_id: "https://evil.example/client.json" }, 401, "invalid_client"],
    [{ code_verifier: "too-short" }, 400, "invalid_request"],
  ];
  for (const [overrides, status, error] of expectations) {
    const { code, verifier } = await issueCode(env);
    const response = await exchange(env, code, verifier, overrides);
    assert.equal(response.status, status, JSON.stringify(overrides));
    assert.deepEqual(await response.json(), { error }, JSON.stringify(overrides));
  }

  const basic = await issueCode(env);
  const withBasic = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code", code: basic.code, code_verifier: basic.verifier,
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, resource: RESOURCE,
  }, { authorization: "Basic Zm9vOmJhcg==" });
  assert.equal(withBasic.status, 401, "token_endpoint_auth_method is none");

  const expired = await issueCode(env);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + CODE_TTL_MS + 1);
  assert.deepEqual(await (await exchange(env, expired.code, expired.verifier)).json(), { error: "invalid_grant" });
});

// ---------------------------------------------------------------------------
// 6. Access tokens on /mcp

test("an OAuth access token works on /mcp and every tool advertises its oauth2 scope", async () => {
  const relayCalls = [];
  const { env } = makeEnv({ relayCalls });
  const { body } = await tokensFor(env);
  const response = await mcp(env, "tools/list", {}, body.access_token);
  assert.equal(response.status, 200);
  const { tools } = (await response.json()).result;
  assert.equal(tools.length, 27);
  const scopeOf = (name) => READ_TOOLS.includes(name) ? "astra.read" : WRITE_TOOLS.includes(name) ? "astra.write" : "astra.control";
  for (const tool of tools) {
    const expected = [{ type: "oauth2", scopes: [scopeOf(tool.name)] }];
    assert.deepEqual(tool.securitySchemes, expected, tool.name);
    assert.deepEqual(tool._meta.securitySchemes, expected, tool.name);
  }
  const called = await mcp(env, "tools/call", { name: "start_process", arguments: { command: "true", idempotencyKey: "proc-0001" } }, body.access_token);
  assert.equal((await called.json()).result.content[0].text, "ran:start_process");
  assert.deepEqual(relayCalls.map((c) => c.name), [DEVICE, DEVICE], "OAuth resolves only to MCP_DEVICE_ID");
});

test("missing, wrong, expired, or wrong-audience tokens get 401 with a Bearer challenge", async (t) => {
  const relayCalls = [];
  const { env, storage } = makeEnv({ relayCalls });

  const missing = await mcp(env, "tools/list");
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"),
    `Bearer realm="astra-bridge", resource_metadata="${PRM_URL}", scope="astra.read astra.write astra.control"`);
  assert.equal(missing.headers.has("access-control-allow-origin"), false);

  for (const token of [`astra_at_${"A".repeat(43)}`, "x".repeat(64), `astra_rt_${"A".repeat(43)}`]) {
    const wrong = await mcp(env, "tools/list", {}, token);
    assert.equal(wrong.status, 401);
    const challenge = wrong.headers.get("www-authenticate");
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, /error="invalid_token"/);
    assert.match(challenge, new RegExp(`resource_metadata="${PRM_URL}"`));
    assert.match(challenge, /scope="astra.read astra.write astra.control"/);
    assert.doesNotMatch(challenge, new RegExp(token));
  }

  // A refresh token is not an access token.
  const { body } = await tokensFor(env);
  assert.equal((await mcp(env, "tools/list", {}, body.refresh_token)).status, 401);

  // Wrong audience or client in the stored grant fails closed.
  const accessKey = [...storage.map.keys()].find((k) => k.startsWith("access:"));
  const original = structuredClone(storage.map.get(accessKey));
  storage.map.set(accessKey, { ...original, resource: "https://other.example/mcp" });
  assert.equal((await mcp(env, "tools/list", {}, body.access_token)).status, 401);
  storage.map.set(accessKey, { ...original, clientId: "https://evil.example/client.json" });
  assert.equal((await mcp(env, "tools/list", {}, body.access_token)).status, 401);
  storage.map.set(accessKey, { ...original, scopes: ["astra.admin"] });
  assert.equal((await mcp(env, "tools/list", {}, body.access_token)).status, 401);
  storage.map.set(accessKey, original);
  assert.equal((await mcp(env, "tools/list", {}, body.access_token)).status, 200);

  // Removing the owner secret is a kill switch for every OAuth grant.
  const secret = env.OAUTH_OWNER_SECRET;
  delete env.OAUTH_OWNER_SECRET;
  assert.equal((await mcp(env, "tools/list", {}, body.access_token)).status, 401);
  env.OAUTH_OWNER_SECRET = secret;

  const now = Date.now();
  t.mock.method(Date, "now", () => now + ACCESS_TOKEN_TTL_MS + 1);
  const expired = await mcp(env, "tools/list", {}, body.access_token);
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get("www-authenticate"), /error="invalid_token"/);
  assert.equal(relayCalls.length, 1, "only the one fully valid tools/list call reached the relay");
});

// ---------------------------------------------------------------------------
// 7. Scopes

test("tools/list and tools/call enforce granted scopes with a tool-level challenge", async () => {
  const relayCalls = [];
  const { env } = makeEnv({ relayCalls });
  const { body } = await tokensFor(env, { granted: ["astra.read"] });
  assert.equal(body.scope, "astra.read");
  assert.deepEqual(await listedNames(env, body.access_token), [...READ_TOOLS].sort());

  relayCalls.length = 0;
  const denied = await (await mcp(env, "tools/call", {
    name: "write_file", arguments: { path: "/tmp/x", content: "secret file body", idempotencyKey: "write-0001" },
  }, body.access_token)).json();
  assert.equal(denied.result.isError, true);
  const [challenge] = denied.result._meta["mcp/www_authenticate"];
  assert.equal(challenge,
    `Bearer realm="astra-bridge", error="insufficient_scope", error_description="The astra.write scope is required", resource_metadata="${PRM_URL}", scope="astra.read astra.write"`);
  assert.doesNotMatch(JSON.stringify(denied), /secret file body|\/tmp\/x|astra_at_/);
  assert.equal(relayCalls.length, 0, "denied calls never reach the relay");

  const control = await (await mcp(env, "tools/call", { name: "job_logs", arguments: { jobId: "j1" } }, body.access_token)).json();
  assert.match(control.result._meta["mcp/www_authenticate"][0], /scope="astra.read astra.control"/);

  const allowed = await (await mcp(env, "tools/call", { name: "read_file", arguments: { path: "/tmp/x" } }, body.access_token)).json();
  assert.equal(allowed.result.content[0].text, "ran:read_file");

  const writeOnly = await tokensFor(env, { scope: "astra.write", granted: ["astra.write"] });
  assert.deepEqual(await listedNames(env, writeOnly.body.access_token), [...WRITE_TOOLS].sort());

  const controlOnly = await tokensFor(env, { scope: "astra.control", granted: ["astra.control"] });
  assert.deepEqual(await listedNames(env, controlOnly.body.access_token), [...CONTROL_TOOLS].sort());
});

test("refresh may narrow but never widen scopes", async () => {
  const { env } = makeEnv();
  const { body } = await tokensFor(env, { scope: "astra.read astra.write", granted: ["astra.read", "astra.write"] });
  const wider = await refresh(env, body.refresh_token, { scope: "astra.read astra.control" });
  assert.deepEqual(await wider.json(), { error: "invalid_scope" });

  const narrowed = await (await refresh(env, body.refresh_token, { scope: "astra.read" })).json();
  assert.equal(narrowed.scope, "astra.read");
  assert.deepEqual(await listedNames(env, narrowed.access_token), [...READ_TOOLS].sort());
  // The rotated refresh token keeps the original grant (RFC 6749 §6).
  const again = await (await refresh(env, narrowed.refresh_token)).json();
  assert.equal(again.scope, "astra.read astra.write");
});

// ---------------------------------------------------------------------------
// 8. Refresh rotation and expiry

test("refresh rotates tokens; reusing a rotated token revokes the family", async () => {
  const { env } = makeEnv();
  const { body: first } = await tokensFor(env);
  const second = await (await refresh(env, first.refresh_token)).json();
  assert.notEqual(second.access_token, first.access_token);
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal((await mcp(env, "tools/list", {}, second.access_token)).status, 200);

  const reuse = await refresh(env, first.refresh_token);
  assert.equal(reuse.status, 400);
  assert.deepEqual(await reuse.json(), { error: "invalid_grant" });
  assert.equal((await mcp(env, "tools/list", {}, second.access_token)).status, 401, "family revoked");
  assert.equal((await refresh(env, second.refresh_token)).status, 400, "family revoked");
});

test("refresh validates client and resource and expires 30 days after authorization", async (t) => {
  const { env } = makeEnv();
  const { body } = await tokensFor(env);
  assert.equal((await refresh(env, body.refresh_token, { client_id: "https://evil.example/c.json" })).status, 401);
  assert.deepEqual(await (await refresh(env, body.refresh_token, { resource: `${ISSUER}/other` })).json(), { error: "invalid_target" });
  // resource is optional on refresh; the stored binding still applies.
  const rotated = await (await refresh(env, body.refresh_token, { resource: undefined })).json();
  assert.ok(rotated.access_token);

  const start = Date.now();
  t.mock.method(Date, "now", () => start + REFRESH_TOKEN_TTL_MS - 30 * 60_000);
  const late = await (await refresh(env, rotated.refresh_token)).json();
  assert.ok(late.expires_in <= 30 * 60, "access tokens never outlive the grant");

  Date.now.mock.mockImplementation(() => start + REFRESH_TOKEN_TTL_MS + 1);
  assert.deepEqual(await (await refresh(env, late.refresh_token)).json(), { error: "invalid_grant" });
  assert.equal((await mcp(env, "tools/list", {}, late.access_token)).status, 401);
});

test("the token endpoint rejects malformed and unsupported requests", async () => {
  const { env } = makeEnv();
  const cases = [
    [{ grant_type: "client_credentials", client_id: CLIENT_ID }, 400, "unsupported_grant_type"],
    [{ grant_type: "password", client_id: CLIENT_ID, username: "a", password: "b" }, 400, "unsupported_grant_type"],
    [{ client_id: CLIENT_ID }, 400, "invalid_request"],
    [{ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: "not-a-token" }, 400, "invalid_grant"],
    [{ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: "x", client_secret: "s" }, 401, "invalid_client"],
  ];
  for (const [form, status, error] of cases) {
    const response = await postForm(env, "/oauth/token", form);
    assert.equal(response.status, status, JSON.stringify(form));
    assert.deepEqual(await response.json(), { error });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const duplicate = new URLSearchParams([["grant_type", "refresh_token"], ["grant_type", "authorization_code"], ["client_id", CLIENT_ID]]);
  assert.equal((await postForm(env, "/oauth/token", duplicate)).status, 400);
  const json = await worker.fetch(new Request(`${BASE}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), env);
  assert.deepEqual(await json.json(), { error: "invalid_request" });
  const oversized = await postForm(env, "/oauth/token", { client_id: CLIENT_ID, pad: "x".repeat(9 * 1024) });
  assert.equal(oversized.status, 413);
});

// ---------------------------------------------------------------------------
// 9. Operator bearer

test("the static operator bearer still works exactly and bypasses OAuth storage", async () => {
  const relayCalls = [];
  const { env, storeNames } = makeEnv({ relayCalls });
  assert.equal((await listedNames(env, OPERATOR_TOKEN)).length, 27);
  const called = await (await mcp(env, "tools/call", {
    name: "start_process", arguments: { command: "true", idempotencyKey: "proc-0001" },
  }, OPERATOR_TOKEN)).json();
  assert.equal(called.result.content[0].text, "ran:start_process");
  assert.deepEqual(storeNames, [], "the operator path never touches OAuthStore");

  // Unchanged when OAuth is entirely unconfigured.
  const bare = makeEnv({ relayCalls });
  for (const key of ["OAUTH_ISSUER", "OAUTH_RESOURCE", "OAUTH_OWNER_SECRET", "OAUTH_STORE"]) delete bare.env[key];
  assert.equal((await listedNames(bare.env, OPERATOR_TOKEN)).length, 27);
  const missing = await mcp(bare.env, "tools/list");
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), `Bearer realm="astra-bridge", scope="astra.read astra.write astra.control"`);

  // A near-miss operator token is not accepted, and is not tried against OAuth.
  assert.equal((await mcp(env, "tools/list", {}, `${OPERATOR_TOKEN}x`)).status, 401);
  assert.deepEqual(storeNames, []);
});

// ---------------------------------------------------------------------------
// 10. Storage and response hygiene

test("stored records, responses, and logs never contain secrets, codes, or tokens", async (t) => {
  const logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    t.mock.method(console, method, (...args) => { logged.push(args); });
  }
  const { env, storage } = makeEnv();
  const { verifier, challenge } = pkce();
  const responses = [];
  const keep = async (response) => {
    responses.push({ status: response.status, headers: [...response.headers], body: await response.clone().text() });
    return response;
  };

  await keep(await postAuthorize(env, challenge, { secret: `wrong-${"y".repeat(40)}` }));
  const params = redirectParams(await keep(await postAuthorize(env, challenge)));
  const code = params.get("code");
  const tokens = await (await keep(await exchange(env, code, verifier))).json();
  await keep(await exchange(env, code, verifier));
  const rotated = await (await keep(await refresh(env, tokens.refresh_token))).json();
  await keep(await refresh(env, tokens.refresh_token));
  await keep(await mcp(env, "tools/list", {}, rotated.access_token));
  await keep(await mcp(env, "tools/call", {
    name: "write_file", arguments: { path: "/private/file", content: "file contents", idempotencyKey: "write-0001" },
  }, rotated.access_token));

  const secrets = [OWNER_SECRET, code, verifier, tokens.access_token, tokens.refresh_token, rotated.access_token, rotated.refresh_token];
  const stored = JSON.stringify([...storage.map]);
  for (const secret of secrets) assert.equal(stored.includes(secret), false, "plaintext in storage");
  for (const key of storage.map.keys()) {
    assert.match(key, /^(?:(code|access|refresh):[a-f0-9]{64}|family:[0-9a-f-]{36}|owner-auth|cleanup-cursor:.*)$/, key);
  }
  for (const record of storage.map.values()) {
    assert.equal(JSON.stringify(record).includes("wrong-"), false, "failed candidates are not stored");
  }

  // Error responses never echo a secret; success responses carry only what the flow requires.
  const errorBodies = JSON.stringify(responses.filter((r) => r.status >= 400));
  for (const secret of secrets) assert.equal(errorBodies.includes(secret), false, "secret in an error response");
  assert.equal(JSON.stringify(responses).includes(OWNER_SECRET), false);
  assert.equal(JSON.stringify(responses).includes(verifier), false);
  assert.deepEqual(logged, [], "nothing was logged");
});

// ---------------------------------------------------------------------------
// 11. CORS and methods

test("no endpoint emits CORS headers and unsafe methods are rejected", async () => {
  const { env } = makeEnv();
  const paths = [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/oauth/authorize",
    "/oauth/token",
  ];
  for (const path of paths) {
    for (const method of ["OPTIONS", "PUT", "DELETE", "PATCH"]) {
      const response = await worker.fetch(new Request(`${BASE}${path}`, {
        method, headers: { origin: "https://chatgpt.com", "access-control-request-method": "POST" },
      }), env);
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.ok(response.headers.get("allow"));
      for (const [name] of response.headers) assert.doesNotMatch(name, /^access-control-/i, `${method} ${path}`);
    }
    const get = await worker.fetch(new Request(`${BASE}${path}`, { headers: { origin: "https://evil.example" } }), env);
    for (const [name] of get.headers) assert.doesNotMatch(name, /^access-control-/i, `GET ${path}`);
  }
  assert.equal((await worker.fetch(new Request(`${BASE}/oauth/token`), env)).status, 405);
  assert.equal((await worker.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`, { method: "POST" }), env)).status, 405);
  assert.equal((await worker.fetch(new Request(`${BASE}/oauth/register`, { method: "POST" }), env)).status, 404, "no DCR");
  const preflight = await worker.fetch(new Request(`${BASE}/mcp`, { method: "OPTIONS", headers: { origin: "https://evil.example" } }), env);
  assert.equal(preflight.status, 401);
  for (const [name] of preflight.headers) assert.doesNotMatch(name, /^access-control-/i);
});

// ---------------------------------------------------------------------------
// Store bounds

test("expired records are cleaned up in bounded batches and live grants are capped", async (t) => {
  const { env, storage, store } = makeEnv();
  const start = Date.now();
  // Seed more expired records than one batch, plus one live family.
  for (let i = 0; i < CLEANUP_BATCH + 20; i += 1) {
    storage.map.set(`access:${i.toString(16).padStart(64, "0")}`, { expiresAt: start - 1 });
  }
  const { body } = await tokensFor(env);
  assert.notEqual(storage.alarm, null);

  t.mock.method(Date, "now", () => start + 1);
  await store.alarm();
  assert.equal(storage.alarm, start + 1 + 1_000, "a full batch schedules a quick follow-up");
  await store.alarm();
  const expiredLeft = [...storage.map].filter(([k, v]) => k.startsWith("access:") && v.expiresAt <= start);
  assert.equal(expiredLeft.length, 0);
  assert.equal((await mcp(env, "tools/list", {}, body.access_token)).status, 200, "live records survive");
  assert.equal(storage.alarm, start + 1 + 10 * 60_000, "live records keep a periodic alarm");

  Date.now.mock.mockImplementation(() => start + REFRESH_TOKEN_TTL_MS + 60_000);
  await store.alarm();
  await store.alarm();
  assert.deepEqual([...storage.map.keys()].filter((k) => /^(code|access|refresh|family):/.test(k)), []);

  Date.now.mock.mockImplementation(() => start);
  const first = await tokensFor(env);
  for (let i = 1; i < MAX_TOKEN_FAMILIES; i += 1) {
    Date.now.mock.mockImplementation(() => start + i);
    await tokensFor(env);
  }
  assert.equal((await mcp(env, "tools/list", {}, first.body.access_token)).status, 200);
  Date.now.mock.mockImplementation(() => start + MAX_TOKEN_FAMILIES);
  await tokensFor(env);
  assert.equal([...storage.map.keys()].filter((k) => k.startsWith("family:")).length, MAX_TOKEN_FAMILIES);
  assert.equal((await mcp(env, "tools/list", {}, first.body.access_token)).status, 401, "oldest grant evicted");
});

// ---------------------------------------------------------------------------
// 12. Cloudflare build

test("wrangler deploy --dry-run bundles the Worker with the OAuthStore export", () => {
  const outdir = ".test-tmp/oauth-dry-run";
  const result = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", outdir], {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /env\.OAUTH_STORE \(OAuthStore\)/);
  assert.doesNotMatch(result.stdout, /OAUTH_OWNER_SECRET/);
  const bundle = readFileSync(`${outdir}/index.js`, "utf8");
  assert.match(bundle, /OAuthStore = class extends DurableObject|class OAuthStore extends DurableObject/);
  assert.match(bundle, /export \{[^}]*\bOAuthStore\b[^}]*\}/);
});
