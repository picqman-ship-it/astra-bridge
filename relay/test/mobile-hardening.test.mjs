import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import worker from '../.test-tmp/index.mjs';
import { sqliteRegistry } from './enrollment-sqlite.mjs';
import { createPairingSession, claimPairingSession, pairingStatus, PAIR_TTL_MS } from '../.test-tmp/pairing.mjs';
import { signPairStart } from '../../installer/lib/account-pairing.mjs';
const ORIGIN = 'https://relay.example';
const TEAM = 'https://mobile-hardening.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const PERSONAL = 'personal-mac';
const DEVICE = 'beta-11111111-2222-4333-8444-555555555555';
const SECOND = 'beta-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = 1800000000000;
const identity = { issuer: TEAM, subject: 'alice-subject', email: 'alice@example.com' };
const rateNames = ['BETA_ENROLL_RATE', 'BETA_REQUEST_RATE', 'BETA_MCP_RATE', 'BETA_ENROLL_GLOBAL_RATE', 'BETA_AGENT_GLOBAL_RATE', 'BETA_MCP_GLOBAL_RATE'];
let signingKey;
const realFetch = globalThis.fetch;
before(async () => {
  const keys = await generateKeyPair('RS256'); signingKey = keys.privateKey;
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'mobile-audit', alg: 'RS256', use: 'sig' };
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, TEAM + '/cdn-cgi/access/certs');
    return Response.json({ keys: [jwk] });
  };
});
after(() => { globalThis.fetch = realFetch; });
async function jwt(subject = 'alice-subject') {
  return new SignJWT({ email: 'alice@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'mobile-audit' })
    .setIssuer(TEAM).setAudience(AUD).setSubject(subject).setIssuedAt().setExpirationTime('10m').sign(signingKey);
}
function fixture(t, overrides = {}, registryOverride) {
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  const key = generateKeyPairSync('ed25519');
  const pub = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  db.prepare("INSERT INTO users VALUES ('alice', 'Alice', 'active', '2026-01-01')").run();
  db.prepare("INSERT INTO devices VALUES (?, 'alice', ?, 'active', 0, '2026-01-01', NULL)").run(DEVICE, pub);
  db.prepare("INSERT INTO user_identities (issuer,subject,owner_id,status,created_at) VALUES (?,?,'alice','active','2026-01-01')").run(TEAM, 'alice-subject');
  const calls = []; const rates = [];
  const env = {
    MCP_AUTH_MODE: 'access', ACCESS_DEVICE_ROUTING: 'registry', TEAM_DOMAIN: TEAM, POLICY_AUD: AUD,
    BETA_REGISTRY_ENABLED: 'true', BETA_REGISTRY: registryOverride ?? registry,
    MCP_DEVICE_ID: PERSONAL, AGENT_DEVICE_ID: PERSONAL, CLIENT_DEVICE_ID: PERSONAL,
    MCP_BEARER_TOKEN: 'operator-test-token-'.repeat(3),
    ...Object.fromEntries(rateNames.map(name => [name, { limit: async ({ key }) => { rates.push({ name, key }); return { success: true }; } }])),
    DEVICE_RELAY: { getByName: deviceId => ({ mcpRpc: async payload => {
      calls.push({ deviceId, payload });
      const tools = ['read_file', 'write_file', 'start_process'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { path: { type: 'string' }, idempotencyKey: { type: 'string' } } } }));
      return { ok: true, result: payload.action === 'tools/list' ? { tools } : { content: [{ type: 'text', text: 'synthetic test only' }] } };
    } }) }, ...overrides,
  };
  return { db, registry, env, calls, rates };
}
async function request(env, options = {}) {
  const { method = 'tools/list', params = {}, token = await jwt(), bearer, query = '', ctx } = options;
  return worker.fetch(new Request(ORIGIN + '/mcp' + query, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'cf-access-jwt-assertion': token, ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), env, ctx);
}
for (const routing of ['regsitry', '', 'off', 'REGISTRY ']) {
  if (routing === 'REGISTRY ') continue; // Existing deliberate normalization remains supported.
  test(`unknown routing '${routing}' cannot fall back to the personal Mac`, async t => {
    const { env, calls } = fixture(t, { ACCESS_DEVICE_ROUTING: routing });
    assert.equal((await request(env)).status, 503); assert.equal(calls.length, 0);
  });
}
test('registry routing cannot fall back to a personal bearer in static mode', async t => {
  const { env, calls } = fixture(t, { MCP_AUTH_MODE: 'static' });
  assert.equal((await request(env, { bearer: env.MCP_BEARER_TOKEN })).status, 503);
  assert.equal(calls.length, 0);
});
test('registry routing requires rate gates before any registry read', async t => {
  let queries = 0;
  const { env, calls } = fixture(t, { BETA_MCP_RATE: undefined }, { prepare() { queries++; throw new Error('must not query'); } });
  assert.equal((await request(env)).status, 503); assert.equal(queries, 0); assert.equal(calls.length, 0);
});
test('registry routing honours a rejected pre-authentication rate gate', async t => {
  const { env, calls } = fixture(t, { BETA_MCP_RATE: { limit: async () => ({ success: false }) } });
  assert.equal((await request(env)).status, 429); assert.equal(calls.length, 0);
});
test('registry failure is a redacted 503 rather than an uncaught exception', async t => {
  const { env, calls } = fixture(t, {}, { prepare() { throw new Error('PRIVATE-DATABASE-DETAIL'); } });
  const response = await request(env);
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE-DATABASE-DETAIL/); assert.equal(calls.length, 0);
});
test('verified identity ignores caller target hints and never obtains file-only control tools', async t => {
  const { env, calls } = fixture(t);
  const listed = await request(env, { query: '?deviceId=' + SECOND });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).result.tools.map(t => t.name).sort(), ['read_file', 'write_file']);
  assert.equal(calls[0].deviceId, DEVICE);
  const denied = await request(env, { method: 'tools/call', params: { name: 'start_process', arguments: { command: 'true', idempotencyKey: 'test-should-not-run' } } });
  assert.equal((await denied.json()).result.isError, true); assert.equal(calls.length, 1);
});
test('identity, user and device revocation are rechecked on every authenticated request', async t => {
  const { db, env, calls } = fixture(t);
  assert.equal((await request(env)).status, 200);
  for (const table of ['user_identities', 'users', 'devices']) {
    db.exec(`UPDATE ${table} SET status='revoked'`);
    assert.equal((await request(env)).status, 401, table); assert.equal(calls.length, 1);
    db.exec(`UPDATE ${table} SET status='active'`);
  }
  assert.equal((await request(env, { token: await jwt('unregistered') })).status, 401);
});
test('registry tool audit contains metadata, not user arguments or results', async t => {
  const { db, env } = fixture(t); const pending = [];
  const response = await request(env, { method: 'tools/call', params: { name: 'read_file', arguments: { path: '/do-not-store-private-path' } }, ctx: { waitUntil: p => pending.push(p) } });
  assert.equal(response.status, 200); await Promise.all(pending);
  const rows = db.prepare('SELECT * FROM audit_events').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].device_id, DEVICE); assert.equal(rows[0].outcome, 'succeeded');
  assert.doesNotMatch(JSON.stringify(rows), /do-not-store-private-path|synthetic test only/);
});
async function pairingFixture(t) {
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  const keys = generateKeyPairSync('ed25519');
  const pub = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const body = signPairStart(ORIGIN, randomUUID(), DEVICE, pub, keys.privateKey);
  const session = await createPairingSession(registry, body, NOW); assert.ok(session);
  return { db, registry, body, session };
}
for (const condition of ['unknown', 'expired', 'before-created']) {
  test(`pairing ${condition} grant creates no user, identity or device`, async t => {
    const { db, registry, session } = await pairingFixture(t);
    const token = condition === 'unknown' ? 'ap1_' + '0'.repeat(64) : session.secret;
    const when = condition === 'expired' ? NOW + PAIR_TTL_MS : condition === 'before-created' ? NOW - 1 : NOW + 1;
    assert.equal(await claimPairingSession(registry, token, identity, when), null);
    for (const table of ['users', 'user_identities', 'devices']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
  });
}
test('simultaneous claimants cannot both claim or create extra identities', async t => {
  const { db, registry, session } = await pairingFixture(t);
  const claims = await Promise.all([identity, { ...identity, subject: 'bob-subject', email: 'bob@example.com' }].map(i => claimPairingSession(registry, session.secret, i, NOW + 1)));
  assert.equal(claims.filter(Boolean).length, 1);
  for (const table of ['users', 'user_identities', 'devices']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 1, table);
});
test('claimed pairing token expires too; it is not a permanent status credential', async t => {
  const { registry, session } = await pairingFixture(t);
  assert.ok(await claimPairingSession(registry, session.secret, identity, NOW + 1));
  assert.equal((await pairingStatus(registry, session.secret, NOW + PAIR_TTL_MS)).status, 'expired');
});
