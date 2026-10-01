// Local revocation and durable-job shutdown. Everything here is local (launchd, files, signals),
// so a permission-reducing run finishes it before any dependency download, build, Cloudflare
// login or deploy.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeLaunchctl } from "./context.mjs";
import { createLaunchd } from "./launchd.mjs";
import { installedPaths, metadataFile } from "./install-metadata.mjs";
import { pendingRuntime } from "./state.mjs";
import { InstallerError, shQuote, writeFileAtomic } from "./util.mjs";

/** mcp-commander's offboarding marker (src/remote/offboarding.ts JOBS_DISABLED_FILE). */
export const JOBS_DISABLED_FILE = "jobs-disabled.json";

/** A compiled mcp-commander module. Missing means this checkout was updated but not rebuilt. */
export async function commanderModule(ctx, rel) {
  const file = path.join(ctx.commanderDir, "dist", rel);
  if (!fs.existsSync(file)) {
    throw new InstallerError(`this checkout's mcp-commander build is older than its sources (${file} is missing)`, {
      hint: `Build it (no download is needed when its dependencies are installed): (cd ${shQuote(ctx.commanderDir)} && npm run build), then re-run.`,
    });
  }
  return import(pathToFileURL(file).href);
}

/**
 * The state an earlier offboarding left: null (none), "complete" or "incomplete". Anything that
 * is not a regular file saying complete counts as incomplete. Read-only.
 */
export function offboardingState(remoteDir) {
  const marker = path.join(remoteDir, "durable", JOBS_DISABLED_FILE);
  const st = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (!st) return null;
  try {
    return st.isFile() && JSON.parse(fs.readFileSync(marker, "utf8"))?.complete === true ? "complete" : "incomplete";
  } catch {
    return "incomplete";
  }
}

/**
 * Disables durable-job submissions, cancels queued jobs and stops the recorded worker and job
 * process groups after verifying their identity (mcp-commander's stopDurableJobs). Returns null
 * when there is no durable state. Throws when shutdown is not confirmed; nothing is deleted.
 */
export async function stopJobs(ctx, remoteDir = ctx.commanderRemoteDir) {
  const durable = path.join(remoteDir, "durable");
  if (!fs.lstatSync(durable, { throwIfNoEntry: false })) return null;
  let stopDurableJobs;
  try {
    ({ stopDurableJobs } = await commanderModule(ctx, "remote/offboarding.js"));
  } catch (err) {
    throw new InstallerError(`durable-job shutdown is UNCONFIRMED: recorded jobs were not touched because ${err.message}`, { hint: err.hint });
  }
  try {
    return await stopDurableJobs(remoteDir);
  } catch (err) {
    throw new InstallerError(`durable-job shutdown is UNCONFIRMED: ${err.message}`, {
      hint: `Keys, config and job records were kept; new durable jobs stay disabled. Resolve the item above and re-run the same command (./install-macos.sh doctor shows this state). Never delete ${durable} while a recorded process may still run.`,
    });
  }
}

/**
 * Turns off the terminal/GUI access this run will not keep (--file-only: both; --reconfigure:
 * whatever is not re-requested with --enable-*). Only ever removes access and needs no build, so
 * no later start (a KeepAlive restart, the next login, a resumed run without flags) regains it.
 * Returns a description of the change, or null. A file mcp-commander would refuse to load is left
 * alone: it cannot grant anything, and the workspace step reports it.
 */
export function reduceRemoteConfig(ctx, { fileOnly = false, reconfigure = false, enableTerminal = false, enableGui = false } = {}) {
  const st = fs.lstatSync(ctx.remoteConfigFile, { throwIfNoEntry: false });
  if (!st?.isFile() || st.uid !== process.getuid()) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ctx.remoteConfigFile, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const off = [];
  const next = { ...raw };
  if (raw.trustedTerminal === true && (fileOnly || (reconfigure && !enableTerminal))) {
    next.trustedTerminal = false;
    off.push("terminal");
  }
  if (raw.trustedGui === true && (fileOnly || (reconfigure && !enableGui))) {
    next.trustedGui = false;
    off.push("GUI");
  }
  if (!off.length) return null;
  writeFileAtomic(ctx.remoteConfigFile, `${JSON.stringify(next, null, 2)}\n`, st.mode & 0o777);
  // Only a hint: agent() and doctor compare the applied runtime fingerprint, which the new
  // remote.json already changed.
  try { pendingRuntime(ctx); } catch {}
  return `${off.join(" and ")} tools off`;
}

/**
 * The local half of a permission-reducing run (--file-only, --reconfigure), before anything that
 * may need the network: reduce remote.json, stop the agent and disable it at login (the agent
 * step re-enables it only for a restart it then verifies), and stop tracked durable jobs. Every
 * failure stops the run and says what is and is not confirmed.
 */
export async function revokeLocalRuntime(ctx, ui, opts = {}, { makeLaunchd = createLaunchd } = {}) {
  assertSafeLaunchctl(ctx);
  const { readTemplate } = await import(pathToFileURL(ctx.installAgent).href);
  const { label } = readTemplate();
  const plistFile = path.join(ctx.launchAgentsDir, `${label}.plist`);
  const plistExists = Boolean(fs.lstatSync(plistFile, { throwIfNoEntry: false }));
  const launchd = makeLaunchd({ launchctl: ctx.launchctl, uid: ctx.uid, label });
  const byHand = `Stop it by hand: launchctl bootout ${shQuote(launchd.target)}; launchctl disable ${shQuote(launchd.target)}`;
  // remote.json and durable state are only ever touched for this installation's paths.
  if (plistExists || fs.lstatSync(metadataFile(ctx), { throwIfNoEntry: false })) {
    let installed;
    try {
      installed = await installedPaths(ctx, plistFile);
    } catch (err) {
      throw new InstallerError(err.message, { hint: `Nothing was changed. ${byHand}` });
    }
    if (installed.commanderRemoteDir !== ctx.commanderRemoteDir || installed.astraHome !== ctx.astraHome) {
      throw new InstallerError("installed paths differ from this setup; pass the installation's ASTRA_HOME and ASTRA_COMMANDER_REMOTE_DIR before revoking permissions", { hint: `Nothing was changed. ${byHand}` });
    }
  } else if (fs.lstatSync(path.join(ctx.commanderRemoteDir, "durable"), { throwIfNoEntry: false })) {
    throw new InstallerError("no validated installation paths for durable jobs; refusing to signal another setup's workers");
  }

  const reduced = reduceRemoteConfig(ctx, opts);
  if (reduced) ui.ok(`remote.json: ${reduced}, for every future start of the agent`);
  const already = reduced ? " remote.json was already reduced for every future start." : "";
  const st = launchd.status();
  if (st.loaded === null) throw new InstallerError(`agent shutdown is UNKNOWN: ${st.error}.${already}`, { hint: byHand });
  if (st.loaded && (launchd.bootout().status !== 0 || !(await launchd.waitUnloaded()))) {
    throw new InstallerError(`agent shutdown is UNKNOWN; the running agent may keep its previous permissions.${already}`, { hint: byHand });
  }
  if (st.loaded || plistExists) {
    if (launchd.disable().status !== 0) {
      throw new InstallerError(`the agent is stopped, but disabling it at login failed, so it could start again at the next login.${already}`, {
        hint: `Run: launchctl disable ${shQuote(launchd.target)}`,
      });
    }
    ui.ok("agent stopped and disabled at login; setup re-enables it only for a restart it then verifies");
  }
  const jobs = await stopJobs(ctx, ctx.commanderRemoteDir);
  if (jobs) ui.ok(`durable jobs disabled and verified stopped (${jobs.cancelled} queued cancelled, ${jobs.stopped} process(es) stopped)`);
  ui.ok("local revocation done; none of it depends on Cloudflare");
}
