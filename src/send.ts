import type { Env } from "./env";
import {
  outboundFromAddress,
  resolveOutboundAdapter,
  type OutboundDraft,
  type SendInput,
} from "./outbound";
import {
  insertOutboundAttempt,
  type MailboxRecord,
  type OutboundAttemptRecord,
} from "./store";

export { parseSendFields, type SendInput } from "./outbound";

export interface SendOutcome {
  attempt: OutboundAttemptRecord;
  httpStatus: number;
}

/**
 * Resolve the adapter, attempt the send, and persist the outcome.
 * Config / provider failures are stored as `failed` so the UI can show them.
 */
export async function sendOutbound(
  env: Env,
  mailbox: MailboxRecord,
  input: SendInput,
): Promise<SendOutcome> {
  const from = outboundFromAddress(env, mailbox.address);
  const draft: OutboundDraft = {
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
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
    return { attempt, httpStatus: 503 };
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
    return { attempt, httpStatus: 200 };
  }

  const attempt = await persist(env, mailbox.id, draft, {
    provider: resolved.adapter.name,
    status: "failed",
    error: result.error ?? "outbound_failed",
    hint: [result.hint, result.detail].filter(Boolean).join(" "),
    providerMessageId: result.providerMessageId ?? null,
  });
  return { attempt, httpStatus: 502 };
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
    subject: draft.subject || null,
    body_text: draft.text || null,
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
