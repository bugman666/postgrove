import type { Env } from "./env";
import { requireOwner, type OwnerPrincipal } from "./auth";
import { handleOwnerTokenRoutes } from "./rest.ts";
import {
  isSystemFolder,
  parseDraftFields,
  parseFolder,
  publicFolderList,
} from "./folders";
import { forbiddenJson, json, methodNotAllowed, notFoundJson } from "./http";
import { buildComposePrefill, parseComposeMode } from "./reply";
import { parseSendFields, sendOutbound } from "./send";
import {
  countUnreadInbox,
  getInboxMessage,
  getMailbox,
  getMailboxMessage,
  getMessageById,
  insertDraft,
  insertMailbox,
  listFolderMessages,
  listInboxMessages,
  listOutboundAttempts,
  markRead,
  moveMessage,
  setRead,
  setStarred,
  trashMessage,
  updateDraft,
  type MailboxRecord,
  type MessageRecord,
  type OutboundAttemptRecord,
} from "./store";
import {
  findThreadById,
  groupMessagesIntoThreads,
  latestThreadMessage,
  threadHasStar,
  threadHasUnread,
  type MessageThread,
} from "./threads";
import { parseInboxFilter, parseSearchQuery, SEARCH_ENGINE } from "./triage";

export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const gate = await requireOwner(request, env);
  if (!gate.ok) {
    return gate.response;
  }

  const path = url.pathname;
  const method = request.method;
  const owner = gate.principal;

  const tokens = await handleOwnerTokenRoutes(request, env, url, owner);
  if (tokens) {
    return tokens;
  }

  if (path === "/api/mailboxes" && method === "POST") {
    return createOwnedMailbox(request, env);
  }

  if (path === "/api/send") {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return sendMessage(request, env, owner);
  }

  if (path === "/api/outbound/attempts") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    const mailbox = await getMailbox(env, owner.mailboxId);
    if (!mailbox) {
      return notFoundJson();
    }
    const attempts = await listOutboundAttempts(env, mailbox.id);
    return json({
      ok: true,
      mailbox: publicMailbox(mailbox),
      attempts: attempts.map(publicAttempt),
    });
  }

  if (path === "/api/mailboxes") {
    if (method !== "GET") {
      return methodNotAllowed("GET, POST");
    }
    const mailbox = await getMailbox(env, owner.mailboxId);
    if (!mailbox) {
      return notFoundJson();
    }
    const unreadCount = await countUnreadInbox(env, mailbox.id);
    return json({ ok: true, mailboxes: [publicMailbox(mailbox)], unread_count: unreadCount });
  }

  if (path === "/api/search") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    const mailbox = await getMailbox(env, owner.mailboxId);
    if (!mailbox) {
      return notFoundJson();
    }
    return searchMessages(env, mailbox, url);
  }

  if (path === "/api/folders") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return json({ ok: true, folders: publicFolderList() });
  }

  if (path === "/api/threads") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    const mailbox = await getMailbox(env, owner.mailboxId);
    if (!mailbox) {
      return notFoundJson();
    }
    return listThreads(env, mailbox, url);
  }

  const oneThread = path.match(/^\/api\/threads\/([^/]+)$/);
  if (oneThread) {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    const mailbox = await getMailbox(env, owner.mailboxId);
    if (!mailbox) {
      return notFoundJson();
    }
    return readThread(env, mailbox, decodeURIComponent(oneThread[1]), url);
  }

  if (path === "/api/drafts") {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return upsertDraft(request, env, owner, null);
  }

  const oneDraft = path.match(/^\/api\/drafts\/([^/]+)$/);
  if (oneDraft) {
    const draftId = decodeURIComponent(oneDraft[1]);
    if (method === "GET") {
      return readDraft(env, owner, draftId);
    }
    if (method === "POST") {
      return upsertDraft(request, env, owner, draftId);
    }
    return methodNotAllowed("GET, POST");
  }

  const mailboxMessages = path.match(/^\/api\/mailboxes\/([^/]+)\/messages$/);
  if (mailboxMessages) {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    const mailbox = await getMailbox(env, decodeURIComponent(mailboxMessages[1]));
    if (!mailbox) {
      return notFoundJson();
    }
    if (!sameMailbox(owner, mailbox)) {
      return forbiddenJson();
    }
    const folder = parseFolder(url.searchParams.get("folder"));
    if (folder !== "inbox") {
      const messages = await listFolderMessages(env, mailbox.id, folder);
      return json({
        ok: true,
        mailbox: publicMailbox(mailbox),
        folder,
        messages: messages.map(publicMessageListItem),
      });
    }
    return searchMessages(env, mailbox, url);
  }

  const starMessage = path.match(/^\/api\/messages\/([^/]+)\/star$/);
  if (starMessage) {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return setMessageStar(request, env, owner, decodeURIComponent(starMessage[1]));
  }

  const readFlag = path.match(/^\/api\/messages\/([^/]+)\/read$/);
  if (readFlag) {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return setMessageRead(request, env, owner, decodeURIComponent(readFlag[1]));
  }

  const composeMatch = path.match(/^\/api\/messages\/([^/]+)\/compose$/);
  if (composeMatch) {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return composePrefill(env, owner, decodeURIComponent(composeMatch[1]), url);
  }

  const moveMatch = path.match(/^\/api\/messages\/([^/]+)\/move$/);
  if (moveMatch) {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return moveOwnedMessage(request, env, owner, decodeURIComponent(moveMatch[1]));
  }

  const oneMessage = path.match(/^\/api\/messages\/([^/]+)$/);
  if (oneMessage) {
    const messageId = decodeURIComponent(oneMessage[1]);
    if (method === "GET") {
      return readMessage(env, owner, messageId);
    }
    if (method === "DELETE") {
      return deleteMessage(env, owner, messageId);
    }
    return methodNotAllowed("GET, DELETE");
  }

  return notFoundJson();
}

async function inboxThreads(env: Env, mailbox: MailboxRecord, url: URL): Promise<MessageThread[]> {
  const q = parseSearchQuery(url.searchParams.get("q"));
  const filter = parseInboxFilter(url.searchParams.get("filter"));
  const messages = await listInboxMessages(env, mailbox.id, { q, filter });
  return groupMessagesIntoThreads(messages);
}

async function listThreads(env: Env, mailbox: MailboxRecord, url: URL): Promise<Response> {
  const q = parseSearchQuery(url.searchParams.get("q"));
  const filter = parseInboxFilter(url.searchParams.get("filter"));
  const threads = await inboxThreads(env, mailbox, url);
  const unreadCount = await countUnreadInbox(env, mailbox.id);
  return json({
    ok: true,
    mailbox: publicMailbox(mailbox),
    folder: "inbox",
    q,
    filter,
    unread_count: unreadCount,
    threads: threads.map(publicThreadListItem),
  });
}

async function readThread(
  env: Env,
  mailbox: MailboxRecord,
  threadId: string,
  _url: URL,
): Promise<Response> {
  const messages = await listInboxMessages(env, mailbox.id, {});
  const thread = findThreadById(groupMessagesIntoThreads(messages), threadId);
  if (!thread) {
    return notFoundJson();
  }
  return json({
    ok: true,
    mailbox: publicMailbox(mailbox),
    thread: publicThreadDetail(thread),
  });
}

async function searchMessages(env: Env, mailbox: MailboxRecord, url: URL): Promise<Response> {
  const q = parseSearchQuery(url.searchParams.get("q"));
  const filter = parseInboxFilter(url.searchParams.get("filter"));
  const messages = await listInboxMessages(env, mailbox.id, { q, filter });
  const unreadCount = await countUnreadInbox(env, mailbox.id);
  return json({
    ok: true,
    mailbox: publicMailbox(mailbox),
    folder: "inbox",
    q,
    filter,
    engine: SEARCH_ENGINE,
    unread_count: unreadCount,
    messages: messages.map(publicMessageListItem),
  });
}

async function sendMessage(
  request: Request,
  env: Env,
  owner: OwnerPrincipal,
): Promise<Response> {
  const mailbox = await getMailbox(env, owner.mailboxId);
  if (!mailbox) {
    return notFoundJson();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: "Send JSON { \"to\", \"subject\", \"text\" } (optional cc, in_reply_to, references).",
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: "Send JSON { \"to\", \"subject\", \"text\" } (optional cc, in_reply_to, references).",
      },
      400,
    );
  }

  const parsed = parseSendFields(body as Record<string, unknown>);
  if (!parsed.ok) {
    return json({ ok: false, error: parsed.error, hint: parsed.hint }, 400);
  }

  const draftId = optionalId((body as Record<string, unknown>).draft_id);
  const outcome = await sendOutbound(env, mailbox, parsed.input, { draftId });
  return json(
    {
      ok: outcome.attempt.status === "sent",
      attempt: publicAttempt(outcome.attempt),
      sent: outcome.sent ? publicMessageDetail(outcome.sent) : null,
      error: outcome.attempt.error,
      hint: outcome.attempt.hint,
    },
    outcome.httpStatus,
  );
}

function publicAttempt(row: OutboundAttemptRecord) {
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
    created_at: row.created_at,
  };
}

async function readMessage(
  env: Env,
  owner: OwnerPrincipal,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.mailbox_id !== owner.mailboxId) {
    return forbiddenJson();
  }
  if (existing.folder === "inbox" && existing.is_read !== 1) {
    await markRead(env, existing.mailbox_id, existing.id);
  }
  const message =
    existing.folder === "inbox"
      ? await getInboxMessage(env, existing.mailbox_id, existing.id)
      : await getMailboxMessage(env, existing.mailbox_id, existing.id);
  if (!message) {
    return notFoundJson();
  }
  return json({ ok: true, message: publicMessageDetail(message) });
}

async function readDraft(
  env: Env,
  owner: OwnerPrincipal,
  draftId: string,
): Promise<Response> {
  const existing = await getMailboxMessage(env, owner.mailboxId, draftId);
  if (!existing || existing.folder !== "draft") {
    return notFoundJson();
  }
  return json({ ok: true, draft: publicDraft(existing) });
}

async function upsertDraft(
  request: Request,
  env: Env,
  owner: OwnerPrincipal,
  draftId: string | null,
): Promise<Response> {
  const mailbox = await getMailbox(env, owner.mailboxId);
  if (!mailbox) {
    return notFoundJson();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "to", "subject", "text" } (all optional for drafts).',
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "to", "subject", "text" } (all optional for drafts).',
      },
      400,
    );
  }

  const record = body as Record<string, unknown>;
  const parsed = parseDraftFields(record);
  if (!parsed.ok) {
    return json({ ok: false, error: parsed.error, hint: parsed.hint }, 400);
  }

  const id = draftId ?? optionalId(record.id);
  const saved = id
    ? await updateDraft(env, mailbox, id, parsed.fields)
    : await insertDraft(env, mailbox, parsed.fields);
  if (!saved) {
    return notFoundJson();
  }
  return json({ ok: true, draft: publicDraft(saved) }, id ? 200 : 201);
}

async function moveOwnedMessage(
  request: Request,
  env: Env,
  owner: OwnerPrincipal,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.mailbox_id !== owner.mailboxId) {
    return forbiddenJson();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "folder": "inbox"|"sent"|"draft"|"trash"|"spam" }.',
      },
      400,
    );
  }
  const folderRaw =
    body && typeof body === "object" ? (body as Record<string, unknown>).folder : null;
  if (typeof folderRaw !== "string" || !isSystemFolder(folderRaw)) {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "folder": "inbox"|"sent"|"draft"|"trash"|"spam" }.',
      },
      400,
    );
  }
  const moved = await moveMessage(env, existing.mailbox_id, existing.id, folderRaw);
  if (!moved) {
    return notFoundJson();
  }
  const message = await getMailboxMessage(env, existing.mailbox_id, existing.id);
  if (!message) {
    return notFoundJson();
  }
  return json({ ok: true, message: publicMessageDetail(message) });
}

async function composePrefill(
  env: Env,
  owner: OwnerPrincipal,
  messageId: string,
  url: URL,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.mailbox_id !== owner.mailboxId) {
    return forbiddenJson();
  }
  const mailbox = await getMailbox(env, owner.mailboxId);
  if (!mailbox) {
    return notFoundJson();
  }
  const mode = parseComposeMode(url.searchParams.get("mode"));
  if (mode === "new") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: "mode must be reply, reply-all, or forward.",
      },
      400,
    );
  }
  const draft = buildComposePrefill(existing, mailbox.address, mode);
  return json({
    ok: true,
    mode,
    message_id: existing.id,
    draft: {
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      text: draft.body,
      in_reply_to: draft.inReplyTo || null,
      references: draft.references || null,
    },
  });
}

async function setMessageStar(
  request: Request,
  env: Env,
  owner: OwnerPrincipal,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.mailbox_id !== owner.mailboxId) {
    return forbiddenJson();
  }

  const parsed = await readBooleanField(request, "starred");
  if (!parsed.ok) {
    return parsed.response;
  }

  const updated = await setStarred(env, existing.mailbox_id, existing.id, parsed.value);
  if (!updated) {
    return notFoundJson();
  }
  const message = await getInboxMessage(env, existing.mailbox_id, existing.id);
  if (!message) {
    return notFoundJson();
  }
  return json({ ok: true, message: publicMessageDetail(message) });
}

async function setMessageRead(
  request: Request,
  env: Env,
  owner: OwnerPrincipal,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.mailbox_id !== owner.mailboxId) {
    return forbiddenJson();
  }

  const parsed = await readBooleanField(request, "read");
  if (!parsed.ok) {
    return parsed.response;
  }

  const updated = await setRead(env, existing.mailbox_id, existing.id, parsed.value);
  if (!updated) {
    return notFoundJson();
  }
  const message = await getInboxMessage(env, existing.mailbox_id, existing.id);
  if (!message) {
    return notFoundJson();
  }
  const unreadCount = await countUnreadInbox(env, existing.mailbox_id);
  return json({
    ok: true,
    message: publicMessageDetail(message),
    unread_count: unreadCount,
  });
}

async function readBooleanField(
  request: Request,
  field: "starred" | "read",
): Promise<{ ok: true; value: boolean } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "invalid_request",
          hint: `Send JSON { "${field}": true|false }.`,
        },
        400,
      ),
    };
  }
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "invalid_request",
          hint: `Send JSON { "${field}": true|false }.`,
        },
        400,
      ),
    };
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "boolean") {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "invalid_request",
          hint: `Send JSON { "${field}": true|false }.`,
        },
        400,
      ),
    };
  }
  return { ok: true, value };
}

async function deleteMessage(
  env: Env,
  owner: OwnerPrincipal,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.mailbox_id !== owner.mailboxId) {
    return forbiddenJson();
  }
  const moved = await trashMessage(env, existing.mailbox_id, existing.id);
  if (!moved) {
    return notFoundJson();
  }
  return json({ ok: true, id: existing.id, folder: "trash" });
}

async function createOwnedMailbox(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      { ok: false, error: "invalid_request", hint: 'Send JSON { "address" } (optional display_name).' },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      { ok: false, error: "invalid_request", hint: 'Send JSON { "address" } (optional display_name).' },
      400,
    );
  }
  const record = body as Record<string, unknown>;
  const address = typeof record.address === "string" ? record.address : "";
  const displayName = typeof record.display_name === "string" ? record.display_name : null;
  const created = await insertMailbox(env, { address, displayName });
  if (!created.ok) {
    return json(
      { ok: false, error: created.error, hint: created.hint },
      created.error === "address_taken" ? 409 : 400,
    );
  }
  return json({ ok: true, mailbox: publicMailbox(created.mailbox) }, 201);
}

function sameMailbox(owner: OwnerPrincipal, mailbox: MailboxRecord): boolean {
  return mailbox.id === owner.mailboxId || mailbox.address === owner.address;
}

function publicMailbox(row: MailboxRecord) {
  return {
    id: row.id,
    address: row.address,
    display_name: row.display_name,
    status: row.status,
  };
}

function publicMessageListItem(row: MessageRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    from: row.envelope_from,
    to: row.envelope_to,
    subject: row.subject,
    snippet: row.snippet,
    is_read: row.is_read === 1,
    is_starred: row.is_starred === 1,
    folder: row.folder,
    received_at: row.received_at,
  };
}

function publicDraft(row: MessageRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    folder: "draft" as const,
    to: row.envelope_to,
    cc: row.header_cc ?? "",
    subject: row.subject ?? "",
    text: row.body_text ?? "",
    in_reply_to: row.in_reply_to,
    references: row.references_header,
    updated_at: row.received_at,
  };
}

function optionalId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function publicMessageDetail(row: MessageRecord) {
  return {
    ...publicMessageListItem(row),
    rfc_message_id: row.rfc_message_id,
    body_text: row.body_text,
    header_to: row.header_to,
    header_cc: row.header_cc,
    header_reply_to: row.header_reply_to,
    in_reply_to: row.in_reply_to,
    references: row.references_header,
    folder: row.folder,
    size_bytes: row.size_bytes,
  };
}

function publicThreadListItem(thread: MessageThread) {
  const latest = latestThreadMessage(thread);
  return {
    id: thread.id,
    kind: thread.kind,
    mailbox_id: latest.mailbox_id,
    message_count: thread.messages.length,
    latest_message_id: latest.id,
    from: latest.envelope_from,
    to: latest.envelope_to,
    subject: latest.subject,
    snippet: latest.snippet,
    is_read: !threadHasUnread(thread),
    is_starred: threadHasStar(thread),
    folder: latest.folder,
    received_at: latest.received_at,
  };
}

function publicThreadDetail(thread: MessageThread) {
  const latest = latestThreadMessage(thread);
  return {
    ...publicThreadListItem(thread),
    subject: latest.subject,
    messages: thread.messages.map(publicMessageDetail),
  };
}
