// launchctl for the agent's user LaunchAgent (gui/<uid> domain; no sudo). The binary is
// injectable so tests never touch the real launchd (see assertSafeLaunchctl in context.mjs).

import fs from "node:fs";
import path from "node:path";
import { poll, run as defaultRun } from "./util.mjs";

export function createLaunchd({ launchctl, uid, label, run = defaultRun }) {
  const target = `gui/${uid}/${label}`;
  const exec = (args) => run(launchctl, args, { timeoutMs: 30_000 });
  const api = {
    target,
    /** { loaded, state, pid, lastExitCode } from `launchctl print`. */
    status() {
      const r = exec(["print", target]);
      if (r.status !== 0) return { loaded: false };
      const field = (name) => new RegExp(`^\\s*${name} = (.+)$`, "m").exec(r.stdout)?.[1].trim();
      const pid = Number(field("pid"));
      return {
        loaded: true,
        state: field("state"),
        pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
        lastExitCode: field("last exit code"),
      };
    },
    bootout: () => exec(["bootout", target]),
    enable: () => exec(["enable", target]),
    bootstrap: (plist) => exec(["bootstrap", `gui/${uid}`, plist]),
    kickstart: () => exec(["kickstart", "-k", target]),
    async waitUnloaded(timeoutMs = 15_000) {
      return Boolean(await poll(() => !api.status().loaded, { timeoutMs, intervalMs: 250 }));
    },
    async waitRunning(timeoutMs = 10_000) {
      return (await poll(() => {
        const s = api.status();
        return s.loaded && s.state === "running" ? s : null;
      }, { timeoutMs, intervalMs: 250 })) || api.status();
    },
  };
  return api;
}

/** A plist as JSON via plutil: { data } or { error }. */
export function readPlist(file, run = defaultRun) {
  const r = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
  if (r.status !== 0) return { error: (r.stderr || r.stdout).trim().slice(0, 200) || "plutil failed" };
  try {
    return { data: JSON.parse(r.stdout) };
  } catch {
    return { error: "plutil produced no JSON" };
  }
}

/**
 * Other LaunchAgents that run an Astra Bridge agent (for example one installed by hand under
 * another label), with the relay URL and device id they use when readable. Two agents for the
 * same relay and device keep replacing each other's relay connection.
 */
export function findOtherAgents(launchAgentsDir, ourLabel, run = defaultRun) {
  let names;
  try {
    names = fs.readdirSync(launchAgentsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".plist") || name === `${ourLabel}.plist`) continue;
    const file = path.join(launchAgentsDir, name);
    let text;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > 256 * 1024) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("ASTRA_DEVICE_ID") && !/astra-bridge[^<]*\/agent\.mjs</.test(text)) continue;
    const plist = readPlist(file, run).data ?? {};
    const env = plist.EnvironmentVariables ?? {};
    out.push({
      file,
      label: plist.Label ?? /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? name.replace(/\.plist$/, ""),
      relayUrl: typeof env.ASTRA_RELAY_URL === "string" ? env.ASTRA_RELAY_URL : null,
      deviceId: typeof env.ASTRA_DEVICE_ID === "string" ? env.ASTRA_DEVICE_ID : null,
    });
  }
  return out;
}

/** The other agent competes with ours for the same relay connection. */
export function conflicts(other, relayUrl, deviceId) {
  return Boolean(relayUrl && deviceId) && other.deviceId === deviceId && (other.relayUrl ?? "").replace(/\/$/, "") === relayUrl;
}
