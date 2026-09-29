import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../.test-tmp/index.mjs";
import {
  accessConfig,
  authenticateAccessRequest,
  mcpAuthMode,
  verifyAccessJwt,
} from "../.test-tmp/access-auth.mjs";

const TEAM = "https://astra-owner.cloudflareaccess.com";
const CERTS_URL = `${TEAM}/cdn-cgi/access/certs`;
const AUD = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
const OWNER = "owner@example.com";
const OPERATOR_TOKEN = "operator-bearer-token-which-is-long-enough-for-the-check";
const DEVICE = "test-device";
const KID = "access-test-key-1";
const TOOL_NAMES = [
  "get_config", "read_file", "read_multiple_files", "write_file", "create_directory",
  "list_directory", "move_file", "get_file_info", "start_search", "get_more_search_results",
  "stop_search", "list_searches", "edit_block", "start_process", "read_process_output",
  "interact_with_process", "force_terminate", "list_sessions", "list_processes", "kill_process",
  "get_recent_tool_calls", "get_usage_stats", "job_start", "job_status", "job_list",
  "job_logs", "job_cancel",
];
const GATED = new Set([
  "create_directory", "write_file", "edit_block", "move_file", "start_process",
  "interact_with_process", "force_terminate", "kill_process", "job_start",
]);
const DOWNSTREAM_TOOLS = TOOL_NAMES.map((name) => ({
  name,
  description: `tool ${name}`,
  inputSchema: { type: "object", properties: GATED.has(name) ? { idempotencyKey: { type: "string" } } : {} },
}));

// ---------------------------------------------------------------------------
// Local signing keys and a mock JWKS endpoint. The Worker path uses the real
// createRemoteJWKSet; only the network is replaced.

let teamKey;
let attackerKey;
let jwks;
const jwksFetches = [];
const realFetch = globalThis.fetch;

before(async () => {
  teamKey = await generateKeyPair("RS256");
  attackerKey = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(teamKey.publicKey)), kid: KID, alg: "RS256", use: "sig" }] };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    jwksFetches.push(url);
    if (url === CERTS_URL) return Response.json(jwks);
    return new Response("unavailable", { status: 503 });
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

async function accessJwt({
  key = teamKey.privateKey,
  kid = KID,
  alg = "RS256",
  issuer = TEAM,
  audience = [AUD],
  email = OWNER,
  subject = "00000000-0000-4000-8000-000000000001",
  expiresIn = "10m",
  issuedAt,
} = {}) {
  const claims = { type: "app", identity_nonce: "nonce-1234" };
  if (email !== null) claims.email = email;
  let jwt = new SignJWT(claims).setProtectedHeader({ alg, kid });
  if (issuer !== null) jwt = jwt.setIssuer(issuer);
  if (audience !== null) jwt = jwt.setAudience(audience);
  if (subject !== null) jwt = jwt.setSubject(subject);
  jwt = jwt.setIssuedAt(issuedAt).setNotBefore(issuedAt ?? "0s").setExpirationTime(expiresIn);
  return jwt.sign(key);
}

function accessEnv(overrides = {}) {
  const relayCalls = [];
  const storeCalls = [];
  const doFetches = [];
  const env = {
    AGENT_PUBLIC_KEY_B64: "",
    CLIENT_PUBLIC_KEY_B64: "",
    AGENT_DEVICE_ID: DEVICE,
    CLIENT_DEVICE_ID: DEVICE,
    MCP_DEVICE_ID: DEVICE,
    MCP_BEARER_TOKEN: OPERATOR_TOKEN,
    OAUTH_ISSUER: "https://relay.example",
    OAUTH_RESOURCE: "https://relay.example/mcp",
    OAUTH_OWNER_SECRET: "owner-secret-for-tests-" + "s".repeat(40),
    // Any OAuthStore use would mean the Worker's own OAuth tokens were consulted.
    OAUTH_STORE: { getByName: (name) => { storeCalls.push(name); throw new Error("OAuthStore must not be used"); } },
    MCP_AUTH_MODE: "access",
    TEAM_DOMAIN: TEAM,
    POLICY_AUD: AUD,
    DEVICE_RELAY: {
      getByName: (name) => ({
        mcpRpc: async (payload) => {
          relayCalls.push({ name, payload });
          if (payload.action === "tools/list") return { ok: true, result: { tools: DOWNSTREAM_TOOLS } };
          return { ok: true, result: { content: [{ type: "text", text: `ran:${payload.name}` }] } };
        },
      }),
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (request) => {
          doFetches.push({ name: id.name, path: new URL(request.url).pathname });
          return Response.json({ ok: true, agentConnected: false });
        },
      }),
    },
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete env[key];
  return { env, relayCalls, storeCalls, doFetches };
}

let rpcId = 0;
function mcp(env, method, { jwt, bearer, params = {} } = {}) {
  rpcId += 1;
  return worker.fetch(new Request("https://relay.example/mcp", {
    method: "POST",
    headers: {
      ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  }), env);
}

async function assertUnauthorized(response) {
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), null, "the origin is not the authorization server");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized" }, id: null,
  });
}

// ---------------------------------------------------------------------------
// Config

test("auth mode defaults to static and fails closed on unknown values", () => {
  assert.equal(mcpAuthMode({}), "static");
  assert.equal(mcpAuthMode({ MCP_AUTH_MODE: "" }), "static");
  assert.equal(mcpAuthMode({ MCP_AUTH_MODE: "static" }), "static");
  assert.equal(mcpAuthMode({ MCP_AUTH_MODE: " Access " }), "access");
  assert.equal(mcpAuthMode({ MCP_AUTH_MODE: "acess" }), null);
  assert.equal(mcpAuthMode({ MCP_AUTH_MODE: "none" }), null);
  // TEAM_DOMAIN alone never switches modes.
  assert.equal(mcpAuthMode({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD }), "static");
});

test("template wrangler.jsonc selects Access mode and fails closed until configured", () => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const { vars } = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(vars.MCP_AUTH_MODE, "access");
  assert.equal(mcpAuthMode(vars), "access");
  // Placeholder TEAM_DOMAIN / POLICY_AUD must be rejected, so an unconfigured deploy
  // answers /mcp with 503 instead of accepting anything.
  assert.equal(accessConfig(vars), null);
});

test("Access config accepts only a bare cloudflareaccess.com team origin and a plausible AUD", () => {
  const expected = { issuer: TEAM, audience: AUD, certsUrl: CERTS_URL, allowedEmails: null };
  assert.deepEqual(accessConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD }), expected);
  assert.deepEqual(accessConfig({ TEAM_DOMAIN: "astra-owner.cloudflareaccess.com", POLICY_AUD: AUD }), expected);
  assert.deepEqual(accessConfig({ TEAM_DOMAIN: `${TEAM}/`, POLICY_AUD: ` ${AUD} ` }), expected);

  for (const TEAM_DOMAIN of [
    undefined, "", "http://astra-owner.cloudflareaccess.com", `${TEAM}/cdn-cgi`, `${TEAM}?x=1`,
    "https://astra-owner.cloudflareaccess.com.evil.example", "https://evil.example",
    "https://user@astra-owner.cloudflareaccess.com", `${TEAM}:8443`, "https://cloudflareaccess.com",
  ]) {
    assert.equal(accessConfig({ TEAM_DOMAIN, POLICY_AUD: AUD }), null, String(TEAM_DOMAIN));
  }
  for (const POLICY_AUD of [undefined, "", "REPLACE_ME", "a".repeat(31), `${AUD}!`]) {
    assert.equal(accessConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD }), null, String(POLICY_AUD));
  }

  const allow = accessConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ACCESS_ALLOWED_EMAILS: " Owner@Example.com , " });
  assert.deepEqual([...allow.allowedEmails], [OWNER]);
  assert.equal(accessConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ACCESS_ALLOWED_EMAILS: " , " }), null);
});

// ---------------------------------------------------------------------------
// Verifier with an injected local JWKS

test("verifyAccessJwt accepts a valid owner assertion from a local JWKS", async () => {
  const config = accessConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD });
  const keys = createLocalJWKSet(jwks);
  assert.deepEqual(await verifyAccessJwt(await accessJwt(), config, keys), {
    email: OWNER, subject: "00000000-0000-4000-8000-000000000001",
  });
  // A single-string aud is equally valid.
  assert.ok(await verifyAccessJwt(await accessJwt({ audience: AUD }), config, keys));
});

test("verifyAccessJwt rejects wrong audience, issuer, key, algorithm, lifetime, and identity", async () => {
  const config = accessConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD });
  const keys = createLocalJWKSet(jwks);
  const hmac = new TextEncoder().encode("s".repeat(64));
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    "wrong aud": await accessJwt({ audience: ["b".repeat(64)] }),
    "missing aud": await accessJwt({ audience: null }),
    "wrong issuer": await accessJwt({ issuer: "https://other-team.cloudflareaccess.com" }),
    "missing issuer": await accessJwt({ issuer: null }),
    "unknown key": await accessJwt({ key: attackerKey.privateKey, kid: "attacker" }),
    "known kid, wrong key": await accessJwt({ key: attackerKey.privateKey }),
    "HS256": await accessJwt({ key: hmac, alg: "HS256" }),
    "expired": await accessJwt({ issuedAt: now - 3600, expiresIn: now - 600 }),
    "service token (no email)": await accessJwt({ email: null }),
    "empty email": await accessJwt({ email: "" }),
    "missing sub": await accessJwt({ subject: null }),
    "garbage": "not.a.jwt",
    "empty": "",
    "oversized": "a".repeat(9000),
  };
  for (const [name, token] of Object.entries(cases)) {
    assert.equal(await verifyAccessJwt(token, config, keys), null, name);
  }

  const allowlisted = accessConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ACCESS_ALLOWED_EMAILS: "someone@else.example" });
  assert.equal(await verifyAccessJwt(await accessJwt(), allowlisted, keys), null, "email outside allowlist");
});

test("authenticateAccessRequest reads only Cf-Access-Jwt-Assertion, never Authorization", async () => {
  const config = accessConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD });
  const keys = createLocalJWKSet(jwks);
  const jwt = await accessJwt();
  const req = (headers) => new Request("https://relay.example/mcp", { method: "POST", headers });

  const principal = await authenticateAccessRequest(req({ "cf-access-jwt-assertion": jwt }), config, DEVICE, keys);
  assert.equal(principal.kind, "access");
  assert.equal(principal.deviceId, DEVICE);
  assert.deepEqual([...principal.scopes], ["astra.read", "astra.write", "astra.control"]);

  assert.equal(await authenticateAccessRequest(req({ authorization: `Bearer ${jwt}` }), config, DEVICE, keys), null);
  assert.equal(await authenticateAccessRequest(req({ "cf-access-authenticated-user-email": OWNER }), config, DEVICE, keys), null);
  assert.equal(await authenticateAccessRequest(req({ cookie: `CF_Authorization=${jwt}` }), config, DEVICE, keys), null);
  assert.equal(await authenticateAccessRequest(req({ "cf-access-jwt-assertion": jwt }), config, undefined, keys), null);
});

// ---------------------------------------------------------------------------
// Worker: static mode unchanged

test("static mode (MCP_AUTH_MODE unset) keeps the operator bearer and ignores Access assertions", async () => {
  const { env, relayCalls } = accessEnv({ MCP_AUTH_MODE: undefined, OAUTH_STORE: undefined });
  const listed = await mcp(env, "tools/list", { bearer: OPERATOR_TOKEN });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).result.tools.length, 27);

  const missing = await mcp(env, "tools/list");
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate"), /^Bearer realm="astra-bridge"/);

  // A valid Access assertion is not a credential in static mode.
  const fetchesBefore = jwksFetches.length;
  assert.equal((await mcp(env, "tools/list", { jwt: await accessJwt() })).status, 401);
  assert.equal(jwksFetches.length, fetchesBefore, "static mode never contacts the Access JWKS");
  assert.equal(relayCalls.length, 1);

  // The Worker's own OAuth metadata is still served in static mode.
  const metadata = await worker.fetch(new Request("https://relay.example/.well-known/oauth-authorization-server"), env);
  assert.equal(metadata.status, 200);
});

// ---------------------------------------------------------------------------
// Worker: Access mode

test("Access mode accepts a valid assertion, verified through the team JWKS URL", async () => {
  const { env, relayCalls } = accessEnv();
  const jwt = await accessJwt();
  const listed = await mcp(env, "tools/list", { jwt });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).result.tools.length, 27);
  assert.ok(jwksFetches.includes(CERTS_URL));
  assert.ok(jwksFetches.every((url) => url === CERTS_URL));

  const called = await (await mcp(env, "tools/call", {
    jwt, params: { name: "start_process", arguments: { command: "true", idempotencyKey: "proc-0001" } },
  })).json();
  assert.equal(called.result.content[0].text, "ran:start_process");
  assert.deepEqual(relayCalls.map((call) => call.name), [DEVICE, DEVICE]);

  // Access may forward the client's own Authorization header; it is ignored, not rejected.
  assert.equal((await mcp(env, "tools/list", { jwt, bearer: "x".repeat(40) })).status, 200);
});

test("Access mode rejects missing, malformed, wrong-aud, wrong-issuer, and forged assertions", async () => {
  const { env, relayCalls } = accessEnv();
  const now = Math.floor(Date.now() / 1000);
  await assertUnauthorized(await mcp(env, "tools/list"));
  for (const jwt of [
    "not.a.jwt",
    await accessJwt({ audience: ["b".repeat(64)] }),
    await accessJwt({ issuer: "https://other-team.cloudflareaccess.com" }),
    await accessJwt({ key: attackerKey.privateKey }),
    await accessJwt({ key: attackerKey.privateKey, kid: "attacker" }),
    await accessJwt({ issuedAt: now - 3600, expiresIn: now - 600 }),
    await accessJwt({ email: null }),
  ]) {
    await assertUnauthorized(await mcp(env, "tools/list", { jwt }));
  }
  assert.equal(relayCalls.length, 0);
});

test("Access mode never falls back to the static bearer or the Worker's own OAuth", async () => {
  const { env, relayCalls, storeCalls } = accessEnv();
  await assertUnauthorized(await mcp(env, "tools/list", { bearer: OPERATOR_TOKEN }));
  await assertUnauthorized(await mcp(env, "tools/list", { bearer: OPERATOR_TOKEN, jwt: "not.a.jwt" }));
  await assertUnauthorized(await mcp(env, "tools/list", { bearer: `astra_at_${"A".repeat(43)}` }));
  // A valid Access JWT presented as a bearer is still not the assertion header.
  await assertUnauthorized(await mcp(env, "tools/list", { bearer: await accessJwt() }));
  assert.equal(relayCalls.length, 0);
  assert.deepEqual(storeCalls, []);

  // The owner-secret OAuth server is switched off in Access mode.
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/oauth/authorize",
  ]) {
    assert.equal((await worker.fetch(new Request(`https://relay.example${path}`), env)).status, 404, path);
  }
  const token = await worker.fetch(new Request("https://relay.example/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token&refresh_token=x",
  }), env);
  assert.equal(token.status, 404);
  assert.deepEqual(storeCalls, []);
});

test("Access mode fails closed on missing config, an unknown mode, or an unreachable JWKS", async () => {
  const jwt = await accessJwt();
  for (const overrides of [
    { TEAM_DOMAIN: undefined },
    { POLICY_AUD: undefined },
    { TEAM_DOMAIN: "https://evil.example" },
    { POLICY_AUD: "REPLACE_WITH_AUD" },
    { MCP_AUTH_MODE: "acess" },
  ]) {
    const { env, relayCalls, storeCalls } = accessEnv(overrides);
    for (const credentials of [{ jwt }, { bearer: OPERATOR_TOKEN }]) {
      const response = await mcp(env, "tools/list", credentials);
      assert.equal(response.status, 503, JSON.stringify(overrides));
      assert.deepEqual(await response.json(), { error: "service_unavailable" });
    }
    assert.equal(relayCalls.length, 0);
    assert.deepEqual(storeCalls, []);
  }

  // Unknown mode also disables the Worker's own OAuth routes.
  const { env: typo } = accessEnv({ MCP_AUTH_MODE: "acess" });
  assert.equal((await worker.fetch(new Request("https://relay.example/.well-known/oauth-authorization-server"), typo)).status, 404);

  // A team whose JWKS cannot be fetched rejects without leaking the failure.
  const downTeam = "https://down-team.cloudflareaccess.com";
  const { env, relayCalls } = accessEnv({ TEAM_DOMAIN: downTeam });
  await assertUnauthorized(await mcp(env, "tools/list", { jwt: await accessJwt({ issuer: downTeam }) }));
  assert.ok(jwksFetches.includes(`${downTeam}/cdn-cgi/access/certs`));
  assert.equal(relayCalls.length, 0);
});

test("Access mode leaves health and signed agent RPC unchanged", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const { env, doFetches } = accessEnv({ CLIENT_PUBLIC_KEY_B64: publicB64, AGENT_PUBLIC_KEY_B64: publicB64 });

  const health = await worker.fetch(new Request("https://relay.example/healthz"), env);
  assert.deepEqual(await health.json(), { ok: true, service: "astra-bridge-relay" });

  const path = `/v1/device/${DEVICE}/status`;
  assert.equal((await worker.fetch(new Request(`https://relay.example${path}`), env)).status, 401);
  // No Access assertion is needed or consulted on the signed path.
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  const signature = sign(null, Buffer.from([timestamp, nonce, "GET", path, hash].join("\n")), privateKey).toString("base64");
  const status = await worker.fetch(new Request(`https://relay.example${path}`, {
    headers: { "x-astra-timestamp": timestamp, "x-astra-nonce": nonce, "x-astra-signature": signature },
  }), env);
  assert.equal(status.status, 200);
  assert.deepEqual(doFetches, [{ name: DEVICE, path }]);
});
