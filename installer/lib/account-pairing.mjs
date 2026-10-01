import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { InstallerError, run, sleep } from "./util.mjs";
import { normalizeRelayUrl } from "./validate.mjs";
import { readState, writeState } from "./state.mjs";
import { KEY_FILES } from "./keys.mjs";
import { assertTrustedBetaRelay, BETA_RELAY_ORIGIN } from "./beta-trust.mjs";
import { probeBetaStatus } from "./beta-enrollment.mjs";

const DEVICE = /^beta-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAIR_TOKEN = /^ap1_[a-f0-9]{64}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RESPONSE = 4096;
const MAX_PAIR_WAIT_MS = 10 * 60 * 1000;

function exactKeys(value, names) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...names].sort().join(",");
}

async function boundedJson(response) {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE) {
        await reader.cancel().catch(() => {});
        throw new Error("oversize response");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

export function signPairStart(origin, requestId, deviceId, agentPublicKeyB64, privateKey) {
  const relay = normalizeRelayUrl(origin);
  if (!REQUEST_ID.test(requestId) || !DEVICE.test(deviceId) || typeof agentPublicKeyB64 !== "string") {
    throw new InstallerError("invalid account-pairing identity");
  }
  const message = ["astra-pair-start-v1", relay, requestId, deviceId, agentPublicKeyB64].join("\n");
  return {
    version: 1,
    requestId,
    deviceId,
    agentPublicKeyB64,
    proof: sign(null, Buffer.from(message), privateKey).toString("base64"),
  };
}

export function accountPairInstallOptions(
  ctx,
  opts,
  { trust = assertTrustedBetaRelay, pinnedOrigin = BETA_RELAY_ORIGIN } = {},
) {
  const saved = readState(ctx).accountPairing;
  if (!opts.accountPair) {
    if (saved) throw new InstallerError("this is an account-paired installation; re-run with --account-pair");
    return opts;
  }
  if (opts.betaEnroll) throw new InstallerError("--account-pair and --beta-enroll are separate enrollment modes");
  if (readState(ctx).betaEnrollment) throw new InstallerError("this installation is already an invited-beta device");
  if (opts.enableTerminal || opts.enableGui || opts.redeploy || opts.replaceExistingWorker || opts.email
    || opts.accountId || opts.teamDomain || opts.policyAud || opts.workerName || opts.noNetworkChecks
    || opts.deviceId !== undefined) {
    throw new InstallerError("account pairing starts file-only and cannot use owner/Cloudflare/control options");
  }
  if (fs.existsSync(ctx.personalConfig) || readState(ctx).deploy) {
    throw new InstallerError("a personal self-deploy installation exists; account pairing requires a separate installation");
  }

  const candidate = opts.relayUrl ?? saved?.relayUrl ?? pinnedOrigin;
  if (!candidate) throw new InstallerError("this release does not pin an Astra account relay");
  const relayUrl = normalizeRelayUrl(candidate);
  trust(relayUrl);
  if (saved?.registered === true && saved.relayUrl !== relayUrl) {
    throw new InstallerError("confirmed account pairing cannot change relay");
  }
  const deviceId = saved?.deviceId ?? `beta-${randomUUID()}`;
  if (!DEVICE.test(deviceId)) throw new InstallerError("invalid account-pairing device id");
  return { ...opts, relayUrl, deviceId, fileOnly: true, skipCloudflare: true };
}

function validateStartResponse(body, relayUrl, deviceId, now) {
  if (!exactKeys(body, ["ok", "deviceId", "expiresAtMs", "claimUrl", "pairingToken"])
    || body.ok !== true || body.deviceId !== deviceId
    || !PAIR_TOKEN.test(body.pairingToken)
    || !Number.isSafeInteger(body.expiresAtMs)
    || body.expiresAtMs <= now || body.expiresAtMs > now + MAX_PAIR_WAIT_MS + 60_000
    || typeof body.claimUrl !== "string") return null;

  let claim;
  try { claim = new URL(body.claimUrl); } catch { return null; }
  if (claim.origin !== relayUrl || claim.pathname !== "/pair/claim" || claim.hash
    || [...claim.searchParams.keys()].some((key) => key !== "token")
    || claim.searchParams.getAll("token").length !== 1
    || claim.searchParams.get("token") !== body.pairingToken) return null;
  return body;
}

async function defaultOpenBrowser(url) {
  const result = run("/usr/bin/open", [url], { timeoutMs: 15_000 });
  return result.status === 0 && !result.error;
}

async function fetchPairStatus(relayUrl, token, deviceId, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(new URL("/pair/status", relayUrl), {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ok: false, status: response.status };
    }
    const body = await boundedJson(response);
    if (!exactKeys(body, ["status", "deviceId"]) || body.deviceId !== deviceId
      || !["pending", "claimed", "cancelled", "expired"].includes(body.status)) {
      return { ok: false, status: 502 };
    }
    return { ok: true, ...body };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function pairAccount(
  ctx,
  opts,
  ui,
  s,
  {
    fetchImpl = fetch,
    openBrowser = defaultOpenBrowser,
    wait = sleep,
    clock = Date.now,
    probe = probeBetaStatus,
  } = {},
) {
  const keyFile = path.join(ctx.astraHome, KEY_FILES.agent);
  let privateKey;
  try { privateKey = createPrivateKey(fs.readFileSync(keyFile)); }
  catch { throw new InstallerError("account pairing requires the generated agent private key"); }

  const saved = readState(ctx).accountPairing;
  if (saved?.agentPublicKeyB64 && saved.agentPublicKeyB64 !== s.keys.agent) {
    throw new InstallerError("account-paired agent key changed; do not rebind silently");
  }
  if (saved?.registered === true) {
    const status = await probe(opts.relayUrl, opts.deviceId, keyFile, { fetchImpl });
    if (!status.ok) throw new InstallerError("confirmed account pairing could not be verified; retry later");
    s.beta = true;
    s.accountPaired = true;
    s.relayUrl = opts.relayUrl;
    s.personal = { values: { deviceId: opts.deviceId, relayUrl: opts.relayUrl } };
    ui.ok("existing account pairing verified by agent signature");
    return;
  }

  const record = {
    relayUrl: opts.relayUrl,
    deviceId: opts.deviceId,
    agentPublicKeyB64: s.keys.agent,
    registered: false,
  };
  writeState(ctx, { accountPairing: record });
  s.beta = true;
  s.accountPaired = true;
  s.relayUrl = opts.relayUrl;
  s.personal = { values: { deviceId: opts.deviceId, relayUrl: opts.relayUrl } };

  if (saved) {
    const recovered = await probe(opts.relayUrl, opts.deviceId, keyFile, { fetchImpl });
    if (recovered.ok) {
      writeState(ctx, { accountPairing: { ...record, registered: true } });
      ui.ok("recovered completed account pairing by agent signature");
      return;
    }
    if (recovered.status && ![403, 404, 408, 429, 503].includes(recovered.status)) {
      throw new InstallerError("pending account pairing could not be safely recovered; retry later");
    }
  }

  const requestId = randomUUID();
  const body = signPairStart(opts.relayUrl, requestId, opts.deviceId, s.keys.agent, privateKey);
  let response;
  try {
    response = await fetchImpl(new URL("/pair/start", opts.relayUrl), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new InstallerError("account pairing could not start; check the network and retry");
  }
  if (response.status !== 201) {
    await response.body?.cancel();
    const messages = {
      403: "account pairing proof was rejected",
      404: "account pairing is not enabled on this relay",
      409: "this Mac identity is already paired or has a conflicting request",
      429: "account pairing is rate-limited; retry later",
      503: "account pairing service is temporarily unavailable; retry later",
    };
    throw new InstallerError(messages[response.status] ?? "account pairing could not start");
  }

  let start;
  try { start = validateStartResponse(await boundedJson(response), opts.relayUrl, opts.deviceId, clock()); }
  catch { start = null; }
  if (!start) throw new InstallerError("account pairing relay returned an invalid response");

  ui.info("Opening the secure Astra pairing page in your browser. Sign in and confirm this Mac.");
  if (!await openBrowser(start.claimUrl)) {
    throw new InstallerError("the secure pairing page could not be opened; re-run account pairing");
  }

  const deadline = Math.min(start.expiresAtMs, clock() + MAX_PAIR_WAIT_MS);
  let lastStatus = 0;
  while (clock() < deadline) {
    const result = await fetchPairStatus(opts.relayUrl, start.pairingToken, opts.deviceId, { fetchImpl });
    lastStatus = result.status ?? lastStatus;
    if (result.ok && result.status === "claimed") {
      writeState(ctx, { accountPairing: { ...record, registered: true } });
      ui.ok("Astra account paired with this Mac");
      return;
    }
    if (result.ok && (result.status === "expired" || result.status === "cancelled")) {
      throw new InstallerError("account pairing expired or was cancelled; re-run to start a fresh request");
    }
    if (!result.ok && lastStatus && ![408, 429, 500, 502, 503, 504].includes(lastStatus)) {
      throw new InstallerError("account pairing status was rejected; re-run to recover safely");
    }
    await wait(2000);
  }
  throw new InstallerError("account pairing was not confirmed before it expired; re-run to start a fresh request");
}
