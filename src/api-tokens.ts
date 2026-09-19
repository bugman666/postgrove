import type { Env } from "./env.ts";

export const API_TOKEN_PREFIX = "pg_";
const TOKEN_RANDOM_BYTES = 24;
const PREFIX_VISIBLE = 11;

export interface ApiTokenRecord {
  id: string;
  mailbox_id: string;
  token_hash: string;
  token_prefix: string;
  label: string | null;
  created_at: number;
  revoked_at: number | null;
}

export interface IssuedApiToken {
  record: ApiTokenRecord;
  token: string;
}

const TOKEN_COLUMNS =
  "id, mailbox_id, token_hash, token_prefix, label, created_at, revoked_at" as const;

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

export async function insertApiToken(
  env: Env,
  mailboxId: string,
  label: string | null,
  now = Date.now(),
): Promise<IssuedApiToken> {
  const generated = await generateApiTokenSecret();
  const record: ApiTokenRecord = {
    id: crypto.randomUUID(),
    mailbox_id: mailboxId,
    token_hash: generated.hash,
    token_prefix: generated.prefix,
    label,
    created_at: now,
    revoked_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, mailbox_id, token_hash, token_prefix, label, created_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`,
  )
    .bind(record.id, record.mailbox_id, record.token_hash, record.token_prefix, record.label, record.created_at)
    .run();
  return { record, token: generated.token };
}

export async function findApiTokenByHash(env: Env, hash: string): Promise<ApiTokenRecord | null> {
  return env.DB.prepare(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?1`)
    .bind(hash)
    .first<ApiTokenRecord>();
}

export async function listApiTokens(env: Env, mailboxId: string): Promise<ApiTokenRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${TOKEN_COLUMNS} FROM api_tokens
     WHERE mailbox_id = ?1
     ORDER BY created_at DESC`,
  )
    .bind(mailboxId)
    .all<ApiTokenRecord>();
  return rows.results ?? [];
}

export async function getApiToken(env: Env, tokenId: string): Promise<ApiTokenRecord | null> {
  return env.DB.prepare(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE id = ?1`)
    .bind(tokenId)
    .first<ApiTokenRecord>();
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
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    prefix: row.token_prefix,
    label: row.label,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    ...(plaintext ? { token: plaintext } : {}),
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
