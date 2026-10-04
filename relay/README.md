# Astra Bridge relay

Cloudflare Worker + `DeviceRelay` Durable Object that relays MCP calls from an AI client (for example ChatGPT) to your Mac over an outbound, authenticated WebSocket opened by the Mac agent. A separate Ed25519-signed RPC is available at `/v1/device/:deviceId/{connect,rpc,status}` for the agent and for operator tools such as the smoke test.

Setup from scratch is described in the [top-level README](../README.md). Cloudflare Access configuration is in [docs/SETUP-ACCESS.md](docs/SETUP-ACCESS.md).

## Streamable HTTP MCP endpoint

`POST /mcp` is a stateless, standards-compliant MCP Streamable HTTP endpoint. It supports `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`; the latter two are forwarded through the Durable Object and the agent, exposing the 31 reviewed downstream tools (see `src/tool-policy.ts`).

It has no CORS headers (and specifically no wildcard CORS). How a client authenticates depends on `MCP_AUTH_MODE`:

- `access` (template default): Cloudflare Access Managed OAuth. This is the mode to use with ChatGPT, which cannot send a custom API key or header.
- `static`: a Worker secret bearer token (`MCP_BEARER_TOKEN`) for operator testing, plus the Worker's own single-owner OAuth server.

In `static` mode clients send:

```http
Authorization: Bearer <MCP_BEARER_TOKEN>
Accept: application/json, text/event-stream
Content-Type: application/json
```

The token is a Worker secret, not the Ed25519 client key. Never put it in `wrangler.jsonc`, source, logs, or a client configuration committed to git:

```sh
openssl rand -base64 48 | npx wrangler secret put MCP_BEARER_TOKEN
```

`MCP_DEVICE_ID` is the non-secret device name the MCP endpoint routes to. It must equal the agent's `ASTRA_DEVICE_ID`. A request can never choose another device.

## Built-in OAuth 2.1 (static mode, single owner)

Used only in `MCP_AUTH_MODE=static`; in `access` mode these routes return 404.

The Worker is a single-owner OAuth 2.1 authorization server (authorization code + PKCE S256), implemented in `src/oauth.ts` (endpoints) and `src/oauth-store.ts` (`OAuthStore` Durable Object). The static `MCP_BEARER_TOKEN` is still accepted on `/mcp` for operator smoke tests and is checked first.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource`, `…/oauth-protected-resource/mcp` | RFC 9728 metadata for resource `OAUTH_RESOURCE` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata for issuer `OAUTH_ISSUER` (no registration endpoint, `token_endpoint_auth_methods_supported: ["none"]`, `authorization_response_iss_parameter_supported`, `client_id_metadata_document_supported`) |
| `GET/POST /oauth/authorize` | Consent form; the owner enters `OAUTH_OWNER_SECRET` |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants |

- Only `client_id=https://chatgpt.com/oauth/client.json` with `redirect_uri=https://chatgpt.com/connector_platform_oauth_redirect` is accepted. `resource` must equal `OAUTH_RESOURCE` exactly in the authorization request and code exchange. Every authorization redirect, including errors, carries `iss`.
- Scopes come from `TOOL_SCOPE` in `src/tool-policy.ts`: `astra.read` (read-only file tools), `astra.write` (file/search-state mutations) and `astra.control` (process, job, GUI and recent-call tools). Every listed tool advertises `securitySchemes: [{ type: "oauth2", scopes: [...] }]`. `tools/list` hides tools outside the token's scopes, and `tools/call` refuses them with `_meta["mcp/www_authenticate"]`.
- Lifetimes: codes 5 min (one presentation only; a replay revokes what was issued), access tokens 1 h, refresh grants 30 days from authorization (rotation does not extend the grant; reusing a rotated refresh token revokes the grant). Tokens are `astra_at_`/`astra_rt_` + 32 random bytes. Only their SHA-256 hashes are stored.
- Owner secret: 5 failed attempts per 15 minutes, counted globally, after which even the correct secret is refused until the window ends.
- Kill switch: deleting `OAUTH_OWNER_SECRET` disables authorization, token issuance and every existing OAuth access token immediately. The operator bearer is unaffected.

This is **not** a multi-user identity system. Prefer `access` mode.

## Cloudflare Access mode (Managed OAuth)

Cloudflare Access authenticates you with your Zero Trust identity provider and an exact email Allow rule, then issues and refreshes the OAuth tokens the client holds. It forwards allowed requests with a signed `Cf-Access-Jwt-Assertion`. The Worker validates the signature, issuer, audience and owner email itself (`src/access-auth.ts`).

| Var | Value |
|---|---|
| `MCP_AUTH_MODE` | `access` in the template; `static` only when unset or explicitly selected. Unknown values make `/mcp` return 503 and disable the Worker's OAuth routes. |
| `TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com`. This is the JWT issuer; the JWKS is fetched from `<TEAM_DOMAIN>/cdn-cgi/access/certs`. |
| `POLICY_AUD` | The Access application's Audience (AUD) tag. |
| `ACCESS_ALLOWED_EMAILS` | Optional comma-separated allowlist, checked in addition to the Access policy. |

In `access` mode:

- `/mcp` requires `Cf-Access-Jwt-Assertion`. It is verified with jose `createRemoteJWKSet` + `jwtVerify`: RS256 only, exact `iss` = `TEAM_DOMAIN`, `aud` containing `POLICY_AUD`, `exp`/`nbf` with 60 s tolerance, and non-empty `sub` and `email`. Service-token assertions carry no email and are refused.
- `Authorization`, `Cf-Access-Authenticated-User-Email` and the `CF_Authorization` cookie are never read. The static `MCP_BEARER_TOKEN` and the Worker's own OAuth tokens are **not** accepted, and there is no fallback.
- Missing, placeholder or invalid config returns 503 (the committed template config fails closed until you fill it in). A missing or invalid assertion, or an unreachable JWKS, returns a fixed JSON-RPC 401 with no `WWW-Authenticate` and no verification detail.
- The Worker's own `/oauth/*` and `/.well-known/oauth-*` routes return 404, because Access is the authorization server.
- `/healthz`, `/.well-known/openai-apps-challenge` and signed `/v1/device/*` RPC behave exactly as in static mode. Only `/mcp` is protected by the Access application, so no Bypass policy is needed. Signed RPC keeps its Ed25519 authentication.
- Access advertises `/.well-known/cloudflare-access-protected-resource/mcp` in its 401 challenge; that metadata points to the team OAuth server and works with the path-scoped application.

Dashboard steps: [docs/SETUP-ACCESS.md](docs/SETUP-ACCESS.md).

## Trust boundary

```text
MCP client --OAuth--> Access --verified JWT--> Worker /mcp --> DeviceRelay
                                                        --agent WebSocket--> Mac agent --> mcp-commander

signed client --Ed25519 signature--> Worker /v1/device/... --> DeviceRelay --> same agent
```

After Access JWT verification, the Worker calls `mcpRpc` on the `DeviceRelay` Durable Object for the fixed `MCP_DEVICE_ID`. The MCP request cannot choose a device ID. Cloudflare receives only public keys for signed RPC verification; Ed25519 private keys stay on the Mac in `~/.astra-bridge`.

**Trust model (single owner).** The authenticated Access owner, the holder of the Ed25519 client key, or whoever controls the Cloudflare account/Worker has remote-shell-equivalent control of the Mac as the logged-in user (`start_process`, `job_start`, GUI tools when enabled). The agent executes what the relay sends. The static bearer alone is refused in Access mode. See [../SECURITY.md](../SECURITY.md).

The repository also contains an optional multi-device registry (`beta-registry.ts`, `agent-auth.ts`, `migrations/`, `wrangler.beta.example.jsonc`). It stays inert unless you enable it with `BETA_REGISTRY_ENABLED` and a D1 database, and even then its principals are refused on `/mcp` and cannot reach your configured device. You can ignore it for a single-Mac setup.

Authenticated beta principals use `/beta/mcp`, with a beta-only authenticator, explicit file-tool allowlist, metadata-only audit and mandatory provider rate bindings before D1. Beta UUIDs cannot share personal device namespaces. Personal credentials are refused on that route; personal `/mcp` behavior is unchanged.

Compatibility note: existing personal `beta-*` IDs remain valid while `BETA_REGISTRY_ENABLED` is disabled. Rename them before enabling beta; the enabled registry reserves the entire prefix even if D1 is misconfigured. Installer doctor exposes this condition. Beta rate admission now needs six bindings with client-first checks and separate enrollment, agent and MCP budgets; merge the updated example into ignored `wrangler.beta.local.jsonc` before a separately authorized rollout.

Invited testers can use the [closed-beta device enrollment flow](docs/BETA-ENROLLMENT.md), separately gated by `BETA_ENROLLMENT_ENABLED` (off by default; onboarding windows only). A private relay-bound invite artifact and versioned key-possession proof register a file-only device without Cloudflare credentials or a connector token. Operator tooling binds subsequent connector authorization to the redeemed device ID and tester-confirmed full agent fingerprint.

## Limits and failure handling

| Area | Behavior |
|---|---|
| Tool allowlist | Only the 31 reviewed tools in `src/tool-policy.ts` are listed on `/mcp` and callable anywhere: calls are checked both in `/mcp` and in the Durable Object, so signed RPC cannot call other tools either (signed-RPC `tools/list` returns the raw downstream list). `set_config_value` is explicitly excluded. Unknown downstream tools are dropped from `/mcp`'s `tools/list`. |
| Idempotency | `create_directory`, `write_file`, `edit_block`, `move_file`, `start_process`, `interact_with_process`, `force_terminate`, `kill_process`, `press_element`, `set_element_value` and `job_start` require an `idempotencyKey` (8–200 chars). `/mcp` marks it as `required` in their schemas. If a gated tool's downstream schema stops declaring `idempotencyKey`, the tool is hidden rather than exposed. Nothing is retried automatically. |
| Body size | `/mcp` 64 KiB, signed RPC 512 KiB. The actual streamed bytes are counted; Content-Length is only used as an early reject. JSON-RPC batches are rejected. |
| Backpressure | Up to 8 pending RPCs per device (then 429). 240 client requests/min, with a separate 240/min bucket for agent connects. The agent runs at most 4 tool calls at once (then `agent_busy`). |
| Frames | 1 MiB in both directions; an oversized agent frame closes that socket. |
| Health | `agentConnected` requires the current socket, `mcpHealthy=true` from the agent's last state message, and a sign of life within the last 75 s. The agent sends `{"type":"ping"}` every 30 s; the Durable Object answers it with `{"type":"pong"}` through `setWebSocketAutoResponse`, which does **not** wake the object (no billable duration), and reads the time back with `getWebSocketAutoResponseTimestamp`. The agent probes its local MCP server every 10 s (restarting it after two failed probes or when the transport dies) but sends a `heartbeat` state message only when the result changes or every 10 min. So an idle connection hibernates instead of keeping the object awake around the clock. |
| Reconnect | https and the pinned host only. The handshake has a timeout. Relay liveness is checked via pongs (75 s); it arms only after the first pong, so an agent against an older relay without the auto-response is never disconnected in a loop. Backoff is exponential with jitter and resets only after 30 s of stable connection. |
| Alerts | A cron every 5 min checks the device. After two consecutive unhealthy checks it emails you once (repeat at most every 6 h while down) and once more when it recovers. Optional: requires the `send_email` binding (see `wrangler.jsonc`); without it the check is a no-op. |
| Replay | Each request's nonce is stored for 120 s (the timestamp window is ±60 s) and pruned by an alarm. Nonces are never evicted by count. |
| Errors | Clients only see fixed codes (for example `idempotency_key_required`, `agent_timeout`, `tool_failed`). Raw agent or downstream error text is never forwarded. Tool results with `isError` pass through as normal tool output. |

MCP requests are POST-only, require JSON and use no persistent MCP session. The relay waits 30 s for the agent; the agent's tool timeout is 28 s.

## Mac agent configuration

`src/agent.mjs` reads everything from its environment (set in the LaunchAgent plist that `scripts/install-agent.mjs` renders) and has no defaults for the relay or device. `agentConfig()` in `src/agent-lib.mjs` validates it at startup and exits with a clear error if a required value is missing.

| Variable | Required | Default |
|---|---|---|
| `ASTRA_RELAY_URL` | yes | — (`https://<worker host>`) |
| `ASTRA_RELAY_HOST` | yes | — (must equal the URL's host; pinned) |
| `ASTRA_DEVICE_ID` | yes | — (`[a-zA-Z0-9._-]{1,96}`; must match the Worker's `AGENT_DEVICE_ID`) |
| `ASTRA_AGENT_KEY_FILE` | no | `~/.astra-bridge/agent-private.pem` |
| `ASTRA_NODE` | no | the Node binary running the agent |
| `ASTRA_COMMANDER_ENTRY` | no | `~/projects/mcp-commander/dist/remote-stdio.js`; `install-agent.mjs` sets it to this repository's `mcp-commander/dist/remote-stdio.js` |
| `ASTRA_COMMANDER_REMOTE_DIR` | no | `~/.mcp-commander-remote` |

Helper scripts (run with `node`, from the repository root):

- `relay/scripts/keygen.mjs` creates the agent and client Ed25519 key pairs in `~/.astra-bridge` (0700/0600, never overwrites) and prints the public keys for `wrangler.jsonc`.
- `relay/scripts/install-agent.mjs` renders the LaunchAgent plist from `templates/astra-bridge-agent.plist.template`. It only prints by default; `--install` writes the file and prints the `launchctl` command for you to run.

The agent starts mcp-commander with the MCP SDK default environment plus `MCP_COMMANDER_PROTECTED_PATHS`: its own code directory (this repository, wherever it is cloned), the key file's directory when `ASTRA_AGENT_KEY_FILE` points outside `~/.astra-bridge`, and any entries already set for the agent. mcp-commander refuses a root that is, contains or is inside a protected path, so a root can never expose the agent's code or keys; it also protects `~/.astra-bridge` by default (see `commanderEnv()` in `src/agent-lib.mjs`).

## Local verification

```sh
npm install
npm run typecheck
npm test
```

`npm test` is deterministic and does not contact Cloudflare, the Mac agent, or private keys. `test/build.mjs` bundles the TypeScript sources and maps `cloudflare:workers` and `cloudflare:email` to stubs, so the tests run the real Worker `fetch`/`scheduled` handlers and a real `DeviceRelay` against a fake Durable Object state and fake WebSockets. The tests cover:

- `test/mcp.test.mjs`: the MCP protocol and bearer auth, plus the beta registry helpers.
- `test/oauth.test.mjs`: OAuth metadata, authorize/token validation, owner rate limiting, PKCE, code and refresh single-use, scopes, token hygiene, CORS/methods, store cleanup, and a `wrangler deploy --dry-run` build.
- `test/access.test.mjs`: auth mode and Access config parsing; JWT verification against a local JWKS (valid owner, wrong `aud`/`iss`, forged/unknown key, HS256, expired, service token, allowlist); the Worker in Access mode through the real `createRemoteJWKSet` with a mocked JWKS endpoint; no fallback to the static bearer or owner OAuth; fail-closed config, including the committed placeholder `wrangler.jsonc`.
- `test/relay.test.mjs`: Worker routing, the allowlist, the idempotency gate, body limits, health and the ping auto-response, socket replacement, pending caps, send races, timeouts, replay and rate buckets, signed RPC, and liveness alerting.
- `test/tool-policy.test.mjs`: the reviewed tool policy.
- `test/agent-lib.test.mjs`: agent configuration and URL pinning, backoff, liveness, the concurrency gate, error classification, and MCP child supervision.
- `test/demo-agent.test.mjs`: the sandboxed review/demo agent (`src/demo-*.mjs`), which never touches a real Mac.

Real Cloudflare hibernation and WebSocket delivery semantics are not exercised locally.

The live signed-RPC smoke test is opt-in because it performs harmless but real file and job actions on your Mac:

```sh
ASTRA_RELAY_URL=https://<your-worker>.<your-subdomain>.workers.dev \
ASTRA_DEVICE_ID=my-mac \
ASTRA_SMOKE_WORKSPACE=/Users/<you>/remote-workspace \
npm run smoke
```

`ASTRA_SMOKE_WORKSPACE` must be inside mcp-commander's configured roots. The client key defaults to `~/.astra-bridge/client-private.pem` (override with `ASTRA_CLIENT_KEY_FILE`). In file-only mode the job checks are skipped; set `ASTRA_SMOKE_EXPECTED_TOOLS` to enforce an exact tool count.

Two more opt-in live checks, run with `node` and the same `ASTRA_RELAY_URL` / `ASTRA_DEVICE_ID`:

- `src/security-smoke.mjs`: a foreign device, a missing signature and an oversized body are rejected (plus `ASTRA_SMOKE_WORKSPACE` for a write that must be refused).
- `src/oauth-live-smoke.mjs`: exercises the built-in OAuth server; only meaningful in `static` mode and needs the owner secret in a file (`ASTRA_OAUTH_OWNER_SECRET_FILE`).

## Deployment

Keep your real values in `wrangler.personal.jsonc` (a gitignored copy of `wrangler.jsonc`; the committed file stays a template and `npm test` checks that it only holds placeholders). After local verification passes:

```sh
npm run deploy:dry-run
npm run deploy          # wrangler deploy -c wrangler.personal.jsonc
```

When updating an existing install, deploy the Worker **before** restarting the Mac agent: the relay also accepts the older 10 s JSON heartbeat, so an older agent keeps working against a newer relay, but a newer agent relies on the relay's ping auto-response. When rolling back, roll back the agent first (restore `src/agent.mjs` and restart the LaunchAgent), then the Worker. `src/agent-lib.mjs` must sit next to `src/agent.mjs`.

This repository does not deploy automatically and never touches your LaunchAgents or `~/.astra-bridge` keys unless you run the helper scripts or `./install-macos.sh` yourself (the installer asks before it deploys or loads the agent).
