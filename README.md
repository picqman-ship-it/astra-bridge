# Astra Bridge

Use ChatGPT — on the web, the desktop app or your iPhone, including voice — to work with **your own Mac**: read, search and edit files, run terminal sessions and long-running background jobs, and optionally drive app windows through macOS Accessibility.

The connection runs through a small relay in **your own Cloudflare account**. Your Mac opens an outbound WebSocket to it; no inbound port is opened and no third-party service sits in the data path (only OpenAI, which you are already talking to, and Cloudflare, which you control).

```text
ChatGPT ──OAuth (Cloudflare Access)──▶ your Worker /mcp ──▶ Durable Object ◀──WebSocket── Mac agent ──stdio──▶ mcp-commander ──▶ files / terminal / jobs / GUI
                                          (your Cloudflare account)            (outbound only)          (your Mac, your user)
```

| Directory | What it is |
|---|---|
| [`relay/`](relay/README.md) | Cloudflare Worker + Durable Object relay, the Mac agent (`relay/src/agent.mjs`), key and LaunchAgent helper scripts |
| [`mcp-commander/`](mcp-commander/README.md) | The MCP server that runs on the Mac and does the actual work (files, terminal sessions, search, durable jobs, GUI tools) |
| [`installer/`](installer/README.md) | The macOS installer behind `./install-macos.sh`: guided setup, `doctor`, `uninstall` |

> [!WARNING]
> **This is remote-shell-equivalent access to your Mac.** Whoever controls your Access login, your Cloudflare account or the signed-RPC client key can do anything your macOS user can do once terminal tools are enabled. Content the AI reads (web pages, emails, documents) can try to steer it through prompt injection. Start in **file-only mode** with a dedicated folder, enable terminal and GUI tools only if you need them, and read [SECURITY.md](SECURITY.md) first. Single owner only — do not share the connector.

## What you need

- A Mac with macOS 13 (Ventura) or newer, Apple Silicon or Intel, with Node.js 22+ (required by the current `wrangler`) and the Xcode Command Line Tools (`xcode-select --install`; they provide `git` and build the small Swift helper the optional GUI tools use).
- A Cloudflare account. The Workers **Free** plan is enough for one Mac; Zero Trust Free for Cloudflare Access.
- A ChatGPT plan that lets you add custom connectors / apps (developer mode).

## Quick start on macOS

> [!CAUTION]
> The installer sets up **file-only** access to one dedicated folder. It never turns on terminal or GUI tools unless you pass `--enable-terminal` / `--enable-gui` and confirm, because those give the AI client the same power over your Mac as you have. Read [SECURITY.md](SECURITY.md) before you start.

```sh
git clone <this repository> astra-bridge && cd astra-bridge
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

Details, exit codes and the reasons there is no signed `.pkg` yet: [installer/README.md](installer/README.md).

## Manual setup (advanced / reference)

These are the steps the installer performs, for people who want to do or audit them by hand.

### 1. Get the code and build mcp-commander

```sh
git clone <this repository> astra-bridge && cd astra-bridge
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
- ChatGPT asks for confirmation before write and control actions; that is intended friction.

## Cost

One Mac fits the Workers **Free** plan: the agent keeps its connection alive with pings that Cloudflare answers without waking the Durable Object, so an idle connection hibernates instead of being billed around the clock. Zero Trust Free covers Cloudflare Access for a single owner. The optional Workers Paid plan is $5/month.

## Credits and licence

mcp-commander is an independent reimplementation of the core ideas of [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP); its fuzzy-search algorithm and several model-facing message formats follow Desktop Commander, used under the MIT License (see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [mcp-commander/LICENSE](mcp-commander/LICENSE)).

Released under the [MIT License](LICENSE). Provided as is, without warranty; you are responsible for how you deploy and secure it.
