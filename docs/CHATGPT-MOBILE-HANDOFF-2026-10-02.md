# ChatGPT mobile → Astra Bridge → Mac: 2026-10-02 checkpoint

Current separately consented control and packaged-source milestone: [2026-10-03 checkpoint](CHATGPT-MOBILE-HANDOFF-2026-10-03.md). Earlier counts/status below are historical.

## Credential-free claim and account-bound consent: verified local milestone

This section supersedes the rollout status below; the earlier checkpoint and its evidence remain historical. Base: `7291ab39463059b2f1a5c5b6c5be6ccb0d81c8a6`; the remote feature branch was rechecked as unchanged before commit. Codex started this work and stopped at its usage limit. Its intermediate full-relay run (230 pass / 12 fail) failed only because its sandbox denied Miniflare's localhost listener. A separate session outside that sandbox then completed, re-audited and verified the work. Every count below comes from that session's final runs on the committed source.

### Design (implemented)

- The browser opens exactly `/pair/claim`, with no credential in query, fragment or path. Legacy token URLs and POSTs are rejected without reflection. The installer accepts no other claim URL and prints the credential-free URL so the user can switch browsers.
- There are three separate random values, and only their SHA-256 hashes are stored:
  - a 256-bit polling token (installer memory only, ten minutes);
  - a 128-bit browser code (local macOS dialog over stdin, five minutes, one-time; the dialog says never to share it);
  - a 256-bit confirmation value, issued at review and bound to the verified issuer, subject and email, the session device/key and `files-v1`, for at most five minutes.
- Review is an Access-verified, same-origin POST of the code. Confirmation is a second POST with the explicit file-access checkbox. Email-only identity, caller-selected device ids, extra target fields, account switches, replay and widened scope are refused without creating rows.
- Every write in the claim batch rechecks the reviewed identity, device, key, scope and expiry. Any constraint failure rolls back the whole claim, so no partial account rows remain.
- One Mac identity or agent key never has two live pending sessions. A retry after a lost start response gets 409 until the session expires. The installer never rotates identity silently and records completion only after signed device verification.
- `/pair/status` reports `cancelled` once the bound identity, user or device is inactive. Every `/mcp` request re-resolves identity → active user → exactly one active device.
- A malformed `MCP_AUTH_MODE` or `ACCESS_DEVICE_ROUTING` (empty, non-string, unknown) returns 503 before any registry access and never reaches the personal Mac. An unset `MCP_AUTH_MODE` still means static mode. An explicitly empty value is now invalid, matching `relay/README.md`.
- Claim pages send `no-store`, `no-referrer`, `nosniff`, `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin`. The CSP is `default-src 'none'` (no script, no external resource), with `form-action 'self'`, `frame-ancestors 'none'` and `base-uri 'none'`.
- Migration `0007_pairing_consent.sql` is additive. Its CHECKs allow only 64-hex credential hashes, the `files-v1` scope and integer consent times. Migrations 0001–0006 are byte-identical to the base commit.

### Audit findings fixed in this session (negative tests first)

| Finding | Before the fix | Fix |
|---|---|---|
| `INSERT OR IGNORE` silently skips CHECK failures, and review accepted identities the registry cannot store (2-character email, issuer over 512 characters) | A "failed" claim committed an orphan `users` row; reproduced as users 1 / identities 0 / devices 0 | Identity validation mirrors the registry CHECKs (code points, no control characters). Explicit `NOT EXISTS` guards replace `OR IGNORE`, so any constraint failure aborts the batch |
| No database-level scope invariant | A code defect could store a non-file consent scope | 0007 CHECKs on scope, hash format and timestamp type |
| No framing/opener headers beyond CSP | Defense in depth only | `X-Frame-Options: DENY` and `COOP: same-origin` on every claim page |
| A pasted code with whitespace or capitals got the message "already used, wait ten minutes" | User stranded although the code was intact | Trim and lowercase. A malformed code is refused before registry access with its own message |
| Pairing HTTP handlers never ran inside workerd | Runtime-specific gaps untested | A whole-Worker workerd test, described under verification |
| The populated 0006→0007 upgrade ran only in Node SQLite | Not proven in the D1 runtime | A real-D1 upgrade test, described under verification |

Codex's two fixes are kept: no overlapping sessions after a lost start response, and consent rechecked inside each batch write. Both were re-verified with SQLite and real-D1 tests.

### Verification of the committed source

Environment: macOS Intel (Darwin 22.6.0), Node 24.15.0, npm 11.12.1, Miniflare 5.20260926.0-alpha.

| Gate | PASS | FAIL | SKIP |
|---|---:|---:|---:|
| Codex tree as received (re-run here), full relay incl. real D1 | 265 | 0 | 0 |
| Codex tree as received (re-run here), full installer | 153 | 0 | 0 |
| Consent + D1 test files with the new negative tests, before the fix (6 new tests red) | 47 | 6 | 0 |
| New installer negative tests before the fix (two separate runs) | 4 + 4 | 1 + 1 | 0 |
| Focused relay after fix (pairing, consent, HTTP, hardening, access, real D1) | 98 | 0 | 0 |
| Focused installer after fix | 22 | 0 | 0 |
| **Final full relay** (incl. real Miniflare D1 and the workerd e2e) | **276** | **0** | **0** |
| **Final full macOS installer** | **153** | **0** | **0** |

Final typecheck and `git diff --check` exit 0. The source-tree hash was identical before and after the final runs (see evidence). The real-D1 runs cover:

- racing reviewers and claimants;
- simultaneous starts for one Mac;
- injected device- and identity-insert failures, with rollback;
- non-file scope rejected by the database;
- a **populated 0006 → 0007 upgrade**: existing rows identical, legacy sessions unusable as browser credentials, fresh pairing works afterwards;
- a **whole-Worker workerd run**: Mac proof → Access-verified review and consent → pairing status and signed probe → agent WebSocket → Access-authenticated MCP reaching only that Mac (terminal tool refused, same email with another subject refused) → operator `revoke-device` SQL → MCP 401, status `cancelled`, signed probe 403. The only outbound fetch was the Access JWKS.

Two mutants confirmed the e2e test detects a terminal-enabled claim and routing that ignores revocation. A third mutant survived because the routing query checks revocation twice, which is intentional.

Machine-readable results and hashes: [claim/consent evidence](evidence/mobile-claim-consent-2026-10-02.json). Raw logs are local-only, under the gitignored `relay/.local-evidence/claude-session/`.

### Residual risks (accepted, documented, not blockers)

- **Code phishing.** Whoever enters a shown code first, with an identity the Access policy admits, binds that account to the Mac. Mitigations: local-only display, a never-share warning, five-minute one-time code, the account shown before confirmation, and closed-beta Access policy. The Mac cannot yet display which account claimed it. Cancelling the dialog does not cancel the server session; there is no Mac-side cancel endpoint yet.
- **Strict one-time semantics.** A double-submitted code or a lost review response consumes the code. The user re-runs pairing after the ten-minute session ends. The wording now says so.
- **Browser memory.** The review page holds the account-bound confirmation value in a hidden field. It is useless to any other identity, but `no-store` does not prove the browser erased it.
- **Installer recovery** confirms a binding by signed device status, which reflects device/user state but not identity revocation. MCP still denies a revoked identity.
- **Rate budget.** The example `BETA_ENROLL_RATE` is 5/min per address, and a pairing spends 3–4 of those. Check this in staging.
- **History.** Migration 0005 was revised once on 2026-10-01 (`d0f9683` → `2061c6b`), before 0006 existed. That is untagged feature-branch history; per the prior checkpoint, no migration has run outside disposable databases.

### Not done / boundaries

No deployment, live migration, Access/security change, account creation, plugin publication or submission, main merge, published-release change or terminal/GUI elevation occurred. Public ChatGPT mobile, Voice or plugin availability is **not** established by these local results.

### Next action (single, owner-gated)

Isolated staging, fresh-account acceptance per [the acceptance plan](CHATGPT-MOBILE-ACCEPTANCE-2026-10-02.md): install → account pairing → normal ChatGPT mobile invocation → correct Mac effect → server-side revoke. It needs separate owner authorization naming the staging Worker/D1/Access application, test accounts and Macs. Do not run it against live accounts or deployments without that.

---

## Earlier verified checkpoint (historical)

## Product constraint

Normal ChatGPT chat on the phone is the control interface. Astra authenticates the user and routes actions to that user's Mac. Browser account pairing is one-time setup, not a replacement chat/PWA. Codex Remote is not a product dependency.

## Canonical work

Continue `feature/chatgpt-mobile-plugin-beta2`, based on beta.2. This checkpoint follows `94f452080785cf9983ab3c75b91dd4376d9a8fd6`. A separate local `feature/chatgpt-mobile-plugin` prototype exists with different identity tables; its uncommitted work was preserved and was NOT merged.

Neither the published beta.2 assets nor public main nor the working personal relay/Access configuration was changed. The existing owner connector responded successfully in the current ChatGPT session. That does not prove fresh-account onboarding.

## Completed in this patch

- Reject invalid routing settings and registry/static-auth mixtures rather than silently falling back to the personal owner's Mac.
- Enforce hosted rate gates before D1 lookup, reject reserved personal device targets, preserve file-only tools, and emit metadata-only audit records. Database failures return a redacted 503.
- Bind pairing claims to a unique per-attempt transaction marker. Invalid, expired and future-dated grants do not create accounts/identities/devices. A failed device insert rolls back the whole claim. Used pairing status tokens expire too.
- Add migration 0006; preserve the bytes/history of 0005. This migration has run ONLY against disposable local databases.
- Refuse replacement of an existing agent with unproven installation identity. Inconclusive signed recovery does not start another pairing session or rewrite saved identity. A claimed response needs signed-device verification before being marked registered.
- Keep pairing URLs out of process arguments and reflected browser-launch errors. Account-paired uninstall uses hosted-device guidance.

## Verified results

Environment: macOS Intel, Node 24.15.0, npm 11.12.1.

| Gate | PASS | FAIL | SKIP |
|---|---:|---:|---:|
| Unmodified branch baseline relay | 214 | 0 | 0 |
| Unmodified branch baseline installer | 139 | 0 | 0 |
| Added relay regressions before fixes | 2 | 13 | 0 |
| Added installer regressions before fixes | 0 | 8 | 0 |
| Focused relay regressions after fixes | 15 | 0 | 0 |
| Focused installer regressions after fixes | 9 | 0 | 0 |
| Full final relay suite | 230 | 0 | 0 |
| Full final macOS installer suite | 148 | 0 | 0 |

Typecheck and both final suite exit codes: 0. No cancelled tests. Twenty-one reproduced failing regression cases are not a claim of twenty-one distinct vulnerabilities. The ninth installer regression adds explicit no-secret-in-argv coverage.

The final relay suite includes an actual Miniflare D1 test with concurrent claimants, token expiry, and an injected insert failure proving transaction rollback. Node SQLite tests alone are not claimed as provider-runtime evidence.

Machine-readable source/log hashes and results: `docs/evidence/mobile-hardening-2026-10-02.json`. Exact changed source bytes are hashed there; later source changes require fresh verification. CI for a subsequent commit is separate from these local results.

## NOT complete / rollout gates

- The short-lived claim token still appears in the browser query URL. Removing process-argument exposure does not remove browser-history, Access redirect, or edge-log exposure. Finish the browser handoff/consent binding review before any rollout.
- Fresh account: install → account pairing → ChatGPT mobile tool invocation → correct Mac effect → server-side revoke is NOT tested end to end.
- Hosted account pairing remains file-only. Terminal/GUI authority needs a separate explicit server AND local Mac consent mechanism. Never widen it as a side effect of pairing.
- Public plugin listing/submission/approval and the packaged-source gate for this feature are NOT complete. A callable owner connector or a locally generated package is not directory approval.
- The current client, account and enabled integrations determine mobile/Voice availability. Do not repeat a blanket claim that all phone integrations are unsupported; equally, do not claim every account/client is supported without testing it. Consult current official OpenAI docs when implementing that gate.

## Next action

Eliminate or contain the browser claim credential exposure with a minimally scoped, reviewed one-time handoff and explicit account/device consent binding; add negative tests first. Keep normal ChatGPT as the command interface. Then complete the fresh-account acceptance in isolated staging, without changing the working owner deployment.
