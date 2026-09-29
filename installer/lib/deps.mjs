// npm dependencies and the mcp-commander build.
//
// `npm ci` installs exactly what package-lock.json pins. To keep re-runs fast it is skipped
// when node_modules was installed by this installer from the same lockfile for the same CPU
// architecture (a stamp file records that); anything else reinstalls.

import fs from "node:fs";
import path from "node:path";
import { runInherit, sha256 } from "./util.mjs";

const STAMP = ".astra-bridge-install.json";

export function expectedStamp(pkgDir, arch = process.arch) {
  const lock = fs.readFileSync(path.join(pkgDir, "package-lock.json"), "utf8");
  return { lockSha256: sha256(lock), platform: process.platform, arch };
}

/** null when node_modules matches the lockfile, else a short reason to (re)install. */
export function installReason(pkgDir, arch = process.arch) {
  const stampFile = path.join(pkgDir, "node_modules", STAMP);
  if (!fs.existsSync(path.join(pkgDir, "node_modules"))) return "node_modules missing";
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
  } catch {
    return "not installed by this installer yet";
  }
  const want = expectedStamp(pkgDir, arch);
  if (stamp.lockSha256 !== want.lockSha256) return "package-lock.json changed";
  if (stamp.arch !== want.arch || stamp.platform !== want.platform) return `installed for ${stamp.arch}, Node is ${want.arch}`;
  return null;
}

export function npmCi(ctx, pkgDir) {
  const args = ["ci", "--include=dev", "--no-audit", "--no-fund"];
  const status = runInherit(ctx.npm, args, { cwd: pkgDir, env: ctx.childEnv });
  if (status !== 0) return false;
  fs.writeFileSync(path.join(pkgDir, "node_modules", STAMP), `${JSON.stringify(expectedStamp(pkgDir), null, 2)}\n`);
  return true;
}

function newestMtime(dir, ext) {
  let newest = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return newest;
}

/** null when mcp-commander's dist/ is current, else why it needs `npm run build`. */
export function commanderBuildReason(commanderDir, { needGui = false } = {}) {
  const entry = path.join(commanderDir, "dist", "remote-stdio.js");
  if (!fs.existsSync(entry)) return "dist/ is missing";
  const built = fs.statSync(entry).mtimeMs;
  if (newestMtime(path.join(commanderDir, "src"), ".ts") > built + 1000) return "src/ is newer than dist/";
  if (needGui && !fs.existsSync(axHelperPath(commanderDir))) return "the GUI (Accessibility) helper has not been built";
  return null;
}

export function axHelperPath(commanderDir) {
  return path.join(commanderDir, "dist", "native", "mcp-commander-ax");
}

export function buildCommander(ctx) {
  return runInherit(ctx.npm, ["run", "build"], { cwd: ctx.commanderDir, env: ctx.childEnv }) === 0;
}
