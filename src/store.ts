import type { Env } from "./env";
import type { InboxFilter } from "./triage";

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
  header_to: string | null;
  header_cc: string | null;
  header_reply_to: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  size_bytes: number | null;
  is_read: number;
  is_starred: number;
  folder: string;
  received_at: number;
  created_at: number;
}

export interface InboxQuery {
  q?: string;
  filter?: InboxFilter;
}

const MAILBOX_COLUMNS =
  "id, address, local_part, domain, display_name, status" as const;

const MESSAGE_COLUMNS = `id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
  subject, snippet, body_text, header_to, header_cc, header_reply_to, in_reply_to,
  references_header, size_bytes, is_read, is_starred, folder, received_at, created_at`;

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
  query: InboxQuery = {},
): Promise<MessageRecord[]> {
  const filter = query.filter ?? "all";
  const q = (query.q ?? "").trim();
  const clauses = ["mailbox_id = ?1", "folder = 'inbox'"];
  const binds: (string | number)[] = [mailboxId];

  if (filter === "unread") {
    clauses.push("is_read = 0");
  } else if (filter === "starred") {
    clauses.push("is_starred = 1");
  }

  if (q) {
    const pattern = likeContainsPattern(q);
    const fromIdx = binds.length + 1;
    const subjectIdx = binds.length + 2;
    const bodyIdx = binds.length + 3;
    clauses.push(
      `(envelope_from LIKE ?${fromIdx} ESCAPE '\\' OR IFNULL(subject, '') LIKE ?${subjectIdx} ESCAPE '\\' OR IFNULL(body_text, '') LIKE ?${bodyIdx} ESCAPE '\\')`,
    );
    binds.push(pattern, pattern, pattern);
  }

  const rows = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE ${clauses.join(" AND ")}
     ORDER BY received_at DESC, created_at DESC
     LIMIT 200`,
  )
    .bind(...binds)
    .all<MessageRecord>();
  return rows.results ?? [];
}

function likeContainsPattern(value: string): string {
  return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

export async function countUnreadInbox(env: Env, mailboxId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS unread_count FROM messages
     WHERE mailbox_id = ?1 AND folder = 'inbox' AND is_read = 0`,
  )
    .bind(mailboxId)
    .first<{ unread_count: number }>();
  return Number(row?.unread_count ?? 0);
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
  await setRead(env, mailboxId, messageId, true);
}

export async function setRead(
  env: Env,
  mailboxId: string,
  messageId: string,
  isRead: boolean,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE messages SET is_read = ?3
     WHERE id = ?1 AND mailbox_id = ?2 AND folder = 'inbox'`,
  )
    .bind(messageId, mailboxId, isRead ? 1 : 0)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setStarred(
  env: Env,
  mailboxId: string,
  messageId: string,
  isStarred: boolean,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE messages SET is_starred = ?3
     WHERE id = ?1 AND mailbox_id = ?2 AND folder = 'inbox'`,
  )
    .bind(messageId, mailboxId, isStarred ? 1 : 0)
    .run();
  return (result.meta.changes ?? 0) > 0;
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
  cc_address: string | null;
  subject: string | null;
  body_text: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  provider: string;
  status: "sent" | "failed";
  error: string | null;
  hint: string | null;
  provider_message_id: string | null;
  created_at: number;
}

const OUTBOUND_COLUMNS = `id, mailbox_id, from_address, to_address, cc_address, subject,
  body_text, in_reply_to, references_header, provider, status, error, hint,
  provider_message_id, created_at`;

export async function insertOutboundAttempt(
  env: Env,
  row: OutboundAttemptRecord,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO outbound_attempts (
       id, mailbox_id, from_address, to_address, cc_address, subject, body_text,
       in_reply_to, references_header, provider, status, error, hint,
       provider_message_id, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  )
    .bind(
      row.id,
      row.mailbox_id,
      row.from_address,
      row.to_address,
      row.cc_address,
      row.subject,
      row.body_text,
      row.in_reply_to,
      row.references_header,
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
