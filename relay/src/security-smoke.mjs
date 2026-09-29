// Live negative checks against a deployed relay: device binding, the idempotency gate
// and the signed-RPC body limit. Every request here must be rejected; nothing is written.
//
//   ASTRA_RELAY_URL        required, e.g. https://<your-worker>.<your-subdomain>.workers.dev
//   ASTRA_DEVICE_ID        required, the relay's CLIENT_DEVICE_ID
//   ASTRA_SMOKE_WORKSPACE  required, absolute directory on the Mac (target of the refused write)
//   ASTRA_CLIENT_KEY_FILE  default ~/.astra-bridge/client-private.pem
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";

function requireEnv(name, hint) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required (${hint}).`);
    process.exit(2);
  }
  return value;
}

const base = requireEnv("ASTRA_RELAY_URL", "https://<your-worker>.<your-subdomain>.workers.dev");
const deviceId = requireEnv("ASTRA_DEVICE_ID", "the device id configured in wrangler.jsonc, e.g. my-mac");
const workspace = requireEnv("ASTRA_SMOKE_WORKSPACE", "an absolute directory on the Mac inside mcp-commander's roots");
if (!/^[a-zA-Z0-9._-]{1,96}$/.test(deviceId)) {
  console.error("ASTRA_DEVICE_ID must match [a-zA-Z0-9._-]{1,96}.");
  process.exit(2);
}
if (!path.posix.isAbsolute(workspace)) {
  console.error("ASTRA_SMOKE_WORKSPACE must be an absolute path.");
  process.exit(2);
}
const keyFile = process.env.ASTRA_CLIENT_KEY_FILE
  || path.join(os.homedir(), ".astra-bridge", "client-private.pem");
function readKeyFile(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    console.error(`Cannot read the client private key ${file} (${err.code || err.message}). Set ASTRA_CLIENT_KEY_FILE.`);
    process.exit(2);
  }
}
const privateKey = createPrivateKey(readKeyFile(keyFile));

function signedHeaders(method, pathname, body = Buffer.alloc(0)) {
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = [timestamp, nonce, method.toUpperCase(), pathname, hash].join("\n");
  return {
    "X-Astra-Timestamp": timestamp,
    "X-Astra-Nonce": nonce,
    "X-Astra-Signature": sign(null, Buffer.from(canonical), privateKey).toString("base64"),
  };
}

function pass(name, detail) {
  console.log(`PASS ${name} — ${detail}`);
}

// A syntactically valid device id that is guaranteed to differ from the configured one.
const foreign = `/v1/device/${`not-${deviceId}`.slice(0, 96)}/rpc`;
const foreignBody = Buffer.from(JSON.stringify({ action: "tools/list" }));
let response = await fetch(new URL(foreign, base), {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...signedHeaders("POST", foreign, foreignBody),
  },
  body: foreignBody,
});
if (response.status !== 403) throw new Error(`foreign device expected 403 got ${response.status}`);
pass("device binding", "foreign device rejected 403");

const rpcPath = `/v1/device/${deviceId}/rpc`;
const noIdemBody = Buffer.from(JSON.stringify({
  action: "tools/call",
  name: "write_file",
  arguments: {
    path: path.posix.join(workspace, "should-not-write.txt"),
    content: "no\n",
    mode: "rewrite",
  },
}));
response = await fetch(new URL(rpcPath, base), {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...signedHeaders("POST", rpcPath, noIdemBody),
  },
  body: noIdemBody,
});
if (response.status !== 400) throw new Error(`missing idempotency expected 400 got ${response.status}`);
pass("idempotency gate", "mutating write without key rejected 400");
const oversized = Buffer.alloc(512 * 1024 + 1, 0x61);
const oversizedHeaders = signedHeaders("POST", rpcPath, oversized);
let sent = false;
const stream = new ReadableStream({
  start(controller) {
    const chunk = 64 * 1024;
    for (let offset = 0; offset < oversized.length; offset += chunk) {
      controller.enqueue(oversized.subarray(offset, Math.min(offset + chunk, oversized.length)));
    }
    controller.close();
    sent = true;
  },
});
response = await fetch(new URL(rpcPath, base), {
  method: "POST",
  headers: {
    "Content-Type": "application/octet-stream",
    ...oversizedHeaders,
  },
  body: stream,
  duplex: "half",
});
if (!sent || response.status !== 413) {
  throw new Error(`chunked body expected 413 got ${response.status}`);
}
pass("bounded body", "chunked >512KiB rejected 413");

console.log("SECURITY_SMOKE_OK");
