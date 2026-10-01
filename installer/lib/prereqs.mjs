// Prerequisite detection. Nothing here installs anything: a missing component is reported
// with the exact command or download the user runs themselves.

import fs from "node:fs";
import path from "node:path";
import { run as defaultRun } from "./util.mjs";

export const MIN_NODE_MAJOR = 22;
export const MIN_MACOS_MAJOR = 13;

export function parseVersion(raw) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(raw ?? "").trim());
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), raw: m[0] } : null;
}

const NODE_FIX = [
  "Install Node.js 22 LTS or newer (Astra Bridge does not install it for you):",
  "  • the macOS installer (.pkg) from https://nodejs.org/en/download, or",
  "  • Homebrew: brew install node, or",
  "  • nvm: nvm install 22 && nvm alias default 22",
  "Then open a new Terminal window and re-run ./install-macos.sh",
];

/**
 * Returns [{ name, level: "pass"|"warn"|"fail", detail, fix? }]. `system` injects facts for
 * tests: { platform, arch, nodeVersion, uid, run }.
 */
export function checkPrereqs(ctx, { needGui = false, system = {} } = {}) {
  const platform = system.platform ?? process.platform;
  const nodeArch = system.arch ?? process.arch;
  const nodeVersion = system.nodeVersion ?? process.versions.node;
  const uid = system.uid ?? ctx.uid;
  const run = system.run ?? defaultRun;
  const checks = [];
  const add = (name, level, detail, fix) => checks.push({ name, level, detail, ...(fix ? { fix } : {}) });

  if (platform !== "darwin") {
    add("macOS", "fail", `this installer supports macOS only (platform: ${platform})`);
    return checks;
  }
  if (uid === 0) {
    add("user", "fail", "running as root", ["Run the installer as your normal user, without sudo. The agent runs in your login session."]);
  }

  const sw = run("/usr/bin/sw_vers", ["-productVersion"]);
  const mac = sw.status === 0 ? parseVersion(sw.stdout) : null;
  if (!mac) add("macOS version", "warn", "could not read the macOS version (sw_vers)");
  else if (mac.major < MIN_MACOS_MAJOR) {
    add("macOS version", "fail", `macOS ${mac.raw} is not supported; Astra Bridge needs macOS ${MIN_MACOS_MAJOR} (Ventura) or newer`, [
      "Update macOS in System Settings → General → Software Update.",
    ]);
  } else add("macOS version", "pass", `macOS ${mac.raw}`);

  const arm = run("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"]).stdout.trim() === "1";
  const translated = run("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"]).stdout.trim() === "1";
  const hw = arm ? "Apple silicon (arm64)" : "Intel (x86_64)";
  if (arm && nodeArch === "x64") {
    add("architecture", "warn", `${hw}, but Node is an Intel (x64) build${translated ? " running under Rosetta" : ""}`, [
      "It works, but a native arm64 Node is faster. Install the arm64 build of Node 22+ and re-run the installer;",
      "dependencies are installed for whichever Node runs the installer.",
    ]);
  } else add("architecture", "pass", `${hw}, Node ${nodeArch}`);

  const node = parseVersion(nodeVersion);
  if (!node || node.major < MIN_NODE_MAJOR) {
    add("Node.js", "fail", `Node ${nodeVersion} at ${ctx.execPath}; version ${MIN_NODE_MAJOR} or newer is required (wrangler needs it)`, NODE_FIX);
  } else add("Node.js", "pass", `Node ${nodeVersion} (${ctx.execPath})`);

  const npm = run(ctx.npm, ["--version"], { env: ctx.childEnv, timeoutMs: 30_000 });
  const npmVersion = npm.status === 0 ? parseVersion(npm.stdout) : null;
  if (!npmVersion) add("npm", "fail", `npm not found or not working (${ctx.npm})`, NODE_FIX);
  else add("npm", "pass", `npm ${npmVersion.raw}`);
  const npx = path.join(path.dirname(ctx.npm), "npx");
  if (ctx.npm !== "npm" && !fs.existsSync(npx)) {
    add("npx", "warn", `npx not found next to ${ctx.npm}`, ["npx comes with npm; reinstall Node.js if it is missing."]);
  } else if (npmVersion) add("npx", "pass", "available");

  // xcode-select -p never opens the "install developer tools" dialog; xcrun and git would,
  // so they are only called once the tools are known to be installed.
  const sel = run("/usr/bin/xcode-select", ["-p"]);
  const cltDir = sel.status === 0 ? sel.stdout.trim() : "";
  const cltOk = Boolean(cltDir) && fs.existsSync(cltDir);
  const swiftc = cltOk ? run("/usr/bin/xcrun", ["--find", "swiftc"]).status === 0 : false;
  const cltFix = ["Install them with: xcode-select --install", "(a macOS dialog asks you to confirm; then re-run ./install-macos.sh)"];
  if (cltOk && swiftc) add("Xcode Command Line Tools", "pass", cltDir);
  else if (needGui) {
    add("Xcode Command Line Tools", "fail", `${cltOk ? "installed, but swiftc is missing" : "not installed"}; GUI tools need them to build the Accessibility helper`, cltFix);
  } else {
    add("Xcode Command Line Tools", "warn", `${cltOk ? "installed, but swiftc is missing" : "not installed"}; only the optional GUI tools need them`, cltFix);
  }

  if (/[:\n\r]/.test(ctx.repoDir)) {
    add("checkout location", "fail", `${ctx.repoDir} contains ':' or a newline, which the agent cannot protect`, [
      "Move the checkout to a path without ':' (for example ~/astra-bridge) and run the installer from there.",
    ]);
  }
  return checks;
}

export function blockers(checks) {
  return checks.filter((c) => c.level === "fail");
}
