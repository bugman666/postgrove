import { json } from "./http.ts";

export const REST_RATE_LIMIT_MAX = 60;
export const REST_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const SIGNUP_RATE_LIMIT_MAX = 5;
export const SIGNUP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const RATE_LIMIT_PRUNE_AT = 512;

type Bucket = { count: number; resetAt: number };

/** Best-effort per-isolate counters. A new isolate starts a fresh window. */
const buckets = new Map<string, Bucket>();

export interface RateLimitConfig {
  max: number;
  windowMs: number;
  hint: string;
}

export type RateLimitResult = { ok: true } | { ok: false; response: Response };

/**
 * Fixed-window limiter, same style as POST /auth/login in src/auth.ts.
 * Keyed by caller (token id or IP). Not a shared store — enough for one box.
 */
export function consumeRateLimit(
  key: string,
  config: RateLimitConfig,
  now = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + config.windowMs });
    pruneRateLimits(now);
    return { ok: true };
  }
  if (existing.count >= config.max) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
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
  existing.count += 1;
  return { ok: true };
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

/** Test helper: drop in-memory REST / signup counters. */
export function resetRateLimitForTests(): void {
  buckets.clear();
}
