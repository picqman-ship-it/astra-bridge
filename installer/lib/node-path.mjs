// Picks the Node path written into the LaunchAgent.
//
// process.execPath is always the fully resolved binary, which for Homebrew is a versioned
// Cellar path (/opt/homebrew/Cellar/node/24.1.0/bin/node) that disappears on the next
// `brew upgrade`, leaving launchd restarting a missing program. Instead we look for a stable
// name that resolves to the very same binary: the `node` found on PATH, Homebrew's
// <prefix>/opt/<formula>/bin/node and <prefix>/bin/node, and the usual /opt/homebrew (Apple
// silicon) and /usr/local (Intel, and the nodejs.org installer) locations. Nothing is
// hard-coded as the answer: a candidate is only used if it is the Node running right now.

import fs from "node:fs";
import path from "node:path";

// Version managers whose paths change whenever you switch or upgrade Node.
const VERSIONED = [/\/Cellar\//, /\/\.nvm\/versions\//, /\/\.asdf\/installs\//, /\/\.fnm\//, /\/mise\/installs\//, /\/\.volta\/tools\/image\//, /\/n\/versions\//];

export function isVersionedPath(p) {
  return VERSIONED.some((re) => re.test(p));
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function executable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Returns { path, stable, note } for the running Node. `pathEnv` is the user's PATH;
 * `extraCandidates` exists for tests.
 */
export function stableNodePath(execPath = process.execPath, { pathEnv = process.env.PATH ?? "", extraCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"] } = {}) {
  const real = realpath(execPath) ?? execPath;
  const candidates = [];
  for (const dir of pathEnv.split(":")) if (dir && path.isAbsolute(dir)) candidates.push(path.join(dir, "node"));
  const cellar = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(real);
  if (cellar) candidates.push(path.join(cellar[1], "opt", cellar[2], "bin", "node"), path.join(cellar[1], "bin", "node"));
  candidates.push(...extraCandidates);

  for (const c of [...new Set(candidates)]) {
    if (isVersionedPath(c) || !executable(c) || realpath(c) !== real) continue;
    return { path: c, stable: true, note: c === execPath ? null : `${c} (resolves to ${real})` };
  }
  const versioned = isVersionedPath(execPath);
  return {
    path: execPath,
    stable: !versioned,
    note: versioned
      ? `${execPath} is managed by a version manager and changes when Node is upgraded or switched; re-run ./install-macos.sh afterwards (./install-macos.sh doctor detects it)`
      : null,
  };
}
