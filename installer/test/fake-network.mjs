// Explicit test preload, never imported by production. No request can leave the process.
import fs from "node:fs";
import path from "node:path";
if (!process.env.FAKE_STATE_DIR) throw new Error("fake network requires a sandbox");
const team = "https://myteam.cloudflareaccess.com";
globalThis.fetch = async (input) => {
  const url = new URL(input);
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
  if (url.origin === team && url.pathname === "/.well-known/oauth-authorization-server") return json({
    issuer: team, authorization_endpoint: `${team}/cdn-cgi/access/oauth/authorization`,
    token_endpoint: `${team}/cdn-cgi/access/oauth/token`, registration_endpoint: `${team}/cdn-cgi/access/oauth/registration`,
    response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
  });
  if (url.origin !== "https://astra-bridge-relay.example-sub.workers.dev") throw new Error("unexpected test URL");
  if (url.pathname === "/healthz") return json({ ok: true, service: "astra-bridge-relay" });
  if (url.pathname.startsWith("/v1/device/") && url.pathname.endsWith("/status")) {
    const file = path.join(process.env.FAKE_STATE_DIR, "status.json");
    const status = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { ok: true, agentConnected: true, mcpHealthy: true, lastSeenAgeMs: 0 };
    return json(status, status.status ?? 200);
  }
  if (url.pathname === "/mcp") return json({}, 401, { "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/cloudflare-access-protected-resource/mcp"` });
  if (url.pathname === "/.well-known/cloudflare-access-protected-resource/mcp") return json({ resource: `${url.origin}/mcp`, protected: true, authorization_servers: [team], team_domain: "myteam.cloudflareaccess.com" });
  throw new Error("unhandled fake URL");
};
