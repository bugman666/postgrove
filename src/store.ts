import type { Env } from "./env";
import {
  snippetFromBody,
  type DraftFields,
  type SystemFolder,
} from "./folders.ts";
import { chunkIds, sqlInPlaceholders, uniqueIds } from "./sql-in.ts";
import {
  candidateThreadIds,
  groupMessagesIntoThreads,
  relatedLookupRfcIds,
  resolveThreadIdForInsert,
  storedThreadId,
} from "./threads.ts";
import {
  escapeFts5Query,
  likeContains,
  SEARCH_ENGINE_FTS5,
  SEARCH_ENGINE_LIKE,
  type InboxFilter,
  type SearchEngine,
} from "./triage.ts";

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
  thread_id?: string | null;
}

export interface InboxQuery {
  q?: string;
  filter?: InboxFilter;
}

const MAILBOX_COLUMNS =
  "id, address, local_part, domain, display_name, status" as const;

export const INBOX_LIST_LIMIT = 200;

const MESSAGE_COLUMNS = `id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
  subject, snippet, body_text, header_to, header_cc, header_reply_to, in_reply_to,
  references_header, size_bytes, is_read, is_starred, folder, received_at, created_at,
  thread_id`;

/** List/thread grouping columns — omit `body_text` so open-thread does not rescan full bodies. */
const MESSAGE_HEAD_COLUMNS = `id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
  subject, snippet, header_to, header_cc, header_reply_to, in_reply_to,
  references_header, size_bytes, is_read, is_starred, folder, received_at, created_at,
  thread_id`;

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

export async function createMailbox(
  env: Env,
  input: { address: string; displayName?: string | null },
  now = Date.now(),
): Promise<MailboxRecord> {
  const parsed = parseMailboxAddress(input.address);
  if (!parsed) {
    throw new MailboxInputError(
      "invalid_address",
      "Address must look like local@domain.tld.",
    );
  }
  const existing = await getMailbox(env, parsed.address);
  if (existing) {
    throw new MailboxInputError("address_taken", "That address is already in this grove.");
  }
  const row: MailboxRecord = {
    id: crypto.randomUUID(),
    address: parsed.address,
    local_part: parsed.localPart,
    domain: parsed.domain,
    display_name: input.displayName?.trim() || null,
    status: "active",
  };
  await env.DB.prepare(
    `INSERT INTO mailboxes (
       id, address, local_part, domain, display_name, status, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      row.id,
      row.address,
      row.local_part,
      row.domain,
      row.display_name,
      row.status,
      now,
      now,
    )
    .run();
  return row;
}

export async function setMailboxStatus(
  env: Env,
  mailboxId: string,
  status: "active" | "disabled",
  now = Date.now(),
): Promise<MailboxRecord | null> {
  const result = await env.DB.prepare(
    `UPDATE mailboxes SET status = ?2, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(mailboxId, status, now)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return null;
  }
  return getMailbox(env, mailboxId);
}

export async function listMailboxesForUser(env: Env, userId: string): Promise<MailboxRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${MAILBOX_COLUMNS} FROM mailboxes
     WHERE id IN (SELECT mailbox_id FROM user_mailboxes WHERE user_id = ?1)
     ORDER BY created_at ASC, address ASC`,
  )
    .bind(userId)
    .all<MailboxRecord>();
  return rows.results ?? [];
}

export class MailboxInputError extends Error {
  error: string;
  constructor(error: string, hint: string) {
    super(hint);
    this.error = error;
  }
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
  const { messages } = await queryInboxMessages(env, mailboxId, query, MESSAGE_COLUMNS);
  return messages;
}

/** Inbox rows for list/thread grouping without selecting `body_text`. */
export async function listInboxMessageHeads(
  env: Env,
  mailboxId: string,
  query: InboxQuery = {},
): Promise<MessageRecord[]> {
  const { messages } = await queryInboxMessages(env, mailboxId, query, MESSAGE_HEAD_COLUMNS);
  return messages.map((row) => ({ ...row, body_text: row.body_text ?? null }));
}

/** Same list as `listInboxMessages`, plus the engine used for `q`. */
export async function searchInboxMessages(
  env: Env,
  mailboxId: string,
  query: InboxQuery = {},
): Promise<{ messages: MessageRecord[]; engine: SearchEngine }> {
  return queryInboxMessages(env, mailboxId, query, MESSAGE_COLUMNS);
}

async function queryInboxMessages(
  env: Env,
  mailboxId: string,
  query: InboxQuery,
  columns: string,
): Promise<{ messages: MessageRecord[]; engine: SearchEngine }> {
  const q = (query.q ?? "").trim();
  if (q && (await messagesFtsAvailable(env))) {
    const match = escapeFts5Query(q);
    if (!match) {
      return { messages: [], engine: SEARCH_ENGINE_FTS5 };
    }
    try {
      const messages = await queryInboxMessagesFts(env, mailboxId, query, columns, match);
      return { messages, engine: SEARCH_ENGINE_FTS5 };
    } catch (error) {
      if (isFtsUnavailableError(error)) {
        rememberFtsAvailable(env, false);
      }
    }
  }

  const { sql, binds } = inboxListWhere(mailboxId, query);
  const rows = await env.DB.prepare(
    `SELECT ${columns} FROM messages
     WHERE ${sql}
     ORDER BY received_at DESC, created_at DESC
     LIMIT ${INBOX_LIST_LIMIT}`,
  )
    .bind(...binds)
    .all<MessageRecord>();
  return { messages: rows.results ?? [], engine: SEARCH_ENGINE_LIKE };
}

async function queryInboxMessagesFts(
  env: Env,
  mailboxId: string,
  query: InboxQuery,
  columns: string,
  match: string,
): Promise<MessageRecord[]> {
  const filter = query.filter ?? "all";
  const clauses = ["m.mailbox_id = ?1", "m.folder = 'inbox'", "messages_fts MATCH ?2"];
  const binds: (string | number)[] = [mailboxId, match];
  if (filter === "unread") {
    clauses.push("m.is_read = 0");
  } else if (filter === "starred") {
    clauses.push("m.is_starred = 1");
  }
  const qualified = qualifyColumns(columns, "m");
  const rows = await env.DB.prepare(
    `SELECT ${qualified} FROM messages AS m
     INNER JOIN messages_fts ON messages_fts.message_id = m.id
     WHERE ${clauses.join(" AND ")}
     ORDER BY bm25(messages_fts, 4.0, 3.0, 8.0, 1.0) ASC, m.received_at DESC, m.created_at DESC
     LIMIT 200`,
  )
    .bind(...binds)
    .all<MessageRecord>();
  return rows.results ?? [];
}

function qualifyColumns(columns: string, alias: string): string {
  return columns
    .split(",")
    .map((part) => `${alias}.${part.replace(/\s+/g, " ").trim()}`)
    .join(", ");
}

const ftsAvailableByDb = new WeakMap<object, boolean>();

async function messagesFtsAvailable(env: Env): Promise<boolean> {
  const cached = ftsAvailableByDb.get(env.DB);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE name = 'messages_fts' LIMIT 1`,
    ).first<{ ok: number }>();
    const ok = row != null;
    ftsAvailableByDb.set(env.DB, ok);
    return ok;
  } catch {
    ftsAvailableByDb.set(env.DB, false);
    return false;
  }
}

function rememberFtsAvailable(env: Env, ok: boolean): void {
  ftsAvailableByDb.set(env.DB, ok);
}

function isFtsUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (table|module)|fts5/i.test(message);
}

function inboxListWhere(
  mailboxId: string,
  query: InboxQuery,
): { sql: string; binds: (string | number)[] } {
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
    const pattern = likeContains(q);
    const fromIdx = binds.length + 1;
    const subjectIdx = binds.length + 2;
    const bodyIdx = binds.length + 3;
    const toIdx = binds.length + 4;
    clauses.push(
      `(envelope_from LIKE ?${fromIdx} ESCAPE '\\' OR IFNULL(subject, '') LIKE ?${subjectIdx} ESCAPE '\\' OR IFNULL(body_text, '') LIKE ?${bodyIdx} ESCAPE '\\' OR IFNULL(envelope_to, '') LIKE ?${toIdx} ESCAPE '\\')`,
    );
    binds.push(pattern, pattern, pattern, pattern);
  }

  return { sql: clauses.join(" AND "), binds };
}

export async function getMailboxMessagesByIds(
  env: Env,
  mailboxId: string,
  messageIds: readonly string[],
): Promise<MessageRecord[]> {
  const found: MessageRecord[] = [];
  for (const chunk of chunkIds(messageIds)) {
    const placeholders = sqlInPlaceholders(2, chunk.length);
    const rows = await env.DB.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE mailbox_id = ?1 AND id IN (${placeholders})`,
    )
      .bind(mailboxId, ...chunk)
      .all<MessageRecord>();
    found.push(...(rows.results ?? []));
  }
  const byId = new Map(found.map((row) => [row.id, row]));
  return uniqueIds(messageIds)
    .map((id) => byId.get(id))
    .filter((row): row is MessageRecord => Boolean(row));
}

export async function listInboxMessagesByThreadId(
  env: Env,
  mailboxId: string,
  threadId: string,
): Promise<MessageRecord[]> {
  const key = threadId.trim();
  if (!key) {
    return [];
  }
  const rows = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE mailbox_id = ?1 AND folder = 'inbox' AND thread_id = ?2
     ORDER BY received_at ASC, created_at ASC`,
  )
    .bind(mailboxId, key)
    .all<MessageRecord>();
  return rows.results ?? [];
}

export async function listMailboxMessageHeads(
  env: Env,
  mailboxId: string,
): Promise<MessageRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${MESSAGE_HEAD_COLUMNS} FROM messages
     WHERE mailbox_id = ?1
     ORDER BY received_at ASC, created_at ASC`,
  )
    .bind(mailboxId)
    .all<MessageRecord>();
  return (rows.results ?? []).map((row) => ({ ...row, body_text: row.body_text ?? null }));
}

export async function findRelatedThreadMessages(
  env: Env,
  mailboxId: string,
  message: {
    id?: string;
    rfc_message_id?: string | null;
    in_reply_to?: string | null;
    references_header?: string | null;
    subject?: string | null;
    envelope_from: string;
    envelope_to: string;
    thread_id?: string | null;
  },
): Promise<MessageRecord[]> {
  const rfcIds = relatedLookupRfcIds(message);
  const threadIds = candidateThreadIds(message);
  if (rfcIds.length === 0 && threadIds.length === 0) {
    return [];
  }

  const found: MessageRecord[] = [];
  const seen = new Set<string>();
  const remember = (rows: MessageRecord[]) => {
    for (const row of rows) {
      if (message.id && row.id === message.id) {
        continue;
      }
      if (seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      found.push(row);
    }
  };

  for (const chunk of chunkIds(rfcIds)) {
    const rfcPlace = sqlInPlaceholders(2, chunk.length);
    const irtPlace = sqlInPlaceholders(2 + chunk.length, chunk.length);
    const rows = await env.DB.prepare(
      `SELECT ${MESSAGE_HEAD_COLUMNS} FROM messages
       WHERE mailbox_id = ?1
         AND (rfc_message_id IN (${rfcPlace}) OR in_reply_to IN (${irtPlace}))`,
    )
      .bind(mailboxId, ...chunk, ...chunk)
      .all<MessageRecord>();
    remember(rows.results ?? []);
  }

  for (const chunk of chunkIds(threadIds)) {
    const placeholders = sqlInPlaceholders(2, chunk.length);
    const rows = await env.DB.prepare(
      `SELECT ${MESSAGE_HEAD_COLUMNS} FROM messages
       WHERE mailbox_id = ?1 AND thread_id IN (${placeholders})`,
    )
      .bind(mailboxId, ...chunk)
      .all<MessageRecord>();
    remember(rows.results ?? []);
  }

  if (found.length === 0) {
    return [];
  }

  const extraThreadIds = uniqueIds(
    found.map((row) => storedThreadId(row) ?? "").filter(Boolean),
  ).filter((id) => !threadIds.includes(id));
  for (const chunk of chunkIds(extraThreadIds)) {
    const placeholders = sqlInPlaceholders(2, chunk.length);
    const rows = await env.DB.prepare(
      `SELECT ${MESSAGE_HEAD_COLUMNS} FROM messages
       WHERE mailbox_id = ?1 AND thread_id IN (${placeholders})`,
    )
      .bind(mailboxId, ...chunk)
      .all<MessageRecord>();
    remember(rows.results ?? []);
  }

  return found.map((row) => ({ ...row, body_text: row.body_text ?? null }));
}

export async function applyMessageThreadIds(
  env: Env,
  mailboxId: string,
  assignments: ReadonlyArray<{ id: string; thread_id: string }>,
): Promise<number> {
  const byThread = new Map<string, string[]>();
  for (const item of assignments) {
    const threadId = item.thread_id.trim();
    const id = item.id.trim();
    if (!threadId || !id) {
      continue;
    }
    const list = byThread.get(threadId) ?? [];
    list.push(id);
    byThread.set(threadId, list);
  }
  let changes = 0;
  for (const [threadId, ids] of byThread) {
    for (const chunk of chunkIds(ids)) {
      const placeholders = sqlInPlaceholders(3, chunk.length);
      const result = await env.DB.prepare(
        `UPDATE messages SET thread_id = ?2
         WHERE mailbox_id = ?1 AND id IN (${placeholders})`,
      )
        .bind(mailboxId, threadId, ...chunk)
        .run();
      changes += Number(result.meta.changes ?? 0);
    }
  }
  return changes;
}

/** One-time (per mailbox) backfill using the same Union-Find rules as list grouping. */
export async function ensureMailboxThreadIds(env: Env, mailboxId: string): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT id FROM messages WHERE mailbox_id = ?1 AND thread_id IS NULL LIMIT 1`,
  )
    .bind(mailboxId)
    .first<{ id: string }>();
  if (!pending) {
    return 0;
  }
  const all = await listMailboxMessageHeads(env, mailboxId);
  const threads = groupMessagesIntoThreads(all);
  const assignments: { id: string; thread_id: string }[] = [];
  for (const thread of threads) {
    for (const member of thread.messages) {
      if (storedThreadId(member) !== thread.id) {
        assignments.push({ id: member.id, thread_id: thread.id });
      }
    }
  }
  if (assignments.length === 0) {
    return 0;
  }
  return applyMessageThreadIds(env, mailboxId, assignments);
}

export async function persistThreadIdOnRecord(
  env: Env,
  mailboxId: string,
  row: MessageRecord,
): Promise<MessageRecord> {
  await ensureMailboxThreadIds(env, mailboxId);
  const related = await findRelatedThreadMessages(env, mailboxId, row);
  const resolved = resolveThreadIdForInsert(row, related);
  const next = { ...row, thread_id: resolved.threadId };
  const realign = resolved.members
    .filter((member) => member.id !== row.id && storedThreadId(member) !== resolved.threadId)
    .map((member) => ({ id: member.id, thread_id: resolved.threadId }));
  if (realign.length > 0) {
    await applyMessageThreadIds(env, mailboxId, realign);
  }
  return next;
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

/** Inbox-folder messages only — used to land login on a mailbox that already has mail. */
export async function countInboxMessages(env: Env, mailboxId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ?1 AND folder = 'inbox'`,
  )
    .bind(mailboxId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
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
     LIMIT ${INBOX_LIST_LIMIT}`,
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

/** One UPDATE per chunk instead of N mark-read statements. */
export async function markReadMany(
  env: Env,
  mailboxId: string,
  messageIds: readonly string[],
): Promise<number> {
  let changes = 0;
  for (const chunk of chunkIds(messageIds)) {
    const placeholders = sqlInPlaceholders(2, chunk.length);
    const result = await env.DB.prepare(
      `UPDATE messages SET is_read = 1
       WHERE mailbox_id = ?1 AND folder = 'inbox' AND is_read != 1
         AND id IN (${placeholders})`,
    )
      .bind(mailboxId, ...chunk)
      .run();
    changes += Number(result.meta.changes ?? 0);
  }
  return changes;
}

export function markMessagesReadLocally(
  rows: MessageRecord[],
  messageIds: Iterable<string>,
): MessageRecord[] {
  const marked = messageIds instanceof Set ? messageIds : new Set(messageIds);
  if (marked.size === 0) {
    return rows;
  }
  return rows.map((row) => (marked.has(row.id) ? { ...row, is_read: 1 } : row));
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
  const row = await persistThreadIdOnRecord(
    env,
    mailbox.id,
    draftRecord(id, mailbox, fields, now, now),
  );
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
  const row = await persistThreadIdOnRecord(
    env,
    mailbox.id,
    draftRecord(existing.id, mailbox, fields, now, existing.created_at),
  );
  const result = await env.DB.prepare(
    `UPDATE messages
     SET envelope_from = ?3, envelope_to = ?4, subject = ?5, snippet = ?6,
         body_text = ?7, header_cc = ?8, in_reply_to = ?9, references_header = ?10,
         received_at = ?11, thread_id = ?12
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
      row.thread_id ?? null,
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
  const row = await persistThreadIdOnRecord(
    env,
    mailbox.id,
    sentRecord(id, mailbox, fields, now, now),
  );
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
  const row = await persistThreadIdOnRecord(
    env,
    mailbox.id,
    sentRecord(existing.id, mailbox, fields, now, existing.created_at),
  );
  const result = await env.DB.prepare(
    `UPDATE messages
     SET folder = 'sent', envelope_from = ?3, envelope_to = ?4, subject = ?5,
         snippet = ?6, body_text = ?7, header_cc = ?8, in_reply_to = ?9,
         references_header = ?10, is_read = 1, received_at = ?11, thread_id = ?12
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
      row.thread_id ?? null,
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
       received_at, created_at, thread_id
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
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
      row.thread_id ?? null,
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
    thread_id: null,
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
    thread_id: null,
  };
}

export type OutboundAttemptStatus = "pending" | "sent" | "failed";

export const OUTBOUND_MAX_ATTEMPTS = 3;

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
  status: OutboundAttemptStatus;
  error: string | null;
  hint: string | null;
  provider_message_id: string | null;
  idempotency_key: string;
  attempt_count: number;
  max_attempts: number;
  last_attempt_at: number | null;
  sent_message_id: string | null;
  created_at: number;
  updated_at: number;
}

const OUTBOUND_COLUMNS = `id, mailbox_id, from_address, to_address, cc_address, subject,
  body_text, in_reply_to, references_header, provider, status, error, hint,
  provider_message_id, idempotency_key, attempt_count, max_attempts,
  last_attempt_at, sent_message_id, created_at, updated_at`;

export function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed/i.test(message);
}

export async function insertOutboundAttempt(
  env: Env,
  row: OutboundAttemptRecord,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO outbound_attempts (
       id, mailbox_id, from_address, to_address, cc_address, subject, body_text,
       in_reply_to, references_header, provider, status, error, hint,
       provider_message_id, created_at, idempotency_key, attempt_count,
       max_attempts, last_attempt_at, sent_message_id, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
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
      row.idempotency_key,
      row.attempt_count,
      row.max_attempts,
      row.last_attempt_at,
      row.sent_message_id,
      row.updated_at,
    )
    .run();
}

export async function updateOutboundAttempt(
  env: Env,
  row: OutboundAttemptRecord,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbound_attempts
     SET provider = ?3, status = ?4, error = ?5, hint = ?6,
         provider_message_id = ?7, attempt_count = ?8, last_attempt_at = ?9,
         sent_message_id = ?10, updated_at = ?11
     WHERE id = ?1 AND mailbox_id = ?2`,
  )
    .bind(
      row.id,
      row.mailbox_id,
      row.provider,
      row.status,
      row.error,
      row.hint,
      row.provider_message_id,
      row.attempt_count,
      row.last_attempt_at,
      row.sent_message_id,
      row.updated_at,
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

export async function getOutboundAttemptByIdempotency(
  env: Env,
  mailboxId: string,
  idempotencyKey: string,
): Promise<OutboundAttemptRecord | null> {
  return env.DB.prepare(
    `SELECT ${OUTBOUND_COLUMNS} FROM outbound_attempts
     WHERE mailbox_id = ?1 AND idempotency_key = ?2`,
  )
    .bind(mailboxId, idempotencyKey)
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
