// Side-effect-free pieces of the review/demo agent: configuration, request signing and
// rpc frame handling. The demo agent never falls back to the personal agent's live
// relay, device, key or ~/.astra-bridge directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, sign } from "node:crypto";
import { classifyError, encodeFrame, validateRelayUrl } from "./agent-lib.mjs";

export const DEMO_HOME_DIRNAME = ".astra-bridge-demo";
const PERSONAL_DIRNAME = ".astra-bridge";
const DEVICE_ID = /^[A-Za-z0-9._-]{1,64}$/;

const within = (root, p) => p === root || p.startsWith(root + path.sep);

/** realpath of the deepest existing ancestor plus the not-yet-existing remainder. */
export function realpathish(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Local paths for the demo agent. Defaults live under ~/.astra-bridge-demo. Nothing
 * may resolve into the personal agent's ~/.astra-bridge directory, the private key and
 * state must stay outside the served workspace, and the workspace cannot be the home
 * directory or one of its ancestors.
 */
export function resolveDemoPaths(env = process.env, { homedir = os.homedir() } = {}) {
  const demoHome = path.join(homedir, DEMO_HOME_DIRNAME);
  const pick = (name, fallback) => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
    return path.resolve(value);
  };
  const workspace = pick("ASTRA_DEMO_WORKSPACE", path.join(demoHome, "workspace"));
  const stateDir = pick("ASTRA_DEMO_STATE_DIR", path.join(demoHome, "state"));
  const keyFile = pick("ASTRA_AGENT_KEY_FILE", path.join(demoHome, "agent-private.pem"));

  const home = realpathish(homedir);
  const personal = [path.join(homedir, PERSONAL_DIRNAME), path.join(home, PERSONAL_DIRNAME)];
  const real = { workspace: realpathish(workspace), stateDir: realpathish(stateDir), keyFile: realpathish(keyFile) };

  for (const [name, value] of Object.entries(real)) {
    if (personal.some((dir) => within(dir, value))) {
      throw new Error(`demo ${name} must not be inside the personal ~/${PERSONAL_DIRNAME} directory`);
    }
  }
  if (within(real.workspace, home) || real.workspace === path.parse(real.workspace).root) {
    throw new Error("demo workspace must not be the filesystem root, the home directory, or one of its ancestors");
  }
  if (within(real.workspace, real.keyFile)) throw new Error("agent key file must not be inside the demo workspace");
  if (within(real.workspace, real.stateDir) || within(real.stateDir, real.workspace)) {
    throw new Error("demo state directory and workspace must not contain each other");
  }
  return { workspace, stateDir, keyFile };
}

/** Relay and device have no defaults: the demo agent must be pointed at a review relay explicitly. */
export function resolveDemoConnection(env = process.env) {
  const url = env.ASTRA_RELAY_URL;
  if (!url) throw new Error("ASTRA_RELAY_URL is required (the demo agent has no default relay)");
  let host = env.ASTRA_RELAY_HOST;
  if (!host) {
    try { host = new URL(url).hostname; } catch { throw new Error("ASTRA_RELAY_URL is not a valid URL"); }
  }
  const relayBase = validateRelayUrl(url, host);
  const deviceId = env.ASTRA_DEVICE_ID;
  if (!deviceId) throw new Error("ASTRA_DEVICE_ID is required (the demo agent has no default device)");
  if (!DEVICE_ID.test(deviceId)) throw new Error("ASTRA_DEVICE_ID has invalid characters");
  return { relayBase, deviceId };
}

/**
 * Refuses to serve a directory the demo did not create: an existing, non-empty
 * workspace is accepted only if the state directory recorded it at first seeding.
 * Returns "seed" when the caller should seed it now, "existing" otherwise.
 */
export function checkWorkspaceOwnership(workspace, stateDir) {
  const marker = path.join(stateDir, "workspace.json");
  let entries = [];
  try {
    entries = fs.readdirSync(workspace);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (entries.length === 0) return "seed";
  let recorded = null;
  try {
    recorded = JSON.parse(fs.readFileSync(marker, "utf8")).workspace;
  } catch {}
  if (recorded && recorded === fs.realpathSync(workspace)) return "existing";
  throw new Error("demo workspace already contains files that the demo agent did not create; refusing to serve it");
}

export function recordWorkspaceOwnership(workspace, stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(stateDir, "workspace.json"),
    JSON.stringify({ workspace: fs.realpathSync(workspace), seededAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
}

/** Same canonical form the relay verifies: timestamp, nonce, METHOD, target, sha256(body). */
export function signedHeaders(privateKey, method, target, body = Buffer.alloc(0), {
  now = Date.now(),
  nonce = randomBytes(16).toString("hex"),
} = {}) {
  const timestamp = String(now);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [timestamp, nonce, method.toUpperCase(), target, bodyHash].join("\n");
  return {
    "X-Astra-Timestamp": timestamp,
    "X-Astra-Nonce": nonce,
    "X-Astra-Signature": sign(null, Buffer.from(canonical), privateKey).toString("base64"),
  };
}

/** Executes one relay rpc payload against the demo runtime. */
export function createDemoExecutor(runtime) {
  return async (payload) => {
    if (payload?.action === "tools/list") return runtime.listTools();
    if (payload?.action === "tools/call") {
      if (typeof payload.name !== "string" || !payload.name) throw new Error("tool_name_required");
      return await runtime.callTool(payload.name, payload.arguments ?? {});
    }
    throw new Error("unsupported_action");
  };
}

/**
 * Turns one inbound text frame into the rpc_result frame to send, or null when the
 * frame is not an rpc request. Errors become fixed codes and oversized results become
 * result_too_large, exactly like the personal agent.
 */
export async function handleRpcMessage(text, execute, gate, maxBytes) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (msg?.type !== "rpc" || typeof msg.id !== "string" || !msg.id) return null;
  if (!gate.tryAcquire()) return { type: "rpc_result", id: msg.id, error: "agent_busy" };
  try {
    const frame = { type: "rpc_result", id: msg.id, result: await execute(msg.payload) };
    encodeFrame(frame, maxBytes);
    return frame;
  } catch (err) {
    return { type: "rpc_result", id: msg.id, error: classifyError(err) };
  } finally {
    gate.release();
  }
}
