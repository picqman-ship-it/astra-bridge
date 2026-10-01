// Test sandbox: a temporary HOME, a copy of the checkout, and fake launchctl / wrangler, so the
// installer runs end to end without touching the real ~/.astra-bridge, ~/Library/LaunchAgents,
// launchd or Cloudflare. mcp-commander and relay/node_modules are symlinked from this checkout
// (they must be installed and built: see installer/README.md).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pinBetaRelease } from "../pin-beta-release.mjs";
import { BETA_RELAY_ORIGIN } from "../lib/beta-trust.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKE_ACCOUNT = "0123456789abcdef0123456789abcdef";
export const AUD = "a".repeat(32) + "0123456789abcdef0123456789abcdef";

/** Unpinned trust template for disposable test releases, including tests of a pinned copy. */
export function writeTestTrustTemplate(file) {
  const source = fs.readFileSync(new URL("../lib/beta-trust.mjs", import.meta.url), "utf8");
  fs.writeFileSync(file, source.replace(`export const BETA_RELAY_ORIGIN = ${JSON.stringify(BETA_RELAY_ORIGIN)};`, "export const BETA_RELAY_ORIGIN = null;"));
}

export function tmpDir(prefix = "astra-installer-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Sources whose compiled output in mcp-commander/dist is missing or older than the source. */
export function staleCommanderBuild(commander = path.join(REPO, "mcp-commander")) {
  const src = path.join(commander, "src");
  const stale = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
        const built = fs.statSync(path.join(commander, "dist", path.relative(src, file)).replace(/\.ts$/, ".js"), { throwIfNoEntry: false });
        if (!built || built.mtimeMs < fs.statSync(file).mtimeMs) stale.push(path.relative(commander, file));
      }
    }
  };
  walk(src);
  return stale;
}

/**
 * The end-to-end tests run the installer against this checkout's compiled mcp-commander, which
 * every sandbox symlinks. Without dependencies they are skipped; a dist/ older than its sources
 * fails them (naming the fix) instead of silently testing an old build.
 */
export function prerequisitesBuilt() {
  if (!fs.existsSync(path.join(REPO, "mcp-commander", "dist", "remote", "setup.js")) || !fs.existsSync(path.join(REPO, "relay", "node_modules", "ws"))) return false;
  const stale = staleCommanderBuild();
  if (stale.length) {
    throw new Error(`mcp-commander/dist is older than its sources (${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}); run: (cd mcp-commander && npm run build)`);
  }
  return true;
}

const FAKE_LAUNCHCTL = `#!/bin/sh
# Records calls; keeps "loaded" state in $FAKE_STATE_DIR.
echo "launchctl $*" >> "$FAKE_STATE_DIR/calls.log"
case "$1" in
  print)
    if [ -f "$FAKE_STATE_DIR/print-error" ]; then echo 'Operation not permitted' >&2; exit 1; fi
    if [ -f "$FAKE_STATE_DIR/loaded" ]; then
      pid=$(cat "$FAKE_STATE_DIR/pid" 2>/dev/null || echo 4242)
      printf 'gui/501/x = {\\n\\tstate = running\\n\\tpid = %s\\n\\tlast exit code = (never exited)\\n}\\n' "$pid"
      exit 0
    fi
    echo "Could not find service" >&2; exit 113 ;;
  bootstrap)
    if [ -f "$FAKE_STATE_DIR/disabled" ]; then echo "Bootstrap failed: 119: Service is disabled" >&2; exit 119; fi
    if [ -f "$FAKE_STATE_DIR/loaded" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    touch "$FAKE_STATE_DIR/loaded"; exit 0 ;;
  bootout)
    if [ -f "$FAKE_STATE_DIR/bootout-error" ]; then echo 'Input/output error' >&2; exit 5; fi
    rm -f "$FAKE_STATE_DIR/loaded"; exit 0 ;;
  disable)
    if [ -f "$FAKE_STATE_DIR/disable-error" ]; then echo 'Operation not permitted' >&2; exit 1; fi
    touch "$FAKE_STATE_DIR/disabled"; exit 0 ;;
  enable)
    rm -f "$FAKE_STATE_DIR/disabled"; exit 0 ;;
  *) exit 0 ;;
esac
`;

const FAKE_WRANGLER = `#!/bin/sh
echo "wrangler $*" >> "$FAKE_STATE_DIR/calls.log"
echo "$1 account=\${CLOUDFLARE_ACCOUNT_ID-unset} env=\${CLOUDFLARE_ENV-unset}" >> "$FAKE_STATE_DIR/accounts.log"
case "$1" in
  whoami)
    if [ -f "$FAKE_STATE_DIR/logged-out" ]; then echo '{"loggedIn":false}'; exit 1; fi
    if [ -f "$FAKE_STATE_DIR/accounts.json" ]; then cat "$FAKE_STATE_DIR/accounts.json"; exit 0; fi
    echo '{"loggedIn":true,"authType":"OAuth Token","email":"owner@corp.test","accounts":[{"id":"${FAKE_ACCOUNT}","name":"Test"}]}' ;;
  deployments)
    if [ -f "$FAKE_STATE_DIR/lookup-error" ]; then echo 'not found: permission denied' >&2; exit 1; fi
    if [ -f "$FAKE_STATE_DIR/empty-deployments" ]; then echo '[]'; exit 0; fi
    if [ -f "$FAKE_STATE_DIR/worker-exists" ]; then echo '[{"id":"d1"}]'; exit 0; fi
    echo "X [ERROR] This Worker does not exist on your account. [code: 10007]" >&2; exit 1 ;;
  deploy)
    cfg="$3"
    case "$*" in *--dry-run*) echo "--dry-run: exiting now."; exit 0 ;; esac
    name=$(sed -n 's/^  "name": "\\(.*\\)",$/\\1/p' "$cfg")
    n=$(cat "$FAKE_STATE_DIR/deploys" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_STATE_DIR/deploys"
    cp "$cfg" "$FAKE_STATE_DIR/deployed-config.jsonc"
    printf 'Uploaded %s (1.00 sec)\\nDeployed %s triggers (0.50 sec)\\n  https://%s.example-sub.workers.dev\\n  schedule: */5 * * * *\\nCurrent Version ID: 00000000\\n' "$name" "$name" "$name" ;;
  login) exit 1 ;;
  *) exit 0 ;;
esac
`;

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (skip(e.name)) continue;
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

/** A fresh sandbox; call cleanup() when done. */
export function makeSandbox({ homeName = "home" } = {}) {
  const base = tmpDir();
  const home = path.join(base, homeName);
  const repo = path.join(base, "checkout");
  const state = path.join(base, "fake-state");
  const bin = path.join(base, "bin");
  for (const d of [home, repo, state, bin]) fs.mkdirSync(d, { recursive: true });

  copyDir(path.join(REPO, "installer"), path.join(repo, "installer"), (n) => n === "node_modules");
  // Also support testing an extracted, already-pinned release. Only the disposable
  // sandbox gets the fake-network pin; the source release trust anchor stays intact.
  writeTestTrustTemplate(path.join(repo, "installer", "lib", "beta-trust.mjs"));
  pinBetaRelease(repo, "https://astra-bridge-relay.example-sub.workers.dev");
  fs.copyFileSync(path.join(REPO, "install-macos.sh"), path.join(repo, "install-macos.sh"));
  fs.chmodSync(path.join(repo, "install-macos.sh"), 0o755);
  fs.copyFileSync(path.join(REPO, ".gitignore"), path.join(repo, ".gitignore"));
  const relay = path.join(repo, "relay");
  for (const d of ["src", "scripts", "templates"]) copyDir(path.join(REPO, "relay", d), path.join(relay, d));
  for (const f of ["wrangler.jsonc", "package.json", "package-lock.json", ".gitignore"]) fs.copyFileSync(path.join(REPO, "relay", f), path.join(relay, f));
  fs.symlinkSync(path.join(REPO, "relay", "node_modules"), path.join(relay, "node_modules"));
  fs.symlinkSync(path.join(REPO, "mcp-commander"), path.join(repo, "mcp-commander"));

  const launchctl = path.join(bin, "launchctl");
  const wrangler = path.join(bin, "wrangler");
  fs.writeFileSync(launchctl, FAKE_LAUNCHCTL, { mode: 0o755 });
  fs.writeFileSync(wrangler, FAKE_WRANGLER, { mode: 0o755 });

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
    ASTRA_LAUNCHCTL: launchctl,
    ASTRA_WRANGLER: wrangler,
    FAKE_STATE_DIR: state,
  };
  const sb = {
    base,
    home,
    repo,
    state,
    env,
    astraHome: path.join(home, ".astra-bridge"),
    remoteDir: path.join(home, ".mcp-commander-remote"),
    personal: path.join(relay, "wrangler.personal.jsonc"),
    plist: path.join(home, "Library", "LaunchAgents", "com.example.astra-bridge-agent.plist"),
    run(args, extraEnv = {}, { network = false } = {}) {
      const preload = network ? ["--import", pathToFileURL(path.join(repo, "installer", "test", "fake-network.mjs")).href] : [];
      const r = spawnSync(process.execPath, [...preload, path.join(repo, "installer", "astra-macos.mjs"), ...args], {
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        input: "",
        timeout: 120_000,
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    calls: () => (fs.existsSync(path.join(state, "calls.log")) ? fs.readFileSync(path.join(state, "calls.log"), "utf8") : ""),
    deploys: () => Number(fs.existsSync(path.join(state, "deploys")) ? fs.readFileSync(path.join(state, "deploys"), "utf8") : 0),
    flag: (name, on = true) => (on ? fs.writeFileSync(path.join(state, name), "") : fs.rmSync(path.join(state, name), { force: true })),
    /** What launchd does at the next login: load our LaunchAgent unless its label is disabled. */
    login() {
      if (fs.existsSync(sb.plist) && !fs.existsSync(path.join(state, "disabled"))) fs.writeFileSync(path.join(state, "loaded"), "");
      return fs.existsSync(path.join(state, "loaded"));
    },
    loaded: () => fs.existsSync(path.join(state, "loaded")),
    disabled: () => fs.existsSync(path.join(state, "disabled")),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
  return sb;
}
