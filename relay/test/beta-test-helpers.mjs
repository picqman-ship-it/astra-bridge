import { createHash } from "node:crypto";
export { signEnrollment } from "../../installer/lib/beta-enrollment.mjs";
export const ORIGIN = "https://relay.example";
// Deterministic synthetic v4-shaped UUIDs; production uses crypto.randomUUID().
export function betaId(label) {
  const h = createHash("sha256").update(label).digest("hex");
  return `beta-${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function rateBindings() {
  return Object.fromEntries(["BETA_ENROLL_RATE", "BETA_REQUEST_RATE", "BETA_MCP_RATE",
    "BETA_ENROLL_GLOBAL_RATE", "BETA_AGENT_GLOBAL_RATE", "BETA_MCP_GLOBAL_RATE"]
    .map(name => [name, { async limit() { return { success: true }; } }]));
}
