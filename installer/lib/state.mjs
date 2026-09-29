// Non-secret installer progress in ~/.astra-bridge/install-state.json (0600): which Worker was
// deployed from this Mac, with which config/code hash, and the chosen Cloudflare account id.
// Everything else is read from the real files each run, so deleting this file is harmless
// (the next run just deploys again).

import fs from "node:fs";
import path from "node:path";
import { sha256, writeFileAtomic } from "./util.mjs";

export function readState(ctx) {
  try {
    const data = JSON.parse(fs.readFileSync(ctx.stateFile, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function writeState(ctx, patch) {
  const next = { ...readState(ctx), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(ctx.stateFile), { recursive: true, mode: 0o700 });
  writeFileAtomic(ctx.stateFile, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
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
