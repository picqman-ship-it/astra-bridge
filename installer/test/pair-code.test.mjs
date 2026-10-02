import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, createHash } from 'node:crypto';
import * as pairing from '../lib/account-pairing.mjs';
import { createContext } from '../lib/context.mjs';
import { tmpDir } from './helpers.mjs';
import { readState } from '../lib/state.mjs';
const ORIGIN = 'https://relay.example';
const TOKEN = 'ap1_' + 'a'.repeat(64);
const CODE = 'pc1_' + 'b'.repeat(32);
const DEVICE = 'beta-11111111-2222-4333-8444-555555555555';
function fixture(t) {
  const home = tmpDir('astra-pair-code-'); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ctx = createContext({ repoDir: path.join(home, 'checkout'), env: { HOME: home } });
  fs.mkdirSync(ctx.astraHome, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(ctx.astraHome, 'agent-private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const output = []; const ui = { ok: x => output.push(x), info: x => output.push(x) };
  return { ctx, ui, output, s: { keys: { agent: pub } }, opts: { accountPair: true, relayUrl: ORIGIN, deviceId: DEVICE } };
}
const started = () => Response.json({ ok: true, deviceId: DEVICE, expiresAtMs: Date.now() + 600000,
  claimUrl: ORIGIN + '/pair/claim', claimCode: CODE, pairingToken: TOKEN }, { status: 201 });
test('fresh installer opens a credential-free URL and shows code only in local dialog', async t => {
  const { ctx, ui, output, s, opts } = fixture(t); let displayed = false; let opened = false;
  await pairing.pairAccount(ctx, opts, ui, s, {
    fetchImpl: async (url, init) => {
      if (url.pathname === '/pair/start') return started();
      assert.equal(init.headers.authorization, 'Bearer ' + TOKEN);
      return Response.json({ status: 'claimed', deviceId: DEVICE });
    },
    openBrowser: async url => { assert.equal(url, ORIGIN + '/pair/claim'); opened = true; return true; },
    showCode: async (code, device, fingerprint) => {
      assert.equal(code, CODE); assert.equal(device, DEVICE);
      assert.equal(fingerprint, createHash('sha256').update(Buffer.from(s.keys.agent, 'base64')).digest('hex'));
      displayed = true; return true;
    },
    probe: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(opened, true); assert.equal(displayed, true);
  // The setup URL carries no credential, so it is printed for a manual browser fallback.
  assert.ok(output.some(line => line.includes(ORIGIN + '/pair/claim')));
  for (const value of [CODE, TOKEN]) {
    assert.ok(!output.join(' ').includes(value)); assert.ok(!fs.readFileSync(ctx.stateFile, 'utf8').includes(value));
  }
});
test('browser launcher rejects any credential URL before spawning a process', async () => {
  for (const suffix of ['?token=' + TOKEN, '#code=' + CODE, '?code=' + CODE]) {
    let calls = 0;
    assert.equal(await pairing.openPairingBrowser(ORIGIN + '/pair/claim' + suffix, { runImpl() { calls++; return { status: 0 }; } }), false);
    assert.equal(calls, 0);
  }
});
test('local code dialog transports credentials on stdin and suppresses returned text', async () => {
  assert.equal(typeof pairing.showPairingCode, 'function');
  let called = false;
  assert.equal(await pairing.showPairingCode(CODE, DEVICE, 'c'.repeat(64), { runImpl(command, args, options) {
    called = true; assert.equal(command, '/usr/bin/osascript'); assert.deepEqual(args, ['-']);
    assert.ok(options.input.includes(CODE)); assert.match(options.input, /return ""/);
    // Device-code phishing is the residual risk of any user-carried code.
    assert.match(options.input, /Never share this code/);
    assert.ok(!options.input.includes(TOKEN)); return { status: 0 };
  } }), true);
  assert.equal(called, true);
});
test('local dialog failure or reflected exception stops polling and stays redacted', async t => {
  const { ctx, ui, s, opts, output } = fixture(t); let calls = 0;
  await assert.rejects(pairing.pairAccount(ctx, opts, ui, s, {
    fetchImpl: async () => { calls++; return started(); }, openBrowser: async () => true,
    showCode: async () => { throw new Error(CODE); },
  }), error => /code|cancel/i.test(error.message) && !error.message.includes(CODE));
  assert.equal(calls, 1); assert.ok(!output.join(' ').includes(CODE));
});

test('lost start response retains identity, rejects a still-pending retry, then recovers signed completion', async t => {
  const { ctx, ui, s, opts, output } = fixture(t);
  let starts = 0;
  await assert.rejects(pairing.pairAccount(ctx, opts, ui, s, {
    fetchImpl: async () => { starts++; throw new Error('lost response ' + TOKEN + CODE); },
  }), error => !error.message.includes(TOKEN) && !error.message.includes(CODE));
  const saved = readState(ctx).accountPairing;
  assert.equal(saved.deviceId, DEVICE);
  assert.equal(saved.agentPublicKeyB64, s.keys.agent);
  assert.equal(saved.registered, false);
  await assert.rejects(pairing.pairAccount(ctx, opts, ui, s, {
    probe: async () => ({ ok: false, status: 403 }),
    fetchImpl: async () => { starts++; return Response.json({ error: 'pairing_conflict' }, { status: 409 }); },
    openBrowser: async () => { assert.fail('conflicting start cannot open another consent'); },
  }), /pending request/);
  assert.deepEqual(readState(ctx).accountPairing, saved);
  await pairing.pairAccount(ctx, opts, ui, s, {
    probe: async () => ({ ok: true, status: 200 }),
    fetchImpl: async () => { assert.fail('completed binding must recover without another start'); },
  });
  assert.deepEqual(readState(ctx).accountPairing, { ...saved, registered: true });
  assert.equal(starts, 2);
  for (const secret of [TOKEN, CODE]) {
    assert.ok(!fs.readFileSync(ctx.stateFile, 'utf8').includes(secret));
    assert.ok(!output.join(' ').includes(secret));
  }
});
