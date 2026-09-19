/**
 * Inbound webhooks and optional forward (chat URL or external mailbox).
 *
 * Signing (document this; receivers must be able to fail a bad/missing secret):
 *   HMAC-SHA256 over `${unix_seconds}.${raw_json_body}` (UTF-8).
 *   Header X-Postgrove-Timestamp: <unix_seconds>
 *   Header X-Postgrove-Signature: v1=<hex>
 *   Header X-Postgrove-Event: inbound
 *
 * Save, fetch, and each redirect hop call validateSafeUrl from src/safe-url.ts.
 * Default: https only. http://127.0.0.1 (and other private http) only when
 * ALLOW_PRIVATE_WEBHOOKS=1 (passed as allowPrivate). Redirects are followed
 * manually — never redirect: "follow".
 */

import type { Env } from "./env.ts";
import { isBlockedIp, validateSafeUrl, type ValidateSafeUrlResult } from "./safe-url.ts";
import { parseSendFields, sendOutbound } from "./send.ts";
import { getMailbox, parseMailboxAddress, type MailboxRecord } from "./store.ts";

export const WEBHOOK_SIGNATURE_HEADER = "x-postgrove-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-postgrove-timestamp";
export const WEBHOOK_EVENT_HEADER = "x-postgrove-event";
export const WEBHOOK_ALG = "hmac-sha256";
export const WEBHOOK_SIGNED_STRING = "${timestamp}.${raw_json_body}";
export const WEBHOOK_MAX_SKEW_SECONDS = 5 * 60;
export const WEBHOOK_MAX_REDIRECTS = 5;
export const WEBHOOK_BODY_TEXT_MAX = 8000;

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

export type InboundDeliveryRecord = {
  id: string;
  mailbox_id: string;
  message_id: string | null;
  kind: "webhook" | "forward";
  target: string;
  status: "sent" | "failed";
  http_status: number | null;
  error: string | null;
  hint: string | null;
  created_at: number;
};

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
type ResolveHost = (hostname: string) => Promise<string[] | null>;

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
    target: row.target,
    status: row.status,
    http_status: row.http_status,
    error: row.error,
    hint: row.hint,
    created_at: row.created_at,
  };
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
  return env.DB.prepare(
    `SELECT mailbox_id, webhook_enabled, webhook_url, webhook_secret,
            forward_enabled, forward_url, forward_email, updated_at
     FROM inbound_hooks WHERE mailbox_id = ?1`,
  )
    .bind(mailboxId)
    .first<InboundHookRow>();
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

  let secret = existing?.webhook_secret ?? null;
  let secretOnce: string | null = null;
  if (input.rotate_secret || (webhookEnabled && !secret && input.webhook_secret === undefined)) {
    secret = generateWebhookSecret();
    secretOnce = secret;
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
      secret = next;
      secretOnce = next;
    }
  }
  if (webhookEnabled && !secret) {
    secret = generateWebhookSecret();
    secretOnce = secret;
  }

  const row: InboundHookRow = {
    mailbox_id: mailboxId,
    webhook_enabled: webhookEnabled ? 1 : 0,
    webhook_url: webhookUrl,
    webhook_secret: secret,
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
): Promise<InboundDeliveryRecord[]> {
  const capped = Math.min(200, Math.max(1, Math.floor(limit)));
  if (mailboxId) {
    const rows = await env.DB.prepare(
      `SELECT id, mailbox_id, message_id, kind, target, status, http_status, error, hint, created_at
       FROM inbound_deliveries
       WHERE mailbox_id = ?1
       ORDER BY created_at DESC
       LIMIT ?2`,
    )
      .bind(mailboxId, capped)
      .all<InboundDeliveryRecord>();
    return rows.results ?? [];
  }
  const rows = await env.DB.prepare(
    `SELECT id, mailbox_id, message_id, kind, target, status, http_status, error, hint, created_at
     FROM inbound_deliveries
     ORDER BY created_at DESC
     LIMIT ?1`,
  )
    .bind(capped)
    .all<InboundDeliveryRecord>();
  return rows.results ?? [];
}

export async function insertDelivery(
  env: Env,
  row: Omit<InboundDeliveryRecord, "id" | "created_at"> & { id?: string; created_at?: number },
): Promise<InboundDeliveryRecord> {
  const record: InboundDeliveryRecord = {
    id: row.id ?? crypto.randomUUID(),
    mailbox_id: row.mailbox_id,
    message_id: row.message_id,
    kind: row.kind,
    target: row.target,
    status: row.status,
    http_status: row.http_status,
    error: row.error,
    hint: row.hint,
    created_at: row.created_at ?? Date.now(),
  };
  await env.DB.prepare(
    `INSERT INTO inbound_deliveries (
       id, mailbox_id, message_id, kind, target, status, http_status, error, hint, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      record.id,
      record.mailbox_id,
      record.message_id,
      record.kind,
      record.target,
      record.status,
      record.http_status,
      record.error,
      record.hint,
      record.created_at,
    )
    .run();
  return record;
}

export function inboundWebhookPayload(input: InboundNotifyInput): Record<string, unknown> {
  return {
    event: "inbound",
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
 * POST signed inbound payload / chat forward. Failures are stored; never swallowed.
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

  const out: InboundDeliveryRecord[] = [];
  if (config.webhook_enabled === 1 && config.webhook_url) {
    out.push(await deliverWebhook(env, config, input));
  }
  if (config.forward_enabled === 1 && config.forward_url) {
    out.push(await deliverForwardUrl(env, config, input));
  }
  if (config.forward_enabled === 1 && config.forward_email) {
    out.push(await deliverForwardEmail(env, config, input));
  }
  return out;
}

async function deliverWebhook(
  env: Env,
  config: InboundHookRow,
  input: InboundNotifyInput,
): Promise<InboundDeliveryRecord> {
  const rawBody = JSON.stringify(inboundWebhookPayload(input));
  const secret = config.webhook_secret ?? "";
  const signed = secret ? await signWebhookBody(secret, rawBody) : null;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [WEBHOOK_EVENT_HEADER]: "inbound",
  };
  if (signed) {
    headers[WEBHOOK_TIMESTAMP_HEADER] = signed.timestamp;
    headers[WEBHOOK_SIGNATURE_HEADER] = signed.signature;
  }
  const result = await safeOutboundFetch(config.webhook_url ?? "", {
    method: "POST",
    headers,
    body: rawBody,
  }, { allowPrivate: allowPrivateWebhooks(env) });
  return persistHttpDelivery(env, {
    mailboxId: input.mailboxId,
    messageId: input.messageId,
    kind: "webhook",
    target: redactTarget(config.webhook_url ?? ""),
    result,
  });
}

async function deliverForwardUrl(
  env: Env,
  config: InboundHookRow,
  input: InboundNotifyInput,
): Promise<InboundDeliveryRecord> {
  const text = chatText(input);
  const rawBody = JSON.stringify({
    event: "inbound.forward",
    text,
    content: text,
    from: input.from,
    to: input.to,
    subject: input.subject,
    snippet: input.snippet,
    message_id: input.messageId,
  });
  const result = await safeOutboundFetch(config.forward_url ?? "", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  }, { allowPrivate: allowPrivateWebhooks(env) });
  return persistHttpDelivery(env, {
    mailboxId: input.mailboxId,
    messageId: input.messageId,
    kind: "forward",
    target: redactTarget(config.forward_url ?? ""),
    result,
  });
}

async function deliverForwardEmail(
  env: Env,
  config: InboundHookRow,
  input: InboundNotifyInput,
): Promise<InboundDeliveryRecord> {
  const target = config.forward_email ?? "";
  const mailbox = await getMailbox(env, input.mailboxId);
  if (!mailbox) {
    return insertDelivery(env, {
      mailbox_id: input.mailboxId,
      message_id: input.messageId,
      kind: "forward",
      target,
      status: "failed",
      http_status: null,
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
    return insertDelivery(env, {
      mailbox_id: input.mailboxId,
      message_id: input.messageId,
      kind: "forward",
      target,
      status: "failed",
      http_status: 400,
      error: parsed.error,
      hint: parsed.hint,
    });
  }
  try {
    const outcome = await sendOutbound(env, mailbox, parsed.input);
    return insertDelivery(env, {
      mailbox_id: input.mailboxId,
      message_id: input.messageId,
      kind: "forward",
      target,
      status: outcome.attempt.status === "sent" ? "sent" : "failed",
      http_status: outcome.httpStatus,
      error: outcome.attempt.error,
      hint: outcome.attempt.hint,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    return insertDelivery(env, {
      mailbox_id: input.mailboxId,
      message_id: input.messageId,
      kind: "forward",
      target,
      status: "failed",
      http_status: null,
      error: "forward_failed",
      hint: `Could not relay to ${target}. ${detail}`,
    });
  }
}

async function persistHttpDelivery(
  env: Env,
  input: {
    mailboxId: string;
    messageId: string;
    kind: "webhook" | "forward";
    target: string;
    result: SafeFetchResult;
  },
): Promise<InboundDeliveryRecord> {
  if (input.result.ok) {
    const status = input.result.response.status;
    if (status >= 200 && status < 300) {
      return insertDelivery(env, {
        mailbox_id: input.mailboxId,
        message_id: input.messageId,
        kind: input.kind,
        target: input.target,
        status: "sent",
        http_status: status,
        error: null,
        hint: null,
      });
    }
    return insertDelivery(env, {
      mailbox_id: input.mailboxId,
      message_id: input.messageId,
      kind: input.kind,
      target: input.target,
      status: "failed",
      http_status: status,
      error: "downstream_failed",
      hint: `Downstream returned HTTP ${status}. Check the webhook/forward URL; this is not swallowed.`,
    });
  }
  return insertDelivery(env, {
    mailbox_id: input.mailboxId,
    message_id: input.messageId,
    kind: input.kind,
    target: input.target,
    status: "failed",
    http_status: input.result.httpStatus ?? null,
    error: input.result.error,
    hint: input.result.hint,
  });
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
  const resolveHost = opts.resolveHost ?? testResolve ?? resolveHostDoH;
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
    const dns = await recheckResolvedIps(url.hostname, allowPrivate, resolveHost);
    if (dns) {
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

async function recheckResolvedIps(
  hostname: string,
  allowPrivate: boolean,
  resolveHost: ResolveHost,
): Promise<SafeFetchResult | null> {
  if (isIpLiteral(hostname)) {
    return null;
  }
  let ips: string[] | null;
  try {
    ips = await resolveHost(hostname);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.log("inbound hooks: DNS re-check skipped", { hostname, detail });
    return null;
  }
  if (ips === null) {
    return null;
  }
  if (ips.length === 0) {
    return {
      ok: false,
      error: "unresolved_host",
      hint: `Host "${hostname}" did not resolve. Webhook/forward was not sent.`,
    };
  }
  if (allowPrivate) {
    return null;
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      return {
        ok: false,
        error: "blocked_destination",
        hint: `Host "${hostname}" resolved to blocked address ${ip}. Internal, metadata, loopback, RFC1918, link-local, and CGNAT targets are rejected after DNS.`,
      };
    }
  }
  return null;
}

async function resolveHostDoH(hostname: string): Promise<string[] | null> {
  const fetchImpl = testFetch ?? fetch;
  const ips = new Set<string>();
  try {
    for (const type of ["A", "AAAA"] as const) {
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
      const response = await fetchImpl(url, {
        headers: { accept: "application/dns-json" },
        redirect: "manual",
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> };
      for (const answer of body.Answer ?? []) {
        if ((answer.type === 1 || answer.type === 28) && typeof answer.data === "string") {
          ips.add(answer.data.replace(/\.$/, ""));
        }
      }
    }
    return [...ips];
  } catch {
    return null;
  }
}

function isIpLiteral(host: string): boolean {
  const value = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (value.includes(":")) {
    return true;
  }
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
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
