import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { sqliteRegistry } from "./enrollment-sqlite.mjs";
import { pairingProofMessage } from "../.test-tmp/pairing.mjs";
import {
  handlePairClaim,
  handlePairStart,
  handlePairStatus,
} from "../.test-tmp/pairing-http.mjs";

const ORIGIN = "https://relay.example";
const DEVICE = "beta-11111111-2222-4333-8444-555555555555";

async function pairStartBody() {
  const keys = generateKeyPairSync("ed25519");
  const requestId = randomUUID();
  const agentPublicKeyB64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const message = await pairingProofMessage(ORIGIN, requestId, DEVICE, agentPublicKeyB64);
  const proof = sign(null, Buffer.from(message), keys.privateKey).toString("base64");
  return { version: 1, requestId, deviceId: DEVICE, agentPublicKeyB64, proof };
}

function startRequest(body) {
  return new Request(ORIGIN + "/pair/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("pair HTTP flow starts, previews, claims and reports completion without enabling control", async () => {
  const { db, registry } = sqliteRegistry();
  const body = await pairStartBody();

  const started = await handlePairStart(startRequest(body), registry);
  assert.equal(started.status, 201);
  assert.equal(started.headers.get("cache-control"), "no-store");
  const start = await started.json();
  assert.equal(start.ok, true);
  assert.equal(start.deviceId, DEVICE);
  assert.match(start.pairingToken, /^ap1_[a-f0-9]{64}$/);
  assert.equal(start.claimUrl, ORIGIN + "/pair/claim");

  const identity = {
    issuer: "https://team.cloudflareaccess.com",
    subject: "subject-http-01",
    email: "tester@example.com",
  };

  const preview = await handlePairClaim(
    new Request(start.claimUrl, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: start.claimCode }) }),
    registry,
    identity,
  );
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /Connect this Mac/);
  assert.match(previewHtml, /Initial access is file-only/);
  assert.match(previewHtml, new RegExp(DEVICE));
  const consent = previewHtml.match(/name="consent" value="([^"]+)"/)[1];

  const claimed = await handlePairClaim(
    new Request(ORIGIN + "/pair/claim", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ consent, scope: 'files-v1' }).toString(),
    }),
    registry,
    identity,
  );
  assert.equal(claimed.status, 200);
  assert.match(await claimed.text(), /Mac connected/);

  const status = await handlePairStatus(
    new Request(ORIGIN + "/pair/status", {
      headers: { authorization: "Bearer " + start.pairingToken },
    }),
    registry,
  );
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { status: "claimed", deviceId: DEVICE });

  const device = db.prepare("SELECT terminal_enabled, status FROM devices WHERE device_id = ?").get(DEVICE);
  assert.equal(device.terminal_enabled, 0);
  assert.equal(device.status, "active");

  const reused = await handlePairClaim(new Request(start.claimUrl, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: start.claimCode }) }), registry, identity);
  assert.equal(reused.status, 409);
  db.close();
});

test("pair HTTP endpoints reject malformed, cross-origin and unproved requests", async () => {
  const { db, registry } = sqliteRegistry();
  const body = await pairStartBody();

  assert.equal((await handlePairStart(new Request(ORIGIN + "/pair/start"), registry)).status, 405);
  assert.equal((await handlePairStart(new Request(ORIGIN + "/pair/start", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
  }), registry)).status, 415);
  assert.equal((await handlePairStart(startRequest({ ...body, proof: "x" }), registry)).status, 403);

  const started = await handlePairStart(startRequest(body), registry);
  const start = await started.json();
  const identity = {
    issuer: "https://team.cloudflareaccess.com",
    subject: "subject-http-02",
    email: "tester2@example.com",
  };

  const crossOrigin = await handlePairClaim(
    new Request(ORIGIN + "/pair/claim", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: start.pairingToken }).toString(),
    }),
    registry,
    identity,
  );
  assert.equal(crossOrigin.status, 403);

  assert.equal((await handlePairStatus(new Request(ORIGIN + "/pair/status"), registry)).status, 401);
  assert.equal((await handlePairStatus(new Request(ORIGIN + "/pair/status?token=x", {
    headers: { authorization: "Bearer " + start.pairingToken },
  }), registry)).status, 400);
  db.close();
});
