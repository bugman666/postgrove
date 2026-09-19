import type { Env } from "./env.ts";
import { actorUserId, requireOwner, type MailboxActor } from "./auth.ts";
import { handleOwnerAliasRoutes, handleOwnerTokenRoutes } from "./rest.ts";
import {
  isSystemFolder,
  parseDraftFields,
  parseFolder,
  publicFolderList,
} from "./folders.ts";
import { forbiddenJson, json, methodNotAllowed, notFoundJson, quotaJson } from "./http.ts";
import { parseLocalePreference, resolveLocale, t, withLocaleCookie } from "./i18n.ts";
import { buildComposePrefill, parseComposeMode } from "./reply.ts";
import { checkAddressQuota } from "./quotas.ts";
import {
  parseIdempotencyKey,
  parseSendFields,
  publicOutboundAttempt,
  readIdempotencyKey,
  sendOutbound,
} from "./send.ts";
import {
  countUnreadInbox,
  createMailbox,
  ensureMailboxThreadIds,
  getInboxMessage,
  getMailbox,
  getMailboxMessage,
  getMessageById,
  insertDraft,
  listFolderMessages,
  listInboxMessages,
  listInboxMessagesByThreadId,
  listMailboxesForUser,
  searchInboxMessages,
  listOutboundAttempts,
  MailboxInputError,
  markRead,
  moveMessage,
  setRead,
  setStarred,
  trashMessage,
  updateDraft,
  type MailboxRecord,
  type MessageRecord,
} from "./store.ts";
import { bindUserMailbox, getUser, mailboxAllowed } from "./users.ts";
import {
  findThreadById,
  groupMessagesByStoredThreadId,
  latestThreadMessage,
  threadFromStoredId,
  threadHasStar,
  threadHasUnread,
  type MessageThread,
} from "./threads.ts";
import { parseInboxFilter, parseSearchQuery } from "./triage.ts";
import {
  HookInputError,
  getHookConfig,
  listDeliveries,
  parseHookConfigBody,
  publicDelivery,
  publicHookConfig,
  saveHookConfig,
} from "./webhooks.ts";

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

  const aliases = await handleOwnerAliasRoutes(request, env, url, owner);
  if (aliases) {
    return aliases;
  }

  if (path === "/api/locale") {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return setOwnerLocale(request);
  }

  if (path === "/api/addresses") {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return createOwnedAddress(request, env, owner);
  }

  if (path === "/api/mailboxes" && method === "POST") {
    return createOwnedAddress(request, env, owner);
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
      attempts: attempts.map(publicOutboundAttempt),
    });
  }

  if (path === "/api/hooks") {
    if (method === "GET") {
      return getOwnerHooks(env, owner);
    }
    if (method === "POST") {
      return saveOwnerHooks(request, env, owner);
    }
    return methodNotAllowed("GET, POST");
  }

  if (path === "/api/hooks/attempts") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return listOwnerDeliveries(env, owner, url);
  }

  if (path === "/api/mailboxes") {
    if (method !== "GET") {
      return methodNotAllowed("GET, POST");
    }
    const boxes = await visibleMailboxes(env, owner);
    const unreadCount = boxes[0] ? await countUnreadInbox(env, boxes[0].id) : 0;
    return json({
      ok: true,
      mailboxes: boxes.map(publicMailbox),
      unread_count: unreadCount,
    });
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
    if (!mailboxAllowed(owner, mailbox)) {
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
  await ensureMailboxThreadIds(env, mailbox.id);
  const messages = await listInboxMessages(env, mailbox.id, { q, filter });
  return groupMessagesByStoredThreadId(messages);
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
  await ensureMailboxThreadIds(env, mailbox.id);
  const members = await listInboxMessagesByThreadId(env, mailbox.id, threadId);
  const thread = members.length > 0
    ? threadFromStoredId(threadId, members)
    : findThreadById(await inboxThreads(env, mailbox, _url), threadId);
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
  const { messages, engine } = await searchInboxMessages(env, mailbox.id, { q, filter });
  const unreadCount = await countUnreadInbox(env, mailbox.id);
  return json({
    ok: true,
    mailbox: publicMailbox(mailbox),
    folder: "inbox",
    q,
    filter,
    engine,
    unread_count: unreadCount,
    messages: messages.map(publicMessageListItem),
  });
}

async function sendMessage(
  request: Request,
  env: Env,
  owner: MailboxActor,
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

  const record = body as Record<string, unknown>;
  const draftId = optionalId(record.draft_id);
  const idempotency = parseIdempotencyKey(readIdempotencyKey(request, record));
  if (!idempotency.ok) {
    return json({ ok: false, error: idempotency.error, hint: idempotency.hint }, 400);
  }
  const outcome = await sendOutbound(env, mailbox, parsed.input, {
    draftId,
    userId: actorUserId(owner),
    idempotencyKey: idempotency.key,
  });
  return json(
    {
      ok: outcome.attempt.status === "sent",
      attempt: publicOutboundAttempt(outcome.attempt),
      sent: outcome.sent ? publicMessageDetail(outcome.sent) : null,
      error: outcome.attempt.error,
      hint: outcome.attempt.hint,
    },
    outcome.httpStatus,
  );
}

async function readMessage(
  env: Env,
  owner: MailboxActor,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (!ownsMessage(owner, existing)) {
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
  owner: MailboxActor,
  draftId: string,
): Promise<Response> {
  const existing = await getMessageById(env, draftId);
  if (!existing || existing.folder !== "draft") {
    return notFoundJson();
  }
  if (!ownsMessage(owner, existing)) {
    return forbiddenJson();
  }
  return json({ ok: true, draft: publicDraft(existing) });
}

async function upsertDraft(
  request: Request,
  env: Env,
  owner: MailboxActor,
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
  owner: MailboxActor,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (!ownsMessage(owner, existing)) {
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
  owner: MailboxActor,
  messageId: string,
  url: URL,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (!ownsMessage(owner, existing)) {
    return forbiddenJson();
  }
  const mailbox = await getMailbox(env, existing.mailbox_id);
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
  owner: MailboxActor,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (!ownsMessage(owner, existing)) {
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
  owner: MailboxActor,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (!ownsMessage(owner, existing)) {
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
  owner: MailboxActor,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (!ownsMessage(owner, existing)) {
    return forbiddenJson();
  }
  const moved = await trashMessage(env, existing.mailbox_id, existing.id);
  if (!moved) {
    return notFoundJson();
  }
  return json({ ok: true, id: existing.id, folder: "trash" });
}

function ownsMessage(owner: MailboxActor, message: MessageRecord): boolean {
  if (owner.kind === "owner") {
    return message.mailbox_id === owner.mailboxId;
  }
  return owner.mailboxIds.includes(message.mailbox_id);
}

async function visibleMailboxes(env: Env, owner: MailboxActor): Promise<MailboxRecord[]> {
  if (owner.kind === "mailbox") {
    return listMailboxesForUser(env, owner.userId);
  }
  const mailbox = await getMailbox(env, owner.mailboxId);
  return mailbox ? [mailbox] : [];
}

async function setOwnerLocale(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      { ok: false, error: "invalid_request", hint: 'Send JSON { "locale": "zh"|"en"|"auto" }.' },
      400,
    );
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const preference = parseLocalePreference(record.locale);
  const locale = preference === "auto" ? resolveLocale(request) : preference;
  const hint = t(locale, "banner.lang-updated");
  return withLocaleCookie(json({ ok: true, locale: preference === "auto" ? "auto" : locale, hint }), request, preference);
}

async function createOwnedAddress(
  request: Request,
  env: Env,
  owner: MailboxActor,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "address" } (optional display_name).',
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "address" } (optional display_name).',
      },
      400,
    );
  }
  const record = body as Record<string, unknown>;
  const address = typeof record.address === "string" ? record.address : "";
  const displayName = typeof record.display_name === "string" ? record.display_name : null;

  const userId = actorUserId(owner);
  if (userId) {
    const user = await getUser(env, userId);
    if (!user) {
      return notFoundJson();
    }
    const quota = await checkAddressQuota(env, user, resolveLocale(request));
    if (quota) {
      return quotaJson(quota.error, quota.hint, { used: quota.used, limit: quota.limit });
    }
  }

  try {
    const mailbox = await createMailbox(env, { address, displayName });
    if (userId) {
      await bindUserMailbox(env, userId, mailbox.id);
    }
    return json({ ok: true, mailbox: publicMailbox(mailbox) }, 201);
  } catch (error) {
    if (error instanceof MailboxInputError) {
      return json(
        { ok: false, error: error.error, hint: error.message },
        error.error === "address_taken" ? 409 : 400,
      );
    }
    throw error;
  }
}

async function getOwnerHooks(env: Env, owner: MailboxActor): Promise<Response> {
  const mailbox = await getMailbox(env, owner.mailboxId);
  if (!mailbox) {
    return notFoundJson();
  }
  try {
    const row = await getHookConfig(env, mailbox.id);
    return json({
      ok: true,
      mailbox: publicMailbox(mailbox),
      hook: row
        ? publicHookConfig(row)
        : publicHookConfig({
            mailbox_id: mailbox.id,
            webhook_enabled: 0,
            webhook_url: null,
            webhook_secret: null,
            forward_enabled: 0,
            forward_url: null,
            forward_email: null,
            updated_at: 0,
          }),
    });
  } catch (error) {
    return hookMigrateHint(error);
  }
}

async function saveOwnerHooks(request: Request, env: Env, owner: MailboxActor): Promise<Response> {
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
        hint: 'Send JSON { "webhook_url", "webhook_secret" } and/or forward_url / forward_email.',
      },
      400,
    );
  }
  try {
    const input = parseHookConfigBody(body);
    const saved = await saveHookConfig(env, mailbox.id, input);
    return json({
      ok: true,
      mailbox: publicMailbox(mailbox),
      hook: publicHookConfig(saved.row, saved.secretOnce ?? undefined),
    });
  } catch (error) {
    if (error instanceof HookInputError) {
      return json({ ok: false, error: error.error, hint: error.message }, 400);
    }
    return hookMigrateHint(error);
  }
}

async function listOwnerDeliveries(env: Env, owner: MailboxActor, url: URL): Promise<Response> {
  const mailbox = await getMailbox(env, owner.mailboxId);
  if (!mailbox) {
    return notFoundJson();
  }
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  try {
    const deliveries = await listDeliveries(env, mailbox.id, limit);
    return json({
      ok: true,
      mailbox: publicMailbox(mailbox),
      deliveries: deliveries.map(publicDelivery),
    });
  } catch (error) {
    return hookMigrateHint(error);
  }
}

function hookMigrateHint(error: unknown): Response {
  const detail = error instanceof Error ? error.message : "unknown";
  return json(
    {
      ok: false,
      error: "migrations_pending",
      hint: "Apply D1 migrations (npm run db:migrate:local), then retry.",
      detail,
    },
    503,
  );
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
    thread_id: row.thread_id ?? null,
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
