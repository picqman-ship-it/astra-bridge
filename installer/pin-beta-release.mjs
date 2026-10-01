#!/usr/bin/env node
// Offline, deterministic release step. Public origin only; never reads a signing secret.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRelayUrl } from "./lib/validate.mjs";

export function pinBetaRelease(releaseRoot, relayOrigin) {
  const origin = normalizeRelayUrl(relayOrigin);
  if (origin !== relayOrigin) throw new Error("use the exact canonical HTTPS origin");
  const root = fs.realpathSync(releaseRoot);
  const sourceRoot = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  if (root === sourceRoot || fs.existsSync(path.join(root, ".git"))) throw new Error("pin an extracted release copy, not a checkout");
  const file = path.join(root, "installer/lib/beta-trust.mjs");
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error("invalid release template path");
  const source = fs.readFileSync(file, "utf8");
  const marker = "export const BETA_RELAY_ORIGIN = null;";
  if (source.split(marker).length !== 2) throw new Error("release trust template missing or already pinned");
  fs.writeFileSync(file, source.replace(marker, `export const BETA_RELAY_ORIGIN = ${JSON.stringify(origin)};`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error("arguments");
    pinBetaRelease(process.argv[2], process.argv[3]);
    process.stdout.write("Pinned public beta relay origin in release copy. Rebuild and verify the distribution checksum.\n");
  } catch {
    process.stderr.write("Beta release pin failed. Usage: node installer/pin-beta-release.mjs EXTRACTED_RELEASE_ROOT HTTPS_ORIGIN\n");
    process.exitCode = 1;
  }
}
