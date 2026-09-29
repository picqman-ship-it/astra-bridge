# Cloudflare Access (Managed OAuth) setup

ChatGPT connectors cannot send a custom API key or header, so the relay's `/mcp` endpoint is protected by **Cloudflare Access with Managed OAuth**. Access is the OAuth authorization server: it logs you in, issues and refreshes the tokens ChatGPT holds, and forwards each allowed request with a signed `Cf-Access-Jwt-Assertion`. The Worker verifies that assertion itself (`src/access-auth.ts`); it never trusts the edge alone.

Only `/mcp` is put behind Access. `/healthz`, `/.well-known/openai-apps-challenge` and the Ed25519-signed `/v1/device/*` routes (used by the Mac agent and the smoke test) stay outside Access and keep their own authentication, so **no Bypass policies are needed**.

Cloudflare dashboard labels change over time. If a label below differs, the setting it describes is still the one to change.

In the steps below, `<worker-host>` is your Worker's hostname, for example `astra-bridge-relay.<your-subdomain>.workers.dev`.

## 1. Zero Trust and your team domain

1. Open the Zero Trust dashboard (`one.dash.cloudflare.com`). The Free plan is enough for a single owner.
2. **Settings → Team name and domain**: note `<team>.cloudflareaccess.com`. This becomes `TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"`.
3. **Settings → Authentication → Login methods**: make sure you have a login method you can use (your existing identity provider, or **One-time PIN** by email).

## 2. Access application for `/mcp` only

**Access → Applications → Add an application → Self-hosted**:

- **Name**: anything, for example `Astra Bridge`.
- **Destination / public hostname**: `<worker-host>`, **path** `mcp`. Only this path is protected.
- **Login methods**: pick the one from step 1. Turn off "Accept all available identity providers".
- **Policy**: Action **Allow**, Include → **Emails** → your email address only. Press Enter so the email is actually added before saving (an empty Include is rejected). No "Everyone", no email-domain rule, no service-token rule.
- **Session duration**: 24 h or less.

## 3. Managed OAuth on the same application

In the application's settings, enable **Managed OAuth** (OAuth for non-browser / MCP clients):

- **Allowed redirect / callback URLs**: ChatGPT shows the exact callback URL when you add the connector (it looks like `https://chatgpt.com/connector/oauth/<id>`). Add that exact URL. Managed OAuth also accepts HTTPS wildcards in the path, so `https://chatgpt.com/connector/oauth/*` works if you reconnect often.
- **Localhost / loopback callbacks**: off.
- **Access token lifetime**: short (for example 10 minutes). **Grant / refresh lifetime**: for example 2 weeks; you sign in again when it ends.

## 4. Copy the AUD tag into your personal config

Open the application → **Overview / Basic information** → **Application Audience (AUD) Tag** (a 64-character hex value). In `relay/wrangler.personal.jsonc` (your gitignored copy of `wrangler.jsonc`) → `vars` (none of these are secrets):

```jsonc
"MCP_AUTH_MODE": "access",
"TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
"POLICY_AUD": "<64-hex AUD tag>",
"ACCESS_ALLOWED_EMAILS": "you@example.com"   // optional second check at the Worker, recommended
```

Until these hold real values the Worker fails closed: `/mcp` returns 503.

Then:

```sh
cd relay
npm run typecheck && npm test && npm run deploy:dry-run
npm run deploy
```

## 5. Check it

```sh
curl -si -X POST https://<worker-host>/mcp        # expect a 401 challenge from Access, not the Worker's JSON
curl -s  https://<worker-host>/healthz            # expect {"ok":true,...} (outside Access)
```

With the agent running, the signed smoke test (see `relay/README.md`) should report `agentConnected: true`.

## 6. Connect ChatGPT

In ChatGPT, add a custom connector / app (developer mode) with:

- **MCP server URL**: `https://<worker-host>/mcp`
- **Authentication**: OAuth

ChatGPT discovers Access's OAuth metadata from the 401 challenge and registers itself. You log in through Access, approve the connection, and `tools/list` should return the reviewed tools. In a chat, select the app (for example `@Astra Bridge`) to use it.

## Turning it off or rolling back

- To cut access at once: disable the Access application (or delete the Worker) and stop the Mac agent.
- To switch to the Worker's built-in `static` mode instead: it needs the `MCP_BEARER_TOKEN` and `OAUTH_OWNER_SECRET` Worker secrets and a real `OAUTH_ISSUER`/`OAUTH_RESOURCE` (see `relay/README.md`); without them `/mcp` rejects everyone. Set `MCP_AUTH_MODE` to `"static"`, deploy, then disable the Access application, otherwise the edge keeps blocking requests before they reach the Worker. Note that static mode's OAuth only accepts ChatGPT's older fixed callback, so Access mode is the recommended path.
