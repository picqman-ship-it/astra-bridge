import { DurableObject } from "cloudflare:workers";
import { equalSecret, randomToken, sha256Base64Url, sha256Hex } from "./secrets";
import type { OAuthScope } from "./tool-policy";

export const CODE_TTL_MS = 5 * 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const OWNER_MAX_FAILURES = 5;
export const OWNER_WINDOW_MS = 15 * 60_000;
export const MAX_TOKEN_FAMILIES = 16;
export const CLEANUP_INTERVAL_MS = 10 * 60_000;
export const CLEANUP_BATCH = 256;
export const OWNER_SECRET_MIN_LENGTH = 32;

export const CODE_PREFIX = "astra_ac_";
export const ACCESS_TOKEN_PREFIX = "astra_at_";
export const REFRESH_TOKEN_PREFIX = "astra_rt_";
// Prefix + base64url of 32 random bytes.
const OPAQUE_BODY = "[A-Za-z0-9_-]{43}";
export const CODE_PATTERN = new RegExp(`^${CODE_PREFIX}${OPAQUE_BODY}$`);
export const ACCESS_TOKEN_PATTERN = new RegExp(`^${ACCESS_TOKEN_PREFIX}${OPAQUE_BODY}$`);
export const REFRESH_TOKEN_PATTERN = new RegExp(`^${REFRESH_TOKEN_PREFIX}${OPAQUE_BODY}$`);

// Single-owner build: every grant belongs to this one principal.
export const OWNER_SUBJECT = "owner";

const RECORD_PREFIXES = ["code:", "access:", "refresh:", "family:"] as const;
const OWNER_AUTH_KEY = "owner-auth";

export type CodeBinding = {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: OAuthScope[];
  codeChallenge: string;
};

export type OwnerAuthorization =
  | { ok: true; code: string }
  | { ok: false; error: "access_denied" }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: OAuthScope[];
};

export type TokenOutcome =
  | { ok: true; tokens: TokenSet }
  | { ok: false; error: "invalid_grant" | "invalid_scope" | "invalid_target" };

export type ExchangeRequest = {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  resource: string;
};

export type RefreshRequest = {
  refreshToken: string;
  clientId: string;
  resource?: string;
  scopes?: OAuthScope[];
};

export type AccessGrant = {
  subject: string;
  clientId: string;
  resource: string;
  scopes: OAuthScope[];
  expiresAt: number;
};

// Stored records. Keys carry SHA-256 hashes; no record holds a code or token.
type CodeRecord = CodeBinding & {
  subject: string;
  expiresAt: number;
  usedAt?: number;
  familyId?: string;
};

type FamilyRecord = {
  subject: string;
  clientId: string;
  resource: string;
  scopes: OAuthScope[];
  createdAt: number;
  expiresAt: number;
};

type TokenRecord = {
  familyId: string;
  subject: string;
  clientId: string;
  resource: string;
  scopes: OAuthScope[];
  expiresAt: number;
  rotatedAt?: number;
};

type OwnerAuthState = { windowStart: number; failures: number };

type OAuthStoreEnv = { OAUTH_OWNER_SECRET?: string };

/**
 * Persistent OAuth state for the single-owner dogfood build. One instance
 * (named "owner") holds every record. Every read-check-write sequence runs under
 * blockConcurrencyWhile, so a code or refresh token can be consumed only once and
 * parallel owner guesses cannot share one rate-limit reading, independent of
 * input-gate behavior around the crypto awaits.
 */
export class OAuthStore extends DurableObject<OAuthStoreEnv> {
  async authorizeOwner(candidate: string, binding: CodeBinding): Promise<OwnerAuthorization> {
    return this.ctx.blockConcurrencyWhile(() => this.authorizeOwnerLocked(candidate, binding));
  }

  async exchangeCode(request: ExchangeRequest): Promise<TokenOutcome> {
    return this.ctx.blockConcurrencyWhile(() => this.exchangeCodeLocked(request));
  }

  async refreshTokens(request: RefreshRequest): Promise<TokenOutcome> {
    return this.ctx.blockConcurrencyWhile(() => this.refreshTokensLocked(request));
  }

  /**
   * Counts the attempt before comparing and releases only that one reservation
   * on success, so earlier failures stay counted.
   */
  private async authorizeOwnerLocked(candidate: string, binding: CodeBinding): Promise<OwnerAuthorization> {
    const now = Date.now();
    let state = (await this.ctx.storage.get<OwnerAuthState>(OWNER_AUTH_KEY)) ?? { windowStart: now, failures: 0 };
    if (now - state.windowStart >= OWNER_WINDOW_MS) state = { windowStart: now, failures: 0 };
    if (state.failures >= OWNER_MAX_FAILURES) {
      return {
        ok: false,
        error: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil((state.windowStart + OWNER_WINDOW_MS - now) / 1000)),
      };
    }
    await this.ctx.storage.put(OWNER_AUTH_KEY, { windowStart: state.windowStart, failures: state.failures + 1 });

    const expected = this.env.OAUTH_OWNER_SECRET;
    const accepted = typeof expected === "string"
      && expected.length >= OWNER_SECRET_MIN_LENGTH
      && typeof candidate === "string"
      && await equalSecret(candidate, expected);
    if (!accepted) return { ok: false, error: "access_denied" };

    const latest = await this.ctx.storage.get<OwnerAuthState>(OWNER_AUTH_KEY);
    if (latest && latest.windowStart === state.windowStart) {
      await this.ctx.storage.put(OWNER_AUTH_KEY, { ...latest, failures: Math.max(0, latest.failures - 1) });
    }

    const code = randomToken(CODE_PREFIX);
    const record: CodeRecord = {
      clientId: binding.clientId,
      redirectUri: binding.redirectUri,
      resource: binding.resource,
      scopes: [...binding.scopes],
      codeChallenge: binding.codeChallenge,
      subject: OWNER_SUBJECT,
      expiresAt: now + CODE_TTL_MS,
    };
    await this.ctx.storage.put(`code:${await sha256Hex(code)}`, record);
    await this.ensureCleanupAlarm();
    return { ok: true, code };
  }

  /** Any presentation consumes the code; a second presentation revokes what it issued. */
  private async exchangeCodeLocked(request: ExchangeRequest): Promise<TokenOutcome> {
    const key = `code:${await sha256Hex(request.code)}`;
    const record = await this.ctx.storage.get<CodeRecord>(key);
    const now = Date.now();
    if (!record || record.expiresAt <= now) return { ok: false, error: "invalid_grant" };
    if (record.usedAt !== undefined) {
      if (record.familyId) await this.revokeFamily(record.familyId);
      return { ok: false, error: "invalid_grant" };
    }
    await this.ctx.storage.put(key, { ...record, usedAt: now });

    if (record.clientId !== request.clientId || record.redirectUri !== request.redirectUri) {
      return { ok: false, error: "invalid_grant" };
    }
    if (record.resource !== request.resource) return { ok: false, error: "invalid_target" };
    if (!(await equalSecret(await sha256Base64Url(request.codeVerifier), record.codeChallenge))) {
      return { ok: false, error: "invalid_grant" };
    }

    const familyId = crypto.randomUUID();
    await this.createFamily(familyId, {
      subject: record.subject,
      clientId: record.clientId,
      resource: record.resource,
      scopes: record.scopes,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
    });
    await this.ctx.storage.put(key, { ...record, usedAt: now, familyId });
    return this.issueTokens(familyId, now);
  }

  /**
   * Rotates the refresh token. Presenting an already-rotated token is treated as
   * theft and revokes the whole family. The family's 30-day lifetime is fixed at
   * the original authorization and is not extended by rotation.
   */
  private async refreshTokensLocked(request: RefreshRequest): Promise<TokenOutcome> {
    const key = `refresh:${await sha256Hex(request.refreshToken)}`;
    const record = await this.ctx.storage.get<TokenRecord>(key);
    const now = Date.now();
    if (!record) return { ok: false, error: "invalid_grant" };
    if (record.rotatedAt !== undefined) {
      await this.revokeFamily(record.familyId);
      return { ok: false, error: "invalid_grant" };
    }
    if (record.expiresAt <= now) return { ok: false, error: "invalid_grant" };
    const family = await this.ctx.storage.get<FamilyRecord>(`family:${record.familyId}`);
    if (!family || family.expiresAt <= now) return { ok: false, error: "invalid_grant" };
    if (record.clientId !== request.clientId) return { ok: false, error: "invalid_grant" };
    if (request.resource !== undefined && request.resource !== record.resource) {
      return { ok: false, error: "invalid_target" };
    }
    const scopes = request.scopes ?? record.scopes;
    if (scopes.length === 0 || scopes.some((scope) => !record.scopes.includes(scope))) {
      return { ok: false, error: "invalid_scope" };
    }

    await this.ctx.storage.put(key, { ...record, rotatedAt: now });
    return this.issueTokens(record.familyId, now, scopes);
  }

  async verifyAccessToken(token: string): Promise<AccessGrant | null> {
    const record = await this.ctx.storage.get<TokenRecord>(`access:${await sha256Hex(token)}`);
    const now = Date.now();
    if (!record || record.expiresAt <= now) return null;
    const family = await this.ctx.storage.get<FamilyRecord>(`family:${record.familyId}`);
    if (!family || family.expiresAt <= now) return null;
    return {
      subject: record.subject,
      clientId: record.clientId,
      resource: record.resource,
      scopes: [...record.scopes],
      expiresAt: record.expiresAt,
    };
  }

  private async createFamily(familyId: string, family: FamilyRecord): Promise<void> {
    // Bound live grants: authorizing again beyond the cap revokes the oldest grant.
    const existing = [...(await this.ctx.storage.list<FamilyRecord>({ prefix: "family:" }))]
      .sort(([, a], [, b]) => a.createdAt - b.createdAt);
    const excess = existing.length - (MAX_TOKEN_FAMILIES - 1);
    if (excess > 0) {
      const oldest = existing.slice(0, excess).map(([key]) => key);
      for (let i = 0; i < oldest.length; i += 128) await this.ctx.storage.delete(oldest.slice(i, i + 128));
    }
    await this.ctx.storage.put(`family:${familyId}`, family);
  }

  /** Revocation deletes the family; every token that references it then fails verification. */
  private async revokeFamily(familyId: string): Promise<void> {
    await this.ctx.storage.delete(`family:${familyId}`);
  }

  private async issueTokens(familyId: string, now: number, narrowed?: OAuthScope[]): Promise<TokenOutcome> {
    const family = await this.ctx.storage.get<FamilyRecord>(`family:${familyId}`);
    if (!family) return { ok: false, error: "invalid_grant" };
    const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
    const refreshToken = randomToken(REFRESH_TOKEN_PREFIX);
    const accessScopes = narrowed ?? family.scopes;
    const accessExpiresAt = Math.min(now + ACCESS_TOKEN_TTL_MS, family.expiresAt);
    const base = {
      familyId,
      subject: family.subject,
      clientId: family.clientId,
      resource: family.resource,
    };
    const [accessHash, refreshHash] = await Promise.all([sha256Hex(accessToken), sha256Hex(refreshToken)]);
    await this.ctx.storage.put({
      [`access:${accessHash}`]: { ...base, scopes: [...accessScopes], expiresAt: accessExpiresAt } satisfies TokenRecord,
      // RFC 6749 §6: a rotated refresh token keeps the scope of the one it replaces.
      [`refresh:${refreshHash}`]: { ...base, scopes: [...family.scopes], expiresAt: family.expiresAt } satisfies TokenRecord,
    });
    await this.ensureCleanupAlarm();
    return {
      ok: true,
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: Math.floor((accessExpiresAt - now) / 1000),
        scopes: [...accessScopes],
      },
    };
  }

  private async ensureCleanupAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    }
  }

  /**
   * Deletes expired records, at most CLEANUP_BATCH keys per prefix per run. A
   * cursor per prefix resumes the scan, so every key is eventually visited.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let more = false;

    for (const prefix of RECORD_PREFIXES) {
      const cursorKey = `cleanup-cursor:${prefix}`;
      const cursor = await this.ctx.storage.get<string>(cursorKey);
      const entries = await this.ctx.storage.list<{ expiresAt?: unknown }>({
        prefix,
        limit: CLEANUP_BATCH,
        ...(cursor ? { startAfter: cursor } : {}),
      });
      const expired: string[] = [];
      let lastKey: string | undefined;
      for (const [key, record] of entries) {
        lastKey = key;
        const expiresAt = typeof record?.expiresAt === "number" ? record.expiresAt : 0;
        if (expiresAt <= now) expired.push(key);
      }
      for (let i = 0; i < expired.length; i += 128) {
        await this.ctx.storage.delete(expired.slice(i, i + 128));
      }
      if (entries.size === CLEANUP_BATCH && lastKey) {
        await this.ctx.storage.put(cursorKey, lastKey);
        more = true;
      } else {
        // End of this prefix; the next pass starts from the beginning again.
        await this.ctx.storage.delete(cursorKey);
      }
    }

    const owner = await this.ctx.storage.get<OwnerAuthState>(OWNER_AUTH_KEY);
    if (owner && now - owner.windowStart >= OWNER_WINDOW_MS) await this.ctx.storage.delete(OWNER_AUTH_KEY);

    if (more) {
      await this.ctx.storage.setAlarm(now + 1_000);
      return;
    }
    for (const prefix of RECORD_PREFIXES) {
      if ((await this.ctx.storage.list({ prefix, limit: 1 })).size > 0) {
        await this.ctx.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
        return;
      }
    }
  }
}
