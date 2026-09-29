// Live signed-RPC smoke test against a deployed relay and a connected Mac agent.
// It performs harmless but real actions on the Mac: writes and reads a small file inside
// ASTRA_SMOKE_WORKSPACE and, when terminal/jobs are enabled (trustedTerminal), runs one
// short background job there. In file-only mode the job checks are skipped.
//
//   ASTRA_RELAY_URL             required, e.g. https://<your-worker>.<your-subdomain>.workers.dev
//   ASTRA_DEVICE_ID             required, the relay's CLIENT_DEVICE_ID / MCP_DEVICE_ID
//   ASTRA_SMOKE_WORKSPACE       required, absolute directory on the Mac inside mcp-commander's roots
//   ASTRA_CLIENT_KEY_FILE       default ~/.astra-bridge/client-private.pem
//   ASTRA_SMOKE_EXPECTED_TOOLS  optional exact tool count to enforce (15 file-only, 27 with
//                               trustedTerminal, 19/31 with trustedGui); unset = just report it
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
const expectedTools = process.env.ASTRA_SMOKE_EXPECTED_TOOLS
  ? Number(process.env.ASTRA_SMOKE_EXPECTED_TOOLS)
  : null;
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

function headers(method, pathname, body = Buffer.alloc(0)) {
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = [timestamp, nonce, method.toUpperCase(), pathname, hash].join("\n");
  const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64");
  return {
    "X-Astra-Timestamp": timestamp,
    "X-Astra-Nonce": nonce,
    "X-Astra-Signature": signature,
  };
}

async function signedFetch(pathname, init = {}) {
  const body = init.body ? Buffer.from(init.body) : Buffer.alloc(0);
  const method = init.method || "GET";
  return fetch(new URL(pathname, base), {
    ...init,
    method,
    headers: { ...init.headers, ...headers(method, pathname, body) },
  });
}
async function rpc(payload) {
  const pathname = `/v1/device/${encodeURIComponent(deviceId)}/rpc`;
  const body = JSON.stringify(payload);
  const response = await signedFetch(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`rpc ${response.status}: ${JSON.stringify(data)}`);
  return data.result;
}

const checks = [];
function pass(name, detail = "") {
  checks.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? " — " + detail : ""}`);
}

const health = await fetch(new URL("/healthz", base));
if (!health.ok) throw new Error("health failed");
pass("health", `HTTP ${health.status}`);

const unauth = await fetch(new URL(`/v1/device/${deviceId}/status`, base));
if (unauth.status !== 401) throw new Error(`unauth expected 401 got ${unauth.status}`);
pass("unauthorized request rejected");
const statusPath = `/v1/device/${deviceId}/status`;
const status = await signedFetch(statusPath);
const statusData = await status.json();
if (!status.ok || statusData.agentConnected !== true) {
  throw new Error(`agent unavailable: ${JSON.stringify(statusData)}`);
}
pass("agent connected");

const list = await rpc({ action: "tools/list" });
const tools = list?.tools ?? [];
const toolNames = new Set(tools.map((t) => t.name));
if (expectedTools !== null && tools.length !== expectedTools) {
  throw new Error(`expected ${expectedTools} tools, got ${tools.length}`);
}
for (const required of ["get_config", "read_file", "write_file", "list_directory"]) {
  if (!toolNames.has(required)) throw new Error(`tools/list is missing ${required}`);
}
const jobsEnabled = toolNames.has("job_start");
pass("tools/list", `${tools.length} tools${jobsEnabled ? "" : " (file-only mode)"}`);

const configResult = await rpc({
  action: "tools/call",
  name: "get_config",
  arguments: {},
});
const configText = configResult?.content?.map((x) => x.text || "").join("\n") || "";
if (!configText.trim()) throw new Error("get_config returned nothing");
const version = configText.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? "unknown";
pass("get_config", `mcp-commander ${version}`);

const testPath = path.posix.join(workspace, "astra-bridge-e2e.txt");
const marker = `astra-bridge-e2e-${Date.now()}`;
await rpc({
  action: "tools/call",
  name: "write_file",
  arguments: {
    path: testPath,
    content: marker + "\n",
    mode: "rewrite",
    idempotencyKey: `astra-smoke-write-${Date.now()}`,
  },
});
pass("write_file");
const readResult = await rpc({
  action: "tools/call",
  name: "read_file",
  arguments: { path: testPath, offset: 0, length: 20 },
});
const readText = readResult?.content?.map((x) => x.text || "").join("\n") || "";
if (!readText.includes(marker)) throw new Error("read-back marker mismatch");
pass("read_file", "marker verified");

const replayHeaders = headers("GET", statusPath);
const replay1 = await fetch(new URL(statusPath, base), { headers: replayHeaders });
const replay2 = await fetch(new URL(statusPath, base), { headers: replayHeaders });
if (!replay1.ok || replay2.status !== 409) {
  throw new Error(`replay guard failed: ${replay1.status}/${replay2.status}`);
}
pass("replay protection", "second identical signed request rejected");

if (!jobsEnabled) {
  pass("durable jobs", "skipped: terminal/jobs are not enabled (trustedTerminal is off)");
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
  process.exit(0);
}

const jobKey = `astra-smoke-job-${Date.now()}`;
const jobPath = path.posix.join(workspace, "astra-bridge-job-e2e.txt");
const jobArgs = {
  command: `printf 'start\\n' > "${jobPath}"; sleep 2; printf 'end\\n' >> "${jobPath}"`,
  idempotencyKey: jobKey,
  cwd: workspace,
  timeoutSeconds: 15,
  label: "Astra Bridge relay smoke",
};
const started = await rpc({ action: "tools/call", name: "job_start", arguments: jobArgs });
const startedText = started?.content?.map((x) => x.text || "").join("\n") || "";
const startedData = JSON.parse(startedText);
if (!startedData.jobId) throw new Error("job_start returned no jobId");
pass("job_start", startedData.jobId);

let finalJob;
for (let i = 0; i < 20; i++) {
  const statusResult = await rpc({
    action: "tools/call",
    name: "job_status",
    arguments: { jobId: startedData.jobId },
  });
  const statusText = statusResult?.content?.map((x) => x.text || "").join("\n") || "";
  finalJob = JSON.parse(statusText);
  if (["succeeded", "failed", "cancelled", "timed_out", "interrupted", "outcome_unknown"].includes(finalJob.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (finalJob?.state !== "succeeded") throw new Error(`job did not succeed: ${JSON.stringify(finalJob)}`);
pass("job_status", "succeeded");

const jobRead = await rpc({
  action: "tools/call",
  name: "read_file",
  arguments: { path: jobPath, offset: 0, length: 20 },
});
const jobReadText = jobRead?.content?.map((x) => x.text || "").join("\n") || "";
if (!jobReadText.includes("start") || !jobReadText.includes("end")) throw new Error("job output file incomplete");
pass("job output", "start/end verified");

const replayJob = await rpc({ action: "tools/call", name: "job_start", arguments: jobArgs });
const replayJobText = replayJob?.content?.map((x) => x.text || "").join("\n") || "";
const replayJobData = JSON.parse(replayJobText);
if (replayJobData.jobId !== startedData.jobId || replayJobData.deduplicated !== true) {
  throw new Error("job idempotency failed");
}
pass("job idempotency", "same jobId, deduplicated=true");

console.log(JSON.stringify({ ok: true, checks }, null, 2));
