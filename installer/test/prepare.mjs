// `npm test` step: the end-to-end tests run the installer against this checkout's compiled
// mcp-commander, so build it first, as mcp-commander's and relay's own `npm test` build theirs.
// Missing prerequisites are a failed gate, never a silently skipped beta acceptance suite.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO } from "./helpers.mjs";

const commander = path.join(REPO, "mcp-commander");
if (!fs.existsSync(path.join(commander, "node_modules", ".bin", "tsc"))) {
  process.stderr.write("[installer tests] required mcp-commander dependencies are missing (see installer/README.md)\n");
  process.exit(1);
}
const npm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ["npm"];
const r = spawnSync(npm[0], [...npm.slice(1), "run", "build"], { cwd: commander, stdio: "inherit" });
process.exit(r.status ?? 1);
