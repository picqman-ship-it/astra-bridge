// Astra Bridge review/demo agent. Speaks the same signed WebSocket protocol as the
// personal agent (src/agent.mjs) but serves the 31 reviewed tools from an isolated
// in-process sandbox instead of mcp-commander, so it never touches a real Mac. Useful for a
// separate review/demo relay (for example for an app-directory reviewer).
//
//   node src/demo-agent.mjs --init   create the demo key (if missing) and seed the workspace
//   node src/demo-agent.mjs          connect to the review relay (ASTRA_RELAY_URL, ASTRA_DEVICE_ID)

import fs from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import WebSocket from "ws";
import {
  BASE_BACKOFF_MS,
  ConcurrencyGate,
  LivenessMonitor,
  connectUrl,
  encodeFrame,
  nextBackoff,
  withJitter,
} from "./agent-lib.mjs";
import {
  checkWorkspaceOwnership,
  createDemoExecutor,
  handleRpcMessage,
  recordWorkspaceOwnership,
  resolveDemoConnection,
  resolveDemoPaths,
  signedHeaders,
} from "./demo-agent-lib.mjs";
import { DemoRuntime } from "./demo-runtime.mjs";

const MAX_CONCURRENT = 4;
const MAX_FRAME_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const LIVENESS_TIMEOUT_MS = 35_000;

function log(message) {
  process.stderr.write(`[astra-bridge-demo-agent] ${message}\n`);
}

const paths = resolveDemoPaths();

async function prepareRuntime() {
  const ownership = checkWorkspaceOwnership(paths.workspace, paths.stateDir);
  const runtime = await DemoRuntime.create({
    root: paths.workspace,
    stateDir: paths.stateDir,
    seed: ownership === "seed",
    log,
  });
  if (ownership === "seed") recordWorkspaceOwnership(paths.workspace, paths.stateDir);
  return runtime;
}

if (process.argv.includes("--init")) {
  fs.mkdirSync(path.dirname(paths.keyFile), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.keyFile)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(paths.keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    log("created demo agent key");
  }
  const runtime = await prepareRuntime();
  await runtime.close();
  const publicKey = createPublicKey(createPrivateKey(fs.readFileSync(paths.keyFile)));
  process.stdout.write(
    "Demo workspace is ready.\n"
      + "Set this on the REVIEW Worker only (never on the personal Worker):\n"
      + `  AGENT_PUBLIC_KEY_B64=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}\n`,
  );
  process.exit(0);
}

const { relayBase, deviceId } = resolveDemoConnection();
const privateKey = createPrivateKey(fs.readFileSync(paths.keyFile));
const runtime = await prepareRuntime();
const execute = createDemoExecutor(runtime);
const gate = new ConcurrencyGate(MAX_CONCURRENT);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendFrame(ws, value) {
  const encoded = encodeFrame(value, MAX_FRAME_BYTES);
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(encoded);
  return true;
}

async function runSocket() {
  return await new Promise((resolve) => {
    const url = connectUrl(relayBase, deviceId);
    const ws = new WebSocket(url.toString(), {
      headers: signedHeaders(privateKey, "GET", url.pathname + url.search),
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    let openedAt = 0;
    let heartbeat = null;
    const liveness = new LivenessMonitor(LIVENESS_TIMEOUT_MS);

    const beat = () => {
      if (liveness.expired(Date.now())) {
        log("relay liveness timeout");
        try { ws.terminate(); } catch {}
        return;
      }
      // The sandbox runs in-process, so the tool backend is healthy whenever the agent is.
      try { sendFrame(ws, { type: "heartbeat", mcpHealthy: true, at: Date.now() }); } catch {}
    };

    ws.on("open", () => {
      openedAt = Date.now();
      liveness.inbound(openedAt);
      log("connected");
      beat();
      heartbeat = setInterval(beat, HEARTBEAT_MS);
    });

    ws.on("message", async (buffer, isBinary) => {
      liveness.inbound(Date.now());
      if (isBinary) return;
      const text = buffer.toString("utf8");
      if (text.includes('"heartbeat_ack"')) {
        try {
          if (JSON.parse(text)?.type === "heartbeat_ack") {
            liveness.inbound(Date.now(), { ack: true });
            return;
          }
        } catch {}
      }
      const frame = await handleRpcMessage(text, execute, gate, MAX_FRAME_BYTES);
      if (!frame) return;
      try {
        sendFrame(ws, frame);
      } catch {
        try { ws.close(1011, "result send failed"); } catch {}
      }
    });

    ws.on("close", (code) => {
      if (heartbeat) clearInterval(heartbeat);
      const uptime = openedAt ? Date.now() - openedAt : 0;
      log(`disconnected code=${code} uptimeMs=${uptime}`);
      resolve(uptime);
    });
    ws.on("error", () => {
      log("websocket error");
      try { ws.terminate(); } catch {}
    });
    ws.on("unexpected-response", (_request, response) => {
      log(`websocket rejected status=${response.statusCode ?? "unknown"}`);
      try { ws.terminate(); } catch {}
    });
  });
}

let delay = BASE_BACKOFF_MS;
for (;;) {
  let uptime = 0;
  try {
    uptime = await runSocket();
  } catch {
    log("loop error");
  }
  delay = nextBackoff(delay, uptime);
  await sleep(withJitter(delay));
}
