# Security

> **Public beta — v0.1.0-beta.2. Not production-ready.** Distributed as unsigned, non-notarized source. Review this document before installation or enabling broader access.

## What this software is

For advanced self-deploy, Astra Bridge gives an AI client (for example ChatGPT) tool access to **your own Mac** through a relay in your own Cloudflare account. Depending on how you configure mcp-commander, the connected client can:

| Mode | Tools | What that means |
|---|---|---|
| file-only (default) | 15: read, list, search, write, edit and move files inside the configured roots | A client can read and change anything under those folders |
| `trustedTerminal` | 27: adds terminal sessions, process control and durable background jobs | **Arbitrary code execution as your macOS user.** Roots no longer contain it; a shell can reach every file you can |
| `trustedGui` | +4: list windows, inspect UI trees, press controls, set values | The client can read and operate app windows of your user. Pressing and typing are refused in protected system apps (System Settings, Keychain Access, Passwords, the login and security dialogs, Installer, Disk Utility and others) and in secure text fields; listing and inspecting are not |

It is designed for **a single owner** controlling **their own machine**. It is not a sandbox and not a multi-user service.

### Invited testing

Invited testing uses an operator-controlled relay and file-only device access. The operator controls the relay infrastructure and server-side authorization and is part of the trust boundary. Each connection is for its intended owner; do not share invite files or connector credentials. See the [beta.2 enrollment guide](https://github.com/picqman-ship-it/astra-bridge/blob/v0.1.0-beta.2/relay/docs/BETA-ENROLLMENT.md).

## Who can control your Mac

- Anyone who can pass your Cloudflare Access policy for `/mcp` (your identity provider login).
- Anyone who holds `~/.astra-bridge/client-private.pem` (signed `/v1/device/*` RPC).
- Anyone who holds `~/.astra-bridge/agent-private.pem`: they can connect as your device, see every tool call's arguments and return forged results.
- Anyone who controls your Cloudflare account or can deploy to the Worker.
- The AI client acting on content it reads: web pages, emails, documents and tool output can contain instructions (**prompt injection**). A model that can both read untrusted content and run shell commands is the classic risky combination.

## What the relay enforces

- `/mcp` accepts only Access-issued, signature-verified JWTs for the configured audience and (optionally) an email allowlist; misconfiguration fails closed (503).
- The device an MCP request reaches is fixed by configuration; a request cannot choose another device.
- A reviewed tool allowlist is enforced at the Worker and in the Durable Object; configuration-changing tools are never exposed.
- Mutating tools that create side effects (11 of them, listed in `relay/README.md`) require idempotency keys, so a retried request cannot silently repeat an action.
- Signed RPC uses Ed25519 with timestamp and nonce replay protection; private keys never leave the Mac and only public keys are in Cloudflare.
- mcp-commander roots can never be, contain or sit inside protected locations (keys, agent code, its own installation, shell and launch configuration); the check follows the on-disk spelling, symlinks, firmlinks and device/inode identity. With `trustedTerminal` on, a shell can still reach any file your user can.
- Body, frame, rate and concurrency limits. Relay and agent failures reach clients only as fixed error codes; a tool's own error result (for example "file not found") is passed through as tool output.
- The relay does not log tool arguments or results.

## Recommendations

1. Start in **file-only mode** with a dedicated folder (`~/remote-workspace`); `./install-macos.sh` does exactly that. mcp-commander refuses roots that overlap your home folder, `~/.astra-bridge` (private keys), its own installation and other sensitive locations, and the agent adds its own code directory. Keep the whole checkout protected (`--protect ..` in the manual setup command; the installer adds it for you) so no root can ever reach the agent, mcp-commander or installer code that runs as you.
2. Enable `trustedTerminal` / `trustedGui` only when you need them, and turn them off again afterwards. mcp-commander reads `remote.json` only at startup, so restart the agent after every change (`launchctl kickstart -k gui/$(id -u)/com.example.astra-bridge-agent`); until then the old mode stays active.
3. Keep your Access policy to your exact email, keep session and token lifetimes short, and use a strong login with MFA.
4. Treat `client-private.pem` like an SSH private key. Never commit or share any `.pem` file.
5. Review the client’s write and control confirmations; confirmation behavior depends on the client and its settings.
6. Be careful combining browsing or email-reading tasks with terminal tools in the same conversation.
7. Auto-login (needed for unattended reboots) requires FileVault off. Weigh that before enabling it; the bridge works without it, it just waits for you to log in after a reboot.
8. Emergency stop: run `./install-macos.sh uninstall --yes` on the Mac. It stops the agent and disables it at login, disables durable job submissions, cancels queued jobs and verifies that the recorded worker and job process groups are gone before removing the LaunchAgent. Unknown identities or failed shutdowns stop the cleanup and keep the evidence; the agent stays stopped and does not start again at login. For complete remote revocation, delete the relay Worker in the correct Cloudflare account (Workers & Pages), or, with the agent still stopped, move both private keys out of `~/.astra-bridge` and re-run `./install-macos.sh --file-only`: it creates new agent/client keys and redeploys before it starts the agent again. Uninstall keeps `remote.json`, including its terminal/GUI flags, so reinstall with `--file-only` after a compromise. Access protects `/mcp` only: disabling or removing Access does **not** revoke signed `/v1/device/*` RPC. Remove the connector and Access application after relay revocation. Previously launched programs that detached from tracked process groups need separate local inspection; arbitrary terminal execution cannot be undone by uninstall.
9. Run `./install-macos.sh doctor` after changes and now and then: it checks key and config permissions, that the deployed relay matches your keys, that the agent runs, and that Cloudflare Access really sits in front of `/mcp`.

For an **invited installation**, stop the local agent and have the operator revoke the device and its connector tokens. Local uninstall or purge does not revoke server-side authorization. After revocation, fresh enrollment requires fresh keys and a fresh invite. Testers must not follow the self-deploy Worker deletion or redeployment instructions.

## What the macOS installer does and does not do

- It never installs system software, never uses `sudo`, and never turns on terminal or GUI tools unless you pass `--enable-terminal` / `--enable-gui` (and, in a terminal, type `enable`). `--yes` does not enable them.
- It never prints private keys, never accepts secrets on its command line, and writes the personal config only where git ignores it.
- It deploys only to the Cloudflare account you log in to, after asking, and refuses to overwrite a Worker it did not deploy from this Mac unless you confirm.
- It reports Cloudflare Access as configured only after an outside request to `/mcp` shows the Access challenge. It cannot see your Access policy, so check yourself that the policy admits only your email (the Worker enforces `ACCESS_ALLOWED_EMAILS` as well).
- `uninstall` keeps keys and configuration unless you add `--purge`, which deletes only a fixed list of Astra Bridge files.
- Nothing is code-signed or notarized yet; see [beta.2 installer documentation](https://github.com/picqman-ship-it/astra-bridge/blob/v0.1.0-beta.2/installer/README.md). Read the scripts before running them; they are plain shell and Node.js without dependencies.

## Reporting a vulnerability

Please open a GitHub issue with a short description and mark it as security-related. Do not include exploit details, secrets or personal data in a public issue; ask for a private channel in the issue instead.
