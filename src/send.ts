import type { Env } from "./env.ts";
import {
  outboundFromAddress,
  resolveOutboundAdapter,
  type OutboundAdapter,
  type OutboundDraft,
  type SendInput,
} from "./outbound.ts";
import { checkSendQuota, incrementSendUsage } from "./quotas.ts";
import {
  getMailboxMessage,
  getOutboundAttemptByIdempotency,
  insertOutboundAttempt,
  insertSentMessage,
  isUniqueConstraintError,
  OUTBOUND_MAX_ATTEMPTS,
  promoteDraftToSent,
  updateOutboundAttempt,
  type MailboxRecord,
  type MessageRecord,
  type OutboundAttemptRecord,
} from "./store.ts";
import { getUser } from "./users.ts";

export { parseSendFields, type SendInput } from "./outbound.ts";
export { OUTBOUND_MAX_ATTEMPTS };

export const IDEMPOTENCY_KEY_MAX = 128;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]+$/;

export interface SendOutcome {
  attempt: OutboundAttemptRecord;
  httpStatus: number;
  sent: MessageRecord | null;
}

export interface SendOptions {
  draftId?: string | null;
  userId?: string | null;
  idempotencyKey?: string | null;
  /** Test hook — production callers resolve the adapter from env. */
  adapter?: OutboundAdapter;
}

/**
 * Outbox send: persist `pending` + idempotency key before the provider call,
 * retry transient failures in-request (cap `OUTBOUND_MAX_ATTEMPTS`), then
 * mark `sent` / `failed` and write the Sent folder row.
 *
 * wrangler.jsonc has no cron triggers yet. Leftover `pending` rows can be
 * finished by replaying the same idempotency key; a scheduled drain is a
 * later step.
 */
export async function sendOutbound(
  env: Env,
  mailbox: MailboxRecord,
  input: SendInput,
  options: SendOptions = {},
): Promise<SendOutcome> {
  const parsedKey = parseIdempotencyKey(options.idempotencyKey);
  if (!parsedKey.ok) {
    return {
      attempt: syntheticAttempt(mailbox, input, {
        provider: (env.OUTBOUND_PROVIDER ?? "").trim() || "unset",
        status: "failed",
        error: parsedKey.error,
        hint: parsedKey.hint,
      }),
      httpStatus: 400,
      sent: null,
    };
  }
  const idempotencyKey = parsedKey.key ?? newIdempotencyKey();
  const draft = buildDraft(env, mailbox, input);

  const existing = await getOutboundAttemptByIdempotency(env, mailbox.id, idempotencyKey);
  if (existing) {
    return resumeAttempt(env, mailbox, input, draft, existing, options);
  }

  if (options.userId) {
    const user = await getUser(env, options.userId);
    if (user) {
      const quota = await checkSendQuota(env, user);
      if (quota) {
        const attempt = await persistNew(env, mailbox.id, draft, {
          provider: (env.OUTBOUND_PROVIDER ?? "").trim() || "unset",
          status: "failed",
          error: quota.error,
          hint: quota.hint,
          providerMessageId: null,
          idempotencyKey,
        });
        return finishReserved(env, mailbox, input, draft, attempt, options);
      }
    }
  }

  const resolved = options.adapter
    ? { ok: true as const, adapter: options.adapter }
    : resolveOutboundAdapter(env);
  if (!resolved.ok) {
    const attempt = await persistNew(env, mailbox.id, draft, {
      provider: (env.OUTBOUND_PROVIDER ?? "").trim() || "unset",
      status: "failed",
      error: resolved.error,
      hint: resolved.hint,
      providerMessageId: null,
      idempotencyKey,
    });
    return finishReserved(env, mailbox, input, draft, attempt, options);
  }

  const attempt = await persistNew(env, mailbox.id, draft, {
    provider: resolved.adapter.name,
    status: "pending",
    error: null,
    hint: null,
    providerMessageId: null,
    idempotencyKey,
  });
  return finishReserved(env, mailbox, input, draft, attempt, options);
}

export function parseIdempotencyKey(
  raw: unknown,
): { ok: true; key: string | null } | { ok: false; error: string; hint: string } {
  if (raw == null) {
    return { ok: true, key: null };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: "invalid_request",
      hint: "idempotency_key must be a string.",
    };
  }
  const key = raw.trim();
  if (!key) {
    return { ok: true, key: null };
  }
  if (key.length > IDEMPOTENCY_KEY_MAX || !IDEMPOTENCY_KEY_RE.test(key)) {
    return {
      ok: false,
      error: "invalid_request",
      hint: `idempotency_key must be 1–${IDEMPOTENCY_KEY_MAX} visible ASCII characters (no spaces).`,
    };
  }
  return { ok: true, key };
}

export function readIdempotencyKey(
  request: Request,
  body?: Record<string, unknown> | null,
): unknown {
  const header = request.headers.get("idempotency-key");
  if (header != null && header.trim()) {
    return header;
  }
  if (body && typeof body.idempotency_key === "string") {
    return body.idempotency_key;
  }
  return null;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function publicOutboundAttempt(row: OutboundAttemptRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    from: row.from_address,
    to: row.to_address,
    cc: row.cc_address,
    subject: row.subject,
    in_reply_to: row.in_reply_to,
    references: row.references_header,
    provider: row.provider,
    status: row.status,
    error: row.error,
    hint: row.hint,
    provider_message_id: row.provider_message_id,
    idempotency_key: row.idempotency_key,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    sent_message_id: row.sent_message_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function finishReserved(
  env: Env,
  mailbox: MailboxRecord,
  input: SendInput,
  draft: OutboundDraft,
  reserved: OutboundAttemptRecord,
  options: SendOptions,
): Promise<SendOutcome> {
  if (reserved.status === "sent" || reserved.status === "failed") {
    return resumeAttempt(env, mailbox, input, draft, reserved, options);
  }
  return dispatchAttempt(env, mailbox, input, draft, reserved, options);
}

async function resumeAttempt(
  env: Env,
  mailbox: MailboxRecord,
  input: SendInput,
  draft: OutboundDraft,
  existing: OutboundAttemptRecord,
  options: SendOptions,
): Promise<SendOutcome> {
  if (existing.status === "sent") {
    const sent = await ensureSentRecord(env, mailbox, input, existing, options.draftId);
    return { attempt: sent.attempt, httpStatus: 200, sent: sent.sent };
  }
  if (existing.status === "failed") {
    return { attempt: existing, httpStatus: httpStatusForFailed(existing), sent: null };
  }
  return dispatchAttempt(env, mailbox, input, draft, existing, options);
}

async function dispatchAttempt(
  env: Env,
  mailbox: MailboxRecord,
  input: SendInput,
  draft: OutboundDraft,
  attempt: OutboundAttemptRecord,
  options: SendOptions,
): Promise<SendOutcome> {
  const resolved = options.adapter
    ? { ok: true as const, adapter: options.adapter }
    : resolveOutboundAdapter(env);
  if (!resolved.ok) {
    attempt.status = "failed";
    attempt.error = resolved.error;
    attempt.hint = resolved.hint;
    attempt.provider = (env.OUTBOUND_PROVIDER ?? "").trim() || "unset";
    attempt.updated_at = Date.now();
    await updateOutboundAttempt(env, attempt);
    return { attempt, httpStatus: 503, sent: null };
  }

  const adapter = resolved.adapter;
  const max = attempt.max_attempts || OUTBOUND_MAX_ATTEMPTS;
  let result: Awaited<ReturnType<OutboundAdapter["send"]>> | null = null;

  while (attempt.attempt_count < max) {
    attempt.attempt_count += 1;
    attempt.last_attempt_at = Date.now();
    attempt.updated_at = attempt.last_attempt_at;
    attempt.provider = adapter.name;
    await updateOutboundAttempt(env, attempt);

    result = await adapter.send(draft);
    if (result.ok || !result.retryable) {
      break;
    }
  }

  if (result?.ok) {
    attempt.status = "sent";
    attempt.error = null;
    attempt.hint = null;
    attempt.provider_message_id = result.providerMessageId ?? null;
    attempt.provider = adapter.name;
    attempt.updated_at = Date.now();
    await updateOutboundAttempt(env, attempt);

    const sent = await recordSent(env, mailbox, input, options.draftId);
    attempt.sent_message_id = sent.id;
    attempt.updated_at = Date.now();
    await updateOutboundAttempt(env, attempt);

    if (options.userId) {
      await incrementSendUsage(env, options.userId);
    }
    return { attempt, httpStatus: 200, sent };
  }

  attempt.status = "failed";
  attempt.error = result?.error ?? "outbound_failed";
  attempt.hint = [result?.hint, result?.detail].filter(Boolean).join(" ");
  attempt.provider = adapter.name;
  attempt.updated_at = Date.now();
  await updateOutboundAttempt(env, attempt);
  return { attempt, httpStatus: 502, sent: null };
}

async function ensureSentRecord(
  env: Env,
  mailbox: MailboxRecord,
  input: SendInput,
  attempt: OutboundAttemptRecord,
  draftId?: string | null,
): Promise<{ attempt: OutboundAttemptRecord; sent: MessageRecord }> {
  if (attempt.sent_message_id) {
    const existing = await getMailboxMessage(env, mailbox.id, attempt.sent_message_id);
    if (existing) {
      return { attempt, sent: existing };
    }
  }
  const sent = await recordSent(env, mailbox, input, draftId);
  attempt.sent_message_id = sent.id;
  attempt.updated_at = Date.now();
  await updateOutboundAttempt(env, attempt);
  return { attempt, sent };
}

async function persistNew(
  env: Env,
  mailboxId: string,
  draft: OutboundDraft,
  fields: {
    provider: string;
    status: OutboundAttemptRecord["status"];
    error: string | null;
    hint: string | null;
    providerMessageId: string | null;
    idempotencyKey: string;
  },
): Promise<OutboundAttemptRecord> {
  const now = Date.now();
  const record: OutboundAttemptRecord = {
    id: crypto.randomUUID(),
    mailbox_id: mailboxId,
    from_address: draft.from,
    to_address: draft.to,
    cc_address: draft.cc || null,
    subject: draft.subject || null,
    body_text: draft.text || null,
    in_reply_to: draft.headers?.["In-Reply-To"] ?? null,
    references_header: draft.headers?.References ?? null,
    provider: fields.provider,
    status: fields.status,
    error: fields.error,
    hint: fields.hint,
    provider_message_id: fields.providerMessageId,
    idempotency_key: fields.idempotencyKey,
    attempt_count: 0,
    max_attempts: OUTBOUND_MAX_ATTEMPTS,
    last_attempt_at: null,
    sent_message_id: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await insertOutboundAttempt(env, record);
    return record;
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = await getOutboundAttemptByIdempotency(env, mailboxId, fields.idempotencyKey);
    if (!existing) {
      throw error;
    }
    return existing;
  }
}

async function recordSent(
  env: Env,
  mailbox: MailboxRecord,
  input: SendInput,
  draftId?: string | null,
): Promise<MessageRecord> {
  const fields = {
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text: input.text,
    inReplyTo: input.inReplyTo,
    references: input.references,
  };
  if (draftId) {
    const promoted = await promoteDraftToSent(env, mailbox, draftId, fields);
    if (promoted) {
      return promoted;
    }
  }
  return insertSentMessage(env, mailbox, fields);
}

function buildDraft(env: Env, mailbox: MailboxRecord, input: SendInput): OutboundDraft {
  const headers: OutboundDraft["headers"] = {};
  if (input.inReplyTo) {
    headers["In-Reply-To"] = input.inReplyTo;
  }
  if (input.references) {
    headers.References = input.references;
  }
  return {
    from: outboundFromAddress(env, mailbox.address),
    to: input.to,
    cc: input.cc || undefined,
    subject: input.subject,
    text: input.text,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

function httpStatusForFailed(attempt: OutboundAttemptRecord): number {
  if (attempt.error === "quota_send") {
    return 429;
  }
  if (attempt.error === "outbound_not_configured" || attempt.error === "unknown_provider") {
    return 503;
  }
  if (attempt.error === "invalid_request") {
    return 400;
  }
  return 502;
}

function syntheticAttempt(
  mailbox: MailboxRecord,
  input: SendInput,
  fields: {
    provider: string;
    status: OutboundAttemptRecord["status"];
    error: string;
    hint: string;
  },
): OutboundAttemptRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    mailbox_id: mailbox.id,
    from_address: mailbox.address,
    to_address: input.to,
    cc_address: input.cc || null,
    subject: input.subject || null,
    body_text: input.text || null,
    in_reply_to: input.inReplyTo,
    references_header: input.references,
    provider: fields.provider,
    status: fields.status,
    error: fields.error,
    hint: fields.hint,
    provider_message_id: null,
    idempotency_key: "",
    attempt_count: 0,
    max_attempts: OUTBOUND_MAX_ATTEMPTS,
    last_attempt_at: null,
    sent_message_id: null,
    created_at: now,
    updated_at: now,
  };
}
