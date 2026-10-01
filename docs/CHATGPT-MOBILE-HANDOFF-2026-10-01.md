# ChatGPT mobile → Astra Bridge checkpoint — 2026-10-01

Goal: ChatGPT chat on iPhone/mobile controls the user's Mac through Astra Bridge. Codex Remote is not the primary product path.

## Product direction
- ChatGPT is the client.
- Astra Bridge is the plugin/app/MCP integration layer.
- Relay routes the authenticated ChatGPT user to that user's registered Mac.
- QR is optional onboarding/pairing assistance, not the core control path.
- Do not redesign around Codex.

## Current safe implementation state
Work is isolated on branch:
- `feature/chatgpt-mobile-plugin-beta2`
- based from `v0.1.0-beta.2`
- do not modify `main` or the verified beta.2 release while this work is experimental.

Implemented on the feature branch:
- `relay/src/access-registry.ts` — resolves an authenticated external identity to exactly one active Astra device.
- `relay/migrations/0004_access_identities.sql` — adds `user_identities` keyed by `issuer + subject`.
- `relay/src/access-auth.ts` — Access auth can use a dynamic principal resolver; file-only devices receive read/write scopes, control-enabled devices receive full scopes.
- `relay/src/index.ts` — optional `ACCESS_DEVICE_ROUTING=registry` path routes authenticated Access identities through D1 to their device.
- `relay/package.json` — includes `access-registry.ts` in the test build.
- `.github/workflows/relay-ci.yml` — CI workflow added for feature branches.
- `relay/test/access-registry.test.mjs` — resolver tests started.

## Important safety constraints
- Keep existing personal/single-owner route unchanged by default.
- Registry routing must be explicit opt-in and fail closed.
- Never route by email alone; use authenticated issuer + subject.
- Never let the request choose an arbitrary device ID.
- Fail closed if an identity has zero or multiple active devices until explicit multi-device selection is designed.
- Keep private agent keys on the Mac.
- Do not merge or deploy until full relay + installer tests pass and mobile ChatGPT behavior is verified end to end.

## Next step when resuming
1. Finish/verify `access-registry.test.mjs`.
2. Add integration tests for Access JWT → D1 identity → correct device relay.
3. Add negative tests: unknown identity, revoked identity/device, multiple active devices, personal-device targeting.
4. Add operator pairing/bootstrap flow that creates `user_identities` only after verified enrollment.
5. Run full relay suite, installer suite, and archive/repro checks.
6. Only then test real ChatGPT mobile → Astra → Mac end to end.

Status when paused: implementation in progress, not deployed, main/release untouched.
