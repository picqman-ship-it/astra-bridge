# macOS installer (reference)

`./install-macos.sh` at the repository root is the entry point. This directory holds the installer itself: plain Node.js scripts with no dependencies (they run before `npm ci`), easy to read before you run them.

| File | Role |
|---|---|
| `../install-macos.sh` | Checks for macOS and Node.js 22+, then starts `astra-macos.mjs`. Never installs anything, never uses sudo. |
| `astra-macos.mjs` | Command line: `install` (default), `doctor`, `uninstall`, `permissions` for an already account-paired Mac. |
| `lib/install.mjs` | The guided steps, in order (below). |
| `lib/doctor.mjs` | Read-only health check. |
| `lib/uninstall.mjs` | Conservative removal. |
| `lib/*.mjs` | Prerequisites, JSONC editing of the personal config, Node path selection, launchctl, relay probes, key inspection. |
| `build-source-release.sh` | Reproducible source archive + SHA-256 for a commit (see Distribution). |

## What `./install-macos.sh` does

Every step first looks at the real state and only does what is missing, so running it again continues where it stopped.

1. **Checks this Mac**: macOS 13 or newer, Apple silicon or Intel (warns about an Intel Node under Rosetta), Node.js 22+, npm/npx, Xcode Command Line Tools (required only for the optional GUI tools). Missing pieces are reported with the command to run; nothing is installed for you.
2. **Dependencies**: `npm ci` in `mcp-commander/` and `relay/` (exact versions from `package-lock.json`; skipped when a stamp shows they are already installed from the same lockfile for the same CPU architecture). Build fingerprints cover TypeScript, native sources, build scripts, package/TypeScript configuration, output, Node/CPU and Swift/SDK identity. Any change or missing stamp rebuilds mcp-commander. The native compiler target follows Node's architecture.
3. **Workspace**: creates `~/remote-workspace` (0700; `--workspace` to choose another) and writes `~/.mcp-commander-remote/remote.json` with mcp-commander's own `remote:setup` in **file-only mode**, protecting this whole checkout (`--protect <checkout>`). An existing `remote.json` is kept as is. The installer only adds the checkout protection to it and changes the terminal/GUI flags when you ask.
4. **Keys**: runs `relay/scripts/keygen.mjs` when no keys exist (directory 0700, files 0600, never overwritten), then checks both keys. Private keys are never printed. A readable key or a half pair stops the installer with the exact fix.
5. **Personal Cloudflare config**: creates `relay/wrangler.personal.jsonc` (gitignored, 0600) from the committed template and fills in only the public keys, the device id, the worker name, your email (`ACCESS_ALLOWED_EMAILS`) and later the relay URL and Access values. Comments and anything else you add are preserved, including an `ACCESS_ALLOWED_EMAILS` list of several addresses. The Worker compares the device ids, `OAUTH_ISSUER` and `OAUTH_RESOURCE` verbatim, so values that are only equal after trimming are rewritten in exact form (doctor reports them until then). It refuses to write if git would not ignore the file.
6. **Cloudflare login**: `wrangler whoami`; if you are not logged in, it offers `wrangler login` (browser) or stops at a checkpoint. One effective account is selected from `--account-id`, `CLOUDFLARE_ACCOUNT_ID` (legacy `CF_ACCOUNT_ID`), personal `account_id`, remembered selection, or a single available account, in that order. Ambiguity stops for a selection. The effective account is pinned in the config and environment for both lookup and deploy; inherited Wrangler environments cannot silently change the target.
7. **Deploy**: ownership and deployment fingerprints identify both the account and Worker name. Switching either, or resuming an old record without an account, requires a fresh existence check. Unknown lookup results never authorize replacement; an existing Worker requires `--replace-existing-worker` or typing its name. Then `wrangler deploy --dry-run`, `wrangler deploy`, and `/healthz`. Later runs deploy when the personal config, Worker sources or lockfile changed (or with `--redeploy`).
8. **Agent**: renders the LaunchAgent with `relay/scripts/install-agent.mjs`, shows what it will run, asks, writes it with the same script, and loads it with `launchctl bootstrap` in your user session. The Node path is a stable name that resolves to the running Node (for Homebrew `/opt/homebrew/bin/node` or `<prefix>/opt/<formula>/bin/node` instead of a versioned `Cellar` path), so it survives upgrades on Apple silicon and Intel alike. It then waits until the relay reports the agent connected. It stops instead if another LaunchAgent already runs an agent for the same relay and device.
9. **Cloudflare Access**: prints the dashboard steps, takes the team domain and AUD tag, and redeploys if needed. It validates the expected Bearer challenge, same-origin protected-resource metadata, and the configured team's OAuth issuer/endpoints. This verifies **edge protection and OAuth discovery**. Your authenticated `/mcp` session and email policy still require verification in the client/dashboard. The Worker independently enforces `ACCESS_ALLOWED_EMAILS`.

Then it prints the ChatGPT connector settings. Exit 0 also requires a running local agent and a successful signed relay status reporting both agent connectivity and MCP health, checked again after the Access step. Transient unavailability is a checkpoint; authentication/configuration failures fail the run.

Runtime changes (including `--file-only`, custom protections, keys, config and code) remain pending in `install-state.json` until an actual restart and readiness verification succeed. An interrupted or offline run cannot mark them applied; resuming without the original flags still restarts the agent. Custom key directories receive the same protections during installer validation as at agent startup. Personal config ownership, regular-file type and mode 0600 are checked even when its content is unchanged.

### Checkpoints and exit codes

| Exit | Meaning |
|---|---|
| 0 | Done (install: agent/MCP health and Access edge discovery verified; doctor: no failures) |
| 1 | Failed: the message says what and how to fix it |
| 2 | Usage error |
| 3 | Checkpoint: input is needed or readiness is temporarily unavailable. Progress is kept; re-run afterwards |

Non-interactive runs (`--non-interactive`, or stdin not a terminal) never guess: a missing answer or confirmation becomes a checkpoint that names the flag to pass (`--email`, `--yes`, ...). In both TTY and non-interactive mode, `--yes` accepts ordinary confirmations (deploy, loading the agent). Typed confirmations for risky opt-ins, Worker replacement and destructive cleanup remain explicit in a TTY.

### Terminal and GUI tools

Off by default and never turned on implicitly. For personal self-deploy, `--enable-terminal` / `--enable-gui` print what they grant, require typing `enable` in an interactive terminal, update only those flags in `remote.json`, and restart the agent so the change takes effect (mcp-commander reads its config only at startup). `--file-only` turns both off again. See [../SECURITY.md](../SECURITY.md).

Account pairing always begins with explicit `files-v1` consent and both control capabilities off. An **already account-paired Mac** uses the separate local command:

```sh
./install-macos.sh permissions --enable-terminal
./install-macos.sh permissions --enable-gui
./install-macos.sh permissions --disable-terminal
./install-macos.sh permissions --disable-gui
./install-macos.sh permissions --file-only
```

These are alternative changes, not a script to run automatically. Review the displayed account/provider, issuer + subject identity fingerprint, device ID, locally verified key fingerprint and current/target permissions. Elevation requires typing `enable` interactively; `--yes` does not approve it. GUI approval additionally requires the compiled helper, an unlocked on-console Mac, and Accessibility already granted by the human through System Settings. Never edit TCC or automate its approval.

Terminal is equivalent to a remote shell running as your macOS user, including process and durable-job tools. Workspace roots restrict file/search tools only, not shells or interpreters; terminal permission does not promise GUI isolation. GUI permits reading/operating app windows beyond those roots. The protocol advertises terminal and GUI as independent account-paired capabilities.

The hosted service requires additive migration 0008 and explicit `CONTROL_PERMISSIONS_ENABLED=true`, Access/registry routing, D1 and rate bindings; see [the Access configuration](../relay/docs/ACCOUNT-PAIRING-ACCESS.md). There is no MCP tool to elevate permissions. Each request checks the active account/device/grants, and the Mac independently enforces `remote.json`.

Elevation verifies the restarted local agent before granting server authority. Reduction attempts to remove server authority first, then removes local control even if the service or server apply is unavailable; unresolved server authority is explicitly reported. Removing terminal permission disables new durable submissions, cancels queued jobs and verifies recorded worker/job process groups stopped. Detached programs outside those groups need separate local inspection. An unconfirmed shutdown blocks another terminal opt-in; cancelled work stays cancelled.

Interrupted changes keep a transaction pending until server and running-agent verification complete. Matching saved flags alone do not complete an unreviewed elevation. If local/server state differs, run `permissions --file-only` to reconcile before enabling again; follow any reported local recovery instruction. An unchanged elevated request still requires a completed matching local review and verifies the running agent. Ordinary install/restart must not silently restore a permission.

Source defaults and the release origin pin remain unchanged. These commands describe the source mechanism; they do not authorize deployment, installation or control on a real Mac.

## Doctor

`./install-macos.sh doctor [--offline] [--json]` changes nothing. It checks the prerequisites, dependencies and build, `remote.json` (with mcp-commander's own validator, as the agent would load it) and its mode, key permissions and type, that the personal config matches this Mac's keys and holds no placeholders, the LaunchAgent (valid plist, Node still present and 22+, agent file present, same relay and device as the config), `launchctl` state, whether the running agent still matches the applied runtime fingerprint, whether an earlier durable-job shutdown is unconfirmed, conflicting LaunchAgents, the agent's last log event, and, unless `--offline`, the relay's `/healthz`, a signed status request (is the agent connected?) and the Access check. It exits 1 on any failure. The output contains paths and your relay URL but no keys and no email.

## Uninstall

`./install-macos.sh uninstall` stops the agent (`launchctl bootout`) and disables it at login (`launchctl disable`), then disables durable job submissions, cancels queued jobs and verifies that the recorded worker and job process groups are gone before it removes the LaunchAgent file (then it lifts the login block: nothing is left to load). Unknown identities, malformed records or failed stops end the run early and keep keys, config, job records and the LaunchAgent file, but the agent stays stopped and does not start again at login. Re-run it once the reported item is resolved. Previously launched programs that detached from tracked groups require separate local inspection. Keys, `remote.json`, job records, your workspace and the deployed Worker are kept. `--dry-run` shows the plan without stopping anything. `--purge` additionally deletes the two private keys, agent logs, installer state and personal relay config from validated installation paths. It never deletes a directory tree, workspace, `remote.json` or job records, and requires typing `delete` (or `--yes`). Explicit `--enable-terminal` permits new jobs after a confirmed shutdown; cancelled work stays cancelled.

Emergency procedure: run `./install-macos.sh uninstall --yes` locally, then delete the relay Worker through Workers & Pages in the correct Cloudflare account (or rotate both agent/client signing keys and redeploy with the agent stopped). Access protects `/mcp` only; disabling Access does **not** revoke signed `/v1/device/*` RPC. Remove the connector and Access application afterwards. Dashboard deletion does not depend on a config file that purge may already have deleted.

For custom installations, paths come from the validated installed plist and the owner-only locator `~/.config/astra-bridge/install.json`, which is now written before first-install keys/config, survives ordinary uninstall and is removed by purge. A partial-install inventory covers only reserved files absent before setup; pre-existing files are never adopted for partial cleanup. Purge works after custom environment overrides are unset; conflicting overrides and mismatched metadata/plists are refused. Legacy partial installs without either locator or plist can purge only default-path, owner-only Ed25519 keys and a personal config whose public keys match; unproven paths and unrelated files are kept. Paths must use real directory components. Inspection errors, timeouts and failed shutdowns are UNKNOWN: no purge occurs until shutdown is confirmed.

`--file-only` and `--reconfigure` apply their reduction locally before any dependency download, build, Cloudflare login or deployment: first `remote.json` loses the terminal/GUI access the run does not keep (it is only ever removed, so no later start regains it: not a KeepAlive restart, the next login or a resumed run without flags), then the agent is stopped and disabled at login, then tracked durable jobs are stopped. Setup re-enables the agent only for a restart it then verifies. A shutdown that cannot be verified stops the run and is reported as UNKNOWN or UNCONFIRMED, never as done. Every later run retries an unconfirmed durable-job shutdown first; until it is confirmed, `--enable-terminal` is refused before `remote.json` changes and no run reports setup complete. Doctor compares the applied runtime fingerprint and running PID with current config, keys, code and launch inputs; an unset pending flag alone never proves the current permissions are active.

## Tests

```sh
(cd mcp-commander && npm ci && npm run build)   # the end-to-end tests use the built mcp-commander
(cd relay && npm ci)
(cd installer && npm test)
```

`npm test` builds mcp-commander first (the sandboxes use this checkout's build). Missing dependencies or beta end-to-end prerequisites fail the gate; a stale build also fails rather than silently testing old code.

The tests never touch your real `~/.astra-bridge`, `~/.mcp-commander-remote`, `~/Library/LaunchAgents`, launchd or Cloudflare account. End-to-end runs use a temporary `HOME`, a copy of the checkout, and fake `launchctl`/`wrangler` (`ASTRA_LAUNCHCTL`, `ASTRA_WRANGLER`). The installer refuses to use the real `launchctl` when `HOME` is not your real home directory. Network probes use injected transports, including a test-only preload for complete CLI readiness checks; they make no external requests.

## Distribution and signing

This MVP is distributed as source: `git clone`, or a source archive made with `installer/build-source-release.sh` (reproducible for a given commit, with a `.sha256` to verify). Nothing in this repository is code-signed or notarized, and nothing claims to be.

The canonical builder packages a **committed revision only**, using `git archive` and `gzip -n -9`. Uncommitted edits are omitted. Its product paths include this installer reference and `relay/docs/`, but exclude root `docs/`, dependencies, Git history and runtime state.

For a local committed-source gate, keep at least 5 GiB free and use a new output directory; do not install the resulting archive:

```sh
task_revision=$(git rev-parse HEAD)
task_gate=$(mktemp -d "${TMPDIR:-/tmp}/astra-source-gate-20261003.XXXXXX")
sh installer/build-source-release.sh "$task_revision" --out "$task_gate/a"
sh installer/build-source-release.sh "$task_revision" --out "$task_gate/b"
task_archive=$(basename "$task_gate/a/"*.tar.gz)
cmp "$task_gate/a/$task_archive" "$task_gate/b/$task_archive"
cmp "$task_gate/a/$task_archive.sha256" "$task_gate/b/$task_archive.sha256"
(cd "$task_gate/a" && shasum -a 256 -c "$task_archive.sha256")
tar -tzf "$task_gate/a/$task_archive"
```

Inspect the archive listing before extracting into a new directory: every entry must be beneath its single expected source prefix, with no absolute/traversal path or escaping link. Record the exact commit, archive hash and tool versions. After safe extraction, run locked `npm ci` in the extracted `mcp-commander/` and `relay/`, then each package's tests/typecheck and `(cd installer && npm test)` as described above, from that extracted source. Use only the test suites, which create their own sandboxes; do not run install, deploy, service setup or live smoke commands.

A plain archive has no `.git`: the installer test named “source release helper: the same commit gives byte-identical archives with only tracked files” must skip with “not a git checkout”. That one expected archive skip is verified by the two-build comparison above and by the same test passing in the source checkout. No other skip is expected on the prepared macOS environment; missing dependencies or failed D1/workerd/native prerequisites are failures. Keep canonical committed-source and separately origin-pinned staging artifacts/checksums distinct.

There is deliberately no `.pkg` yet:

- An unsigned installer package is blocked by Gatekeeper, and recent macOS versions no longer offer the right-click "Open" bypass for it. A package worth shipping needs an Apple Developer ID Installer certificate, `productsign`, and notarization with `notarytool`. Those credentials are not part of this project.
- Package scripts run as root, but everything Astra Bridge sets up belongs to your user (keys in `~/.astra-bridge`, a LaunchAgent in your login session, a config naming your folder). A root postinstall that acts on behalf of "the logged-in user" is fragile and a poor security pattern, and the Cloudflare and Access steps need your browser anyway.
- The dependencies include per-architecture binaries (ripgrep, esbuild/workerd, the compiled Accessibility helper), so a package would have to be built and tested per architecture or as a universal bundle, together with a pinned Node.js runtime.

Signed/notarized release blockers: a Developer ID certificate and notarization credentials, a decision on bundling Node.js, universal (arm64 + x86_64) builds of the native pieces, and hardened-runtime signing of the Accessibility helper so its Accessibility permission stays stable across updates.

## Invited beta enrollment

Use `./install-macos.sh --beta-enroll --invite-file /path/to/invite.json`
on a fresh tester installation using the operator's release with its pinned relay
origin. The source trust template fails closed until the offline
`pin-beta-release.mjs` release step is performed; see the operator guide below.
The 0600 invite artifact must match that independent release pin. The installer
generates a beta UUID, proves agent-key
possession, forces one-workspace file-only mode and skips Cloudflare credentials,
email and deployment. Confirm the displayed device ID and full agent fingerprint
with the operator before connector authorization. Re-run with `--beta-enroll` to
resume. Uninstall/purge does not revoke the server device/token: ask the operator
to revoke them, purge the old keys, then enroll with a fresh artifact. Environment
or hidden-prompt input requires warned `--legacy-invite` compatibility opt-in.
See [operator setup, revocation and pairing contract](../relay/docs/BETA-ENROLLMENT.md).

Pending correction/reset first tries signed recovery with the old ID/key. If a
definitive denial requires a new ID, its unconfirmed agent key is rotated too;
confirmed identity/key remains immutable. Enrollment messages distinguish 403
possible invite consumption, 404 closed enrollment, temporary 429/503 and unknown
network/timeout outcomes. Repeated runs recover committed lost responses.

Personal compatibility: existing `beta-*` IDs keep working with the beta registry
disabled. Doctor flags these IDs so the operator can rename them before setting
`BETA_REGISTRY_ENABLED=true`, which enforces the reserved namespace.

Account-paired LaunchAgents carry the non-secret `ASTRA_ACCOUNT_CONTROL_STATE_FILE` marker for this installation’s protected `install-state.json`. The agent checks the completed review on every tool request, including after reboot or KeepAlive restart. Pending, missing, malformed or mismatched state hides and denies terminal, jobs, GUI and control telemetry while reviewed file operations remain available. Completion opens only the separately reviewed capabilities; unmarked personal and invited-beta agents keep their previous behavior. `permissions --file-only` always stops tracked jobs, even when stored flags already say off.
