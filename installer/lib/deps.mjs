// npm dependencies and the mcp-commander build.
//
// `npm ci` installs exactly what package-lock.json pins. To keep re-runs fast it is skipped
// when node_modules was installed by this installer from the same lockfile for the same CPU
// architecture (a stamp file records that); anything else reinstalls.

import fs from "node:fs";
import path from "node:path";
import { run as defaultRun, runInherit, sha256, writeFileAtomic } from "./util.mjs";
import { treeHash } from "./state.mjs";

const STAMP = ".astra-bridge-install.json";
const BUILD_STAMP = ".astra-bridge-build.json";

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

export function buildIdentity({ run = defaultRun, arch = process.arch, platform = process.platform, env = process.env } = {}) {
  const query = (args) => {
    const r = run("/usr/bin/xcrun", args, { env, timeoutMs: 15_000 });
    return r.status === 0 ? r.stdout.trim() : "unavailable";
  };
  return { arch, platform, node: process.version,
    toolchain: platform === "darwin" ? [query(["--find", "swiftc"]), query(["swiftc", "--version"]), query(["--show-sdk-path"]), query(["--show-sdk-version"])] : [],
    developerDir: env.DEVELOPER_DIR ?? "", sdkRoot: env.SDKROOT ?? "", target: env.MACOSX_DEPLOYMENT_TARGET ?? "12.0" };
}

export function buildFingerprint(commanderDir, identity = buildIdentity()) {
  const inputs = ["package.json", "package-lock.json", ...fs.readdirSync(commanderDir).filter((f) => /^tsconfig.*\.json$/.test(f))]
    .sort().map((f) => [f, sha256(fs.readFileSync(path.join(commanderDir, f)))]);
  return sha256(JSON.stringify({ identity, inputs, trees: ["src", "native", "scripts"].map((d) => treeHash(path.join(commanderDir, d))) }));
}

/** null when mcp-commander's dist/ is current, else why it needs `npm run build`. */
export function commanderBuildReason(commanderDir, { needGui = false, identity = buildIdentity() } = {}) {
  const entry = path.join(commanderDir, "dist", "remote-stdio.js");
  if (!fs.existsSync(entry)) return "dist/ is missing";
  if (needGui && !fs.existsSync(axHelperPath(commanderDir))) return "the GUI (Accessibility) helper has not been built";
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(path.join(commanderDir, "dist", BUILD_STAMP), "utf8")); } catch {}
  if (stamp?.fingerprint !== buildFingerprint(commanderDir, identity)) return "build inputs, architecture or toolchain changed (or no build stamp)";
  if (stamp.output !== treeHash(path.join(commanderDir, "dist"), { exclude: [BUILD_STAMP] })) return "build output changed";
  return null;
}

export function axHelperPath(commanderDir) {
  return path.join(commanderDir, "dist", "native", "mcp-commander-ax");
}

export function buildCommander(ctx) {
  const fingerprint = buildFingerprint(ctx.commanderDir);
  if (runInherit(ctx.npm, ["run", "build"], { cwd: ctx.commanderDir, env: ctx.childEnv }) !== 0) return false;
  if (fingerprint !== buildFingerprint(ctx.commanderDir)) return false;
  writeFileAtomic(path.join(ctx.commanderDir, "dist", BUILD_STAMP), JSON.stringify({ fingerprint,
    output: treeHash(path.join(ctx.commanderDir, "dist"), { exclude: [BUILD_STAMP] }) }));
  return true;
}
