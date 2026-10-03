// Explicit post-pairing permission changes for hosted/account-paired Macs.
// Pairing itself is always file-only. Elevation requires local typed consent,
// server state and local mcp-commander state must agree, and the agent is restarted
// and verified before server-side elevation becomes effective.

import fs from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { loadCommanderConfig, updateCommanderConfig } from "./commander.mjs";
import { axHelperPath } from "./deps.mjs";
import { agent } from "./install.mjs";
import { inspectKeys, KEY_FILES } from "./keys.mjs";
import { commanderModule, offboardingState, revokeLocalRuntime, stopJobs } from "./offboarding.mjs";
import { signedHeaders } from "./relay-probe.mjs";
import { probeBetaStatus } from "./beta-enrollment.mjs";
import { pendingRuntime, readState, writeState } from "./state.mjs";
import { Checkpoint, InstallerError, run } from "./util.mjs";
import { normalizeRelayUrl } from "./validate.mjs";

const DEVICE = /^beta-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 4096;
const CONTROL_TTL_MS = 5 * 60 * 1000;
const displaySafe = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function sameBinding(a, b) {
  return a.accountEmail === b.accountEmail && a.identityIssuer === b.identityIssuer
    && a.identityFingerprint === b.identityFingerprint && a.agentFingerprint === b.agentFingerprint;
}


function sameTarget(a, b) {
  return a.terminalEnabled === b.terminalEnabled && a.guiEnabled === b.guiEnabled;
}

function targetFromOptions(current, opts) {
  if (opts.fileOnly) return { terminalEnabled: false, guiEnabled: false };
  return {
    terminalEnabled: opts.enableTerminal ? true : opts.disableTerminal ? false : current.terminalEnabled,
    guiEnabled: opts.enableGui ? true : opts.disableGui ? false : current.guiEnabled,
  };
}

export function permissionPlan(local, server, opts) {
  if (!sameTarget(local, server) && !opts.fileOnly) {
    throw new InstallerError("local and server permission state differ; use permissions --file-only first to fail closed");
  }
  const base = sameTarget(local, server) ? local : {
    terminalEnabled: local.terminalEnabled || server.terminalEnabled,
    guiEnabled: local.guiEnabled || server.guiEnabled,
  };
  const target = targetFromOptions(local, opts);
  const elevated = [];
  const reduced = [];
  for (const [name, key] of [["terminal", "terminalEnabled"], ["GUI", "guiEnabled"]]) {
    if (!base[key] && target[key]) elevated.push(name);
    if (base[key] && !target[key]) reduced.push(name);
  }
  if (elevated.length && reduced.length) {
    throw new InstallerError("do not mix permission elevation and reduction in one command; reduce first, then enable separately");
  }
  return { target, elevated, reduced, unchanged: sameTarget(target, local) && sameTarget(target, server) };
}

async function boundedJson(response) {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("oversize response");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

async function controlRequest(relayUrl, deviceId, action, key, { body, requestId, fetchImpl = fetch } = {}) {
  const origin = normalizeRelayUrl(relayUrl);
  const target = action === "status"
    ? `/control/device/${deviceId}/status`
    : action === "request-status" && REQUEST_ID.test(requestId ?? "")
      ? `/control/device/${deviceId}/request/${requestId}/status`
      : `/control/device/${deviceId}/${action}`;
  const method = action === "status" || action === "request-status" ? "GET" : "POST";
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const headers = signedHeaders(key, method, target, payload);
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetchImpl(new URL(target, origin), {
      method,
      headers,
      body: body === undefined ? undefined : payload,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new InstallerError("permission service is unavailable; no new permission was granted");
  }
  let data = null;
  try { data = await boundedJson(response); } catch {}
  return { status: response.status, data };
}

function validateServerStatus(value, deviceId) {
  if (!value || value.ok !== true || value.deviceId !== deviceId
    || !displaySafe(value.accountEmail, 320) || value.accountEmail.length < 3
    || !displaySafe(value.identityIssuer, 512) || !value.identityIssuer.startsWith("https://")
    || typeof value.identityFingerprint !== "string" || !FINGERPRINT.test(value.identityFingerprint)
    || typeof value.agentFingerprint !== "string" || !FINGERPRINT.test(value.agentFingerprint)
    || typeof value.terminalEnabled !== "boolean" || typeof value.guiEnabled !== "boolean") return null;
  return value;
}

function validatePreview(value, deviceId, requestId, target, previous) {
  if (!value || value.ok !== true || value.deviceId !== deviceId || value.requestId !== requestId || value.status !== "pending"
    || typeof value.accountEmail !== "string" || typeof value.identityIssuer !== "string"
    || typeof value.identityFingerprint !== "string" || !FINGERPRINT.test(value.identityFingerprint)
    || typeof value.agentFingerprint !== "string" || !FINGERPRINT.test(value.agentFingerprint)
    || value.previousTerminal !== previous.terminalEnabled || value.previousGui !== previous.guiEnabled
    || value.requestedTerminal !== target.terminalEnabled || value.requestedGui !== target.guiEnabled
    || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= Date.now() || value.expiresAtMs > Date.now() + CONTROL_TTL_MS) return null;
  return value;
}

function validateApplied(value, deviceId, requestId, target) {
  return value?.ok === true && value.deviceId === deviceId && value.requestId === requestId && value.status === "applied"
    && value.terminalEnabled === target.terminalEnabled && value.guiEnabled === target.guiEnabled;
}

function validateRequestStatus(value, deviceId, requestId, target, serverBody) {
  if (!value || value.ok !== true || value.deviceId !== deviceId || value.requestId !== requestId
    || !["pending", "applied", "cancelled", "expired"].includes(value.status)
    || !sameBinding(value, serverBody)
    || value.requestedTerminal !== target.terminalEnabled || value.requestedGui !== target.guiEnabled
    || typeof value.terminalEnabled !== "boolean" || typeof value.guiEnabled !== "boolean") return null;
  return value;
}

function permissionError(result, action) {
  const map = {
    401: "permission request authentication shape was rejected",
    403: "this Mac is not authorized for the permission service",
    404: "permission service is not enabled on this relay",
    409: action === "start" ? "another permission request is pending or the requested state conflicts" : "permission change was not applied",
    429: "permission service is rate-limited; retry later",
    503: "permission service is temporarily unavailable",
  };
  return new InstallerError(map[result.status] ?? `permission service returned HTTP ${result.status}; no unverified permission is accepted`);
}

export function guiPermissionState(ctx, { runImpl = run } = {}) {
  const helper = axHelperPath(ctx.commanderDir);
  if (!fs.existsSync(helper)) return { ok: false, reason: "helper_missing" };
  const result = runImpl(helper, ["check"], { input: "{}", timeoutMs: 10_000 });
  if (result.status !== 0 || result.error) return { ok: false, reason: "helper_failed" };
  try {
    const body = JSON.parse(result.stdout);
    return { ok: body.trusted === true && body.screenLocked !== true && body.onConsole === true,
      trusted: body.trusted === true, screenLocked: body.screenLocked === true, onConsole: body.onConsole === true };
  } catch {
    return { ok: false, reason: "helper_invalid" };
  }
}

async function defaultRestart(ctx, ui, saved, target) {
  const s = {
    beta: true,
    accountPaired: true,
    relayUrl: saved.relayUrl,
    personal: { values: { deviceId: saved.deviceId, relayUrl: saved.relayUrl } },
  };
  await agent(ctx, { accountPair: true, fileOnly: !target.terminalEnabled && !target.guiEnabled }, { ...ui, confirm: async () => true }, s, { probeStatus: probeBetaStatus });
  return s.agentVerified === true;
}

export async function changeAccountPermissions(ctx, opts, ui, deps = {}) {
  const state = readState(ctx);
  const saved = state.accountPairing;
  if (!saved || saved.registered !== true || !DEVICE.test(saved.deviceId) || typeof saved.relayUrl !== "string") {
    throw new InstallerError("permissions are available only after this Mac has completed account pairing");
  }
  if (state.accountControl?.pending && !opts.fileOnly) {
    throw new InstallerError("an interrupted permission change is unverified; run permissions --file-only before reviewing a new elevation");
  }
  const relayUrl = normalizeRelayUrl(saved.relayUrl);
  if (relayUrl !== saved.relayUrl) throw new InstallerError("saved account relay is not canonical; refusing permission changes");
  const keys = inspectKeys(ctx.astraHome);
  if (!keys.dir.ok || !keys.agent.ok || keys.agent.publicKeyB64 !== saved.agentPublicKeyB64) {
    throw new InstallerError("account-paired agent key does not match this Mac; refusing permission changes");
  }
  const localFingerprint = createHash("sha256").update(Buffer.from(keys.agent.publicKeyB64, "base64")).digest("hex");
  let privateKey;
  try { privateKey = createPrivateKey(fs.readFileSync(path.join(ctx.astraHome, KEY_FILES.agent))); }
  catch { throw new InstallerError("account-paired agent private key is unreadable"); }

  const loadConfig = deps.loadConfig ?? loadCommanderConfig;
  const updateConfig = deps.updateConfig ?? updateCommanderConfig;
  const request = deps.request ?? ((action, options = {}) => controlRequest(relayUrl, saved.deviceId, action, privateKey, options));
  const restart = deps.restart ?? ((target) => defaultRestart(ctx, ui, saved, target));
  const stopRuntime = deps.stopRuntime ?? (() => revokeLocalRuntime(ctx, { ...ui, confirm: async () => true }, { fileOnly: true }));
  const enableJobs = deps.enableJobs ?? (async () => {
    const { enableDurableJobs } = await commanderModule(ctx, "remote/offboarding.js");
    await enableDurableJobs(ctx.commanderRemoteDir);
  });
  const stopTrackedJobs = deps.stopJobs ?? (() => stopJobs(ctx, ctx.commanderRemoteDir));
  const guiCheck = deps.guiCheck ?? (() => guiPermissionState(ctx));
  const localConfig = await loadConfig(ctx);
  if (!localConfig.exists || !localConfig.cfg || !localConfig.raw) {
    throw new InstallerError(`remote.json is not ready: ${localConfig.error ?? "missing"}`);
  }
  const local = { terminalEnabled: localConfig.cfg.trustedTerminal === true, guiEnabled: localConfig.cfg.trustedGui === true };
  const begin = (target, phase, binding = {}, requestId) => writeState(ctx, { accountControl: {
    version: 1, deviceId: saved.deviceId, relayUrl, ...binding, ...target, pending: phase,
    ...(requestId ? { requestId } : {}),
  } });
  const complete = (target, binding) => writeState(ctx, { accountControl: {
    version: 1, deviceId: saved.deviceId, relayUrl, accountEmail: binding.accountEmail,
    identityIssuer: binding.identityIssuer, identityFingerprint: binding.identityFingerprint,
    agentFingerprint: binding.agentFingerprint, ...target, pending: null, verifiedAt: new Date().toISOString(),
  } });
  const setLocal = async target => {
    pendingRuntime(ctx, "permission change pending verified restart");
    await updateConfig(ctx, localConfig.raw, { terminal: target.terminalEnabled, gui: target.guiEnabled });
    if (!(await restart(target))) throw new InstallerError("agent restart/readiness was not verified after the local permission change");
    if (target.guiEnabled && !guiCheck().ok) {
      throw new InstallerError("macOS Accessibility was not verified after restart; GUI permission remains unconfirmed");
    }
  };
  const reduceLocal = async (target, stopTerminal) => {
    const failures = [];
    if (stopTerminal) {
      try { await stopTrackedJobs(); } catch (err) { failures.push(err); }
    }
    try { await setLocal(target); }
    catch (err) {
      failures.push(err);
      // A refused/failed restart must not leave the old elevated runtime serving.
      try { await stopRuntime(); } catch (stopping) { failures.push(stopping); }
    }
    if (failures.length) throw new InstallerError(failures.map(err => err.message).join("; "));
  };
  const reduceOnUnavailable = async err => {
    const target = targetFromOptions(local, opts);
    if (!opts.fileOnly && !opts.disableTerminal && !opts.disableGui) throw err;
    if (target.terminalEnabled > local.terminalEnabled || target.guiEnabled > local.guiEnabled) throw err;
    begin(target, "server_reduction_unverified");
    try { await reduceLocal(target, opts.fileOnly || (local.terminalEnabled && !target.terminalEnabled)); }
    catch (reduction) {
      throw new InstallerError(`server permission state is unverified; local reduction also reported: ${reduction.message}. Run permissions --file-only to reconcile.`);
    }
    throw new InstallerError(`${err.message}; local permissions were reduced, but server authority is unverified. Re-run permissions --file-only.`);
  };

  let statusResult;
  try { statusResult = await request("status"); }
  catch (err) { return reduceOnUnavailable(err); }
  if (statusResult.status !== 200) return reduceOnUnavailable(permissionError(statusResult, "status"));
  const serverBody = validateServerStatus(statusResult.data, saved.deviceId);
  if (!serverBody || serverBody.agentFingerprint !== localFingerprint) {
    return reduceOnUnavailable(new InstallerError("permission service returned an invalid identity or Mac key fingerprint; no new permission is accepted"));
  }
  const server = { terminalEnabled: serverBody.terminalEnabled, guiEnabled: serverBody.guiEnabled };
  const plan = permissionPlan(local, server, opts);
  const verifyFinal = async () => {
    let finalServer = null;
    try {
      const result = await request("status");
      finalServer = result.status === 200 ? validateServerStatus(result.data, saved.deviceId) : null;
    } catch {}
    const finalLocal = await loadConfig(ctx);
    return finalServer && sameBinding(finalServer, serverBody) && sameTarget(finalServer, plan.target)
      && finalLocal.cfg?.trustedTerminal === plan.target.terminalEnabled && finalLocal.cfg?.trustedGui === plan.target.guiEnabled;
  };

  // Cancel the exact interrupted request before a new reconciliation, if present.
  if (opts.fileOnly && REQUEST_ID.test(state.accountControl?.requestId ?? "")) {
    const previous = state.accountControl;
    try { await request("cancel", { body: { version: 1, requestId: previous.requestId,
      terminalEnabled: previous.terminalEnabled, guiEnabled: previous.guiEnabled } }); } catch {}
  }
  if (plan.unchanged || (opts.fileOnly && !server.terminalEnabled && !server.guiEnabled)) {
    if ((plan.target.terminalEnabled || plan.target.guiEnabled)
      && (!state.accountControl || state.accountControl.version !== 1 || state.accountControl.pending
        || !sameBinding(state.accountControl, serverBody) || !sameTarget(state.accountControl, plan.target)
        || state.accountControl.deviceId !== saved.deviceId || state.accountControl.relayUrl !== relayUrl)) {
      throw new InstallerError("configured control has no completed local review for this exact account/Mac; run permissions --file-only before enabling it");
    }
    if (!plan.unchanged && !(await ui.confirm("Apply this local permission reduction?", { what: "reduce Astra permissions" }))) {
      throw new Checkpoint("permission reduction not confirmed");
    }
    begin(plan.target, "runtime_reconciliation", serverBody);
    await reduceLocal(plan.target, Boolean(opts.fileOnly));
    if (!(await verifyFinal())) throw new InstallerError("final permission verification failed; run permissions --file-only to reconcile");
    complete(plan.target, serverBody);
    ui.ok(`permissions verified: terminal=${plan.target.terminalEnabled ? "ON" : "off"}, GUI=${plan.target.guiEnabled ? "ON" : "off"}`);
    return;
  }

  if (plan.elevated.includes("terminal") && offboardingState(ctx.commanderRemoteDir) === "incomplete") {
    throw new InstallerError("an earlier durable-job shutdown is unconfirmed; terminal permission stays off until it is resolved");
  }
  if (plan.elevated.includes("GUI") && !guiCheck().ok) {
    throw new Checkpoint("macOS Accessibility is not ready, so GUI permission was not requested", {
      instructions: ["System Settings → Privacy & Security → Accessibility: grant access to the Astra/Node helper, unlock the Mac, then rerun the same permissions command."],
    });
  }

  const requestId = randomUUID();
  const startBody = { version: 1, requestId, terminalEnabled: plan.target.terminalEnabled, guiEnabled: plan.target.guiEnabled };
  const requestStatus = async () => {
    try {
      const result = await request("request-status", { requestId });
      return result.status === 200 ? validateRequestStatus(result.data, saved.deviceId, requestId, plan.target, serverBody) : null;
    } catch { return null; }
  };
  const cancel = async () => { try { await request("cancel", { body: startBody }); } catch {} };
  let started;
  try {
    try { started = await request("start", { body: startBody }); }
    catch (err) {
      const recovered = await requestStatus();
      if (!recovered || recovered.status !== "pending") throw err;
      started = { status: 201, data: recovered };
    }
    if (started.status !== 201) {
      const recovered = started.status >= 500 ? await requestStatus() : null;
      if (!recovered || recovered.status !== "pending") throw permissionError(started, "start");
      started = { status: 201, data: recovered };
    }
  } catch (err) {
    if (plan.reduced.length) return reduceOnUnavailable(err);
    throw err;
  }
  const preview = validatePreview(started.data, saved.deviceId, requestId, plan.target, server);
  if (!preview || !sameBinding(preview, serverBody)) {
    await cancel();
    if (plan.reduced.length) return reduceOnUnavailable(new InstallerError("permission preview did not match the verified account/Mac state"));
    throw new InstallerError("permission preview did not match the verified account/Mac state; nothing changed");
  }

  ui.heading("Permission change review");
  ui.info(`account: ${preview.accountEmail}`);
  ui.info(`identity provider: ${preview.identityIssuer}`);
  ui.info(`identity SHA-256 (issuer + subject): ${preview.identityFingerprint}`);
  ui.info(`device: ${saved.deviceId}`);
  ui.info(`Mac key SHA-256: ${preview.agentFingerprint}`);
  ui.info(`current: terminal=${server.terminalEnabled ? "ON" : "off"}, GUI=${server.guiEnabled ? "ON" : "off"}`);
  ui.info(`target:  terminal=${plan.target.terminalEnabled ? "ON" : "off"}, GUI=${plan.target.guiEnabled ? "ON" : "off"}`);
  try {
    let confirmed;
    if (plan.elevated.length) {
      ui.danger([
        ...(plan.elevated.includes("terminal") ? [
          "TERMINAL is equivalent to a remote shell: ChatGPT can execute arbitrary commands as your macOS user beyond workspace boundaries.",
          "Terminal permission provides no GUI isolation: shell commands can also reach apps and any macOS capabilities already available to your user.",
        ] : []),
        ...(plan.elevated.includes("GUI") ? ["GUI lets ChatGPT read and operate app windows through macOS Accessibility."] : []),
        "This is a separate opt-in after pairing; it is not granted by account pairing itself.",
      ]);
      confirmed = await ui.typed("Enable the reviewed permissions?", "enable");
    } else {
      confirmed = await ui.confirm("Apply this permission reduction?", { what: "reduce Astra permissions" });
    }
    if (!confirmed) throw new Checkpoint(plan.elevated.length ? "permission elevation not confirmed; nothing was enabled" : "permission reduction not confirmed");
  } catch (err) { await cancel(); throw err; }
  if (preview.expiresAtMs <= Date.now()) {
    await cancel();
    throw new InstallerError("permission preview expired during local review; nothing was enabled");
  }

  // This transaction survives agent() clearing its separate runtime pending state.
  begin(plan.target, plan.elevated.length ? "elevation" : "reduction", {
    accountEmail: preview.accountEmail, identityIssuer: preview.identityIssuer,
    identityFingerprint: preview.identityFingerprint, agentFingerprint: preview.agentFingerprint,
  }, requestId);
  const applyServer = async () => {
    let result;
    try { result = await request("apply", { body: startBody }); }
    catch (err) {
      const recovered = await requestStatus();
      if (recovered?.status === "applied" && sameTarget(recovered, plan.target)) return;
      throw err;
    }
    if (result.status === 200 && validateApplied(result.data, saved.deviceId, requestId, plan.target)) return;
    const recovered = result.status >= 500 ? await requestStatus() : null;
    if (recovered?.status === "applied" && sameTarget(recovered, plan.target)) return;
    throw permissionError(result, "apply");
  };
  const rollbackLocal = async () => {
    begin(local, "elevation_unconfirmed", serverBody, requestId);
    await reduceLocal(local, !local.terminalEnabled && plan.target.terminalEnabled);
  };
  if (plan.reduced.length) {
    let applyFailure = null;
    try { await applyServer(); } catch (err) { applyFailure = err; }
    try { await reduceLocal(plan.target, Boolean(opts.fileOnly) || (local.terminalEnabled && !plan.target.terminalEnabled)); }
    catch (err) { await cancel(); throw err; }
    if (applyFailure) { await cancel(); throw applyFailure; }
  } else {
    try {
      if (!local.terminalEnabled && plan.target.terminalEnabled) await enableJobs();
      await setLocal(plan.target);
      await applyServer();
    } catch (err) {
      await cancel();
      try { await rollbackLocal(); }
      catch (rollback) {
        throw new InstallerError(`permission elevation was not confirmed and local rollback also failed: ${rollback.message}. Stop the Astra agent and run permissions --file-only before using control tools.`);
      }
      throw err;
    }
  }
  if (!(await verifyFinal())) {
    if (plan.elevated.length) {
      await cancel();
      try { await rollbackLocal(); }
      catch (rollback) {
        throw new InstallerError(`final permission verification failed and local rollback also failed: ${rollback.message}. Stop the Astra agent and run permissions --file-only.`);
      }
      throw new InstallerError("final permission verification failed; local control was rolled back. Run permissions --file-only to reconcile any unknown server state before retrying.");
    }
    throw new InstallerError("permission reduction could not be fully verified; remote authority was reduced first. Re-run permissions --file-only to reconcile local state.");
  }
  complete(plan.target, serverBody);
  ui.ok(`permissions verified: terminal=${plan.target.terminalEnabled ? "ON" : "off"}, GUI=${plan.target.guiEnabled ? "ON" : "off"}`);
}
