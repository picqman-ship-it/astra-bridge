#!/usr/bin/env node
// Renders the Mac agent's LaunchAgent plist from relay/templates/astra-bridge-agent.plist.template.
//
// Default (--dry-run): validate the values and PRINT the plist to stdout. Nothing is written.
// --install:   also write ~/Library/LaunchAgents/<label>.plist and print the launchctl
//              commands to load it. This script never runs launchctl itself.
// --uninstall: print the commands that unload and remove the LaunchAgent. Nothing is changed.
//
// Values come from flags, falling back to environment variables (the ASTRA_* names the agent
// reads, plus ASTRA_HOME, which only this installer and keygen use):
//   --relay-url            ASTRA_RELAY_URL             required, https://<your-worker>.<your-subdomain>.workers.dev
//   --relay-host           ASTRA_RELAY_HOST            default: the host of --relay-url (pinned by the agent)
//   --device-id            ASTRA_DEVICE_ID             required, [a-zA-Z0-9._-]{1,96}, same as the Worker's AGENT_DEVICE_ID
//   --node                                             default: the Node binary running this script
//   --agent-path                                       default: relay/src/agent.mjs next to this script
//   --commander-entry      ASTRA_COMMANDER_ENTRY       default: mcp-commander/dist/remote-stdio.js in this repository
//   --commander-remote-dir ASTRA_COMMANDER_REMOTE_DIR  optional (agent default ~/.mcp-commander-remote)
//   --agent-key-file       ASTRA_AGENT_KEY_FILE        default: <astra home>/agent-private.pem
//   --astra-home           ASTRA_HOME                  default ~/.astra-bridge (keys and agent logs)
//
// Validation reuses agentConfig() from relay/src/agent-lib.mjs, so a plist that renders here
// passes the same checks the agent runs at startup.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentConfig } from "../src/agent-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_DIR = path.resolve(RELAY_DIR, "..");
const TEMPLATE_PATH = path.join(RELAY_DIR, "templates", "astra-bridge-agent.plist.template");
const DEFAULT_AGENT_PATH = path.join(RELAY_DIR, "src", "agent.mjs");
const DEFAULT_COMMANDER_ENTRY = path.join(REPO_DIR, "mcp-commander", "dist", "remote-stdio.js");
const PLACEHOLDERS = ["NODE", "AGENT_PATH", "WORKING_DIR", "RELAY_URL", "RELAY_HOST", "DEVICE_ID", "OPTIONAL_ENV", "LOG_DIR"];

const USAGE = `Usage: node relay/scripts/install-agent.mjs --relay-url <https://host> --device-id <id> [options]

Modes (default --dry-run):
  --dry-run                 print the rendered plist to stdout; write nothing
  --install                 write ~/Library/LaunchAgents/<label>.plist and print the
                            launchctl commands to load it (launchctl is never run for you)
  --uninstall               print the commands that unload and remove the LaunchAgent
  --force                   with --install: replace an existing, different plist

Values (flag, else environment variable, else default):
  --relay-url <url>             ASTRA_RELAY_URL (required)
  --relay-host <host>           ASTRA_RELAY_HOST (default: host of --relay-url)
  --device-id <id>              ASTRA_DEVICE_ID (required)
  --node <path>                 default: ${process.execPath}
  --agent-path <path>           default: ${DEFAULT_AGENT_PATH}
  --commander-entry <path>      ASTRA_COMMANDER_ENTRY (default: ${DEFAULT_COMMANDER_ENTRY})
  --commander-remote-dir <dir>  ASTRA_COMMANDER_REMOTE_DIR (optional)
  --agent-key-file <path>       ASTRA_AGENT_KEY_FILE (default: <astra home>/agent-private.pem)
  --astra-home <dir>            ASTRA_HOME (default: ~/.astra-bridge; keys and agent logs)
  --help                        show this help
`;

class UsageError extends Error {}

const VALUE_FLAGS = {
  "--relay-url": "relayUrl",
  "--relay-host": "relayHost",
  "--device-id": "deviceId",
  "--node": "node",
  "--agent-path": "agentPath",
  "--commander-entry": "commanderEntry",
  "--commander-remote-dir": "commanderRemoteDir",
  "--agent-key-file": "agentKeyFile",
  "--astra-home": "astraHome",
};

export function parseArgs(argv) {
  const flags = { mode: null, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (a in VALUE_FLAGS) {
      const v = inline ?? argv[++i];
      if (v === undefined || v === "" || (inline === undefined && v.startsWith("--"))) {
        throw new UsageError(`${a} needs a value`);
      }
      flags[VALUE_FLAGS[a]] = v;
    } else if (a === "--dry-run" || a === "--install" || a === "--uninstall") {
      const mode = a.slice(2);
      if (flags.mode && flags.mode !== mode) throw new UsageError(`--${flags.mode} and ${a} cannot be combined`);
      flags.mode = mode;
    } else if (a === "--force") {
      flags.force = true;
    } else if (a === "--help" || a === "-h") {
      flags.help = true;
    } else {
      throw new UsageError(`unknown argument: ${argv[i]}`);
    }
  }
  flags.mode ??= "dry-run";
  if (flags.force && flags.mode !== "install") throw new UsageError("--force only applies to --install");
  return flags;
}

function expandHome(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function assertPlainValue(name, value) {
  // Control characters are not valid in an XML 1.0 plist and never belong in these values.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new UsageError(`${name} must not contain control characters or newlines`);
}

export function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Resolves flags + environment into the plist values and validates them with the agent's own
 * agentConfig(). Returns { values, warnings } where warnings are non-fatal for a dry run.
 */
export function resolveValues(flags, env = process.env, home = os.homedir()) {
  const pick = (flag, envName) => {
    const v = flags[flag] ?? (envName ? env[envName] : undefined);
    return v === undefined || v === "" ? undefined : v;
  };
  const abs = (p) => path.resolve(expandHome(p, home));

  const relayUrl = pick("relayUrl", "ASTRA_RELAY_URL");
  if (!relayUrl) throw new UsageError("--relay-url (or ASTRA_RELAY_URL) is required");
  let relayHost = pick("relayHost", "ASTRA_RELAY_HOST");
  if (!relayHost) {
    try {
      relayHost = new URL(relayUrl).hostname;
    } catch {
      throw new UsageError("ASTRA_RELAY_URL is not a valid URL");
    }
  }
  const deviceId = pick("deviceId", "ASTRA_DEVICE_ID");
  if (!deviceId) throw new UsageError("--device-id (or ASTRA_DEVICE_ID) is required");

  const astraHome = abs(pick("astraHome", "ASTRA_HOME") ?? path.join(home, ".astra-bridge"));
  const nodePath = abs(pick("node") ?? process.execPath);
  const agentPath = abs(pick("agentPath") ?? DEFAULT_AGENT_PATH);
  const commanderEntry = abs(pick("commanderEntry", "ASTRA_COMMANDER_ENTRY") ?? DEFAULT_COMMANDER_ENTRY);
  const commanderRemoteDirRaw = pick("commanderRemoteDir", "ASTRA_COMMANDER_REMOTE_DIR");
  const commanderRemoteDir = commanderRemoteDirRaw ? abs(commanderRemoteDirRaw) : undefined;
  const agentKeyFile = abs(pick("agentKeyFile", "ASTRA_AGENT_KEY_FILE") ?? path.join(astraHome, "agent-private.pem"));

  const plain = { relayUrl, relayHost, deviceId, astraHome, nodePath, agentPath, commanderEntry, agentKeyFile };
  if (commanderRemoteDir) plain.commanderRemoteDir = commanderRemoteDir;
  for (const [name, value] of Object.entries(plain)) assertPlainValue(name, value);

  // Exactly the environment the agent will see, checked by the agent's own validator.
  const agentEnv = {
    ASTRA_RELAY_URL: relayUrl,
    ASTRA_RELAY_HOST: relayHost,
    ASTRA_DEVICE_ID: deviceId,
    ASTRA_COMMANDER_ENTRY: commanderEntry,
    ASTRA_AGENT_KEY_FILE: agentKeyFile,
    ...(commanderRemoteDir ? { ASTRA_COMMANDER_REMOTE_DIR: commanderRemoteDir } : {}),
  };
  try {
    agentConfig(agentEnv, { homedir: home, execPath: nodePath });
  } catch (err) {
    throw new UsageError(`invalid agent configuration: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Missing program files are always fatal: launchd would restart a broken agent forever.
  try {
    fs.accessSync(nodePath, fs.constants.X_OK);
    if (!fs.statSync(nodePath).isFile()) throw new Error();
  } catch {
    throw new UsageError(`--node ${nodePath} is not an executable file`);
  }
  if (!fs.statSync(agentPath, { throwIfNoEntry: false })?.isFile()) {
    throw new UsageError(`--agent-path ${agentPath} does not exist`);
  }
  if (!fs.existsSync(path.join(path.dirname(agentPath), "agent-lib.mjs"))) {
    throw new UsageError(`agent-lib.mjs must sit next to ${agentPath}`);
  }

  const warnings = [];
  if (!fs.existsSync(commanderEntry)) {
    warnings.push(`mcp-commander entry ${commanderEntry} does not exist yet (build it: cd mcp-commander && npm run build)`);
  }
  if (!fs.existsSync(agentKeyFile)) {
    warnings.push(`agent key ${agentKeyFile} does not exist yet (run: node relay/scripts/keygen.mjs)`);
  }
  if (!fs.statSync(astraHome, { throwIfNoEntry: false })?.isDirectory()) {
    warnings.push(`log directory ${astraHome} does not exist yet (keygen creates it)`);
  }
  if (nodePath.includes("/Cellar/")) {
    warnings.push(
      `--node ${nodePath} is a versioned Homebrew path that disappears on upgrade; ` +
      "consider --node /opt/homebrew/bin/node (Apple silicon) or --node /usr/local/bin/node (Intel)",
    );
  }

  // The agent resolves its npm dependencies relative to its own file, so this only needs to
  // be a stable directory; the relay package root is the natural choice.
  const agentDir = path.dirname(agentPath);
  const workingDir = path.basename(agentDir) === "src" ? path.dirname(agentDir) : agentDir;

  // ASTRA_AGENT_KEY_FILE is written only when it differs from the agent's own default.
  const defaults = agentConfig(
    { ASTRA_RELAY_URL: relayUrl, ASTRA_RELAY_HOST: relayHost, ASTRA_DEVICE_ID: deviceId },
    { homedir: home, execPath: nodePath },
  );
  const optionalEnv = [["ASTRA_COMMANDER_ENTRY", commanderEntry]];
  if (commanderRemoteDir) optionalEnv.push(["ASTRA_COMMANDER_REMOTE_DIR", commanderRemoteDir]);
  if (agentKeyFile !== defaults.keyFile) optionalEnv.push(["ASTRA_AGENT_KEY_FILE", agentKeyFile]);

  return {
    values: {
      NODE: nodePath,
      AGENT_PATH: agentPath,
      WORKING_DIR: workingDir,
      RELAY_URL: relayUrl,
      RELAY_HOST: relayHost,
      DEVICE_ID: deviceId,
      LOG_DIR: astraHome,
      optionalEnv,
    },
    warnings,
    astraHome,
    agentKeyFile,
    commanderEntry,
  };
}

export function readTemplate(templatePath = TEMPLATE_PATH) {
  const text = fs.readFileSync(templatePath, "utf8");
  for (const name of PLACEHOLDERS) {
    if (!text.includes(`{{${name}}}`)) throw new Error(`template is missing {{${name}}}`);
  }
  const m = text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
  if (!m || !/^[A-Za-z0-9._-]{1,128}$/.test(m[1])) throw new Error("template has no valid Label");
  return { text, label: m[1] };
}

export function renderPlist(templateText, values) {
  const optional = values.optionalEnv
    .map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${xmlEscape(v)}</string>`)
    .join("\n");
  // A replacer function, so "$&"-style sequences in paths are never treated as patterns.
  let out = templateText.replace(/^\{\{OPTIONAL_ENV\}\}\n/m, () => (optional ? `${optional}\n` : ""));
  for (const name of PLACEHOLDERS) {
    if (name === "OPTIONAL_ENV") continue;
    out = out.split(`{{${name}}}`).join(xmlEscape(values[name]));
  }
  const leftover = out.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`unrendered placeholder ${leftover[0]}`);
  return out;
}

function launchAgentPath(label, home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

function shQuote(s) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function printUninstall(label) {
  const target = launchAgentPath(label);
  process.stdout.write(
    [
      "To stop and remove the Astra Bridge agent, run:",
      "",
      `  launchctl bootout gui/$(id -u)/${label}`,
      `  rm ${shQuote(target)}`,
      "",
      "Keys and logs in ~/.astra-bridge are kept. Delete them yourself if you no longer need",
      "them, and remove the public keys from relay/wrangler.personal.jsonc (or delete the Worker).",
      "",
    ].join("\n"),
  );
}

function install(label, plist, resolved, force) {
  const target = launchAgentPath(label);
  const problems = [];
  if (!fs.existsSync(resolved.commanderEntry)) problems.push(`missing ${resolved.commanderEntry} (cd mcp-commander && npm run build)`);
  if (!fs.existsSync(resolved.agentKeyFile)) problems.push(`missing ${resolved.agentKeyFile} (node relay/scripts/keygen.mjs)`);
  if (!fs.statSync(resolved.astraHome, { throwIfNoEntry: false })?.isDirectory()) problems.push(`missing log directory ${resolved.astraHome}`);
  if (problems.length) throw new UsageError(`not installing:\n  ${problems.join("\n  ")}`);

  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

  let replaced = false;
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isFile()) throw new UsageError(`${target} exists and is not a regular file`);
    if (fs.readFileSync(target, "utf8") === plist) {
      process.stderr.write(`${target} is already up to date.\n`);
      printLoadCommands(label, target, resolved.astraHome, true);
      return;
    }
    if (!force) {
      throw new UsageError(`${target} already exists with different content; re-run with --force to replace it`);
    }
    replaced = true;
  }

  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, plist, { mode: 0o644, flag: "wx" });
  try {
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
  process.stderr.write(`Wrote ${target}${replaced ? " (replaced the previous version)" : ""}.\n`);

  if (fs.existsSync("/usr/bin/plutil")) {
    const lint = spawnSync("/usr/bin/plutil", ["-lint", target], { encoding: "utf8" });
    process.stderr.write(lint.status === 0 ? "plutil -lint: OK\n" : `plutil -lint FAILED:\n${lint.stdout}${lint.stderr}`);
    if (lint.status !== 0) process.exitCode = 1;
  }
  printLoadCommands(label, target, resolved.astraHome, replaced);
}

function printLoadCommands(label, target, logDir, reload) {
  const lines = ["", "Load it yourself (this script does not run launchctl):", ""];
  if (reload) lines.push(`  launchctl bootout gui/$(id -u)/${label} 2>/dev/null || true`);
  lines.push(
    `  launchctl bootstrap gui/$(id -u) ${shQuote(target)}`,
    "",
    "Check that it runs and connected:",
    "",
    `  launchctl print gui/$(id -u)/${label} | grep -E 'state =|pid ='`,
    `  tail -n 20 ${shQuote(path.join(logDir, "agent.stderr.log"))}    # expect "[astra-bridge-agent] connected"`,
    "",
  );
  process.stdout.write(lines.join("\n"));
}

function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`install-agent: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  const { text, label } = readTemplate();
  if (flags.mode === "uninstall") {
    printUninstall(label);
    return;
  }

  let resolved;
  try {
    resolved = resolveValues(flags);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`install-agent: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const plist = renderPlist(text, resolved.values);

  for (const w of resolved.warnings) process.stderr.write(`warning: ${w}\n`);
  if (flags.mode === "dry-run") {
    process.stdout.write(plist);
    process.stderr.write(
      `\nDry run: nothing was written. The plist above would go to ${launchAgentPath(label)}.\n` +
      "Re-run with --install to write it (you then load it with launchctl yourself).\n",
    );
    return;
  }

  try {
    install(label, plist, resolved, flags.force);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`install-agent: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
