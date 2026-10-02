# Account pairing + Cloudflare Access (feature branch)

This document applies to the `feature/chatgpt-mobile-plugin-beta2` account-routing work. It is **not** an instruction to change the released beta.2 deployment yet.

## Goal

Use one authenticated identity boundary for both:

- ChatGPT's OAuth-authenticated MCP calls to `/mcp`; and
- the browser confirmation page at `/pair/claim`.

The relay still needs a small set of public endpoints because the Mac agent cannot complete an interactive Access login.

## Preferred Access shape

For this feature, prefer one Cloudflare Access application that protects the Worker and uses explicit public path overrides instead of creating unrelated Access applications with different audience tags.

Protected by Access:

- `/mcp`
- `/pair/claim`
- every other path not explicitly listed as public

Public at the Access edge, but independently authenticated/limited by the Worker:

- `/healthz` — harmless health probe
- `/.well-known/openai-apps-challenge` — plugin ownership challenge
- `/v1/device/*` — personal signed RPC, Ed25519 verified by Worker
- `/beta/device/*/status` — registry-device agent-signed status only; beta agent connection is `/v1/device/<beta-id>/connect`
- `/beta/mcp` — separate legacy beta connector route, authenticated/limited by the Worker
- `/beta/enroll` — invited enrollment; one-time invite + proof of key possession + rate limit
- `/pair/start` — proof-of-key-possession + short-lived session + rate limit
- `/pair/status` — short-lived pairing bearer only + rate limit

Do **not** make `/pair/claim` public. The origin requires a cryptographically verified Access assertion before it binds an external identity to a Mac.

## Why one Access application

The origin validates the Access JWT's issuer and audience. A single application gives `/mcp` and `/pair/claim` the same audience tag, so the same `TEAM_DOMAIN` + `POLICY_AUD` validation is sufficient.

It also means an authenticated browser session can confirm pairing without introducing a second identity namespace.

## Relay feature gates

The new paths/routing remain disabled unless all required flags/bindings are present:

```text
MCP_AUTH_MODE=access
ACCESS_DEVICE_ROUTING=registry
PAIRING_ENABLED=true
BETA_REGISTRY_ENABLED=true
BETA_REGISTRY=<D1 binding>
TEAM_DOMAIN=https://<team>.cloudflareaccess.com
POLICY_AUD=<Access application audience>
```

For closed testing, the Access policy should admit only the invited identities. Do not broaden the policy while the feature remains pre-release.

## Identity contract

The Worker trusts only the verified Access JWT and uses:

```text
issuer + subject → user_identities → owner → exactly one active device
```

Email is stored only as display/operational metadata. It is not the authorization key.

The MCP request cannot submit a device id.

## Pairing contract

`POST /pair/start` is intentionally public because an unpaired Mac does not have a user session yet. It is safe only because it requires possession of the proposed Mac's Ed25519 private key and creates no user/device authorization by itself.

`GET/POST /pair/claim` is the authority boundary. The installer opens exactly `/pair/claim`, with no credential in its URL. It then shows a separate five-minute, one-time browser code in a local macOS dialog. With a verified Access assertion, the browser POSTs that code. Review consumes the code once and returns a confirmation value bound to the verified issuer, subject, email, session device/key and `files-v1` scope. A second POST, with the explicit file-access checkbox, rechecks all of those inside the D1 batch that creates the identity→owner→device binding. Email alone, caller-selected device ids and a second active Mac are refused.

`GET /pair/status` only reveals the state of the one short-lived session represented by its high-entropy bearer. It reports `cancelled`, not `claimed`, once the bound identity, user or device is no longer active. The installer keeps that bearer in memory and never writes it to installer state, logs or the browser.

## Logging and redaction

The Worker writes no request logs. The template sets `observability.logs.invocation_logs = false`. If invocation/tail logging is enabled later, Cloudflare's default tail redaction replaces header values whose names contain `auth`, `jwt` or `token`. That covers the `/pair/status` bearer and the Access assertion. Request bodies (code and confirmation) are not part of tail events. No pairing credential is ever placed in a URL. Treat this as defense in depth and verify it in staging; it is not a guarantee about every Cloudflare product's logs.

## Rollout rule

Do not modify the current beta.2 Access application or deploy these flags until:

1. relay CI passes;
2. macOS installer CI passes;
3. migration replay on a disposable D1 database passes;
4. a disposable Worker/Access application proves `/mcp` and `/pair/claim` protected while every listed public override still works;
5. a real Mac completes pair → agent connect → ChatGPT MCP call → revoke.

Only then consider promotion.

## Latest verification and open gates

See `../../docs/CHATGPT-MOBILE-HANDOFF-2026-10-02.md`. Account pairing additionally requires coherent Access/registry routing, migrations 0006 and 0007, and the existing rate bindings. With the example limits, each pairing spends three to four `BETA_ENROLL_RATE` requests per browser/Mac address: start, code-entry page, code review and confirmation. Check that budget in staging. No new feature has been deployed. Real Access login/expiry redirects and fresh-account ChatGPT mobile acceptance remain rollout gates.
