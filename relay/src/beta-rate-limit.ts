export type BetaRateEnv = {
  BETA_ENROLL_RATE?: RateLimit;
  BETA_REQUEST_RATE?: RateLimit;
  BETA_MCP_RATE?: RateLimit;
  BETA_ENROLL_GLOBAL_RATE?: RateLimit;
  BETA_AGENT_GLOBAL_RATE?: RateLimit;
  BETA_MCP_GLOBAL_RATE?: RateLimit;
};

/** Strict edge address parsing. Never use caller-controlled forwarding headers. */
export function betaClientKey(ip: string | null): string {
  if (!ip || ip.length > 45) return "unknown";
  if (/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(ip)) {
    return ip.split(".").every(part => Number(part) <= 255) ? ip : "unknown";
  }
  if (!ip.includes(":") || !/^[0-9a-f:.]+$/i.test(ip)) return "unknown";
  try {
    // WHATWG URL validates IPv6 (including embedded IPv4) and canonicalizes it.
    const host = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
    const [left, right] = host.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const words = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
    if (words.length !== 8) return "unknown";
    const nums = words.map(word => parseInt(word, 16));
    if (nums.slice(0, 5).every(n => n === 0) && nums[5] === 0xffff) {
      return [nums[6] >> 8, nums[6] & 255, nums[7] >> 8, nums[7] & 255].join(".");
    }
    return words.slice(0, 4).map(word => word.padStart(4, "0")).join(":") + "/64";
  } catch { return "unknown"; }
}

/** Provider counters are approximate and local to a Cloudflare location. No isolate state.
 * CF-Connecting-IP is supplied by the edge; missing IPs share a bucket, never bypass it.
 * IP limits deliberately trade shared-NAT throughput for pre-authentication abuse control.
 */
export async function betaRateGate(
  request: Request, env: BetaRateEnv, route: "enroll" | "status" | "mcp" | "connect",
): Promise<Response | null> {
  const unavailable = () => Response.json({ error: "beta_rate_unavailable" }, {
    status: 503, headers: { "cache-control": "no-store" },
  });
  try {
    if (![env.BETA_ENROLL_RATE, env.BETA_REQUEST_RATE, env.BETA_MCP_RATE,
      env.BETA_ENROLL_GLOBAL_RATE, env.BETA_AGENT_GLOBAL_RATE, env.BETA_MCP_GLOBAL_RATE]
      .every(binding => typeof binding?.limit === "function")) return unavailable();
    const limiter = route === "enroll" ? env.BETA_ENROLL_RATE! : route === "mcp" ? env.BETA_MCP_RATE! : env.BETA_REQUEST_RATE!;
    const shared = route === "enroll" ? env.BETA_ENROLL_GLOBAL_RATE! : route === "mcp" ? env.BETA_MCP_GLOBAL_RATE! : env.BETA_AGENT_GLOBAL_RATE!;
    const routeClass = route === "enroll" ? "enroll" : route === "mcp" ? "mcp" : "agent";
    // Client rejection MUST return without charging shared capacity.
    for (const [binding, key] of [
      [limiter, `${route}:${betaClientKey(request.headers.get("cf-connecting-ip"))}`],
      [shared, `beta:${routeClass}`],
    ] as const) {
      const result = await binding.limit({ key });
      if (typeof result?.success !== "boolean") return unavailable();
      if (!result.success) return Response.json({ error: "rate_limited" }, {
        status: 429, headers: { "cache-control": "no-store", "retry-after": "60" },
      });
    }
    return null;
  } catch { return unavailable(); }
}
