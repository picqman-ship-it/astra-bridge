// Inspection of the Astra Bridge key directory. Private keys are read only to derive their
// public half; no function here returns, logs or prints private key material.
// Key generation itself is relay/scripts/keygen.mjs (see install.mjs).

import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mode, octal, shQuote } from "./util.mjs";

export const KEY_FILES = { agent: "agent-private.pem", client: "client-private.pem" };

function ownedByMe(st) {
  return typeof process.getuid !== "function" || st.uid === process.getuid();
}

/** { exists, ok, problems[] } for the key directory itself (must be a real 0700 dir of ours). */
export function inspectKeyDir(dir) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return { exists: false, ok: false, problems: [] };
  const problems = [];
  if (st.isSymbolicLink()) problems.push(`${dir} is a symbolic link; it must be a real directory`);
  else if (!st.isDirectory()) problems.push(`${dir} is not a directory`);
  else {
    if (!ownedByMe(st)) problems.push(`${dir} is owned by another user`);
    if (mode(st) & 0o077) problems.push(`${dir} has mode ${octal(st.mode)}; fix with: chmod 700 ${shQuote(dir)}`);
  }
  return { exists: true, ok: problems.length === 0, problems };
}

/**
 * { exists, ok, publicKeyB64?, problems[] } for one private key file. ok means: a regular file
 * of ours, mode 0600 (no group/other bits), holding an Ed25519 private key.
 */
export function inspectKey(file) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return { exists: false, ok: false, problems: [] };
  const problems = [];
  if (!st.isFile()) {
    problems.push(`${file} is not a regular file${st.isSymbolicLink() ? " (symbolic link)" : ""}`);
    return { exists: true, ok: false, problems };
  }
  if (!ownedByMe(st)) problems.push(`${file} is owned by another user`);
  if (mode(st) & 0o077) {
    problems.push(`${file} has mode ${octal(st.mode)} and may have been readable by others; fix with: chmod 600 ${shQuote(file)} (and consider rotating the keys)`);
  }
  let publicKeyB64;
  try {
    const key = createPrivateKey(fs.readFileSync(file));
    if (key.asymmetricKeyType !== "ed25519") problems.push(`${file} is not an Ed25519 key`);
    else publicKeyB64 = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  } catch {
    problems.push(`${file} is not a readable private key`);
  }
  return { exists: true, ok: problems.length === 0, publicKeyB64, problems };
}

/** "none" | "both" | "partial", looking only at whether the files exist (dangling links count). */
export function keyPresence(dir) {
  const present = Object.values(KEY_FILES).filter((f) => fs.lstatSync(path.join(dir, f), { throwIfNoEntry: false }));
  return present.length === 0 ? "none" : present.length === 2 ? "both" : "partial";
}

export function inspectKeys(dir) {
  return {
    dir: inspectKeyDir(dir),
    agent: inspectKey(path.join(dir, KEY_FILES.agent)),
    client: inspectKey(path.join(dir, KEY_FILES.client)),
  };
}

/** Short, non-secret fingerprint of a public key for display. */
export function fingerprint(publicKeyB64) {
  return publicKeyB64 ? `${publicKeyB64.slice(-12)}` : "none";
}
