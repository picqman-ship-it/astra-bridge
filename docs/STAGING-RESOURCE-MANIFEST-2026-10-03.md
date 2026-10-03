# Proposed isolated staging resources — 2026-10-03

**Status: proposal only; every resource below is uncreated/unapproved.** No deployment, live D1 query or migration, Access/Cloudflare change, account creation, Mac installation, permission elevation or publication is authorized by this file.

The existing [fresh-account acceptance plan](CHATGPT-MOBILE-ACCEPTANCE-2026-10-02.md) remains the baseline. Run its file-only sequence first. The separate terminal/GUI sequence below needs explicit approval for those capabilities and their effects on the named test Mac.

## Available public/source metadata

| Item | Observed source metadata |
|---|---|
| Repository / development branch | `picqman-ship-it/astra-bridge` / `feature/chatgpt-mobile-plugin-beta2` |
| Worker entry / compatibility date | `relay/src/index.ts` / `2026-09-27` |
| Durable Objects | `DEVICE_RELAY` → `DeviceRelay`; `OAUTH_STORE` → `OAuthStore`; migration tags `v1`, `v2` |
| Registry / schema | D1 binding `BETA_REGISTRY`; reviewed migrations 0001–0008 |
| Public release trust | `installer/lib/beta-trust.mjs` has `BETA_RELAY_ORIGIN = null`; origin must be pinned in a reviewed release copy |
| Logging template | `observability.enabled = true`, `observability.logs.invocation_logs = false`; no live logging setting was inspected |
| Runtime packages | Relay/installer `0.1.0`; mcp-commander `0.3.0`; locked npm dependencies |
| Actual staging identifiers | No actual staging account ID, Worker hostname, D1 ID, Access application ID/AUD or test account/Mac identifier is present in the inspected versioned configuration/docs |

These values come from the source template and versioned docs, not a Cloudflare inventory. Existing placeholders such as `my-mac`, `you@example.com` and `<your-subdomain>` are examples, not approved resources. Private config, environment, Keychain, credential stores and live identity rows were not inspected.

## Specific proposed resource set

| Resource | Proposed name / location | Required owner-supplied binding before use |
|---|---|---|
| Cloudflare account | Owner-selected isolated staging account | Exact account ID; explicitly exclude the current owner/beta.2 deployment |
| Worker | `astra-mobile-control-staging-20261003` | Newly created Worker identity and workers.dev subdomain in the approved account |
| HTTPS origin | `https://astra-mobile-control-staging-20261003.<approved-staging-subdomain>.workers.dev` | Replace the placeholder only with the authorized exact canonical origin |
| D1 database | `astra-mobile-control-staging-registry-20261003` | Newly created database ID, bound only as `BETA_REGISTRY` to the proposed Worker |
| Access application | `Astra Mobile Control Staging 2026-10-03` | Newly created application ID/AUD and exact team issuer; one identity boundary for claim + MCP |
| Access allow policy | `Astra Mobile Control Staging A-B Only` | Exact human-approved test identities A/B; deny unrelated identities |
| Test account A | `astra-stage-account-a` | Fresh human-created account, actual provider/issuer/subject and ChatGPT plan/workspace; no credentials in evidence |
| Test account B | `astra-stage-account-b` | Separate approved identity for cross-account rejection; no shared credential |
| Test Mac A | `Astra-Stage-Mac-A`, dedicated local user `astra-stage-a` | Actual approved hardware/macOS user; staged LaunchAgent only; existing owner installation excluded |
| Test Mac B | `Astra-Stage-Mac-B`, dedicated local user `astra-stage-b` | Separate approved Mac for routing/cross-account checks; no owner Mac substitution |
| Approved folder A | `/Users/astra-stage-a/remote-workspace/astra-mobile-acceptance-20261003` | Human confirms exact folder; create only non-secret acceptance fixtures there |
| Approved folder B | `/Users/astra-stage-b/remote-workspace/astra-mobile-acceptance-20261003` | Separate non-secret marker folder; A's actions must have no effect here |
| iPhone | `Astra-Stage-iPhone-A` | Actual approved iPhone, iOS/ChatGPT versions, fresh account A and offered integration surface |

Names are concrete proposals, not evidence that a resource exists. The owner must name the actual IDs and devices before any live action. No serial numbers, personal accounts or credential inventory is needed in this source proposal.

The six rate-limit bindings must use unused positive-integer namespace IDs in the approved account. Candidate IDs below are **unallocated and unverified**; do not reuse them until uniqueness is checked as part of the separately approved configuration review.

| Binding | Candidate namespace | Source example requests/minute |
|---|---:|---:|
| `BETA_ENROLL_RATE` | 2026100301 | 5 |
| `BETA_REQUEST_RATE` | 2026100302 | 120 |
| `BETA_MCP_RATE` | 2026100303 | 1200 |
| `BETA_ENROLL_GLOBAL_RATE` | 2026100304 | 60 |
| `BETA_AGENT_GLOBAL_RATE` | 2026100305 | 600 |
| `BETA_MCP_GLOBAL_RATE` | 2026100306 | 6000 |

Keep source limits initially; observe start/review/confirmation and signed permission-recovery rate budgets during approved staging. Do not weaken a gate to obtain a pass.

## Reviewed configuration and release copy

The proposed isolated configuration enables `MCP_AUTH_MODE=access`, `ACCESS_DEVICE_ROUTING=registry`, `PAIRING_ENABLED=true`, `BETA_REGISTRY_ENABLED=true` and `CONTROL_PERMISSIONS_ENABLED=true`, with the exact approved issuer/AUD and the D1/rate bindings above. Keep invited enrollment off unless separately included in the approved test. Personal-device placeholders must never point to the existing owner Mac.

Protect `/mcp`, `/pair/claim` and other non-public paths with the single Access application. Public-edge exceptions are the reviewed list in [Access setup](../relay/docs/ACCOUNT-PAIRING-ACCESS.md), including `/control/device/*`; that control path still requires fresh signatures from the exact active registry Mac. Verify every override in staging. No Access setting has been applied.

After the final source commit and local packaged-source gate, derive a separate staging release copy with:

```sh
node installer/pin-beta-release.mjs EXTRACTED_RELEASE_ROOT APPROVED_HTTPS_ORIGIN
```

This is an offline origin pin, not deployment. The derived copy has different bytes: rebuild/record its own checksum and reverify it before installation. Keep the canonical committed-source archive, derived staging archive and their hashes distinct. Both remain local, unsigned and non-notarized.

## Approval scope and acceptance record

The approval must explicitly include the exact account/Worker/D1/Access IDs, migrations 0001–0008, configuration diff, origin pin, test accounts A/B, both Macs/users, approved folders, iPhone, staged installation, identity pairing, optional terminal and GUI capabilities, revocation and cleanup. Until then, no item in this manifest is executable live authorization.

Record separate outcomes for source tests, canonical archive, derived pinned archive, exact-commit CI, deployment and actual fresh-account iPhone acceptance. Include UTC time, commit/artifact SHA-256, public device/key fingerprints and account aliases. Users perform login and Accessibility approval themselves. Never record cookies, bearer tokens, private keys, pairing codes or full authentication/network payloads.

Proposed live sequence after approval:

1. Deploy only the isolated Worker/database/Access configuration and verify protections, schema and logging/rate behavior.
2. Install the reviewed pinned artifact in test user A, pair account A, and prove terminal/GUI remain off. Complete the existing normal ChatGPT iPhone file read/write acceptance.
3. Pair approved account B/Mac B and prove exact-account/exact-Mac routing and denial for account switches, caller device hints, replay, expired consent and revoked bindings.
4. If terminal is included in the approval, run the local reviewed `permissions --enable-terminal` flow on Mac A, inspect the shown account/device/capabilities and type `enable`. Through normal ChatGPT iPhone chat, run only approved synthetic marker commands. Verify GUI remains unconsented in the protocol while acknowledging remote-shell-equivalent authority.
5. If GUI is included, the human grants Accessibility in System Settings on Mac A, then runs `permissions --enable-gui` with separate confirmation. Use a disposable app window containing only non-secret test text.
6. Reduce each capability and run `permissions --file-only` reconciliation. Check denial in new and existing chats, reconnect/retry/restart, queued-job cancellation and tracked-job shutdown. Do not claim detached processes were stopped by revocation.
7. Apply reviewed device/identity revocation only to the approved isolated database, prove subsequent calls/status/reconnect deny access, and perform the exact authorized local offboarding/cleanup.

Human login continuity, Access expiry redirects, actual iPhone integration availability, actual macOS Accessibility, detached-process inspection and Cloudflare deployed behavior cannot be proven by local fixtures. Normal ChatGPT mobile and Voice are separate observations; neither publication nor public availability is established. An unavailable integration is a recorded blocker, not a skipped acceptance pass.
