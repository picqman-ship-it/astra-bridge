# Astra Bridge

Astra Bridge connects ChatGPT to a dedicated workspace on your own Mac through a Cloudflare relay. File access is the default. Advanced self-deploy installations can optionally enable terminal sessions, background jobs and macOS app control.

**Public beta — v0.1.0-beta.2. Not production-ready.** Distributed as source; not code-signed or notarized.

> [!WARNING]
> **Enabling terminal tools gives remote-shell-equivalent access as your macOS user.** Start in file-only mode with a dedicated workspace. Use one owner per connection; do not share the connector. Untrusted content can attempt prompt injection. Read [SECURITY.md](SECURITY.md) before installation or enabling broader access.

[Download beta.2](https://github.com/picqman-ship-it/astra-bridge/releases/tag/v0.1.0-beta.2) · [Security](SECURITY.md) · [File-only walkthrough](#file-only-walkthrough) · [Advanced self-deploy](#advanced-self-deploy-on-macos)

> This page documents beta.2. Use its release archive or tagged checkout below for the published source; the listed SHA-256 applies to the named release asset.

## Why this exists / what it proves

Astra Bridge explores how a chat assistant can work with a personal Mac while making access, recovery and revocation explicit. It combines an outbound relay, restricted MCP tools, resumable installation and health checks. Beta.2’s evidence covers a real second-Mac lifecycle and tests against both the repository and packaged source.

### Self-deploy architecture

Traffic passes through OpenAI and a Cloudflare relay in your own account. Your Mac opens an outbound WebSocket; no inbound port is opened.

```text
ChatGPT ──OAuth──▶ your Cloudflare Worker /mcp ──▶ Durable Object ◀──WebSocket── Mac agent ──stdio──▶ mcp-commander
```

| Component | Documentation |
|---|---|
| Relay | [Cloudflare Worker + Durable Object relay](https://github.com/picqman-ship-it/astra-bridge/blob/v0.1.0-beta.2/relay/README.md) |
| Mac tools | [mcp-commander](https://github.com/picqman-ship-it/astra-bridge/blob/v0.1.0-beta.2/mcp-commander/README.md) |
| Installer | [macOS installer](https://github.com/picqman-ship-it/astra-bridge/blob/v0.1.0-beta.2/installer/README.md) |

## Start here

| Path | What it means |
|---|---|
| **Public beta** | Source release for inspection and advanced self-deployment. Download beta.2 and its checksum from the [release page](https://github.com/picqman-ship-it/astra-bridge/releases/tag/v0.1.0-beta.2). |
| **Advanced self-deploy** | Run your own relay in your own Cloudflare account. You manage deployment, authentication and revocation. |
| **Invited testing** | Operator-hosted enrollment remains invite-only. It requires an operator-pinned package and private invite. The public source template alone cannot enroll, and enrollment does not itself authorize a connector. See the [beta.2 enrollment guide](https://github.com/picqman-ship-it/astra-bridge/blob/v0.1.0-beta.2/relay/docs/BETA-ENROLLMENT.md). |

## Validated — beta.2

These are recorded release-gate results, not claims of production readiness.

| Check | Confirmed result |
|---|---|
| Second physical Mac (operator-invited enrollment) | Install → enrollment → reboot → revoke → purge → fresh reinstall → reboot: passed |
| Repository installer | 131/131 passed |
| Repository relay | 199/199 passed |
| Extracted archive installer | 130 passed, 0 failed, 1 expected skip because it is not a Git checkout |
| Extracted archive relay | 199/199 passed after normal locked `npm ci` |
| Reproducibility | Independent archive builds produced the same SHA-256 |

Published evidence: [v0.1.0-beta.2 release](https://github.com/picqman-ship-it/astra-bridge/releases/tag/v0.1.0-beta.2).

```text
astra-bridge-0.1.0-4325edbbc163.tar.gz
SHA-256: e04fc02bed0646f1885ab1c45bcd0291a3c6abba225a0ecffbbae53e88a4538a
```

The checksum above applies to that named uploaded asset, not GitHub's automatically generated source downloads.

## File-only walkthrough

This is an example walkthrough with expected results, not a recorded demo. It assumes an installed, authorized connection and a dedicated workspace.

1. Ask: “List the files in my configured workspace.”
2. Ask: “If `astra-demo.txt` does not exist, create it in that workspace containing `Astra Bridge file-only demo.` Otherwise stop.”
3. Ask: “Read `astra-demo.txt` back.” Expected content: `Astra Bridge file-only demo.`
4. Open the file locally and verify the same content.

Terminal and GUI access remain disabled in this walkthrough.

## What you need

- A Mac with macOS 13 (Ventura) or newer, Apple Silicon or Intel, with Node.js 22+ and npm. Git is needed for the tagged-checkout route. Xcode Command Line Tools are required for optional GUI support.
- For advanced self-deploy: a Cloudflare account. Cloudflare offers Free and Paid plans; costs depend on usage and current limits. See the [official Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- A ChatGPT plan that lets you add custom connectors / apps (developer mode).

## Advanced self-deploy on macOS

> [!CAUTION]
> Fresh installations default to **file-only** access to one dedicated folder. Existing configuration is retained unless explicitly changed; use `--file-only` to disable terminal and GUI access. Enabling terminal or GUI tools gives broader authority. Read [SECURITY.md](SECURITY.md) first.

```sh
git clone --branch v0.1.0-beta.2 --depth 1 https://github.com/picqman-ship-it/astra-bridge.git astra-bridge
cd astra-bridge
./install-macos.sh
```

That is the only command to remember. It checks your Mac (macOS, Apple Silicon/Intel, Node.js 22+, npm, Xcode Command Line Tools) and tells you exactly what to install if something is missing; it never installs system software or uses `sudo`. Then it:

1. installs the pinned dependencies (`npm ci`) and builds mcp-commander;
2. creates `~/remote-workspace` and configures mcp-commander for it in file-only mode;
3. generates your keys in `~/.astra-bridge` (private keys never leave the Mac and are never printed);
4. writes your personal, gitignored `relay/wrangler.personal.jsonc` (asks for your email and a device name);
5. logs you in to Cloudflare (browser) and deploys the relay Worker to **your** account, after asking;
6. installs and starts the Mac agent as a LaunchAgent in your user session, after showing you what it will run;
7. walks you through the one dashboard task it cannot do for you, protecting `/mcp` with Cloudflare Access, and then **verifies** from outside that Access is really in front of it.

Wherever you have to act in a browser or dashboard, it stops with exact instructions (exit code 3). Run `./install-macos.sh` again afterwards to continue; every step it has already done is detected and skipped. At the end it prints the ChatGPT connector settings (step 8 below).

```sh
./install-macos.sh doctor       # read-only health check: config, permissions, build, agent, relay, Access
./install-macos.sh uninstall    # stop and remove the agent; keeps keys and config (add --purge to delete them)
./install-macos.sh --help       # all options, for example --workspace, --email, --enable-terminal
```

Details, exit codes and the reasons there is no signed `.pkg` yet: [beta.2 installer documentation](https://github.com/picqman-ship-it/astra-bridge/blob/v0.1.0-beta.2/installer/README.md).

## Manual setup (advanced / reference)

These are the steps the installer performs, for people who want to do or audit them by hand.

### 1. Get the code and build mcp-commander

```sh
git clone --branch v0.1.0-beta.2 --depth 1 https://github.com/picqman-ship-it/astra-bridge.git astra-bridge
cd astra-bridge
(cd mcp-commander && npm ci && npm run build)
(cd relay && npm ci)
```

### 2. Configure what the Mac side may touch

mcp-commander's remote mode is confined to explicit root folders. Start with files and search only:

```sh
mkdir -p ~/remote-workspace
(cd mcp-commander && npm run remote:setup -- --root ~/remote-workspace --protect ..)
```

This writes `~/.mcp-commander-remote/remote.json` (0600). It exposes 15 file/search tools.

**Roots are checked.** mcp-commander refuses a root that is, contains or sits inside a sensitive location — your home folder, `~/.ssh`, `~/Library/LaunchAgents`, its own installation, `~/.astra-bridge` (your private keys) and anything listed with `--protect` (here the whole checkout: the `relay/` code the LaunchAgent runs, mcp-commander and the installer; the agent also passes its `relay/` directory to mcp-commander itself). Case variants, symlinks and macOS firmlink spellings do not get around the check. A dedicated folder such as `~/remote-workspace` is still the right choice.

Optional, riskier modes:

- Terminal, processes and durable jobs (27 tools; arbitrary code execution as your user — roots no longer contain it):
  `(cd mcp-commander && npm run remote:setup -- --root ~/remote-workspace --protect .. --trusted-terminal --replace-config)`
- GUI tools (`list_windows`, `inspect_ui`, `press_element`, `set_element_value`; +4, so 19 or 31 tools): add `--trusted-gui` to the setup command (or set `"trustedGui": true` by hand in `~/.mcp-commander-remote/remote.json`), then grant Accessibility to your Node binary in **System Settings → Privacy & Security → Accessibility** when macOS asks.

mcp-commander reads `remote.json` only when it starts. After any change to it (including switching a mode off again), restart the agent once it is installed (step 7): `launchctl kickstart -k gui/$(id -u)/com.example.astra-bridge-agent`.

Details: [mcp-commander/docs/remote-runbook.md](mcp-commander/docs/remote-runbook.md) (with Astra Bridge you can skip its HTTP-service and OpenAI-tunnel sections).

### 3. Generate keys

```sh
node relay/scripts/keygen.mjs
```

Creates `~/.astra-bridge/agent-private.pem` and `client-private.pem` (directory 0700, files 0600, never overwritten) and prints two public keys. Private keys never leave the Mac.

### 4. Create your personal Worker config

```sh
cp relay/wrangler.jsonc relay/wrangler.personal.jsonc
```

Edit `relay/wrangler.personal.jsonc` (it is gitignored; the committed `wrangler.jsonc` stays a template and the tests check that it only holds placeholders). Replace every `REPLACE_WITH_*` / `<your-...>` value: the two public keys from step 3, a device name (for example `my-mac`, used in three places), your Worker URL, and your email.

### 5. Deploy the Worker

```sh
cd relay
npx wrangler login
npm run typecheck && npm test
npm run deploy          # = wrangler deploy -c wrangler.personal.jsonc
cd ..
```

Until Access is configured the Worker fails closed (`/mcp` answers 503).

### 6. Protect `/mcp` with Cloudflare Access

Follow [relay/docs/SETUP-ACCESS.md](relay/docs/SETUP-ACCESS.md): create an Access application for `<worker-host>/mcp` only, allow only your email, turn on Managed OAuth, then put `TEAM_DOMAIN` and `POLICY_AUD` into `wrangler.personal.jsonc` and run `npm run deploy` again.

### 7. Install the Mac agent

```sh
node relay/scripts/install-agent.mjs --relay-url https://<your-worker>.<your-subdomain>.workers.dev --device-id my-mac
```

This only prints the LaunchAgent plist. When it looks right, run it again with `--install`; it writes `~/Library/LaunchAgents/com.example.astra-bridge-agent.plist` and prints the `launchctl bootstrap` command for you to run. The agent log is `~/.astra-bridge/agent.stderr.log`.

### 8. Connect ChatGPT

Add a custom connector / app in ChatGPT with the MCP server URL `https://<your-worker>.<your-subdomain>.workers.dev/mcp` and OAuth authentication. Log in through Access and approve. In a chat, select the app and ask, for example, "List the files in my remote workspace".

### 9. Verify (optional)

```sh
cd relay
ASTRA_RELAY_URL=https://<your-worker>.<your-subdomain>.workers.dev \
ASTRA_DEVICE_ID=my-mac \
ASTRA_SMOKE_WORKSPACE=$HOME/remote-workspace \
npm run smoke
```

The smoke test signs its requests with `~/.astra-bridge/client-private.pem` and performs harmless real actions inside the workspace: a file write/read, and a short background job when terminal tools are enabled (skipped in file-only mode). Set `ASTRA_SMOKE_EXPECTED_TOOLS` (15, 19, 27 or 31) to also enforce the exact tool count.

### 10. Liveness alerts (optional)

A cron in the Worker checks every 5 minutes whether your Mac is connected. To get an email when it goes down (after two consecutive failed checks) and when it comes back, enable the `send_email` binding and the `ALERT_*` values in `wrangler.personal.jsonc` and deploy again. This needs a domain with Cloudflare Email Routing turned on and a verified destination address.

## Limits you should know

- **The Mac must be awake and logged in.** A LaunchAgent runs in your login session: nothing runs at the login screen, and sleep suspends everything. After a reboot the agent starts as soon as you log in.
- **Unattended reboots need auto-login**, and macOS only offers auto-login with FileVault turned off. That is a real security trade-off (anyone with the Mac in hand gets your session and an unencrypted disk). Many people should not make it; if you don't, the bridge simply stays offline after a reboot until you log in.
- **Durable jobs** survive disconnects and service restarts, but not a reboot or logout; after one they are reported as `interrupted` and are never re-run automatically.
- The Mac's **screen must be unlocked** for GUI tools; macOS hides windows from Accessibility while it is locked (the tools say so).
- Review the client’s write and control confirmations; confirmation behavior depends on the client and its settings.

## Cost

Cloudflare offers Free and Paid plans; costs depend on usage and current limits. Check [official Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and the current terms for any other services you use.

## Credits and licence

mcp-commander is an independent reimplementation of the core ideas of [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP); its fuzzy-search algorithm and several model-facing message formats follow Desktop Commander, used under the MIT License (see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [mcp-commander/LICENSE](mcp-commander/LICENSE)).

Released under the [MIT License](LICENSE). Provided as is, without warranty; you are responsible for how you deploy and secure it.
