# Closed-beta device enrollment

Enrollment registers a file-only device; it does not issue a connector credential.
Personal /mcp, Access/OAuth and signed personal RPC remain separate. No owner
Cloudflare credential belongs on a tester Mac.

## Operator preparation

Before rollout, apply migrations 0001, 0002 and 0003 through the operator's reviewed
D1 workflow. Migration 0003 enforces unique agent public keys, including revoked
devices. Existing duplicate keys must be inspected and reconciled; migration
failure is a blocker, never a reason to remove the uniqueness check.

Keep relay/wrangler.jsonc generic. Merge the opt-in beta example into an explicit
private deployment config named `relay/wrangler.beta.local.jsonc` (gitignored).
Set BETA_REGISTRY_ENABLED=true and bind BETA_REGISTRY plus all six rate limiters.
BETA_ENROLLMENT_ENABLED defaults to false: enable it
only during onboarding windows and turn it off after outstanding invites are
resolved. Closing enrollment does not disable beta status/MCP.

The Workers Rate Limiting binding was checked against the
[official API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
and installed Wrangler schema/Workers types. The example provides:

- BETA_ENROLL_RATE: 5 attempts per minute, keyed by route and edge-supplied IP.
- BETA_REQUEST_RATE: 120 requests per minute per route/client (status, connect).
- BETA_MCP_RATE: 1200 requests per minute per client, allowing hosted connector egress.
- BETA_ENROLL_GLOBAL_RATE: 60 admitted enroll requests/minute, key beta:enroll.
- BETA_AGENT_GLOBAL_RATE: 600 admitted status/connect requests/minute, key beta:agent.
- BETA_MCP_GLOBAL_RATE: 6000 admitted MCP requests/minute, key beta:mcp.

Choose unused positive-integer namespace IDs in the deployment account; the
example numbers are placeholders, not live identifiers. Counters are approximate,
eventually consistent and per Cloudflare location, not an exact worldwide quota.
The route/client gate runs first; rejection never charges a shared budget.
Separate classes keep enrollment floods from spending agent or MCP capacity.
Strict IPv4 addresses retain address buckets; IPv6 is canonicalized to /64, with
IPv4-mapped IPv6 normalized to IPv4. Missing/malformed IPs share one unknown
bucket per route. Only CF-Connecting-IP is used, never X-Forwarded-For.
Shared NATs and hosted egress share client budgets. After MCP authentication,
DeviceRelay's existing per-device control remains in force (240 client
requests/minute). These pre-authentication limits are cost backstops; review
budgets against capacity in staging. Every beta path that queries D1 gates first;
missing/throwing/malformed limiters return 503, rejection returns 429 with
Retry-After: 60. No development bypass or module-global request state exists.
A provider-wide WAF policy may supplement this later. It is not configured here.

## Required release trust anchor

This closed beta has one operator relay. The release pins its exact HTTPS origin
in `installer/lib/beta-trust.mjs`; TLS authenticates that endpoint. The checked-in
null template fails closed for all beta setup, including legacy input and saved
identities. Personal setup remains available. Invites, CLI options, environment
variables and QR payloads cannot override the pin. Forged artifacts naming a
different origin fail before key creation, enrollment or agent startup.

Build a reviewed source release, extract it into a fresh directory and run this
deterministic offline step from the trusted source checkout:

```sh
node installer/pin-beta-release.mjs /path/to/extracted-release https://relay.example
```

The step replaces exactly the null template with public material and refuses a
checkout or already-pinned template. Identical source and canonical origin give
identical pinned bytes. Repack with fixed entry order/timestamps, recompute the
archive checksum AFTER pinning, and verify the final archive's pin. Distribute
installer and checksum through the operator's authenticated release channel,
independently of invite delivery. Never ask testers to pin an origin supplied by
their invite. Release authenticity is the trust root; replacing the installer
itself is outside this protection. Future QR pairing MUST use this same
pinned-origin validator before consuming its payload.

Prepare an invite offline (substitute the intended relay origin):

```sh
node relay/scripts/beta-invite.mjs create --owner tester-01 --relay-origin https://relay.example --out /private/tmp/astra-invite-01 --ttl-seconds 3600
```

The new output directory is 0700. registry.sql and invite.json are 0600.
Review/apply registry.sql to the intended registry; require exactly one returned
row for the active invited user before delivery. SQL contains the invite hash,
never plaintext. Deliver invite.json through an authenticated private channel;
the JSON contains version: 1, relayOrigin and invite. The release pin determines
which relay may receive it; the file cannot select another server. Confirm the
sender. Never paste its contents into commands, logs or support
messages. TTL starts on the operator machine, defaults to one hour and is at most
24 hours. Keep clocks accurate; remove delivery copies after confirmed use.
The helper has no network, login or deployment behavior. Output inside this
repository or another git checkout is refused, including symlinked parents.
Use a private operator directory and remove invite/connector artifacts after use.
The /private/tmp paths here are examples, not long-term secret storage.

## Tester setup

On a fresh local installation:

```sh
./install-macos.sh --beta-enroll --invite-file /path/to/invite.json
```

The file must be owned by the tester, regular, mode 0600, at most 2048 bytes and
not a symlink. --relay-url is optional; if supplied it must match the artifact.
No email, Cloudflare login, account selection, deployment or Access setup is needed.
The installer does not copy, persist or echo invite plaintext. The supplied file
remains until the tester removes it after verification.

The installer generates a beta UUID; --device-id is rejected. Personal device IDs
reserve the beta- prefix only when BETA_REGISTRY_ENABLED=true. Existing personal
beta-* IDs remain valid with beta disabled; doctor warns to rename them before
enabling beta. With beta enabled the whole prefix is reserved even if D1 is
missing. Beta registry lookups accept only lowercase beta v4
UUIDs and refuse configured personal IDs. Terminal/GUI options are rejected;
existing remote.json is reduced to one selected workspace and file-only settings.
Private keys stay on the Mac. The existing key lifecycle also creates a local
client key, which enrollment never sends or uses remotely.

The Mac displays its device ID and full SHA-256 fingerprint of the agent SPKI.
Send these two public values to the operator over a trusted channel before
connector authorization. A 403 may mean somebody else consumed the invite:
report it for inspection/revocation rather than simply asking for a replacement.
404 means enrollment is closed; 429/503 means retry later. Network errors,
timeouts and invalid responses leave the outcome unknown: re-run for signed
recovery. Server bodies and secrets are never reflected in these messages.

Re-run --beta-enroll to recover a lost response through an agent-signed status
request. The invite is not replayed if that succeeds. An unconfirmed identity may
correct --relay-url to the release-pinned origin, or use --reset-pending-identity.
Both first probe the OLD ID using its existing key at the trusted target relay.
Success recovers the committed ID/key even when reset was requested. Unknown or
temporary status preserves the identity and requires a later retry. After a
definitive 403/404, correction/reset generates a new UUID AND rotates the
unconfirmed agent key, clearing stale saved public identity. A write-ahead flag
finishes interrupted rotations before enrollment; the local client key is kept.
Ask the operator to inspect/revoke the displayed previous ID: the lost response
may have committed. Revocation does not free its unique public key, so a new ID
must never reuse that key. Confirmed relay/ID/key identity stays immutable;
offboarding, purge and a fresh invite recover confirmed revoked installations.
There is never a beta ID override. Readiness still requires the agent connection,
local MCP health, and
running-process/config fingerprint checks.

Legacy compatibility only: --legacy-invite permits a hidden prompt (with a
separately verified --relay-url) or ASTRA_BETA_INVITE. The installer warns that
these inputs are not relay-bound and that environment secrets can be visible to
same-user processes. It removes the variable before any child process, but this
cannot erase initial process-environment exposure. The release origin pin is
enforced for legacy input too. Use --invite-file normally.

## Inspect, confirm, authorize, revoke

Inspect the delivered invite using its hash from registry.sql:

```sh
node relay/scripts/beta-invite.mjs inspect --owner tester-01 --hash HASH_FROM_SQL --out /private/tmp/astra-inspect-01
```

Review/apply the generated read-only SQL. It returns the redeemed_device_id,
redemption timestamp, revocation state and public key, plus all devices for that
owner. If the ID or fingerprint differs from the tester's confirmed values,
revoke that device and its tokens immediately. Do not choose a device by owner,
oldest row, display name or an unverified claimed device ID.

Save the first query's single row as an object in a private local JSON file
(not the surrounding Wrangler result envelope). After confirming the full
fingerprint and device ID with the tester:

```sh
node relay/scripts/beta-invite.mjs authorize --record /private/tmp/inspection-row.json --device-id CONFIRMED_BETA_UUID --fingerprint CONFIRMED_SHA256 --out /private/tmp/astra-connector-01
```

The helper checks the fingerprint against the exact inspected public key and
requires the confirmed ID to equal redeemed_device_id. It emits hash-only
registry.sql plus a 0600 connector-token.json containing the bearer and exact
owner ID, device ID and agent SHA-256. Stdout names the same full binding context
and never prints the bearer. SQL rechecks the invite, redeemed
ID, key, active owner/device, file-only permission and absence of any other
active device for this owner. It will return zero rows on stale/mismatched
state. Require exactly one returned owner/device row before securely giving
the artifact only to the tester who confirmed that exact ID and fingerprint.
Compare its labels with that tester, copy its `bearer` field into the AI client
for /beta/mcp, then delete delivery copies. Tokens expire after seven
days. Never supply this connector token or an owner credential to the agent.

Revoke a suspicious/consumed invite:

```sh
node relay/scripts/beta-invite.mjs revoke --owner tester-01 --hash HASH_FROM_SQL --out /private/tmp/astra-revoke-01
```

Review/apply ALL statements. The first returns redemption fields explicitly;
the following statements revoke the redeemed device and all its connector
tokens, including on a repeated revoke. Verify the device status and token
results. Repeated revokes preserve original device/token revoked_at timestamps.
The first invite update does not alone complete device revocation.
Every beta lookup rechecks active device/user state, so a revoked device cannot
serve MCP even if its old socket has not yet disconnected.

Revoke unexpected extra devices with the same deterministic helper:

```sh
node relay/scripts/beta-invite.mjs revoke-device --owner tester-01 --device-id UNEXPECTED_BETA_UUID --out /private/tmp/astra-device-revoke-01
```

Inspect again before authorizing the tester's connector. The SQL is owner-scoped;
none of these helpers connects to Cloudflare or applies changes itself.

## Uninstall and recovery

Uninstall stops/removes the local agent; --purge additionally removes its listed
keys/state. Both retain workspace files and explain that server-side device and
connector authorization remain until the operator revokes them. Beta output shows
the device ID and full fingerprint and never directs testers to redeploy a Worker.
After operator revocation, purge old keys and re-enroll with --beta-enroll plus a
fresh invite artifact. Unique keys are intentionally not reusable across device
records. Do not start the owner installer flow on a tester Mac.

## Enrollment contract v1 and audit

POST /beta/enroll requires HTTPS, no query, a bounded JSON body and the invite in
Authorization. The exact body fields are version (number 1), deviceId,
agentPublicKeyB64 (canonical Ed25519 SPKI base64) and proof (canonical base64
64-byte Ed25519 signature). Sign the UTF-8 encoding of these lines, with no final
newline:

```text
astra-beta-enroll-v1
<exact HTTPS relay origin>
<lowercase SHA-256 hex of invite token>
<generated beta UUID>
<canonical SPKI base64>
```

The relay checks y < 2^255-19, rejects all eight small-order points and their sign
aliases, requires canonical/non-small-order signature R and S < L, then verifies
PoP with platform WebCrypto. Stored beta keys are revalidated before connect and
status verification, including manually provisioned legacy rows. The identity-key
/ R=B,S=1 regression proves signature canonicality alone is insufficient.
It does not implement its own curve arithmetic.
The compact coordinate table is cross-checked against
[Node's reviewed Ed25519 table](https://github.com/nodejs/node/blob/29890721cda51eeb64f4079143d55b69333599c2/src/crypto/crypto_sig.cc).
The old unversioned two-field enrollment body is intentionally rejected before
pre-rollout clients exist.

The D1 batch still makes the atomic invite claim and insert decision. There is
no read-then-write authorization, overwrite, or nontransactional fallback. An
insert/unique-key failure rolls back the claim. Lost responses or missing
RETURNING results fail closed and may be recovered by signed status.

Beta MCP has its own authenticator and read/write scopes for file-only devices.
Its explicit file-tool allowlist excludes command/job/GUI tools, call history,
usage telemetry and configuration mutation. Tool audit stores only generated
event ID, owner/device ID, reviewed tool name, outcome, duration and timestamp;
unreviewed names become a fixed unapproved_tool marker. It never receives
arguments, content, credentials or raw error text. Audit errors are swallowed and
waitUntil keeps writes alive without making user requests depend on them.

Audit retention: define a beta retention window (recommended 30 days), then
remove older rows in bounded, reviewed maintenance batches using created_at and
monitor database size. Preserve the relevant window before incident cleanup.
Rate gates bound growth per minute, not lifetime storage. This release performs
no automatic cleanup or live maintenance.

## Verification and later pairing

Run typecheck, the full relay and installer suites, and explicitly
node --test relay/test/enrollment-d1.test.mjs. D1 tests are mandatory and must
execute with zero skips in a local environment allowing Miniflare loopback.
SQLite passing does not replace workerd/D1 verification. Beta installer e2e
prerequisites are mandatory. Fixtures use fake services, not real launchd or
Cloudflare.

The mandatory suite includes a real bundled Worker smoke with migrations 0001–3,
local D1/DeviceRelay and Miniflare native local RateLimit bindings: enrollment,
signed status, WebSocket connect/heartbeat, beta MCP, waitUntil audit, whole
authorize/revoke SQL artifacts and denial after revoke. D1 exec needs one
statement per line; the test reformats complete artifacts without omitting any
statements. Miniflare's deterministic local counters cannot verify production
per-location eventual consistency, cross-isolate behavior, deployed namespace
provisioning or hosted-egress capacity. Those are staging-only checks; local
success is not full provider verification.

Later OAuth/QR pairing can carry the same grant and v1 proof under the release
origin pin, while
authenticating the invited user. Keep beta tokens mapped to their D1 principal;
never reuse the personal OAuth store that maps tokens to the owner's device.
A real invited-Mac enrollment/reconnect/revoke/purge/re-enrollment exercise
remains a separately authorized rollout gate.
