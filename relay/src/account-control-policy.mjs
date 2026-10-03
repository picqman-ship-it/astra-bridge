// Per-RPC local authorization for explicitly marked account-paired LaunchAgents.
// State is read each time: an interrupted transaction stays file-only across an
// automatic restart, and verified completion opens the already restarted child.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const ACCOUNT_FILE_TOOLS = new Set([
  "get_config", "read_file", "read_multiple_files", "write_file", "create_directory",
  "list_directory", "move_file", "get_file_info", "start_search", "get_more_search_results",
  "stop_search", "list_searches", "edit_block",
]);
export const ACCOUNT_TERMINAL_TOOLS = new Set([
  "start_process", "read_process_output", "interact_with_process", "force_terminate",
  "list_sessions", "list_processes", "kill_process", "get_recent_tool_calls", "get_usage_stats",
  "job_start", "job_status", "job_list", "job_logs", "job_cancel",
]);
export const ACCOUNT_GUI_TOOLS = new Set([
  "list_windows", "inspect_ui", "press_element", "set_element_value",
]);

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, min, max) => typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value)
  && [...value].length >= min && [...value].length <= max;
const fingerprint = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function httpsOrigin(value) {
  if (!text(value, 1, 512)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; }
  catch { return false; }
}
function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return record(value) ? value : null;
  } catch { return null; }
}

export function createAccountControlPolicy({
  stateFile, commanderRemoteDir, deviceId, relayOrigin, agentPublicKeyB64,
}) {
  // Personal and invited-beta agents have no account-control marker. Their
  // existing downstream configuration and relay policy remain authoritative.
  if (stateFile === null || stateFile === undefined) {
    return { allows: () => true, filterTools: result => result };
  }
  const agentFingerprint = createHash("sha256")
    .update(Buffer.from(agentPublicKeyB64, "base64")).digest("hex");
  function permissions() {
    const state = readJson(stateFile);
    const pair = state?.accountPairing;
    const reviewed = state?.accountControl;
    const local = readJson(path.join(commanderRemoteDir, "remote.json"));
    if (!record(pair) || pair.registered !== true || pair.deviceId !== deviceId
      || pair.relayUrl !== relayOrigin || pair.agentPublicKeyB64 !== agentPublicKeyB64
      || state.betaEnrollment
      || !record(reviewed) || reviewed.version !== 1 || reviewed.pending !== null
      || reviewed.deviceId !== deviceId || reviewed.relayUrl !== relayOrigin
      || reviewed.agentFingerprint !== agentFingerprint
      || !text(reviewed.accountEmail, 3, 320) || !httpsOrigin(reviewed.identityIssuer)
      || !fingerprint(reviewed.identityFingerprint)
      || typeof reviewed.verifiedAt !== "string" || !Number.isFinite(Date.parse(reviewed.verifiedAt))
      || typeof reviewed.terminalEnabled !== "boolean" || typeof reviewed.guiEnabled !== "boolean"
      || !local || reviewed.terminalEnabled !== (local.trustedTerminal === true)
      || reviewed.guiEnabled !== (local.trustedGui === true)) {
      return { terminalEnabled: false, guiEnabled: false };
    }
    return { terminalEnabled: reviewed.terminalEnabled, guiEnabled: reviewed.guiEnabled };
  }
  function allowed(name, current) {
    if (ACCOUNT_FILE_TOOLS.has(name)) return true;
    if (ACCOUNT_TERMINAL_TOOLS.has(name)) return current.terminalEnabled;
    if (ACCOUNT_GUI_TOOLS.has(name)) return current.guiEnabled;
    return false;
  }
  return {
    allows(name) { return allowed(name, permissions()); },
    filterTools(result) {
      const current = permissions();
      return { ...result, tools: result.tools.filter(tool => allowed(tool.name, current)) };
    },
  };
}
