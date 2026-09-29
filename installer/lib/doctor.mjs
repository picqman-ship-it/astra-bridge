// Read-only health check of an installation. Changes nothing; exits 1 when any check fails.
// Output never contains private key material or the owner email (people paste doctor output
// into issues); it does contain local paths and the relay URL.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describeMode, loadCommanderConfig, protectsCheckout } from "./commander.mjs";
import { axHelperPath, commanderBuildReason, installReason } from "./deps.mjs";
import { KEY_FILES, fingerprint, inspectKeys } from "./keys.mjs";
import { conflicts, createLaunchd, findOtherAgents, readPlist } from "./launchd.mjs";
import { isVersionedPath } from "./node-path.mjs";
import { MIN_NODE_MAJOR, checkPrereqs, parseVersion } from "./prereqs.mjs";
import { probeAccess, probeAgentStatus, probeHealth } from "./relay-probe.mjs";
import { run } from "./util.mjs";
import { readPersonalConfig } from "./wrangler-config.mjs";

/** The last meaningful status line the agent (or its mcp-commander child) logged. */
export function lastAgentEvent(logText) {
  const lines = String(logText).split("\n").filter((l) => /^\[(astra-bridge-agent|mcp-commander-remote-stdio)\]/.test(l));
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/refusing to start|fatal/.test(l)) return { level: "fail", line: l };
    const rejected = /websocket rejected status=(\d+)/.exec(l);
    if (rejected) {
      const why = { 401: "the relay does not accept this Mac's agent key (redeploy: ./install-macos.sh --redeploy)", 403: "the relay does not know this device id (check AGENT_DEVICE_ID)" }[rejected[1]];
      return { level: "fail", line: l, why };
    }
    if (/\] connected$/.test(l)) return { level: "pass", line: l };
    if (/disconnected|error|timeout|failed/.test(l)) return { level: "warn", line: l };
  }
  return null;
}

function logTail(file, bytes = 64 * 1024) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(bytes, size));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export async function doctor(ctx, { offline = false, fetchImpl = fetch } = {}) {
  const checks = [];
  const add = (group, name, level, detail, fix) => checks.push({ group, name, level, detail, ...(fix ? { fix: [].concat(fix) } : {}) });

  // --- this Mac
  let rawCommander = null;
  try {
    rawCommander = JSON.parse(fs.readFileSync(ctx.remoteConfigFile, "utf8"));
  } catch {}
  for (const c of checkPrereqs(ctx, { needGui: rawCommander?.trustedGui === true })) add("mac", c.name, c.level, c.detail, c.fix);

  // --- build
  for (const [name, dir] of [["mcp-commander", ctx.commanderDir], ["relay", ctx.relayDir]]) {
    const reason = installReason(dir);
    if (!fs.existsSync(path.join(dir, "node_modules"))) add("build", `${name} dependencies`, "fail", "node_modules missing", "./install-macos.sh");
    else if (reason) add("build", `${name} dependencies`, "warn", `${reason}`, "./install-macos.sh reinstalls them from package-lock.json");
    else add("build", `${name} dependencies`, "pass", "match package-lock.json");
  }
  const buildReason = commanderBuildReason(ctx.commanderDir);
  add("build", "mcp-commander build", !fs.existsSync(ctx.commanderEntry) ? "fail" : buildReason ? "warn" : "pass", buildReason ?? "dist/ is current", buildReason ? "./install-macos.sh" : undefined);

  // --- mcp-commander remote config
  const commander = await loadCommanderConfig(ctx);
  if (!commander.exists) add("workspace", "remote.json", "fail", `${ctx.remoteConfigFile} missing`, "./install-macos.sh");
  else if (!commander.cfg) add("workspace", "remote.json", "fail", commander.error, "Fix it, or: ./install-macos.sh --reconfigure --workspace <dir>");
  else {
    const cfg = commander.cfg;
    add("workspace", "remote.json", "pass", `${ctx.remoteConfigFile}: owner-only, roots ${cfg.roots.join(", ")}`);
    const risky = cfg.trustedTerminal || cfg.trustedGui;
    add("workspace", "access mode", risky ? "warn" : "pass", describeMode(cfg), risky ? "Back to file-only: ./install-macos.sh --file-only" : undefined);
    if (!protectsCheckout(ctx, commander.raw)) add("workspace", "checkout protection", "warn", `${ctx.repoDir} is not in protectedPaths (the agent still protects relay/)`, "./install-macos.sh adds it");
    if (cfg.trustedGui && !fs.existsSync(axHelperPath(ctx.commanderDir))) add("workspace", "GUI helper", "fail", "trustedGui is on but the Accessibility helper is not built", "xcode-select --install, then ./install-macos.sh");
  }

  // --- keys
  const keys = inspectKeys(ctx.astraHome);
  if (!keys.dir.exists) add("keys", "key directory", "fail", `${ctx.astraHome} missing`, "./install-macos.sh");
  else add("keys", "key directory", keys.dir.ok ? "pass" : "fail", keys.dir.ok ? `${ctx.astraHome} (0700)` : keys.dir.problems.join("; "));
  for (const [name, k] of [["agent key", keys.agent], ["client key", keys.client]]) {
    const file = path.join(ctx.astraHome, KEY_FILES[name.split(" ")[0]]);
    if (!k.exists) add("keys", name, "fail", `${file} missing`, "./install-macos.sh");
    else add("keys", name, k.ok ? "pass" : "fail", k.ok ? `0600 Ed25519, public …${fingerprint(k.publicKeyB64)}` : k.problems.join("; "));
  }

  // --- personal Cloudflare config
  const personal = readPersonalConfig(ctx.personalConfig);
  const v = personal.values ?? {};
  if (!personal.exists) add("cloudflare", "personal config", "fail", `${ctx.personalConfig} missing`, "./install-macos.sh");
  else if (personal.error) add("cloudflare", "personal config", "fail", personal.error);
  else {
    const missing = ["agentKey", "clientKey", "deviceId", "workerName", "email"].filter((k) => !v[k]);
    add("cloudflare", "personal config", missing.length || personal.problems.length ? "fail" : "pass",
      missing.length ? `not set: ${missing.join(", ")}` : personal.problems.length ? personal.problems.join("; ") : `worker ${v.workerName}, device ${v.deviceId}, owner email set`,
      missing.length || personal.problems.length ? "./install-macos.sh" : undefined);
    for (const [field, k] of [["agentKey", keys.agent], ["clientKey", keys.client]]) {
      if (v[field] && k.publicKeyB64 && v[field] !== k.publicKeyB64) {
        add("cloudflare", `${field === "agentKey" ? "agent" : "client"} public key`, "fail", "the personal config holds a different public key than this Mac's private key", "./install-macos.sh (updates the config and redeploys)");
      }
    }
    if (v.authMode !== "access") add("cloudflare", "auth mode", "warn", `MCP_AUTH_MODE is "${v.authMode}", not "access"`);
    else if (!personal.accessConfigured) add("cloudflare", "Access settings", "warn", "TEAM_DOMAIN / POLICY_AUD not set: /mcp fails closed (503)", "./install-macos.sh (guides the Access setup)");
    else add("cloudflare", "Access settings", "pass", `team ${new URL(v.teamDomain).hostname}, AUD set`);
    if (!v.relayUrl) add("cloudflare", "relay URL", "fail", "not recorded (OAUTH_ISSUER is a placeholder)", "./install-macos.sh (deploys and records it)");
  }

  // --- LaunchAgent
  let label = "com.example.astra-bridge-agent";
  try {
    const { readTemplate } = await import(pathToFileURL(ctx.installAgent).href);
    label = readTemplate().label;
  } catch {}
  const plistFile = path.join(ctx.launchAgentsDir, `${label}.plist`);
  const launchd = createLaunchd({ launchctl: ctx.launchctl, uid: ctx.uid, label });
  if (!fs.existsSync(plistFile)) add("agent", "LaunchAgent", "fail", `${plistFile} not installed`, "./install-macos.sh");
  else {
    const plist = readPlist(plistFile);
    if (plist.error) add("agent", "LaunchAgent", "fail", `${plistFile} is not a valid plist: ${plist.error}`, "./install-macos.sh");
    else {
      const [nodePath, agentPath] = plist.data.ProgramArguments ?? [];
      const envv = plist.data.EnvironmentVariables ?? {};
      const problems = [];
      const ver = nodePath && fs.existsSync(nodePath) ? parseVersion(run(nodePath, ["--version"], { timeoutMs: 15_000 }).stdout) : null;
      if (!ver) problems.push(`Node ${nodePath} is missing or does not run`);
      else if (ver.major < MIN_NODE_MAJOR) problems.push(`Node ${nodePath} is ${ver.raw}; ${MIN_NODE_MAJOR}+ is required`);
      if (!agentPath || !fs.existsSync(agentPath)) problems.push(`agent ${agentPath} is missing (checkout moved or deleted?)`);
      if (v.relayUrl && envv.ASTRA_RELAY_URL !== v.relayUrl) problems.push(`ASTRA_RELAY_URL ${envv.ASTRA_RELAY_URL} differs from the personal config (${v.relayUrl})`);
      if (v.deviceId && envv.ASTRA_DEVICE_ID !== v.deviceId) problems.push(`ASTRA_DEVICE_ID ${envv.ASTRA_DEVICE_ID} differs from the personal config (${v.deviceId})`);
      if (problems.length) add("agent", "LaunchAgent", "fail", problems.join("; "), "./install-macos.sh (rewrites the LaunchAgent)");
      else {
        const versioned = isVersionedPath(nodePath);
        add("agent", "LaunchAgent", versioned ? "warn" : "pass", `${plistFile} → Node ${ver.raw} at ${nodePath}`,
          versioned ? "This Node path changes when Node is upgraded or switched; re-run ./install-macos.sh afterwards." : undefined);
      }
    }
    const st = launchd.status();
    if (!st.loaded) add("agent", "launchd", "fail", "not loaded (the agent is not running)", `launchctl bootstrap gui/${ctx.uid} ${plistFile}   (or ./install-macos.sh)`);
    else if (st.state !== "running") add("agent", "launchd", "fail", `loaded but ${st.state ?? "not running"}, last exit ${st.lastExitCode ?? "?"}`, `See ${path.join(ctx.astraHome, "agent.stderr.log")}`);
    else add("agent", "launchd", "pass", `running, pid ${st.pid ?? "?"}`);
  }
  const ours = fs.existsSync(plistFile);
  for (const other of findOtherAgents(ctx.launchAgentsDir, label)) {
    const clash = ours && conflicts(other, v.relayUrl, v.deviceId);
    add("agent", "other agent", clash ? "fail" : "warn",
      `${other.label} (${other.file}) also runs an Astra Bridge agent for device ${other.deviceId ?? "?"}${clash ? "; both use the same relay and device, so they keep replacing each other's connection" : ""}`,
      clash || !ours ? `If it is an older install: launchctl bootout gui/${ctx.uid}/${other.label}   and move the file out of ~/Library/LaunchAgents` : undefined);
  }
  // The log is shared by every agent using this ~/.astra-bridge, so only read it for ours.
  const event = ours ? lastAgentEvent(logTail(path.join(ctx.astraHome, "agent.stderr.log")) ?? "") : null;
  if (event) add("agent", "agent log", event.level, event.line.slice(0, 200), event.why);

  // --- relay (network)
  if (offline) add("relay", "network checks", "warn", "skipped (--offline)");
  else if (v.relayUrl) {
    const h = await probeHealth(v.relayUrl, { fetchImpl });
    add("relay", "health", h.ok ? "pass" : "fail", h.ok ? `${v.relayUrl}/healthz OK` : `${v.relayUrl}/healthz: ${h.error}`, h.ok ? undefined : "Deployed? ./install-macos.sh --redeploy");
    if (h.ok && v.deviceId && keys.client.ok) {
      const st = await probeAgentStatus(v.relayUrl, v.deviceId, path.join(ctx.astraHome, KEY_FILES.client), { fetchImpl });
      if (!st.ok) {
        add("relay", "agent connection", "fail", `signed status request refused: ${st.error}`,
          st.status === 401 || st.status === 403 ? "The deployed Worker has other keys or another device id: ./install-macos.sh --redeploy" : undefined);
      } else {
        add("relay", "agent connection", st.agentConnected ? "pass" : "fail",
          st.agentConnected ? `connected, mcp-commander healthy, last seen ${Math.round((st.lastSeenAgeMs ?? 0) / 1000)} s ago` : `not connected (mcpHealthy=${st.mcpHealthy})`,
          st.agentConnected ? undefined : "Check the launchd and agent log lines above.");
      }
    }
    if (h.ok && v.authMode === "access") {
      const a = await probeAccess(v.relayUrl, { expectedTeamHost: v.teamDomain ? new URL(v.teamDomain).hostname : undefined, fetchImpl });
      const level = a.state === "verified" ? "pass" : a.state === "unreachable" || a.state === "unknown" ? "warn" : "fail";
      add("relay", "Cloudflare Access", level, a.detail, level === "pass" ? undefined : "./install-macos.sh guides the Access setup (relay/docs/SETUP-ACCESS.md)");
    }
  }

  return { ok: !checks.some((c) => c.level === "fail"), checks };
}

export function printDoctor(ui, result) {
  let group = null;
  for (const c of result.checks) {
    if (c.group !== group) {
      group = c.group;
      ui.write(`\n${group}`);
    }
    ui.write(`  ${c.level.toUpperCase().padEnd(4)}  ${c.name}: ${c.detail}`);
    for (const f of c.fix ?? []) ui.write(`        → ${f}`);
  }
  ui.write(result.ok ? "\nDoctor: no failures." : "\nDoctor: problems found (FAIL lines above).");
  ui.write("Output contains local paths and your relay URL, but no keys or email; review before sharing.");
}
