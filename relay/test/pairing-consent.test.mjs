import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sqliteRegistry } from './enrollment-sqlite.mjs';
import { signPairStart } from '../../installer/lib/account-pairing.mjs';
import { handlePairStart, handlePairClaim, handlePairStatus } from '../.test-tmp/pairing-http.mjs';
import { createPairingSession, pairingPreview, claimPairingSession, pairingStatus, PAIR_CLAIM_TTL_MS, PAIR_TTL_MS } from '../.test-tmp/pairing.mjs';

const ORIGIN = 'https://relay.example';
const identity = { issuer: 'https://team.cloudflareaccess.com', subject: 'alice', email: 'alice@example.com' };
async function startOn(registry) {
  const keys = generateKeyPairSync('ed25519');
  const pub = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const device = `beta-${randomUUID()}`;
  const response = await handlePairStart(new Request(ORIGIN + '/pair/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signPairStart(ORIGIN, randomUUID(), device, pub, keys.privateKey)),
  }), registry);
  assert.equal(response.status, 201);
  return { start: await response.json(), device, pub };
}
async function fixture(t) {
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  const { start, device, pub } = await startOn(registry);
  return { db, registry, start, device, pub };
}
const post = (registry, fields, who = identity) => handlePairClaim(new Request(ORIGIN + '/pair/claim', {
  method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
}), registry, who);
function empty(db) {
  for (const table of ['users', 'user_identities', 'devices']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
}
async function preview(registry, start) {
  assert.match(start.claimCode ?? '', /^pc1_[a-f0-9]{32}$/);
  const response = await post(registry, { code: start.claimCode });
  assert.equal(response.status, 200);
  const html = await response.text();
  const consent = html.match(/name="consent" value="(ac1_[a-f0-9]{64})"/)?.[1];
  assert.ok(consent, 'one-time account-bound confirmation');
  return { html, consent };
}
test('start separates browser code from polling and has a credential-free URL', async t => {
  const { start } = await fixture(t);
  assert.equal(start.claimUrl, ORIGIN + '/pair/claim');
  assert.match(start.claimCode, /^pc1_[a-f0-9]{32}$/);
  assert.notEqual(start.claimCode, start.pairingToken);
});
test('legacy credential query is rejected without reflection', async t => {
  const { registry, start } = await fixture(t);
  const response = await handlePairClaim(new Request(ORIGIN + '/pair/claim?token=' + start.pairingToken), registry, identity);
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes(start.pairingToken));
});
test('polling credential cannot authorize browser claim', async t => {
  const { registry, start, db } = await fixture(t);
  assert.equal((await post(registry, { token: start.pairingToken })).status, 400);
  empty(db);
});
test('GET is only a code-entry page and discloses no device or credential', async t => {
  const { registry, start, device } = await fixture(t);
  const response = await handlePairClaim(new Request(ORIGIN + '/pair/claim'), registry, identity);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /name="code"/); assert.match(html, /autocomplete="off"/);
  assert.ok(!html.includes(start.pairingToken)); assert.ok(!html.includes(device));
});
test('one-time code review binds consent to the displayed account and Mac', async t => {
  const { registry, start, db, device } = await fixture(t);
  const { html, consent } = await preview(registry, start);
  assert.ok(html.includes(identity.email)); assert.ok(html.includes(device)); assert.match(html, /file-only/);
  assert.ok(!html.includes(start.claimCode)); assert.ok(!html.includes(start.pairingToken)); empty(db);
  assert.equal((await post(registry, { code: start.claimCode })).status, 409);
  assert.equal((await post(registry, { consent, scope: 'files-v1' }, { ...identity, subject: 'bob', email: 'bob@example.com' })).status, 409);
  empty(db);
  assert.equal((await post(registry, { consent, scope: 'files-v1' })).status, 200);
  assert.equal((await post(registry, { consent, scope: 'files-v1' })).status, 409);
  const rows = db.prepare('SELECT device_id, terminal_enabled FROM devices').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].device_id, device); assert.equal(rows[0].terminal_enabled, 0);
  for (const credential of [start.claimCode, consent]) {
    const r = await handlePairStatus(new Request(ORIGIN + '/pair/status', { headers: { authorization: 'Bearer ' + credential } }), registry);
    assert.equal(r.status, 401);
  }
});
test('confirmation requires the explicit file scope checkbox', async t => {
  const { registry, start, db } = await fixture(t);
  const { consent } = await preview(registry, start);
  assert.equal((await post(registry, { consent })).status, 400);
  assert.equal((await post(registry, { consent, scope: 'terminal' })).status, 400); empty(db);
  assert.equal((await post(registry, { consent, scope: 'files-v1' })).status, 200);
});

for (const change of [{ issuer: 'https://other.cloudflareaccess.com' }, { subject: 'other' }, { email: 'changed@example.com' }]) {
  test(`review binds authenticated ${Object.keys(change)[0]} without side effects on mismatch`, async t => {
    const { registry, start, db } = await fixture(t);
    const { consent } = await preview(registry, start);
    assert.equal((await post(registry, { consent, scope: 'files-v1' }, { ...identity, ...change })).status, 409);
    empty(db);
    assert.equal((await post(registry, { consent, scope: 'files-v1' })).status, 200);
  });
}
test('code and confirmation each expire; future review, poll token and raw code cannot claim', async t => {
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  const keys = generateKeyPairSync('ed25519');
  const pub = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const now = 1800000000000;
  const session = await createPairingSession(registry, signPairStart(ORIGIN, randomUUID(), `beta-${randomUUID()}`, pub, keys.privateKey), now);
  assert.equal(await pairingPreview(registry, session.claimCode, identity, now - 1), null);
  assert.equal(await pairingPreview(registry, session.claimCode, identity, now + PAIR_CLAIM_TTL_MS), null);
  assert.equal(await pairingPreview(registry, session.secret, identity, now), null);
  const reviewed = await pairingPreview(registry, session.claimCode, identity, now);
  for (const credential of [session.claimCode, session.secret]) assert.equal(await claimPairingSession(registry, credential, identity, now), null);
  assert.equal(await claimPairingSession(registry, reviewed.consent, identity, now - 1), null);
  assert.equal(await claimPairingSession(registry, reviewed.consent, identity, now + PAIR_CLAIM_TTL_MS), null);
  empty(db);
  assert.equal((await pairingStatus(registry, session.secret, now + PAIR_CLAIM_TTL_MS)).status, 'pending');
  const stored = JSON.stringify(db.prepare('SELECT * FROM pairing_sessions').get());
  for (const credential of [session.claimCode, session.secret, reviewed.consent]) assert.ok(!stored.includes(credential));
});
test('consent cannot be retargeted with caller device/account/key fields or cross-origin forms', async t => {
  const { registry, start, db, device } = await fixture(t);
  const { consent } = await preview(registry, start);
  for (const field of ['deviceId', 'ownerId', 'agentPublicKeyB64']) {
    assert.equal((await post(registry, { consent, scope: 'files-v1', [field]: 'attacker-target' })).status, 400);
  }
  for (const fields of [{ code: start.claimCode }, { consent, scope: 'files-v1' }]) {
    const r = await handlePairClaim(new Request(ORIGIN + '/pair/claim', {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    }), registry, identity);
    assert.equal(r.status, 403);
  }
  empty(db);
  assert.equal((await post(registry, { consent, scope: 'files-v1' })).status, 200);
  assert.equal(db.prepare('SELECT device_id FROM devices').get().device_id, device);
});
test('invalid duplicate/oversized forms and escaped identity never echo credentials', async t => {
  const { registry, start, db } = await fixture(t);
  for (const body of [new URLSearchParams([['code', start.claimCode], ['code', start.claimCode]]),
    new URLSearchParams({ code: 'x'.repeat(1100) })]) {
    const r = await handlePairClaim(new Request(ORIGIN + '/pair/claim', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body,
    }), registry, identity);
    assert.ok([400, 413].includes(r.status)); assert.ok(!(await r.text()).includes(start.claimCode));
  }
  const r = await post(registry, { code: start.claimCode }, { ...identity, email: '<script>@example.com' });
  const html = await r.text(); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
  empty(db);
});

test('lost start response cannot create another live session for the same device or key', async t => {
  const { db, registry } = sqliteRegistry(); t.after(() => db.close());
  const keys = generateKeyPairSync('ed25519');
  const pub = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const device = `beta-${randomUUID()}`;
  const now = 1800000000000;
  const start = () => signPairStart(ORIGIN, randomUUID(), device, pub, keys.privateKey);
  const session = await createPairingSession(registry, start(), now);
  assert.ok(session);
  assert.equal(await createPairingSession(registry, start(), now + 1), null);
  assert.equal(await createPairingSession(registry,
    signPairStart(ORIGIN, randomUUID(), `beta-${randomUUID()}`, pub, keys.privateKey), now + 2), null);
  const replacement = generateKeyPairSync('ed25519');
  const replacementPub = replacement.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(await createPairingSession(registry,
    signPairStart(ORIGIN, randomUUID(), device, replacementPub, replacement.privateKey), now + 3), null);
  assert.equal(db.prepare('SELECT count(*) n FROM pairing_sessions').get().n, 1);
  assert.ok(await createPairingSession(registry, start(), now + PAIR_TTL_MS));
  assert.equal(db.prepare('SELECT count(*) n FROM pairing_sessions').get().n, 2);
  assert.equal(await pairingPreview(registry, session.claimCode, identity, now + PAIR_TTL_MS), null);
  empty(db);
});

// A non-file scope cannot even be stored (see the registry CHECK test below), so
// the in-transaction scope recheck is exercised with a cleared scope instead.
for (const change of [
  'consent_scope = NULL', "consent_subject = 'switched'", "consent_email = 'switched@example.com'",
  'consent_hash = NULL', 'consent_expires_at_ms = 0',
]) {
  test(`confirmation rechecks ${change.split(' = ')[0]} inside its transaction`, async t => {
    const { db, registry, start } = await fixture(t);
    const { consent } = await preview(registry, start);
    // Interleave a state change after any preflight reads, immediately before
    // the actual atomic batch. A pre-read alone must never authorize writes.
    const raced = { ...registry, async batch(statements) {
      db.exec(`UPDATE pairing_sessions SET ${change}`);
      return registry.batch(statements);
    } };
    assert.equal(await claimPairingSession(raced, consent, identity), null);
    empty(db);
  });
}

for (const field of ['device_id', 'agent_public_key_b64']) {
  test(`confirmation cannot change reviewed ${field}`, async t => {
    const { db, registry, start } = await fixture(t);
    const { consent } = await preview(registry, start);
    const value = field === 'device_id' ? `beta-${randomUUID()}`
      : generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    db.prepare(`UPDATE pairing_sessions SET ${field} = ?`).run(value);
    assert.equal(await claimPairingSession(registry, consent, identity), null);
    empty(db);
  });
}

for (const table of ['users', 'user_identities', 'devices']) {
  test(`pair status stops reporting claimed after ${table} is disabled`, async t => {
    const { db, registry, start } = await fixture(t);
    const { consent } = await preview(registry, start);
    assert.ok(await claimPairingSession(registry, consent, identity));
    db.exec(`UPDATE ${table} SET status = 'disabled'`);
    assert.deepEqual(await pairingStatus(registry, start.pairingToken), { status: 'cancelled', deviceId: start.deviceId });
  });
}

for (const state of ['disabled-user', 'revoked-user', 'disabled-identity', 'revoked-identity', 'other-owner']) {
  test(`confirmation refuses ${state} without creating another owner or device`, async t => {
    const { db, registry, start } = await fixture(t);
    const { consent } = await preview(registry, start);
    const owner = state === 'other-owner' ? 'existing-owner'
      : 'usr_' + createHash('sha256').update(`${identity.issuer}\n${identity.subject}`).digest('hex').slice(0, 40);
    const userStatus = state.endsWith('-user') ? state.split('-')[0] : 'active';
    const identityStatus = state.endsWith('-identity') ? state.split('-')[0] : 'active';
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(owner, 'Existing account', userStatus, '2026-01-01');
    db.prepare('INSERT INTO user_identities (issuer,subject,owner_id,email,status,created_at) VALUES (?,?,?,?,?,?)')
      .run(identity.issuer, identity.subject, owner, identity.email, identityStatus, '2026-01-01');
    const before = JSON.stringify(db.prepare('SELECT * FROM user_identities').all());
    assert.equal(await claimPairingSession(registry, consent, identity), null);
    assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM devices').get().n, 0);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM user_identities').all()), before);
  });
}

test('migration 0007 upgrades populated 0006 without rewriting accounts or authorizing legacy sessions', async t => {
  const { db, registry } = sqliteRegistry(':memory:', { migrate: false }); t.after(() => db.close());
  for (const name of ['0001_closed_beta_registry.sql', '0002_beta_enrollment_invites.sql',
    '0003_beta_agent_key_unique.sql', '0004_access_identities.sql', '0005_pairing_sessions.sql', '0006_pairing_claim_marker.sql']) {
    db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  db.exec("INSERT INTO users VALUES ('legacy-owner','Legacy','active','2026-01-01')");
  const legacyDevice = `beta-${randomUUID()}`;
  const pub = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  db.prepare("INSERT INTO devices VALUES (?, 'legacy-owner', ?, 'active', 0, '2026-01-01', NULL)").run(legacyDevice, pub);
  const token = 'ap1_' + 'd'.repeat(64);
  const hash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  db.prepare("INSERT INTO pairing_sessions (secret_hash,request_id,device_id,agent_public_key_b64,status,created_at_ms,expires_at_ms) VALUES (?,?,?,?,'pending',?,?)")
    .run(hash, randomUUID(), `beta-${randomUUID()}`, pub, now, now + PAIR_TTL_MS);
  const oldDevice = db.prepare('SELECT * FROM devices').get();
  const oldUser = db.prepare('SELECT * FROM users').get();
  db.exec(readFileSync(new URL('../migrations/0007_pairing_consent.sql', import.meta.url), 'utf8'));
  assert.deepEqual(db.prepare('SELECT * FROM devices').get(), oldDevice);
  assert.deepEqual(db.prepare('SELECT * FROM users').get(), oldUser);
  assert.equal(db.prepare('SELECT claim_code_hash FROM pairing_sessions').get().claim_code_hash, null);
  assert.equal(await pairingPreview(registry, token, identity, now), null);
  assert.equal(await claimPairingSession(registry, token, identity, now), null);
  assert.equal(db.prepare('SELECT count(*) n FROM devices').get().n, 1);
});

test('claim pages contain no external requests, redirects, referrers or polling credential', async t => {
  const { registry, start } = await fixture(t);
  const review = await post(registry, { code: start.claimCode });
  assert.equal(review.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(review.headers.get('cache-control'), 'no-store');
  assert.match(review.headers.get('content-security-policy'), /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'.*base-uri 'none'/);
  assert.equal(review.headers.get('location'), null);
  const body = await review.text();
  assert.doesNotMatch(body, /<script|<iframe|<img|<link|http-equiv/i);
  assert.ok(!body.includes(start.pairingToken));
  assert.ok(!body.includes(start.claimCode));
  assert.equal(body.match(/action="([^"]+)"/)[1], '/pair/claim');
});

// An identity whose binding row would violate a registry CHECK must be refused
// before review AND inside confirmation. INSERT OR IGNORE silently skips CHECK
// failures, which previously left a users row behind after a "failed" claim.
for (const [label, change] of [
  ['two-character email', { email: 'a@' }],
  ['oversized issuer', { issuer: `https://${'a'.repeat(520)}.cloudflareaccess.com` }],
]) {
  test(`identity the registry cannot store (${label}) is refused and leaves no partial account`, async t => {
    const { db, registry, start } = await fixture(t);
    const who = { ...identity, ...change };
    assert.equal((await post(registry, { code: start.claimCode }, who)).status, 409);
    const consent = 'ac1_' + 'e'.repeat(64);
    db.prepare(`UPDATE pairing_sessions SET claim_code_hash = NULL, consent_hash = ?, consent_issuer = ?,
      consent_subject = ?, consent_email = ?, consent_scope = 'files-v1', consent_device_id = device_id,
      consent_agent_public_key_b64 = agent_public_key_b64, consent_created_at_ms = created_at_ms,
      consent_expires_at_ms = expires_at_ms`)
      .run(createHash('sha256').update(consent).digest('hex'), who.issuer, who.subject, who.email);
    assert.equal(await claimPairingSession(registry, consent, who), null);
    empty(db);
  });
}

test('a failed identity insert rolls back the account row and leaves the confirmation usable', async t => {
  const { db, registry, start } = await fixture(t);
  const { consent } = await preview(registry, start);
  db.exec("CREATE TRIGGER identity_fail BEFORE INSERT ON user_identities BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.equal(await claimPairingSession(registry, consent, identity), null);
  empty(db);
  db.exec('DROP TRIGGER identity_fail');
  assert.ok(await claimPairingSession(registry, consent, identity));
});

test('an existing account pairs a replacement Mac after revocation without duplicate account rows', async t => {
  const { db, registry, start } = await fixture(t);
  assert.ok(await claimPairingSession(registry, (await preview(registry, start)).consent, identity));
  const users = db.prepare('SELECT * FROM users').all();
  const identities = db.prepare('SELECT * FROM user_identities').all();
  db.exec("UPDATE devices SET status = 'revoked', revoked_at = '2026-10-02T00:00:00.000Z'");
  const next = await startOn(registry);
  const claimed = await claimPairingSession(registry, (await preview(registry, next.start)).consent, identity);
  assert.equal(claimed?.deviceId, next.device);
  assert.deepEqual(db.prepare('SELECT * FROM users').all(), users);
  assert.deepEqual(db.prepare('SELECT * FROM user_identities').all(), identities);
  assert.equal(db.prepare("SELECT count(*) n FROM devices WHERE status = 'active'").get().n, 1);
});

test('every claim page denies framing and opener access and is never cached', async t => {
  const { registry, start } = await fixture(t);
  const pages = [
    await handlePairClaim(new Request(ORIGIN + '/pair/claim'), registry, identity),
    await handlePairClaim(new Request(ORIGIN + '/pair/claim?token=x'), registry, identity),
    await post(registry, { code: 'pc1_' + 'f'.repeat(32) }),
    await post(registry, { code: start.claimCode }),
  ];
  for (const page of pages) {
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*form-action 'self'/);
  }
});

test('code entry tolerates copy whitespace and case but rejects malformed input without consuming the code', async t => {
  const { db, registry, start } = await fixture(t);
  for (const code of ['pc1_' + 'z'.repeat(32), start.claimCode.slice(0, -1), start.pairingToken, 'x']) {
    const response = await post(registry, { code });
    assert.equal(response.status, 400, code);
    const body = await response.text();
    assert.match(body, /not a valid/i);
    assert.ok(!body.includes(start.pairingToken) && !body.includes(start.claimCode));
  }
  const response = await post(registry, { code: `  ${start.claimCode.toUpperCase()}\n` });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /name="consent" value="ac1_/);
  empty(db);
});

test('registry rejects any non-file consent scope or malformed stored credential hash', async t => {
  const { db, registry, start } = await fixture(t);
  await preview(registry, start);
  for (const change of ["consent_scope = 'terminal'", "consent_scope = 'files-v2'", "consent_hash = 'not-a-hash'",
    "consent_hash = upper(hex(randomblob(32)))", "claim_code_hash = 'abc'", "consent_expires_at_ms = 'soon'"]) {
    assert.throws(() => db.exec(`UPDATE pairing_sessions SET ${change}`), /CHECK constraint failed/, change);
  }
});

test('browser review shows the same key fingerprint the installer derives locally', async t => {
  const { registry, start, pub } = await fixture(t);
  const installerFingerprint = createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex');
  const { html } = await preview(registry, start);
  assert.ok(html.includes(installerFingerprint));
});
