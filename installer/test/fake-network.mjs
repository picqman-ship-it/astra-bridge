// Explicit test preload, never imported by production. No request can leave the process.
import fs from "node:fs";
import path from "node:path";
if (!process.env.FAKE_STATE_DIR) throw new Error("fake network requires a sandbox");
const team = "https://myteam.cloudflareaccess.com";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
  if (url.origin === team && url.pathname === "/.well-known/oauth-authorization-server") return json({
    issuer: team, authorization_endpoint: `${team}/cdn-cgi/access/oauth/authorization`,
    token_endpoint: `${team}/cdn-cgi/access/oauth/token`, registration_endpoint: `${team}/cdn-cgi/access/oauth/registration`,
    response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
  });
  if (url.origin !== "https://astra-bridge-relay.example-sub.workers.dev") throw new Error("unexpected test URL");
  if (url.pathname === "/beta/enroll") {
    if (init.method !== "POST" || init.redirect !== "error" || !/^Bearer abi1_[a-f0-9]{64}$/.test(init.headers?.authorization ?? "")) throw new Error("invalid enrollment request");
    const body = JSON.parse(init.body);
    if (Object.keys(body).sort().join(",") !== "agentPublicKeyB64,deviceId,proof,version" || body.version !== 1) throw new Error("unexpected enrollment material");
    const { createPublicKey, verify, createHash } = await import("node:crypto");
    const message = ["astra-beta-enroll-v1", url.origin, createHash("sha256").update(init.headers.authorization.slice(7)).digest("hex"), body.deviceId, body.agentPublicKeyB64].join("\n");
    const publicKey = createPublicKey({ key: Buffer.from(body.agentPublicKeyB64, "base64"), type: "spki", format: "der" });
    if (!verify(null, Buffer.from(message), publicKey, Buffer.from(body.proof, "base64"))) return json({ error: "enrollment_denied" }, 403);
    const saved = path.join(process.env.FAKE_STATE_DIR, "enrolled.json");
    if (fs.existsSync(saved)) return json({ error: "enrollment_denied" }, 403);
    fs.writeFileSync(saved, JSON.stringify({ deviceId: body.deviceId, agentPublicKeyB64: body.agentPublicKeyB64 }));
    if (fs.existsSync(path.join(process.env.FAKE_STATE_DIR, "lose-enroll-response"))) throw new Error("connection lost");
    return json({ ok: true }, 201);
  }
  if (url.pathname.startsWith("/beta/device/") && url.pathname.endsWith("/status")) {
    const saved = path.join(process.env.FAKE_STATE_DIR, "enrolled.json");
    if (!fs.existsSync(saved)) return json({ error: "unauthorized" }, 403);
    const device = JSON.parse(fs.readFileSync(saved, "utf8"));
    const { createPublicKey, verify, createHash } = await import("node:crypto");
    const headers = init.headers;
    const canonical = [headers["X-Astra-Timestamp"], headers["X-Astra-Nonce"], "GET", url.pathname, createHash("sha256").update("").digest("hex")].join("\n");
    const key = createPublicKey({ key: Buffer.from(device.agentPublicKeyB64, "base64"), type: "spki", format: "der" });
    if (url.pathname !== `/beta/device/${device.deviceId}/status` || !verify(null, Buffer.from(canonical), key, Buffer.from(headers["X-Astra-Signature"], "base64"))) return json({ error: "unauthorized" }, 403);
    const file = path.join(process.env.FAKE_STATE_DIR, "status.json");
    const status = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { ok: true, agentConnected: true, mcpHealthy: true };
    return json(status, status.status ?? 200);
  }
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
