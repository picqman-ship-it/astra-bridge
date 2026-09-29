# macOS installer (reference)

`./install-macos.sh` at the repository root is the entry point. This directory holds the installer itself: plain Node.js scripts with no dependencies (they run before `npm ci`), easy to read before you run them.

| File | Role |
|---|---|
| `../install-macos.sh` | Checks for macOS and Node.js 22+, then starts `astra-macos.mjs`. Never installs anything, never uses sudo. |
| `astra-macos.mjs` | Command line: `install` (default), `doctor`, `uninstall`. |
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
5. **Personal Cloudflare config**: creates `relay/wrangler.personal.jsonc` (gitignored, 0600) from the committed template and fills in only the public keys, the device id, the worker name, your email (`ACCESS_ALLOWED_EMAILS`) and later the relay URL and Access values. Comments and anything else you add are preserved. It refuses to write if git would not ignore the file.
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

Off by default and never turned on implicitly. `--enable-terminal` / `--enable-gui` print what they grant, require typing `enable` in an interactive terminal, update only those flags in `remote.json`, and restart the agent so the change takes effect (mcp-commander reads its config only at startup). `--file-only` turns both off again. See [../SECURITY.md](../SECURITY.md).

## Doctor

`./install-macos.sh doctor [--offline] [--json]` changes nothing. It checks the prerequisites, dependencies and build, `remote.json` (with mcp-commander's own validator, as the agent would load it) and its mode, key permissions and type, that the personal config matches this Mac's keys and holds no placeholders, the LaunchAgent (valid plist, Node still present and 22+, agent file present, same relay and device as the config), `launchctl` state, conflicting LaunchAgents, the agent's last log event, and, unless `--offline`, the relay's `/healthz`, a signed status request (is the agent connected?) and the Access check. It exits 1 on any failure. The output contains paths and your relay URL but no keys and no email.

## Uninstall

`./install-macos.sh uninstall` stops the agent (`launchctl bootout`) and removes its LaunchAgent file. Keys, `remote.json`, the personal config, your workspace and the deployed Worker are kept, and the commands to remove them are printed. `--dry-run` shows the plan. `--purge` additionally deletes exactly these files: the two private keys, the agent logs and the installer state in `~/.astra-bridge`, and `relay/wrangler.personal.jsonc`. It never deletes a directory tree, the workspace or `remote.json`, and it asks you to type `delete` (or needs `--yes` when not interactive). To cut remote access immediately, also disable the Access application or delete the Worker.

For custom installations, paths come from the validated installed plist and the owner-only locator `~/.config/astra-bridge/install.json`, which survives ordinary uninstall and is removed by purge. Purge works after custom environment overrides are unset; conflicting overrides, mismatched metadata/plists, and missing installation evidence are refused. Paths must use real directory components. Inspection errors, timeouts and failed shutdowns are UNKNOWN: uninstall/purge removes nothing until shutdown is confirmed.

## Tests

```sh
(cd mcp-commander && npm ci && npm run build)   # the end-to-end tests use the built mcp-commander
(cd relay && npm ci)
(cd installer && npm test)
```

The tests never touch your real `~/.astra-bridge`, `~/.mcp-commander-remote`, `~/Library/LaunchAgents`, launchd or Cloudflare account. End-to-end runs use a temporary `HOME`, a copy of the checkout, and fake `launchctl`/`wrangler` (`ASTRA_LAUNCHCTL`, `ASTRA_WRANGLER`). The installer refuses to use the real `launchctl` when `HOME` is not your real home directory. Network probes use injected transports, including a test-only preload for complete CLI readiness checks; they make no external requests.

## Distribution and signing

This MVP is distributed as source: `git clone`, or a source archive made with `installer/build-source-release.sh` (reproducible for a given commit, with a `.sha256` to verify). Nothing in this repository is code-signed or notarized, and nothing claims to be.

There is deliberately no `.pkg` yet:

- An unsigned installer package is blocked by Gatekeeper, and recent macOS versions no longer offer the right-click "Open" bypass for it. A package worth shipping needs an Apple Developer ID Installer certificate, `productsign`, and notarization with `notarytool`. Those credentials are not part of this project.
- Package scripts run as root, but everything Astra Bridge sets up belongs to your user (keys in `~/.astra-bridge`, a LaunchAgent in your login session, a config naming your folder). A root postinstall that acts on behalf of "the logged-in user" is fragile and a poor security pattern, and the Cloudflare and Access steps need your browser anyway.
- The dependencies include per-architecture binaries (ripgrep, esbuild/workerd, the compiled Accessibility helper), so a package would have to be built and tested per architecture or as a universal bundle, together with a pinned Node.js runtime.

Signed/notarized release blockers: a Developer ID certificate and notarization credentials, a decision on bundling Node.js, universal (arm64 + x86_64) builds of the native pieces, and hardened-runtime signing of the Accessibility helper so its Accessibility permission stays stable across updates.
