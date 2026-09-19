import type { Env } from "./env";
import {
  snippetFromBody,
  type DraftFields,
  type SystemFolder,
} from "./folders.ts";
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

export type InsertMailboxResult =
  | { ok: true; mailbox: MailboxRecord }
  | { ok: false; error: "invalid_address" | "address_taken"; hint: string };

const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseMailboxAddress(raw: string): { address: string; localPart: string; domain: string } | null {
  const address = raw.trim().toLowerCase();
  if (!ADDRESS_RE.test(address) || address.length > 254) {
    return null;
  }
  const at = address.lastIndexOf("@");
  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!localPart || localPart.length > 64 || !domain.includes(".")) {
    return null;
  }
  return { address, localPart, domain };
}

export async function insertMailbox(
  env: Env,
  input: { address: string; displayName?: string | null },
  now = Date.now(),
): Promise<InsertMailboxResult> {
  const parsed = parseMailboxAddress(input.address);
  if (!parsed) {
    return {
      ok: false,
      error: "invalid_address",
      hint: "address must be a single email like support@example.test.",
    };
  }
  const existing = await getMailbox(env, parsed.address);
  if (existing) {
    return {
      ok: false,
      error: "address_taken",
      hint: "That address already exists. Choose another local part.",
    };
  }
  const mailbox: MailboxRecord = {
    id: crypto.randomUUID(),
    address: parsed.address,
    local_part: parsed.localPart,
    domain: parsed.domain,
    display_name: input.displayName?.trim() || null,
    status: "active",
  };
  await env.DB.prepare(
    `INSERT INTO mailboxes (id, address, local_part, domain, display_name, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      mailbox.id,
      mailbox.address,
      mailbox.local_part,
      mailbox.domain,
      mailbox.display_name,
      mailbox.status,
      now,
      now,
    )
    .run();
  return { ok: true, mailbox };
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

export async function listFolderMessages(
  env: Env,
  mailboxId: string,
  folder: SystemFolder,
): Promise<MessageRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE mailbox_id = ?1 AND folder = ?2
     ORDER BY received_at DESC, created_at DESC
     LIMIT 200`,
  )
    .bind(mailboxId, folder)
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

export async function getMailboxMessage(
  env: Env,
  mailboxId: string,
  messageId: string,
): Promise<MessageRecord | null> {
  return env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE id = ?1 AND mailbox_id = ?2`,
  )
    .bind(messageId, mailboxId)
    .first<MessageRecord>();
}

export async function getMessageById(
  env: Env,
  messageId: string,
): Promise<MessageRecord | null> {
  return env.DB.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?1`)
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
     WHERE id = ?1 AND mailbox_id = ?2 AND folder != 'trash'`,
  )
    .bind(messageId, mailboxId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function moveMessage(
  env: Env,
  mailboxId: string,
  messageId: string,
  folder: SystemFolder,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE messages SET folder = ?3
     WHERE id = ?1 AND mailbox_id = ?2`,
  )
    .bind(messageId, mailboxId, folder)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function insertDraft(
  env: Env,
  mailbox: MailboxRecord,
  fields: DraftFields,
  now = Date.now(),
): Promise<MessageRecord> {
  const id = crypto.randomUUID();
  const row = draftRecord(id, mailbox, fields, now, now);
  await insertMessage(env, row);
  return row;
}

export async function updateDraft(
  env: Env,
  mailbox: MailboxRecord,
  messageId: string,
  fields: DraftFields,
  now = Date.now(),
): Promise<MessageRecord | null> {
  const existing = await getMailboxMessage(env, mailbox.id, messageId);
  if (!existing || existing.folder !== "draft") {
    return null;
  }
  const row = draftRecord(existing.id, mailbox, fields, now, existing.created_at);
  const result = await env.DB.prepare(
    `UPDATE messages
     SET envelope_from = ?3, envelope_to = ?4, subject = ?5, snippet = ?6,
         body_text = ?7, header_cc = ?8, in_reply_to = ?9, references_header = ?10,
         received_at = ?11
     WHERE id = ?1 AND mailbox_id = ?2 AND folder = 'draft'`,
  )
    .bind(
      existing.id,
      mailbox.id,
      row.envelope_from,
      row.envelope_to,
      row.subject,
      row.snippet,
      row.body_text,
      row.header_cc,
      row.in_reply_to,
      row.references_header,
      row.received_at,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return null;
  }
  return row;
}

export async function insertSentMessage(
  env: Env,
  mailbox: MailboxRecord,
  fields: {
    to: string;
    cc: string;
    subject: string;
    text: string;
    inReplyTo: string | null;
    references: string | null;
  },
  now = Date.now(),
): Promise<MessageRecord> {
  const id = crypto.randomUUID();
  const row = sentRecord(id, mailbox, fields, now, now);
  await insertMessage(env, row);
  return row;
}

export async function promoteDraftToSent(
  env: Env,
  mailbox: MailboxRecord,
  draftId: string,
  fields: {
    to: string;
    cc: string;
    subject: string;
    text: string;
    inReplyTo: string | null;
    references: string | null;
  },
  now = Date.now(),
): Promise<MessageRecord | null> {
  const existing = await getMailboxMessage(env, mailbox.id, draftId);
  if (!existing || existing.folder !== "draft") {
    return null;
  }
  const row = sentRecord(existing.id, mailbox, fields, now, existing.created_at);
  const result = await env.DB.prepare(
    `UPDATE messages
     SET folder = 'sent', envelope_from = ?3, envelope_to = ?4, subject = ?5,
         snippet = ?6, body_text = ?7, header_cc = ?8, in_reply_to = ?9,
         references_header = ?10, is_read = 1, received_at = ?11
     WHERE id = ?1 AND mailbox_id = ?2 AND folder = 'draft'`,
  )
    .bind(
      existing.id,
      mailbox.id,
      row.envelope_from,
      row.envelope_to,
      row.subject,
      row.snippet,
      row.body_text,
      row.header_cc,
      row.in_reply_to,
      row.references_header,
      row.received_at,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return null;
  }
  return row;
}

export async function insertMessage(env: Env, row: MessageRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
       id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
       subject, snippet, body_text, header_to, header_cc, header_reply_to,
       in_reply_to, references_header, size_bytes, is_read, is_starred, folder,
       received_at, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
  )
    .bind(
      row.id,
      row.mailbox_id,
      row.rfc_message_id,
      row.envelope_from,
      row.envelope_to,
      row.subject,
      row.snippet,
      row.body_text,
      row.header_to,
      row.header_cc,
      row.header_reply_to,
      row.in_reply_to,
      row.references_header,
      row.size_bytes,
      row.is_read,
      row.is_starred,
      row.folder,
      row.received_at,
      row.created_at,
    )
    .run();
}

function draftRecord(
  id: string,
  mailbox: MailboxRecord,
  fields: DraftFields,
  receivedAt: number,
  createdAt: number,
): MessageRecord {
  return {
    id,
    mailbox_id: mailbox.id,
    rfc_message_id: null,
    envelope_from: mailbox.address,
    envelope_to: fields.to.trim(),
    subject: fields.subject,
    snippet: snippetFromBody(fields.text) || snippetFromBody(fields.subject),
    body_text: fields.text,
    header_to: fields.to.trim() || null,
    header_cc: fields.cc.trim() || null,
    header_reply_to: null,
    in_reply_to: fields.inReplyTo,
    references_header: fields.references,
    size_bytes: fields.text.length,
    is_read: 1,
    is_starred: 0,
    folder: "draft",
    received_at: receivedAt,
    created_at: createdAt,
  };
}

function sentRecord(
  id: string,
  mailbox: MailboxRecord,
  fields: {
    to: string;
    cc: string;
    subject: string;
    text: string;
    inReplyTo: string | null;
    references: string | null;
  },
  receivedAt: number,
  createdAt: number,
): MessageRecord {
  return {
    id,
    mailbox_id: mailbox.id,
    rfc_message_id: null,
    envelope_from: mailbox.address,
    envelope_to: fields.to,
    subject: fields.subject || null,
    snippet: snippetFromBody(fields.text) || snippetFromBody(fields.subject),
    body_text: fields.text,
    header_to: fields.to || null,
    header_cc: fields.cc || null,
    header_reply_to: null,
    in_reply_to: fields.inReplyTo,
    references_header: fields.references,
    size_bytes: fields.text.length,
    is_read: 1,
    is_starred: 0,
    folder: "sent",
    received_at: receivedAt,
    created_at: createdAt,
  };
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
