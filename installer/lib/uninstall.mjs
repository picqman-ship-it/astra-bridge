// Conservative removal. By default only the agent is stopped and its LaunchAgent removed; keys,
// configs, the workspace and the deployed Worker stay. --purge additionally deletes an explicit
// list of Astra Bridge files (never a whole directory tree, never the workspace).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeLaunchctl } from "./context.mjs";
import { KEY_FILES } from "./keys.mjs";
import { createLaunchd, findOtherAgents } from "./launchd.mjs";
import { Checkpoint, InstallerError, shQuote } from "./util.mjs";
import { readPersonalConfig } from "./wrangler-config.mjs";

function present(file) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  return st && (st.isFile() || st.isSymbolicLink()) ? file : null;
}

export async function uninstall(ctx, { purge = false, dryRun = false } = {}, ui) {
  if (!dryRun) assertSafeLaunchctl(ctx);
  const { readTemplate } = await import(pathToFileURL(ctx.installAgent).href);
  const { label } = readTemplate();
  const plistFile = path.join(ctx.launchAgentsDir, `${label}.plist`);
  const launchd = createLaunchd({ launchctl: ctx.launchctl, uid: ctx.uid, label });
  const personal = readPersonalConfig(ctx.personalConfig);
  const workerName = personal.values?.workerName ?? "astra-bridge-relay";

  const actions = [];
  const st = launchd.status();
  if (st.loaded) {
    actions.push({
      text: `stop the agent (launchctl bootout ${launchd.target})`,
      run: async () => {
        launchd.bootout();
        if (!(await launchd.waitUnloaded())) throw new InstallerError("the agent did not stop within 15 s", { hint: `Try: launchctl bootout ${launchd.target}` });
      },
    });
  }
  const plist = fs.lstatSync(plistFile, { throwIfNoEntry: false });
  if (plist) {
    if (!plist.isFile() || !fs.readFileSync(plistFile, "utf8").includes(`<string>${label}</string>`)) {
      throw new InstallerError(`${plistFile} is not the LaunchAgent this installer writes; leaving it alone`);
    }
    actions.push({ text: `remove ${plistFile}`, run: () => fs.rmSync(plistFile) });
  }

  const purgeFiles = purge
    ? [
        ...Object.values(KEY_FILES).map((f) => path.join(ctx.astraHome, f)),
        path.join(ctx.astraHome, "agent.stdout.log"),
        path.join(ctx.astraHome, "agent.stderr.log"),
        ctx.stateFile,
        ctx.personalConfig,
      ].filter(present)
    : [];
  for (const f of purgeFiles) actions.push({ text: `DELETE ${f}`, run: () => fs.rmSync(f) });
  if (purge) {
    actions.push({
      text: `remove ${ctx.astraHome} if it is then empty`,
      run: () => {
        try {
          fs.rmdirSync(ctx.astraHome);
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
    ui.info(`  keys and logs in ${ctx.astraHome}, ${ctx.personalConfig}  (./install-macos.sh uninstall --purge deletes them)`);
  }
  ui.info(`  mcp-commander config ${ctx.commanderRemoteDir} (other mcp-commander setups may use it): rm -r ${shQuote(ctx.commanderRemoteDir)}`);
  ui.info("  your workspace folder(s) and their files");
  ui.info("  build output: (cd mcp-commander && rm -rf node_modules dist) && (cd relay && rm -rf node_modules .wrangler)");
  ui.info(`  the Worker in Cloudflare: cd relay && npx wrangler delete --name ${workerName}`);
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
  for (const a of actions) {
    await a.run();
    if (!a.quiet) ui.ok(a.text.replace(/^(stop|remove|DELETE)/, (w) => ({ stop: "stopped", remove: "removed", DELETE: "deleted" })[w]));
  }
}
