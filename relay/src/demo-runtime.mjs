// In-process implementation of the 31 reviewed tools for the review/demo agent.
//
// Trust boundary: every path is a virtual path under /demo-workspace, mapped onto one
// real sandbox directory and checked component by component (symlinks resolved with
// realpath) so nothing outside it can be read or written. Processes and jobs are
// simulated from a four-command grammar; no shell, child process, or network request
// is ever started. Results never contain the sandbox's real location.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { CommandRefused, parseDemoCommand, simulatedOutput } from "./demo-commands.mjs";
import {
  DEMO_COMMAND_HELP,
  DEMO_IDEMPOTENT_TOOLS,
  DEMO_ROOT,
  DEMO_TOOL_NAMES,
  DEMO_TOOLS,
  IDEMPOTENCY_KEY_MAX,
  IDEMPOTENCY_KEY_MIN,
  demoToolByName,
} from "./demo-tools.mjs";

export const DEMO_VERSION = "0.1.0-review-demo";

export const LIMITS = Object.freeze({
  resultChars: 64_000,
  readFileBytes: 1024 * 1024,
  fileBytes: 256 * 1024,
  writeChars: 64 * 1024,
  workspaceBytes: 5 * 1024 * 1024,
  workspaceEntries: 500,
  fileReadLineLimit: 1000,
  fileWriteLineLimit: 50,
  lineChars: 20_000,
  listEntries: 1000,
  searchEntries: 5000,
  searchResults: 5000,
  searchTimeoutMs: 10_000,
  searchSessions: 20,
  activeSessions: 10,
  completedSessions: 50,
  sessionOutputChars: 64 * 1024,
  jobs: 200,
  jobMaxConcurrent: 2,
  jobLogBytes: 64 * 1024,
  idempotencyKeys: 2000,
  recordedResultChars: 8 * 1024,
  history: 1000,
});

const JOB_TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted", "outcome_unknown"]);
const SEARCH_RETENTION_MS = 5 * 60 * 1000;
const SEARCH_INITIAL_WAIT_MS = 1500;
const INITIAL_RESULTS = 50;
const FIRST_PID = 41000;

/** An error whose message is safe to return to the caller (virtual paths only). */
export class DemoError extends Error {}

const IDEMPOTENT = new Set(DEMO_IDEMPOTENT_TOOLS);

// ---------------------------------------------------------------------------------------------
// Seed fixture

export const SEED_FILES = Object.freeze({
  "README.txt": [
    "Astra Bridge review workspace",
    "=============================",
    "",
    "This folder is a disposable sandbox served by the Astra Bridge review/demo agent.",
    "It contains only sample data and nothing here belongs to a real person.",
    "",
    "Things to try:",
    "- read project/sample.txt",
    "- search this folder for OAuth",
    "- write review-note.txt and read it back",
    "- run node --version, or start a short background job such as sleep 2",
    "",
  ].join("\n"),
  "project/sample.txt": [
    "Sample project notes",
    "status: draft",
    "The relay authenticates ChatGPT with OAuth 2.1 and PKCE.",
    "Each mutating tool call carries an idempotency key.",
    "TODO: replace this line during the edit_block review test.",
    "",
  ].join("\n"),
});

/** Writes the fixture files that are missing; never overwrites existing content. */
export async function seedWorkspace(root) {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  for (const [rel, content] of Object.entries(SEED_FILES)) {
    const target = path.join(root, ...rel.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await fsp.writeFile(target, content, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

const within = (root, p) => p === root || p.startsWith(root + path.sep);
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function splitTextLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function capText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[… demo output truncated at ${max} characters]`;
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function errno(err) {
  return err && typeof err === "object" ? err.code : undefined;
}

// ---------------------------------------------------------------------------------------------
// Argument validation against the checked-in descriptors (same leniency as production:
// numeric strings, "true"/"false", null/"" meaning omitted, JSON-array strings).

function coerceArgs(tool, raw) {
  const { properties, required } = tool.inputSchema;
  const out = {};
  const problems = [];
  for (const [key, spec] of Object.entries(properties)) {
    let v = raw[key];
    if (v === null || (v === "" && spec.type !== "string")) v = undefined;
    if (v === undefined) {
      if (spec.default !== undefined) out[key] = spec.default;
      else if (required.includes(key)) problems.push(`${key}: Required`);
      continue;
    }
    switch (spec.type) {
      case "string":
        if (typeof v !== "string") { problems.push(`${key}: Expected string`); continue; }
        if (spec.enum && !spec.enum.includes(v)) { problems.push(`${key}: Expected one of ${spec.enum.join(", ")}`); continue; }
        if (spec.maxLength !== undefined && v.length > spec.maxLength) { problems.push(`${key}: At most ${spec.maxLength} characters`); continue; }
        if (spec.minLength !== undefined && v.length < spec.minLength) { problems.push(`${key}: At least ${spec.minLength} characters`); continue; }
        break;
      case "integer":
        if (typeof v === "string" && /^\s*-?\d+\s*$/.test(v)) v = Number(v);
        if (typeof v !== "number" || !Number.isSafeInteger(v)) { problems.push(`${key}: Expected integer`); continue; }
        if (spec.minimum !== undefined && v < spec.minimum) { problems.push(`${key}: Must be >= ${spec.minimum}`); continue; }
        if (spec.maximum !== undefined && v > spec.maximum) { problems.push(`${key}: Must be <= ${spec.maximum}`); continue; }
        break;
      case "boolean":
        if (typeof v === "string") {
          const s = v.trim().toLowerCase();
          if (["true", "1", "yes"].includes(s)) v = true;
          else if (["false", "0", "no"].includes(s)) v = false;
        }
        if (typeof v !== "boolean") { problems.push(`${key}: Expected boolean`); continue; }
        break;
      case "array":
        if (typeof v === "string") {
          const s = v.trim();
          if (s.startsWith("[")) { try { v = JSON.parse(s); } catch {} } else v = [v];
        }
        if (!Array.isArray(v) || !v.every((item) => typeof item === "string")) { problems.push(`${key}: Expected array of strings`); continue; }
        if (spec.minItems !== undefined && v.length < spec.minItems) { problems.push(`${key}: At least ${spec.minItems} items`); continue; }
        if (spec.maxItems !== undefined && v.length > spec.maxItems) { problems.push(`${key}: At most ${spec.maxItems} items`); continue; }
        break;
      default:
        break;
    }
    out[key] = v;
  }
  if (problems.length) throw new DemoError(`Invalid arguments: ${problems.join("; ")}`);
  return out;
}

export function isValidIdempotencyKey(key) {
  return typeof key === "string"
    && key.length >= IDEMPOTENCY_KEY_MIN
    && key.length <= IDEMPOTENCY_KEY_MAX
    && !/[\u0000-\u001f\u007f]/.test(key);
}

// ---------------------------------------------------------------------------------------------
// Sandbox paths

export class Workspace {
  /** `realRoot` must already be a realpath. */
  constructor(realRoot) {
    this.root = realRoot;
  }

  static async open(root) {
    const real = await fsp.realpath(root);
    const st = await fsp.stat(real);
    if (!st.isDirectory()) throw new Error("demo workspace is not a directory");
    return new Workspace(real);
  }

  /** Normalizes a caller path to a virtual path under DEMO_ROOT, or throws. */
  virtualOf(input) {
    if (typeof input !== "string" || !input.trim()) throw new DemoError("Path must be a non-empty string.");
    if (input.length > 1024 || input.includes("\0")) throw new DemoError("Path is not valid.");
    const p = input.trim();
    if (p.startsWith("~") || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.includes("\\")) {
      throw new DemoError(`Access denied: the path is outside the allowed directory ${DEMO_ROOT}.`);
    }
    const v = path.posix.resolve(DEMO_ROOT, p);
    if (v !== DEMO_ROOT && !v.startsWith(`${DEMO_ROOT}/`)) {
      throw new DemoError(`Access denied: the path is outside the allowed directory ${DEMO_ROOT}.`);
    }
    return v;
  }

  toVirtual(real) {
    if (!within(this.root, real)) return null;
    const rel = path.relative(this.root, real).split(path.sep).join("/");
    return rel ? `${DEMO_ROOT}/${rel}` : DEMO_ROOT;
  }

  /**
   * Maps a caller path to a real path inside the sandbox. Every existing component is
   * lstat'ed; a symlink is followed only if its realpath stays inside the sandbox
   * (with `noFollowLast`, a final symlink is described itself). Returns
   * { virtual, real, exists, stat }, where `stat` is an lstat of `real` when it exists.
   */
  async resolve(input, { noFollowLast = false } = {}) {
    const virtual = this.virtualOf(input);
    const segments = virtual.slice(DEMO_ROOT.length).split("/").filter(Boolean);
    let cur = this.root;
    for (let i = 0; i < segments.length; i += 1) {
      const next = path.join(cur, segments[i]);
      let st;
      try {
        st = await fsp.lstat(next);
      } catch (err) {
        const code = errno(err);
        if (code === "ENOENT") return { virtual, real: path.join(next, ...segments.slice(i + 1)), exists: false, stat: null };
        if (code === "ENOTDIR") throw new DemoError(`A parent path component of ${virtual} is not a directory.`);
        throw new DemoError(`Cannot access ${virtual}.`);
      }
      const last = i === segments.length - 1;
      if (st.isSymbolicLink()) {
        if (last && noFollowLast) return { virtual, real: next, exists: true, stat: st };
        let target;
        try {
          target = await fsp.realpath(next);
        } catch {
          throw new DemoError(`Access denied: ${virtual} is a symbolic link whose target cannot be resolved.`);
        }
        if (!within(this.root, target)) {
          throw new DemoError(`Access denied: ${virtual} is a symbolic link that points outside the allowed directory ${DEMO_ROOT}.`);
        }
        cur = target;
        if (last) return { virtual, real: cur, exists: true, stat: await fsp.lstat(cur) };
        continue;
      }
      if (!last && !st.isDirectory()) throw new DemoError(`A parent path component of ${virtual} is not a directory.`);
      cur = next;
      if (last) return { virtual, real: cur, exists: true, stat: st };
    }
    return { virtual, real: this.root, exists: true, stat: await fsp.lstat(this.root) };
  }

  async resolveExisting(input, opts) {
    const r = await this.resolve(input, opts);
    if (!r.exists) throw new DemoError(`No such file or directory: ${r.virtual}`);
    return r;
  }

  /** Total bytes and entries in the sandbox (bounded walk, symlinks not followed). */
  async usage() {
    let bytes = 0;
    let entries = 0;
    const stack = [this.root];
    while (stack.length) {
      const dir = stack.pop();
      let list;
      try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of list) {
        entries += 1;
        const p = path.join(dir, d.name);
        if (d.isDirectory()) stack.push(p);
        else if (d.isFile()) {
          try { bytes += (await fsp.lstat(p)).size; } catch {}
        }
        if (entries > LIMITS.workspaceEntries * 4) return { bytes, entries };
      }
    }
    return { bytes, entries };
  }
}

// ---------------------------------------------------------------------------------------------
// Runtime

export class DemoRuntime {
  /**
   * @param {object} opts
   * @param {Workspace} opts.workspace
   * @param {string|null} [opts.stateDir] durable job/idempotency state; memory only when null
   * @param {string[]} [opts.scrub] extra host paths that must never appear in results
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ workspace, stateDir = null, scrub = [], log = () => {} }) {
    this.ws = workspace;
    this.stateDir = stateDir;
    this.log = log;
    this.startedAt = Date.now();
    const hide = [[workspace.root, DEMO_ROOT]];
    for (const p of scrub) if (typeof p === "string" && p.length > 1) hide.push([p, DEMO_ROOT]);
    if (stateDir) hide.push([stateDir, "<demo-state>"]);
    const home = os.homedir();
    if (home && home.length > 1) hide.push([home, "~"]);
    this.hide = hide.sort((a, b) => b[0].length - a[0].length);

    this.idem = new Map();
    this.history = [];
    this.sessions = new Map();
    this.nextPid = FIRST_PID;
    this.jobs = new Map();
    this.jobTimers = new Map();
    this.searches = new Map();
    this.searchSeq = 0;
    this.closed = false;
    this.loadState();
  }

  static async create({ root, stateDir = null, seed = true, scrub = [], log } = {}) {
    if (seed) await seedWorkspace(root);
    const workspace = await Workspace.open(root);
    if (stateDir) await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    return new DemoRuntime({ workspace, stateDir, scrub: [root, ...scrub], log });
  }

  listTools() {
    return { tools: structuredClone(DEMO_TOOLS) };
  }

  /** Stops timers and workers (tests and shutdown). Unfinished jobs stay recorded as running. */
  async close() {
    this.closed = true;
    for (const s of this.sessions.values()) if (s.timer) clearTimeout(s.timer);
    for (const t of this.jobTimers.values()) clearTimeout(t);
    this.jobTimers.clear();
    await Promise.all([...this.searches.values()].map((s) => s.worker?.terminate()));
  }

  // -------------------------------------------------------------------------------------------
  // Dispatch

  async callTool(name, rawArgs) {
    const tool = typeof name === "string" ? demoToolByName(name) : null;
    if (!tool) throw Object.assign(new Error("tool_not_found"), { code: -32601 });
    const started = Date.now();
    let result;
    try {
      result = await this.dispatch(tool, rawArgs ?? {});
    } catch (err) {
      if (err instanceof DemoError || err instanceof CommandRefused) result = errorResult(err.message);
      else {
        this.log(`internal error in ${name}: ${err instanceof Error ? err.name : "error"}`);
        result = errorResult("The demo agent could not complete this call (internal error). No host data was accessed.");
      }
    }
    result = this.sanitize(result);
    this.record(name, rawArgs, result, Date.now() - started);
    return result;
  }

  async dispatch(tool, rawArgs) {
    if (!isRecord(rawArgs)) throw new DemoError("Invalid arguments: expected an object.");
    const gated = IDEMPOTENT.has(tool.name);
    if (gated && !isValidIdempotencyKey(rawArgs.idempotencyKey)) {
      return errorResult(
        `idempotency_key_required: ${tool.name} requires idempotencyKey, a unique string of `
          + `${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} characters per intended action. Nothing was executed.`,
      );
    }
    const args = coerceArgs(tool, rawArgs);
    if (!gated) return this.run(tool.name, args);

    const { idempotencyKey: key, ...rest } = args;
    const fingerprint = sha256(`${tool.name}\n${canonicalJson(rest)}`);
    const keyHash = sha256(key);
    const rec = this.idem.get(keyHash);
    if (rec) {
      if (rec.tool !== tool.name || rec.fingerprint !== fingerprint) {
        return errorResult(
          `idempotencyKey was already used for a different call (${rec.tool === tool.name ? "same tool, different arguments" : `tool ${rec.tool}`}). `
            + "Nothing was executed. Use a fresh key for a new action.",
        );
      }
      if (rec.state === "pending") {
        return errorResult("A call with this idempotencyKey is still in progress. It was NOT executed again; retry later to get its recorded result.");
      }
      if (rec.state === "unknown") {
        return errorResult("Outcome unknown: a call with this idempotencyKey has no recorded result (the demo agent restarted). It was NOT executed again.");
      }
      if (tool.name === "job_start" && rec.jobId && this.jobs.has(rec.jobId)) {
        return textResult(JSON.stringify({
          ...this.jobView(this.jobs.get(rec.jobId)),
          deduplicated: true,
          worker: "running",
          note: "This idempotencyKey was already used for this request: this is the existing job; nothing new was started.",
        }, null, 2));
      }
      return {
        content: [
          ...structuredClone(rec.result.content),
          { type: "text", text: "[idempotent replay: this idempotencyKey was already used for this exact call; the action was not run again]" },
        ],
        ...(rec.result.isError ? { isError: true } : {}),
      };
    }
    if (this.idem.size >= LIMITS.idempotencyKeys) {
      return errorResult("The demo agent has reached its idempotency key limit; no new mutating calls are accepted until it is reset.");
    }
    const entry = { tool: tool.name, fingerprint, state: "pending", createdAt: Date.now() };
    this.idem.set(keyHash, entry);
    this.saveState();
    let result;
    try {
      result = await this.run(tool.name, rest, { keyHash });
    } catch (err) {
      if (err instanceof DemoError || err instanceof CommandRefused) result = errorResult(err.message);
      else {
        entry.state = "unknown";
        this.saveState();
        throw err;
      }
    }
    result = this.sanitize(result);
    entry.state = "completed";
    entry.result = {
      isError: !!result.isError,
      content: result.content.map((c) => ({ type: "text", text: capText(c.text, LIMITS.recordedResultChars) })),
    };
    if (tool.name === "job_start" && result.jobId) entry.jobId = result.jobId;
    this.saveState();
    return result;
  }

  run(name, a, ctx = {}) {
    switch (name) {
      case "get_config": return this.getConfig();
      case "read_file": return this.readFile(a);
      case "read_multiple_files": return this.readMultipleFiles(a);
      case "write_file": return this.writeFile(a);
      case "create_directory": return this.createDirectory(a);
      case "list_directory": return this.listDirectory(a);
      case "move_file": return this.moveFile(a);
      case "get_file_info": return this.getFileInfo(a);
      case "start_search": return this.startSearch(a);
      case "get_more_search_results": return this.moreSearchResults(a);
      case "stop_search": return this.stopSearch(a);
      case "list_searches": return this.listSearches();
      case "edit_block": return this.editBlock(a);
      case "list_windows": return JSON.stringify({ ok: true, locked: false, applications: [{ app: "Demo App", bundleId: "demo.app", pid: 1001, active: true, windows: [{ index: 1, title: "Demo Window", minimized: false }] }] }, null, 2);
      case "inspect_ui": return JSON.stringify({ ok: true, locked: false, app: a.app, bundleId: "demo.app", pid: 1001, truncated: false, elements: [{ path: "", depth: 0, role: "AXApplication", title: a.app }, { path: "0", depth: 1, role: "AXButton", title: "Demo Button", enabled: true, actions: ["AXPress"] }] }, null, 2);
      case "press_element": return errorResult("Review demo only: host macOS UI control is disabled; no AXPress was performed.");
      case "set_element_value": return errorResult("Review demo only: host macOS UI control is disabled; no AXValue was changed.");
      case "start_process": return this.startProcess(a);
      case "read_process_output": return this.readProcessOutput(a);
      case "interact_with_process": return this.interact(a);
      case "force_terminate": return this.forceTerminate(a);
      case "list_sessions": return this.listSessions();
      case "list_processes": return this.listProcesses(a);
      case "kill_process": return this.killProcess(a);
      case "get_recent_tool_calls": return this.recentCalls(a);
      case "get_usage_stats": return this.usageStats();
      case "job_start": return this.jobStart(a, ctx);
      case "job_status": return this.jobStatus(a);
      case "job_list": return this.jobList(a);
      case "job_logs": return this.jobLogs(a);
      case "job_cancel": return this.jobCancel(a);
      default: throw new DemoError("Unknown tool.");
    }
  }

  /** Bounds every text block and replaces host paths with their virtual names. */
  sanitize(result) {
    const r = typeof result === "string" ? textResult(result) : result;
    const content = (Array.isArray(r.content) ? r.content : []).map((c) => {
      let text = typeof c?.text === "string" ? c.text : "";
      for (const [needle, replacement] of this.hide) text = text.split(needle).join(replacement);
      return { type: "text", text: capText(text, LIMITS.resultChars) };
    });
    const out = { content };
    if (r.isError) out.isError = true;
    if (r.jobId) Object.defineProperty(out, "jobId", { value: r.jobId, enumerable: false });
    return out;
  }

  record(name, rawArgs, result, durationMs) {
    const args = {};
    if (isRecord(rawArgs)) {
      for (const [k, v] of Object.entries(rawArgs).slice(0, 20)) {
        args[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v;
      }
    }
    let argsText = JSON.stringify(args);
    for (const [needle, replacement] of this.hide) argsText = argsText.split(needle).join(replacement);
    const first = result.content[0]?.text ?? "";
    this.history.push({
      timestamp: new Date().toISOString(),
      toolName: name,
      arguments: capText(argsText, 2000),
      outputSummary: first.slice(0, 120),
      isError: !!result.isError,
      durationMs,
    });
    if (this.history.length > LIMITS.history) this.history.splice(0, this.history.length - LIMITS.history);
  }

  // -------------------------------------------------------------------------------------------
  // Durable state (jobs + idempotency records), outside the sandbox

  statePath() {
    return this.stateDir ? path.join(this.stateDir, "demo-state.json") : null;
  }

  loadState() {
    const file = this.statePath();
    if (!file) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (errno(err) !== "ENOENT") this.log("demo state unreadable; starting empty");
      return;
    }
    if (!isRecord(data) || data.v !== 1) return;
    for (const job of Array.isArray(data.jobs) ? data.jobs : []) {
      if (!isRecord(job) || typeof job.id !== "string") continue;
      if (!JOB_TERMINAL.has(job.state)) {
        job.state = "interrupted";
        job.endedAt = job.endedAt ?? Date.now();
        job.reason = "The demo agent restarted while this job was unfinished; it was not re-run.";
      }
      this.jobs.set(job.id, job);
    }
    for (const [hash, rec] of Object.entries(isRecord(data.idempotency) ? data.idempotency : {})) {
      if (!isRecord(rec)) continue;
      if (rec.state === "pending") rec.state = "unknown";
      this.idem.set(hash, rec);
    }
    this.saveState();
  }

  saveState() {
    const file = this.statePath();
    if (!file) return;
    const data = {
      v: 1,
      jobs: [...this.jobs.values()],
      idempotency: Object.fromEntries(this.idem),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // -------------------------------------------------------------------------------------------
  // Config and history

  getConfig() {
    const payload = {
      mode: "review-demo",
      version: DEMO_VERSION,
      roots: [DEMO_ROOT],
      trustedTerminal: false,
      demo: {
        description: "Astra Bridge review/demo agent: an isolated sandbox with sample data. It is not connected to anyone's real computer.",
        commandGrammar: DEMO_COMMAND_HELP,
        commandExecution: "simulated in-process; no shell or real program is run",
        urlFetching: false,
        networkAccess: false,
      },
      idempotency: { required: true, keyLength: `${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX}`, tools: DEMO_IDEMPOTENT_TOOLS },
      fileReadLineLimit: LIMITS.fileReadLineLimit,
      fileWriteLineLimit: LIMITS.fileWriteLineLimit,
      limits: {
        workspaceBytes: LIMITS.workspaceBytes,
        workspaceEntries: LIMITS.workspaceEntries,
        fileBytes: LIMITS.fileBytes,
        maxSleepSeconds: 30,
        jobMaxConcurrent: LIMITS.jobMaxConcurrent,
      },
      tools: DEMO_TOOL_NAMES,
      note: "Process and job tools accept only the demo grammar and are simulated; the roots confine every file and search tool.",
    };
    return `Remote configuration:\n${JSON.stringify(payload, null, 2)}`;
  }

  recentCalls({ maxResults, toolName, since }) {
    let calls = this.history;
    if (toolName) calls = calls.filter((c) => c.toolName === toolName);
    if (since) {
      const at = Date.parse(since);
      if (Number.isNaN(at)) throw new DemoError("since must be an ISO 8601 timestamp.");
      calls = calls.filter((c) => Date.parse(c.timestamp) >= at);
    }
    calls = calls.slice(-(maxResults ?? 50));
    return `Tool Call History (${calls.length} results, ${this.history.length} total in memory)\n\n${JSON.stringify(calls, null, 2)}`;
  }

  usageStats() {
    const total = this.history.length;
    const failed = this.history.filter((c) => c.isError).length;
    const per = new Map();
    for (const c of this.history) per.set(c.toolName, (per.get(c.toolName) ?? 0) + 1);
    const top = [...per].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => `  • ${n}: ${c}`).join("\n") || "  • none";
    const rate = total ? (((total - failed) / total) * 100).toFixed(1) : "0.0";
    return `📊 Usage Summary (this demo session, uptime ${((Date.now() - this.startedAt) / 60000).toFixed(1)} min)\n`
      + `• Total calls: ${total} (${total - failed} successful, ${failed} failed)\n`
      + `• Success rate: ${rate}%\n`
      + `• Unique tools used: ${per.size}\n`
      + `• Most used:\n${top}`;
  }

  // -------------------------------------------------------------------------------------------
  // Files

  async readText(r) {
    const st = await fsp.stat(r.real);
    if (!st.isFile()) throw new DemoError(`Not a regular file: ${r.virtual}`);
    if (st.size > LIMITS.readFileBytes) throw new DemoError(`File too large for the demo (${st.size} bytes; limit ${LIMITS.readFileBytes}).`);
    const buf = await fsp.readFile(r.real);
    if (buf.subarray(0, 8192).includes(0)) return { binary: true, size: buf.length };
    return { binary: false, text: buf.toString("utf8").replace(/^﻿/, "") };
  }

  formatLines(text, offset, length) {
    const lines = splitTextLines(text);
    const total = lines.length;
    const trunc = (l) => (l.length > LIMITS.lineChars ? `${l.slice(0, LIMITS.lineChars)}… [line truncated]` : l);
    if (offset < 0) {
      const chunk = lines.slice(Math.max(0, total + offset));
      return `[Reading last ${chunk.length} lines (total: ${total} lines)]\n\n${chunk.map(trunc).join("\n")}`;
    }
    const chunk = lines.slice(offset, offset + length);
    const remaining = Math.max(0, total - offset - chunk.length);
    const where = offset === 0 ? "start" : `line ${offset}`;
    let out = `[Reading ${chunk.length} lines from ${where} (total: ${total} lines, ${remaining} remaining)]\n\n${chunk.map(trunc).join("\n")}`;
    if (remaining > 0) out += `\n\n[… ${remaining} more lines. Continue with offset ${offset + chunk.length}]`;
    return out;
  }

  async readOne(input, offset, length) {
    const r = await this.ws.resolveExisting(input);
    if (r.stat.isDirectory()) {
      return { kind: "text", text: `${r.virtual} is a directory:\n${(await this.listLines(r.real, 1)).join("\n")}` };
    }
    const f = await this.readText(r);
    if (f.binary) return { kind: "binary", text: `[Binary file ${r.virtual} (${f.size} bytes) is not displayed]` };
    return { kind: "text", text: this.formatLines(f.text, offset, length) };
  }

  async readFile({ path: p, offset, length, isUrl }) {
    if (isUrl === true || /^[a-z][a-z0-9+.-]*:\/\//i.test(p.trim())) {
      return errorResult(
        `Demo policy: URL fetching is disabled in the Astra Bridge review demo. read_file only reads files inside ${DEMO_ROOT}; `
          + "no network request was made.",
      );
    }
    const out = await this.readOne(p, offset, length ?? LIMITS.fileReadLineLimit);
    return out.text;
  }

  async readMultipleFiles({ paths }) {
    const summary = [];
    const blocks = [];
    for (const [i, p] of paths.entries()) {
      // Only sandbox paths are echoed back; anything else is referred to by position.
      let shown;
      try { shown = this.ws.virtualOf(p); } catch { shown = `[path ${i + 1}]`; }
      try {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p.trim())) throw new DemoError("URLs are not supported (demo policy: no network access).");
        const out = await this.readOne(p, 0, LIMITS.fileReadLineLimit);
        summary.push(out.kind === "binary" ? `${shown}: binary` : `${shown}: text/plain (text)`);
        blocks.push({ type: "text", text: `\n--- ${shown} contents: ---\n${out.text}` });
      } catch (err) {
        summary.push(`${shown}: Error - ${err instanceof DemoError ? err.message : "cannot read this file"}`);
      }
    }
    return { content: [{ type: "text", text: summary.join("\n") }, ...blocks] };
  }

  async ensureCapacity({ addBytes = 0, addEntries = 0 }) {
    const u = await this.ws.usage();
    if (addEntries && u.entries + addEntries > LIMITS.workspaceEntries) {
      throw new DemoError(`Demo workspace limit reached (${LIMITS.workspaceEntries} files and directories).`);
    }
    if (addBytes > 0 && u.bytes + addBytes > LIMITS.workspaceBytes) {
      throw new DemoError(`Demo workspace limit reached (${LIMITS.workspaceBytes} bytes).`);
    }
  }

  /** Creates missing directories below an existing, already-verified sandbox directory. */
  async mkdirs(real) {
    if (!within(this.ws.root, real)) throw new DemoError("Access denied.");
    const missing = [];
    let cur = real;
    while (cur !== this.ws.root) {
      try {
        const st = await fsp.lstat(cur);
        if (!st.isDirectory()) throw new DemoError("A parent path component is not a directory.");
        break;
      } catch (err) {
        if (err instanceof DemoError) throw err;
        if (errno(err) !== "ENOENT") throw new DemoError("Cannot create the parent directory.");
        missing.push(cur);
        cur = path.dirname(cur);
      }
    }
    if (missing.length) await this.ensureCapacity({ addEntries: missing.length });
    for (const dir of missing.reverse()) await fsp.mkdir(dir, { mode: 0o700 });
  }

  async writeFile({ path: p, content, mode }) {
    if (content.length > LIMITS.writeChars) {
      throw new DemoError(`Content too large for one demo write (${content.length} characters; limit ${LIMITS.writeChars}). Write in chunks with mode 'append'.`);
    }
    const r = await this.ws.resolve(p);
    if (r.real === this.ws.root) throw new DemoError(`Cannot write to ${r.virtual}: it is a directory`);
    const existing = r.exists ? await fsp.stat(r.real) : null;
    if (existing?.isDirectory()) throw new DemoError(`Cannot write to ${r.virtual}: it is a directory`);
    if (existing && !existing.isFile()) throw new DemoError(`Cannot write to ${r.virtual}: not a regular file`);
    if (mode === undefined && existing && existing.size > 0) {
      throw new DemoError(
        `Write rejected to prevent accidental data loss: ${r.virtual} already exists with content (${existing.size} bytes), `
          + "and no 'mode' was specified. Retry with mode 'append' or 'rewrite'.",
      );
    }
    const append = mode === "append";
    const bytes = Buffer.byteLength(content);
    const finalSize = (append && existing ? existing.size : 0) + bytes;
    if (finalSize > LIMITS.fileBytes) throw new DemoError(`File would exceed the demo file size limit (${LIMITS.fileBytes} bytes).`);
    await this.ensureCapacity({ addBytes: finalSize - (existing?.size ?? 0), addEntries: existing ? 0 : 1 });
    await this.mkdirs(path.dirname(r.real));
    if (append) await fsp.appendFile(r.real, content, { mode: 0o600 });
    else await fsp.writeFile(r.real, content, { mode: 0o600 });
    const lines = splitTextLines(content).length;
    let msg = `Successfully ${append ? "appended to" : "wrote to"} ${r.virtual} (${lines} ${lines === 1 ? "line" : "lines"})`;
    if (lines > LIMITS.fileWriteLineLimit) {
      msg += `\n\n💡 Tip: this write had ${lines} lines (limit ${LIMITS.fileWriteLineLimit}). For large files write in chunks.`;
    }
    return msg;
  }

  async createDirectory({ path: p }) {
    const r = await this.ws.resolve(p);
    if (r.exists) {
      if ((await fsp.stat(r.real)).isDirectory()) return `Directory already exists: ${r.virtual}`;
      throw new DemoError(`Cannot create directory ${r.virtual}: a file with that name already exists`);
    }
    await this.mkdirs(r.real);
    return `Successfully created directory ${r.virtual}`;
  }

  async listLines(realDir, depth) {
    const out = [];
    let count = 0;
    const walk = async (dir, rel, level) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        out.push(`[DENIED] ${rel || "."}`);
        return;
      }
      entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      const cap = level === 1 ? LIMITS.listEntries : 100;
      for (const d of entries.slice(0, cap)) {
        if (count >= LIMITS.listEntries) return;
        count += 1;
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isSymbolicLink()) out.push(`[LINK] ${r}`);
        else if (d.isDirectory()) {
          out.push(`[DIR] ${r}`);
          if (level < depth) await walk(path.join(dir, d.name), r, level + 1);
        } else out.push(`[FILE] ${r}`);
      }
      if (entries.length > cap) out.push(`[WARNING] ${rel || "."}: ${entries.length - cap} more entries not shown`);
    };
    await walk(realDir, "", 1);
    return out;
  }

  async listDirectory({ path: p, depth }) {
    const r = await this.ws.resolveExisting(p);
    if (!(await fsp.stat(r.real)).isDirectory()) throw new DemoError(`Not a directory: ${r.virtual}`);
    const lines = await this.listLines(r.real, Math.min(10, Math.max(1, depth)));
    return lines.length ? lines.join("\n") : `(empty directory: ${r.virtual})`;
  }

  async moveFile({ source, destination }) {
    const src = await this.ws.resolveExisting(source, { noFollowLast: true });
    const dst = await this.ws.resolve(destination, { noFollowLast: true });
    if (src.virtual === DEMO_ROOT) throw new DemoError("Cannot move the demo workspace root.");
    if (dst.virtual === DEMO_ROOT || dst.exists) throw new DemoError(`Destination already exists: ${dst.virtual}`);
    if (src.stat.isDirectory() && within(src.real, dst.real)) {
      throw new DemoError(`Cannot move ${src.virtual} into itself (${dst.virtual})`);
    }
    await this.mkdirs(path.dirname(dst.real));
    await fsp.rename(src.real, dst.real);
    return `Successfully moved ${src.virtual} to ${dst.virtual}`;
  }

  async getFileInfo({ path: p }) {
    const r = await this.ws.resolveExisting(p, { noFollowLast: true });
    const st = r.stat;
    const lines = [
      `path: ${r.virtual}`,
      `size: ${st.size}`,
      `created: ${st.birthtime.toISOString()}`,
      `modified: ${st.mtime.toISOString()}`,
      `accessed: ${st.atime.toISOString()}`,
      `isDirectory: ${st.isDirectory()}`,
      `isFile: ${st.isFile()}`,
      `isSymbolicLink: ${st.isSymbolicLink()}`,
    ];
    if (st.isSymbolicLink()) {
      let target = "(outside the demo workspace or unresolvable)";
      try {
        const real = await fsp.realpath(r.real);
        target = this.ws.toVirtual(real) ?? target;
      } catch {}
      lines.push(`symlinkTarget: ${target}`);
    }
    lines.push(`permissions: ${(st.mode & 0o777).toString(8)}`);
    let fileType = st.isDirectory() ? "directory" : st.isFile() ? "text" : "other";
    if (st.isFile() && st.size <= LIMITS.readFileBytes) {
      const f = await this.readText({ real: r.real, virtual: r.virtual });
      if (f.binary) fileType = "binary";
      else {
        const count = splitTextLines(f.text).length;
        lines.push(`lineCount: ${count}`, `lastLine: ${Math.max(0, count - 1)}`, `appendPosition: ${count}`);
      }
    }
    lines.push(`fileType: ${fileType}`);
    return lines.join("\n");
  }

  async editBlock({ file_path, old_string, new_string, expected_replacements }) {
    if (old_string === "") {
      throw new DemoError("old_string must not be empty: pass the exact text to replace. To create or fully rewrite a file, use write_file.");
    }
    if (old_string === new_string) throw new DemoError("old_string and new_string are identical — nothing to change");
    const r = await this.ws.resolveExisting(file_path);
    const st = await fsp.stat(r.real);
    if (st.isDirectory()) throw new DemoError(`Cannot edit a directory: ${r.virtual}`);
    const f = await this.readText(r);
    if (f.binary) throw new DemoError(`Cannot edit binary file: ${r.virtual}`);
    const content = f.text;
    const eolMatch = content.match(/\r\n|\r|\n/);
    const eol = eolMatch ? eolMatch[0] : "\n";
    const norm = (s) => s.replace(/\r\n|\r|\n/g, eol);
    const needle = norm(old_string);
    const replacement = norm(new_string);
    const positions = [];
    for (let pos = content.indexOf(needle); pos !== -1; pos = content.indexOf(needle, pos + needle.length)) positions.push(pos);
    if (positions.length === 0) {
      throw new DemoError(`No exact match found for old_string in ${r.virtual}. Nothing was changed. (The review demo does not offer fuzzy suggestions; read the file and copy the text exactly.)`);
    }
    const lineOf = (pos) => content.slice(0, pos).split(/\r\n|\r|\n/).length;
    if (positions.length !== expected_replacements) {
      const at = positions.slice(0, 20).map(lineOf).join(", ");
      throw new DemoError(
        `Expected ${expected_replacements} occurrence(s) of old_string in ${r.virtual} but found ${positions.length} (lines ${at}). `
          + "Nothing was changed. Add surrounding text to make it unique, or set expected_replacements.",
      );
    }
    const updated = content.split(needle).join(replacement);
    const size = Buffer.byteLength(updated);
    if (size > LIMITS.fileBytes) throw new DemoError(`File would exceed the demo file size limit (${LIMITS.fileBytes} bytes).`);
    await this.ensureCapacity({ addBytes: size - st.size });
    await fsp.writeFile(r.real, updated);
    const all = splitTextLines(updated);
    const first = lineOf(positions[0]) - 1;
    const from = Math.max(0, first - 10);
    const to = Math.min(all.length, first + splitTextLines(replacement).length + 10);
    return `Successfully applied ${positions.length} edit${positions.length === 1 ? "" : "s"} to ${r.virtual}\n\n`
      + `[Reading ${to - from} lines from ${from === 0 ? "start" : `line ${from}`} (total: ${all.length} lines, ${all.length - to} remaining)]\n\n`
      + all.slice(from, to).join("\n");
  }

  // -------------------------------------------------------------------------------------------
  // Search

  pruneSearches() {
    const now = Date.now();
    for (const [id, s] of this.searches) {
      if (s.status !== "running" && now - s.lastRead > SEARCH_RETENTION_MS) this.searches.delete(id);
    }
  }

  async collectEntries(r, includeHidden) {
    const entries = [];
    const st = await fsp.stat(r.real);
    if (st.isFile()) {
      const name = path.basename(r.real);
      return { entries: [{ real: r.real, virtual: r.virtual, rel: name, name, isDir: false }], truncated: false };
    }
    let truncated = false;
    const walk = async (dir, rel) => {
      let list;
      try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      list.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of list) {
        if (entries.length >= LIMITS.searchEntries) { truncated = true; return; }
        if (!includeHidden && d.name.startsWith(".")) continue;
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory() && (d.name === "node_modules" || d.name === ".git")) continue;
        const real = path.join(dir, d.name);
        const relPath = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          entries.push({ real, virtual: this.ws.toVirtual(real), rel: relPath, name: d.name, isDir: true });
          await walk(real, relPath);
        } else if (d.isFile()) {
          const size = (await fsp.lstat(real)).size;
          if (size <= LIMITS.readFileBytes) entries.push({ real, virtual: this.ws.toVirtual(real), rel: relPath, name: d.name, isDir: false });
        }
      }
    };
    await walk(r.real, "");
    return { entries, truncated };
  }

  async startSearch(a) {
    this.pruneSearches();
    if (this.searches.size >= LIMITS.searchSessions) {
      throw new DemoError("Too many search sessions; stop or wait for existing ones to expire.");
    }
    if (a.pattern.length > 500) throw new DemoError("Pattern too long for the demo (max 500 characters).");
    if (a.searchType === "content" && !a.literalSearch) {
      try { new RegExp(a.pattern); } catch { throw new DemoError("Invalid regular expression in pattern (use literalSearch for exact text)."); }
    }
    const r = await this.ws.resolveExisting(a.path);
    const { entries, truncated } = await this.collectEntries(r, a.includeHidden);
    this.searchSeq += 1;
    const id = `search_${this.searchSeq}_${Date.now()}`;
    const timeoutMs = Math.min(a.timeout_ms && a.timeout_ms > 0 ? a.timeout_ms : LIMITS.searchTimeoutMs, LIMITS.searchTimeoutMs);
    const s = {
      id,
      searchType: a.searchType,
      pattern: a.pattern,
      displayPath: r.virtual,
      status: "running",
      results: [],
      matchCount: 0,
      contextCount: 0,
      startedAt: Date.now(),
      endedAt: null,
      lastRead: Date.now(),
      notes: truncated ? [`Only the first ${LIMITS.searchEntries} entries were searched (demo limit).`] : [],
      limitReached: false,
      timedOut: false,
      earlyTerminated: false,
      maxResults: Math.min(a.maxResults ?? LIMITS.searchResults, LIMITS.searchResults),
      worker: null,
      error: null,
    };
    this.searches.set(id, s);
    s.done = new Promise((resolve) => {
      const worker = new Worker(new URL("./demo-search-worker.mjs", import.meta.url), {
        workerData: {
          entries: entries.map(({ real, virtual, rel, name, isDir }) => ({ real, virtual, rel, name, isDir })),
          searchType: a.searchType,
          pattern: a.pattern,
          filePattern: a.filePattern,
          ignoreCase: a.ignoreCase,
          literalSearch: a.literalSearch,
          contextLines: a.searchType === "content" ? Math.min(a.contextLines, 10) : 0,
          earlyTermination: a.searchType === "files" && a.earlyTermination,
          maxResults: s.maxResults,
        },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      s.worker = worker;
      const finish = (status) => {
        if (s.status !== "running") return;
        clearTimeout(timer);
        s.status = status;
        s.endedAt = Date.now();
        s.worker = null;
        void worker.terminate();
        resolve();
      };
      const timer = setTimeout(() => { s.timedOut = true; finish("stopped"); }, timeoutMs);
      s.stop = () => finish("stopped");
      worker.once("message", (msg) => {
        if (!msg?.ok) {
          s.error = msg?.error === "invalid pattern" ? "invalid pattern" : "search failed";
          finish("error");
          return;
        }
        s.results = msg.results;
        s.matchCount = msg.matchCount ?? 0;
        s.contextCount = msg.contextCount ?? 0;
        s.limitReached = !!msg.limitReached;
        s.earlyTerminated = !!msg.earlyTerminated;
        finish("completed");
      });
      worker.once("error", () => { s.error = "search failed"; finish("error"); });
      worker.once("exit", () => { if (s.status === "running") { s.error = "search failed"; finish("error"); } });
    });
    await Promise.race([s.done, sleep(SEARCH_INITIAL_WAIT_MS)]);
    if (s.status === "error") return errorResult(`Search session ${s.id} encountered an error: ${s.error}`);
    return this.describeStart(s);
  }

  totalText(s) {
    const n = s.results.length;
    return s.contextCount > 0 ? `${n} (${s.matchCount} matches + ${s.contextCount} context lines)` : String(n);
  }

  formatResult(r) {
    const text = (r.text ?? "").trimEnd();
    const snippet = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    switch (r.type) {
      case "file": return `📁 ${r.file}`;
      case "dir": return `📂 ${r.file}/`;
      case "match": return `📄 ${r.file}:${r.line} - ${snippet}`;
      default: return `   ${r.file}:${r.line}   ${snippet}`;
    }
  }

  noteLines(s) {
    const out = s.notes.map((n) => `ℹ️ ${n}`);
    if (s.limitReached) out.push(`⚠️ Result limit reached (maxResults=${s.maxResults}); the search was stopped early.`);
    if (s.timedOut) out.push("⏱️ Search timed out and was stopped; results may be incomplete.");
    else if (s.status === "stopped") out.push("⏹️ Search was stopped before it finished; results may be incomplete.");
    if (s.earlyTerminated) out.push("🎯 Stopped at the first file whose name equals the pattern (earlyTermination).");
    return out;
  }

  runtimeMs(s) {
    return (s.endedAt ?? Date.now()) - s.startedAt;
  }

  describeStart(s) {
    const complete = s.status !== "running";
    let text = `Started ${s.searchType === "content" ? "content search" : "file search"} session: ${s.id}\n`
      + `Pattern: "${s.pattern}"\nPath: ${s.displayPath}\nStatus: ${complete ? "COMPLETED" : "RUNNING"}\n`
      + `Runtime: ${this.runtimeMs(s)}ms\nEngine: demo\nTotal results: ${this.totalText(s)}\n\n`;
    if (s.results.length) {
      text += `Initial results:\n${s.results.slice(0, INITIAL_RESULTS).map((r) => this.formatResult(r)).join("\n")}\n`;
      if (s.results.length > INITIAL_RESULTS) {
        text += `... and ${s.results.length - INITIAL_RESULTS} more results. Use get_more_search_results with sessionId ${s.id} and offset ${INITIAL_RESULTS}\n`;
      }
    } else if (complete) text += "No matches found.\n";
    const footer = this.noteLines(s);
    footer.push(complete ? "✅ Search completed." : "🔄 Search in progress. Use get_more_search_results to get more results.");
    return `${text}\n${footer.join("\n")}`;
  }

  getSearch(sessionId) {
    this.pruneSearches();
    const s = this.searches.get(sessionId);
    if (!s) throw new DemoError(`Search session ${sessionId.slice(0, 80)} not found`);
    return s;
  }

  moreSearchResults({ sessionId, offset, length }) {
    const s = this.getSearch(sessionId);
    s.lastRead = Date.now();
    if (s.status === "error") return errorResult(`Search session ${s.id} encountered an error: ${s.error}`);
    const complete = s.status !== "running";
    const all = s.results;
    const len = Math.min(length, 1000);
    const slice = offset < 0 ? all.slice(offset) : all.slice(offset, offset + len);
    const start = offset < 0 ? all.length - slice.length : offset;
    let text = `Search session: ${s.id}\nStatus: ${complete ? "COMPLETED" : "IN PROGRESS"}\n`
      + `Runtime: ${(this.runtimeMs(s) / 1000).toFixed(1)}s\nTotal results found: ${this.totalText(s)}\n`;
    if (!slice.length) {
      text += `${!complete ? "No results yet, search is still running..." : all.length === 0 ? "No matches found." : "No results in this range."}\n`;
    } else {
      text += `${offset < 0 ? `Showing last ${slice.length} results` : `Showing results ${start}-${start + slice.length - 1}`}\n\nResults:\n`
        + `${slice.map((r) => this.formatResult(r)).join("\n")}\n`;
    }
    const footer = [];
    if (offset >= 0 && (offset + slice.length < all.length || !complete)) {
      footer.push(`📖 More results available. Use get_more_search_results with offset: ${offset + slice.length}`);
    }
    if (complete) footer.push(...this.noteLines(s), "✅ Search completed.");
    return footer.length ? `${text}\n${footer.join("\n")}` : text;
  }

  stopSearch({ sessionId }) {
    const s = this.getSearch(sessionId);
    if (s.status !== "running") return `Search session ${s.id} had already completed.`;
    s.stop();
    return `Search session ${s.id} terminated successfully.`;
  }

  listSearches() {
    this.pruneSearches();
    if (!this.searches.size) return "No active searches.";
    const badge = { running: "🔄 RUNNING", completed: "✅ COMPLETED", error: "❌ ERROR", stopped: "⏹️ STOPPED" };
    return [...this.searches.values()].map((s) => `Session: ${s.id}\n  Type: ${s.searchType}\n  Pattern: "${s.pattern}"\n`
      + `  Status: ${badge[s.status]}\n  Runtime: ${(this.runtimeMs(s) / 1000).toFixed(1)}s\n  Results: ${s.results.length}\n`).join("\n");
  }

  // -------------------------------------------------------------------------------------------
  // Simulated process sessions

  async resolveCwd(cwd) {
    if (!cwd || !cwd.trim()) return DEMO_ROOT;
    const r = await this.ws.resolveExisting(cwd);
    if (!(await fsp.stat(r.real)).isDirectory()) throw new DemoError(`cwd is not a directory: ${r.virtual}`);
    return r.virtual;
  }

  finishSession(s, { exitCode = null, signal = null }) {
    if (s.endedAt) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.endedAt = Date.now();
    s.exitCode = exitCode;
    s.signal = signal;
    if (exitCode === 0) s.output += simulatedOutput(s.step, s.cwd);
    if (s.output.length > LIMITS.sessionOutputChars) s.output = s.output.slice(-LIMITS.sessionOutputChars);
    for (const wake of s.waiters.splice(0)) wake();
    const done = [...this.sessions.values()].filter((x) => x.endedAt).sort((x, y) => x.endedAt - y.endedAt);
    for (const old of done.slice(0, Math.max(0, done.length - LIMITS.completedSessions))) this.sessions.delete(old.pid);
  }

  waitSession(s, ms) {
    if (s.endedAt || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      s.waiters.push(done);
    });
  }

  exitPhrase(s) {
    return s.signal ? `terminated by signal ${s.signal}` : `exited with code ${s.exitCode}`;
  }

  async startProcess({ command, timeout_ms, cwd }) {
    const step = parseDemoCommand(command);
    const dir = await this.resolveCwd(cwd);
    const active = [...this.sessions.values()].filter((s) => !s.endedAt);
    if (active.length >= LIMITS.activeSessions) {
      throw new DemoError(`Too many running demo sessions (limit ${LIMITS.activeSessions}); force_terminate one first.`);
    }
    const s = {
      pid: this.nextPid++,
      command: command.trim(),
      cwd: dir,
      step,
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      output: "",
      cursor: 0,
      stdin: [],
      timer: null,
      waiters: [],
    };
    this.sessions.set(s.pid, s);
    if (step.kind === "sleep") s.timer = setTimeout(() => this.finishSession(s, { exitCode: 0 }), step.ms);
    else this.finishSession(s, { exitCode: 0 });
    await this.waitSession(s, timeout_ms);
    const out = s.output.slice(s.cursor);
    s.cursor = s.output.length;
    const status = s.endedAt
      ? `✅ Process ${this.exitPhrase(s)} (runtime: ${seconds(s.endedAt - s.startedAt)})`
      : "⏳ Process is still running. Use read_process_output to get more output, interact_with_process to send input, or force_terminate to stop it.";
    return `Process started with PID ${s.pid} (shell: demo-simulator; simulated PID, no real process)\n`
      + `Initial output:\n${out.trim() ? out.replace(/\n$/, "") : "(no output yet)"}\n${status}`;
  }

  getSession(pid) {
    const s = this.sessions.get(pid);
    if (!s) throw new DemoError(`No session found for PID ${pid}`);
    return s;
  }

  async readProcessOutput({ pid, timeout_ms, offset, length }) {
    const s = this.getSession(pid);
    const limit = length ?? LIMITS.fileReadLineLimit;
    let header;
    let body;
    if (offset === 0) {
      if (!s.endedAt && s.cursor >= s.output.length) await this.waitSession(s, timeout_ms);
      const lines = splitTextLines(s.output.slice(s.cursor));
      const chunk = lines.slice(0, limit);
      s.cursor = chunk.length === lines.length ? s.output.length : s.cursor + chunk.map((l) => `${l}\n`).join("").length;
      header = `[Reading ${chunk.length} new lines (total: ${splitTextLines(s.output).length} lines)]`;
      body = chunk.length ? chunk.join("\n") : "(No new output)";
    } else {
      const lines = splitTextLines(s.output);
      const start = offset > 0 ? offset : Math.max(0, lines.length + offset);
      const chunk = lines.slice(start, start + limit);
      header = offset > 0
        ? `[Reading ${chunk.length} lines from line ${start} (total: ${lines.length} lines, ${Math.max(0, lines.length - start - chunk.length)} remaining)]`
        : `[Reading last ${chunk.length} lines (total: ${lines.length} lines)]`;
      body = chunk.length ? chunk.join("\n") : "(No output in requested range)";
    }
    const state = s.endedAt
      ? (s.signal
        ? `✅ Process terminated by signal ${s.signal} (runtime: ${seconds(s.endedAt - s.startedAt)})`
        : `✅ Process completed with exit code ${s.exitCode} (runtime: ${seconds(s.endedAt - s.startedAt)})`)
      : `⏳ Process ${s.pid} is still running`;
    return `${header}\n\n${body}\n${state}`;
  }

  async interact({ pid, input, timeout_ms, wait_for_prompt }) {
    const s = this.sessions.get(pid);
    if (!s || s.endedAt) {
      throw new DemoError(`No active session for PID ${pid} (it may have exited; use read_process_output to see its final output)`);
    }
    s.stdin.push(input.slice(0, 1000));
    if (s.stdin.length > 20) s.stdin.shift();
    if (!wait_for_prompt) return `✅ Input sent to process ${pid}. Use read_process_output to get the response.`;
    await this.waitSession(s, Math.min(timeout_ms, 30_000));
    const status = s.endedAt
      ? `✅ Process ${this.exitPhrase(s)}`
      : `⏱️ No prompt detected within ${timeout_ms}ms — the process may still be working. Use read_process_output to get more output.`;
    return `✅ Input executed in process ${pid}.\n📭 (No output produced: demo sessions do not read stdin, and the input was not executed.)\n\n${status}`;
  }

  signalSession(s, signal) {
    this.finishSession(s, { signal });
  }

  forceTerminate({ pid }) {
    const s = this.sessions.get(pid);
    if (!s || s.endedAt) throw new DemoError(`No active session found for PID ${pid}`);
    this.signalSession(s, "SIGINT");
    return `Successfully terminated session ${pid} (signal SIGINT)`;
  }

  listSessions() {
    const all = [...this.sessions.values()];
    const active = all.filter((s) => !s.endedAt);
    const done = all.filter((s) => s.endedAt).sort((a, b) => b.endedAt - a.endedAt).slice(0, 10);
    if (!active.length && !done.length) return "No active sessions";
    const parts = [];
    if (active.length) {
      parts.push(`Active sessions:\n${active.map((s) => `PID: ${s.pid}, Status: running, Runtime: ${Math.round((Date.now() - s.startedAt) / 1000)}s, Command: ${s.command.slice(0, 80)}`).join("\n")}`);
    }
    if (done.length) {
      parts.push(`Recently completed:\n${done.map((s) => `PID: ${s.pid}, ${this.exitPhrase(s)}, Runtime: ${seconds(s.endedAt - s.startedAt)}, Command: ${s.command.slice(0, 80)}`).join("\n")}`);
    }
    return parts.join("\n\n");
  }

  listProcesses({ filter, limit }) {
    let rows = [...this.sessions.values()].filter((s) => !s.endedAt);
    const needle = filter?.trim().toLowerCase();
    if (needle) rows = rows.filter((s) => s.command.toLowerCase().includes(needle));
    const shown = rows.slice(0, limit);
    const header = `Processes (showing ${shown.length} of ${rows.length}, sorted by CPU) [review demo: simulated sessions only; real operating-system processes are never listed]`;
    if (!shown.length) return `${header}\n(no simulated processes are running)`;
    return `${header}\n${shown.map((s) => `PID ${s.pid}  PPID 1  USER demo  CPU 0.0%  MEM 0 KB  ${s.command.slice(0, 200)}`).join("\n")}`;
  }

  killProcess({ pid, signal }) {
    if (pid <= 1) throw new DemoError(`Refusing to signal PID ${pid}`);
    const s = this.sessions.get(pid);
    if (!s || s.endedAt) {
      throw new DemoError(`No process with PID ${pid} (review demo: only simulated demo sessions can be signaled)`);
    }
    this.signalSession(s, signal);
    return `Successfully terminated process ${pid}`;
  }

  // -------------------------------------------------------------------------------------------
  // Durable jobs (simulated; persisted in stateDir)

  jobView(j) {
    const end = j.endedAt ?? (j.startedAt ? Date.now() : null);
    return {
      jobId: j.id,
      state: j.state,
      ...(j.label ? { label: j.label } : {}),
      command: j.command,
      cwd: j.cwd,
      createdAt: iso(j.createdAt),
      startedAt: iso(j.startedAt),
      endedAt: iso(j.endedAt),
      elapsedMs: j.startedAt ? end - j.startedAt : null,
      exitCode: j.exitCode ?? null,
      signal: j.signal ?? null,
      reason: j.reason ?? null,
      progress: null,
      stdoutBytes: Buffer.byteLength(j.stdout),
      stderrBytes: Buffer.byteLength(j.stderr),
      simulated: true,
    };
  }

  getJob(jobId) {
    if (!/^j[0-9a-z]+-[0-9a-f]{16}$/.test(jobId)) throw new DemoError("Invalid job id.");
    const j = this.jobs.get(jobId);
    if (!j) throw new DemoError(`Job ${jobId} not found`);
    return j;
  }

  endJob(j, state, fields = {}) {
    if (JOB_TERMINAL.has(j.state)) return;
    const t = this.jobTimers.get(j.id);
    if (t) clearTimeout(t);
    this.jobTimers.delete(j.id);
    Object.assign(j, { state, endedAt: Date.now() }, fields);
    this.saveState();
    this.pumpJobs();
  }

  /** Starts queued jobs up to the concurrency cap; every job finishes from a timer. */
  pumpJobs() {
    if (this.closed) return;
    for (;;) {
      const all = [...this.jobs.values()];
      if (all.filter((j) => j.state === "running").length >= LIMITS.jobMaxConcurrent) break;
      const next = all.filter((j) => j.state === "queued").sort((a, b) => a.seq - b.seq)[0];
      if (!next) break;
      next.state = "running";
      next.startedAt = Date.now();
      const step = parseDemoCommand(next.command);
      const runMs = step.kind === "sleep" ? step.ms : 0;
      const limitMs = next.timeoutSeconds * 1000;
      this.jobTimers.set(next.id, setTimeout(() => {
        if (runMs > limitMs) {
          this.endJob(next, "timed_out", { signal: "SIGTERM", reason: `Stopped after timeoutSeconds=${next.timeoutSeconds}.` });
          return;
        }
        next.stdout = simulatedOutput(step, next.cwd).slice(0, LIMITS.jobLogBytes);
        this.endJob(next, "succeeded", { exitCode: 0 });
      }, Math.min(runMs, limitMs)));
    }
    this.saveState();
  }

  async jobStart({ command, cwd, timeoutSeconds, label }) {
    parseDemoCommand(command);
    const dir = await this.resolveCwd(cwd);
    const finished = [...this.jobs.values()].filter((j) => JOB_TERMINAL.has(j.state)).sort((a, b) => a.createdAt - b.createdAt);
    while (this.jobs.size >= LIMITS.jobs && finished.length) this.jobs.delete(finished.shift().id);
    if (this.jobs.size >= LIMITS.jobs) throw new DemoError("Too many unfinished demo jobs; cancel some first.");
    const now = Date.now();
    this.jobSeq = (this.jobSeq ?? 0) + 1;
    const j = {
      id: `j${now.toString(36)}-${randomBytes(8).toString("hex")}`,
      seq: this.jobSeq,
      command: command.trim(),
      cwd: dir,
      label: label ?? null,
      timeoutSeconds: timeoutSeconds ?? 3600,
      state: "queued",
      createdAt: now,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      signal: null,
      reason: null,
      stdout: "",
      stderr: "",
    };
    this.jobs.set(j.id, j);
    this.pumpJobs();
    const out = textResult(JSON.stringify({
      ...this.jobView(j),
      deduplicated: false,
      worker: "running",
      note: "Job accepted. Poll job_status (and job_logs) with this jobId.",
    }, null, 2));
    out.jobId = j.id;
    return out;
  }

  jobStatus({ jobId }) {
    return JSON.stringify(this.jobView(this.getJob(jobId)), null, 2);
  }

  jobList({ state, limit }) {
    let list = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (state) list = list.filter((j) => j.state === state);
    const shown = list.slice(0, limit);
    return JSON.stringify({
      total: list.length,
      shown: shown.length,
      worker: "running",
      jobs: shown.map((j) => ({
        jobId: j.id,
        state: j.state,
        ...(j.label ? { label: j.label } : {}),
        command: j.command.slice(0, 120),
        createdAt: iso(j.createdAt),
        exitCode: j.exitCode ?? null,
      })),
    }, null, 2);
  }

  jobLogs({ jobId, stream, offset, length }) {
    const j = this.getJob(jobId);
    const buf = Buffer.from(stream === "stderr" ? j.stderr : j.stdout, "utf8");
    const size = buf.length;
    const start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
    const len = Math.min(length ?? 16_384, 65_536);
    const chunk = buf.subarray(start, start + len);
    const meta = {
      jobId: j.id,
      stream,
      offset: start,
      nextOffset: start + chunk.length,
      size,
      droppedAfterLimit: 0,
      endOfLog: start + chunk.length >= size && JOB_TERMINAL.has(j.state),
    };
    return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }, { type: "text", text: chunk.length ? chunk.toString("utf8") : "(no output in this range)" }] };
  }

  jobCancel({ jobId }) {
    const j = this.getJob(jobId);
    let action;
    if (j.state === "queued") {
      this.endJob(j, "cancelled", { reason: "Cancelled before it started." });
      action = "cancelled_before_start";
    } else if (j.state === "running") {
      this.endJob(j, "cancelled", { signal: "SIGTERM", reason: "Cancelled by job_cancel." });
      action = "cancelled";
    } else {
      action = "already_finished";
    }
    return JSON.stringify({ action, ...this.jobView(j) }, null, 2);
  }
}
