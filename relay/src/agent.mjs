import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { createAccountControlPolicy } from "./account-control-policy.mjs";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BASE_BACKOFF_MS,
  ConcurrencyGate,
  LivenessMonitor,
  McpSupervisor,
  PROTECTED_PATHS_ENV,
  agentConfig,
  classifyError,
  commanderEnv,
  connectUrl,
  encodeFrame,
  nextBackoff,
  withJitter,
} from "./agent-lib.mjs";

const config = agentConfig(process.env, { homedir: os.homedir(), execPath: process.execPath });
const { relayBase, deviceId, keyFile } = config;
// This repository (the parent of src/), wherever it is cloned; mcp-commander refuses any root
// that is, contains or is inside it, so a remote client can never rewrite the agent.
const AGENT_CODE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const MAX_CONCURRENT = 4;
const MAX_FRAME_BYTES = 1024 * 1024;
// Local MCP health is probed this often. The probe is local and free; the relay only
// hears about it when the result changes or STATE_REFRESH_MS has passed.
const MCP_PROBE_MS = 10_000;
const STATE_REFRESH_MS = 10 * 60_000;
// The relay answers PING with PONG through a runtime auto-response that does not wake its
// Durable Object, so this keepalive costs no billable duration. Must match the relay's
// AGENT_PING / AGENT_PONG byte for byte.
const PING_MS = 30_000;
const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';
const HANDSHAKE_TIMEOUT_MS = 10_000;
// No inbound frame (pong, ack or rpc) for this long means the relay link is dead.
const LIVENESS_TIMEOUT_MS = 75_000;
const MCP_PING_TIMEOUT_MS = 8_000;
// Below the relay's 30 s agent timeout so a slow tool frees its slot once the client gave up.
const TOOL_CALL_TIMEOUT_MS = 28_000;

const privateKey = createPrivateKey(fs.readFileSync(keyFile));
const accountControls = createAccountControlPolicy({
  stateFile: config.accountControlStateFile, commanderRemoteDir: config.commanderRemoteDir,
  deviceId, relayOrigin: relayBase.origin,
  agentPublicKeyB64: createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64"),
});
// Computed once at startup so a bad value stops the agent here with a clear error. The key's
// real path is protected too, in case the configured file is a symlink to another directory.
const COMMANDER_ENV = commanderEnv(getDefaultEnvironment(), AGENT_CODE_DIR, {
  existing: process.env[PROTECTED_PATHS_ENV],
  keyFiles: [keyFile, fs.realpathSync(keyFile), ...(config.accountControlStateFile
    ? [config.accountControlStateFile, ...(fs.existsSync(config.accountControlStateFile)
      ? [fs.realpathSync(config.accountControlStateFile)] : [])] : [])],
  homedir: os.homedir(),
});
let logChecks = 0;
function log(message) {
  process.stderr.write(`[astra-bridge-agent] ${message}\n`);
  logChecks += 1;
  if (logChecks % 100 !== 0) return;
  try {
    const st = fs.fstatSync(2);
    if (st.isFile() && st.size > 1024 * 1024) fs.ftruncateSync(2, 0);
  } catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectMcp(onClosed) {
  const client = new Client({ name: "astra-bridge-agent", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: config.nodePath,
    args: [config.commanderEntry, "--remote-dir", config.commanderRemoteDir],
    env: COMMANDER_ENV,
    stderr: "inherit",
  });
  client.onclose = () => {
    log("local MCP transport closed");
    onClosed(client);
  };
  try {
    await client.connect(transport);
  } catch (err) {
    // Do not leave a half-started child behind; the next heartbeat retries.
    try { await transport.close(); } catch {}
    log(`local MCP connect failed: ${classifyError(err)}`);
    throw err;
  }
  return client;
}

const mcp = new McpSupervisor(connectMcp);
const gate = new ConcurrencyGate(MAX_CONCURRENT);

async function execute(payload) {
  if (payload?.action === "tools/list") {
    const result = await mcp.run((client) => client.listTools(undefined, { timeout: TOOL_CALL_TIMEOUT_MS }));
    return accountControls.filterTools(result);
  }
  if (payload?.action === "tools/call") {
    if (typeof payload.name !== "string" || !payload.name) {
      throw new Error("tool_name_required");
    }
    return await mcp.run((client) => {
      // Check after the child is ready, immediately before dispatch. A pending
      // or incomplete local review must never resume control after a reboot.
      if (!accountControls.allows(payload.name)) throw new Error("account_control_unverified");
      return client.callTool(
        { name: payload.name, arguments: payload.arguments ?? {} },
        undefined,
        { timeout: TOOL_CALL_TIMEOUT_MS },
      );
    });
  }
  throw new Error("unsupported_action");
}

function signedHeaders(method, target, body = Buffer.alloc(0)) {
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [timestamp, nonce, method.toUpperCase(), target, bodyHash].join("\n");
  const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64");
  return {
    "X-Astra-Timestamp": timestamp,
    "X-Astra-Nonce": nonce,
    "X-Astra-Signature": signature,
  };
}

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
      headers: signedHeaders("GET", url.pathname + url.search),
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });

    let openedAt = 0;
    let probeTimer = null;
    let pingTimer = null;
    let probeInFlight = false;
    // Last MCP health reported to the relay and when; null forces a report.
    let reportedHealthy = null;
    let reportedAt = 0;
    const liveness = new LivenessMonitor(LIVENESS_TIMEOUT_MS);
    const handshake = setTimeout(() => {
      log("websocket handshake timeout");
      try { ws.terminate(); } catch {}
    }, HANDSHAKE_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(handshake);
      if (probeTimer) clearInterval(probeTimer);
      if (pingTimer) clearInterval(pingTimer);
    };

    const ping = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(PING);
    };

    // Probes local MCP every MCP_PROBE_MS (this also drives McpSupervisor restarts) and
    // reports to the relay only on a change or every STATE_REFRESH_MS, since each report
    // wakes the relay's Durable Object.
    const probe = async () => {
      if (liveness.expired(Date.now())) {
        log("relay liveness timeout");
        try { ws.terminate(); } catch {}
        return;
      }
      if (probeInFlight) return;
      probeInFlight = true;
      try {
        const healthy = await mcp.probe(MCP_PING_TIMEOUT_MS);
        const now = Date.now();
        if (healthy !== reportedHealthy || now - reportedAt >= STATE_REFRESH_MS) {
          if (sendFrame(ws, { type: "heartbeat", mcpHealthy: healthy, at: now })) {
            reportedHealthy = healthy;
            reportedAt = now;
          }
        }
      } catch (err) {
        log(`health probe failed: ${classifyError(err)}`);
      } finally {
        probeInFlight = false;
      }
    };

    ws.on("open", () => {
      clearTimeout(handshake);
      openedAt = Date.now();
      liveness.inbound(openedAt);
      log("connected");
      ping();
      void probe();
      probeTimer = setInterval(() => void probe(), MCP_PROBE_MS);
      pingTimer = setInterval(ping, PING_MS);
    });

    ws.on("message", async (buffer, isBinary) => {
      liveness.inbound(Date.now());
      if (isBinary) return;
      const text = buffer.toString("utf8");
      if (text === PONG) {
        // Only a pong arms liveness: a relay without the auto-response never sends one,
        // so this agent is not disconnected in a loop against an older relay.
        liveness.inbound(Date.now(), { ack: true });
        return;
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg?.type === "heartbeat_ack") return;
      if (msg?.type !== "rpc" || typeof msg.id !== "string" || !msg.id) return;

      if (!gate.tryAcquire()) {
        try { sendFrame(ws, { type: "rpc_result", id: msg.id, error: "agent_busy" }); } catch {}
        return;
      }
      try {
        const result = await execute(msg.payload);
        sendFrame(ws, { type: "rpc_result", id: msg.id, result });
      } catch (err) {
        const code = classifyError(err);
        if (code === "tool_error" || code === "mcp_unavailable") log(`rpc failed: ${code}`);
        try {
          sendFrame(ws, { type: "rpc_result", id: msg.id, error: code });
        } catch {
          try { ws.close(1011, "result send failed"); } catch {}
        }
      } finally {
        gate.release();
      }
    });

    ws.on("close", (code, reason) => {
      cleanup();
      const uptime = openedAt ? Date.now() - openedAt : 0;
      log(`disconnected code=${code} uptimeMs=${uptime} reason=${reason.toString().slice(0, 120)}`);
      resolve(uptime);
    });
    ws.on("error", (err) => {
      log(`websocket error=${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
      try { ws.terminate(); } catch {}
    });

    ws.on("unexpected-response", (_request, response) => {
      log(`websocket rejected status=${response.statusCode ?? "unknown"}`);
      try { ws.terminate(); } catch {}
    });
  });
}

await mcp.get();

let delay = BASE_BACKOFF_MS;
for (;;) {
  let uptime = 0;
  try {
    uptime = await runSocket();
  } catch (err) {
    log(`loop error=${classifyError(err)}`);
  }
  delay = nextBackoff(delay, uptime);
  await sleep(withJitter(delay));
}
