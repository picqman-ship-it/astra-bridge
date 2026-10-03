# ChatGPT Mobile / Voice → Astra Bridge → Mac

Current separately consented control and packaged-source milestone: [2026-10-03 checkpoint](CHATGPT-MOBILE-HANDOFF-2026-10-03.md). Earlier counts/status below are historical.

## Product goal

Astra Bridge's product goal is **normal ChatGPT chat on an iPhone → authenticated Astra integration → that user's Mac**. Voice is a separate acceptance target where the actual client/account supports it. Neither universal mobile/Voice availability nor public plugin approval is established by local tests.

The product path is:

```text
Normal ChatGPT mobile chat (Voice requires separate acceptance)
        │
        ▼
Astra ChatGPT plugin (publication remains a release gate)
        │  OAuth-authenticated MCP calls
        ▼
Astra remote MCP (/mcp)
        │
        ├─ identity (issuer + subject) → Astra owner
        ├─ Astra owner → one active Mac device
        ▼
per-device Durable Object
        │  outbound-only WebSocket
        ▼
Mac Astra agent
        │
        ▼
mcp-commander
        │
        ├─ files/search
        ├─ terminal/jobs (explicit opt-in only)
        └─ GUI/Accessibility (explicit opt-in only)
```

Codex is not a dependency of this path. It can coexist as a separate OpenAI product, but it is not the Astra mobile-control architecture.

## Why a published plugin matters

A private developer-mode MCP connection is useful for development, but the end-user product must be a normal ChatGPT plugin so it can be installed from ChatGPT and used from supported ChatGPT clients without asking the user to configure an MCP URL.

The plugin points at one stable public HTTPS MCP endpoint. User authentication happens with OAuth at the Astra service; the authenticated principal, not a caller-provided device id, determines which Mac receives a tool call.

## One-time Mac pairing

Pairing is setup only. It is **not** the command transport.

1. The Mac installer generates/uses the Mac's Ed25519 agent key pair. The private key stays on the Mac.
2. The installer creates a fresh beta-namespace device id and a fresh request id.
3. It signs a domain-separated pairing message with the Mac agent key.
4. `POST /pair/start` validates proof of key possession and creates a short-lived pairing session.
5. The server creates separate random polling and browser-code credentials, storing only their SHA-256 hashes. The poll credential lasts ten minutes; the one-time browser code lasts five minutes.
6. The installer opens the credential-free `/pair/claim` URL and displays the browser code in a local macOS dialog. The code is never placed in a URL, process argument, installer log or saved state; clipboard copying is the user's choice.
7. After authentication, the user submits the code in a same-origin POST. Review consumes the code and creates a five-minute confirmation credential bound to the verified issuer, subject, displayed email, session device/key and `files-v1` scope. The browser displays the account, device and key fingerprint; the user compares them with the installer and explicitly checks file-access consent. A second POST confirms using that credential. An account switch, replay, expired credential or missing checkbox fails closed.
8. D1 binds the external identity tuple `(issuer, subject)` to an internal Astra owner and that device.
9. The installer polls `/pair/status` with the short-lived token kept only in memory.
10. After the claim succeeds, the Mac connects with its existing signed-agent protocol. Future ChatGPT calls require no QR code or pairing token.

A future QR shortcut may encode the credential-free setup URL. Putting either credential into a QR URL would reopen the history/redirect/log review. This is a custom Mac-binding flow inspired by device-code separation, not an implementation of the OAuth device authorization grant.

## Routing invariant

The MCP caller cannot choose a device id.

For account routing:

```text
verified OAuth/Access identity
  → (issuer, subject)
  → active user identity record
  → active Astra owner
  → exactly one active owned device
  → Durable Object named by that device id
```

The current first version deliberately fails closed if an owner has zero or more than one active Mac. Multi-device selection must be implemented explicitly later; it must never silently choose an arbitrary machine.

## Permission model

Successful pairing creates a **file-only** device.

Pairing does not enable shell or GUI control.

A later "Enable Mac control" feature must require explicit permission elevation and keep two boundaries aligned:

1. **server authorization** — the device/principal may receive control-scope tools;
2. **local Mac configuration** — mcp-commander terminal/GUI capabilities are intentionally enabled by the Mac owner.

The two controls must not silently grant one another.

## Current feature gates

Development stays isolated from beta.2 until it passes its own release gates.

- `ACCESS_DEVICE_ROUTING=registry` — resolve authenticated users through D1 instead of the fixed personal device.
- `PAIRING_ENABLED=true` — expose the account pairing routes.
- `BETA_REGISTRY_ENABLED=true` — D1-backed devices/identities are available.

All are opt-in. The tested beta.2 fixed-device path remains the default until this feature is promoted.

## Pairing endpoints

- `POST /pair/start`
  - public pre-auth endpoint;
  - rate-limited;
  - accepts only a bounded JSON body;
  - requires Ed25519 proof of possession for the proposed Mac identity;
  - returns the credential-free `claimUrl`, separate one-time `claimCode`, and installer-only `pairingToken`.

- `GET /pair/status`
  - rate-limited;
  - authenticated only with the short-lived pairing token;
  - returns no user identity or secrets.

- `GET /pair/claim`
  - behind the service's authenticated browser boundary;
  - displays a code-entry form; performs no pairing mutation;
  - rejects query credentials rather than accepting legacy links.

- `POST /pair/claim`
  - authenticated browser identity required;
  - same-origin form submission required;
  - `{code}` consumes the browser code and displays account/device review with a one-time confirmation value. Surrounding whitespace and letter case are tolerated; a malformed code is rejected before any registry access, so a typo never consumes the real code;
  - the confirmation value is bound to the verified issuer, subject and email. It is useless to any other identity, works like an anti-forgery state value rather than a bearer token, and lasts at most five minutes;
  - `{consent, scope=files-v1}` consumes the reviewed pending session and creates the identity→owner→device binding atomically;
  - neither browser credential is accepted by the polling endpoint, and the polling token cannot authorize either browser step.

Every claim page is `no-store`, `no-referrer`, `nosniff`, `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin`. The CSP is `default-src 'none'` and allows no script or external resource. Its `form-action 'self'` also stops a form POST from following a cross-origin redirect, such as an expired Access session, so code/confirmation bodies stay on the relay origin.

Migration `0007_pairing_consent.sql` is additive. Existing pending sessions must restart; existing accounts/devices remain intact. Its CHECK constraints allow only SHA-256 hex credential hashes and only the `files-v1` consent scope; widening scope requires a new migration. An old installer cannot use the new response. Upgrade coordination, packaged-source testing, browser/Access behavior and fresh-account acceptance remain rollout gates. See [acceptance plan](CHATGPT-MOBILE-ACCEPTANCE-2026-10-02.md).

## Security invariants

- Mac private keys never leave the Mac.
- Pairing plaintext tokens are not written to D1, logs, installer state, command-line arguments or generated config.
- External email is metadata/display only; authorization is keyed by issuer + subject.
- Pairing sessions expire and are one-time. A Mac identity or agent key cannot have two live pending sessions, so a retry after a lost start response cannot open a second authorization.
- Confirmation rechecks the reviewed identity, device, key, scope and expiry inside every write of one D1 batch. Any constraint failure rolls back the whole claim; no partial account rows remain.
- Device identity is still cryptographically bound to the agent public key.
- Existing signed agent connect/revocation semantics remain in force.
- Account pairing begins file-only.
- Fixed beta.2 behavior remains unchanged unless the new flags are enabled.
- No production deploy or main-branch merge occurs until relay, installer, packaged-source and real-device tests pass.
