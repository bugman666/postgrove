import type { Env } from "./env.ts";
import type { MailboxRecord } from "./store.ts";

export type MailboxAccess = {
  kind: "owner" | "mailbox";
  mailboxId: string;
  address: string;
  mailboxIds?: string[];
};

export type UserRole = "admin" | "mailbox";
export type UserStatus = "active" | "disabled";

export interface UserRecord {
  id: string;
  login: string;
  display_name: string | null;
  role: UserRole;
  status: UserStatus;
  token_salt: string | null;
  token_hash: string | null;
  quota_addresses: number;
  quota_storage_bytes: number;
  quota_send_daily: number;
  created_at: number;
  updated_at: number;
}

export interface UserMailboxBind {
  user_id: string;
  mailbox_id: string;
  created_at: number;
}

const USER_COLUMNS = `id, login, display_name, role, status, token_salt, token_hash,
  quota_addresses, quota_storage_bytes, quota_send_daily, created_at, updated_at`;

export const DEFAULT_QUOTA_ADDRESSES = 3;
export const DEFAULT_QUOTA_STORAGE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_QUOTA_SEND_DAILY = 50;

export function isUserRole(value: string): value is UserRole {
  return value === "admin" || value === "mailbox";
}

export function isUserStatus(value: string): value is UserStatus {
  return value === "active" || value === "disabled";
}

export function mailboxAllowed(actor: MailboxAccess, mailbox: MailboxRecord): boolean {
  if (actor.kind === "owner") {
    return mailbox.id === actor.mailboxId || mailbox.address === actor.address;
  }
  return (actor.mailboxIds ?? []).includes(mailbox.id);
}

export function publicUser(row: UserRecord, usage?: UserUsage) {
  return {
    id: row.id,
    login: row.login,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    quotas: {
      addresses: row.quota_addresses,
      storage_bytes: row.quota_storage_bytes,
      send_daily: row.quota_send_daily,
    },
    usage: usage ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface UserUsage {
  addresses: number;
  storage_bytes: number;
  send_today: number;
  day: string;
}

export async function listUsers(env: Env): Promise<UserRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC, login ASC`,
  ).all<UserRecord>();
  return rows.results ?? [];
}

export async function getUser(env: Env, idOrLogin: string): Promise<UserRecord | null> {
  const key = idOrLogin.trim();
  if (!key) {
    return null;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    const byId = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`)
      .bind(key)
      .first<UserRecord>();
    if (byId) {
      return byId;
    }
  }
  return env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE login = ?1 COLLATE NOCASE`)
    .bind(key.toLowerCase())
    .first<UserRecord>();
}

export async function listUserMailboxIds(env: Env, userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT mailbox_id FROM user_mailboxes WHERE user_id = ?1 ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<{ mailbox_id: string }>();
  return (rows.results ?? []).map((row) => row.mailbox_id);
}

export async function listUsersForMailbox(env: Env, mailboxId: string): Promise<UserRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users
     WHERE id IN (SELECT user_id FROM user_mailboxes WHERE mailbox_id = ?1)
     ORDER BY created_at ASC`,
  )
    .bind(mailboxId)
    .all<UserRecord>();
  return rows.results ?? [];
}

export async function countUserAddresses(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user_mailboxes WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function bindUserMailbox(
  env: Env,
  userId: string,
  mailboxId: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_mailboxes (user_id, mailbox_id, created_at)
     VALUES (?1, ?2, ?3)`,
  )
    .bind(userId, mailboxId, now)
    .run();
}

export async function findUserByMailboxToken(
  env: Env,
  mailboxId: string,
  token: string,
): Promise<UserRecord | null> {
  const rows = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users
     WHERE status = 'active'
       AND id IN (SELECT user_id FROM user_mailboxes WHERE mailbox_id = ?1)`,
  )
    .bind(mailboxId)
    .all<UserRecord>();
  for (const row of rows.results ?? []) {
    if (!row.token_salt || !row.token_hash) {
      continue;
    }
    const digest = await hashUserToken(token, row.token_salt);
    if (timingSafeEqualHex(digest, row.token_hash)) {
      return row;
    }
  }
  return null;
}

export interface CreateUserInput {
  login: string;
  displayName?: string | null;
  role: UserRole;
  token?: string | null;
  status?: UserStatus;
  quotaAddresses?: number;
  quotaStorageBytes?: number;
  quotaSendDaily?: number;
}

export async function createUser(
  env: Env,
  input: CreateUserInput,
  now = Date.now(),
): Promise<{ user: UserRecord; token: string | null }> {
  const login = normalizeLogin(input.login);
  if (!login) {
    throw new UserInputError("invalid_request", "login must be 2–64 characters (letters, numbers, . _ - @).");
  }
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE login = ?1 COLLATE NOCASE`)
    .bind(login)
    .first<{ id: string }>();
  if (existing) {
    throw new UserInputError("login_taken", "That login is already in use.");
  }

  const defaults = input.role === "admin"
    ? { addresses: 0, storage: 0, send: 0 }
    : {
        addresses: DEFAULT_QUOTA_ADDRESSES,
        storage: DEFAULT_QUOTA_STORAGE_BYTES,
        send: DEFAULT_QUOTA_SEND_DAILY,
      };
  const quotas = {
    addresses: normalizeQuota(input.quotaAddresses, defaults.addresses),
    storage: normalizeQuota(input.quotaStorageBytes, defaults.storage),
    send: normalizeQuota(input.quotaSendDaily, defaults.send),
  };

  let token: string | null = null;
  let salt: string | null = null;
  let hash: string | null = null;
  const rawToken = input.token?.trim() || generateUserToken();
  if (rawToken.length < 8) {
    throw new UserInputError("invalid_request", "User token must be at least 8 characters.");
  }
  token = rawToken;
  salt = generateSalt();
  hash = await hashUserToken(token, salt);

  const row: UserRecord = {
    id: crypto.randomUUID(),
    login,
    display_name: input.displayName?.trim() || null,
    role: input.role,
    status: input.status ?? "active",
    token_salt: salt,
    token_hash: hash,
    quota_addresses: quotas.addresses,
    quota_storage_bytes: quotas.storage,
    quota_send_daily: quotas.send,
    created_at: now,
    updated_at: now,
  };

  await env.DB.prepare(
    `INSERT INTO users (
       id, login, display_name, role, status, token_salt, token_hash,
       quota_addresses, quota_storage_bytes, quota_send_daily, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      row.id,
      row.login,
      row.display_name,
      row.role,
      row.status,
      row.token_salt,
      row.token_hash,
      row.quota_addresses,
      row.quota_storage_bytes,
      row.quota_send_daily,
      row.created_at,
      row.updated_at,
    )
    .run();

  return { user: row, token };
}

export async function setUserStatus(
  env: Env,
  userId: string,
  status: UserStatus,
  now = Date.now(),
): Promise<UserRecord | null> {
  const result = await env.DB.prepare(
    `UPDATE users SET status = ?2, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(userId, status, now)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return null;
  }
  return getUser(env, userId);
}

export async function setUserQuotas(
  env: Env,
  userId: string,
  quotas: {
    quotaAddresses?: number;
    quotaStorageBytes?: number;
    quotaSendDaily?: number;
  },
  now = Date.now(),
): Promise<UserRecord | null> {
  const existing = await getUser(env, userId);
  if (!existing) {
    return null;
  }
  const next = {
    addresses: normalizeQuota(quotas.quotaAddresses, existing.quota_addresses),
    storage: normalizeQuota(quotas.quotaStorageBytes, existing.quota_storage_bytes),
    send: normalizeQuota(quotas.quotaSendDaily, existing.quota_send_daily),
  };
  await env.DB.prepare(
    `UPDATE users
     SET quota_addresses = ?2, quota_storage_bytes = ?3, quota_send_daily = ?4, updated_at = ?5
     WHERE id = ?1`,
  )
    .bind(userId, next.addresses, next.storage, next.send, now)
    .run();
  return getUser(env, userId);
}

export async function resetUserToken(
  env: Env,
  userId: string,
  token = generateUserToken(),
  now = Date.now(),
): Promise<{ user: UserRecord; token: string } | null> {
  if (token.trim().length < 8) {
    throw new UserInputError("invalid_request", "User token must be at least 8 characters.");
  }
  const salt = generateSalt();
  const hash = await hashUserToken(token.trim(), salt);
  const result = await env.DB.prepare(
    `UPDATE users SET token_salt = ?2, token_hash = ?3, updated_at = ?4 WHERE id = ?1`,
  )
    .bind(userId, salt, hash, now)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return null;
  }
  const user = await getUser(env, userId);
  return user ? { user, token: token.trim() } : null;
}

export class UserInputError extends Error {
  error: string;
  constructor(error: string, hint: string) {
    super(hint);
    this.error = error;
  }
}

export function normalizeLogin(value: string): string | null {
  const login = value.trim().toLowerCase();
  if (login.length < 2 || login.length > 64) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9._@-]*[a-z0-9]$/i.test(login) && !/^[a-z0-9]{2}$/i.test(login)) {
    return null;
  }
  return login;
}

export function normalizeQuota(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  const n = Math.floor(value);
  return n >= 0 ? n : fallback;
}

export function generateUserToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return bytesToB64url(bytes);
}

export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function hashUserToken(token: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
