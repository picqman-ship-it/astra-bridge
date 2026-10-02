# ChatGPT mobile → Astra Bridge → Mac: 2026-10-02 checkpoint

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
