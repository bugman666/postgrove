/**
 * Inbound webhooks and optional forward (chat URL or external mailbox).
 *
 * Signing (document this; receivers must be able to fail a bad/missing secret):
 *   HMAC-SHA256 over `${unix_seconds}.${raw_json_body}` (UTF-8).
 *   Header X-Postgrove-Timestamp: <unix_seconds>
 *   Header X-Postgrove-Signature: v1=<hex>
 *   Header X-Postgrove-Event: inbound
 *
 * webhook_secret is stored enveloped (enc:v1: AES-GCM, key from SESSION_SECRET).
 * Mint / rotate returns plaintext once; later reads only set webhook_secret_set.
 * Delivery opens the envelope and HMAC-signs with the plaintext. verifyWebhookSignature
 * compares the hex MAC in constant time. Leftover plaintext rows wrap on read/save.
 *
 * Save, fetch, each redirect hop, and **each retry** call validateSafeUrl
 * from src/safe-url.ts. Hostnames are re-checked after DNS via recheckResolvedIps
 * (shared with logo probe). Default: https only. http://127.0.0.1 (and other
 * private http) only when ALLOW_PRIVATE_WEBHOOKS=1 (passed as allowPrivate).
 * Redirects are followed manually — never redirect: "follow".
 *
 * Failed HTTP deliveries stay `pending` with next_attempt_at backoff until
 * max_attempts, then `failed`. A Worker cron (and admin drain) re-opens the
 * secret envelope, re-validates the live target URL, and mints a **fresh**
 * X-Postgrove-Timestamp (skew stays WEBHOOK_MAX_SKEW_SECONDS). Receivers
 * dedupe on delivery_id / event_id — retries do not replay an old signed body.
 */

import type { Env } from "./env.ts";
import {
  recheckResolvedIps,
  validateSafeUrl,
  type ResolveHost,
  type ValidateSafeUrlResult,
} from "./safe-url.ts";
import { parseSendFields, sendOutbound } from "./send.ts";
import {
  getMailbox,
  getMailboxMessage,
  isUniqueConstraintError,
  parseMailboxAddress,
  type MailboxRecord,
} from "./store.ts";

export const WEBHOOK_SIGNATURE_HEADER = "x-postgrove-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-postgrove-timestamp";
export const WEBHOOK_EVENT_HEADER = "x-postgrove-event";
export const WEBHOOK_ALG = "hmac-sha256";
export const WEBHOOK_SIGNED_STRING = "${timestamp}.${raw_json_body}";
export const WEBHOOK_MAX_SKEW_SECONDS = 5 * 60;
export const WEBHOOK_MAX_REDIRECTS = 5;
export const WEBHOOK_BODY_TEXT_MAX = 8000;
/** Limited automatic retries (first attempt + scheduled drain). */
export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_RETRY_BASE_MS = 60_000;
export const WEBHOOK_DRAIN_BATCH = 20;
export const WEBHOOK_DRAIN_CONCURRENCY = 4;
export const WEBHOOK_DRAIN_PER_MAILBOX = 3;
export const WEBHOOK_DRAIN_LEASE_MS = 120_000;
/** AES-GCM envelope prefix. Legacy plaintext rows are wrapped on read/save. */
export const WEBHOOK_SECRET_ENVELOPE_PREFIX = "enc:v1:";
const WEBHOOK_SECRET_WRAP_INFO = "postgrove.webhook_secret.v1";

const URL_MAX = 2048;
const SECRET_MIN = 8;
const SECRET_MAX = 256;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class HookInputError extends Error {
  readonly error: string;
  constructor(error: string, hint: string) {
    super(hint);
    this.error = error;
  }
}

export type InboundHookRow = {
  mailbox_id: string;
  webhook_enabled: number;
  webhook_url: string | null;
  webhook_secret: string | null;
  forward_enabled: number;
  forward_url: string | null;
  forward_email: string | null;
  updated_at: number;
};

export type InboundDeliveryStatus = "pending" | "sent" | "failed";
export type InboundDeliveryChannel = "webhook" | "forward_url" | "forward_email";

export type InboundDeliveryRecord = {
  id: string;
  mailbox_id: string;
  message_id: string | null;
  kind: "webhook" | "forward";
  channel: InboundDeliveryChannel;
  target: string;
  status: InboundDeliveryStatus;
  http_status: number | null;
  error: string | null;
  hint: string | null;
  delivery_key: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  payload_json: string | null;
  created_at: number;
  updated_at: number;
};

export type WebhookDrainResult = {
  scanned: number;
  claimed: number;
  sent: number;
  failed: number;
  pending: number;
  skipped: number;
};

export type DrainWebhookOptions = {
  now?: number;
  limit?: number;
  concurrency?: number;
  perMailbox?: number;
};

const DELIVERY_COLUMNS = `id, mailbox_id, message_id, kind, channel, target, status,
  http_status, error, hint, delivery_key, attempt_count, max_attempts,
  next_attempt_at, last_attempt_at, payload_json, created_at, updated_at`;

export type PublicHookConfig = {
  mailbox_id: string;
  webhook_enabled: boolean;
  webhook_url: string | null;
  webhook_secret_set: boolean;
  webhook_secret?: string;
  forward_enabled: boolean;
  forward_url: string | null;
  forward_email: string | null;
  signing: {
    alg: typeof WEBHOOK_ALG;
    signed_string: typeof WEBHOOK_SIGNED_STRING;
    signature_header: string;
    timestamp_header: string;
    event_header: string;
  };
  updated_at: number;
};

export type HookConfigInput = {
  webhook_enabled?: boolean;
  webhook_url?: string | null;
  webhook_secret?: string | null;
  rotate_secret?: boolean;
  forward_enabled?: boolean;
  forward_url?: string | null;
  forward_email?: string | null;
};

export type InboundNotifyInput = {
  mailboxId: string;
  mailboxAddress: string;
  messageId: string;
  from: string;
  to: string;
  subject: string | null;
  snippet: string | null;
  text: string | null;
  receivedAt: number;
};

type FetchImpl = typeof fetch;

let testFetch: FetchImpl | null = null;
let testResolve: ResolveHost | null = null;

/** Test helper: inject fetch used by webhook / forward HTTP. */
export function setWebhookFetchForTests(fn: FetchImpl | null): void {
  testFetch = fn;
}

/** Test helper: inject DNS answers. Return [] for NXDOMAIN, null to skip IP re-check. */
export function setWebhookResolveForTests(fn: ResolveHost | null): void {
  testResolve = fn;
}

export function allowPrivateWebhooks(env: Env): boolean {
  return (env.ALLOW_PRIVATE_WEBHOOKS ?? "").trim() === "1";
}

export function publicSigningDoc(): PublicHookConfig["signing"] & { hint: string } {
  return {
    alg: WEBHOOK_ALG,
    signed_string: WEBHOOK_SIGNED_STRING,
    signature_header: "X-Postgrove-Signature",
    timestamp_header: "X-Postgrove-Timestamp",
    event_header: "X-Postgrove-Event",
    hint: "HMAC-SHA256 hex of `${unix_seconds}.${raw_json_body}`. Header value is v1=<hex>. A missing or wrong secret must fail verification.",
  };
}

export function publicHookConfig(row: InboundHookRow, secretOnce?: string): PublicHookConfig {
  return {
    mailbox_id: row.mailbox_id,
    webhook_enabled: row.webhook_enabled === 1,
    webhook_url: row.webhook_url,
    webhook_secret_set: Boolean(row.webhook_secret),
    ...(secretOnce ? { webhook_secret: secretOnce } : {}),
    forward_enabled: row.forward_enabled === 1,
    forward_url: row.forward_url,
    forward_email: row.forward_email,
    signing: publicSigningDoc(),
    updated_at: row.updated_at,
  };
}

export function publicDelivery(row: InboundDeliveryRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    message_id: row.message_id,
    kind: row.kind,
    channel: row.channel,
    target: row.target,
    status: row.status,
    http_status: row.http_status,
    error: row.error,
    hint: row.hint,
    delivery_key: row.delivery_key,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at,
    last_attempt_at: row.last_attempt_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function parseDeliveryStatus(
  raw: string | null | undefined,
): InboundDeliveryStatus | null {
  if (raw == null) {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "pending" || value === "sent" || value === "failed") {
    return value;
  }
  throw new HookInputError(
    "invalid_request",
    "status must be pending, sent, or failed.",
  );
}

export function deliveryKeyFor(channel: InboundDeliveryChannel, messageId: string): string {
  if (channel === "webhook") {
    return `webhook:${messageId}`;
  }
  if (channel === "forward_url") {
    return `forward:url:${messageId}`;
  }
  return `forward:email:${messageId}`;
}

export function kindForChannel(channel: InboundDeliveryChannel): "webhook" | "forward" {
  return channel === "webhook" ? "webhook" : "forward";
}

export function webhookRetryDelayMs(attemptCount: number): number {
  const n = Math.min(Math.max(Math.floor(attemptCount), 1), 8);
  return WEBHOOK_RETRY_BASE_MS * 2 ** (n - 1);
}

export function parseHookConfigBody(body: unknown): HookConfigInput {
  if (!body || typeof body !== "object") {
    throw new HookInputError(
      "invalid_request",
      'Send JSON with webhook_url / webhook_secret / forward_url / forward_email and optional enabled flags.',
    );
  }
  const record = body as Record<string, unknown>;
  return {
    webhook_enabled: optionalBool(record.webhook_enabled),
    webhook_url: optionalNullableString(record.webhook_url),
    webhook_secret: optionalNullableString(record.webhook_secret),
    rotate_secret: optionalBool(record.rotate_secret) === true,
    forward_enabled: optionalBool(record.forward_enabled),
    forward_url: optionalNullableString(record.forward_url),
    forward_email: optionalNullableString(record.forward_email),
  };
}

/** Validate operator URLs with validateSafeUrl. Bad URL → HookInputError (400). */
export function assertSafeHookUrl(raw: string, env: Env, label: string): URL {
  const checked = gateHookUrl(raw, allowPrivateWebhooks(env), label);
  if (!checked.ok) {
    throw new HookInputError(checked.error, checked.hint);
  }
  return checked.url;
}

export function gateHookUrl(
  raw: string,
  allowPrivate: boolean,
  label = "URL",
): ValidateSafeUrlResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      error: "invalid_url",
      hint: `${label} must be an absolute https URL (http://127.0.0.1 only if ALLOW_PRIVATE_WEBHOOKS=1).`,
    };
  }
  if (raw.trim().length > URL_MAX) {
    return {
      ok: false,
      error: "invalid_url",
      hint: `${label} is too long (max ${URL_MAX} characters).`,
    };
  }
  const checked = validateSafeUrl(raw.trim(), { allowPrivate });
  if (!checked.ok) {
    return {
      ok: false,
      error: checked.error,
      hint: `${label} rejected: ${checked.hint} Internal, metadata, loopback, RFC1918, link-local, CGNAT, and *.localhost targets are blocked.`,
    };
  }
  if (!allowPrivate && checked.url.protocol !== "https:") {
    return {
      ok: false,
      error: "blocked_destination",
      hint: `${label} must use https. Set ALLOW_PRIVATE_WEBHOOKS=1 to allow local http://127.0.0.1.`,
    };
  }
  return checked;
}

export async function getHookConfig(env: Env, mailboxId: string): Promise<InboundHookRow | null> {
  const row = await env.DB.prepare(
    `SELECT mailbox_id, webhook_enabled, webhook_url, webhook_secret,
            forward_enabled, forward_url, forward_email, updated_at
     FROM inbound_hooks WHERE mailbox_id = ?1`,
  )
    .bind(mailboxId)
    .first<InboundHookRow>();
  if (!row) {
    return null;
  }
  row.webhook_secret = await upgradeStoredWebhookSecret(env, row.mailbox_id, row.webhook_secret);
  return row;
}

export async function saveHookConfig(
  env: Env,
  mailboxId: string,
  input: HookConfigInput,
  now = Date.now(),
): Promise<{ row: InboundHookRow; secretOnce: string | null }> {
  const existing = await getHookConfig(env, mailboxId);
  const allowPrivate = allowPrivateWebhooks(env);

  let webhookUrl = existing?.webhook_url ?? null;
  if (input.webhook_url !== undefined) {
    webhookUrl = normalizeOptional(input.webhook_url);
    if (webhookUrl) {
      const checked = gateHookUrl(webhookUrl, allowPrivate, "webhook_url");
      if (!checked.ok) {
        throw new HookInputError(checked.error, checked.hint);
      }
      webhookUrl = checked.url.toString();
    }
  }

  let forwardUrl = existing?.forward_url ?? null;
  if (input.forward_url !== undefined) {
    forwardUrl = normalizeOptional(input.forward_url);
    if (forwardUrl) {
      const checked = gateHookUrl(forwardUrl, allowPrivate, "forward_url");
      if (!checked.ok) {
        throw new HookInputError(checked.error, checked.hint);
      }
      forwardUrl = checked.url.toString();
    }
  }

  let forwardEmail = existing?.forward_email ?? null;
  if (input.forward_email !== undefined) {
    forwardEmail = normalizeOptional(input.forward_email);
    if (forwardEmail) {
      const parsed = parseMailboxAddress(forwardEmail) ?? (EMAIL_RE.test(forwardEmail.toLowerCase())
        ? { address: forwardEmail.trim().toLowerCase() }
        : null);
      if (!parsed) {
        throw new HookInputError(
          "invalid_request",
          "forward_email must look like neighbor@example.test.",
        );
      }
      forwardEmail = parsed.address;
    }
  }

  const webhookEnabled =
    input.webhook_enabled !== undefined
      ? input.webhook_enabled
      : existing?.webhook_enabled === 1;
  const forwardEnabled =
    input.forward_enabled !== undefined
      ? input.forward_enabled
      : existing?.forward_enabled === 1;

  if (webhookEnabled && !webhookUrl) {
    throw new HookInputError(
      "invalid_request",
      "webhook_enabled needs webhook_url (https). Internal/metadata URLs are rejected.",
    );
  }
  if (forwardEnabled && !forwardUrl && !forwardEmail) {
    throw new HookInputError(
      "invalid_request",
      "forward_enabled needs forward_url (chat bot https) or forward_email.",
    );
  }

  let storedSecret = existing?.webhook_secret ?? null;
  let secretOnce: string | null = null;
  if (input.rotate_secret || (webhookEnabled && !storedSecret && input.webhook_secret === undefined)) {
    const minted = generateWebhookSecret();
    storedSecret = await envelopeWebhookSecret(env, minted);
    secretOnce = minted;
  }
  if (input.webhook_secret !== undefined) {
    const next = normalizeOptional(input.webhook_secret);
    if (next) {
      if (next.length < SECRET_MIN || next.length > SECRET_MAX) {
        throw new HookInputError(
          "invalid_request",
          `webhook_secret must be ${SECRET_MIN}–${SECRET_MAX} characters.`,
        );
      }
      storedSecret = await envelopeWebhookSecret(env, next);
      secretOnce = next;
    }
  }
  if (webhookEnabled && !storedSecret) {
    const minted = generateWebhookSecret();
    storedSecret = await envelopeWebhookSecret(env, minted);
    secretOnce = minted;
  }
  if (storedSecret && !isEnvelopedWebhookSecret(storedSecret)) {
    storedSecret = await envelopeWebhookSecret(env, storedSecret);
  }

  const row: InboundHookRow = {
    mailbox_id: mailboxId,
    webhook_enabled: webhookEnabled ? 1 : 0,
    webhook_url: webhookUrl,
    webhook_secret: storedSecret,
    forward_enabled: forwardEnabled ? 1 : 0,
    forward_url: forwardUrl,
    forward_email: forwardEmail,
    updated_at: now,
  };

  await env.DB.prepare(
    `INSERT INTO inbound_hooks (
       mailbox_id, webhook_enabled, webhook_url, webhook_secret,
       forward_enabled, forward_url, forward_email, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(mailbox_id) DO UPDATE SET
       webhook_enabled = excluded.webhook_enabled,
       webhook_url = excluded.webhook_url,
       webhook_secret = excluded.webhook_secret,
       forward_enabled = excluded.forward_enabled,
       forward_url = excluded.forward_url,
       forward_email = excluded.forward_email,
       updated_at = excluded.updated_at`,
  )
    .bind(
      row.mailbox_id,
      row.webhook_enabled,
      row.webhook_url,
      row.webhook_secret,
      row.forward_enabled,
      row.forward_url,
      row.forward_email,
      row.updated_at,
    )
    .run();

  return { row, secretOnce };
}

export async function listDeliveries(
  env: Env,
  mailboxId?: string,
  limit = 50,
  status?: InboundDeliveryStatus | null,
): Promise<InboundDeliveryRecord[]> {
  const capped = Math.min(200, Math.max(1, Math.floor(limit)));
  if (mailboxId && status) {
    const rows = await env.DB.prepare(
      `SELECT ${DELIVERY_COLUMNS}
       FROM inbound_deliveries
       WHERE mailbox_id = ?1 AND status = ?2
       ORDER BY created_at DESC
       LIMIT ?3`,
    )
      .bind(mailboxId, status, capped)
      .all<InboundDeliveryRecord>();
    return rows.results ?? [];
  }
  if (mailboxId) {
    const rows = await env.DB.prepare(
      `SELECT ${DELIVERY_COLUMNS}
       FROM inbound_deliveries
       WHERE mailbox_id = ?1
       ORDER BY created_at DESC
       LIMIT ?2`,
    )
      .bind(mailboxId, capped)
      .all<InboundDeliveryRecord>();
    return rows.results ?? [];
  }
  if (status) {
    const rows = await env.DB.prepare(
      `SELECT ${DELIVERY_COLUMNS}
       FROM inbound_deliveries
       WHERE status = ?1
       ORDER BY created_at DESC
       LIMIT ?2`,
    )
      .bind(status, capped)
      .all<InboundDeliveryRecord>();
    return rows.results ?? [];
  }
  const rows = await env.DB.prepare(
    `SELECT ${DELIVERY_COLUMNS}
     FROM inbound_deliveries
     ORDER BY created_at DESC
     LIMIT ?1`,
  )
    .bind(capped)
    .all<InboundDeliveryRecord>();
  return rows.results ?? [];
}

export async function getDeliveryByKey(
  env: Env,
  mailboxId: string,
  deliveryKey: string,
): Promise<InboundDeliveryRecord | null> {
  return env.DB.prepare(
    `SELECT ${DELIVERY_COLUMNS}
     FROM inbound_deliveries
     WHERE mailbox_id = ?1 AND delivery_key = ?2`,
  )
    .bind(mailboxId, deliveryKey)
    .first<InboundDeliveryRecord>();
}

export async function getDeliveryById(
  env: Env,
  id: string,
): Promise<InboundDeliveryRecord | null> {
  return env.DB.prepare(
    `SELECT ${DELIVERY_COLUMNS}
     FROM inbound_deliveries
     WHERE id = ?1`,
  )
    .bind(id)
    .first<InboundDeliveryRecord>();
}

export async function insertDelivery(
  env: Env,
  row: Partial<InboundDeliveryRecord> &
    Pick<InboundDeliveryRecord, "mailbox_id" | "kind" | "target" | "status">,
): Promise<InboundDeliveryRecord> {
  const now = row.created_at ?? Date.now();
  const id = row.id ?? crypto.randomUUID();
  const channel = row.channel ?? (row.kind === "webhook" ? "webhook" : "forward_url");
  const record: InboundDeliveryRecord = {
    id,
    mailbox_id: row.mailbox_id,
    message_id: row.message_id ?? null,
    kind: row.kind,
    channel,
    target: row.target,
    status: row.status,
    http_status: row.http_status ?? null,
    error: row.error ?? null,
    hint: row.hint ?? null,
    delivery_key: row.delivery_key ?? id,
    attempt_count: row.attempt_count ?? 0,
    max_attempts: row.max_attempts ?? WEBHOOK_MAX_ATTEMPTS,
    next_attempt_at: row.next_attempt_at ?? null,
    last_attempt_at: row.last_attempt_at ?? null,
    payload_json: row.payload_json ?? null,
    created_at: now,
    updated_at: row.updated_at ?? now,
  };
  try {
    await persistDeliveryRow(env, record);
    return record;
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = await getDeliveryByKey(env, record.mailbox_id, record.delivery_key);
    if (!existing) {
      throw error;
    }
    return existing;
  }
}

async function persistDeliveryRow(env: Env, record: InboundDeliveryRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO inbound_deliveries (
       id, mailbox_id, message_id, kind, channel, target, status, http_status,
       error, hint, delivery_key, attempt_count, max_attempts, next_attempt_at,
       last_attempt_at, payload_json, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
  )
    .bind(
      record.id,
      record.mailbox_id,
      record.message_id,
      record.kind,
      record.channel,
      record.target,
      record.status,
      record.http_status,
      record.error,
      record.hint,
      record.delivery_key,
      record.attempt_count,
      record.max_attempts,
      record.next_attempt_at,
      record.last_attempt_at,
      record.payload_json,
      record.created_at,
      record.updated_at,
    )
    .run();
}

export async function updateDelivery(env: Env, row: InboundDeliveryRecord): Promise<void> {
  await env.DB.prepare(
    `UPDATE inbound_deliveries
     SET target = ?2, status = ?3, http_status = ?4, error = ?5, hint = ?6,
         attempt_count = ?7, next_attempt_at = ?8, last_attempt_at = ?9,
         payload_json = ?10, updated_at = ?11
     WHERE id = ?1`,
  )
    .bind(
      row.id,
      row.target,
      row.status,
      row.http_status,
      row.error,
      row.hint,
      row.attempt_count,
      row.next_attempt_at,
      row.last_attempt_at,
      row.payload_json,
      row.updated_at,
    )
    .run();
}

export function inboundWebhookPayload(
  input: InboundNotifyInput,
  ids?: { deliveryId?: string; eventId?: string },
): Record<string, unknown> {
  return {
    event: "inbound",
    event_id: ids?.eventId ?? input.messageId,
    delivery_id: ids?.deliveryId ?? input.messageId,
    message_id: input.messageId,
    mailbox_id: input.mailboxId,
    from: input.from,
    to: input.to,
    subject: input.subject,
    snippet: input.snippet,
    text: clip(input.text, WEBHOOK_BODY_TEXT_MAX),
    received_at: input.receivedAt,
  };
}

export async function signWebhookBody(
  secret: string,
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<{ timestamp: string; signature: string }> {
  const ts = String(timestamp);
  const hex = bytesToHex(await hmacSha256(secret, `${ts}.${rawBody}`));
  return { timestamp: ts, signature: `v1=${hex}` };
}

export async function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string;
  rawBody: string;
  signatureHeader: string | null;
  nowSeconds?: number;
  maxSkewSeconds?: number;
}): Promise<{ ok: true } | { ok: false; error: string; hint: string }> {
  const secret = input.secret;
  if (!secret) {
    return {
      ok: false,
      error: "missing_secret",
      hint: "No webhook secret configured. HMAC-SHA256 verification requires the shared secret.",
    };
  }
  const header = input.signatureHeader?.trim() ?? "";
  if (!header) {
    return {
      ok: false,
      error: "missing_signature",
      hint: "Missing X-Postgrove-Signature (expected v1=<hex HMAC-SHA256 of `${timestamp}.${body}`).",
    };
  }
  const ts = input.timestamp.trim();
  if (!/^\d+$/.test(ts)) {
    return {
      ok: false,
      error: "invalid_timestamp",
      hint: "X-Postgrove-Timestamp must be unix seconds.",
    };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = input.maxSkewSeconds ?? WEBHOOK_MAX_SKEW_SECONDS;
  if (Math.abs(now - Number(ts)) > skew) {
    return {
      ok: false,
      error: "timestamp_skew",
      hint: `X-Postgrove-Timestamp is outside ±${skew} seconds.`,
    };
  }
  const expected = bytesToHex(await hmacSha256(secret, `${ts}.${input.rawBody}`));
  const provided = header.replace(/^v1=/i, "").trim();
  if (!timingSafeEqualHex(provided, expected)) {
    return {
      ok: false,
      error: "bad_signature",
      hint: "Signature does not match. Check webhook_secret (HMAC-SHA256 of `${timestamp}.${raw_json_body}`).",
    };
  }
  return { ok: true };
}

/**
 * POST signed inbound payload / chat forward. Writes `pending` with a
 * delivery_key before the first POST (outbox-style). Failures stay pending
 * with backoff until max_attempts, then failed. Never swallowed.
 */
export async function notifyInbound(env: Env, input: InboundNotifyInput): Promise<InboundDeliveryRecord[]> {
  let config: InboundHookRow | null = null;
  try {
    config = await getHookConfig(env, input.mailboxId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.log("inbound hooks: config lookup skipped", { detail });
    return [];
  }
  if (!config) {
    return [];
  }

  const now = Date.now();
  const out: InboundDeliveryRecord[] = [];
  if (config.webhook_enabled === 1 && config.webhook_url) {
    out.push(await deliverChannel(env, config, input, "webhook", now));
  }
  if (config.forward_enabled === 1 && config.forward_url) {
    out.push(await deliverChannel(env, config, input, "forward_url", now));
  }
  if (config.forward_enabled === 1 && config.forward_email) {
    out.push(await deliverChannel(env, config, input, "forward_email", now));
  }
  return out;
}

/**
 * Drain due `pending` rows. Caps batch size, per-mailbox fanout, and
 * concurrent POSTs so one bad hook cannot DoS the Worker.
 */
/** Cron / admin / test entry for the pending delivery drain. */
export async function handleScheduled(
  env: Env,
  opts: DrainWebhookOptions = {},
): Promise<WebhookDrainResult> {
  return drainDueWebhookDeliveries(env, opts);
}

export async function drainDueWebhookDeliveries(
  env: Env,
  opts: DrainWebhookOptions = {},
): Promise<WebhookDrainResult> {
  const now = opts.now ?? Date.now();
  const limit = Math.min(
    WEBHOOK_DRAIN_BATCH,
    Math.max(1, Math.floor(opts.limit ?? WEBHOOK_DRAIN_BATCH)),
  );
  const perMailbox = Math.min(
    WEBHOOK_DRAIN_PER_MAILBOX,
    Math.max(1, Math.floor(opts.perMailbox ?? WEBHOOK_DRAIN_PER_MAILBOX)),
  );
  const concurrency = Math.min(
    WEBHOOK_DRAIN_CONCURRENCY,
    Math.max(1, Math.floor(opts.concurrency ?? WEBHOOK_DRAIN_CONCURRENCY)),
  );

  const due = await listDueDeliveries(env, now, limit * 3);
  const selected = capPerMailbox(due, perMailbox).slice(0, limit);
  const result: WebhookDrainResult = {
    scanned: due.length,
    claimed: 0,
    sent: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
  };

  const claimed: InboundDeliveryRecord[] = [];
  for (const row of selected) {
    const leased = await claimDelivery(env, row, now);
    if (leased) {
      claimed.push(leased);
    } else {
      result.skipped += 1;
    }
  }
  result.claimed = claimed.length;

  await runPool(claimed, concurrency, async (row) => {
    const updated = await retryClaimedDelivery(env, row, now);
    if (updated.status === "sent") {
      result.sent += 1;
    } else if (updated.status === "failed") {
      result.failed += 1;
    } else {
      result.pending += 1;
    }
  });

  return result;
}

async function deliverChannel(
  env: Env,
  config: InboundHookRow,
  input: InboundNotifyInput,
  channel: InboundDeliveryChannel,
  now: number,
): Promise<InboundDeliveryRecord> {
  const reserved = await reserveDelivery(env, config, input, channel, now);
  if (reserved.status === "sent" || reserved.status === "failed") {
    return reserved;
  }
  if (reserved.attempt_count > 0) {
    return reserved;
  }
  return dispatchDelivery(env, reserved, config, input, now);
}

async function reserveDelivery(
  env: Env,
  config: InboundHookRow,
  input: InboundNotifyInput,
  channel: InboundDeliveryChannel,
  now: number,
): Promise<InboundDeliveryRecord> {
  const key = deliveryKeyFor(channel, input.messageId);
  const existing = await getDeliveryByKey(env, input.mailboxId, key);
  if (existing) {
    return existing;
  }
  return insertDelivery(env, {
    mailbox_id: input.mailboxId,
    message_id: input.messageId,
    kind: kindForChannel(channel),
    channel,
    target: redactTarget(liveTarget(config, channel)),
    status: "pending",
    http_status: null,
    error: null,
    hint: null,
    delivery_key: key,
    attempt_count: 0,
    max_attempts: WEBHOOK_MAX_ATTEMPTS,
    next_attempt_at: now,
    last_attempt_at: null,
    payload_json: JSON.stringify(input),
    created_at: now,
    updated_at: now,
  });
}

async function retryClaimedDelivery(
  env: Env,
  row: InboundDeliveryRecord,
  now: number,
): Promise<InboundDeliveryRecord> {
  const input = await notifyInputFromDelivery(env, row);
  if (!input) {
    row.status = "failed";
    row.error = "payload_missing";
    row.hint = "Delivery snapshot was missing and the inbound message could not be reloaded. This is not retried.";
    row.next_attempt_at = null;
    row.last_attempt_at = now;
    row.updated_at = now;
    await updateDelivery(env, row);
    return row;
  }

  let config: InboundHookRow | null = null;
  try {
    config = await getHookConfig(env, row.mailbox_id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    return finishAttempt(env, row, now, {
      target: row.target,
      httpStatus: null,
      error: "hook_unreadable",
      hint: `Could not reload hook config for retry. ${detail}`,
    });
  }
  if (!config || !channelEnabled(config, row.channel)) {
    row.status = "failed";
    row.error = "hook_disabled";
    row.hint = "Hook was disabled or the target was removed before retry. Delivery stopped.";
    row.next_attempt_at = null;
    row.last_attempt_at = now;
    row.updated_at = now;
    await updateDelivery(env, row);
    return row;
  }
  return dispatchDelivery(env, row, config, input, now);
}

async function dispatchDelivery(
  env: Env,
  row: InboundDeliveryRecord,
  config: InboundHookRow,
  input: InboundNotifyInput,
  now: number,
): Promise<InboundDeliveryRecord> {
  row.attempt_count += 1;
  row.last_attempt_at = now;
  row.updated_at = now;
  row.next_attempt_at = now + WEBHOOK_DRAIN_LEASE_MS;
  row.target = redactTarget(liveTarget(config, row.channel));
  await updateDelivery(env, row);

  if (row.channel === "forward_email") {
    return dispatchForwardEmail(env, row, config, input, now);
  }
  return dispatchHttpChannel(env, row, config, input, now);
}

async function dispatchHttpChannel(
  env: Env,
  row: InboundDeliveryRecord,
  config: InboundHookRow,
  input: InboundNotifyInput,
  now: number,
): Promise<InboundDeliveryRecord> {
  const targetUrl = liveTarget(config, row.channel);
  const ids = { deliveryId: row.id, eventId: row.delivery_key };
  let rawBody: string;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (row.channel === "webhook") {
    rawBody = JSON.stringify(inboundWebhookPayload(input, ids));
    headers[WEBHOOK_EVENT_HEADER] = "inbound";
    let secret = "";
    if (config.webhook_secret) {
      try {
        secret = await openWebhookSecret(env, config.webhook_secret);
      } catch {
        return finishAttempt(env, row, now, {
          target: redactTarget(targetUrl),
          httpStatus: null,
          error: "secret_unreadable",
          hint: "Stored webhook secret could not be opened. Rotate the hook secret (SESSION_SECRET may have changed).",
        });
      }
    }
    if (!secret) {
      return finishAttempt(env, row, now, {
        target: redactTarget(targetUrl),
        httpStatus: null,
        error: "missing_secret",
        hint: "Webhook is enabled but no signing secret is stored. Rotate or set webhook_secret.",
      });
    }
    const signed = await signWebhookBody(secret, rawBody, Math.floor(now / 1000));
    headers[WEBHOOK_TIMESTAMP_HEADER] = signed.timestamp;
    headers[WEBHOOK_SIGNATURE_HEADER] = signed.signature;
  } else {
    rawBody = JSON.stringify(inboundForwardPayload(input, ids));
  }

  const result = await safeOutboundFetch(
    targetUrl,
    { method: "POST", headers, body: rawBody },
    { allowPrivate: allowPrivateWebhooks(env) },
  );
  return applyHttpResult(env, row, now, redactTarget(targetUrl), result);
}

async function dispatchForwardEmail(
  env: Env,
  row: InboundDeliveryRecord,
  config: InboundHookRow,
  input: InboundNotifyInput,
  now: number,
): Promise<InboundDeliveryRecord> {
  const target = config.forward_email ?? "";
  const mailbox = await getMailbox(env, input.mailboxId);
  if (!mailbox) {
    return finishAttempt(env, row, now, {
      target,
      httpStatus: null,
      error: "mailbox_missing",
      hint: "Forward mailbox disappeared before the relay ran.",
    });
  }
  const parsed = parseSendFields({
    to: target,
    subject: input.subject ? `Fwd: ${input.subject}` : "Fwd: (no subject)",
    text: quotedForward(input, mailbox),
  });
  if (!parsed.ok) {
    return finishAttempt(env, row, now, {
      target,
      httpStatus: 400,
      error: parsed.error,
      hint: parsed.hint,
    });
  }
  try {
    const outcome = await sendOutbound(env, mailbox, parsed.input, {
      idempotencyKey: `hook:${row.delivery_key}`,
    });
    if (outcome.attempt.status === "sent") {
      return finishAttempt(env, row, now, {
        target,
        httpStatus: outcome.httpStatus,
        error: null,
        hint: null,
        sent: true,
      });
    }
    return finishAttempt(env, row, now, {
      target,
      httpStatus: outcome.httpStatus,
      error: outcome.attempt.error,
      hint: outcome.attempt.hint,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    return finishAttempt(env, row, now, {
      target,
      httpStatus: null,
      error: "forward_failed",
      hint: `Could not relay to ${target}. ${detail}`,
    });
  }
}

async function applyHttpResult(
  env: Env,
  row: InboundDeliveryRecord,
  now: number,
  target: string,
  result: SafeFetchResult,
): Promise<InboundDeliveryRecord> {
  if (result.ok) {
    const status = result.response.status;
    if (status >= 200 && status < 300) {
      return finishAttempt(env, row, now, {
        target,
        httpStatus: status,
        error: null,
        hint: null,
        sent: true,
      });
    }
    return finishAttempt(env, row, now, {
      target,
      httpStatus: status,
      error: "downstream_failed",
      hint: `Downstream returned HTTP ${status}. Check the webhook/forward URL; this is not swallowed.`,
    });
  }
  return finishAttempt(env, row, now, {
    target,
    httpStatus: result.httpStatus ?? null,
    error: result.error,
    hint: result.hint,
  });
}

async function finishAttempt(
  env: Env,
  row: InboundDeliveryRecord,
  now: number,
  outcome: {
    target: string;
    httpStatus: number | null;
    error: string | null;
    hint: string | null;
    sent?: boolean;
  },
): Promise<InboundDeliveryRecord> {
  row.target = outcome.target;
  row.http_status = outcome.httpStatus;
  row.error = outcome.error;
  row.hint = outcome.hint;
  row.last_attempt_at = now;
  row.updated_at = now;
  if (outcome.sent) {
    row.status = "sent";
    row.next_attempt_at = null;
  } else if (row.attempt_count >= row.max_attempts) {
    row.status = "failed";
    row.next_attempt_at = null;
  } else {
    row.status = "pending";
    row.next_attempt_at = now + webhookRetryDelayMs(row.attempt_count);
  }
  await updateDelivery(env, row);
  return row;
}

async function listDueDeliveries(
  env: Env,
  now: number,
  limit: number,
): Promise<InboundDeliveryRecord[]> {
  const capped = Math.min(200, Math.max(1, Math.floor(limit)));
  const rows = await env.DB.prepare(
    `SELECT ${DELIVERY_COLUMNS}
     FROM inbound_deliveries
     WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?1
     ORDER BY next_attempt_at ASC
     LIMIT ?2`,
  )
    .bind(now, capped)
    .all<InboundDeliveryRecord>();
  return rows.results ?? [];
}

async function claimDelivery(
  env: Env,
  row: InboundDeliveryRecord,
  now: number,
): Promise<InboundDeliveryRecord | null> {
  const leaseUntil = now + WEBHOOK_DRAIN_LEASE_MS;
  const result = await env.DB.prepare(
    `UPDATE inbound_deliveries
     SET next_attempt_at = ?2, updated_at = ?3
     WHERE id = ?1 AND status = 'pending' AND next_attempt_at <= ?3`,
  )
    .bind(row.id, leaseUntil, now)
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    return null;
  }
  row.next_attempt_at = leaseUntil;
  row.updated_at = now;
  return row;
}

async function notifyInputFromDelivery(
  env: Env,
  row: InboundDeliveryRecord,
): Promise<InboundNotifyInput | null> {
  if (row.payload_json) {
    try {
      const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (typeof parsed.mailboxId === "string" && typeof parsed.messageId === "string") {
        return {
          mailboxId: parsed.mailboxId,
          mailboxAddress: typeof parsed.mailboxAddress === "string" ? parsed.mailboxAddress : "",
          messageId: parsed.messageId,
          from: typeof parsed.from === "string" ? parsed.from : "",
          to: typeof parsed.to === "string" ? parsed.to : "",
          subject: typeof parsed.subject === "string" ? parsed.subject : null,
          snippet: typeof parsed.snippet === "string" ? parsed.snippet : null,
          text: typeof parsed.text === "string" ? parsed.text : null,
          receivedAt: typeof parsed.receivedAt === "number" ? parsed.receivedAt : row.created_at,
        };
      }
    } catch {
      // Fall through to the stored message row.
    }
  }
  if (!row.message_id) {
    return null;
  }
  const message = await getMailboxMessage(env, row.mailbox_id, row.message_id);
  if (!message) {
    return null;
  }
  const mailbox = await getMailbox(env, row.mailbox_id);
  return {
    mailboxId: row.mailbox_id,
    mailboxAddress: mailbox?.address ?? message.envelope_to,
    messageId: message.id,
    from: message.envelope_from,
    to: message.envelope_to,
    subject: message.subject,
    snippet: message.snippet,
    text: message.body_text,
    receivedAt: message.received_at,
  };
}

function inboundForwardPayload(
  input: InboundNotifyInput,
  ids: { deliveryId: string; eventId: string },
): Record<string, unknown> {
  const text = chatText(input);
  return {
    event: "inbound.forward",
    event_id: ids.eventId,
    delivery_id: ids.deliveryId,
    text,
    content: text,
    from: input.from,
    to: input.to,
    subject: input.subject,
    snippet: input.snippet,
    message_id: input.messageId,
  };
}

function liveTarget(config: InboundHookRow, channel: InboundDeliveryChannel): string {
  if (channel === "webhook") {
    return config.webhook_url ?? "";
  }
  if (channel === "forward_url") {
    return config.forward_url ?? "";
  }
  return config.forward_email ?? "";
}

function channelEnabled(config: InboundHookRow, channel: InboundDeliveryChannel): boolean {
  if (channel === "webhook") {
    return config.webhook_enabled === 1 && Boolean(config.webhook_url);
  }
  if (channel === "forward_url") {
    return config.forward_enabled === 1 && Boolean(config.forward_url);
  }
  return config.forward_enabled === 1 && Boolean(config.forward_email);
}

function capPerMailbox(
  rows: InboundDeliveryRecord[],
  perMailbox: number,
): InboundDeliveryRecord[] {
  const counts = new Map<string, number>();
  const out: InboundDeliveryRecord[] = [];
  for (const row of rows) {
    const used = counts.get(row.mailbox_id) ?? 0;
    if (used >= perMailbox) {
      continue;
    }
    counts.set(row.mailbox_id, used + 1);
    out.push(row);
  }
  return out;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const queue = items.slice();
  const n = Math.min(concurrency, queue.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) {
          await worker(item);
        }
      }
    }),
  );
}

export type SafeFetchResult =
  | { ok: true; response: Response }
  | { ok: false; error: string; hint: string; httpStatus?: number };

/**
 * Fetch an operator URL: validateSafeUrl, optional DNS IP re-check, then
 * follow redirects ourselves and re-validate each Location.
 */
export async function safeOutboundFetch(
  rawUrl: string,
  init: RequestInit,
  opts: { allowPrivate?: boolean; fetchImpl?: FetchImpl; resolveHost?: ResolveHost } = {},
): Promise<SafeFetchResult> {
  const allowPrivate = opts.allowPrivate === true;
  const fetchImpl = opts.fetchImpl ?? testFetch ?? fetch;
  const resolveHost = opts.resolveHost ?? testResolve ?? undefined;
  let current = rawUrl;
  let method = (init.method ?? "POST").toUpperCase();
  let body = init.body;
  const baseHeaders = headersToRecord(init.headers);

  for (let hop = 0; hop <= WEBHOOK_MAX_REDIRECTS; hop++) {
    const gated = gateHookUrl(current, allowPrivate, hop === 0 ? "URL" : "Redirect URL");
    if (!gated.ok) {
      return { ok: false, error: gated.error, hint: gated.hint };
    }
    const url = gated.url;
    const dns = await recheckResolvedIps(url.hostname, {
      allowPrivate,
      resolveHost,
      fetchImpl,
    });
    if (!dns.ok) {
      return dns;
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: baseHeaders,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      return {
        ok: false,
        error: "fetch_failed",
        hint: `Could not reach ${url.origin}. Check the URL and network egress. ${detail}`,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          error: "redirect_missing",
          hint: "Redirect response had no Location header.",
          httpStatus: response.status,
        };
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return {
          ok: false,
          error: "invalid_url",
          hint: "Redirect Location was not a valid URL.",
          httpStatus: response.status,
        };
      }
      current = next.toString();
      if (response.status === 303 || response.status === 302 || response.status === 301) {
        if (method !== "GET" && method !== "HEAD") {
          method = "GET";
          body = undefined;
        }
      }
      continue;
    }

    return { ok: true, response };
  }

  return {
    ok: false,
    error: "too_many_redirects",
    hint: `Stopped after ${WEBHOOK_MAX_REDIRECTS} redirects. Each hop is re-checked with validateSafeUrl.`,
  };
}

function chatText(input: InboundNotifyInput): string {
  const subject = input.subject?.trim() || "（无主题）";
  const snippet = input.snippet?.trim() || "";
  return `📬 ${input.to} ← ${input.from}\n${subject}${snippet ? `\n${snippet}` : ""}`;
}

function quotedForward(input: InboundNotifyInput, mailbox: MailboxRecord): string {
  const subject = input.subject?.trim() || "（无主题）";
  return `转发自 ${mailbox.address}\nFrom: ${input.from}\nTo: ${input.to}\nSubject: ${subject}\n\n${input.text ?? ""}`;
}

function redactTarget(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.slice(0, 120);
  }
}

export function isEnvelopedWebhookSecret(value: string): boolean {
  return value.startsWith(WEBHOOK_SECRET_ENVELOPE_PREFIX);
}

/** AES-GCM wrap keyed from SESSION_SECRET. Outbound HMAC still needs plaintext. */
export async function envelopeWebhookSecret(env: Env, plaintext: string): Promise<string> {
  const key = await webhookSecretAesKey(env);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return WEBHOOK_SECRET_ENVELOPE_PREFIX + bytesToB64url(packed);
}

/** Open an enveloped row, or return leftover plaintext (legacy, pre-0014). */
export async function openWebhookSecret(env: Env, stored: string): Promise<string> {
  if (!isEnvelopedWebhookSecret(stored)) {
    return stored;
  }
  const packed = b64urlToBytes(stored.slice(WEBHOOK_SECRET_ENVELOPE_PREFIX.length));
  if (packed.length < 13) {
    throw new Error("unreadable_webhook_secret");
  }
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const key = await webhookSecretAesKey(env);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("unreadable_webhook_secret");
  }
}

async function upgradeStoredWebhookSecret(
  env: Env,
  mailboxId: string,
  stored: string | null,
): Promise<string | null> {
  if (!stored || isEnvelopedWebhookSecret(stored)) {
    return stored;
  }
  try {
    const wrapped = await envelopeWebhookSecret(env, stored);
    await env.DB.prepare(`UPDATE inbound_hooks SET webhook_secret = ?2 WHERE mailbox_id = ?1`)
      .bind(mailboxId, wrapped)
      .run();
    return wrapped;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.log("inbound hooks: secret envelope upgrade skipped", { mailboxId, detail });
    return stored;
  }
}

async function webhookSecretAesKey(env: Env): Promise<CryptoKey> {
  const secret = env.SESSION_SECRET?.trim() ?? "";
  if (secret.length < 16) {
    throw new HookInputError(
      "misconfigured",
      "SESSION_SECRET is required to store webhook secrets at rest (min 16 characters).",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${WEBHOOK_SECRET_WRAP_INFO}:${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function normalizeOptional(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function optionalBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1 || value === "1" || value === "true") {
    return true;
  }
  if (value === 0 || value === "0" || value === "false") {
    return false;
  }
  return undefined;
}

function clip(value: string | null, max: number): string | null {
  if (value === null) {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key] = value;
    }
    return out;
  }
  return { ...headers };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (!/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right)) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
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

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
