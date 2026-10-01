// Non-secret installer progress in ~/.astra-bridge/install-state.json (0600): which Worker was
// deployed from this Mac, with which config/code hash, and the chosen Cloudflare account id.
// Applied runtime fingerprints are persisted here too. Missing state forces a restart and
// fresh deployment ownership checks; it never grants replacement permission.

import fs from "node:fs";
import path from "node:path";
import { InstallerError, sha256, writeFileAtomic } from "./util.mjs";
import { inspectKeyDir, inspectKeys } from "./keys.mjs";

export function readState(ctx) {
  try {
    const data = JSON.parse(fs.readFileSync(ctx.stateFile, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function writeState(ctx, patch) {
  const dir = inspectKeyDir(path.dirname(ctx.stateFile));
  if (dir.exists && !dir.ok) throw new InstallerError(dir.problems.join("; "));
  const next = { ...readState(ctx), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(ctx.stateFile), { recursive: true, mode: 0o700 });
  writeFileAtomic(ctx.stateFile, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
}

export function pendingRuntime(ctx, pending = "configuration changed") {
  writeState(ctx, { runtime: { ...readState(ctx).runtime, pending } });
}

// Content hashes include deleted files and native binaries; mtimes alone are not evidence.
export function treeHash(dir, { exclude = [] } = {}) {
  const parts = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (exclude.includes(e.name)) continue;
      const file = path.join(d, e.name);
      if (e.isDirectory()) walk(file);
      else parts.push(path.relative(dir, file), sha256(fs.readFileSync(file)));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return sha256(JSON.stringify(parts));
}

export function runtimeFingerprint(ctx, plist) {
  const keys = inspectKeys(ctx.astraHome);
  if (!keys.dir.ok || !keys.agent.ok || !keys.client.ok) throw new InstallerError("runtime keys changed or are invalid; cannot verify the running agent");
  return sha256(JSON.stringify({
    plist, publicKeys: [keys.agent.publicKeyB64, keys.client.publicKeyB64], config: fs.readFileSync(ctx.remoteConfigFile, "utf8"),
    agent: treeHash(path.join(ctx.relayDir, "src")),
    commander: treeHash(path.join(ctx.commanderDir, "dist")),
    dependencies: [ctx.relayDir, ctx.commanderDir].map((d) => sha256(fs.readFileSync(path.join(d, "package-lock.json")))),
    node: [fs.realpathSync(ctx.execPath), process.version, process.arch, process.platform],
  }));
}

/** Hash of what a deploy uploads: the personal config, the Worker sources and the lockfile. */
export function deployHash(ctx) {
  const parts = [fs.readFileSync(ctx.personalConfig, "utf8"), fs.readFileSync(path.join(ctx.relayDir, "package-lock.json"), "utf8")];
  const src = path.join(ctx.relayDir, "src");
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  };
  walk(src);
  for (const f of files.sort()) parts.push(path.relative(src, f), fs.readFileSync(f, "utf8"));
  return sha256(parts.join("\u0000"));
}
