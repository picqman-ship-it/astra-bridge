# Security

## What this software is

Astra Bridge gives an AI client (for example ChatGPT) tool access to **your own Mac** through a relay in your own Cloudflare account. Depending on how you configure mcp-commander, the connected client can:

| Mode | Tools | What that means |
|---|---|---|
| file-only (default) | 15: read, list, search, write, edit and move files inside the configured roots | A client can read and change anything under those folders |
| `trustedTerminal` | 27: adds terminal sessions, process control and durable background jobs | **Arbitrary code execution as your macOS user.** Roots no longer contain it; a shell can reach every file you can |
| `trustedGui` | +4: list windows, inspect UI trees, press controls, set values | The client can read and operate app windows of your user. Pressing and typing are refused in protected system apps (System Settings, Keychain Access, Passwords, the login and security dialogs, Installer, Disk Utility and others) and in secure text fields; listing and inspecting are not |

It is designed for **a single owner** controlling **their own machine**. It is not a sandbox and not a multi-user service.

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

1. Start in **file-only mode** with a dedicated folder (`~/remote-workspace`). mcp-commander refuses roots that overlap your home folder, `~/.astra-bridge` (private keys), its own installation and other sensitive locations, and the agent adds its own code directory; keep `--protect ../relay` in the setup command so every mcp-commander process enforces that too.
2. Enable `trustedTerminal` / `trustedGui` only when you need them, and turn them off again afterwards. mcp-commander reads `remote.json` only at startup, so restart the agent after every change (`launchctl kickstart -k gui/$(id -u)/com.example.astra-bridge-agent`); until then the old mode stays active.
3. Keep your Access policy to your exact email, keep session and token lifetimes short, and use a strong login with MFA.
4. Treat `client-private.pem` like an SSH private key. Never commit or share any `.pem` file.
5. Keep ChatGPT's confirmation prompts for write and control actions; read them before approving.
6. Be careful combining browsing or email-reading tasks with terminal tools in the same conversation.
7. Auto-login (needed for unattended reboots) requires FileVault off. Weigh that before enabling it; the bridge works without it, it just waits for you to log in after a reboot.
8. To cut access immediately: disable the Access application or delete the Worker, and stop the LaunchAgent (`launchctl bootout gui/$(id -u)/com.example.astra-bridge-agent`). To keep it from starting again at your next login, also remove the plist (`node relay/scripts/install-agent.mjs --uninstall` prints both commands).

## Reporting a vulnerability

Please open a GitHub issue with a short description and mark it as security-related. Do not include exploit details, secrets or personal data in a public issue; ask for a private channel in the issue instead.
