// Where everything lives. All locations derive from this checkout and $HOME, so the installer
// is machine-agnostic, and tests run it against a temporary HOME and fake launchctl/wrangler.
//
// Overrides (all optional):
//   ASTRA_HOME                  keys, agent logs, installer state (default ~/.astra-bridge)
//   ASTRA_COMMANDER_REMOTE_DIR  mcp-commander remote config (default ~/.mcp-commander-remote)
//   ASTRA_LAUNCHCTL             launchctl binary (tests only; see assertSafeLaunchctl)
//   ASTRA_WRANGLER              wrangler binary (default relay/node_modules/.bin/wrangler)
//   ASTRA_NPM                   npm binary (default: the npm next to this Node, else PATH)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InstallerError, expandHome } from "./util.mjs";

export const REAL_LAUNCHCTL = "/bin/launchctl";

export function repoDirFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function createContext({ env = process.env, repoDir = repoDirFromHere(), execPath = process.execPath } = {}) {
  const home = env.HOME ? path.resolve(env.HOME) : os.homedir();
  const abs = (p) => path.resolve(expandHome(p, home));
  const relayDir = path.join(repoDir, "relay");
  const commanderDir = path.join(repoDir, "mcp-commander");
  const astraHome = abs(env.ASTRA_HOME || path.join(home, ".astra-bridge"));
  const commanderRemoteDir = abs(env.ASTRA_COMMANDER_REMOTE_DIR || path.join(home, ".mcp-commander-remote"));
  const nodeDir = path.dirname(execPath);
  const siblingNpm = path.join(nodeDir, "npm");
  const npm = env.ASTRA_NPM || (fs.existsSync(siblingNpm) ? siblingNpm : "npm");
  // Children (npm, wrangler, keygen) must use this same Node: put its directory first on PATH.
  const childEnv = { ...env, PATH: [nodeDir, env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"].join(":") };
  delete childEnv.NODE_ENV; // NODE_ENV=production would make `npm ci` skip the TypeScript compiler

  return {
    env,
    childEnv,
    home,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    execPath,
    repoDir,
    relayDir,
    commanderDir,
    astraHome,
    commanderRemoteDir,
    remoteConfigFile: path.join(commanderRemoteDir, "remote.json"),
    commanderSetup: path.join(commanderDir, "dist", "remote", "setup.js"),
    commanderEntry: path.join(commanderDir, "dist", "remote-stdio.js"),
    commanderConfigModule: path.join(commanderDir, "dist", "remote", "config.js"),
    keygen: path.join(relayDir, "scripts", "keygen.mjs"),
    installAgent: path.join(relayDir, "scripts", "install-agent.mjs"),
    agentPath: path.join(relayDir, "src", "agent.mjs"),
    templateConfig: path.join(relayDir, "wrangler.jsonc"),
    personalConfig: path.join(relayDir, "wrangler.personal.jsonc"),
    stateFile: path.join(astraHome, "install-state.json"),
    launchAgentsDir: path.join(home, "Library", "LaunchAgents"),
    launchctl: env.ASTRA_LAUNCHCTL || REAL_LAUNCHCTL,
    wrangler: env.ASTRA_WRANGLER || path.join(relayDir, "node_modules", ".bin", "wrangler"),
    npm,
    defaultWorkspace: path.join(home, "remote-workspace"),
    customAstraHome: Boolean(env.ASTRA_HOME),
    customRemoteDir: Boolean(env.ASTRA_COMMANDER_REMOTE_DIR),
  };
}

/**
 * The real launchctl acts on your real login session. If HOME has been pointed somewhere else
 * (a test sandbox), a plist written there must never be loaded for real, so refuse.
 */
export function assertSafeLaunchctl(ctx) {
  if (ctx.launchctl !== REAL_LAUNCHCTL) return;
  let realHome;
  try {
    realHome = os.userInfo().homedir;
  } catch {
    realHome = null;
  }
  if (!realHome || path.resolve(realHome) !== path.resolve(ctx.home)) {
    throw new InstallerError(
      `HOME is ${ctx.home} but your account's home is ${realHome ?? "unknown"}; refusing to run the real launchctl against it.`,
      { hint: "Unset HOME overrides, or set ASTRA_LAUNCHCTL to a fake launchctl for tests." },
    );
  }
}
