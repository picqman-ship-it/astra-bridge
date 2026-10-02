// Conservative removal. By default only the agent is stopped and its LaunchAgent removed; keys,
// configs, the workspace and the deployed Worker stay. --purge additionally deletes an explicit
// list of Astra Bridge files (never a whole directory tree, never the workspace).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeLaunchctl } from "./context.mjs";
import { KEY_FILES } from "./keys.mjs";
import { createLaunchd, findOtherAgents } from "./launchd.mjs";
import { installedPaths, metadataFile, recordInstallation } from "./install-metadata.mjs";
import { Checkpoint, InstallerError, shQuote } from "./util.mjs";
import { readPersonalConfig } from "./wrangler-config.mjs";
import { stopJobs } from "./offboarding.mjs";
import { readState } from "./state.mjs";
import { agentFingerprint } from "./beta-enrollment.mjs";
import { validatePublicKeyB64 } from "./validate.mjs";

function present(file) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  return st && (st.isFile() || st.isSymbolicLink()) ? file : null;
}

export async function uninstall(ctx, { purge = false, dryRun = false } = {}, ui, { makeLaunchd = createLaunchd } = {}) {
  if (!dryRun) assertSafeLaunchctl(ctx);
  const { readTemplate } = await import(pathToFileURL(ctx.installAgent).href);
  const { label } = readTemplate();
  const plistFile = path.join(ctx.launchAgentsDir, `${label}.plist`);
  const launchd = makeLaunchd({ launchctl: ctx.launchctl, uid: ctx.uid, label });
  const personal = readPersonalConfig(ctx.personalConfig);
  const workerName = personal.values?.workerName ?? "astra-bridge-relay";

  const actions = [];
  const st = launchd.status();
  if (st.loaded === null) throw new InstallerError(`agent shutdown is UNKNOWN: ${st.error}; nothing removed`);
  if (st.loaded) {
    actions.push({
      text: `stop the agent (launchctl bootout ${shQuote(launchd.target)})`,
      run: async () => {
        if (launchd.bootout().status !== 0) throw new InstallerError("launchctl bootout failed; shutdown is UNKNOWN; nothing removed");
        if (!(await launchd.waitUnloaded())) throw new InstallerError("shutdown was not confirmed; nothing removed", { hint: `Try: launchctl bootout ${shQuote(launchd.target)}` });
      },
    });
  }
  if (st.loaded || fs.lstatSync(plistFile, { throwIfNoEntry: false })) {
    // Until the LaunchAgent file is removed, a cleanup that stops early must not come back at login.
    actions.push({
      text: `disable the agent at login (launchctl disable ${shQuote(launchd.target)})`,
      done: "disabled the agent at login",
      run: () => {
        if (launchd.disable().status !== 0) throw new InstallerError("launchctl disable failed; the agent could start again at the next login; nothing removed", { hint: `Run: launchctl disable ${shQuote(launchd.target)}` });
      },
    });
  }
  const plist = fs.lstatSync(plistFile, { throwIfNoEntry: false });
  // Nothing runs unless the installation's paths validate; stopping and disabling the agent by
  // its label needs no paths, so the refusal says how to do that by hand.
  const byHand = `To stop the agent right away regardless: launchctl bootout ${shQuote(launchd.target)}; launchctl disable ${shQuote(launchd.target)}`;
  let installed = null;
  if (plist || purge || fs.lstatSync(metadataFile(ctx), { throwIfNoEntry: false })) {
    try {
      installed = await installedPaths(ctx, plistFile);
    } catch (err) {
      throw new InstallerError(err.message, { hint: byHand });
    }
  }
  const installedHome = installed?.astraHome ?? ctx.astraHome;
  const identityState = readState({ ...ctx, stateFile: path.join(installedHome, "install-state.json") });
  const beta = identityState.betaEnrollment ?? identityState.accountPairing;
  const remoteDir = installed?.commanderRemoteDir ?? ctx.commanderRemoteDir;
  if (fs.lstatSync(path.join(remoteDir, "durable"), { throwIfNoEntry: false })) {
    if (!installed) throw new InstallerError("no validated installation paths for durable jobs; refusing to signal another setup's workers");
    actions.push({ text: `disable durable jobs, cancel queued work and verify tracked worker/process shutdown in ${remoteDir}`,
      done: (r) => `durable jobs disabled and verified stopped (${r.cancelled} queued cancelled, ${r.stopped} process(es) stopped)`,
      run: () => stopJobs(ctx, remoteDir) });
  }
  if (plist) {
    if (!plist.isFile() || !fs.readFileSync(plistFile, "utf8").includes(`<string>${label}</string>`)) {
      throw new InstallerError(`${plistFile} is not the LaunchAgent this installer writes; leaving it alone`);
    }
    actions.push({ text: `remove ${plistFile}`, run: () => fs.rmSync(plistFile) });
    // With the file gone nothing can load; lift the login block so a later manual load works.
    actions.push({
      text: "clear the login block (nothing is left to load)",
      quiet: true,
      run: () => {
        if (launchd.enable().status !== 0) ui.warn(`launchd still has ${launchd.target} disabled; run launchctl enable ${shQuote(launchd.target)} before loading an agent by hand`);
      },
    });
  }

  const purgeFiles = purge
    ? (installed.partialFiles ?? [
        ...Object.values(KEY_FILES).map((f) => path.join(installedHome, f)),
        path.join(installedHome, "agent.stdout.log"),
        path.join(installedHome, "agent.stderr.log"),
        path.join(installedHome, "install-state.json"),
        installed.personalConfig,
        metadataFile(ctx),
      ]).filter(present)
    : [];
  for (const f of purgeFiles) actions.push({ text: `DELETE ${f}`, run: () => fs.rmSync(f) });
  if (purge) {
    actions.push({
      text: `remove ${installedHome} if it is then empty`,
      run: () => {
        try {
          fs.rmdirSync(installedHome);
        } catch {}
      },
      quiet: true,
    });
  }

  ui.heading(`Uninstall${purge ? " --purge" : ""}${dryRun ? " (dry run)" : ""}`);
  const real = actions.filter((a) => !a.quiet);
  if (!real.length) ui.ok("nothing to remove: the agent is not installed" + (purge ? " and no Astra Bridge files were found" : ""));
  else for (const a of real) ui.info(`will ${a.text}`);

  ui.write("");
  ui.info("Kept (remove yourself if you want):");
  if (!purge) {
    ui.info(`  keys and logs in ${installedHome}, ${ctx.personalConfig}  (./install-macos.sh uninstall --purge deletes them)`);
  }
  ui.info(`  mcp-commander config and durable job records (other setups may use them): ${remoteDir}`);
  ui.info("  Job records are kept. Unknown process identities block removal; inspect them locally before deleting any state.");
  ui.info("  Programs previously launched with terminal access may have detached from tracked groups; inspect those separately.");
  ui.info("  your workspace folder(s) and their files");
  ui.info("  build output: (cd mcp-commander && rm -rf node_modules dist) && (cd relay && rm -rf node_modules .wrangler)");
  if (beta) {
    let fingerprint = null;
    try { fingerprint = agentFingerprint(validatePublicKeyB64(beta.agentPublicKeyB64)); } catch {}
    const keyGuidance = fingerprint ? `agent SHA-256 ${fingerprint}`
      : beta.rotationRequired ? "agent fingerprint unavailable: pending key rotation"
      : "agent fingerprint unavailable: no valid saved public key";
    ui.warn(`Ask the operator to revoke device ${beta.deviceId} and its connector tokens (${keyGuidance}).`);
    ui.info("  Uninstall/purge does not revoke the server-side beta device or connector authorization.");
    ui.info("  After operator revocation, use uninstall --purge to remove the old keys, then re-enroll with --beta-enroll --invite-file /path/to/fresh-invite.json. No Cloudflare login or deployment is needed on this Mac.");
  } else {
  ui.info(`  the Worker in Cloudflare: in the correct account, Workers & Pages → ${workerName} → Settings → Delete`);
  ui.info("  Access protects /mcp only. Disabling Access does NOT revoke signed /v1/device RPC.");
  ui.info("  To revoke relay access completely, delete the Worker, or keep the agent stopped, move both private keys aside");
  ui.info("  and re-run ./install-macos.sh --file-only (new keys are deployed before the agent starts again).");
  ui.info("  remote.json keeps its terminal/GUI flags: after a compromise, reinstall with --file-only.");
  ui.info("  Then remove the Access application and connector if no longer needed.");
  }
  for (const other of findOtherAgents(ctx.launchAgentsDir, label)) {
    ui.warn(`not touched: another Astra Bridge LaunchAgent ${other.label} (${other.file})`);
  }

  if (!real.length) return;
  if (dryRun) {
    ui.write("");
    ui.ok("dry run: nothing was changed");
    return;
  }
  if (purgeFiles.length) {
    ui.danger(beta
      ? ["--purge deletes this Mac's beta private keys. Ask the operator to revoke the old device and connector tokens.", "Re-enroll with --beta-enroll --invite-file /path/to/fresh-invite.json; workspace files are kept."]
      : ["--purge deletes your Astra Bridge private keys. The relay cannot be used from this Mac", "again until you generate new keys and redeploy (./install-macos.sh does both)."]);
    const ok = ui.interactive ? await ui.typed("Delete these files?", "delete") : ui.yes;
    if (!ok) throw new Checkpoint("nothing was deleted", { instructions: ["Non-interactive: add --yes together with --purge to delete them."] });
  } else if (!(await ui.confirm("Stop and remove the agent?", { what: "uninstall the agent" }))) {
    throw new Checkpoint("nothing was changed");
  }
  // Validate once more after user input, then preserve the locator for a later purge.
  if (installed) {
    const now = await installedPaths(ctx, plistFile);
    if (JSON.stringify(now) !== JSON.stringify(installed)) throw new InstallerError("installation changed during confirmation; nothing removed");
    if (plist && !purge) recordInstallation({ ...ctx, astraHome: installedHome, commanderRemoteDir: installed.commanderRemoteDir }, plistFile, fs.readFileSync(plistFile, "utf8"));
  }
  if (launchd.status().loaded !== st.loaded) throw new InstallerError("agent state changed during confirmation; nothing removed");
  for (const a of actions) {
    const result = await a.run();
    if (a.quiet) continue;
    ui.ok(typeof a.done === "function" ? a.done(result) : a.done ?? a.text.replace(/^(stop|remove|DELETE)/, (w) => ({ stop: "stopped", remove: "removed", DELETE: "deleted" })[w]));
  }
}
