#!/usr/bin/env node
// Astra Bridge macOS installer. Start it through ./install-macos.sh at the repository root,
// which checks for Node.js first. See installer/README.md for every option.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext } from "./lib/context.mjs";
import { doctor, printDoctor } from "./lib/doctor.mjs";
import { install } from "./lib/install.mjs";
import { createUi } from "./lib/ui.mjs";
import { uninstall } from "./lib/uninstall.mjs";
import { Checkpoint, EXIT, InstallerError } from "./lib/util.mjs";
import { normalizeRelayUrl, normalizeTeamDomain, validateDeviceId, validateEmail, validatePolicyAud, validateWorkerName } from "./lib/validate.mjs";

const USAGE = `Astra Bridge for macOS

Usage:
  ./install-macos.sh [install] [options]   guided setup; safe to re-run, continues where it stopped
  ./install-macos.sh doctor [--offline] [--json]
                                           read-only health check (exit 1 on failures)
  ./install-macos.sh uninstall [--purge] [--dry-run] [--yes]
                                           stop and remove the agent; --purge also deletes keys

Install options:
  --workspace <dir>         folder the AI may use (default ~/remote-workspace)
  --email <address>         your email, the only identity Cloudflare Access admits
  --device-id <id>          name of this Mac (default my-mac)
  --worker-name <name>      Cloudflare Worker name (default astra-bridge-relay)
  --relay-url <https://…>   relay address, if not the workers.dev URL wrangler prints
  --team-domain <team>      Access team domain (<team>.cloudflareaccess.com)
  --policy-aud <tag>        Access application audience (AUD) tag
  --account-id <id>         Cloudflare account to deploy to, if your login has several
  --enable-terminal         RISKY: expose shell/process/job tools (code execution as you)
  --enable-gui              RISKY: expose app-window tools (needs Accessibility permission)
  --file-only               turn terminal and GUI tools off again
  --reconfigure             rewrite remote.json (file-only unless --enable-* given; backup kept)
  --redeploy                deploy the Worker even if nothing changed
  --replace-existing-worker allow deploying over a Worker this Mac did not deploy
  --skip-deps               do not run npm ci / npm run build
  --skip-cloudflare         local setup only (no login, deploy or Access steps)
  --beta-enroll             invited beta: file-only, no Cloudflare login
  --invite-file <path>      operator's relay-bound private 0600 invite.json
  --legacy-invite           warned compatibility: hidden prompt / ASTRA_BETA_INVITE
  --reset-pending-identity  recover old beta ID first; otherwise rotate pending ID/key
  --no-network-checks       do not contact the relay (alias --offline)
  --yes, -y                 accept confirmations (never enables terminal/GUI by itself)
  --non-interactive         never prompt; missing answers stop at a checkpoint

Exit codes: 0 done, 1 failed, 2 usage error, 3 checkpoint (an action for you; re-run afterwards).
`;

const VALUE_FLAGS = {
  "--invite-file": "inviteFile",
  "--workspace": "workspace",
  "--email": "email",
  "--device-id": "deviceId",
  "--worker-name": "workerName",
  "--relay-url": "relayUrl",
  "--team-domain": "teamDomain",
  "--policy-aud": "policyAud",
  "--account-id": "accountId",
};
const BOOL_FLAGS = {
  "--legacy-invite": "legacyInvite",
  "--reset-pending-identity": "resetPendingIdentity",
  "--beta-enroll": "betaEnroll",
  "--enable-terminal": "enableTerminal",
  "--enable-gui": "enableGui",
  "--file-only": "fileOnly",
  "--reconfigure": "reconfigure",
  "--redeploy": "redeploy",
  "--replace-existing-worker": "replaceExistingWorker",
  "--skip-deps": "skipDeps",
  "--skip-cloudflare": "skipCloudflare",
  "--no-network-checks": "noNetworkChecks",
  "--offline": "noNetworkChecks",
  "--yes": "yes",
  "-y": "yes",
  "--non-interactive": "nonInteractive",
  "--purge": "purge",
  "--dry-run": "dryRun",
  "--json": "json",
  "--help": "help",
  "-h": "help",
};
const ALLOWED = {
  install: new Set([...Object.values(VALUE_FLAGS), "betaEnroll", "legacyInvite", "resetPendingIdentity", "enableTerminal", "enableGui", "fileOnly", "reconfigure", "redeploy", "replaceExistingWorker", "skipDeps", "skipCloudflare", "noNetworkChecks", "yes", "nonInteractive", "help"]),
  doctor: new Set(["noNetworkChecks", "json", "help", "nonInteractive"]),
  uninstall: new Set(["purge", "dryRun", "yes", "nonInteractive", "help"]),
};

export class UsageError extends Error {}

export function parseArgs(argv) {
  if (argv.some(value => /abi1_[a-f0-9]{64}/i.test(value))) throw new UsageError("invite secrets are never accepted on the command line");
  const opts = {};
  let command = "install";
  let i = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    command = argv[0];
    i = 1;
    if (!(command in ALLOWED)) throw new UsageError("unknown command (value redacted)");
  }
  for (; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if ((a !== "--invite-file" && /^--(token|secret|password|api-key|bearer|private-key|invite|beta-invite)/i.test(a)) || /abi1_[a-f0-9]{64}/.test(argv[i])) {
      throw new UsageError("secrets are never accepted on the command line; use --invite-file");
    }
    if (a in VALUE_FLAGS) {
      const v = inline ?? argv[++i];
      if (/abi1_[a-f0-9]{64}/.test(v ?? "")) throw new UsageError("secrets are never accepted on the command line; use --invite-file");
      if (v === undefined || v === "" || (inline === undefined && v.startsWith("--"))) throw new UsageError(`${a} needs a value`);
      opts[VALUE_FLAGS[a]] = v;
    } else if (a in BOOL_FLAGS && inline === undefined) {
      opts[BOOL_FLAGS[a]] = true;
    } else {
      throw new UsageError("unknown option (values redacted)");
    }
  }
  for (const key of Object.keys(opts)) {
    if (!ALLOWED[command].has(key)) {
      const flag = Object.entries({ ...VALUE_FLAGS, ...BOOL_FLAGS }).find(([, k]) => k === key)[0];
      throw new UsageError(`${flag} does not apply to "${command}"`);
    }
  }
  if (opts.fileOnly && (opts.enableTerminal || opts.enableGui)) throw new UsageError("--file-only cannot be combined with --enable-terminal / --enable-gui");
  if (opts.betaEnroll && opts.deviceId !== undefined) throw new UsageError("beta device IDs are generated; --device-id is not allowed");
  if (opts.accountId && !/^[a-f0-9]{32}$/.test(opts.accountId)) throw new UsageError("--account-id must be the 32-character hex account id");
  for (const [flag, key, validate] of [
    ["--device-id", "deviceId", validateDeviceId], ["--email", "email", validateEmail],
    ["--worker-name", "workerName", validateWorkerName], ["--relay-url", "relayUrl", normalizeRelayUrl],
    ["--team-domain", "teamDomain", normalizeTeamDomain], ["--policy-aud", "policyAud", validatePolicyAud],
  ]) {
    if (opts[key] === undefined) continue;
    try { opts[key] = validate(opts[key]); }
    catch (err) { throw new UsageError(`${flag}: ${err.message}`); }
  }
  return { command, opts };
}

function printCheckpoint(ui, cp) {
  ui.write("");
  ui.warn(`Paused: ${cp.message}`);
  for (const l of cp.instructions ?? []) ui.info(l);
  ui.write("");
  ui.info("Everything done so far is kept. Run ./install-macos.sh again to continue.");
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`install-macos: ${err.message}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  const { command, opts } = parsed;
  if (opts.help) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  const ctx = createContext();
  const ui = createUi({ interactive: Boolean(process.stdin.isTTY) && !opts.nonInteractive && !opts.json, yes: Boolean(opts.yes) });
  try {
    if (command === "doctor") {
      const result = await doctor(ctx, { offline: Boolean(opts.noNetworkChecks) });
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else printDoctor(ui, result);
      return result.ok ? EXIT.OK : EXIT.FAIL;
    }
    if (command === "uninstall") {
      await uninstall(ctx, { purge: Boolean(opts.purge), dryRun: Boolean(opts.dryRun) }, ui);
      return EXIT.OK;
    }
    await install(ctx, opts, ui);
    return EXIT.OK;
  } catch (err) {
    if (err instanceof Checkpoint) {
      printCheckpoint(ui, err);
      return EXIT.CHECKPOINT;
    }
    if (err instanceof InstallerError) {
      ui.write("");
      ui.fail(err.message);
      if (err.hint) ui.info(err.hint);
      return EXIT.FAIL;
    }
    ui.fail(`unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return EXIT.FAIL;
  } finally {
    ui.release();
  }
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) main().then((code) => process.exit(code));
