// mcp-commander's remote configuration (~/.mcp-commander-remote/remote.json), which decides
// what the Mac side may touch. New configs are created with mcp-commander's own setup command;
// existing ones are validated with its own loader, so the root guards (home folder, keys,
// LaunchAgents, this checkout, symlink/firmlink spellings, ...) are exactly the ones the agent
// enforces. The installer never loosens them.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { run, writeFileAtomic } from "./util.mjs";

const PROTECTED_ENV = "MCP_COMMANDER_PROTECTED_PATHS";

/**
 * Loads remote.json the way the agent's mcp-commander child will: the agent adds its code
 * directory (relay/) to MCP_COMMANDER_PROTECTED_PATHS, so the same is done here.
 * Returns { exists, cfg?, raw?, error? }.
 */
export async function loadCommanderConfig(ctx) {
  if (!fs.existsSync(ctx.remoteConfigFile)) return { exists: false };
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(ctx.remoteConfigFile, "utf8"));
  } catch {}
  if (!fs.existsSync(ctx.commanderConfigModule)) {
    return { exists: true, raw, error: "mcp-commander is not built yet, so remote.json cannot be validated" };
  }
  const { loadRemoteConfig } = await import(pathToFileURL(ctx.commanderConfigModule).href);
  const previous = process.env[PROTECTED_ENV];
  process.env[PROTECTED_ENV] = [ctx.relayDir, previous].filter(Boolean).join(":");
  try {
    return { exists: true, raw, cfg: loadRemoteConfig(ctx.commanderRemoteDir) };
  } catch (err) {
    return { exists: true, raw, error: err.message };
  } finally {
    if (previous === undefined) delete process.env[PROTECTED_ENV];
    else process.env[PROTECTED_ENV] = previous;
  }
}

/**
 * Runs mcp-commander's setup command. The whole checkout is protected (not just relay/): it
 * holds the agent, mcp-commander and this installer, all of which run as you, so no remote
 * root may ever contain or sit inside it.
 */
export function runSetup(ctx, { workspace, terminal = false, gui = false, replace = false }) {
  const args = [ctx.commanderSetup, "--remote-dir", ctx.commanderRemoteDir, "--root", workspace, "--protect", ctx.repoDir];
  if (terminal) args.push("--trusted-terminal");
  if (gui) args.push("--trusted-gui");
  if (replace) args.push("--replace-config");
  return run(ctx.execPath, args, { env: ctx.childEnv });
}

/**
 * Changes only trustedTerminal / trustedGui / protectedPaths in an existing remote.json, keeping
 * every other setting (custom limits, blocked commands, roots). The result is validated with
 * mcp-commander's own parser before it replaces the file.
 */
export async function updateCommanderConfig(ctx, raw, { terminal, gui, protect }) {
  const next = { ...raw };
  if (terminal !== undefined) next.trustedTerminal = terminal;
  if (gui !== undefined) next.trustedGui = gui;
  if (protect) {
    const list = Array.isArray(raw.protectedPaths) ? [...raw.protectedPaths] : [];
    for (const p of protect) if (!list.includes(p)) list.push(p);
    next.protectedPaths = list;
  }
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const { parseRemoteConfig } = await import(pathToFileURL(ctx.commanderConfigModule).href);
  parseRemoteConfig(text, ctx.commanderRemoteDir); // throws with a user-facing message
  writeFileAtomic(ctx.remoteConfigFile, text, 0o600);
  return next;
}

/** Whether this checkout is listed in remote.json's protectedPaths. */
export function protectsCheckout(ctx, raw) {
  const list = Array.isArray(raw?.protectedPaths) ? raw.protectedPaths : [];
  return list.includes(ctx.repoDir);
}

export function describeMode(cfg) {
  const t = cfg?.trustedTerminal === true;
  const g = cfg?.trustedGui === true;
  if (!t && !g) return "file-only (15 file/search tools inside the workspace)";
  return [
    t ? "TERMINAL ON (27 tools: shell, processes and background jobs — arbitrary code execution as you)" : "terminal off",
    g ? "GUI ON (+4 tools: read and operate app windows through Accessibility)" : "GUI off",
  ].join("; ");
}
