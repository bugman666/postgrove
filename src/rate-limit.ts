import type { Env } from "./env.ts";
import { json } from "./http.ts";

export const REST_RATE_LIMIT_MAX = 60;
export const REST_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const SIGNUP_RATE_LIMIT_MAX = 5;
export const SIGNUP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const LOGIN_RATE_LIMIT_MAX = 8;
export const LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/** Workers KV rejects expirationTtl below 60 seconds. */
export const KV_MIN_EXPIRATION_TTL_SECONDS = 60;

const RATE_LIMIT_PRUNE_AT = 512;
const KV_KEY_PREFIX = "rl:";

type Bucket = { count: number; resetAt: number };

/** Best-effort per-isolate counters. Used when RATE_LIMIT is unbound or KV throws. */
const buckets = new Map<string, Bucket>();

export interface RateLimitConfig {
  max: number;
  windowMs: number;
  hint: string;
}

export type RateLimitResult = { ok: true } | { ok: false; response: Response };

/**
 * Minimal KV surface for the limiter. Workers `KVNamespace` satisfies this.
 * Tests can pass a Map-backed fake.
 */
export interface RateLimitStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export type RateLimitEnv = Pick<Env, "RATE_LIMIT"> | { RATE_LIMIT?: RateLimitStore };

/**
 * Fixed-window limiter for login / REST / signup.
 *
 * When `env.RATE_LIMIT` is bound, counters live in Workers KV so isolates share
 * a window. Pattern (Workers KV fixed-window): one key per caller, JSON
 * `{count, resetAt}`, `expirationTtl` so stale keys drop. get-then-put is not
 * compare-and-swap — two concurrent requests can both read N and both write
 * N+1, so a couple of extra requests can slip through. KV reads are also
 * eventually consistent (default ~60s cache) and the platform allows one write
 * per key per second; a rejected put falls back to the isolate Map. That
 * residual is accepted for this cut (KV is enough for soft fixed windows; a
 * Durable Object would serialize).
 *
 * Without the binding, the in-memory Map is used (local Wrangler / unit tests).
 */
export async function consumeRateLimit(
  env: RateLimitEnv,
  key: string,
  config: RateLimitConfig,
  now = Date.now(),
): Promise<RateLimitResult> {
  const store = env.RATE_LIMIT;
  if (store) {
    try {
      return await consumeShared(store, key, config, now);
    } catch {
      // KV get/put failed (outage or 1-write-per-key-per-second). Isolate Map still applies.
    }
  }
  return consumeMemory(key, config, now);
}

export function restRateLimitConfig(max = REST_RATE_LIMIT_MAX, windowMs = REST_RATE_LIMIT_WINDOW_MS): RateLimitConfig {
  return {
    max,
    windowMs,
    hint: `Too many REST API requests from this token or network. Limit is ${max} per ${Math.round(windowMs / 1000)} seconds. Wait and retry.`,
  };
}

export function signupRateLimitConfig(
  max = SIGNUP_RATE_LIMIT_MAX,
  windowMs = SIGNUP_RATE_LIMIT_WINDOW_MS,
): RateLimitConfig {
  return {
    max,
    windowMs,
    hint: `Too many public signup attempts from this network. Limit is ${max} per ${Math.round(windowMs / 60_000)} minutes. Wait and retry.`,
  };
}

export function loginRateLimitConfig(
  max = LOGIN_RATE_LIMIT_MAX,
  windowMs = LOGIN_RATE_LIMIT_WINDOW_MS,
): RateLimitConfig {
  return {
    max,
    windowMs,
    hint: `Too many login attempts from this network. Wait a few minutes and try again (${max} per ${windowMs / 60_000} minutes per IP).`,
  };
}

/** CF-Connecting-IP, else first X-Forwarded-For hop — same as login. */
export function clientKey(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) {
    return `ip:${cf}`;
  }
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) {
    return `ip:${forwarded}`;
  }
  return "ip:unknown";
}

/** KV key for a limiter identity (`login:…`, `rest:…`, `signup:…`). */
export function rateLimitStorageKey(key: string): string {
  return `${KV_KEY_PREFIX}${key}`;
}

function consumeMemory(key: string, config: RateLimitConfig, now: number): RateLimitResult {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + config.windowMs });
    pruneRateLimits(now);
    return { ok: true };
  }
  if (existing.count >= config.max) {
    return limited(existing, config, now);
  }
  existing.count += 1;
  return { ok: true };
}

async function consumeShared(
  store: RateLimitStore,
  key: string,
  config: RateLimitConfig,
  now: number,
): Promise<RateLimitResult> {
  const storageKey = rateLimitStorageKey(key);
  const existing = parseBucket(await store.get(storageKey));
  if (!existing || existing.resetAt <= now) {
    const bucket = { count: 1, resetAt: now + config.windowMs };
    await store.put(storageKey, serializeBucket(bucket), {
      expirationTtl: expirationTtlSeconds(bucket.resetAt, now),
    });
    return { ok: true };
  }
  if (existing.count >= config.max) {
    return limited(existing, config, now);
  }
  const next = { count: existing.count + 1, resetAt: existing.resetAt };
  await store.put(storageKey, serializeBucket(next), {
    expirationTtl: expirationTtlSeconds(next.resetAt, now),
  });
  return { ok: true };
}

function limited(bucket: Bucket, config: RateLimitConfig, now: number): RateLimitResult {
  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return {
    ok: false,
    response: json(
      {
        ok: false,
        error: "rate_limited",
        hint: config.hint,
        retry_after_seconds: retryAfter,
      },
      429,
      { "retry-after": String(retryAfter) },
    ),
  };
}

function parseBucket(raw: string | null): Bucket | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Bucket>;
    if (
      typeof parsed.count !== "number" ||
      !Number.isFinite(parsed.count) ||
      typeof parsed.resetAt !== "number" ||
      !Number.isFinite(parsed.resetAt)
    ) {
      return null;
    }
    return { count: parsed.count, resetAt: parsed.resetAt };
  } catch {
    return null;
  }
}

function serializeBucket(bucket: Bucket): string {
  return JSON.stringify(bucket);
}

function expirationTtlSeconds(resetAt: number, now: number): number {
  const remaining = Math.ceil((resetAt - now) / 1000);
  return Math.max(KV_MIN_EXPIRATION_TTL_SECONDS, remaining);
}

function pruneRateLimits(now: number): void {
  if (buckets.size < RATE_LIMIT_PRUNE_AT) {
    return;
  }
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

/** Test helper: drop in-memory login / REST / signup counters. Does not clear KV. */
export function resetRateLimitForTests(): void {
  buckets.clear();
}
