# ChatGPT Mobile / Voice → Astra Bridge → Mac

## Product goal

Astra Bridge exists to let a person use **normal ChatGPT on a phone, including Voice**, and have an Astra plugin securely act on that person's Mac.

The product path is:

```text
ChatGPT mobile / Voice
        │
        ▼
published Astra ChatGPT plugin
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
5. Only a SHA-256 hash of the pairing secret is stored server-side.
6. The installer opens the relay's `/pair/claim` page in the browser.
7. The user authenticates through the Astra identity boundary and explicitly confirms the Mac.
8. D1 binds the external identity tuple `(issuer, subject)` to an internal Astra owner and that device.
9. The installer polls `/pair/status` with the short-lived token kept only in memory.
10. After the claim succeeds, the Mac connects with its existing signed-agent protocol. Future ChatGPT calls require no QR code or pairing token.

QR can later be added as a convenience representation of the same one-time claim URL. It must not contain a long-lived Mac credential.

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
  - returns a short-lived one-time claim URL/token.

- `GET /pair/status`
  - rate-limited;
  - authenticated only with the short-lived pairing token;
  - returns no user identity or secrets.

- `GET /pair/claim?token=...`
  - behind the service's authenticated browser boundary;
  - displays the device id and SHA-256 public-key fingerprint;
  - warns that initial access is file-only.

- `POST /pair/claim`
  - authenticated browser identity required;
  - same-origin form submission required;
  - consumes the pending session and creates the identity→owner→device binding.

## Security invariants

- Mac private keys never leave the Mac.
- Pairing plaintext tokens are not written to D1, logs, installer state, command-line arguments or generated config.
- External email is metadata/display only; authorization is keyed by issuer + subject.
- Pairing sessions expire and are one-time.
- Device identity is still cryptographically bound to the agent public key.
- Existing signed agent connect/revocation semantics remain in force.
- Account pairing begins file-only.
- Fixed beta.2 behavior remains unchanged unless the new flags are enabled.
- No production deploy or main-branch merge occurs until relay, installer, packaged-source and real-device tests pass.
