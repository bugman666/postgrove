import type { Env } from "./env";

export interface MailboxRecord {
  id: string;
  address: string;
  local_part: string;
  domain: string;
  display_name: string | null;
  status: string;
}

export interface MessageRecord {
  id: string;
  mailbox_id: string;
  rfc_message_id: string | null;
  envelope_from: string;
  envelope_to: string;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  size_bytes: number | null;
  is_read: number;
  folder: string;
  received_at: number;
  created_at: number;
}

const MAILBOX_COLUMNS =
  "id, address, local_part, domain, display_name, status" as const;

const MESSAGE_COLUMNS = `id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
  subject, snippet, body_text, size_bytes, is_read, folder, received_at, created_at`;

export async function listMailboxes(env: Env): Promise<MailboxRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${MAILBOX_COLUMNS} FROM mailboxes ORDER BY created_at ASC, address ASC`,
  ).all<MailboxRecord>();
  return rows.results ?? [];
}

export async function getMailbox(
  env: Env,
  idOrAddress: string,
): Promise<MailboxRecord | null> {
  const key = idOrAddress.trim();
  if (!key) {
    return null;
  }
  if (key.includes("@")) {
    return env.DB.prepare(
      `SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE address = ?1`,
    )
      .bind(key.toLowerCase())
      .first<MailboxRecord>();
  }
  return env.DB.prepare(`SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE id = ?1`)
    .bind(key)
    .first<MailboxRecord>();
}

export async function defaultMailbox(env: Env): Promise<MailboxRecord | null> {
  return env.DB.prepare(
    `SELECT ${MAILBOX_COLUMNS} FROM mailboxes
     WHERE status = 'active'
     ORDER BY created_at ASC, address ASC
     LIMIT 1`,
  ).first<MailboxRecord>();
}

export async function listInboxMessages(
  env: Env,
  mailboxId: string,
): Promise<MessageRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE mailbox_id = ?1 AND folder = 'inbox'
     ORDER BY received_at DESC, created_at DESC
     LIMIT 200`,
  )
    .bind(mailboxId)
    .all<MessageRecord>();
  return rows.results ?? [];
}

export async function getInboxMessage(
  env: Env,
  mailboxId: string,
  messageId: string,
): Promise<MessageRecord | null> {
  return env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE id = ?1 AND mailbox_id = ?2 AND folder = 'inbox'`,
  )
    .bind(messageId, mailboxId)
    .first<MessageRecord>();
}

export async function getMessageById(
  env: Env,
  messageId: string,
): Promise<MessageRecord | null> {
  return env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?1 AND folder = 'inbox'`,
  )
    .bind(messageId)
    .first<MessageRecord>();
}

export async function markRead(
  env: Env,
  mailboxId: string,
  messageId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE messages SET is_read = 1
     WHERE id = ?1 AND mailbox_id = ?2 AND folder = 'inbox'`,
  )
    .bind(messageId, mailboxId)
    .run();
}

export async function trashMessage(
  env: Env,
  mailboxId: string,
  messageId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE messages SET folder = 'trash'
     WHERE id = ?1 AND mailbox_id = ?2 AND folder = 'inbox'`,
  )
    .bind(messageId, mailboxId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export interface OutboundAttemptRecord {
  id: string;
  mailbox_id: string;
  from_address: string;
  to_address: string;
  subject: string | null;
  body_text: string | null;
  provider: string;
  status: "sent" | "failed";
  error: string | null;
  hint: string | null;
  provider_message_id: string | null;
  created_at: number;
}

const OUTBOUND_COLUMNS = `id, mailbox_id, from_address, to_address, subject, body_text,
  provider, status, error, hint, provider_message_id, created_at`;

export async function insertOutboundAttempt(
  env: Env,
  row: OutboundAttemptRecord,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO outbound_attempts (
       id, mailbox_id, from_address, to_address, subject, body_text,
       provider, status, error, hint, provider_message_id, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      row.id,
      row.mailbox_id,
      row.from_address,
      row.to_address,
      row.subject,
      row.body_text,
      row.provider,
      row.status,
      row.error,
      row.hint,
      row.provider_message_id,
      row.created_at,
    )
    .run();
}

export async function getOutboundAttempt(
  env: Env,
  mailboxId: string,
  attemptId: string,
): Promise<OutboundAttemptRecord | null> {
  return env.DB.prepare(
    `SELECT ${OUTBOUND_COLUMNS} FROM outbound_attempts
     WHERE id = ?1 AND mailbox_id = ?2`,
  )
    .bind(attemptId, mailboxId)
    .first<OutboundAttemptRecord>();
}

export async function listOutboundAttempts(
  env: Env,
  mailboxId: string,
  limit = 20,
): Promise<OutboundAttemptRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${OUTBOUND_COLUMNS} FROM outbound_attempts
     WHERE mailbox_id = ?1
     ORDER BY created_at DESC
     LIMIT ?2`,
  )
    .bind(mailboxId, limit)
    .all<OutboundAttemptRecord>();
  return rows.results ?? [];
}
