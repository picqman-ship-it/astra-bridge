import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { parseJsonc, setStringProperty, stringProperties, stripJsonc } from "../lib/jsonc.mjs";
import {
  DEVICE_ID_RE,
  POLICY_AUD_RE,
  TEAM_HOST_RE,
  isPlaceholder,
  normalizeRelayUrl,
  normalizeTeamDomain,
  validateDeviceId,
  validateEmail,
  validatePolicyAud,
  validatePublicKeyB64,
  validateWorkerName,
} from "../lib/validate.mjs";
import { applyUpdates, interpret, readPersonalConfig } from "../lib/wrangler-config.mjs";
import { AUD, REPO, tmpDir } from "./helpers.mjs";

const TEMPLATE = path.join(REPO, "relay", "wrangler.jsonc");
const publicKeyB64 = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
const AGENT_PUB = publicKeyB64();
const CLIENT_PUB = publicKeyB64();

test("validators accept real values and normalize them", () => {
  assert.equal(validateDeviceId(" studio-mac.2 "), "studio-mac.2");
  assert.equal(validateEmail(" Owner@Corp.Test "), "owner@corp.test");
  assert.equal(validateWorkerName("astra-bridge-relay"), "astra-bridge-relay");
  assert.equal(normalizeRelayUrl("https://astra.sub.workers.dev/"), "https://astra.sub.workers.dev");
  assert.equal(normalizeTeamDomain("myteam"), "https://myteam.cloudflareaccess.com");
  assert.equal(normalizeTeamDomain("MyTeam.cloudflareaccess.com"), "https://myteam.cloudflareaccess.com");
  assert.equal(normalizeTeamDomain("https://myteam.cloudflareaccess.com/"), "https://myteam.cloudflareaccess.com");
  assert.equal(validatePolicyAud(` ${AUD} `), AUD);
  assert.equal(validatePublicKeyB64(AGENT_PUB), AGENT_PUB);
});

test("validators refuse unsafe or placeholder values", () => {
  for (const v of ["", "my mac", "a/b", "x".repeat(97), "mac:1", "é"]) assert.throws(() => validateDeviceId(v), /device id/);
  for (const v of ["", "you@example.com", "a@b", "a b@c.de", "x@y.z,other@y.z", "<you>@x.io"]) assert.throws(() => validateEmail(v));
  for (const v of ["", "-x", "x-", "Astra", "a_b", "a".repeat(64)]) assert.throws(() => validateWorkerName(v));
  for (const v of [
    "http://astra.sub.workers.dev", "https://astra.sub.workers.dev/mcp", "https://u:p@astra.sub.workers.dev",
    "https://astra.sub.workers.dev:8443", "https://astra.sub.workers.dev/?q=1", "https://<your-worker>.<your-subdomain>.workers.dev",
    "not a url", "https://localhost",
  ]) assert.throws(() => normalizeRelayUrl(v), undefined, v);
  for (const v of ["https://<your-team>.cloudflareaccess.com", "https://evil.example", "http://t.cloudflareaccess.com", "https://t.cloudflareaccess.com/x", "https://t.cloudflareaccess.com.evil.example"]) {
    assert.throws(() => normalizeTeamDomain(v), undefined, v);
  }
  for (const v of ["REPLACE_WITH_ACCESS_AUD", "a".repeat(31), `${AUD}!`]) assert.throws(() => validatePolicyAud(v));
  assert.throws(() => validatePublicKeyB64("REPLACE_WITH_AGENT_PUBLIC_KEY_B64"));
  assert.throws(() => validatePublicKeyB64(Buffer.alloc(44).toString("base64")), /Ed25519/);
  assert.ok(isPlaceholder("REPLACE_WITH_X") && isPlaceholder("https://<your-team>.cloudflareaccess.com") && isPlaceholder("you@example.com"));
  assert.ok(!isPlaceholder("my-mac"));
});

test("validation rules match the agent and the Worker", () => {
  const agentLib = fs.readFileSync(path.join(REPO, "relay", "src", "agent-lib.mjs"), "utf8");
  assert.ok(agentLib.includes(`const DEVICE_ID_RE = ${DEVICE_ID_RE};`), "device id rule differs from relay/src/agent-lib.mjs");
  const access = fs.readFileSync(path.join(REPO, "relay", "src", "access-auth.ts"), "utf8");
  assert.ok(access.includes(`const TEAM_HOST = ${TEAM_HOST_RE};`), "team host rule differs from relay/src/access-auth.ts");
  assert.ok(access.includes(`const POLICY_AUD_PATTERN = ${POLICY_AUD_RE};`), "AUD rule differs from relay/src/access-auth.ts");
});

test("JSONC: string properties are found by path, ignoring comments and array elements", () => {
  const text = `// top "name": "comment"
{
  "name": "a", /* "name": "b" */
  "list": [{ "name": "in-array" }, "x"],
  "vars": {
    // "AGENT_DEVICE_ID": "commented",
    "AGENT_DEVICE_ID": "my-mac", "URL": "https://x//y", "N": 5, "T": true,
    "nested": { "K": "v\\"q" },
  },
}`;
  const props = stringProperties(text).map((p) => [p.path.join("."), p.value]);
  assert.deepEqual(props, [["name", "a"], ["vars.AGENT_DEVICE_ID", "my-mac"], ["vars.URL", "https://x//y"], ["vars.nested.K", 'v"q']]);
  const next = setStringProperty(text, ["vars", "AGENT_DEVICE_ID"], "studio");
  assert.equal(parseJsonc(next).vars.AGENT_DEVICE_ID, "studio");
  assert.ok(next.includes('// "AGENT_DEVICE_ID": "commented"'), "comments are preserved");
  assert.equal(parseJsonc(next).vars.URL, "https://x//y", "// inside a string is not a comment");
  assert.throws(() => setStringProperty(text, ["vars", "MISSING"], "x"), /missing/);
  assert.throws(() => setStringProperty(text, ["vars", "N"], "x"), /missing or not a string/);
  assert.throws(() => setStringProperty('{"a":"1","a":"2"}', ["a"], "x"), /more than once/);
  assert.deepEqual(JSON.parse(stripJsonc('{"a": [1, 2,], /* c */ "b": {"c": 1,},}')), { a: [1, 2], b: { c: 1 } });
});

test("personal config: the template is fail-closed placeholders, updates fill exactly the managed values", () => {
  const template = fs.readFileSync(TEMPLATE, "utf8");
  const before = interpret(parseJsonc(template));
  assert.equal(before.values.agentKey, null);
  assert.equal(before.values.email, null);
  assert.equal(before.values.relayUrl, null);
  assert.equal(before.accessConfigured, false);
  assert.equal(before.values.authMode, "access");

  const text = applyUpdates(template, {
    agentKey: AGENT_PUB,
    clientKey: CLIENT_PUB,
    deviceId: "studio-mac",
    email: "Owner@Corp.Test",
    relayUrl: "https://astra-bridge-relay.sub.workers.dev",
  });
  const after = interpret(parseJsonc(text));
  assert.deepEqual(after.problems, []);
  assert.equal(after.values.agentKey, AGENT_PUB);
  assert.equal(after.values.clientKey, CLIENT_PUB);
  assert.equal(after.values.deviceId, "studio-mac");
  assert.equal(after.values.email, "owner@corp.test");
  assert.equal(after.raw.clientDeviceId, "studio-mac");
  assert.equal(after.raw.mcpDeviceId, "studio-mac");
  assert.equal(after.raw.oauthResource, "https://astra-bridge-relay.sub.workers.dev/mcp");
  assert.equal(after.accessConfigured, false, "Access stays unconfigured (fails closed) until its values are given");

  // Everything outside the managed values is byte-for-byte the template.
  const strip = (s) => s.replace(/"[A-Z0-9_]+": "[^"]*"/g, "").replace(/"name": "[^"]*"/g, "");
  assert.equal(strip(text), strip(template));
  const data = parseJsonc(text);
  assert.equal(data.vars.ALERT_TO_ADDRESS, "you@example.com", "optional alert settings are untouched");
  assert.equal(data.vars.MCP_AUTH_MODE, "access");

  const withAccess = interpret(parseJsonc(applyUpdates(text, { teamDomain: "myteam", policyAud: AUD })));
  assert.equal(withAccess.accessConfigured, true);
  assert.equal(withAccess.values.teamDomain, "https://myteam.cloudflareaccess.com");

  assert.throws(() => applyUpdates(text, { email: "not-an-email" }));
  assert.throws(() => applyUpdates(text, { relayUrl: "http://insecure.example.org" }));
  assert.equal(fs.readFileSync(TEMPLATE, "utf8"), template, "the committed template is never modified");
});

test("personal config: inconsistent device ids and unparseable files are reported", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, "wrangler.personal.jsonc");
    const template = fs.readFileSync(TEMPLATE, "utf8");
    fs.writeFileSync(file, setStringProperty(template, ["vars", "MCP_DEVICE_ID"], "other-mac"), { mode: 0o600 });
    assert.match(readPersonalConfig(file).problems.join(), /differ/);
    fs.writeFileSync(file, "{ nope");
    assert.match(readPersonalConfig(file).error, /cannot parse/);
    assert.equal(readPersonalConfig(path.join(dir, "missing.jsonc")).exists, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
