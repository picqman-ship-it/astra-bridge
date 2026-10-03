# Hosted Mac control permissions

This is the feature-branch source contract for an already account-paired Mac. Source preparation does not enable control on a deployment or a real Mac. Deployment, installation and real-device acceptance are separate gates.

## Permission matrix and trust boundary

| Capability | Initial account pairing | Separate local opt-in | Limits |
|---|---|---|---|
| Reviewed file/search tools | Enabled with explicit `files-v1` consent | None | Local roots, symlink checks and protected installation paths still apply |
| Terminal, processes and durable jobs | Disabled | `permissions --enable-terminal` | Remote-shell-equivalent execution as the macOS user; roots do not sandbox shells or interpreters |
| GUI windows and Accessibility actions | Disabled | `permissions --enable-gui` | Can read and operate the user's app windows beyond the approved folder; human-granted macOS Accessibility is required |
| Remote permission/configuration changes | Disabled | No MCP tool | Owner runs the local installer permission command |

Terminal and GUI are distinct advertised grants. Once arbitrary shell execution is allowed, a separate GUI flag does not promise GUI isolation or protection of other user-accessible files. A terminal command can reach everything the macOS user can reach, subject to operating-system permissions.

The account authority is the verified Access issuer + subject, resolved to an active owner and exactly one active Mac. Email is display metadata. A browser login, leaked pairing code, caller-selected device, another account or an MCP tool cannot grant control. The local flow also requires the already paired device ID and its existing Ed25519 agent key; it never silently replaces that identity or key.

## Setup remains file-only

Initial account pairing keeps `files-v1`. Migration `0007_pairing_consent.sql` retains its file-only CHECK. Control uses separate additive migration `0008_control_permissions.sql`, versioned permission rows and short-lived requests. Committed migrations 0001–0007 must not be rewritten. Migration 0008 is a deployment prerequisite even if the permission endpoint flag is off, because registry routing reads the new overlay.

Owner-only/self-deploy authorization remains subject to its existing local flags. For existing invited-beta bearer devices with no control overlay, the previous terminal-enabled policy keeps its earlier GUI compatibility. An explicit overlay makes terminal and GUI independent and applies reductions to both account-routed and legacy bearer calls. That overlay is bound to the exact agent key and issuer/subject/email; changed bindings deny its authority. Adding the schema grants no new account-paired permission; account pairing always begins file-only.

The service stays off unless all of these are explicitly configured in a separately reviewed relay configuration:

```text
MCP_AUTH_MODE=access
ACCESS_DEVICE_ROUTING=registry
PAIRING_ENABLED=true
BETA_REGISTRY_ENABLED=true
CONTROL_PERMISSIONS_ENABLED=true
BETA_REGISTRY=<isolated D1 binding>
TEAM_DOMAIN=<approved Access team issuer>
POLICY_AUD=<the single approved Access application's audience>
```

Apply migrations 0001–0008 only to the specifically authorized disposable staging database. The source template does not enable this service. The release's exact public relay origin must be independently pinned; a source `BETA_RELAY_ORIGIN = null` is intentionally unusable for hosted pairing.

Access protects `/mcp` and `/pair/claim` within one application. `/control/device/*` must pass the Access edge without browser login, like signed agent endpoints, because a Mac-side command has no browser session. The Worker still requires the exact registry Mac's fresh Ed25519 signature, allowed HTTPS method/path/body, rate limits and active binding. This public edge override is not an unauthenticated permission API.

## Local commands

Run only on the specifically approved test Mac and reviewed installed source:

```sh
./install-macos.sh permissions --enable-terminal
./install-macos.sh permissions --enable-gui
./install-macos.sh permissions --disable-terminal
./install-macos.sh permissions --disable-gui
./install-macos.sh permissions --file-only
./install-macos.sh doctor
```

The review identifies the account/provider, issuer + subject identity fingerprint, Mac device ID, locally checked key fingerprint and current/requested capabilities. Elevation requires an interactive typed `enable`; `--yes` does not replace it. GUI opt-in checks the compiled helper and an unlocked, on-console Mac with Accessibility already granted by the human in System Settings. Do not edit TCC or automate that approval. Reduce permissions first if a command would otherwise both elevate and reduce different capabilities.

## Revalidation, interruption and reconciliation

Each hosted MCP request resolves the verified identity and current active owner/device/grants again. The relay filters tool discovery and rejects unapproved or unconsented calls. The Mac independently exposes only the tools allowed by its local `remote.json`; it reads that configuration at startup, so a saved flag alone does not prove running authority.

A permission request binds the existing account, owner, Mac key, previous permissions, target permissions and request ID. Pending requests expire after five minutes. Cancellation and expired/replayed or mismatched requests cannot elevate. Lost responses are recovered only through the signed request-status path for that exact request and verified binding; an unknown outcome is not accepted as success.

Elevation prepares the local configuration and verifies the restarted agent before server authority is granted. Reduction attempts server removal first, then reduces and verifies the local runtime even if the service or server apply is unavailable; it explicitly reports unresolved server state. Local/server disagreement requires `permissions --file-only` reconciliation before another elevation. A persisted transaction remains pending until both server authority and actual restart/readiness are verified; matching saved flags alone cannot complete an interrupted or unreviewed elevation. A later ordinary restart or install must not silently re-enable a permission.

If status, restart, rollback or tracked-job shutdown cannot be verified, keep the result unconfirmed and follow the exact reported local recovery instruction. Use `permissions --file-only` to remove local control and reconcile the server where accessible; use the existing local offboarding procedure for an emergency stop. Doctor reports observed configuration and verified running state separately.

## Jobs and offboarding limits

Removing terminal permission denies new process/job calls and invokes tracked durable-job shutdown. Offboarding disables submissions, cancels queued jobs and stops recorded worker/job process groups only after checking process identity. An incomplete shutdown retains evidence and blocks a later terminal opt-in. Explicit local terminal opt-in can permit new jobs after a confirmed shutdown; cancelled work stays cancelled.

A server-side device/identity revocation denies new remote calls, status and reconnects. It does not prove that previously started programs stopped. Detached shell processes outside recorded process groups cannot be recalled by a permission flag or server revocation; they require separate local inspection. Uninstall is local offboarding and does not itself revoke the server binding.

## Verification and remaining gates

The local test suites use synthetic keys/identities and disposable databases or installer sandboxes, including real Miniflare/workerd D1 paths. Actual run counts, source hashes, packaging and CI belong in the dated completion evidence; this architecture document is not a test pass record.

The canonical source archive is unsigned and non-notarized. Its explicit product-path list excludes root `docs/`, so [installer reference](../installer/README.md) and [Access setup](../relay/docs/ACCOUNT-PAIRING-ACCESS.md) carry the necessary offline instructions.

Use [the proposed staging manifest](STAGING-RESOURCE-MANIFEST-2026-10-03.md) and [fresh-account acceptance plan](CHATGPT-MOBILE-ACCEPTANCE-2026-10-02.md) for the separately authorized live gate. Direct MCP tests, local D1 tests, owner-connector success and CI do not establish normal ChatGPT chat on an actual iPhone, Voice support, public plugin approval or universal account/workspace availability.

Account-paired LaunchAgents carry the non-secret `ASTRA_ACCOUNT_CONTROL_STATE_FILE` marker for this installation’s protected `install-state.json`. The agent checks the completed review on every tool request, including after reboot or KeepAlive restart. Pending, missing, malformed or mismatched state hides and denies terminal, jobs, GUI and control telemetry while reviewed file operations remain available. Completion opens only the separately reviewed capabilities; unmarked personal and invited-beta agents keep their previous behavior. `permissions --file-only` always stops tracked jobs, even when stored flags already say off.
