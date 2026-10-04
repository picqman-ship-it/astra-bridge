export const BETA_DEVICE_PATTERN = /^beta-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isBetaDeviceId(value: unknown): value is string {
  return typeof value === "string" && BETA_DEVICE_PATTERN.test(value);
}

/** Reserve the whole prefix whenever beta is enabled, even if its D1 binding is absent. */
export function isPersonalDeviceId(value: unknown, betaEnabled = true): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,96}$/.test(value) && (!betaEnabled || !/^beta-/i.test(value));
}
