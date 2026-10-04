import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateTargets, makeConfig } from "./render-config.mjs";

// Synthetic metadata only; no account, domain or email ownership is asserted.
const fixture = () => ({ account_id: "123456789abcdef0123456789abcdef0", worker_name: "astra-mobile-control-staging-20261003", origin: "https://astra-mobile-control-staging-20261003.synthetic-fixture.workers.dev", database_name: "astra-mobile-control-staging-registry-20261003", database_id: "12345678-1234-1234-1234-123456789abc", access_application_id: "23456789-1234-1234-1234-123456789abc", team_domain: "https://synthetic-fixture.cloudflareaccess.com", policy_aud: "1".repeat(64), allowed_emails: ["fixture-a@staging-mail.io", "fixture-b@staging-mail.io"], rate_namespace_ids: ["91001", "91002", "91003", "91004", "91005", "91006"], namespace_inventory_checked: true });
const script = fileURLToPath(new URL("./render-config.mjs", import.meta.url));
const migrations = ["0001_closed_beta_registry.sql", "0002_beta_enrollment_invites.sql", "0003_beta_agent_key_unique.sql", "0004_access_identities.sql", "0005_pairing_sessions.sql", "0006_pairing_claim_marker.sql", "0007_pairing_consent.sql", "0008_control_permissions.sql"];
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astra-staging-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "relay", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "relay", "migrations"));
  fs.writeFileSync(path.join(root, "relay", "src", "index.ts"), "// fixture\n");
  for (const name of migrations) fs.writeFileSync(path.join(root, "relay", "migrations", name), "-- fixture\n");
  const targets = path.join(root, "targets.json");
  return { root, targets, output: path.join(root, "relay", "wrangler.mobile-staging.local.jsonc"), run(value = fixture()) { fs.writeFileSync(targets, JSON.stringify(value)); return spawnSync(process.execPath, [script, targets, root], { encoding: "utf8" }); } };
}

test("rejects incomplete targets, invalid identifiers, unreviewed namespaces and examples", () => {
  assert.throws(() => validateTargets({}));
  for (const patch of [{ extra: true }, { account_id: "0".repeat(32) }, { database_id: "00000000-0000-0000-0000-000000000000" }, { access_application_id: "REPLACE" }, { policy_aud: "0".repeat(64) }, { allowed_emails: ["you@example.com"] }, { allowed_emails: ["a@domain.invalid"] }, { allowed_emails: ["A@staging-mail.io", "a@staging-mail.io"] }, { rate_namespace_ids: ["1", "2", "3", "4", "5", "5"] }, { rate_namespace_ids: ["0", "2", "3", "4", "5", "6"] }, { namespace_inventory_checked: false }]) assert.throws(() => validateTargets({ ...fixture(), ...patch }));
});
test("accepts only canonical staging and Access origins", () => {
  const good = fixture();
  for (const origin of [good.origin + "/", good.origin + "?x=1", good.origin + "#x", good.origin.replace("https:", "http:"), good.origin.replace("https://", "https://user@"), good.origin.replace("staging-20261003", "production"), good.origin.replace("workers.dev", "workers.dev.evil.org"), good.origin.replace("synthetic-fixture", "your-subdomain")]) assert.throws(() => validateTargets({ ...good, origin }));
  assert.throws(() => validateTargets({ ...good, team_domain: good.team_domain + "/" }));
  for (const email of ["a..b@staging-mail.io", "a@bad..domain.io", "a@-bad.domain.io"]) assert.throws(() => validateTargets({ ...good, allowed_emails: [email] }));
});
test("config has isolated bindings, rate limits and file-only control boundaries", () => {
  const c = makeConfig(fixture());
  assert.equal(c.main, "src/index.ts"); assert.equal(c.d1_databases[0].binding, "BETA_REGISTRY"); assert.equal(c.d1_databases[0].migrations_dir, "migrations");
  assert.equal(c.workers_dev, true); assert.equal(c.preview_urls, false);
  assert.deepEqual(c.migrations.map((m) => m.tag), ["v1", "v2"]);
  assert.deepEqual(c.ratelimits.map((r) => r.simple.limit), [5, 120, 1200, 60, 600, 6000]);
  assert.equal(c.vars.MCP_AUTH_MODE, "access"); assert.equal(c.vars.ACCESS_DEVICE_ROUTING, "registry"); assert.equal(c.vars.PAIRING_ENABLED, "true");
  assert.equal(c.vars.CONTROL_PERMISSIONS_ENABLED, "false"); assert.equal(c.vars.BETA_ENROLLMENT_ENABLED, "false");
  assert.equal(c.vars.AGENT_DEVICE_ID, "staging-personal-disabled"); assert.equal(c.vars.OAUTH_RESOURCE, `${fixture().origin}/mcp`);
  assert.equal(c.observability.logs.invocation_logs, false);
  for (const key of ["AGENT_PUBLIC_KEY_B64", "CLIENT_PUBLIC_KEY_B64", "MCP_BEARER_TOKEN", "OAUTH_OWNER_SECRET", "ALERT_EMAIL"]) assert.equal(key in c.vars, false);
  assert.equal("triggers" in c, false); assert.equal("send_email" in c, false);
});
test("invalid targets and missing migrations never create config", (t) => {
  const s = sandbox(t); assert.notEqual(s.run({}).status, 0); assert.equal(fs.existsSync(s.output), false);
  fs.unlinkSync(path.join(s.root, "relay", "migrations", migrations[7])); assert.notEqual(s.run().status, 0); assert.equal(fs.existsSync(s.output), false);
});
test("CLI writes privately once and accepts identical output without replacing it", (t) => {
  const s = sandbox(t); const first = s.run(); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /not deployment or Access verification/);
  const before = fs.statSync(s.output); assert.equal(before.mode & 0o777, 0o600);
  assert.equal(s.run().status, 0); const after = fs.statSync(s.output); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
});
test("CLI refuses different output and symlinks without modifying either", (t) => {
  const s = sandbox(t); fs.writeFileSync(s.output, "keep this\n"); assert.notEqual(s.run().status, 0); assert.equal(fs.readFileSync(s.output, "utf8"), "keep this\n");
  fs.unlinkSync(s.output); const elsewhere = path.join(s.root, "untouched.txt"); fs.writeFileSync(elsewhere, "untouched\n"); fs.symlinkSync(elsewhere, s.output);
  assert.notEqual(s.run().status, 0); assert.equal(fs.readFileSync(elsewhere, "utf8"), "untouched\n"); assert.equal(fs.lstatSync(s.output).isSymbolicLink(), true);
});
