import fs from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Checkpoint, InstallerError, writeFileAtomic } from "./util.mjs";
import { normalizeRelayUrl } from "./validate.mjs";
import { pendingRuntime, readState, writeState } from "./state.mjs";
import { KEY_FILES } from "./keys.mjs";
import { signedHeaders } from "./relay-probe.mjs";
import { assertTrustedBetaRelay } from "./beta-trust.mjs";

const INVITE = /^abi1_[a-f0-9]{64}$/;
const DEVICE = /^beta-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const agentFingerprint = key => createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");

/** Read a private, bounded regular file through one no-follow descriptor. No copying or logging. */
export function readInviteFile(file, relayUrl, { trust = assertTrustedBetaRelay } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.uid !== process.getuid() || st.size > 2048) throw new Error();
    const buffer = Buffer.alloc(2049);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 2048) throw new Error();
    const data = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (!data || Object.keys(data).sort().join(",") !== "invite,relayOrigin,version" || data.version !== 1
      || !INVITE.test(data.invite) || typeof data.relayOrigin !== "string") throw new Error();
    const origin = normalizeRelayUrl(data.relayOrigin);
    if (origin !== data.relayOrigin || (relayUrl && normalizeRelayUrl(relayUrl) !== origin)) throw new Error();
    trust(origin);
    return { invite: data.invite, relayUrl: origin };
  } catch { throw new InstallerError("invalid invite file: require a private 0600 file owned by you, version 1, and matching relay origin pinned by this release"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function signEnrollment(origin, invite, deviceId, agentPublicKeyB64, privateKey) {
  const message = ["astra-beta-enroll-v1", normalizeRelayUrl(origin), createHash("sha256").update(invite).digest("hex"), deviceId, agentPublicKeyB64].join("\n");
  return { version: 1, deviceId, agentPublicKeyB64, proof: sign(null, Buffer.from(message), privateKey).toString("base64") };
}

/** Read once, remove from inherited environments before npm/keygen/agent children run. */
export function takeInvite(ctx) {
  const value = ctx.env.ASTRA_BETA_INVITE;
  delete ctx.env.ASTRA_BETA_INVITE;
  delete ctx.childEnv.ASTRA_BETA_INVITE;
  return value;
}

/** No readline echo, shell command, child process or persistent secret storage. */
export async function promptInvite(ui, input = process.stdin, output = process.stderr) {
  if (!ui.interactive || !input.isTTY || typeof input.setRawMode !== "function") {
    throw new Checkpoint("a beta invite is needed", { instructions: ["Use --beta-enroll --invite-file /path/to/invite.json from the operator."] });
  }
  ui.release();
  output.write("Beta invite (hidden): ");
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", end);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
    };
    const end = () => { cleanup(); value = ""; reject(new Checkpoint("invite input cancelled")); };
    const data = (chunk) => {
      for (const c of chunk.toString("utf8")) {
        if (c === "\u0003" || c === "\u0004") return end();
        if (c === "\r" || c === "\n") { cleanup(); resolve(value); value = ""; return; }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (/^[a-z0-9_]$/.test(c) && value.length < 80) value += c;
        else return end();
      }
    };
    input.on("data", data);
    input.once("end", end);
    input.once("error", end);
  });
}

/** Guard before any local mode changes; never convert a personal installation implicitly. */
export function betaInstallOptions(ctx, opts, { trust = assertTrustedBetaRelay } = {}) {
  const saved = readState(ctx).betaEnrollment;
  if (!opts.betaEnroll) {
    if (opts.inviteFile || opts.legacyInvite || opts.resetPendingIdentity) throw new InstallerError("invite options require --beta-enroll");
    if (saved) throw new InstallerError("this is a beta installation; re-run with --beta-enroll");
    return opts;
  }
  if (opts.enableTerminal || opts.enableGui || opts.redeploy || opts.replaceExistingWorker || opts.email
    || opts.accountId || opts.teamDomain || opts.policyAud || opts.workerName || opts.noNetworkChecks || opts.deviceId !== undefined) {
    throw new InstallerError("beta enrollment requires online file-only mode and cannot use owner/Cloudflare options");
  }
  if (fs.existsSync(ctx.personalConfig) || readState(ctx).deploy) throw new InstallerError("a personal installation exists; beta enrollment requires a separate installation");
  if (!saved && fs.existsSync(path.join(ctx.launchAgentsDir, "com.example.astra-bridge-agent.plist"))) {
    throw new InstallerError("an existing agent is not identified as beta; refusing to replace it");
  }
  const relayUrl = normalizeRelayUrl(opts.relayUrl ?? saved?.relayUrl);
  if (opts.resetPendingIdentity && (!saved || saved.registered === true)) throw new InstallerError("only an unconfirmed beta identity can be reset");
  const changed = saved && (saved.relayUrl !== relayUrl || opts.resetPendingIdentity);
  // Keep the old ID until signed recovery has been attempted with the existing key.
  const deviceId = saved?.deviceId ?? `beta-${randomUUID()}`;
  if (!DEVICE.test(deviceId)) throw new InstallerError("invalid beta device id");
  if (saved?.registered === true && changed) throw new InstallerError("confirmed beta relay/device identity cannot be changed on re-run");
  trust(relayUrl);
  return { ...opts, relayUrl, deviceId, fileOnly: true, skipCloudflare: true };
}

/** Runs after key inspection and before enrollment. A write-ahead rotation flag makes
 * interrupted key replacement recoverable without ever reusing the old key for a new ID.
 */
export async function recoverPendingBetaIdentity(ctx, opts, ui, s, { probe = probeBetaStatus } = {}) {
  const saved = readState(ctx).betaEnrollment;
  if (!saved || (!saved.rotationRequired && saved.relayUrl === opts.relayUrl && !opts.resetPendingIdentity)) return opts;
  if (saved.registered === true) throw new InstallerError("confirmed beta identity/key cannot change");
  const keyFile = path.join(ctx.astraHome, KEY_FILES.agent);
  if (!saved.rotationRequired) {
    if (saved.agentPublicKeyB64 && saved.agentPublicKeyB64 !== s.keys.agent) throw new InstallerError("beta agent key changed; operator recovery is required");
    const status = await probe(opts.relayUrl, saved.deviceId, keyFile);
    if (status.ok) {
      writeState(ctx, { betaEnrollment: { ...saved, relayUrl: opts.relayUrl, registered: true } });
      ui.ok("recovered committed beta identity by signed status; ID and key preserved");
      return { ...opts, deviceId: saved.deviceId, resetPendingIdentity: false };
    }
    if (![403, 404].includes(status.status)) throw new InstallerError("pending identity recovery is unavailable; retry later before resetting the identity");
  }
  const deviceId = saved.rotationRequired ? saved.deviceId : `beta-${randomUUID()}`;
  const previousDeviceId = saved.previousDeviceId ?? saved.deviceId;
  const record = { relayUrl: opts.relayUrl, deviceId, registered: false, previousDeviceId, rotationRequired: true };
  // Deliberately omit the stale agentPublicKeyB64 before changing the key file.
  writeState(ctx, { betaEnrollment: record });
  pendingRuntime(ctx, "unconfirmed beta identity/key rotated");
  const pair = generateKeyPairSync("ed25519");
  writeFileAtomic(keyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), 0o600);
  s.keys.agent = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  writeState(ctx, { betaEnrollment: { ...record, rotationRequired: false, agentPublicKeyB64: s.keys.agent } });
  ui.warn?.(`Unconfirmed identity and agent key rotated. Ask the operator to inspect/revoke previous device ${previousDeviceId}; its key remains reserved even after revocation.`);
  return { ...opts, deviceId, resetPendingIdentity: false };
}

async function boundedJson(response) {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); throw new Error("oversize response"); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export async function probeBetaStatus(base, deviceId, keyFile, { fetchImpl = fetch } = {}) {
  let key;
  try { key = createPrivateKey(fs.readFileSync(keyFile)); }
  catch { return { ok: false, failure: "configuration", error: "beta_agent_key_unreadable" }; }
  try {
    const origin = normalizeRelayUrl(base);
    if (!DEVICE.test(deviceId)) throw new Error("invalid device");
    const target = `/beta/device/${deviceId}/status`;
    const res = await fetchImpl(new URL(target, origin), { headers: signedHeaders(key, "GET", target), redirect: "error", signal: AbortSignal.timeout(8000) });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { ok: false, status: res.status, agentConnected: false, mcpHealthy: false, error: "beta_status_unavailable" };
    }
    const body = await boundedJson(res);
    return { ok: res.status === 200 && body?.ok === true, status: res.status,
      agentConnected: body?.agentConnected === true, mcpHealthy: body?.mcpHealthy === true,
      error: "beta_status_unavailable" };
  } catch { return { ok: false, error: "beta_status_unavailable" }; }
}

export async function enrollBeta(ctx, opts, ui, s, invite, { fetchImpl = fetch, prompt = promptInvite, probe = probeBetaStatus } = {}) {
  const registration = { deviceId: opts.deviceId, agentPublicKeyB64: s.keys.agent };
  const saved = readState(ctx).betaEnrollment;
  const sameIdentity = saved?.relayUrl === opts.relayUrl && saved?.deviceId === opts.deviceId;
  if (saved?.registered === true && !sameIdentity) throw new InstallerError("confirmed beta identity cannot change");
  if (saved?.agentPublicKeyB64 && saved.agentPublicKeyB64 !== registration.agentPublicKeyB64) throw new InstallerError("beta agent key changed; operator recovery is required");
  if (saved && !sameIdentity) ui.warn?.(`Correcting unconfirmed identity. Ask the operator to inspect/revoke the previous device ${saved.deviceId}; a lost response may have enrolled it.`);
  ui.ok(`Beta device ID: ${registration.deviceId}`);
  ui.ok(`Agent key SHA-256: ${agentFingerprint(registration.agentPublicKeyB64)}`);
  // Persist public identity before the request. A lost response can recover by a signed status.
  const record = { relayUrl: opts.relayUrl, ...registration };
  writeState(ctx, { betaEnrollment: { ...record, registered: saved?.registered === true } });
  s.beta = true;
  s.relayUrl = opts.relayUrl;
  s.personal = { values: { deviceId: opts.deviceId, relayUrl: opts.relayUrl } };
  if (saved && sameIdentity) {
    const status = await probe(opts.relayUrl, opts.deviceId, path.join(ctx.astraHome, KEY_FILES.agent), { fetchImpl });
    if (status.ok) {
      writeState(ctx, { betaEnrollment: { ...record, registered: true } });
      ui.ok("existing beta registration verified by agent signature");
      return;
    }
    if (saved.registered) throw new InstallerError("beta registration could not be verified; retry later or contact the operator");
  }
  if (invite === undefined && !opts.legacyInvite) throw new Checkpoint("a beta invite file is needed", { instructions: ["Use --beta-enroll --invite-file /path/to/invite.json from the operator."] });
  invite ??= await prompt(ui);
  if (!INVITE.test(invite)) throw new InstallerError("invalid beta invite");
  try {
    const res = await fetchImpl(new URL("/beta/enroll", opts.relayUrl), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json", authorization: `Bearer ${invite}` },
      body: JSON.stringify(signEnrollment(opts.relayUrl, invite, opts.deviceId, s.keys.agent,
        createPrivateKey(fs.readFileSync(path.join(ctx.astraHome, KEY_FILES.agent))))),
    });
    if (res.status !== 201) {
      await res.body?.cancel();
      const messages = {
        403: "This invite may already have been used by another device: report it to the operator for inspection/revocation; do not simply request another invite",
        404: "beta enrollment is closed; ask the operator to open the enrollment window",
        429: "beta enrollment is rate-limited; retry later",
        503: "beta enrollment service is temporarily unavailable; retry later",
      };
      throw new InstallerError(messages[res.status] ?? "beta enrollment was not confirmed; contact the operator or re-run to recover");
    }
    const body = await boundedJson(res);
    if (body?.ok !== true || Object.keys(body).length !== 1) throw new Error("invalid response");
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError("beta enrollment was not confirmed (network, timeout or invalid response); re-run to recover a possibly committed registration");
  } finally { invite = undefined; }
  writeState(ctx, { betaEnrollment: { ...record, registered: true } });
  ui.ok("beta device registered; terminal and GUI remain disabled");
}
