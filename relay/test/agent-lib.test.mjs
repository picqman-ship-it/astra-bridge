import assert from "node:assert/strict";
import test from "node:test";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  STABLE_CONNECTION_MS,
  ConcurrencyGate,
  LivenessMonitor,
  McpSupervisor,
  PROTECTED_PATHS_ENV,
  agentConfig,
  classifyError,
  commanderEnv,
  connectUrl,
  encodeFrame,
  isTransportDeath,
  nextBackoff,
  validateRelayUrl,
  withJitter,
} from "../src/agent-lib.mjs";

const HOST = "relay.example.dev";

const CODE_DIR = "/Users/someone/src/astra-bridge-relay";
const HOME = "/Users/someone";
const protectedList = (env) => env[PROTECTED_PATHS_ENV].split(":");

test("mcp-commander child env keeps the MCP SDK defaults and adds the protected paths", () => {
  assert.equal(PROTECTED_PATHS_ENV, "MCP_COMMANDER_PROTECTED_PATHS");
  const defaults = getDefaultEnvironment();
  const env = commanderEnv(defaults, CODE_DIR, { homedir: HOME });
  for (const key of ["PATH", "HOME", "USER", "SHELL", "LOGNAME", "TERM"]) {
    if (process.env[key] !== undefined && !process.env[key].startsWith("()")) {
      assert.equal(env[key], process.env[key], `${key} from getDefaultEnvironment() is passed through`);
    }
  }
  assert.ok(process.env.PATH === undefined || env.PATH, "PATH is present when the agent has one");
  assert.deepEqual(Object.keys(env).sort(), [...Object.keys(defaults), PROTECTED_PATHS_ENV].sort());
  assert.equal(env[PROTECTED_PATHS_ENV], CODE_DIR);

  const base = { PATH: "/usr/bin:/bin", HOME, USER: "someone" };
  const synthetic = commanderEnv(base, CODE_DIR);
  assert.deepEqual(synthetic, { ...base, [PROTECTED_PATHS_ENV]: CODE_DIR });
  assert.equal(base[PROTECTED_PATHS_ENV], undefined, "the base env is not mutated");
});

test("mcp-commander protected paths: agent code dir, key dirs outside ~/.astra-bridge only", () => {
  const base = { PATH: "/usr/bin" };
  // Default key location: implicit, mcp-commander protects ~/.astra-bridge itself.
  assert.deepEqual(
    protectedList(commanderEnv(base, CODE_DIR, { keyFiles: [`${HOME}/.astra-bridge/agent-private.pem`], homedir: HOME })),
    [CODE_DIR],
  );
  // A subdirectory of ~/.astra-bridge is covered as well.
  assert.deepEqual(
    protectedList(commanderEnv(base, CODE_DIR, { keyFiles: [`${HOME}/.astra-bridge/keys/a.pem`], homedir: HOME })),
    [CODE_DIR],
  );
  // Look-alike sibling directories are not "under" ~/.astra-bridge.
  assert.deepEqual(
    protectedList(commanderEnv(base, CODE_DIR, {
      keyFiles: [`${HOME}/.astra-bridge-old/agent.pem`, `${HOME}/.astra-bridgex/agent.pem`],
      homedir: HOME,
    })),
    [CODE_DIR, `${HOME}/.astra-bridge-old`, `${HOME}/.astra-bridgex`],
  );
  // Custom key location, plus its symlink target elsewhere; duplicates collapse.
  assert.deepEqual(
    protectedList(commanderEnv(base, CODE_DIR, {
      keyFiles: ["/Volumes/Keys/astra/agent.pem", `${HOME}/.astra-bridge/agent-private.pem`, "/Volumes/Keys/astra/agent.pem"],
      homedir: HOME,
    })),
    [CODE_DIR, "/Volumes/Keys/astra"],
  );
  // Paths are normalised before comparing and joining.
  assert.equal(commanderEnv(base, `${CODE_DIR}/src/..`)[PROTECTED_PATHS_ENV], CODE_DIR);
  assert.equal(commanderEnv(base, `${CODE_DIR}/`)[PROTECTED_PATHS_ENV], CODE_DIR);
});

test("mcp-commander protected paths preserve existing entries, deduplicated and ':'-separated", () => {
  const env = commanderEnv({ PATH: "/usr/bin" }, CODE_DIR, {
    existing: `/srv/secrets::${CODE_DIR}/:/srv/secrets: :/opt/other`,
    keyFiles: ["/Volumes/Keys/agent.pem"],
    homedir: HOME,
  });
  assert.equal(env[PROTECTED_PATHS_ENV], [CODE_DIR, "/Volumes/Keys", "/srv/secrets", "/opt/other"].join(":"));
  assert.deepEqual(protectedList(env), [CODE_DIR, "/Volumes/Keys", "/srv/secrets", "/opt/other"]);

  // A value already present in the base env is never dropped either.
  const merged = commanderEnv({ [PROTECTED_PATHS_ENV]: "/from/base" }, CODE_DIR, { existing: "/from/agent" });
  assert.deepEqual(protectedList(merged), [CODE_DIR, "/from/agent", "/from/base"]);

  // Unset or empty values add nothing.
  assert.equal(commanderEnv({}, CODE_DIR, { existing: undefined })[PROTECTED_PATHS_ENV], CODE_DIR);
  assert.equal(commanderEnv({}, CODE_DIR, { existing: "" })[PROTECTED_PATHS_ENV], CODE_DIR);
  assert.equal(commanderEnv(undefined, CODE_DIR)[PROTECTED_PATHS_ENV], CODE_DIR);
});

test("a stdio child spawned with commanderEnv() gets the SDK defaults and the protected paths", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", "process.stderr.write(JSON.stringify(process.env))"],
    env: commanderEnv(getDefaultEnvironment(), CODE_DIR, { existing: "/srv/secrets" }),
    stderr: "pipe",
  });
  const chunks = [];
  transport.stderr.on("data", (chunk) => chunks.push(chunk));
  const closed = new Promise((resolve) => { transport.onclose = resolve; });
  await transport.start();
  await closed;
  const childEnv = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(childEnv[PROTECTED_PATHS_ENV], `${CODE_DIR}:/srv/secrets`);
  if (process.env.PATH !== undefined) assert.equal(childEnv.PATH, process.env.PATH);
  if (process.env.HOME !== undefined) assert.equal(childEnv.HOME, process.env.HOME);
});

test("mcp-commander protected paths refuse entries the list cannot represent", () => {
  assert.throws(() => commanderEnv({}, "relative/dir"), /agent code directory must be an absolute path/);
  assert.throws(() => commanderEnv({}, ""), /agent code directory must be an absolute path/);
  assert.throws(() => commanderEnv({}, undefined), /agent code directory must be an absolute path/);
  assert.throws(() => commanderEnv({}, "/Users/a:b/relay"), /must not contain ":"/);
  assert.throws(
    () => commanderEnv({}, CODE_DIR, { keyFiles: ["/Volumes/a:b/agent.pem"], homedir: HOME }),
    /key file directory must not contain ":"/,
  );
});

test("agent requires an https relay URL on the pinned host and upgrades to wss", () => {
  assert.throws(() => validateRelayUrl(undefined, HOST), /required/);
  assert.throws(() => validateRelayUrl(`http://${HOST}`, HOST), /https/);
  assert.throws(() => validateRelayUrl(`ws://${HOST}`, HOST), /https/);
  assert.throws(() => validateRelayUrl(`wss://${HOST}`, HOST), /https/);
  assert.throws(() => validateRelayUrl("https://evil.example", HOST), /host/);
  assert.throws(() => validateRelayUrl(`https://u:p@${HOST}`, HOST), /credentials/);
  assert.throws(() => validateRelayUrl(`https://${HOST}/?x=1`, HOST), /query/);
  assert.throws(() => validateRelayUrl(`https://${HOST}/#f`, HOST), /fragment/);

  const url = connectUrl(validateRelayUrl(`https://${HOST}`, HOST), "test-device");
  assert.equal(url.toString(), `wss://${HOST}/v1/device/test-device/connect`);
});

test("agent config has no personal defaults: relay URL, host and device ID are required", () => {
  const runtime = { homedir: "/Users/someone", execPath: "/opt/node/bin/node" };
  const base = { ASTRA_RELAY_URL: `https://${HOST}`, ASTRA_RELAY_HOST: HOST, ASTRA_DEVICE_ID: "my-mac" };

  assert.throws(() => agentConfig({ ...base, ASTRA_RELAY_HOST: "" }, runtime), /ASTRA_RELAY_HOST is required/);
  assert.throws(() => agentConfig({ ...base, ASTRA_RELAY_URL: undefined }, runtime), /ASTRA_RELAY_URL is required/);
  assert.throws(() => agentConfig({ ...base, ASTRA_DEVICE_ID: undefined }, runtime), /ASTRA_DEVICE_ID is required/);
  assert.throws(() => agentConfig({ ...base, ASTRA_DEVICE_ID: "../other" }, runtime), /must match/);
  assert.throws(() => agentConfig({ ...base, ASTRA_RELAY_HOST: "other.example" }, runtime), /host is not allowed/);

  const cfg = agentConfig(base, runtime);
  assert.equal(cfg.relayBase.hostname, HOST);
  assert.equal(cfg.deviceId, "my-mac");
  assert.equal(cfg.keyFile, "/Users/someone/.astra-bridge/agent-private.pem");
  assert.equal(cfg.nodePath, "/opt/node/bin/node", "defaults to the Node running the agent");
  assert.equal(cfg.commanderEntry, "/Users/someone/projects/mcp-commander/dist/remote-stdio.js");
  assert.equal(cfg.commanderRemoteDir, "/Users/someone/.mcp-commander-remote");

  const custom = agentConfig({
    ...base,
    ASTRA_AGENT_KEY_FILE: "/k.pem",
    ASTRA_NODE: "/n",
    ASTRA_COMMANDER_ENTRY: "/c.js",
    ASTRA_COMMANDER_REMOTE_DIR: "/r",
  }, runtime);
  assert.deepEqual(
    [custom.keyFile, custom.nodePath, custom.commanderEntry, custom.commanderRemoteDir],
    ["/k.pem", "/n", "/c.js", "/r"],
  );
});

test("reconnect backoff grows on unstable connections and resets only after a stable one", () => {
  let delay = BASE_BACKOFF_MS;
  const seen = [];
  for (let i = 0; i < 8; i += 1) {
    delay = nextBackoff(delay, 0);
    seen.push(delay);
  }
  assert.deepEqual(seen, [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
  assert.equal(Math.max(...seen), MAX_BACKOFF_MS);

  // Opened, then dropped before counting as stable: keep backing off.
  assert.equal(nextBackoff(8_000, STABLE_CONNECTION_MS - 1), 16_000);
  assert.equal(nextBackoff(30_000, STABLE_CONNECTION_MS), BASE_BACKOFF_MS);

  assert.equal(withJitter(10_000, 0), 8_000);
  assert.equal(withJitter(10_000, 1), 12_000);
});

test("agent frames are bounded before sending", () => {
  assert.equal(encodeFrame({ a: 1 }, 100), '{"a":1}');
  assert.throws(() => encodeFrame({ a: "x".repeat(200) }, 100), /result_too_large/);
  assert.equal(classifyError(new Error("result_too_large")), "result_too_large");
});

test("agent errors are mapped to fixed codes without leaking detail", () => {
  const leaky = new Error("EACCES: permission denied, open '/Users/someone/.ssh/id_ed25519'");
  assert.equal(classifyError(leaky), "tool_error");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: -32602 })), "invalid_arguments");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: -32601 })), "tool_not_found");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: -32001 })), "tool_timeout");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: -32000 })), "mcp_unavailable");
  assert.equal(classifyError(new Error("Not connected")), "mcp_unavailable");
  assert.equal(classifyError("string failure"), "tool_error");
  assert.equal(isTransportDeath(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), true);
  assert.equal(isTransportDeath(Object.assign(new Error("bad"), { code: -32602 })), false);
});

test("agent tool concurrency is capped process-wide", () => {
  const gate = new ConcurrencyGate(4);
  const acquired = Array.from({ length: 6 }, () => gate.tryAcquire());
  assert.deepEqual(acquired, [true, true, true, true, false, false]);
  gate.release();
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), false);
});

test("liveness only arms after a heartbeat_ack and then detects a silent relay", () => {
  const monitor = new LivenessMonitor(35_000, 0);
  // Older relay that never acks: never force a disconnect loop.
  assert.equal(monitor.expired(1_000_000), false);

  monitor.inbound(1_000, { ack: true });
  assert.equal(monitor.expired(36_000), false);
  assert.equal(monitor.expired(36_001), true);

  monitor.inbound(40_000);
  assert.equal(monitor.expired(70_000), false);
});

function fakeClientFactory() {
  const created = [];
  const connect = async (onClosed) => {
    const client = {
      closed: false,
      pingError: null,
      async ping() {
        if (this.pingError) throw this.pingError;
        return {};
      },
      async close() {
        this.closed = true;
        onClosed(client);
      },
      die() {
        this.closed = true;
        onClosed(client);
      },
    };
    created.push(client);
    return client;
  };
  return { connect, created };
}

test("MCP supervisor recreates the local transport after the child dies", async () => {
  const { connect, created } = fakeClientFactory();
  const supervisor = new McpSupervisor(connect);
  const first = await supervisor.get();
  assert.equal(await supervisor.get(), first);

  first.die();
  const second = await supervisor.get();
  assert.notEqual(second, first);
  assert.equal(created.length, 2);
});

test("MCP supervisor drops the client when a call fails with transport death only", async () => {
  const { connect, created } = fakeClientFactory();
  const supervisor = new McpSupervisor(connect);

  await assert.rejects(
    supervisor.run(async () => { throw Object.assign(new Error("bad args"), { code: -32602 }); }),
    /bad args/,
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].closed, false);

  await assert.rejects(
    supervisor.run(async () => { throw Object.assign(new Error("Connection closed"), { code: -32000 }); }),
    /Connection closed/,
  );
  assert.equal(created[0].closed, true);
  await supervisor.get();
  assert.equal(created.length, 2);
});

test("MCP supervisor reports unhealthy on failed pings and recycles a hung child", async () => {
  const { connect, created } = fakeClientFactory();
  const supervisor = new McpSupervisor(connect, { maxProbeFailures: 2 });
  assert.equal(await supervisor.probe(10), true);

  created[0].pingError = Object.assign(new Error("timeout"), { code: -32001 });
  assert.equal(await supervisor.probe(10), false);
  assert.equal(created[0].closed, false, "one slow ping does not kill the child");
  assert.equal(await supervisor.probe(10), false);
  assert.equal(created[0].closed, true, "second consecutive failure recycles it");

  assert.equal(await supervisor.probe(10), true);
  assert.equal(created.length, 2);
});

test("MCP supervisor reports connect failures as mcp_unavailable and retries later", async () => {
  let attempts = 0;
  const supervisor = new McpSupervisor(async () => {
    attempts += 1;
    throw new Error("spawn /usr/local/bin/node ENOENT");
  });
  await assert.rejects(supervisor.get(), /^Error: mcp_unavailable$/);
  assert.equal(await supervisor.probe(10), false);
  assert.equal(attempts, 2);
});

test("mcp-commander protected paths: space-padded entries are refused, not silently kept", () => {
  assert.throws(() => commanderEnv({}, "/opt/astra/relay ", { homedir: "/Users/alice" }), /surrounding spaces/);
  assert.throws(() => commanderEnv({}, "/opt/astra/relay", { existing: "/x/y :/z", homedir: "/Users/alice" }), /surrounding spaces/);
  assert.throws(
    () => commanderEnv({ MCP_COMMANDER_PROTECTED_PATHS: " /a" }, "/opt/astra/relay", { homedir: "/Users/alice" }),
    /surrounding spaces/,
  );
});
