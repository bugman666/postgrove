import type { Env } from "./env.ts";
import { formatBytes } from "./attachment-limits.ts";
import { t, type Locale } from "./i18n.ts";
import type { UserRecord } from "./users.ts";

export type QuotaKind = "quota_addresses" | "quota_storage" | "quota_send" | "quota_api";

export interface QuotaError {
  error: QuotaKind;
  hint: string;
  used: number;
  limit: number;
}

export interface UserUsageSnapshot {
  addresses: number;
  storage_bytes: number;
  send_today: number;
  day: string;
}

/** 0 means unlimited — same convention as cloud-mail sendCount / accountCount. */
export function isUnlimited(limit: number): boolean {
  return limit === 0;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function userUsage(env: Env, userId: string, now = Date.now()): Promise<UserUsageSnapshot> {
  const day = utcDay(now);
  const [addresses, storage, send] = await Promise.all([
    countBoundAddresses(env, userId),
    sumBoundStorage(env, userId),
    sendCountForDay(env, userId, day),
  ]);
  return {
    addresses,
    storage_bytes: storage,
    send_today: send,
    day,
  };
}

export async function checkAddressQuota(
  env: Env,
  user: UserRecord,
  locale: Locale = "zh",
): Promise<QuotaError | null> {
  if (isUnlimited(user.quota_addresses)) {
    return null;
  }
  const used = await countBoundAddresses(env, user.id);
  if (used >= user.quota_addresses) {
    return {
      error: "quota_addresses",
      hint: addressHint(used, user.quota_addresses, locale),
      used,
      limit: user.quota_addresses,
    };
  }
  return null;
}

export async function checkStorageQuota(
  env: Env,
  user: UserRecord,
  incomingBytes: number,
  locale: Locale = "zh",
): Promise<QuotaError | null> {
  if (isUnlimited(user.quota_storage_bytes)) {
    return null;
  }
  const used = await sumBoundStorage(env, user.id);
  const next = used + Math.max(0, incomingBytes);
  if (next > user.quota_storage_bytes) {
    return {
      error: "quota_storage",
      hint: storageHint(used, incomingBytes, user.quota_storage_bytes, locale),
      used,
      limit: user.quota_storage_bytes,
    };
  }
  return null;
}

export async function checkSendQuota(
  env: Env,
  user: UserRecord,
  now = Date.now(),
  locale: Locale = "zh",
): Promise<QuotaError | null> {
  if (isUnlimited(user.quota_send_daily)) {
    return null;
  }
  const day = utcDay(now);
  const used = await sendCountForDay(env, user.id, day);
  if (used >= user.quota_send_daily) {
    return {
      error: "quota_send",
      hint: sendHint(used, user.quota_send_daily, day, locale),
      used,
      limit: user.quota_send_daily,
    };
  }
  return null;
}

/**
 * Inbound storage check for every user bound to the recipient mailbox.
 * Unbound (owner-only) mailboxes skip per-user storage quotas.
 */
export async function inboundStorageRejection(
  env: Env,
  mailboxId: string,
  incomingBytes: number,
): Promise<QuotaError | null> {
  const users = await env.DB.prepare(
    `SELECT id, quota_storage_bytes FROM users
     WHERE status = 'active'
       AND id IN (SELECT user_id FROM user_mailboxes WHERE mailbox_id = ?1)`,
  )
    .bind(mailboxId)
    .all<{ id: string; quota_storage_bytes: number }>();

  for (const row of users.results ?? []) {
    if (isUnlimited(row.quota_storage_bytes)) {
      continue;
    }
    const used = await sumBoundStorage(env, row.id);
    const next = used + Math.max(0, incomingBytes);
    if (next > row.quota_storage_bytes) {
      return {
        error: "quota_storage",
        hint: storageHint(used, incomingBytes, row.quota_storage_bytes, "zh"),
        used,
        limit: row.quota_storage_bytes,
      };
    }
  }
  return null;
}

export async function incrementSendUsage(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<number> {
  const day = utcDay(now);
  await env.DB.prepare(
    `INSERT INTO send_usage (user_id, day, count) VALUES (?1, ?2, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`,
  )
    .bind(userId, day)
    .run();
  return sendCountForDay(env, userId, day);
}

export async function countBoundAddresses(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user_mailboxes WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function sumBoundStorage(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS used FROM messages
     WHERE mailbox_id IN (SELECT mailbox_id FROM user_mailboxes WHERE user_id = ?1)`,
  )
    .bind(userId)
    .first<{ used: number }>();
  return Number(row?.used ?? 0);
}

export async function sendCountForDay(env: Env, userId: string, day: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT count FROM send_usage WHERE user_id = ?1 AND day = ?2`,
  )
    .bind(userId, day)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function checkTokenRequestQuota(
  env: Env,
  tokenId: string,
  limit: number,
  now = Date.now(),
  locale: Locale = "zh",
): Promise<QuotaError | null> {
  if (isUnlimited(limit)) {
    return null;
  }
  const day = utcDay(now);
  const used = await tokenRequestCountForDay(env, tokenId, day);
  if (used >= limit) {
    return {
      error: "quota_api",
      hint: apiHint(used, limit, day, locale),
      used,
      limit,
    };
  }
  return null;
}

export async function incrementTokenRequestUsage(
  env: Env,
  tokenId: string,
  now = Date.now(),
): Promise<number> {
  const day = utcDay(now);
  await env.DB.prepare(
    `INSERT INTO api_token_usage (token_id, day, request_count, send_count) VALUES (?1, ?2, 1, 0)
     ON CONFLICT(token_id, day) DO UPDATE SET request_count = request_count + 1`,
  )
    .bind(tokenId, day)
    .run();
  return tokenRequestCountForDay(env, tokenId, day);
}

export async function checkTokenSendQuota(
  env: Env,
  tokenId: string,
  limit: number,
  now = Date.now(),
  locale: Locale = "zh",
): Promise<QuotaError | null> {
  if (isUnlimited(limit)) {
    return null;
  }
  const day = utcDay(now);
  const used = await tokenSendCountForDay(env, tokenId, day);
  if (used >= limit) {
    return {
      error: "quota_send",
      hint: sendHint(used, limit, day, locale),
      used,
      limit,
    };
  }
  return null;
}

export async function incrementTokenSendUsage(
  env: Env,
  tokenId: string,
  now = Date.now(),
): Promise<number> {
  const day = utcDay(now);
  await env.DB.prepare(
    `INSERT INTO api_token_usage (token_id, day, request_count, send_count) VALUES (?1, ?2, 0, 1)
     ON CONFLICT(token_id, day) DO UPDATE SET send_count = send_count + 1`,
  )
    .bind(tokenId, day)
    .run();
  return tokenSendCountForDay(env, tokenId, day);
}

export async function tokenRequestCountForDay(env: Env, tokenId: string, day: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT request_count FROM api_token_usage WHERE token_id = ?1 AND day = ?2`,
  )
    .bind(tokenId, day)
    .first<{ request_count: number }>();
  return Number(row?.request_count ?? 0);
}

export async function tokenSendCountForDay(env: Env, tokenId: string, day: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT send_count FROM api_token_usage WHERE token_id = ?1 AND day = ?2`,
  )
    .bind(tokenId, day)
    .first<{ send_count: number }>();
  return Number(row?.send_count ?? 0);
}

function apiHint(used: number, limit: number, day: string, locale: Locale = "zh"): string {
  if (locale === "en") {
    return t("en", "quota.api-used", { used, limit, day });
  }
  return `今日 API 请求配额已用完（${used} / ${limit}，UTC ${day}）。明天零点（UTC）重置，或为这把钥匙提高日请求上限。`;
}

function addressHint(used: number, limit: number, locale: Locale = "zh"): string {
  if (locale === "en") {
    return t("en", "quota.addresses-full", { used, limit });
  }
  return `地址配额已满（已用 ${used} / 上限 ${limit}）。向值守申请提高配额，或停用一个旧地址后再开新的。`;
}

function storageHint(
  used: number,
  incoming: number,
  limit: number,
  locale: Locale = "zh",
): string {
  if (locale === "en") {
    return t("en", "quota.storage-used", {
      used: formatBytes(used),
      incoming: formatBytes(incoming),
      limit: formatBytes(limit),
    });
  }
  return `存储配额不足（已用 ${formatBytes(used)}，本封 ${formatBytes(incoming)}，上限 ${formatBytes(limit)}）。清一清旧信或提高该成员的存储配额。`;
}

function sendHint(used: number, limit: number, day: string, locale: Locale = "zh"): string {
  if (locale === "en") {
    return t("en", "quota.send-used", { used, limit, day });
  }
  return `今日发送配额已用完（${used} / ${limit}，UTC ${day}）。明天零点（UTC）重置，或向值守申请提高日发送上限。`;
}
