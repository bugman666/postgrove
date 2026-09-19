import type { Env } from "./env";
import {
  outboundFromAddress,
  resolveOutboundAdapter,
  type OutboundDraft,
  type SendInput,
} from "./outbound";
import {
  insertOutboundAttempt,
  insertSentMessage,
  promoteDraftToSent,
  type MailboxRecord,
  type MessageRecord,
  type OutboundAttemptRecord,
} from "./store";

export { parseSendFields, type SendInput } from "./outbound";

export interface SendOutcome {
  attempt: OutboundAttemptRecord;
  httpStatus: number;
  sent: MessageRecord | null;
}

/**
 * Resolve the adapter, attempt the send, and persist the outcome.
 * Config / provider failures are stored as `failed` so the UI can show them.
 * A successful send also writes a `folder=sent` message (and consumes a draft).
 */
export async function sendOutbound(
  env: Env,
  mailbox: MailboxRecord,
  input: SendInput,
  options: { draftId?: string | null } = {},
): Promise<SendOutcome> {
  const from = outboundFromAddress(env, mailbox.address);
  const headers: OutboundDraft["headers"] = {};
  if (input.inReplyTo) {
    headers["In-Reply-To"] = input.inReplyTo;
  }
  if (input.references) {
    headers.References = input.references;
  }
  const draft: OutboundDraft = {
    from,
    to: input.to,
    cc: input.cc || undefined,
    subject: input.subject,
    text: input.text,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };

  const resolved = resolveOutboundAdapter(env);
  if (!resolved.ok) {
    const attempt = await persist(env, mailbox.id, draft, {
      provider: (env.OUTBOUND_PROVIDER ?? "").trim() || "unset",
      status: "failed",
      error: resolved.error,
      hint: resolved.hint,
      providerMessageId: null,
    });
    return { attempt, httpStatus: 503, sent: null };
  }

  const result = await resolved.adapter.send(draft);
  if (result.ok) {
    const attempt = await persist(env, mailbox.id, draft, {
      provider: resolved.adapter.name,
      status: "sent",
      error: null,
      hint: null,
      providerMessageId: result.providerMessageId ?? null,
    });
    const sent = await recordSent(env, mailbox, input, options.draftId);
    return { attempt, httpStatus: 200, sent };
  }

  const attempt = await persist(env, mailbox.id, draft, {
    provider: resolved.adapter.name,
    status: "failed",
    error: result.error ?? "outbound_failed",
    hint: [result.hint, result.detail].filter(Boolean).join(" "),
    providerMessageId: result.providerMessageId ?? null,
  });
  return { attempt, httpStatus: 502, sent: null };
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

async function persist(
  env: Env,
  mailboxId: string,
  draft: OutboundDraft,
  fields: {
    provider: string;
    status: "sent" | "failed";
    error: string | null;
    hint: string | null;
    providerMessageId: string | null;
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
    created_at: now,
  };
  await insertOutboundAttempt(env, record);
  return record;
}
