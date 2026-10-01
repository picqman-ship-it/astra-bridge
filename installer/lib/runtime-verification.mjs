// Read-only evidence for a launchd restart. A matching hash alone cannot prove that a
// process loaded current inputs: a change followed by a revert keeps the hash unchanged.
import fs from "node:fs";
import path from "node:path";
import { KEY_FILES } from "./keys.mjs";
import { runtimeFingerprint, runtimePlist } from "./state.mjs";
import { InstallerError, run as defaultRun } from "./util.mjs";

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const DAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ");
const SECOND = 1_000_000_000n;
export const validRuntimePid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff;

/** macOS ps lstart (%c), with LC_ALL=C and TZ=UTC0. Never use locale-dependent Date.parse. */
export function parseProcessStart(text) {
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(String(text).trim());
  if (!m) return null;
  const [, dayName, monthName, day, hour, minute, second, year] = m;
  const values = [+year, MONTHS.indexOf(monthName), +day, +hour, +minute, +second];
  if (+year < 1970) return null;
  const ms = Date.UTC(...values);
  const date = new Date(ms);
  const actual = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
  return values.every((v, i) => v === actual[i]) && DAYS[date.getUTCDay()] === dayName ? ms : null;
}

export function processStartTime(pid, { run = defaultRun, now = Date.now } = {}) {
  if (!validRuntimePid(pid)) throw new InstallerError("invalid running PID");
  const r = run("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    timeoutMs: 15_000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC0" },
  });
  const start = r.status === 0 && !r.error ? parseProcessStart(r.stdout) : null;
  if (start === null || start > now()) throw new InstallerError("process start time cannot be established");
  return start;
}

/**
 * Required files, recursive source/build trees, and the key directory's own metadata.
 * install-state carries the applied/identity record. Logs are outputs, not runtime inputs.
 */
export function runtimeInputs(ctx, plist, plistFile, options = {}) {
  const data = runtimePlist(plist, options);
  const env = data.EnvironmentVariables ?? {};
  if (data.ProgramArguments.length !== 2 || data.ProgramArguments[1] !== ctx.agentPath
    || data.WorkingDirectory !== ctx.relayDir || env.ASTRA_COMMANDER_ENTRY !== ctx.commanderEntry
    || (env.ASTRA_AGENT_KEY_FILE ?? path.join(ctx.home, ".astra-bridge", KEY_FILES.agent)) !== path.join(ctx.astraHome, KEY_FILES.agent)
    || (env.ASTRA_COMMANDER_REMOTE_DIR ?? path.join(ctx.home, ".mcp-commander-remote")) !== ctx.commanderRemoteDir) {
    throw new InstallerError("runtime plist input paths differ from this installation");
  }
  return [
    ...[plistFile, ctx.remoteConfigFile, ctx.stateFile,
      ...Object.values(KEY_FILES).map((name) => path.join(ctx.astraHome, name)),
      ...[ctx.relayDir, ctx.commanderDir].map((dir) => path.join(dir, "package-lock.json")),
      data.ProgramArguments[0], fs.realpathSync(data.ProgramArguments[0]),
    ].map((file) => ({ file })),
    { file: ctx.astraHome, directory: true },
    { file: path.join(ctx.relayDir, "src"), directory: true, recursive: true },
    { file: path.join(ctx.commanderDir, "dist"), directory: true, recursive: true },
  ];
}

/** Missing/unreadable paths, unsupported types, cycles, and exhausted bounds all fail closed. */
export function newestInputCtime(inputs, { fsImpl = fs, maxEntries = 50_000, maxDepth = 64 } = {}) {
  let newest = 0n;
  let entries = 0;
  const timestamp = (st) => {
    if (typeof st.ctimeNs !== "bigint" || st.ctimeNs <= 0n) throw new InstallerError("runtime input ctime is unavailable");
    if (st.ctimeNs > newest) newest = st.ctimeNs;
  };
  const stat = (file) => {
    if (++entries > maxEntries) throw new InstallerError("runtime input traversal limit exceeded");
    return fsImpl.lstatSync(file, { bigint: true });
  };
  // Observe symlinks in every path component (e.g. Homebrew opt/node), as well as
  // their resolved targets. Ordinary ancestor directory changes are unrelated.
  const resolve = (file) => {
    if (!path.isAbsolute(file) || file === path.parse(file).root) throw new InstallerError("invalid runtime input root");
    let parts = file.split(path.sep).filter(Boolean);
    let current = path.parse(file).root;
    const links = new Set();
    while (parts.length) {
      const part = parts.shift();
      if (part === ".") continue;
      if (part === "..") { current = path.dirname(current); continue; }
      current = path.join(current, part);
      const st = stat(current);
      if (st.isSymbolicLink()) {
        timestamp(st);
        if (links.has(current) || links.size >= maxDepth) throw new InstallerError("runtime input symlink cycle or depth limit");
        links.add(current);
        const target = fsImpl.readlinkSync(current);
        current = path.isAbsolute(target) ? path.parse(target).root : path.dirname(current);
        // Resolve '..' only after preceding symlinks, exactly as path lookup does.
        parts = [...target.split(path.sep).filter(Boolean), ...parts];
      } else if (parts.length && !st.isDirectory()) {
        throw new InstallerError("invalid runtime input path");
      }
    }
    return { file: current, st: stat(current) };
  };
  const walk = (input, depth = 0, ancestors = new Set()) => {
    if (depth > maxDepth) throw new InstallerError("runtime input tree depth limit exceeded");
    const { file, st } = resolve(input.file);
    timestamp(st);
    if (input.directory === true ? !st.isDirectory() : input.directory === false ? !st.isFile() : !st.isFile() && !st.isDirectory()) {
      throw new InstallerError("unsupported runtime input type");
    }
    if (!input.recursive || !st.isDirectory()) return;
    if (ancestors.has(file)) throw new InstallerError("runtime input directory cycle");
    const next = new Set(ancestors).add(file);
    const names = fsImpl.readdirSync(file);
    if (names.length > maxEntries - entries) throw new InstallerError("runtime input traversal limit exceeded");
    for (const name of names) walk({ file: path.join(file, name), recursive: true }, depth + 1, next);
  };
  if (!inputs.length) throw new InstallerError("runtime input inventory is empty");
  for (const input of inputs) walk({ directory: false, ...input });
  return newest;
}

/** Same PID keeps the strict saved-fingerprint path. Changed PID needs additional proof. */
export function verifyRuntime(ctx, { plist, plistFile, status, runtime }, options = {}) {
  if (status?.loaded !== true || status.state !== "running" || !validRuntimePid(status.pid)
    || !runtime || runtime.pending || runtime.applied !== runtimeFingerprint(ctx, plist, options)) {
    return { ok: false, reason: "runtime/config inputs differ or restart/readiness verification is pending" };
  }
  if (status.pid === runtime.pid) return { ok: true, restarted: false };
  if (!validRuntimePid(runtime.pid) || (runtime.pending !== null && runtime.pending !== false)) {
    return { ok: false, reason: "saved runtime verification is incomplete" };
  }
  const start = processStartTime(status.pid, options);
  const newest = newestInputCtime(runtimeInputs(ctx, plist, plistFile, options), options);
  // ps has only second precision: require a DIFFERENT, later second even on filesystems
  // with coarse ctime. This rejects equality and every same-second ambiguity.
  if (BigInt(start / 1000) <= newest / SECOND) return { ok: false, reason: "process start does not strictly follow every runtime input ctime" };
  if (processStartTime(status.pid, options) !== start) return { ok: false, reason: "process changed during runtime verification" };
  return { ok: true, restarted: true };
}
