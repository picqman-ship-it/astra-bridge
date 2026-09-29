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
  const plist = fs.lstatSync(plistFile, { throwIfNoEntry: false });
  const installed = (plist || purge) ? await installedPaths(ctx, plistFile) : null;
  const installedHome = installed?.astraHome ?? ctx.astraHome;
  if (plist) {
    if (!plist.isFile() || !fs.readFileSync(plistFile, "utf8").includes(`<string>${label}</string>`)) {
      throw new InstallerError(`${plistFile} is not the LaunchAgent this installer writes; leaving it alone`);
    }
    actions.push({ text: `remove ${plistFile}`, run: () => fs.rmSync(plistFile) });
  }

  const purgeFiles = purge
    ? [
        ...Object.values(KEY_FILES).map((f) => path.join(installedHome, f)),
        path.join(installedHome, "agent.stdout.log"),
        path.join(installedHome, "agent.stderr.log"),
        path.join(installedHome, "install-state.json"),
        installed.personalConfig,
        metadataFile(ctx),
      ].filter(present)
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
  ui.info(`  mcp-commander config (other setups may use it): rm -r ${shQuote(installed?.commanderRemoteDir ?? ctx.commanderRemoteDir)}`);
  ui.info("  your workspace folder(s) and their files");
  ui.info("  build output: (cd mcp-commander && rm -rf node_modules dist) && (cd relay && rm -rf node_modules .wrangler)");
  ui.info(`  the Worker in Cloudflare: cd ${shQuote(ctx.relayDir)} && npx wrangler delete -c ${shQuote(ctx.personalConfig)} --name ${shQuote(workerName)}`);
  ui.info("  the Access application: Zero Trust → Access → Applications (disable or delete it to cut access at once)");
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
    ui.danger(["--purge deletes your Astra Bridge private keys. The relay cannot be used from this Mac", "again until you generate new keys and redeploy (./install-macos.sh does both)."]);
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
    await a.run();
    if (!a.quiet) ui.ok(a.text.replace(/^(stop|remove|DELETE)/, (w) => ({ stop: "stopped", remove: "removed", DELETE: "deleted" })[w]));
  }
}
