// A fixed, owner-only locator survives ordinary uninstall and custom ASTRA_HOME overrides.
// Purge never takes deletion targets from the current shell environment.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readPlist } from "./launchd.mjs";
import { inspectKeyDir } from "./keys.mjs";
import { InstallerError, sha256, writeFileAtomic } from "./util.mjs";

export const metadataFile = (ctx) => path.join(ctx.home, ".config", "astra-bridge", "install.json");
const fail = (message) => { throw new InstallerError(`installed paths cannot be validated: ${message}; refusing removal`); };

function regularOwned(file, privateFile = false) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st?.isFile() || st.uid !== process.getuid() || (st.mode & 0o022)) fail(`${file} is not an owned, non-writable regular file`);
  if (privateFile && (st.mode & 0o777) !== 0o600) fail(`${file} must have mode 0600`);
  return fs.readFileSync(file, "utf8");
}

function realDirectoryChain(dir) {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    const st = fs.lstatSync(d, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) fail(`${d} is not a real directory`);
  }
}

function validate(ctx, data, plistFile) {
  if (data?.version !== 1 || data.home !== ctx.home || data.repoDir !== ctx.repoDir
    || data.personalConfig !== ctx.personalConfig || data.plistFile !== plistFile) fail("metadata belongs to a different home or checkout");
  for (const key of ["astraHome", "commanderRemoteDir"]) {
    const dir = data[key];
    if (typeof dir !== "string" || !path.isAbsolute(dir) || path.resolve(dir) !== dir || ["/", ctx.home, ctx.repoDir].includes(dir)) fail(`invalid ${key}`);
    realDirectoryChain(dir);
  }
  if (ctx.customAstraHome && ctx.astraHome !== data.astraHome) fail("ASTRA_HOME differs from the installation");
  if (ctx.customRemoteDir && ctx.commanderRemoteDir !== data.commanderRemoteDir) fail("ASTRA_COMMANDER_REMOTE_DIR differs from the installation");
  if (!/^[0-9a-f]{64}$/.test(data.plistHash ?? "")) fail("missing plist fingerprint");
  const keys = inspectKeyDir(data.astraHome);
  if (keys.exists && !keys.ok) fail(keys.problems.join("; "));
  return data;
}

export function recordInstallation(ctx, plistFile, plist) {
  const data = { version: 1, home: ctx.home, repoDir: ctx.repoDir, astraHome: ctx.astraHome,
    commanderRemoteDir: ctx.commanderRemoteDir, personalConfig: ctx.personalConfig, plistFile, plistHash: sha256(plist) };
  validate(ctx, data, plistFile);
  const file = metadataFile(ctx);
  realDirectoryChain(path.dirname(file));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const dir = fs.statSync(path.dirname(file));
  if (dir.uid !== process.getuid() || (dir.mode & 0o077)) fail("metadata directory is not owner-only");
  if (fs.lstatSync(file, { throwIfNoEntry: false })) regularOwned(file, true);
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

export async function installedPaths(ctx, plistFile, { read = readPlist } = {}) {
  const file = metadataFile(ctx);
  realDirectoryChain(path.dirname(file));
  let saved;
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    const dir = fs.statSync(path.dirname(file));
    if (dir.uid !== process.getuid() || (dir.mode & 0o077)) fail("metadata directory is not owner-only");
    try { saved = JSON.parse(regularOwned(file, true)); } catch (err) { fail(err.message); }
    validate(ctx, saved, plistFile);
  }
  if (!fs.lstatSync(plistFile, { throwIfNoEntry: false })) {
    if (!saved) fail("no install metadata or installed plist; re-run setup before purging");
    return saved;
  }
  const text = regularOwned(plistFile);
  const { data: plist, error } = read(plistFile);
  if (error || !plist) fail("invalid plist");
  const { readTemplate, renderPlist } = await import(pathToFileURL(ctx.installAgent).href);
  const template = readTemplate();
  const env = plist.EnvironmentVariables ?? {};
  const astraHome = path.dirname(plist.StandardErrorPath ?? "");
  const remoteDir = env.ASTRA_COMMANDER_REMOTE_DIR ?? path.join(ctx.home, ".mcp-commander-remote");
  if (plist.Label !== template.label || plist.ProgramArguments?.length !== 2
    || plist.ProgramArguments[1] !== ctx.agentPath || plist.WorkingDirectory !== ctx.relayDir
    || env.ASTRA_COMMANDER_ENTRY !== ctx.commanderEntry
    || (env.ASTRA_AGENT_KEY_FILE ?? path.join(ctx.home, ".astra-bridge", "agent-private.pem")) !== path.join(astraHome, "agent-private.pem")
    || plist.StandardOutPath !== path.join(astraHome, "agent.stdout.log")
    || plist.StandardErrorPath !== path.join(astraHome, "agent.stderr.log")) fail("plist identity or key/log paths mismatch");
  const optionalEnv = [["ASTRA_COMMANDER_ENTRY", ctx.commanderEntry]];
  if (env.ASTRA_COMMANDER_REMOTE_DIR) optionalEnv.push(["ASTRA_COMMANDER_REMOTE_DIR", remoteDir]);
  if (env.ASTRA_AGENT_KEY_FILE) optionalEnv.push(["ASTRA_AGENT_KEY_FILE", env.ASTRA_AGENT_KEY_FILE]);
  const expected = renderPlist(template.text, { NODE: plist.ProgramArguments[0], AGENT_PATH: ctx.agentPath,
    WORKING_DIR: ctx.relayDir, RELAY_URL: env.ASTRA_RELAY_URL, RELAY_HOST: env.ASTRA_RELAY_HOST,
    DEVICE_ID: env.ASTRA_DEVICE_ID, LOG_DIR: astraHome, optionalEnv });
  if (expected !== text) fail("plist differs from the installer template");
  const derived = validate(ctx, { version: 1, home: ctx.home, repoDir: ctx.repoDir, astraHome,
    commanderRemoteDir: remoteDir, personalConfig: ctx.personalConfig, plistFile, plistHash: sha256(text) }, plistFile);
  if (saved && Object.keys(derived).some((k) => derived[k] !== saved[k])) fail("plist and install metadata mismatch");
  return derived;
}
