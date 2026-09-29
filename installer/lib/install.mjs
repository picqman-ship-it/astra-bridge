// The guided install. Each step looks at the real state first (files, launchd, Cloudflare) and
// only does what is missing, so re-running continues where the last run stopped. Steps that only
// the user can do (browser login, dashboard settings) end the run at a checkpoint (exit 3) with
// exact instructions; running ./install-macos.sh again resumes.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeLaunchctl } from "./context.mjs";
import { describeMode, loadCommanderConfig, protectsCheckout, runSetup, updateCommanderConfig } from "./commander.mjs";
import { axHelperPath, buildCommander, commanderBuildReason, installReason, npmCi } from "./deps.mjs";
import { parseJsonc } from "./jsonc.mjs";
import { KEY_FILES, fingerprint, inspectKeys, keyPresence } from "./keys.mjs";
import { conflicts, createLaunchd, findOtherAgents } from "./launchd.mjs";
import { stableNodePath } from "./node-path.mjs";
import { blockers, checkPrereqs } from "./prereqs.mjs";
import { probeAccess, probeAgentStatus, probeHealth } from "./relay-probe.mjs";
import { deployHash, readState, writeState } from "./state.mjs";
import { Checkpoint, InstallerError, expandHome, run, runInherit, runTee, shQuote, sleep } from "./util.mjs";
import { normalizeRelayUrl, normalizeTeamDomain, validateDeviceId, validateEmail, validatePolicyAud, validateWorkerName } from "./validate.mjs";
import { applyUpdates, interpret, readPersonalConfig, writePersonalConfig } from "./wrangler-config.mjs";

const TOTAL = 9;
const DEFAULT_WORKER = "astra-bridge-relay";

export const SECURITY_BANNER = [
  "Astra Bridge gives an AI client remote access to this Mac through your own Cloudflare account.",
  "In the default file-only mode it can read and change files in ONE workspace folder. With terminal",
  "tools it can run any command as you. Prompt injection in content the AI reads can steer it.",
  "Read SECURITY.md. Single owner only; never share the connector.",
];

function printChecks(ui, checks) {
  for (const c of checks) {
    const line = `${c.name}: ${c.detail}`;
    if (c.level === "pass") ui.ok(line);
    else if (c.level === "warn") ui.warn(line);
    else ui.fail(line);
    for (const f of c.fix ?? []) ui.info(`    ${f}`);
  }
}

function tail(text, n = 15) {
  return String(text ?? "").trim().split("\n").slice(-n).join("\n");
}

function wranglerEnv(ctx, s) {
  return s.accountId ? { ...ctx.childEnv, CLOUDFLARE_ACCOUNT_ID: s.accountId } : ctx.childEnv;
}

// ---------------------------------------------------------------------------------------------

async function preflight(ctx, opts, ui, s) {
  ui.heading(`1/${TOTAL} Checking this Mac`);
  let rawCommander = null;
  try {
    rawCommander = JSON.parse(fs.readFileSync(ctx.remoteConfigFile, "utf8"));
  } catch {}
  s.needGui = Boolean(opts.enableGui || (!opts.fileOnly && rawCommander?.trustedGui === true));
  const checks = checkPrereqs(ctx, { needGui: s.needGui });
  printChecks(ui, checks);
  if (blockers(checks).length) {
    throw new InstallerError("prerequisites are missing", { hint: "Fix the items marked ✗ above (nothing was installed or changed), then re-run ./install-macos.sh" });
  }
}

async function dependencies(ctx, opts, ui, s) {
  ui.heading(`2/${TOTAL} Dependencies and build`);
  if (opts.skipDeps) {
    ui.warn("skipped (--skip-deps); using what is already installed");
    if (!fs.existsSync(ctx.commanderEntry)) throw new InstallerError(`${ctx.commanderEntry} is missing`, { hint: "Run without --skip-deps." });
    if (!fs.existsSync(path.join(ctx.relayDir, "node_modules", "ws"))) throw new InstallerError("relay dependencies are missing", { hint: "Run without --skip-deps." });
    return;
  }
  for (const [name, dir] of [["mcp-commander", ctx.commanderDir], ["relay", ctx.relayDir]]) {
    const reason = installReason(dir);
    if (!reason) {
      ui.ok(`${name}: dependencies match package-lock.json`);
      continue;
    }
    ui.info(`${name}: ${reason}; running npm ci (exact versions from package-lock.json) …`);
    ui.release();
    if (!npmCi(ctx, dir)) {
      throw new InstallerError(`npm ci failed in ${name}/`, { hint: "See npm's output above (often a network problem). Fix it and re-run ./install-macos.sh" });
    }
    ui.ok(`${name}: dependencies installed`);
  }
  const reason = commanderBuildReason(ctx.commanderDir, { needGui: s.needGui });
  if (reason) {
    ui.info(`mcp-commander: ${reason}; running npm run build …`);
    ui.release();
    if (!buildCommander(ctx)) throw new InstallerError("mcp-commander build failed", { hint: "See the compiler output above." });
  }
  ui.ok("mcp-commander: built");
  if (s.needGui && !fs.existsSync(axHelperPath(ctx.commanderDir))) {
    throw new InstallerError("the GUI (Accessibility) helper could not be built", { hint: "Install the Xcode Command Line Tools (xcode-select --install), then re-run." });
  }
}

async function confirmRiskyModes(ui, { terminal, gui }) {
  const lines = ["You are enabling tools that reach beyond the workspace folder:"];
  if (terminal) {
    lines.push("TERMINAL: the AI client can run ANY command as your macOS user: read your SSH keys, browser");
    lines.push("  data and documents, install software, delete files. The workspace no longer contains it.");
  }
  if (gui) {
    lines.push("GUI: the AI client can read and operate the windows of your apps through Accessibility.");
    lines.push("  You must also grant Accessibility to Node in System Settings.");
  }
  lines.push("Anyone who controls your Access login, Cloudflare account or client key gets the same.");
  lines.push("Prompt injection in web pages, emails or documents the AI reads can trigger these tools.");
  ui.danger(lines);
  if (!ui.interactive) return; // the explicit --enable-* flag is the consent in non-interactive mode
  if (!(await ui.typed("Enable these tools?", "enable"))) {
    throw new InstallerError("not enabled; nothing was changed", { hint: "Re-run without --enable-terminal / --enable-gui to stay in file-only mode." });
  }
}

async function workspace(ctx, opts, ui, s) {
  ui.heading(`3/${TOTAL} Workspace folder and access mode`);
  const wantTerminal = opts.enableTerminal ? true : opts.fileOnly ? false : undefined;
  const wantGui = opts.enableGui ? true : opts.fileOnly ? false : undefined;
  let existing = await loadCommanderConfig(ctx);

  if (!existing.exists || opts.reconfigure) {
    const current = existing.raw?.roots?.[0];
    const chosen = opts.workspace ?? (ui.interactive
      ? await ui.ask("Workspace folder the AI may use (a dedicated, empty-ish folder)", { defaultValue: current ?? ctx.defaultWorkspace })
      : current ?? ctx.defaultWorkspace);
    const ws = path.resolve(expandHome(chosen, ctx.home));
    if (/[:\n\r]/.test(ws)) throw new InstallerError(`workspace ${ws} must not contain ':' or newlines`);
    const terminal = wantTerminal ?? false;
    const gui = wantGui ?? false;
    if (terminal || gui) await confirmRiskyModes(ui, { terminal, gui });
    if (existing.exists && !(await ui.confirm(`Replace ${ctx.remoteConfigFile} (a backup is kept)?`, { what: "replace remote.json (--reconfigure)" }))) {
      throw new Checkpoint("remote.json was not replaced");
    }
    // mcp-commander only accepts an existing folder. Remember what we create, so a folder it
    // then refuses (home, ~/.ssh/x, inside this checkout, ...) is removed again.
    const createdDirs = [];
    for (let d = ws; !fs.existsSync(d); d = path.dirname(d)) createdDirs.push(d);
    if (createdDirs.length) fs.mkdirSync(ws, { recursive: true, mode: 0o700 });
    if (existing.exists) {
      const backup = `${ctx.remoteConfigFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(ctx.remoteConfigFile, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
      ui.info(`backup: ${backup}`);
    }
    const r = runSetup(ctx, { workspace: ws, terminal, gui, replace: existing.exists });
    if (r.status !== 0) {
      for (const d of createdDirs) {
        try { fs.rmdirSync(d); } catch { break; } // only ever removes the empty folders it made
      }
      throw new InstallerError(`mcp-commander refused this configuration:\n   ${tail(r.stderr || r.stdout, 5)}`, {
        hint: "Pick a dedicated folder (not your home folder, not inside this checkout, ~/.ssh, ~/Library/LaunchAgents or ~/.astra-bridge) and re-run with --workspace <dir>.",
      });
    }
    s.modeChanged = existing.exists;
  } else {
    if (existing.error) {
      throw new InstallerError(`${ctx.remoteConfigFile} is not valid: ${existing.error}`, {
        hint: "Fix it by hand, or re-run with --reconfigure [--workspace <dir>] to replace it (the old file is backed up).",
      });
    }
    if (opts.workspace) {
      const asked = path.resolve(expandHome(opts.workspace, ctx.home));
      const want = fs.existsSync(asked) ? fs.realpathSync.native(asked) : null;
      if (!want || !existing.cfg.roots.includes(want)) {
        throw new InstallerError(`remote.json already uses ${existing.cfg.roots.join(", ")}`, { hint: "To switch folders re-run with --reconfigure --workspace <dir>." });
      }
    }
    const change = {};
    if (wantTerminal !== undefined && wantTerminal !== existing.cfg.trustedTerminal) change.terminal = wantTerminal;
    if (wantGui !== undefined && wantGui !== existing.cfg.trustedGui) change.gui = wantGui;
    if (!protectsCheckout(ctx, existing.raw)) change.protect = [ctx.repoDir];
    if (change.terminal || change.gui) await confirmRiskyModes(ui, { terminal: change.terminal, gui: change.gui });
    if (Object.keys(change).length) {
      try {
        await updateCommanderConfig(ctx, existing.raw, change);
      } catch (err) {
        throw new InstallerError(`could not update remote.json: ${err.message}`, {
          hint: change.protect ? "A configured root overlaps this checkout. Re-run with --reconfigure --workspace <dedicated dir>." : undefined,
        });
      }
      if (change.protect) ui.ok(`protected this checkout in remote.json (${ctx.repoDir})`);
      if ("terminal" in change || "gui" in change) s.modeChanged = true;
    }
  }

  existing = await loadCommanderConfig(ctx);
  if (!existing.cfg) throw new InstallerError(`remote.json does not validate: ${existing.error}`);
  s.commander = existing.cfg;
  ui.ok(`config: ${ctx.remoteConfigFile} (0600)`);
  ui.ok(`workspace: ${existing.cfg.roots.join(", ")}`);
  const risky = existing.cfg.trustedTerminal || existing.cfg.trustedGui;
  (risky ? ui.warn : ui.ok)(`mode: ${describeMode(existing.cfg)}`);
  if (!risky) ui.info("Terminal and GUI tools are off. Enable them later only if needed: ./install-macos.sh --enable-terminal / --enable-gui");
  if (existing.cfg.trustedGui) {
    ui.info("GUI tools need Accessibility permission: System Settings → Privacy & Security → Accessibility → allow");
    ui.info(`the Node binary the agent runs (macOS asks the first time a GUI tool is used).`);
  }
}

async function keys(ctx, opts, ui, s) {
  ui.heading(`4/${TOTAL} Keys`);
  const presence = keyPresence(ctx.astraHome);
  if (presence === "partial") {
    throw new InstallerError(`only one of ${KEY_FILES.agent} / ${KEY_FILES.client} exists in ${ctx.astraHome}`, {
      hint: "Move the remaining .pem somewhere safe (do not just delete it), then re-run to create a fresh pair. The installer redeploys the relay with the new public keys.",
    });
  }
  if (presence === "none") {
    const r = run(ctx.execPath, [ctx.keygen, "--dir", ctx.astraHome], { env: ctx.childEnv });
    if (r.status !== 0) throw new InstallerError(`keygen failed: ${tail(r.stderr, 5)}`);
    ui.ok(`created two Ed25519 key pairs in ${ctx.astraHome} (directory 0700, private keys 0600)`);
  }
  const k = inspectKeys(ctx.astraHome);
  const problems = [...k.dir.problems, ...k.agent.problems, ...k.client.problems];
  if (problems.length) throw new InstallerError(problems.join("\n   "), { hint: "Fix the permissions as shown, then re-run." });
  s.keys = { agent: k.agent.publicKeyB64, client: k.client.publicKeyB64 };
  ui.ok(`agent key …${fingerprint(s.keys.agent)}, client key …${fingerprint(s.keys.client)} (private keys stay in ${ctx.astraHome}; never shown)`);
}

function assertIgnoredByGit(ctx) {
  if (!fs.existsSync(path.join(ctx.repoDir, ".git"))) return;
  const sel = run("/usr/bin/xcode-select", ["-p"]);
  if (sel.status !== 0) return; // /usr/bin/git would pop up the developer-tools installer
  const r = run("/usr/bin/git", ["-C", ctx.repoDir, "check-ignore", "-q", path.relative(ctx.repoDir, ctx.personalConfig)]);
  if (r.status === 1) {
    throw new InstallerError(`${ctx.personalConfig} is not ignored by git`, { hint: "Restore relay/.gitignore (it must list wrangler.personal.jsonc) so your email and device id are never committed." });
  }
}

async function personalConfig(ctx, opts, ui, s) {
  ui.heading(`5/${TOTAL} Personal Cloudflare config (relay/wrangler.personal.jsonc)`);
  assertIgnoredByGit(ctx);
  const existing = readPersonalConfig(ctx.personalConfig);
  if (existing.error) throw new InstallerError(existing.error, { hint: "Fix the file, or move it away so the installer starts again from the template." });
  const created = !existing.exists;
  const text = created ? fs.readFileSync(ctx.templateConfig, "utf8") : existing.text;
  const cur = created ? interpret(parseJsonc(text)) : existing;
  const v = cur.values;

  const updates = {};
  const changes = [];
  const note = (field, from, to) => changes.push(`${field}: ${from ?? "(template placeholder)"} → ${to}`);

  for (const [field, key] of [["agentKey", "AGENT_PUBLIC_KEY_B64"], ["clientKey", "CLIENT_PUBLIC_KEY_B64"]]) {
    const onDisk = s.keys[field === "agentKey" ? "agent" : "client"];
    if (v[field] !== onDisk) {
      updates[field] = onDisk;
      note(key, v[field] ? `…${fingerprint(v[field])}` : null, `…${fingerprint(onDisk)} (this Mac's key)`);
    }
  }

  let deviceId = opts.deviceId ? validateDeviceId(opts.deviceId) : v.deviceId;
  if (created && !opts.deviceId && ui.interactive) {
    deviceId = await ui.ask("Device id for this Mac", { defaultValue: v.deviceId ?? "my-mac", validate: validateDeviceId });
  }
  deviceId ??= "my-mac";
  if (deviceId !== v.deviceId || cur.problems.some((p) => p.includes("DEVICE_ID"))) {
    updates.deviceId = deviceId;
    note("device id", v.deviceId, deviceId);
  }

  const workerName = opts.workerName ? validateWorkerName(opts.workerName) : v.workerName ?? DEFAULT_WORKER;
  if (workerName !== v.workerName) {
    updates.workerName = workerName;
    note("worker name", v.workerName, workerName);
  }

  let email = opts.email ? validateEmail(opts.email) : v.email;
  if (!email) {
    ui.info("Cloudflare Access will let exactly one identity in: yours. The Worker checks it a second time.");
    email = await ui.ask("Your email address (the one you log in to Cloudflare Access with)", { flag: "--email", validate: validateEmail });
  }
  if (email !== v.email) {
    updates.email = email;
    note("ACCESS_ALLOWED_EMAILS", v.email, email);
  }

  if (opts.relayUrl) {
    const url = normalizeRelayUrl(opts.relayUrl);
    if (url !== v.relayUrl) {
      updates.relayUrl = url;
      note("relay URL", v.relayUrl, url);
    }
  }
  if (opts.teamDomain) {
    const t = normalizeTeamDomain(opts.teamDomain);
    if (t !== v.teamDomain) {
      updates.teamDomain = t;
      note("TEAM_DOMAIN", v.teamDomain, t);
    }
  }
  if (opts.policyAud) {
    const a = validatePolicyAud(opts.policyAud);
    if (a !== v.policyAud) {
      updates.policyAud = a;
      note("POLICY_AUD", v.policyAud ? "(previous tag)" : null, "(new tag)");
    }
  }

  const next = Object.keys(updates).length ? applyUpdates(text, updates) : text;
  if (created || next !== text) {
    writePersonalConfig(ctx.personalConfig, next);
    ui.ok(`${created ? "created" : "updated"} ${ctx.personalConfig} (0600, gitignored)`);
    for (const c of changes) ui.info(c);
  } else {
    ui.ok(`${ctx.personalConfig} is up to date`);
  }
  s.personal = interpret(parseJsonc(next));
  if (s.personal.problems.length) for (const p of s.personal.problems) ui.warn(p);
  if (s.personal.values.authMode !== "access") {
    ui.warn(`MCP_AUTH_MODE is "${s.personal.values.authMode}"; the guided setup covers Access mode only, so the Access step is skipped`);
  }
}

function parseWhoami(stdout) {
  try {
    const data = JSON.parse(stdout.slice(stdout.indexOf("{")));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

async function cloudflareLogin(ctx, opts, ui, s) {
  ui.heading(`6/${TOTAL} Cloudflare login`);
  if (opts.skipCloudflare) return ui.warn("skipped (--skip-cloudflare)");
  if (!fs.existsSync(ctx.wrangler)) throw new InstallerError(`wrangler not found at ${ctx.wrangler}`, { hint: "Run without --skip-deps so the relay dependencies are installed." });
  const whoami = () => run(ctx.wrangler, ["whoami", "--json"], { cwd: ctx.relayDir, env: ctx.childEnv, timeoutMs: 60_000 });
  let r = whoami();
  if (r.status !== 0) {
    const instructions = [
      "Log in to Cloudflare (opens your browser; approve the access wrangler asks for):",
      "  cd relay && npx wrangler login && cd ..",
      "Then re-run ./install-macos.sh",
      "No Cloudflare account yet? Create one at https://dash.cloudflare.com/sign-up (the Free plan is enough).",
    ];
    if (!ui.interactive) throw new Checkpoint("you are not logged in to Cloudflare", { instructions });
    if (!(await ui.confirm("Not logged in to Cloudflare. Open the login in your browser now (wrangler login)?"))) {
      throw new Checkpoint("you are not logged in to Cloudflare", { instructions });
    }
    ui.release();
    runInherit(ctx.wrangler, ["login"], { cwd: ctx.relayDir, env: ctx.childEnv });
    r = whoami();
    if (r.status !== 0) throw new Checkpoint("the Cloudflare login did not complete", { instructions });
  }
  const who = parseWhoami(r.stdout);
  const accounts = Array.isArray(who?.accounts) ? who.accounts.filter((a) => a && typeof a.id === "string") : [];
  ui.ok(`logged in${who?.email ? ` as ${who.email}` : ""}${accounts.length ? `, ${accounts.length} account(s)` : ""}`);

  const state = readState(ctx);
  s.accountId = opts.accountId ?? ctx.env.CLOUDFLARE_ACCOUNT_ID ?? state.accountId ?? null;
  if (!s.accountId && accounts.length > 1) {
    if (!ui.interactive) {
      throw new Checkpoint("your Cloudflare login has several accounts", {
        instructions: [...accounts.map((a) => `  ${a.id}  ${a.name ?? ""}`), "Re-run with --account-id <id> to choose one."],
      });
    }
    accounts.forEach((a, i) => ui.info(`${i + 1}. ${a.name ?? a.id} (${a.id})`));
    const pick = await ui.ask("Deploy to which account (number)", {
      validate: (x) => {
        const n = Number(x);
        if (!Number.isInteger(n) || n < 1 || n > accounts.length) throw new Error(`enter 1-${accounts.length}`);
        return accounts[n - 1].id;
      },
    });
    s.accountId = pick;
  }
  if (s.accountId && s.accountId !== state.accountId) writeState(ctx, { accountId: s.accountId });
}

/** 'yes' | 'no' | 'unknown': whether a Worker with this name already exists in the account. */
function workerExists(ctx, s, name) {
  const r = run(ctx.wrangler, ["deployments", "list", "--name", name, "--json"], { cwd: ctx.relayDir, env: wranglerEnv(ctx, s), timeoutMs: 60_000 });
  if (r.status === 0) {
    try {
      const list = JSON.parse(r.stdout.slice(r.stdout.search(/[[{]/)));
      return Array.isArray(list) && list.length > 0 ? "yes" : "no";
    } catch {
      return "unknown";
    }
  }
  return /10007|does not exist|not found/i.test(`${r.stdout}${r.stderr}`) ? "no" : "unknown";
}

export function parseDeployUrl(output, workerName) {
  const escaped = workerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`https://${escaped}\\.([a-z0-9-]+)\\.workers\\.dev\\b`).exec(output);
  return m ? `https://${workerName}.${m[1]}.workers.dev` : null;
}

async function deploy(ctx, opts, ui, s, { reason } = {}) {
  const values = s.personal.values;
  const state = readState(ctx);
  const hash = deployHash(ctx);
  if (!reason && state.deploy?.hash === hash && state.deploy?.worker === values.workerName && !opts.redeploy) {
    s.relayUrl = values.relayUrl ?? state.deploy.url;
    ui.ok(`"${values.workerName}" is deployed and unchanged since ${state.deploy.at}`);
    return;
  }
  if (state.deploy?.worker !== values.workerName) {
    const exists = workerExists(ctx, s, values.workerName);
    if (exists !== "no" && !opts.replaceExistingWorker) {
      ui.warn(exists === "yes"
        ? `A Worker named "${values.workerName}" already exists in your Cloudflare account and was not deployed by this installer on this Mac.`
        : `Could not check whether a Worker named "${values.workerName}" already exists.`);
      ui.info("Deploying replaces its code and settings. If it is a relay you set up elsewhere, stop and use that setup instead.");
      const instructions = [
        `Deploy a separate relay: ./install-macos.sh --worker-name <another-name>`,
        `Or replace "${values.workerName}": ./install-macos.sh --replace-existing-worker`,
      ];
      if (!ui.interactive || !(await ui.typed(`Replace "${values.workerName}"?`, values.workerName))) {
        throw new Checkpoint(`not replacing the existing Worker "${values.workerName}"`, { instructions });
      }
    }
  }
  if (!(await ui.confirm(`Deploy "${values.workerName}" to your Cloudflare account now${reason ? ` (${reason})` : ""}?`, { what: "deploy the relay Worker" }))) {
    throw new Checkpoint("the relay was not deployed", { instructions: ["Re-run ./install-macos.sh when you are ready."] });
  }
  const env = wranglerEnv(ctx, s);
  const dry = run(ctx.wrangler, ["deploy", "-c", ctx.personalConfig, "--dry-run"], { cwd: ctx.relayDir, env, timeoutMs: 180_000 });
  if (dry.status !== 0) throw new InstallerError(`wrangler deploy --dry-run failed:\n${tail(dry.stdout + dry.stderr)}`);
  ui.info("running wrangler deploy …");
  ui.release();
  const r = await runTee(ctx.wrangler, ["deploy", "-c", ctx.personalConfig], { cwd: ctx.relayDir, env });
  if (r.status !== 0) {
    if (/workers\.dev subdomain/i.test(r.output)) {
      throw new Checkpoint("your Cloudflare account has no workers.dev subdomain yet", {
        instructions: ["Open https://dash.cloudflare.com → Workers & Pages and choose a workers.dev subdomain (one time),", "then re-run ./install-macos.sh"],
      });
    }
    throw new InstallerError("wrangler deploy failed", { hint: "See wrangler's output above, fix the cause and re-run." });
  }
  const printed = parseDeployUrl(r.output, values.workerName);
  let url;
  if (values.relayUrl && !values.relayUrl.endsWith(".workers.dev")) url = values.relayUrl; // custom domain: keep
  else url = printed ?? values.relayUrl;
  if (!url) {
    url = await ui.ask("Relay URL (the https://… address wrangler printed above)", { flag: "--relay-url", validate: normalizeRelayUrl });
  }
  writeState(ctx, { deploy: { worker: values.workerName, hash, at: new Date().toISOString(), url } });
  if (url !== values.relayUrl) {
    writePersonalConfig(ctx.personalConfig, applyUpdates(fs.readFileSync(ctx.personalConfig, "utf8"), { relayUrl: url }));
    s.personal = readPersonalConfig(ctx.personalConfig);
    ui.info(`recorded the relay URL ${url} in the personal config`);
  }
  s.relayUrl = url;
  ui.ok(`deployed ${url}`);
}

async function deployStep(ctx, opts, ui, s) {
  ui.heading(`7/${TOTAL} Relay Worker`);
  if (opts.skipCloudflare) {
    s.relayUrl = s.personal.values.relayUrl ?? readState(ctx).deploy?.url ?? null;
    return ui.warn("skipped (--skip-cloudflare)");
  }
  await deploy(ctx, opts, ui, s);
  if (opts.noNetworkChecks) return ui.warn("health check skipped (--no-network-checks)");
  let h;
  for (let i = 0; i < 20; i++) {
    h = await probeHealth(s.relayUrl);
    if (h.ok) break;
    if (i === 0) ui.info("waiting for the Worker to become reachable (a new workers.dev subdomain can take a minute) …");
    await sleep(3000);
  }
  if (h.ok) ui.ok(`${s.relayUrl}/healthz answers`);
  else ui.warn(`${s.relayUrl}/healthz is not reachable yet (${h.error}); the agent keeps retrying. Check later with ./install-macos.sh doctor`);
}

function stripAstraEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("ASTRA_")));
}

async function agent(ctx, opts, ui, s) {
  ui.heading(`8/${TOTAL} Mac agent (LaunchAgent)`);
  const relayUrl = s.relayUrl ?? s.personal.values.relayUrl;
  if (!relayUrl) {
    throw new Checkpoint("the relay URL is not known yet, so the agent cannot be configured", {
      instructions: ["Deploy the relay first (re-run without --skip-cloudflare), or pass --relay-url https://<worker>.<subdomain>.workers.dev"],
    });
  }
  assertSafeLaunchctl(ctx);
  const deviceId = s.personal.values.deviceId;
  const node = stableNodePath(ctx.execPath, { pathEnv: ctx.env.PATH ?? "" });
  const { readTemplate, renderPlist, resolveValues } = await import(pathToFileURL(ctx.installAgent).href);
  const flags = { relayUrl, deviceId, node: node.path };
  if (ctx.customAstraHome) flags.astraHome = ctx.astraHome;
  if (ctx.customRemoteDir) flags.commanderRemoteDir = ctx.commanderRemoteDir;
  const { text: template, label } = readTemplate();
  let resolved;
  try {
    // Only the flags above: ASTRA_* variables from your shell must not change the plist.
    resolved = resolveValues(flags, {}, ctx.home);
  } catch (err) {
    throw new InstallerError(`cannot build the LaunchAgent: ${err.message}`);
  }
  for (const w of resolved.warnings) ui.warn(w);
  const plist = renderPlist(template, resolved.values);
  const plistFile = path.join(ctx.launchAgentsDir, `${label}.plist`);
  const current = fs.existsSync(plistFile) ? fs.readFileSync(plistFile, "utf8") : null;
  const launchd = createLaunchd({ launchctl: ctx.launchctl, uid: ctx.uid, label });
  const st = launchd.status();

  for (const other of findOtherAgents(ctx.launchAgentsDir, label)) {
    const stopIt = [`  launchctl bootout gui/${ctx.uid}/${other.label}`, `  mv ${shQuote(other.file)} ~/Desktop/    (keeps it from starting at login; nothing is deleted)`];
    if (conflicts(other, relayUrl, deviceId)) {
      // Not touched by the installer: it is not ours. Two agents would keep replacing each
      // other's connection to the relay, so stop here instead of making it worse.
      throw new Checkpoint(`another LaunchAgent (${other.label}) already runs an agent for device "${deviceId}" on this relay`, {
        instructions: ["Two agents for one device keep replacing each other's connection. If it is an older install, stop it:", ...stopIt, "then re-run ./install-macos.sh"],
      });
    }
    ui.warn(`another Astra Bridge LaunchAgent is installed: ${other.label} (${other.file}, device ${other.deviceId ?? "?"}); it uses a different relay or device, so it is left alone`);
  }

  // A redeployed Worker does not need an agent restart: the agent reconnects by itself.
  const upToDate = current === plist && st.loaded && st.state === "running" && !s.modeChanged;
  if (upToDate) {
    ui.ok(`agent running (pid ${st.pid ?? "?"}), ${plistFile} up to date`);
  } else {
    ui.info(`LaunchAgent: ${plistFile}${current === null ? " (new)" : current === plist ? "" : " (will be replaced)"}`);
    ui.info(`Node:       ${node.path}${node.note ? ` — ${node.note}` : ""}`);
    ui.info(`agent:      ${ctx.agentPath}`);
    ui.info(`relay:      ${relayUrl}   device: ${deviceId}`);
    ui.info(`logs:       ${path.join(ctx.astraHome, "agent.stderr.log")}`);
    if (!node.stable) ui.warn(node.note);
    const question = current === null
      ? "Install the LaunchAgent and start the agent now? (it then starts automatically at every login)"
      : "Update/restart the agent now?";
    if (!(await ui.confirm(question, { what: "install and start the Mac agent" }))) {
      throw new Checkpoint("the agent was not installed or restarted", { instructions: ["Nothing was written. Re-run ./install-macos.sh when you are ready."] });
    }
    if (current !== plist) {
      const args = [ctx.installAgent, "--install", "--relay-url", relayUrl, "--device-id", deviceId, "--node", node.path];
      if (flags.astraHome) args.push("--astra-home", flags.astraHome);
      if (flags.commanderRemoteDir) args.push("--commander-remote-dir", flags.commanderRemoteDir);
      if (current !== null) args.push("--force");
      const r = run(ctx.execPath, args, { env: stripAstraEnv(ctx.childEnv) });
      if (r.status !== 0) throw new InstallerError(`install-agent refused: ${tail(r.stderr, 6)}`);
      if (fs.readFileSync(plistFile, "utf8") !== plist) throw new InstallerError("the written LaunchAgent differs from the preview; not loading it");
      ui.ok(`wrote ${plistFile}`);
    }
    if (st.loaded) {
      launchd.bootout();
      if (!(await launchd.waitUnloaded())) throw new InstallerError("the previous agent did not stop within 15 s", { hint: `Try: launchctl bootout ${launchd.target}` });
    }
    launchd.enable();
    const b = launchd.bootstrap(plistFile);
    if (b.status !== 0) throw new InstallerError(`launchctl bootstrap failed: ${tail(b.stderr || b.stdout, 3)}`, { hint: `Run ./install-macos.sh doctor for details.` });
    const now = await launchd.waitRunning();
    if (now.state === "running") ui.ok(`agent started (pid ${now.pid ?? "?"})`);
    else ui.warn(`agent is loaded but not running (state ${now.state ?? "?"}, last exit ${now.lastExitCode ?? "?"}); see ${path.join(ctx.astraHome, "agent.stderr.log")}`);
  }

  if (opts.noNetworkChecks || opts.skipCloudflare) return ui.warn("relay connection not checked (network checks skipped)");
  const clientKey = path.join(ctx.astraHome, KEY_FILES.client);
  let status;
  for (let i = 0; i < 15; i++) {
    status = await probeAgentStatus(relayUrl, deviceId, clientKey);
    if (status.ok && status.agentConnected) break;
    if (status.status === 401 || status.status === 403) break;
    if (i === 0) ui.info("waiting for the agent to connect to the relay …");
    await sleep(3000);
  }
  if (status.ok && status.agentConnected) ui.ok("the relay reports the agent connected and mcp-commander healthy");
  else if (status.status === 401 || status.status === 403) {
    ui.warn(`the relay rejected this Mac's signed request (${status.error}): the deployed Worker has other public keys or another device id. Re-run with --redeploy.`);
  } else {
    ui.warn(`the relay does not report the agent connected yet (${status.ok ? `mcpHealthy=${status.mcpHealthy}` : status.error}). Check: ./install-macos.sh doctor`);
  }
}

function accessInstructions({ host, email }) {
  return [
    "Cloudflare Access puts your login in front of /mcp. It is set up in the Cloudflare dashboard;",
    "the installer cannot do it for you (labels in the dashboard change over time; the settings do not):",
    "",
    " 1. https://one.dash.cloudflare.com → Settings → Team name and domain: note <team>.cloudflareaccess.com.",
    "    Settings → Authentication → Login methods: have One-time PIN or your identity provider enabled.",
    " 2. Access → Applications → Add an application → Self-hosted:",
    `      Public hostname: ${host}    Path: mcp    (only /mcp; /healthz and /v1/device/* stay public)`,
    `      Policy: Allow → Include → Emails → ${email}   (press Enter so it is added; nothing else)`,
    "      Session duration: 24 hours or less.",
    " 3. In the application's Advanced settings turn on Managed OAuth:",
    "      Allowed redirect URLs: https://chatgpt.com/connector/oauth/*   Localhost/loopback: off",
    "      Access token lifetime: short (for example 10 minutes).",
    " 4. Save, then copy the Application Audience (AUD) Tag from the application's overview.",
    "Full walkthrough: relay/docs/SETUP-ACCESS.md",
  ];
}

async function access(ctx, opts, ui, s) {
  ui.heading(`9/${TOTAL} Cloudflare Access for /mcp`);
  if (opts.skipCloudflare) return ui.warn("skipped (--skip-cloudflare); Access is NOT verified");
  const v = s.personal.values;
  if (v.authMode !== "access") return ui.warn("skipped: MCP_AUTH_MODE is not \"access\"; Access is NOT verified");
  const host = new URL(s.relayUrl).hostname;

  if (!s.personal.accessConfigured) {
    const instructions = accessInstructions({ host, email: v.email });
    for (const l of instructions) ui.info(l);
    const resume = "./install-macos.sh --team-domain https://<team>.cloudflareaccess.com --policy-aud <AUD tag>";
    if (!ui.interactive) throw new Checkpoint("Cloudflare Access is not configured yet", { instructions: ["Do the dashboard steps above, then run:", `  ${resume}`] });
    ui.write("");
    ui.info("When you have done that, enter the two values (or press Ctrl-C to stop and resume later).");
    const teamDomain = await ui.ask("Team domain", { validate: normalizeTeamDomain });
    const policyAud = await ui.ask("Application Audience (AUD) tag", { validate: validatePolicyAud });
    writePersonalConfig(ctx.personalConfig, applyUpdates(fs.readFileSync(ctx.personalConfig, "utf8"), { teamDomain, policyAud }));
    s.personal = readPersonalConfig(ctx.personalConfig);
    ui.ok("saved TEAM_DOMAIN and POLICY_AUD in the personal config");
    await deploy(ctx, opts, ui, s, { reason: "with the Access settings" });
  }

  if (opts.noNetworkChecks) return ui.warn("Access is NOT verified (--no-network-checks)");
  const expectedTeamHost = new URL(s.personal.values.teamDomain).hostname;
  let result;
  for (let i = 0; i < 8; i++) {
    result = await probeAccess(s.relayUrl, { expectedTeamHost });
    if (result.state === "verified") break;
    await sleep(3000);
  }
  if (result.state === "verified") {
    ui.ok(`verified: ${result.detail}`);
    ui.info(`Not verifiable from here: that your Access policy admits only ${v.email}. Check it in the dashboard;`);
    ui.info("the Worker also refuses every other identity (ACCESS_ALLOWED_EMAILS).");
    s.accessVerified = true;
    return;
  }
  const fix = {
    "not-configured": ["The deployed Worker does not have TEAM_DOMAIN / POLICY_AUD yet. Run: ./install-macos.sh --redeploy"],
    "not-protected": accessInstructions({ host, email: v.email }),
    "no-managed-oauth": ["Zero Trust → Access → Applications → your app → Advanced settings → turn on Managed OAuth, save, then re-run."],
    "wrong-team": ["TEAM_DOMAIN does not match the team protecting /mcp. Re-run with --team-domain <the right team>."],
  }[result.state] ?? ["Re-run ./install-macos.sh (or ./install-macos.sh doctor) in a minute."];
  throw new Checkpoint(`Access is not verified: ${result.detail}`, { instructions: fix });
}

function finish(ctx, opts, ui, s) {
  ui.heading("Setup complete");
  ui.ok(`relay: ${s.relayUrl}`);
  ui.info("Connect ChatGPT (done in ChatGPT; the installer cannot check it):");
  ui.info("  1. In ChatGPT settings enable developer mode for apps/connectors and add a custom connector/app.");
  ui.info(`  2. MCP server URL: ${s.relayUrl}/mcp    Authentication: OAuth`);
  ui.info("  3. Log in through Cloudflare Access and approve. In a chat, select the app and ask:");
  ui.info('     "List the files in my remote workspace".');
  ui.info("Health check at any time: ./install-macos.sh doctor");
  ui.info("Stop the agent: ./install-macos.sh uninstall (keeps keys and config). To cut remote access at once,");
  ui.info("also disable the Access application in the Cloudflare dashboard.");
}

export async function install(ctx, opts, ui) {
  ui.danger(SECURITY_BANNER);
  const s = {};
  await preflight(ctx, opts, ui, s);
  await dependencies(ctx, opts, ui, s);
  await workspace(ctx, opts, ui, s);
  await keys(ctx, opts, ui, s);
  await personalConfig(ctx, opts, ui, s);
  await cloudflareLogin(ctx, opts, ui, s);
  await deployStep(ctx, opts, ui, s);
  await agent(ctx, opts, ui, s);
  await access(ctx, opts, ui, s);
  if (!s.accessVerified) {
    throw new Checkpoint("setup is not finished: Cloudflare Access has not been verified", {
      instructions: ["Re-run ./install-macos.sh without --skip-cloudflare / --no-network-checks to finish and verify it."],
    });
  }
  finish(ctx, opts, ui, s);
}
