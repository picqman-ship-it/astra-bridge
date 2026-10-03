import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { sqliteRegistry } from "./enrollment-sqlite.mjs";
import {
  CONTROL_REQUEST_TTL_MS,
  applyControlPermissionRequest,
  cancelControlPermissionRequest,
  controlPermissionRequestStatus,
  resolveControlDeviceState,
  startControlPermissionRequest,
} from "../.test-tmp/control-permissions.mjs";
import { resolveAccessIdentityDevice } from "../.test-tmp/access-registry.mjs";
import { hashBearerToken, resolveBetaBearerHash } from "../.test-tmp/beta-registry.mjs";
import worker from "../.test-tmp/index.mjs";
import { signedHeaders } from "../../installer/lib/relay-probe.mjs";

const DEVICE = "beta-11111111-2222-4333-8444-555555555555";
const ISSUER = "https://team.cloudflareaccess.com";
const SUBJECT = "subject-01";
const EMAIL = "owner@example.com";
const NOW = 1_800_000_000_000;

function fixture(t) {
  const { db, registry } = sqliteRegistry();
  t.after(() => db.close());
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  db.prepare("INSERT INTO users (user_id,display_name,status,created_at) VALUES ('owner-1','Owner','active','2026-01-01')").run();
  db.prepare("INSERT INTO devices (device_id,owner_id,agent_public_key_b64,status,terminal_enabled,created_at,revoked_at) VALUES (?,'owner-1',?,'active',0,'2026-01-01',NULL)").run(DEVICE, publicKey);
  db.prepare("INSERT INTO user_identities (issuer,subject,owner_id,email,status,created_at) VALUES (?,?,'owner-1',?,'active','2026-01-01')")
    .run(ISSUER, SUBJECT, EMAIL);
  return { db, registry, keys, publicKey };
}

test("terminal and GUI grants are independent and immediately affect Access resolution", async t => {
  const { registry, publicKey } = fixture(t);
  assert.deepEqual(await resolveControlDeviceState(registry, DEVICE), {
    ownerId: "owner-1", deviceId: DEVICE, agentPublicKeyB64: publicKey,
    identityIssuer: ISSUER, identitySubject: SUBJECT, identityEmail: EMAIL,
    terminalEnabled: false, guiEnabled: false,
  });

  const terminalId = randomUUID();
  const terminal = await startControlPermissionRequest(registry, DEVICE, publicKey, terminalId,
    { terminalEnabled: true, guiEnabled: false }, NOW);
  assert.equal(terminal.status, "pending");
  assert.equal(terminal.previousTerminal, false);
  assert.equal(terminal.requestedTerminal, true);
  assert.equal((await applyControlPermissionRequest(registry, DEVICE, publicKey, terminalId,
    { terminalEnabled: true, guiEnabled: false }, NOW + 1)).status, "applied");
  assert.deepEqual(await resolveAccessIdentityDevice(registry, ISSUER, SUBJECT), {
    ownerId: "owner-1", deviceId: DEVICE, terminalEnabled: true, guiEnabled: false,
  });

  const guiId = randomUUID();
  assert.equal((await startControlPermissionRequest(registry, DEVICE, publicKey, guiId,
    { terminalEnabled: true, guiEnabled: true }, NOW + 2)).status, "pending");
  await applyControlPermissionRequest(registry, DEVICE, publicKey, guiId,
    { terminalEnabled: true, guiEnabled: true }, NOW + 3);
  assert.deepEqual(await resolveAccessIdentityDevice(registry, ISSUER, SUBJECT), {
    ownerId: "owner-1", deviceId: DEVICE, terminalEnabled: true, guiEnabled: true,
  });
});

test("expired, cancelled, wrong-key and changed-identity requests fail closed", async t => {
  const { db, registry, publicKey } = fixture(t);
  const target = { terminalEnabled: true, guiEnabled: false };
  const expiredId = randomUUID();
  await startControlPermissionRequest(registry, DEVICE, publicKey, expiredId, target, NOW);
  assert.equal((await controlPermissionRequestStatus(registry, DEVICE, expiredId, NOW + CONTROL_REQUEST_TTL_MS)).status, "expired");
  assert.equal(await applyControlPermissionRequest(registry, DEVICE, publicKey, expiredId, target, NOW + CONTROL_REQUEST_TTL_MS), null);

  const cancelId = randomUUID();
  await startControlPermissionRequest(registry, DEVICE, publicKey, cancelId, target, NOW + CONTROL_REQUEST_TTL_MS + 1);
  assert.equal(await cancelControlPermissionRequest(registry, DEVICE, publicKey, cancelId, NOW + CONTROL_REQUEST_TTL_MS + 2), true);
  assert.equal(await applyControlPermissionRequest(registry, DEVICE, publicKey, cancelId, target, NOW + CONTROL_REQUEST_TTL_MS + 3), null);

  const changedId = randomUUID();
  await startControlPermissionRequest(registry, DEVICE, publicKey, changedId, target, NOW + CONTROL_REQUEST_TTL_MS + 4);
  db.prepare("UPDATE user_identities SET status='revoked' WHERE issuer=? AND subject=?").run(ISSUER, SUBJECT);
  assert.equal(await applyControlPermissionRequest(registry, DEVICE, publicKey, changedId, target, NOW + CONTROL_REQUEST_TTL_MS + 5), null);
  assert.equal((await resolveControlDeviceState(registry, DEVICE)), null);
});

test("only one live permission request per device and applied requests are idempotent", async t => {
  const { registry, publicKey } = fixture(t);
  const target = { terminalEnabled: true, guiEnabled: false };
  const [a, b] = await Promise.all([
    startControlPermissionRequest(registry, DEVICE, publicKey, randomUUID(), target, NOW),
    startControlPermissionRequest(registry, DEVICE, publicKey, randomUUID(), target, NOW),
  ]);
  const started = [a, b].filter(Boolean);
  assert.equal(started.length, 1);
  const id = started[0].requestId;
  const first = await applyControlPermissionRequest(registry, DEVICE, publicKey, id, target, NOW + 1);
  const replay = await applyControlPermissionRequest(registry, DEVICE, publicKey, id, target, NOW + 2);
  assert.equal(first.status, "applied");
  assert.equal(replay.status, "applied");
  assert.equal(replay.terminalEnabled, true);
});

test("database constraints reject malformed permission rows and non-boolean capability values", t => {
  const { db } = fixture(t);
  assert.throws(() => db.prepare(`INSERT INTO device_control_permissions
    (device_id,owner_id,agent_public_key_b64,identity_issuer,identity_subject,identity_email,terminal_enabled,gui_enabled,version,updated_at_ms)
    SELECT device_id,owner_id,agent_public_key_b64,?,?,?,2,0,1,? FROM devices WHERE device_id=?`)
    .run(ISSUER, SUBJECT, EMAIL, NOW, DEVICE));
  const insertRequest = db.prepare(`INSERT INTO control_permission_requests
    (request_id,owner_id,device_id,agent_public_key_b64,identity_issuer,identity_subject,identity_email,
     previous_terminal,previous_gui,previous_version,requested_terminal,requested_gui,status,created_at_ms,expires_at_ms,applied_at_ms)
    SELECT ?,'owner-1',device_id,agent_public_key_b64,?,?,?,0,0,?,1,?,'applied',?,?,? FROM devices WHERE device_id=?`);
  // Each assertion starts from an otherwise valid row, so it exercises the named
  // capability, version, or applied-timestamp constraint instead of a missing field.
  for (const [version, gui, appliedAt] of [[1, 2, NOW], [0, 0, NOW], [1, 0, null], [1, 0, NOW + 1]]) {
    assert.throws(() => insertRequest.run(randomUUID(), ISSUER, SUBJECT, EMAIL, version, gui, NOW, NOW + 1, appliedAt, DEVICE));
  }
});

function rateEnv(registry) {
  const limiter = { limit: async () => ({ success: true }) };
  return {
    CONTROL_PERMISSIONS_ENABLED: "true", BETA_REGISTRY_ENABLED: "true", BETA_REGISTRY: registry,
    MCP_AUTH_MODE: "access", ACCESS_DEVICE_ROUTING: "registry",
    AGENT_DEVICE_ID: "personal-mac", CLIENT_DEVICE_ID: "personal-mac", MCP_DEVICE_ID: "personal-mac",
    BETA_ENROLL_RATE: limiter, BETA_REQUEST_RATE: limiter, BETA_MCP_RATE: limiter,
    BETA_ENROLL_GLOBAL_RATE: limiter, BETA_AGENT_GLOBAL_RATE: limiter, BETA_MCP_GLOBAL_RATE: limiter,
  };
}

function signedRequest(keys, path, method = "GET", value) {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  return new Request("https://relay.example" + path, {
    method,
    headers: { ...signedHeaders(keys.privateKey, method, path, body), ...(value === undefined ? {} : { "content-type": "application/json" }) },
    body: value === undefined ? undefined : body,
  });
}

test("signed Worker control routes start/apply/status/cancel only for the enrolled Mac", async t => {
  const { registry, keys } = fixture(t);
  const env = rateEnv(registry);
  const statusPath = `/control/device/${DEVICE}/status`;
  let response = await worker.fetch(signedRequest(keys, statusPath), env);
  assert.equal(response.status, 200);
  assert.deepEqual({ terminalEnabled: (await response.clone().json()).terminalEnabled, guiEnabled: (await response.json()).guiEnabled },
    { terminalEnabled: false, guiEnabled: false });

  const requestId = randomUUID();
  const target = { version: 1, requestId, terminalEnabled: true, guiEnabled: false };
  response = await worker.fetch(signedRequest(keys, `/control/device/${DEVICE}/start`, "POST", target), env);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).requestedTerminal, true);
  response = await worker.fetch(signedRequest(keys, `/control/device/${DEVICE}/apply`, "POST", target), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).terminalEnabled, true);

  const guiId = randomUUID();
  const guiTarget = { version: 1, requestId: guiId, terminalEnabled: true, guiEnabled: true };
  assert.equal((await worker.fetch(signedRequest(keys, `/control/device/${DEVICE}/start`, "POST", guiTarget), env)).status, 201);
  assert.equal((await worker.fetch(signedRequest(keys, `/control/device/${DEVICE}/cancel`, "POST", guiTarget), env)).status, 200);
  const reqStatus = await worker.fetch(signedRequest(keys, `/control/device/${DEVICE}/request/${guiId}/status`), env);
  assert.equal(reqStatus.status, 200);
  assert.equal((await reqStatus.json()).status, "cancelled");

  const attacker = generateKeyPairSync("ed25519");
  assert.equal((await worker.fetch(signedRequest(attacker, statusPath), env)).status, 403);
});


function beforeNextBatch(registry, before) {
  let pending = true;
  return {
    ...registry,
    async batch(statements) {
      if (pending) { pending = false; await before(); }
      return registry.batch(statements);
    },
  };
}

test("status and consent preview fingerprint the same decoded Mac public key", async t => {
  const { registry, keys, publicKey } = fixture(t);
  const env = rateEnv(registry);
  const status = await (await worker.fetch(signedRequest(keys, `/control/device/${DEVICE}/status`), env)).json();
  const requestId = randomUUID();
  const body = { version: 1, requestId, terminalEnabled: true, guiEnabled: false };
  const preview = await (await worker.fetch(signedRequest(keys, `/control/device/${DEVICE}/start`, "POST", body), env)).json();
  const recovered = await (await worker.fetch(signedRequest(keys, `/control/device/${DEVICE}/request/${requestId}/status`), env)).json();
  const expected = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
  assert.equal(status.agentFingerprint, expected);
  assert.equal(preview.agentFingerprint, expected);
  assert.equal(recovered.agentFingerprint, expected);
  const identityFingerprint = createHash("sha256").update(`${ISSUER}\n${SUBJECT}`).digest("hex");
  assert.equal(status.identityFingerprint, identityFingerprint);
  assert.equal(preview.identityFingerprint, identityFingerprint);
  assert.equal(recovered.identityFingerprint, identityFingerprint);
});

test("cancellation between apply read and commit cannot grant permissions", async t => {
  const { db, registry, publicKey } = fixture(t);
  const requestId = randomUUID();
  const target = { terminalEnabled: true, guiEnabled: false };
  await startControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW);
  const racing = beforeNextBatch(registry, () => {
    db.prepare("UPDATE control_permission_requests SET status='cancelled' WHERE request_id=?").run(requestId);
  });
  assert.equal(await applyControlPermissionRequest(racing, DEVICE, publicKey, requestId, target, NOW + 1), null);
  assert.deepEqual(await resolveAccessIdentityDevice(registry, ISSUER, SUBJECT), {
    ownerId: "owner-1", deviceId: DEVICE, terminalEnabled: false, guiEnabled: false,
  });
  assert.equal(db.prepare("SELECT status FROM control_permission_requests WHERE request_id=?").get(requestId).status, "cancelled");
});

test("expiry between apply read and commit cannot grant permissions", async t => {
  const { db, registry, publicKey } = fixture(t);
  const requestId = randomUUID();
  const target = { terminalEnabled: false, guiEnabled: true };
  await startControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW);
  const racing = beforeNextBatch(registry, () => {
    db.prepare("UPDATE control_permission_requests SET expires_at_ms=? WHERE request_id=?").run(NOW + 1, requestId);
  });
  assert.equal(await applyControlPermissionRequest(racing, DEVICE, publicKey, requestId, target, NOW + 1), null);
  const state = await resolveAccessIdentityDevice(registry, ISSUER, SUBJECT);
  assert.equal(state.terminalEnabled, false);
  assert.equal(state.guiEnabled, false);
  assert.equal(db.prepare("SELECT status FROM control_permission_requests WHERE request_id=?").get(requestId).status, "pending");
});

test("adding a second account identity before apply denies the stale consent", async t => {
  const { db, registry, publicKey } = fixture(t);
  const requestId = randomUUID();
  const target = { terminalEnabled: true, guiEnabled: true };
  await startControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW);
  const racing = beforeNextBatch(registry, () => {
    db.prepare("INSERT INTO user_identities (issuer,subject,owner_id,email,status,created_at) VALUES (?,?,'owner-1',?,'active','2026-01-01')")
      .run(ISSUER, "new-subject", "other@example.com");
  });
  assert.equal(await applyControlPermissionRequest(racing, DEVICE, publicKey, requestId, target, NOW + 1), null);
  assert.deepEqual(db.prepare("SELECT terminal_enabled,gui_enabled FROM device_control_permissions WHERE device_id=?").get(DEVICE),
    Object.assign(Object.create(null), { terminal_enabled: 0, gui_enabled: 0 }));
  assert.equal(await resolveControlDeviceState(registry, DEVICE), null);
  assert.equal(await controlPermissionRequestStatus(registry, DEVICE, requestId, NOW + 1), null);
});

test("permission version rejects stale consent after an enable-disable ABA change", async t => {
  const { db, registry, publicKey } = fixture(t);
  const requestId = randomUUID();
  const target = { terminalEnabled: true, guiEnabled: false };
  await startControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW);
  db.prepare("UPDATE device_control_permissions SET terminal_enabled=1,version=version+1 WHERE device_id=?").run(DEVICE);
  db.prepare("UPDATE device_control_permissions SET terminal_enabled=0,version=version+1 WHERE device_id=?").run(DEVICE);
  assert.equal(await applyControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW + 1), null);
  assert.equal((await resolveAccessIdentityDevice(registry, ISSUER, SUBJECT)).terminalEnabled, false);
  assert.equal(db.prepare("SELECT status FROM control_permission_requests WHERE request_id=?").get(requestId).status, "pending");
});

test("permission no-op and constraint failures roll back the applied marker", async t => {
  const { db, registry, publicKey } = fixture(t);
  const requestId = randomUUID();
  const target = { terminalEnabled: true, guiEnabled: false };
  await startControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW);
  for (const failure of ["IGNORE", "ABORT, 'injected permission write failure'"]) {
    db.exec(`CREATE TRIGGER injected_control_failure BEFORE UPDATE ON device_control_permissions BEGIN SELECT RAISE(${failure}); END;`);
    assert.equal(await applyControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW + 1), null);
    assert.equal(db.prepare("SELECT status FROM control_permission_requests WHERE request_id=?").get(requestId).status, "pending");
    assert.equal((await resolveAccessIdentityDevice(registry, ISSUER, SUBJECT)).terminalEnabled, false);
    db.exec("DROP TRIGGER injected_control_failure");
  }
});

test("revoked owner, device, key, or account cannot apply a permission request", async t => {
  for (const mutate of [
    db => db.prepare("UPDATE users SET status='revoked' WHERE user_id='owner-1'").run(),
    db => db.prepare("UPDATE devices SET status='revoked',revoked_at='2026-01-02' WHERE device_id=?").run(DEVICE),
    db => db.prepare("UPDATE devices SET agent_public_key_b64=? WHERE device_id=?")
      .run(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"), DEVICE),
    db => db.prepare("UPDATE user_identities SET status='revoked' WHERE issuer=? AND subject=?").run(ISSUER, SUBJECT),
    db => db.prepare("UPDATE user_identities SET email='changed@example.com' WHERE issuer=? AND subject=?").run(ISSUER, SUBJECT),
  ]) {
    const { db, registry, publicKey } = fixture(t);
    const requestId = randomUUID();
    const target = { terminalEnabled: true, guiEnabled: false };
    await startControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW);
    const racing = beforeNextBatch(registry, () => mutate(db));
    assert.equal(await applyControlPermissionRequest(racing, DEVICE, publicKey, requestId, target, NOW + 1), null);
    assert.equal(db.prepare("SELECT status FROM control_permission_requests WHERE request_id=?").get(requestId).status, "pending");
    assert.equal(db.prepare("SELECT terminal_enabled FROM device_control_permissions WHERE device_id=?").get(DEVICE).terminal_enabled, 0);
  }
});


async function addLegacyBearer(db, label = "legacy") {
  const tokenHash = await hashBearerToken(`synthetic-closed-beta-${label}-credential-only-for-test`);
  db.prepare("INSERT INTO access_tokens (token_hash,owner_id,device_id,label,status,created_at) VALUES (?,'owner-1',?,?,'active','2026-01-01')")
    .run(tokenHash, DEVICE, label);
  return tokenHash;
}

test("legacy bearer follows terminal/GUI overlay and cannot bypass file-only reduction", async t => {
  const { db, registry, publicKey } = fixture(t);
  db.prepare("UPDATE devices SET terminal_enabled=1 WHERE device_id=?").run(DEVICE);
  const tokenHash = await addLegacyBearer(db);
  assert.deepEqual(await resolveBetaBearerHash(registry, tokenHash, NOW), {
    ownerId: "owner-1", deviceId: DEVICE, terminalEnabled: true, guiEnabled: true,
  });
  const requestId = randomUUID();
  const target = { terminalEnabled: false, guiEnabled: false };
  await startControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW);
  await applyControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW + 1);
  assert.deepEqual(await resolveBetaBearerHash(registry, tokenHash, NOW + 1), {
    ownerId: "owner-1", deviceId: DEVICE, terminalEnabled: false, guiEnabled: false,
  });
});

test("legacy bearer retains independent terminal and GUI overlay grants", async t => {
  const { db, registry, publicKey } = fixture(t);
  const tokenHash = await addLegacyBearer(db);
  const target = { terminalEnabled: false, guiEnabled: true };
  const requestId = randomUUID();
  await startControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW);
  await applyControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW + 1);
  assert.deepEqual(await resolveBetaBearerHash(registry, tokenHash, NOW + 1), {
    ownerId: "owner-1", deviceId: DEVICE, terminalEnabled: false, guiEnabled: true,
  });
});

test("control authority is bound to the consenting identity and Mac key across rebind", async t => {
  for (const replacement of ["identity", "key", "email", "missing-identity"]) {
    const { db, registry, publicKey } = fixture(t);
    const tokenHash = await addLegacyBearer(db, replacement);
    const requestId = randomUUID();
    const target = { terminalEnabled: true, guiEnabled: true };
    await startControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW);
    await applyControlPermissionRequest(registry, DEVICE, publicKey, requestId, target, NOW + 1);
    let subject = SUBJECT;
    if (replacement === "identity" || replacement === "missing-identity") {
      db.prepare("UPDATE user_identities SET status='revoked' WHERE issuer=? AND subject=?").run(ISSUER, SUBJECT);
      if (replacement === "identity") {
        subject = "replacement-subject";
        db.prepare("INSERT INTO user_identities (issuer,subject,owner_id,email,status,created_at) VALUES (?,?,'owner-1',?,'active','2026-01-02')")
          .run(ISSUER, subject, EMAIL);
      }
    } else if (replacement === "key") {
      db.prepare("UPDATE devices SET agent_public_key_b64=? WHERE device_id=?")
        .run(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"), DEVICE);
    } else {
      db.prepare("UPDATE user_identities SET email='changed@example.com' WHERE issuer=? AND subject=?").run(ISSUER, SUBJECT);
    }
    assert.equal(await resolveBetaBearerHash(registry, tokenHash, NOW + 2), null, replacement);
    assert.equal(await resolveAccessIdentityDevice(registry, ISSUER, subject), null, replacement);
    assert.equal(await resolveControlDeviceState(registry, DEVICE), null, replacement);
    assert.equal(await controlPermissionRequestStatus(registry, DEVICE, requestId, NOW + 2), null, replacement);
  }
});

test("legacy invited devices with no overlay do not need an account identity", async t => {
  const { db, registry } = fixture(t);
  db.prepare("DELETE FROM user_identities WHERE owner_id='owner-1'").run();
  db.prepare("UPDATE devices SET terminal_enabled=1 WHERE device_id=?").run(DEVICE);
  const tokenHash = await addLegacyBearer(db);
  assert.deepEqual(await resolveBetaBearerHash(registry, tokenHash, NOW), {
    ownerId: "owner-1", deviceId: DEVICE, terminalEnabled: true, guiEnabled: true,
  });
});


test("malformed overlay capabilities fail closed in every authorization path", async t => {
  for (const capability of ["terminal_enabled", "gui_enabled"]) {
    const { db, registry, publicKey } = fixture(t);
    const tokenHash = await addLegacyBearer(db, capability);
    const requestId = randomUUID();
    await startControlPermissionRequest(registry, DEVICE, publicKey, requestId,
      { terminalEnabled: true, guiEnabled: true }, NOW);
    // Simulate storage corruption without relying on the schema rejection test.
    db.exec("PRAGMA ignore_check_constraints=ON");
    db.prepare(`UPDATE device_control_permissions SET ${capability}=2 WHERE device_id=?`).run(DEVICE);
    assert.equal(await resolveBetaBearerHash(registry, tokenHash, NOW + 1), null, capability);
    assert.equal(await resolveAccessIdentityDevice(registry, ISSUER, SUBJECT), null, capability);
    assert.equal(await resolveControlDeviceState(registry, DEVICE), null, capability);
    assert.equal(await controlPermissionRequestStatus(registry, DEVICE, requestId, NOW + 1), null, capability);
  }
});
