# ChatGPT mobile / hosted Mac control — 2026-10-03

This checkpoint supersedes the unfinished source/control assignment in the 2026-10-02 handoff. Historical evidence remains unchanged.

Implemented separate local terminal/process/job and GUI opt-in/reduction for an already paired Mac. Initial pairing stays files-v1. Consent identifies the exact account and Mac key; grants are version-bound and atomically applied by migration 0008. Revocation, cancellation, expiry, identity/key changes and stale retries fail closed, including legacy bearer routes. Personal and invited-beta defaults retain their previous behavior.

Interrupted changes remain pending until server and local runtime agree. A marked account agent checks its protected completed review on every RPC, including automatic restart; unknown/pending state denies control but permits file tools. File-only reconciliation always stops tracked jobs. Detached programs outside recorded process groups are not claimed recalled.

Final unchanged-source gates: relay **315 PASS / 0 FAIL / 0 SKIP** (actual D1/workerd and actual agent WSS/stdio included); macOS installer **183 PASS / 0 FAIL / 0 SKIP**. Cancelled/todo 0. TypeScript and diff checks exit 0. Exact source/log hashes and reproduced negative cases: [evidence](evidence/control-permissions-2026-10-03.json).

Canonical committed-source packaging and exact-commit CI are the next local/development checks; their observed results will be added after completion. No deployment, live migration, real installation/control change, main merge, published beta change or plugin submission occurred.

The remaining live product gate is the [proposed isolated staging resource manifest](STAGING-RESOURCE-MANIFEST-2026-10-03.md) and [fresh-account iPhone acceptance](CHATGPT-MOBILE-ACCEPTANCE-2026-10-02.md): install → account pairing → normal ChatGPT iPhone calls → correct Mac read/write/control effect → server revoke. Real resources/test accounts/Macs, human login/Accessibility and optional control effects need explicit scoped authorization. Local runtime tests do not establish mobile/Voice availability or plugin publication.
