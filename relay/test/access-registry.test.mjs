import assert from "node:assert/strict";
import test from "node:test";
import { resolveAccessIdentityDevice } from "../.test-tmp/access-registry.mjs";

const DEVICE = "beta-11111111-2222-4333-8444-555555555555";

function fakeRegistry(row) {
  const calls = [];
  const statement = {
    bind: (...values) => {
      calls.push({ type: "bind", values });
      return statement;
    },
    first: async () => row,
    run: async () => ({ success: true }),
  };
  return {
    calls,
    registry: {
      prepare: (sql) => {
        calls.push({ type: "prepare", sql });
        return statement;
      },
    },
  };
}

test("resolves one active identity to one beta device", async () => {
  const { registry, calls } = fakeRegistry({
    owner_id: "user-01",
    device_id: DEVICE,
    terminal_enabled: 1,
  });
  assert.deepEqual(
    await resolveAccessIdentityDevice(
      registry,
      "https://team.cloudflareaccess.com",
      "subject-01",
    ),
    { ownerId: "user-01", deviceId: DEVICE, terminalEnabled: true },
  );
  assert.deepEqual(
    calls.find((entry) => entry.type === "bind").values,
    ["https://team.cloudflareaccess.com", "subject-01"],
  );
});

test("file-only identity resolves without control permission", async () => {
  const { registry } = fakeRegistry({
    owner_id: "user-02",
    device_id: DEVICE,
    terminal_enabled: 0,
  });
  assert.deepEqual(
    await resolveAccessIdentityDevice(registry, "issuer", "subject"),
    { ownerId: "user-02", deviceId: DEVICE, terminalEnabled: false },
  );
});

test("invalid identity inputs fail before touching D1", async () => {
  for (const [issuer, subject] of [
    ["", "subject"],
    ["issuer", ""],
    ["x".repeat(513), "subject"],
    ["issuer", "x".repeat(513)],
  ]) {
    const { registry, calls } = fakeRegistry(null);
    assert.equal(await resolveAccessIdentityDevice(registry, issuer, subject), null);
    assert.deepEqual(calls, []);
  }
});

test("invalid or non-beta rows fail closed", async () => {
  for (const row of [
    null,
    { owner_id: "", device_id: DEVICE, terminal_enabled: 1 },
    { owner_id: "user", device_id: "personal-mac", terminal_enabled: 1 },
    { owner_id: "user", device_id: DEVICE, terminal_enabled: 2 },
  ]) {
    const { registry } = fakeRegistry(row);
    assert.equal(await resolveAccessIdentityDevice(registry, "issuer", "subject"), null);
  }
});

test("query requires one active device and active identity/user/device state", async () => {
  const { registry, calls } = fakeRegistry(null);
  await resolveAccessIdentityDevice(registry, "issuer", "subject");
  const sql = calls.find((entry) => entry.type === "prepare").sql;
  assert.match(sql, /i\.status = 'active'/);
  assert.match(sql, /u\.status = 'active'/);
  assert.match(sql, /d\.status = 'active'/);
  assert.match(sql, /COUNT\(\*\)/);
  assert.match(sql, /= 1/);
});
