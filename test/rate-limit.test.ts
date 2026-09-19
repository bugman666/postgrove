import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  KV_MIN_EXPIRATION_TTL_SECONDS,
  consumeRateLimit,
  rateLimitStorageKey,
  resetRateLimitForTests,
  type RateLimitStore,
} from "../src/rate-limit.ts";

const CONFIG = { max: 2, windowMs: 60_000, hint: "slow down" };

class MemoryKV implements RateLimitStore {
  store = new Map<string, { value: string; expiresAt?: number }>();
  puts = 0;

  async get(key: string): Promise<string | null> {
    const row = this.store.get(key);
    if (!row) {
      return null;
    }
    if (row.expiresAt !== undefined && row.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts += 1;
    const expiresAt =
      options?.expirationTtl !== undefined ? Date.now() + options.expirationTtl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
  }
}

beforeEach(() => {
  resetRateLimitForTests();
});

test("in-memory fallback limits after max without a KV binding", async () => {
  const env = {};
  const first = await consumeRateLimit(env, "rest:token:a", CONFIG);
  const second = await consumeRateLimit(env, "rest:token:a", CONFIG);
  const third = await consumeRateLimit(env, "rest:token:a", CONFIG);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  if (!third.ok) {
    assert.equal(third.response.status, 429);
    assert.ok(third.response.headers.get("retry-after"));
    const body = (await third.response.json()) as { error: string; hint: string };
    assert.equal(body.error, "rate_limited");
    assert.equal(body.hint, CONFIG.hint);
  }

  const other = await consumeRateLimit(env, "rest:token:b", CONFIG);
  assert.equal(other.ok, true);
});

test("fake KV Map shares a window across consume calls", async () => {
  const kv = new MemoryKV();
  const env = { RATE_LIMIT: kv };
  const first = await consumeRateLimit(env, "login:ip:203.0.113.8", CONFIG);
  const second = await consumeRateLimit(env, "login:ip:203.0.113.8", CONFIG);
  const third = await consumeRateLimit(env, "login:ip:203.0.113.8", CONFIG);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);

  const stored = await kv.get(rateLimitStorageKey("login:ip:203.0.113.8"));
  assert.ok(stored);
  const bucket = JSON.parse(stored) as { count: number; resetAt: number };
  assert.equal(bucket.count, 2);
  assert.ok(bucket.resetAt > Date.now());
  assert.ok(kv.puts >= 2);
});

test("expired KV window starts a fresh count", async () => {
  const kv = new MemoryKV();
  const env = { RATE_LIMIT: kv };
  const t0 = 1_000_000;
  assert.equal((await consumeRateLimit(env, "signup:ip:1", CONFIG, t0)).ok, true);
  assert.equal((await consumeRateLimit(env, "signup:ip:1", CONFIG, t0 + 1)).ok, true);
  assert.equal((await consumeRateLimit(env, "signup:ip:1", CONFIG, t0 + 2)).ok, false);
  assert.equal((await consumeRateLimit(env, "signup:ip:1", CONFIG, t0 + CONFIG.windowMs + 1)).ok, true);
});

test("KV put uses expirationTtl at least the Workers 60s minimum", async () => {
  const kv = new MemoryKV();
  let seenTtl: number | undefined;
  const original = kv.put.bind(kv);
  kv.put = async (key, value, options) => {
    seenTtl = options?.expirationTtl;
    return original(key, value, options);
  };
  await consumeRateLimit({ RATE_LIMIT: kv }, "rest:token:ttl", { max: 5, windowMs: 1_000, hint: "x" });
  assert.equal(seenTtl, KV_MIN_EXPIRATION_TTL_SECONDS);
});

test("corrupt KV value is treated as a new window", async () => {
  const kv = new MemoryKV();
  await kv.put(rateLimitStorageKey("rest:token:bad"), "not-json");
  const result = await consumeRateLimit({ RATE_LIMIT: kv }, "rest:token:bad", CONFIG);
  assert.equal(result.ok, true);
  const stored = await kv.get(rateLimitStorageKey("rest:token:bad"));
  assert.ok(stored);
  assert.equal((JSON.parse(stored) as { count: number }).count, 1);
});

test("KV throw falls back to the in-memory Map", async () => {
  const broken: RateLimitStore = {
    async get() {
      throw new Error("kv down");
    },
    async put() {
      throw new Error("kv down");
    },
  };
  const env = { RATE_LIMIT: broken };
  assert.equal((await consumeRateLimit(env, "rest:token:fallback", CONFIG)).ok, true);
  assert.equal((await consumeRateLimit(env, "rest:token:fallback", CONFIG)).ok, true);
  const limited = await consumeRateLimit(env, "rest:token:fallback", CONFIG);
  assert.equal(limited.ok, false);
});
