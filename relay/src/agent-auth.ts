import { resolveActiveBetaDevice, type D1DatabaseLike } from "./beta-registry";
import { isBetaDeviceId, isPersonalDeviceId } from "./beta-identity";

export type AgentAuthEnv = {
  AGENT_DEVICE_ID: string;
  CLIENT_DEVICE_ID?: string;
  MCP_DEVICE_ID?: string;
  AGENT_PUBLIC_KEY_B64?: string;
  BETA_REGISTRY_ENABLED?: string;
  BETA_REGISTRY?: D1DatabaseLike;
};

export type AgentAuthentication = {
  deviceId: string;
  publicKeyB64: string;
  beta: boolean;
};

export function betaRegistryEnabled(env: Pick<AgentAuthEnv, "BETA_REGISTRY_ENABLED" | "BETA_REGISTRY">): boolean {
  return env.BETA_REGISTRY_ENABLED === "true" && env.BETA_REGISTRY !== undefined;
}

/**
 * The configured personal agent is always resolved from its existing static
 * public key. Dynamic beta lookup is impossible until both opt-in controls exist.
 */
export async function resolveAgentAuthentication(
  env: AgentAuthEnv,
  deviceId: string,
): Promise<AgentAuthentication | null> {
  if (deviceId === env.AGENT_DEVICE_ID) {
    return isPersonalDeviceId(deviceId, env.BETA_REGISTRY_ENABLED === "true") && env.AGENT_PUBLIC_KEY_B64
      ? { deviceId, publicKeyB64: env.AGENT_PUBLIC_KEY_B64, beta: false }
      : null;
  }
  if (deviceId === env.CLIENT_DEVICE_ID || deviceId === env.MCP_DEVICE_ID
    || !isBetaDeviceId(deviceId) || !betaRegistryEnabled(env)) return null;
  const device = await resolveActiveBetaDevice(env.BETA_REGISTRY!, deviceId);
  return device
    ? { deviceId: device.deviceId, publicKeyB64: device.agentPublicKeyB64, beta: true }
    : null;
}
