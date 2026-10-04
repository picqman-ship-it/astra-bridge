import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = "astra-mobile-control-staging-20261003";
const DATABASE = "astra-mobile-control-staging-registry-20261003";
const OUTPUT = "wrangler.mobile-staging.local.jsonc";
const FIELDS = ["account_id", "worker_name", "origin", "database_name", "database_id", "access_application_id", "team_domain", "policy_aud", "allowed_emails", "rate_namespace_ids", "namespace_inventory_checked"];
const RATES = [["BETA_ENROLL_RATE", 5], ["BETA_REQUEST_RATE", 120], ["BETA_MCP_RATE", 1200], ["BETA_ENROLL_GLOBAL_RATE", 60], ["BETA_AGENT_GLOBAL_RATE", 600], ["BETA_MCP_GLOBAL_RATE", 6000]];
const MIGRATIONS = ["0001_closed_beta_registry.sql", "0002_beta_enrollment_invites.sql", "0003_beta_agent_key_unique.sql", "0004_access_identities.sql", "0005_pairing_sessions.sql", "0006_pairing_claim_marker.sql", "0007_pairing_consent.sql", "0008_control_permissions.sql"];
const requireValue = (valid, field) => { if (!valid) throw new Error(`Invalid or missing ${field}`); };
const nonzeroHex = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "i").test(value) && /[1-9a-f]/i.test(value);
const uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) && /[1-9a-f]/i.test(value);

export function validateTargets(targets) {
  requireValue(targets && typeof targets === "object" && !Array.isArray(targets), "targets object");
  requireValue(Object.keys(targets).sort().join(",") === [...FIELDS].sort().join(","), "target fields");
  requireValue(nonzeroHex(targets.account_id, 32), "account_id");
  requireValue(targets.worker_name === WORKER, "worker_name");
  requireValue(targets.database_name === DATABASE, "database_name");
  requireValue(uuid(targets.database_id), "database_id");
  requireValue(uuid(targets.access_application_id), "access_application_id");
  requireValue(nonzeroHex(targets.policy_aud, 64), "policy_aud");
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  requireValue(typeof targets.origin === "string" && new RegExp(`^https://${WORKER}\\.${label}\\.workers\\.dev$`).test(targets.origin), "origin");
  requireValue(typeof targets.team_domain === "string" && new RegExp(`^https://${label}\\.cloudflareaccess\\.com$`).test(targets.team_domain), "team_domain");
  requireValue(!/replace|placeholder|your-|approved-|example/i.test(targets.origin + targets.team_domain), "real origin and team_domain");
  requireValue(Array.isArray(targets.allowed_emails) && targets.allowed_emails.length >= 1 && targets.allowed_emails.length <= 2, "allowed_emails");
  const emails = targets.allowed_emails.map((email) => {
    requireValue(typeof email === "string" && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(email), "allowed_emails identity");
    const [local, domain] = email.split("@");
    requireValue(email.length <= 254 && local.length <= 64 && !/^\.|\.$|\.\./.test(local) && new RegExp(`^${label}(?:\\.${label})+$`, "i").test(domain), "allowed_emails identity syntax");
    requireValue(!/(?:^|[.@])(?:example\.(?:com|net|org)|invalid|example|test|localhost)$/i.test(email) && !/replace|placeholder|your-email/i.test(email), "real approved identity");
    return email.toLowerCase();
  });
  requireValue(new Set(emails).size === emails.length, "distinct allowed_emails");
  requireValue(Array.isArray(targets.rate_namespace_ids) && targets.rate_namespace_ids.length === 6 && targets.rate_namespace_ids.every((id) => typeof id === "string" && /^[1-9][0-9]*$/.test(id)) && new Set(targets.rate_namespace_ids).size === 6, "rate_namespace_ids");
  requireValue(targets.namespace_inventory_checked === true, "namespace_inventory_checked");
  return { ...targets, allowed_emails: emails, rate_namespace_ids: [...targets.rate_namespace_ids] };
}

export function makeConfig(input) {
  const t = validateTargets(input);
  return {
    account_id: t.account_id, name: t.worker_name, main: "src/index.ts", compatibility_date: "2026-09-27",
    durable_objects: { bindings: [{ name: "DEVICE_RELAY", class_name: "DeviceRelay" }, { name: "OAUTH_STORE", class_name: "OAuthStore" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["DeviceRelay"] }, { tag: "v2", new_sqlite_classes: ["OAuthStore"] }],
    d1_databases: [{ binding: "BETA_REGISTRY", database_name: t.database_name, database_id: t.database_id, migrations_dir: "migrations" }],
    ratelimits: RATES.map(([name, limit], i) => ({ name, namespace_id: t.rate_namespace_ids[i], simple: { limit, period: 60 } })),
    vars: {
      MCP_AUTH_MODE: "access", ACCESS_DEVICE_ROUTING: "registry", PAIRING_ENABLED: "true",
      BETA_REGISTRY_ENABLED: "true", BETA_ENROLLMENT_ENABLED: "false", CONTROL_PERMISSIONS_ENABLED: "false",
      TEAM_DOMAIN: t.team_domain, POLICY_AUD: t.policy_aud, ACCESS_ALLOWED_EMAILS: t.allowed_emails.join(","),
      AGENT_DEVICE_ID: "staging-personal-disabled", CLIENT_DEVICE_ID: "staging-personal-disabled", MCP_DEVICE_ID: "staging-personal-disabled",
      OAUTH_ISSUER: t.origin, OAUTH_RESOURCE: `${t.origin}/mcp`,
    },
    observability: { enabled: true, logs: { invocation_logs: false } },
  };
}

function render(targetsFile, sourceRoot) {
  const config = makeConfig(JSON.parse(fs.readFileSync(targetsFile, "utf8")));
  const relay = path.join(path.resolve(sourceRoot), "relay");
  for (const directory of [path.resolve(sourceRoot), relay, path.join(relay, "src"), path.join(relay, "migrations")]) {
    requireValue(fs.lstatSync(directory).isDirectory(), "regular source directory");
  }
  for (const file of [path.join(relay, "src", "index.ts"), ...MIGRATIONS.map((name) => path.join(relay, "migrations", name))]) {
    requireValue(fs.lstatSync(file).isFile(), "source entry or migrations 0001–0008");
  }
  const output = path.join(relay, OUTPUT);
  const bytes = `// Generated offline. Access configuration and resource identities remain unverified.\n${JSON.stringify(config, null, 2)}\n`;
  try {
    fs.writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const fd = fs.openSync(output, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      requireValue(stat.isFile() && stat.size === Buffer.byteLength(bytes) && fs.readFileSync(fd, "utf8") === bytes, "existing output; refusing overwrite");
    } finally { fs.closeSync(fd); }
  }
  console.log(`Config generated offline: ${output}\nThis is not deployment or Access verification.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node render-config.mjs TARGETS_JSON SOURCE_ROOT");
    render(process.argv[2], process.argv[3]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
