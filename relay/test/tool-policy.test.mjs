import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_TOOL_NAMES,
  EXCLUDED_TOOL_NAMES,
  IDEMPOTENCY_REQUIRED,
  OAUTH_SCOPES,
  TOOL_SAFETY,
  TOOL_SCOPE,
  exposeApprovedTool,
  hasValidIdempotencyKey,
  isToolApproved,
  requiredScope,
} from "../.test-tmp/tool-policy.mjs";
import { TERMINAL_TOOL_NAMES } from "../.test-tmp/beta-registry.mjs";

test("every reviewed tool has exactly one OAuth scope consistent with its safety policy", () => {
  assert.deepEqual([...OAUTH_SCOPES], ["astra.read", "astra.write", "astra.control"]);
  assert.deepEqual(Object.keys(TOOL_SCOPE).sort(), [...APPROVED_TOOL_NAMES].sort());
  for (const [name, scope] of Object.entries(TOOL_SCOPE)) {
    // Shell/process/durable-command tools always need astra.control.
    if (TERMINAL_TOOL_NAMES.has(name)) assert.equal(scope, "astra.control", name);
    // astra.read never unlocks a mutation; any mutation needs write or control.
    if (scope === "astra.read") assert.equal(TOOL_SAFETY[name].readOnlyHint, true, name);
    if (!TOOL_SAFETY[name].readOnlyHint) assert.notEqual(scope, "astra.read", name);
    // Open-world is orthogonal to read/write authorization: read_file may fetch a public URL
    // while remaining read-only; mutating open-world tools require control.
    if (TOOL_SAFETY[name].openWorldHint && !TOOL_SAFETY[name].readOnlyHint) {
      assert.equal(scope, "astra.control", name);
    }
  }
  for (const name of [...EXCLUDED_TOOL_NAMES, "future_unreviewed_tool", "__proto__", "toString"]) {
    assert.equal(requiredScope(name), null, name);
  }
});

test("exposed tools advertise the reviewed oauth2 scheme, overriding downstream values", () => {
  const exposed = exposeApprovedTool({
    name: "read_file",
    inputSchema: { type: "object", properties: {} },
    securitySchemes: [{ type: "noauth" }],
    _meta: { securitySchemes: [{ type: "noauth" }], other: 1 },
  });
  assert.deepEqual(exposed.securitySchemes, [{ type: "oauth2", scopes: ["astra.read"] }]);
  assert.deepEqual(exposed._meta, { other: 1, securitySchemes: [{ type: "oauth2", scopes: ["astra.read"] }] });
});

test("reviewed allowlist is exactly the 31 known tools and excludes config mutation", () => {
  assert.equal(APPROVED_TOOL_NAMES.size, 31);
  for (const name of EXCLUDED_TOOL_NAMES) {
    assert.equal(APPROVED_TOOL_NAMES.has(name), false, name);
    assert.equal(isToolApproved(name), false, name);
  }
  // No approved tool that can mutate state is named like a config/security control.
  const mutating = Object.entries(TOOL_SAFETY).filter(([, s]) => !s.readOnlyHint).map(([n]) => n);
  for (const name of mutating) {
    assert.doesNotMatch(name, /config|secret|token|key|permission|policy|auth/i, name);
  }
  assert.equal(isToolApproved("__proto__"), false);
  assert.equal(isToolApproved(undefined), false);
});

test("every idempotency-gated tool is approved and marked mutating", () => {
  for (const name of IDEMPOTENCY_REQUIRED) {
    assert.equal(APPROVED_TOOL_NAMES.has(name), true, name);
    assert.equal(TOOL_SAFETY[name].readOnlyHint, false, name);
  }
});

test("idempotency keys must be strings of 8-200 characters", () => {
  assert.equal(hasValidIdempotencyKey(undefined), false);
  assert.equal(hasValidIdempotencyKey({}), false);
  assert.equal(hasValidIdempotencyKey({ idempotencyKey: 12345678 }), false);
  assert.equal(hasValidIdempotencyKey({ idempotencyKey: "1234567" }), false);
  assert.equal(hasValidIdempotencyKey({ idempotencyKey: "12345678" }), true);
  assert.equal(hasValidIdempotencyKey({ idempotencyKey: "x".repeat(200) }), true);
  assert.equal(hasValidIdempotencyKey({ idempotencyKey: "x".repeat(201) }), false);
});

test("gated tools are exposed with idempotencyKey required, or hidden if the schema lacks it", () => {
  const withKey = exposeApprovedTool({
    name: "write_file",
    description: "Write a file.",
    inputSchema: { type: "object", properties: { path: {}, idempotencyKey: {} }, required: ["path"] },
    annotations: { title: "Write", readOnlyHint: true },
  });
  assert.deepEqual(withKey.inputSchema.required, ["path", "idempotencyKey"]);
  assert.match(withKey.description, /Requires idempotencyKey/);
  assert.equal(withKey.annotations.title, "Write");
  assert.equal(withKey.annotations.readOnlyHint, false, "reviewed hints override downstream hints");

  const withoutKey = exposeApprovedTool({
    name: "write_file", inputSchema: { type: "object", properties: { path: {} } },
  });
  assert.equal(withoutKey, null, "never inject a key the downstream would ignore");

  const readOnly = exposeApprovedTool({ name: "read_file", inputSchema: { type: "object", properties: {} } });
  assert.equal(readOnly.inputSchema.required, undefined);

  assert.equal(exposeApprovedTool({ name: "set_config_value", inputSchema: {} }), null);
  assert.equal(exposeApprovedTool({ name: "future_unreviewed_tool", inputSchema: {} }), null);
});


test("read_file is marked open-world because it can fetch http/https URLs", () => {
  assert.equal(TOOL_SAFETY.read_file.readOnlyHint, true);
  assert.equal(TOOL_SAFETY.read_file.destructiveHint, false);
  assert.equal(TOOL_SAFETY.read_file.openWorldHint, true);
});
