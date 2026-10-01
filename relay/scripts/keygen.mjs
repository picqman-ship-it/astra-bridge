#!/usr/bin/env node
// Generates the two Ed25519 key pairs Astra Bridge uses:
//
//   agent-private.pem   the Mac agent signs its WebSocket connect request with it
//   client-private.pem  signed status/RPC clients (the smoke test) sign requests with it
//
// Private keys are PKCS#8 PEM files that never leave this Mac. The public keys are
// printed as base64 SPKI DER ("MCowBQYDK2VwAyEA..."), which is exactly what the Worker
// imports in src/index.ts (crypto.subtle.importKey("spki", atob(value), "Ed25519")).
// Paste them into relay/wrangler.personal.jsonc (your gitignored copy of the wrangler.jsonc
// template) as AGENT_PUBLIC_KEY_B64 and CLIENT_PUBLIC_KEY_B64; ./install-macos.sh does it for you.
//
// Usage:
//   node relay/scripts/keygen.mjs [--dir <path>]      generate both pairs
//   node relay/scripts/keygen.mjs --print-public      re-print the public keys of existing keys
//
// The directory is --dir, else $ASTRA_HOME, else ~/.astra-bridge. It is created 0700,
// the key files 0600. Existing keys are never overwritten.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const KEYS = [
  { name: "agent", file: "agent-private.pem", wranglerVar: "AGENT_PUBLIC_KEY_B64" },
  { name: "client", file: "client-private.pem", wranglerVar: "CLIENT_PUBLIC_KEY_B64" },
];

const USAGE = `Usage: node relay/scripts/keygen.mjs [--dir <path>] [--print-public]

  --dir <path>     where to write the keys (default: $ASTRA_HOME or ~/.astra-bridge)
  --print-public   do not generate anything; print the public keys of the existing
                   private keys in that directory (for wrangler.personal.jsonc)
  --help           show this help
`;

function fail(message, code = 1) {
  process.stderr.write(`keygen: ${message}\n`);
  process.exit(code);
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseArgs(argv) {
  const opts = { dir: null, printPublic: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === "--dir") {
      const v = argv[++i];
      if (!v) fail(`--dir needs a value\n\n${USAGE}`, 2);
      opts.dir = v;
    } else if (a.startsWith("--dir=")) {
      opts.dir = a.slice("--dir=".length);
      if (!opts.dir) fail(`--dir needs a value\n\n${USAGE}`, 2);
    } else if (a === "--print-public") {
      opts.printPublic = true;
    } else {
      fail(`unknown argument: ${a}\n\n${USAGE}`, 2);
    }
  }
  const raw = opts.dir ?? process.env.ASTRA_HOME ?? path.join(os.homedir(), ".astra-bridge");
  opts.dir = path.resolve(expandHome(raw));
  return opts;
}

/** The exact form the Worker's AGENT_PUBLIC_KEY_B64 / CLIENT_PUBLIC_KEY_B64 expect. */
function publicKeyB64(keyObject) {
  const pub = keyObject.type === "private" ? createPublicKey(keyObject) : keyObject;
  return pub.export({ type: "spki", format: "der" }).toString("base64");
}

/** Signs and verifies a throwaway message the same way the agent and the Worker do. */
function selfCheck(privateKey, pubB64) {
  const message = Buffer.from(`astra-bridge keygen self-check ${Date.now()}`);
  const signature = sign(null, message, privateKey);
  const pub = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
  if (pub.asymmetricKeyType !== "ed25519" || !verify(null, message, pub, signature)) {
    throw new Error("generated key failed its sign/verify self-check");
  }
}

/** Creates the directory 0700, or checks and tightens an existing one. */
function ensurePrivateDir(dir) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return "created (0700)";
  }
  if (st.isSymbolicLink()) fail(`${dir} is a symbolic link; use a real directory.`);
  if (!st.isDirectory()) fail(`${dir} exists and is not a directory.`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    fail(`${dir} is owned by another user.`);
  }
  if (st.mode & 0o077) {
    fs.chmodSync(dir, 0o700);
    return `exists; permissions tightened from ${(st.mode & 0o777).toString(8)} to 700`;
  }
  return "exists (0700)";
}

function printPublic(dir) {
  const lines = [];
  for (const k of KEYS) {
    const file = path.join(dir, k.file);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) fail(`${file} does not exist. Run keygen without --print-public first.`);
    if (!st.isFile()) fail(`${file} is not a regular file.`);
    let key;
    try {
      key = createPrivateKey(fs.readFileSync(file));
    } catch {
      fail(`${file} is not a readable private key.`);
    }
    if (key.asymmetricKeyType !== "ed25519") fail(`${file} is not an Ed25519 key.`);
    if (st.mode & 0o077) {
      process.stderr.write(`keygen: warning: ${file} is readable by others; run: chmod 600 "${file}"\n`);
    }
    lines.push(`"${k.wranglerVar}": "${publicKeyB64(key)}",`);
  }
  process.stdout.write(`Public keys for relay/wrangler.personal.jsonc ("vars"):\n\n  ${lines.join("\n  ")}\n`);
}

function generate(dir) {
  process.umask(0o077);

  // Refuse before touching anything if either key already exists (a dangling symlink counts).
  const existing = KEYS
    .map((k) => path.join(dir, k.file))
    .filter((file) => fs.lstatSync(file, { throwIfNoEntry: false }));
  if (existing.length) {
    fail(
      `refusing to overwrite existing key(s):\n  ${existing.join("\n  ")}\n` +
      "Your relay and agent may still depend on them. To see their public keys run:\n" +
      `  node relay/scripts/keygen.mjs --print-public${dir === path.join(os.homedir(), ".astra-bridge") ? "" : ` --dir "${dir}"`}\n` +
      "To rotate, move the old files somewhere safe first, then run keygen again\n" +
      "and redeploy the Worker with the new public keys.",
    );
  }

  const dirState = ensurePrivateDir(dir);

  const results = [];
  const written = [];
  try {
    for (const k of KEYS) {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const pubB64 = publicKeyB64(publicKey);
      selfCheck(privateKey, pubB64);
      const file = path.join(dir, k.file);
      const pem = privateKey.export({ type: "pkcs8", format: "pem" });
      // "wx" = O_CREAT | O_EXCL: fails instead of replacing a file that appeared meanwhile.
      fs.writeFileSync(file, pem, { mode: 0o600, flag: "wx" });
      written.push(file);
      fs.chmodSync(file, 0o600);
      results.push({ ...k, path: file, pubB64 });
    }
  } catch (err) {
    for (const file of written) {
      try { fs.unlinkSync(file); } catch {}
    }
    fail(`could not write keys: ${err instanceof Error ? err.message : String(err)}`);
  }

  const defaultDir = path.join(os.homedir(), ".astra-bridge");
  const agentKey = results.find((r) => r.name === "agent").path;
  const out = [];
  out.push(`Key directory: ${dir} (${dirState})`);
  for (const r of results) out.push(`  ${r.path} (0600, new ${r.name} private key)`);
  out.push("");
  out.push('Public keys for relay/wrangler.personal.jsonc ("vars"):');
  out.push("");
  for (const r of results) out.push(`  "${r.wranglerVar}": "${r.pubB64}",`);
  out.push("");
  out.push("Next steps:");
  out.push("  1. Paste the two lines above into the \"vars\" block of relay/wrangler.personal.jsonc");
  out.push("     (cp relay/wrangler.jsonc relay/wrangler.personal.jsonc; the copy is gitignored).");
  out.push("     Public keys are not secret; the private .pem files must never leave this Mac");
  out.push("     and must never be committed, copied into a Worker, or pasted into a chat.");
  out.push("  2. In the same file set AGENT_DEVICE_ID, CLIENT_DEVICE_ID and MCP_DEVICE_ID to one");
  out.push("     device name (for example my-mac). Use the same name for install-agent --device-id.");
  out.push("  3. Deploy the Worker (cd relay && npm run deploy), then install the Mac agent:");
  out.push("       node relay/scripts/install-agent.mjs --relay-url https://<your-worker>.<your-subdomain>.workers.dev --device-id my-mac");
  if (dir !== defaultDir) {
    out.push(`     Keys are not in ${defaultDir}, so also pass --agent-key-file "${agentKey}"`);
    out.push(`     (or set ASTRA_HOME="${dir}") when you run install-agent.`);
  }
  out.push("  4. client-private.pem is only needed for the signed smoke test (npm run smoke) and");
  out.push("     other signed /v1/device/* clients. Whoever holds it can drive the agent through");
  out.push("     /v1/device/<device>/rpc, so treat it like an SSH private key.");
  out.push("  Lost the output? Re-print the public keys any time with --print-public.");
  process.stdout.write(`${out.join("\n")}\n`);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.printPublic) printPublic(opts.dir);
else generate(opts.dir);
