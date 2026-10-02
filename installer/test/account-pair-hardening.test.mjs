import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createContext } from '../lib/context.mjs';
import { accountPairInstallOptions, pairAccount, openPairingBrowser } from '../lib/account-pairing.mjs';
import { readState, writeState } from '../lib/state.mjs';
import { tmpDir } from './helpers.mjs';
const ORIGIN = 'https://relay.example';
const DEVICE = 'beta-11111111-2222-4333-8444-555555555555';
const TOKEN = 'ap1_' + 'a'.repeat(64);
function fixture(t) {
  const home = tmpDir('astra-pair-hardening-'); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ctx = createContext({ repoDir: path.join(home, 'checkout'), env: { HOME: home } });
  fs.mkdirSync(ctx.astraHome, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(ctx.astraHome, 'agent-private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { ctx, opts: { accountPair: true, relayUrl: ORIGIN, deviceId: DEVICE }, s: { keys: { agent: pub } }, ui: { ok() {}, info() {} }, pub };
}
test('account pairing refuses an existing agent with no proven account-pairing identity', t => {
  const { ctx } = fixture(t); fs.mkdirSync(ctx.launchAgentsDir, { recursive: true });
  const file = path.join(ctx.launchAgentsDir, 'com.example.astra-bridge-agent.plist');
  fs.writeFileSync(file, 'existing agent must remain untouched');
  assert.throws(() => accountPairInstallOptions(ctx, { accountPair: true }, { trust: x => x, pinnedOrigin: ORIGIN }), /existing agent|refusing to replace/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing agent must remain untouched');
});
for (const code of [undefined, 408, 409, 429, 503]) {
  test(`inconclusive signed recovery (${code}) does not create a new session or rewrite saved identity`, async t => {
    const { ctx, opts, s, ui, pub } = fixture(t);
    writeState(ctx, { accountPairing: { relayUrl: ORIGIN, deviceId: DEVICE, agentPublicKeyB64: pub, registered: false } });
    const before = fs.readFileSync(ctx.stateFile, 'utf8'); let requests = 0;
    await assert.rejects(pairAccount(ctx, opts, ui, s, {
      probe: async () => ({ ok: false, status: code }),
      fetchImpl: async () => { requests++; throw new Error('network must not be used'); },
    }));
    assert.equal(requests, 0); assert.equal(fs.readFileSync(ctx.stateFile, 'utf8'), before);
  });
}
function startResponse() {
  return Response.json({ ok: true, deviceId: DEVICE, expiresAtMs: Date.now() + 600000, claimUrl: ORIGIN + '/pair/claim?token=' + TOKEN, pairingToken: TOKEN }, { status: 201 });
}
test('claimed session alone cannot mark a device registered without signed device verification', async t => {
  const { ctx, opts, s, ui } = fixture(t); let signedChecks = 0;
  await assert.rejects(pairAccount(ctx, opts, ui, s, {
    fetchImpl: async url => url.pathname === '/pair/start' ? startResponse() : Response.json({ status: 'claimed', deviceId: DEVICE }),
    openBrowser: async () => true,
    probe: async () => { signedChecks++; return { ok: false, status: 503 }; },
  }), /signed|verified|verification/i);
  assert.equal(signedChecks, 1); assert.equal(readState(ctx).accountPairing.registered, false);
});
test('browser launch errors do not reflect a short-lived pairing secret into the error', async t => {
  const { ctx, opts, s, ui } = fixture(t);
  await assert.rejects(pairAccount(ctx, opts, ui, s, {
    fetchImpl: async () => startResponse(),
    openBrowser: async () => { throw new Error('failed opening ' + TOKEN); },
  }), error => !error.message.includes(TOKEN));
});

test('browser handoff does not expose the pairing token in command arguments', async () => {
  const url = ORIGIN + '/pair/claim?token=' + TOKEN;
  let called = false;
  assert.equal(await openPairingBrowser(url, { runImpl(command, args, options) {
    called = true; assert.equal(command, '/usr/bin/osascript'); assert.deepEqual(args, ['-']);
    assert.equal(JSON.stringify(args).includes(TOKEN), false); assert.ok(options.input.includes(TOKEN));
    return { status: 0, error: null };
  } }), true);
  assert.equal(called, true);
});
