import { normalizeRelayUrl } from "./validate.mjs";
import { InstallerError } from "./util.mjs";

// Public release trust anchor. Replaced ONLY in the release copy by pin-beta-release.mjs.
// No CLI flag, environment variable, invite file or QR payload may override this pin.
export const BETA_RELAY_ORIGIN = null;

export function assertTrustedBetaRelay(origin, pinnedOrigin = BETA_RELAY_ORIGIN) {
  if (!pinnedOrigin || normalizeRelayUrl(pinnedOrigin) !== pinnedOrigin || origin !== pinnedOrigin) {
    throw new InstallerError("beta relay is not trusted by this release; obtain the operator's pinned beta release through the trusted distribution channel");
  }
  return origin;
}
