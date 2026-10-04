# Mobile staging deployment kit

Prepared 2026-10-04. **Offline preparation; nothing deployed or installed.**

This kit reuses mobile source `b79c557cb5a31b0d1ef9b55dbbf3dd60f676b414` and feature evidence at `08bb3fb4a558e4b154aeaabaa812c31b2d1f6999`. It does not change the runtime. [Astra CI passed for the exact feature head](https://github.com/picqman-ship-it/astra-bridge/actions/runs/37121601306). Historical native/packaged gates are in [evidence.json](evidence.json); they are not live iPhone acceptance.

## What is ready

- Exact tested source archive identity and checksum.
- An offline renderer for a separate, explicit Worker config; missing or inconsistent targets are rejected before writing.
- Resource names, Access route checklist, all eight source migrations, initial file-only scope and acceptance record.
- Deployment, revocation and cleanup sequence below. These commands are instructions for the selected staging scope, not an automatically executed deployment script.

## Targets still needed

Select the Cloudflare account and first test Mac/local user before any live writes. An existing candidate account is recorded in the owner's private staging note; it is not published here and discovery is not account selection.

Use a **new macOS user or separate test Mac**. The installer has a fixed LaunchAgent label and per-user locator: a new folder or `ASTRA_HOME` alone does not isolate it. Do not run this installer in the current owner's working Mac user. Do not override `HOME`.

Choose test identity A, dedicated local user/folder, and the iPhone account. Identity/Mac B is needed later for the cross-account test. No passwords, tokens or pairing codes belong in these files.

New D1 ID, Worker hostname and Access ID/AUD are outputs of authorized resource creation. The user does not need to invent or research them. Record actual returned IDs before migration or deployment.

Proposed names remain those in the earlier reviewed plan:

| Resource | Name |
|---|---|
| Worker | `astra-mobile-control-staging-20261003` |
| D1 | `astra-mobile-control-staging-registry-20261003` |
| Access app | `Astra Mobile Control Staging 2026-10-03` |

The existing beta.2 Worker, database, Access app, owner installation and release assets are excluded. Initial staging enables pairing and files only; invited enrollment and the permission service remain disabled. Later terminal/GUI testing requires its own actual device consent and scope.

## 1. Reuse the verified archive

The canonical archive already on the owner Mac is `astra-bridge-0.1.0-b79c557cb5a3.tar.gz`, SHA-256:

```text
b7031df82f770c211660e6ffac0223d8da24bde06a1c6a35927fa0f725a83a09
```

Use the existing copy under `CommanderWorkspace/astra-finish-package-20261003-b79c557/a/`. Check its adjacent checksum file from that directory. It was rechecked on 2026-10-04. Safely extract to a new directory after checking that all entries remain under the expected prefix, with no absolute/traversal names or escaping links. Never extract over an installation.

A Linux rebuild has identical source contents but a different archive SHA; it is not a substitute for the recorded artifact. Keep both identities distinct. Root `docs/` and this staging kit are not included by the source archive builder, so retain this kit alongside the source.

## 2. Create and record isolated resources

After target selection, inspect only the chosen account's staging inventory and reuse an exact matching resource only if its identity and purpose are established. A name collision with an unknown resource stops the procedure. Use the source's locked Wrangler dependency; do not fall back to an implicit account or global installation.

1. Create the named isolated D1 database. Record its returned ID/account/name in a private copy of `targets.example.json`.
2. Reserve the named staging Worker and obtain its exact workers.dev origin. If a placeholder Worker is necessary to establish the hostname, it must return no tool service and contain no credentials or bindings; configure Access before deploying Astra.
3. Create a separate Access application for that origin with the same coherent AUD for `/mcp` and `/pair/claim`, Managed OAuth enabled, and only selected test identities allowed. Follow [access-boundary.json](access-boundary.json) and the source [Access guide](../../relay/docs/ACCOUNT-PAIRING-ACCESS.md). Verify actual precedence of public exceptions; ordinary Access login alone does not establish MCP OAuth.
4. Confirm six unused positive rate namespaces. The example IDs are proposals, not allocations. Set `namespace_inventory_checked` only after recording that inventory check.

These are cloud writes and must stay within the selected new resources. No live identity rows or credentials need to be exported.

## 3. Render and inspect the concrete config

Fill the private targets file using actual selected/returned values. Renderer output is fixed to the extracted source's `relay/wrangler.mobile-staging.local.jsonc`; it never changes the generic template or a personal config.

From this kit's `staging/mobile` directory:

```sh
node render-config.mjs /absolute/path/targets.local.json /absolute/path/extracted-source
```

The renderer does not read credentials, call Cloudflare, grant authority or verify Access. A complete manifest is not authorization. It refuses to overwrite different content or a symlink. Keep the output private and gitignored. No owner device or signing keys are copied. Both control service and invited enrollment remain off.

From the extracted source's `relay` directory, use locked dependencies and the explicit file for every command:

```sh
npm ci
./node_modules/.bin/wrangler deploy --dry-run --config wrangler.mobile-staging.local.jsonc --outdir .dry-run-mobile-staging
./node_modules/.bin/wrangler d1 migrations list BETA_REGISTRY --remote --config wrangler.mobile-staging.local.jsonc
```

The last command is a live read, not an offline test. Before any live command, remove inherited account/environment overrides and verify that the effective account equals the selected config account; stop on any mismatch. Confirm the exact D1 ID, names and reviewed dry-run output. Apply **0001–0008**, including the permissions overlay schema even though control is off:

```sh
./node_modules/.bin/wrangler d1 migrations apply BETA_REGISTRY --remote --config wrangler.mobile-staging.local.jsonc
./node_modules/.bin/wrangler deploy --config wrangler.mobile-staging.local.jsonc
```

Do not use the project's default `npm run deploy`, which targets `wrangler.personal.jsonc`. Do not run against inherited Wrangler environments. Record the actual deployment ID. Verify unauthenticated `/mcp` and `/pair/claim` are protected and device/pairing paths retain their route-specific Worker authentication and rate limits. `/healthz` and the ownership-challenge route are intentionally public; an unconfigured challenge and disabled enrollment/control services should refuse or return 404 as implemented. Verify provider logs do not capture credentials or bodies.

## 4. Derive a pinned test installer

Once the canonical staging origin is known, use a separate safe extraction of the canonical archive. Run the pin script from the unmodified trusted mobile checkout or unmodified canonical extraction, targeting a **different** extracted directory. The pin script deliberately refuses to modify its own source root:

```sh
node /absolute/path/unmodified-mobile-source/installer/pin-beta-release.mjs /absolute/path/derived-source https://exact-approved-staging-origin
```

Never pin the checkout or overwrite the canonical archive. Record the derived archive's new SHA-256, verify only the reviewed origin pin changed, and run the required packaged gates before installation. The original source's trust anchor remains null. Do not bypass the pin with flags or environment variables.

In the **selected dedicated test user's login session**, inspect the local account and clean installation state, then run from the reviewed derived source:

```sh
./install-macos.sh --account-pair --workspace /absolute/approved/test/folder
```

This is not a command for the existing owner Mac user. Human login and the displayed account/Mac/fingerprint/file-access consent must be completed by the user. The initial run must leave terminal/GUI disabled.

## 5. Prove actual iPhone behavior

Use the actual supported authenticated integration offered to the fresh ChatGPT account. Record the app version, plan/policy and integration surface. If normal iPhone chat cannot expose or call it, record the blocker; do not substitute the current owner connector, Codex, PWA or a direct MCP client.

1. Put a unique non-secret marker in `mobile-acceptance.txt` in the approved test folder.
2. In normal iPhone ChatGPT: “Use Astra to read mobile-acceptance.txt in my approved test folder and tell me its marker.” Verify Mac A and audit device identity.
3. Ask to create `mobile-result.txt` with another unique marker. Verify exact bytes on Mac A and no effect on another Mac.
4. Confirm terminal and GUI requests are denied. Test identity/Mac B isolation when the second approved test target is available.
5. Record each observed outcome and UTC timestamp in a private copy of `acceptance-record.example.json`. Empty fields remain untested.

## 6. Revoke and clean up exact test targets

Prepare revocation SQL offline, from verified staging owner/device metadata:

```sh
node relay/scripts/beta-invite.mjs revoke-device --owner VERIFIED_STAGING_OWNER --device-id VERIFIED_STAGING_DEVICE --out NEW_REVIEW_DIRECTORY
```

Review owner/device predicates before applying the SQL to the exact staging D1. Revoke first; prove new/existing ChatGPT calls and signed reconnect/status deny access. Connector disconnection alone does not prove revocation.

Then offboard only the selected test user's installation and remove only the staged resources whose recorded IDs match. Preserve acceptance evidence. Do not delete resources by a name guess, purge the owner installation, revoke the owner's current connector, or alter published beta.2.

## Validation scope

Run `node --test render-config.test.mjs` for the preparation tool. Existing source gates are reused because runtime and test files are untouched. Live staging, login, Access behavior, fresh-account iPhone availability and publication remain separate results.
