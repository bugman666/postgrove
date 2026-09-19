import type { Env } from "./env.ts";

export const API_TOKEN_PREFIX = "pg_";
const TOKEN_RANDOM_BYTES = 24;
const PREFIX_VISIBLE = 11;

export type ApiTokenKind = "mailbox" | "admin";

export interface ApiTokenRecord {
  id: string;
  mailbox_id: string;
  token_hash: string;
  token_prefix: string;
  label: string | null;
  created_at: number;
  revoked_at: number | null;
  kind: ApiTokenKind;
  quota_requests_daily: number;
  quota_send_daily: number;
}

export interface IssuedApiToken {
  record: ApiTokenRecord;
  token: string;
}

const TOKEN_COLUMNS =
  "id, mailbox_id, token_hash, token_prefix, label, created_at, revoked_at, kind, quota_requests_daily, quota_send_daily" as const;

export function normalizeTokenKind(value: unknown): ApiTokenKind {
  return value === "admin" ? "admin" : "mailbox";
}

export function normalizeQuotaLimit(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.floor(n);
}

export async function hashApiToken(plaintext: string): Promise<string> {
  const bytes = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

export async function generateApiTokenSecret(): Promise<{ token: string; hash: string; prefix: string }> {
  const random = new Uint8Array(TOKEN_RANDOM_BYTES);
  crypto.getRandomValues(random);
  const token = `${API_TOKEN_PREFIX}${bytesToB64url(random)}`;
  const hash = await hashApiToken(token);
  return { token, hash, prefix: token.slice(0, PREFIX_VISIBLE) };
}

export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX) && value.length > API_TOKEN_PREFIX.length + 8;
}

export interface InsertApiTokenOptions {
  now?: number;
  kind?: ApiTokenKind;
  quotaRequestsDaily?: number;
  quotaSendDaily?: number;
}

export async function insertApiToken(
  env: Env,
  mailboxId: string,
  label: string | null,
  options: InsertApiTokenOptions = {},
): Promise<IssuedApiToken> {
  const generated = await generateApiTokenSecret();
  const record: ApiTokenRecord = {
    id: crypto.randomUUID(),
    mailbox_id: mailboxId,
    token_hash: generated.hash,
    token_prefix: generated.prefix,
    label,
    created_at: options.now ?? Date.now(),
    revoked_at: null,
    kind: normalizeTokenKind(options.kind),
    quota_requests_daily: normalizeQuotaLimit(options.quotaRequestsDaily),
    quota_send_daily: normalizeQuotaLimit(options.quotaSendDaily),
  };
  await env.DB.prepare(
    `INSERT INTO api_tokens (
       id, mailbox_id, token_hash, token_prefix, label, created_at, revoked_at,
       kind, quota_requests_daily, quota_send_daily
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)`,
  )
    .bind(
      record.id,
      record.mailbox_id,
      record.token_hash,
      record.token_prefix,
      record.label,
      record.created_at,
      record.kind,
      record.quota_requests_daily,
      record.quota_send_daily,
    )
    .run();
  return { record, token: generated.token };
}

export async function findApiTokenByHash(env: Env, hash: string): Promise<ApiTokenRecord | null> {
  const row = await env.DB.prepare(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?1`)
    .bind(hash)
    .first<ApiTokenRecord>();
  return row ? hydrateToken(row) : null;
}

export async function listApiTokens(env: Env, mailboxId: string): Promise<ApiTokenRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${TOKEN_COLUMNS} FROM api_tokens
     WHERE mailbox_id = ?1
     ORDER BY created_at DESC`,
  )
    .bind(mailboxId)
    .all<ApiTokenRecord>();
  return (rows.results ?? []).map(hydrateToken);
}

export async function getApiToken(env: Env, tokenId: string): Promise<ApiTokenRecord | null> {
  const row = await env.DB.prepare(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE id = ?1`)
    .bind(tokenId)
    .first<ApiTokenRecord>();
  return row ? hydrateToken(row) : null;
}

export async function revokeApiToken(
  env: Env,
  tokenId: string,
  mailboxId: string | null,
  now = Date.now(),
): Promise<ApiTokenRecord | null> {
  const existing = await getApiToken(env, tokenId);
  if (!existing) {
    return null;
  }
  if (mailboxId && existing.mailbox_id !== mailboxId) {
    return null;
  }
  if (existing.revoked_at) {
    return existing;
  }
  await env.DB.prepare(`UPDATE api_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`)
    .bind(tokenId, now)
    .run();
  return { ...existing, revoked_at: now };
}

export function publicToken(row: ApiTokenRecord, plaintext?: string) {
  const hydrated = hydrateToken(row);
  return {
    id: hydrated.id,
    mailbox_id: hydrated.mailbox_id,
    prefix: hydrated.token_prefix,
    label: hydrated.label,
    kind: hydrated.kind,
    quota_requests_daily: hydrated.quota_requests_daily,
    quota_send_daily: hydrated.quota_send_daily,
    created_at: hydrated.created_at,
    revoked_at: hydrated.revoked_at,
    ...(plaintext ? { token: plaintext } : {}),
  };
}

function hydrateToken(row: ApiTokenRecord): ApiTokenRecord {
  return {
    ...row,
    kind: normalizeTokenKind(row.kind),
    quota_requests_daily: normalizeQuotaLimit(row.quota_requests_daily),
    quota_send_daily: normalizeQuotaLimit(row.quota_send_daily),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
