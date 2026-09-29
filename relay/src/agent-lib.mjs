// Side-effect-free pieces of the Mac agent, kept separate so they can be tested
// without a relay, private key, or local MCP child process.

import path from "node:path";

export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
export const STABLE_CONNECTION_MS = 30_000;

// MCP SDK error codes (ErrorCode in @modelcontextprotocol/sdk/types.js).
const MCP_CONNECTION_CLOSED = -32000;
const MCP_REQUEST_TIMEOUT = -32001;
const MCP_METHOD_NOT_FOUND = -32601;
const MCP_INVALID_PARAMS = -32602;

/** Relay URL must be plain https on the pinned host; the agent upgrades it to wss. */
export function validateRelayUrl(value, expectedHost) {
  if (!value) throw new Error("ASTRA_RELAY_URL is required");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("ASTRA_RELAY_URL must use https");
  if (url.hostname !== expectedHost) throw new Error("ASTRA_RELAY_URL host is not allowed");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("ASTRA_RELAY_URL must not include credentials, query, or fragment");
  }
  return url;
}

const DEVICE_ID_RE = /^[a-zA-Z0-9._-]{1,96}$/;

/**
 * Resolves the agent's configuration from the environment. The relay URL, its pinned host
 * and the device ID have no defaults, so nothing personal is baked into the code; the rest
 * default to the standard per-user locations.
 *
 *   ASTRA_RELAY_URL            required, https://<worker host>
 *   ASTRA_RELAY_HOST           required, must equal the URL's host (pinning)
 *   ASTRA_DEVICE_ID            required, [a-zA-Z0-9._-]{1,96}, must match the Worker config
 *   ASTRA_AGENT_KEY_FILE       default ~/.astra-bridge/agent-private.pem
 *   ASTRA_NODE                 default: the Node binary running this agent
 *   ASTRA_COMMANDER_ENTRY      default ~/projects/mcp-commander/dist/remote-stdio.js
 *   ASTRA_COMMANDER_REMOTE_DIR default ~/.mcp-commander-remote
 */
export function agentConfig(env, { homedir, execPath }) {
  const expectedHost = env.ASTRA_RELAY_HOST;
  if (!expectedHost) throw new Error("ASTRA_RELAY_HOST is required");
  const relayBase = validateRelayUrl(env.ASTRA_RELAY_URL, expectedHost);
  const deviceId = env.ASTRA_DEVICE_ID;
  if (!deviceId) throw new Error("ASTRA_DEVICE_ID is required");
  if (!DEVICE_ID_RE.test(deviceId)) throw new Error("ASTRA_DEVICE_ID must match [a-zA-Z0-9._-]{1,96}");
  return {
    relayBase,
    expectedHost,
    deviceId,
    keyFile: env.ASTRA_AGENT_KEY_FILE || `${homedir}/.astra-bridge/agent-private.pem`,
    nodePath: env.ASTRA_NODE || execPath,
    commanderEntry: env.ASTRA_COMMANDER_ENTRY || `${homedir}/projects/mcp-commander/dist/remote-stdio.js`,
    commanderRemoteDir: env.ASTRA_COMMANDER_REMOTE_DIR || `${homedir}/.mcp-commander-remote`,
  };
}

/** Extra absolute paths mcp-commander refuses as roots (be, contain, or be inside), ":"-separated. */
export const PROTECTED_PATHS_ENV = "MCP_COMMANDER_PROTECTED_PATHS";

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function splitProtected(value) {
  if (typeof value !== "string") return [];
  const entries = value.split(":").filter((entry) => entry.trim() !== "");
  for (const entry of entries) {
    // A stray space would silently protect a different (non-existent) path.
    if (entry !== entry.trim()) throw new Error(`${PROTECTED_PATHS_ENV} entry ${JSON.stringify(entry)} has surrounding spaces`);
  }
  return entries.map((entry) => (path.isAbsolute(entry) ? path.resolve(entry) : entry));
}

function ownProtected(entry, what) {
  if (typeof entry !== "string" || !path.isAbsolute(entry) || entry !== entry.trim()) {
    throw new Error(`${what} must be an absolute path without surrounding spaces`);
  }
  // ":" separates the list, so such a path would silently turn into two wrong entries.
  if (entry.includes(":")) throw new Error(`${what} must not contain ":"`);
  return path.resolve(entry);
}

/**
 * Environment for the mcp-commander child. `baseEnv` is the MCP SDK default environment
 * (getDefaultEnvironment()): an explicit env is what the child gets, so the defaults are always
 * carried over here rather than relying on the transport to add them. On top,
 * MCP_COMMANDER_PROTECTED_PATHS lists the agent's own code directory, the directory of every key
 * file outside ~/.astra-bridge (which mcp-commander protects by default), and every entry already
 * set for the agent (`existing`) or in `baseEnv`, deduplicated, so a configured root can never
 * expose the agent's code or keys.
 */
export function commanderEnv(baseEnv, agentCodeDir, { existing, keyFiles = [], homedir } = {}) {
  const defaultKeyDir = homedir ? path.resolve(homedir, ".astra-bridge") : null;
  const entries = [ownProtected(agentCodeDir, "agent code directory")];
  for (const keyFile of keyFiles) {
    if (!keyFile) continue;
    const keyDir = path.dirname(path.resolve(keyFile));
    if (defaultKeyDir && isWithin(defaultKeyDir, keyDir)) continue;
    entries.push(ownProtected(keyDir, "key file directory"));
  }
  entries.push(...splitProtected(existing), ...splitProtected(baseEnv?.[PROTECTED_PATHS_ENV]));
  return { ...baseEnv, [PROTECTED_PATHS_ENV]: [...new Set(entries)].join(":") };
}

export function connectUrl(relayBase, deviceId) {
  const url = new URL(relayBase);
  url.protocol = "wss:";
  url.pathname = `/v1/device/${encodeURIComponent(deviceId)}/connect`;
  url.search = "";
  return url;
}

/** Backoff only resets after a connection stayed open long enough to count as stable. */
export function nextBackoff(previousMs, uptimeMs) {
  if (uptimeMs >= STABLE_CONNECTION_MS) return BASE_BACKOFF_MS;
  return Math.min(Math.max(previousMs, BASE_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
}

/** ±20% jitter so a relay outage does not produce synchronized reconnect bursts. */
export function withJitter(ms, random = Math.random()) {
  return Math.round(ms * (0.8 + 0.4 * random));
}

export function encodeFrame(value, maxBytes) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error("result_too_large");
  return encoded;
}

/** Errors that mean the stdio transport or child process is gone, not a tool failure. */
export function isTransportDeath(err) {
  if (!err || typeof err !== "object") return false;
  if (err.code === MCP_CONNECTION_CLOSED) return true;
  if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return true;
  return err.message === "Not connected";
}

/** Maps any failure to a fixed code so paths, stack traces, or tool output never leak. */
export function classifyError(err) {
  if (err && typeof err === "object") {
    if (err.message === "result_too_large") return "result_too_large";
    if (err.message === "mcp_unavailable") return "mcp_unavailable";
    if (err.message === "unsupported_action") return "unsupported_action";
    if (err.message === "tool_name_required") return "tool_name_required";
    if (isTransportDeath(err)) return "mcp_unavailable";
    if (err.code === MCP_REQUEST_TIMEOUT) return "tool_timeout";
    if (err.code === MCP_INVALID_PARAMS) return "invalid_arguments";
    if (err.code === MCP_METHOD_NOT_FOUND) return "tool_not_found";
  }
  return "tool_error";
}

/** Process-wide cap on concurrent tool calls, shared across reconnects. */
export class ConcurrencyGate {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
  }
  tryAcquire() {
    if (this.active >= this.limit) return false;
    this.active += 1;
    return true;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
  }
}

/**
 * Detects a silently dead relay connection. It only arms after the first liveness
 * acknowledgement from the relay (the agent passes `ack: true` for a pong), so an
 * agent running against an older relay that never answers is not disconnected in
 * a loop.
 */
export class LivenessMonitor {
  constructor(timeoutMs, now = Date.now()) {
    this.timeoutMs = timeoutMs;
    this.lastInbound = now;
    this.armed = false;
  }
  inbound(now, { ack = false } = {}) {
    this.lastInbound = now;
    if (ack) this.armed = true;
  }
  expired(now) {
    return this.armed && now - this.lastInbound > this.timeoutMs;
  }
}

/**
 * Owns the local MCP client. `connect(onClosed)` must resolve to a connected client
 * and call `onClosed(client)` when its transport closes. A dead client is dropped
 * and recreated on next use; a client that fails repeated pings is closed so its
 * child process is replaced.
 */
export class McpSupervisor {
  constructor(connect, { maxProbeFailures = 2 } = {}) {
    this.connect = connect;
    this.client = null;
    this.connecting = null;
    this.probeFailures = 0;
    this.maxProbeFailures = maxProbeFailures;
  }

  async get() {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.connect((closed) => {
        if (this.client === closed) this.client = null;
      }).then((client) => {
        this.client = client;
        this.probeFailures = 0;
        return client;
      }).finally(() => {
        this.connecting = null;
      });
    }
    try {
      return await this.connecting;
    } catch {
      throw new Error("mcp_unavailable");
    }
  }

  async invalidate(client) {
    if (!client) return;
    if (this.client === client) this.client = null;
    try { await client.close(); } catch {}
  }

  async run(fn) {
    const client = await this.get();
    try {
      return await fn(client);
    } catch (err) {
      if (isTransportDeath(err)) await this.invalidate(client);
      throw err;
    }
  }

  /** Round-trips an MCP ping; returns whether the local server is responsive. */
  async probe(timeoutMs) {
    let client;
    try {
      client = await this.get();
      await client.ping({ timeout: timeoutMs });
      this.probeFailures = 0;
      return true;
    } catch (err) {
      if (client) {
        this.probeFailures += 1;
        if (isTransportDeath(err) || this.probeFailures >= this.maxProbeFailures) {
          this.probeFailures = 0;
          await this.invalidate(client);
        }
      }
      return false;
    }
  }
}
