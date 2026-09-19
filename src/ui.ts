import type { Env } from "./env";
import {
  listMessageAttachments,
  renderAttachmentsHtml,
  type AttachmentRecord,
} from "./attachments";
import { actorUserId, requireOwner, type MailboxActor } from "./auth";
import {
  FOLDER_EMPTY,
  FOLDER_LABELS,
  SYSTEM_FOLDERS,
  folderNavLinks,
  parseDraftFields,
  parseFolder,
  type SystemFolder,
} from "./folders";
import { html, redirect } from "./http";
import { EMPTY_ART, GROVE_MARK, escapeHtml, formatReceived } from "./html";
import { describeOutbound } from "./outbound";
import {
  buildComposePrefill,
  composeHeading,
  parseComposeMode,
  type ComposeMode,
  type ComposePrefill,
} from "./reply";
import { parseSendFields, sendOutbound } from "./send";
import {
  countUnreadInbox,
  createMailbox,
  getInboxMessage,
  getMailbox,
  getMailboxMessage,
  getOutboundAttempt,
  insertDraft,
  listFolderMessages,
  listInboxMessages,
  listMailboxesForUser,
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
  type OutboundAttemptRecord,
} from "./store";
import { checkAddressQuota } from "./quotas.ts";
import { bindUserMailbox, getUser, mailboxAllowed } from "./users.ts";
import {
  findThreadById,
  findThreadForMessage,
  groupMessagesIntoThreads,
  latestThreadMessage,
  threadHasUnread,
  type MessageThread,
} from "./threads";
import { parseInboxFilter, parseSearchQuery, type InboxFilter } from "./triage";

type NavId = SystemFolder | "unread" | "compose" | "addresses" | "settings" | "admin";

interface ComposeForm {
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyTo: string;
  references: string;
  draftId: string;
}

export async function handleUi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const gate = await requireOwner(request, env);
  if (!gate.ok) {
    return unauthorizedPage(gate.response);
  }

  const owner: MailboxActor = gate.principal;
  const path = url.pathname;
  const method = request.method;
  const ownMailbox = await getMailbox(env, owner.mailboxId);
  let unreadCount = ownMailbox ? await countUnreadInbox(env, ownMailbox.id) : 0;

  if (path === "/") {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    if (!ownMailbox) {
      return html(renderAddressesPage([], "inbox", unreadCount), 200);
    }
    return redirect(boxPath(ownMailbox.id));
  }

  if (path === "/compose") {
    if (method === "POST") {
      return handleComposeSubmit(request, env, url, owner, ownMailbox, unreadCount);
    }
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    return renderCompose(env, url, ownMailbox, unreadCount);
  }

  if (path === "/addresses") {
    if (method === "POST") {
      return handleAddressCreate(request, env, owner, unreadCount);
    }
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const boxes = await visibleUiMailboxes(env, owner, ownMailbox);
    return html(renderAddressesPage(boxes, "addresses", unreadCount, url.searchParams.get("error")));
  }

  if (path === "/settings") {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    return html(renderStubPage("settings", "设置", ownMailbox, [
      owner.kind === "mailbox"
        ? `你是成员 ${owner.userId}（${owner.role === "admin" ? "值守" : "信箱"}）。会话可打开已绑定的地址。`
        : "这是主人会话（OWNER_TOKEN）。只绑在你登录的那一个地址上。",
      "登出后需要再次 POST /auth/login。成员口令由值守发放，不是 OWNER_TOKEN。",
      "还没收到信？确认 Email Routing 已指向本 Worker。",
      describeOutbound(env).hint,
      "入站附件存在 R2。单文件上限见 ATTACHMENT_MAX_BYTES（默认 10 MB）。成员还有地址 / 存储 / 日发送配额；超了会明确报错。",
      "值守台在 /admin：ADMIN_TOKEN 或 admin 角色。普通成员进不去。",
    ], true, unreadCount));
  }

  const moveMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)\/move$/);
  if (moveMatch) {
    if (method !== "POST") {
      return pageMethodNotAllowed();
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(moveMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox, unreadCount);
    }
    const messageId = decodeURIComponent(moveMatch[2]);
    const data = await request.formData();
    const target = parseFolder(stringField(data.get("folder")));
    await moveMessage(env, mailbox.id, messageId, target);
    return redirect(`${boxPath(mailbox.id, target)}?moved=1`);
  }

  const deleteMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)\/delete$/);
  if (deleteMatch) {
    if (method !== "POST") {
      return pageMethodNotAllowed();
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(deleteMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox, unreadCount);
    }
    const messageId = decodeURIComponent(deleteMatch[2]);
    await trashMessage(env, mailbox.id, messageId);
    return redirect(`${boxPath(mailbox.id, "trash")}?deleted=1`);
  }

  const starMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)\/star$/);
  if (starMatch) {
    if (method !== "POST") {
      return pageMethodNotAllowed();
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(starMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox, unreadCount);
    }
    const messageId = decodeURIComponent(starMatch[2]);
    const data = await request.formData();
    const starred = stringField(data.get("starred")) !== "0";
    await setStarred(env, mailbox.id, messageId, starred);
    return redirect(safeNext(stringField(data.get("next")), `${messagePath(mailbox.id, messageId)}${inboxQuery(url)}`));
  }

  const flagMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)\/read$/);
  if (flagMatch) {
    if (method !== "POST") {
      return pageMethodNotAllowed();
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(flagMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox, unreadCount);
    }
    const messageId = decodeURIComponent(flagMatch[2]);
    const data = await request.formData();
    const isRead = stringField(data.get("read")) !== "0";
    await setRead(env, mailbox.id, messageId, isRead);
    if (!isRead) {
      return redirect(`${boxPath(mailbox.id)}${inboxQuery(url, { unread: "1" })}`);
    }
    return redirect(safeNext(stringField(data.get("next")), `${messagePath(mailbox.id, messageId)}${inboxQuery(url)}`));
  }

  const threadMatch = path.match(/^\/box\/([^/]+)\/t\/([^/]+)$/);
  if (threadMatch) {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(threadMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox, unreadCount);
    }
    const threadId = decodeURIComponent(threadMatch[2]);
    const view = readInboxView(url);
    const listed = await listInboxMessages(env, mailbox.id, view);
    const visible = findThreadById(groupMessagesIntoThreads(listed), threadId);
    if (!visible) {
      return html(renderNotFound(mailbox, unreadCount), 404);
    }
    const allInbox = await listInboxMessages(env, mailbox.id, {});
    const thread = findThreadById(groupMessagesIntoThreads(allInbox), threadId) ?? visible;
    for (const member of thread.messages) {
      if (member.folder === "inbox" && member.is_read !== 1) {
        await markRead(env, mailbox.id, member.id);
      }
    }
    unreadCount = await countUnreadInbox(env, mailbox.id);
    const refreshed = await listInboxMessages(env, mailbox.id, view);
    const openedAll = await listInboxMessages(env, mailbox.id, {});
    const opened = findThreadById(groupMessagesIntoThreads(openedAll), threadId) ?? thread;
    const attachments = await collectThreadAttachments(env, mailbox.id, opened);
    return html(renderInboxPage(mailbox, refreshed, latestThreadMessage(opened), {
      attachments,
      thread: opened,
      unreadCount,
      ...view,
    }));
  }

  const readMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)$/);
  if (readMatch) {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(readMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox, unreadCount);
    }
    const messageId = decodeURIComponent(readMatch[2]);
    const existing = await getMailboxMessage(env, mailbox.id, messageId);
    if (!existing) {
      return html(renderNotFound(mailbox, unreadCount), 404);
    }
    if (existing.folder === "draft") {
      return redirect(composeHref(mailbox, "new", undefined, existing.id));
    }
    if (existing.folder === "inbox" && existing.is_read !== 1) {
      await markRead(env, mailbox.id, existing.id);
    }
    const message =
      existing.folder === "inbox"
        ? ((await getInboxMessage(env, mailbox.id, existing.id)) ?? existing)
        : existing;
    unreadCount = await countUnreadInbox(env, mailbox.id);
    const folder = parseFolder(existing.folder);
    const view = readInboxView(url);
    const messages =
      folder === "inbox"
        ? await listInboxMessages(env, mailbox.id, view)
        : await listFolderMessages(env, mailbox.id, folder);
    const openedThread =
      folder === "inbox"
        ? findThreadForMessage(
            groupMessagesIntoThreads(await listInboxMessages(env, mailbox.id, {})),
            message.id,
          )
        : null;
    const attachments = openedThread
      ? await collectThreadAttachments(env, mailbox.id, openedThread)
      : await listMessageAttachments(env, mailbox.id, message.id);
    if (url.searchParams.get("reply") === "1") {
      return redirect(composeHref(mailbox, "reply", message.id));
    }
    if (folder === "inbox") {
      return html(renderInboxPage(mailbox, messages, message, {
        attachments,
        thread: openedThread,
        unreadCount,
        ...view,
      }));
    }
    return html(renderFolderPage(mailbox, folder, messages, message, {
      attachments,
      unreadCount,
    }));
  }

  const boxMatch = path.match(/^\/box\/([^/]+)$/);
  if (boxMatch) {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(boxMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox, unreadCount);
    }
    const folder = parseFolder(url.searchParams.get("folder"));
    const view = readInboxView(url);
    if (folder === "inbox") {
      const messages = await listInboxMessages(env, mailbox.id, view);
      return html(
        renderInboxPage(mailbox, messages, null, {
          deleted: url.searchParams.get("deleted") === "1",
          markedUnread: url.searchParams.get("unread") === "1",
          unreadCount,
          ...view,
        }),
      );
    }
    const messages = await listFolderMessages(env, mailbox.id, folder);
    const sentId = url.searchParams.get("sent");
    const selectedSent =
      folder === "sent" && sentId
        ? messages.find((row) => row.id === sentId) ?? null
        : null;
    return html(
      renderFolderPage(mailbox, folder, messages, selectedSent, {
        deleted: url.searchParams.get("deleted") === "1",
        moved: url.searchParams.get("moved") === "1",
        justSent: Boolean(sentId),
        unreadCount,
      }),
    );
  }

  return html(renderNotFound(undefined, unreadCount), 404);
}

async function allowedMailbox(
  env: Env,
  owner: MailboxActor,
  idOrAddress: string,
): Promise<MailboxRecord | null> {
  const mailbox = await getMailbox(env, idOrAddress);
  if (!mailbox) {
    return null;
  }
  if (!mailboxAllowed(owner, mailbox)) {
    return null;
  }
  return mailbox;
}

async function visibleUiMailboxes(
  env: Env,
  owner: MailboxActor,
  ownMailbox: MailboxRecord | null,
): Promise<MailboxRecord[]> {
  if (owner.kind === "mailbox") {
    return listMailboxesForUser(env, owner.userId);
  }
  return ownMailbox ? [ownMailbox] : [];
}

async function handleAddressCreate(
  request: Request,
  env: Env,
  owner: MailboxActor,
  unreadCount: number,
): Promise<Response> {
  const boxes = await visibleUiMailboxes(env, owner, await getMailbox(env, owner.mailboxId));
  const data = await request.formData();
  const address = stringField(data.get("address"));
  const displayName = stringField(data.get("display_name"));
  const userId = actorUserId(owner);
  if (userId) {
    const user = await getUser(env, userId);
    if (user) {
      const quota = await checkAddressQuota(env, user);
      if (quota) {
        return html(renderAddressesPage(boxes, "addresses", unreadCount, quota.hint), 409);
      }
    }
  }
  try {
    const mailbox = await createMailbox(env, { address, displayName: displayName || null });
    if (userId) {
      await bindUserMailbox(env, userId, mailbox.id);
    }
    return redirect(`/addresses?created=1`);
  } catch (error) {
    const hint = error instanceof MailboxInputError ? error.message : "没能开这个地址。";
    return html(renderAddressesPage(boxes, "addresses", unreadCount, hint), 400);
  }
}

async function unauthorizedPage(authResponse: Response): Promise<Response> {
  let hint = "POST /auth/login with address and token, then send the session cookie.";
  let error = "unauthorized";
  try {
    const body = (await authResponse.clone().json()) as {
      hint?: string;
      error?: string;
    };
    if (typeof body.hint === "string" && body.hint) {
      hint = body.hint;
    }
    if (typeof body.error === "string" && body.error) {
      error = body.error;
    }
  } catch {
    // Keep the auth-module default hint.
  }
  return html(renderLoginPage(error, hint), authResponse.status);
}

function forbiddenOrMissing(ownMailbox: MailboxRecord | null, unreadCount = 0): Response {
  return html(renderForbidden(ownMailbox, unreadCount), ownMailbox ? 403 : 404);
}

async function handleComposeSubmit(
  request: Request,
  env: Env,
  url: URL,
  owner: MailboxActor,
  ownMailbox: MailboxRecord | null,
  unreadCount: number,
): Promise<Response> {
  if (!ownMailbox) {
    return html(
      renderComposePage(env, ownMailbox, {
        form: emptyComposeForm(),
        formError: "没有可用地址。先确认本地已经 migrate 并且 seed，再 POST /auth/login。",
        attempts: [],
        unreadCount,
      }),
      404,
    );
  }
  if (!mailboxAllowed(owner, ownMailbox)) {
    return forbiddenOrMissing(ownMailbox, unreadCount);
  }

  let form: ComposeForm;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      form = emptyComposeForm();
      return html(
        renderComposePage(env, ownMailbox, {
          form,
          formError: "Send JSON { \"to\", \"subject\", \"text\" } or a form post.",
          attempts: await listOutboundAttempts(env, ownMailbox.id),
          unreadCount,
        }),
        400,
      );
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    form = {
      to: typeof record.to === "string" ? record.to : "",
      cc: typeof record.cc === "string" ? record.cc : "",
      subject: typeof record.subject === "string" ? record.subject : "",
      body: typeof record.text === "string" ? record.text : typeof record.body === "string" ? record.body : "",
      inReplyTo:
        typeof record.in_reply_to === "string"
          ? record.in_reply_to
          : typeof record.inReplyTo === "string"
            ? record.inReplyTo
            : "",
      references: typeof record.references === "string" ? record.references : "",
      draftId: typeof record.draft_id === "string" ? record.draft_id : typeof record.draftId === "string" ? record.draftId : "",
    };
    if (record.intent === "save" || record.save === true) {
      return saveComposeDraft(env, url, ownMailbox, form, unreadCount);
    }
  } else {
    const data = await request.formData();
    form = {
      to: stringField(data.get("to")),
      cc: stringField(data.get("cc")),
      subject: stringField(data.get("subject")),
      body: stringField(data.get("body")),
      inReplyTo: stringField(data.get("in_reply_to")),
      references: stringField(data.get("references")),
      draftId: stringField(data.get("draft_id")),
    };
    if (stringField(data.get("intent")) === "save") {
      return saveComposeDraft(env, url, ownMailbox, form, unreadCount);
    }
  }

  const parsed = parseSendFields({
    to: form.to,
    cc: form.cc,
    subject: form.subject,
    text: form.body,
    in_reply_to: form.inReplyTo,
    references: form.references,
  });
  if (!parsed.ok) {
    return html(
      renderComposePage(env, ownMailbox, {
        form,
        formError: parsed.hint,
        attempts: await listOutboundAttempts(env, ownMailbox.id),
        unreadCount,
      }),
      400,
    );
  }

  const outcome = await sendOutbound(env, ownMailbox, parsed.input, {
    draftId: form.draftId || null,
    userId: actorUserId(owner),
  });
  if (outcome.sent) {
    const next = new URL(boxPath(ownMailbox.id, "sent"), url.origin);
    next.searchParams.set("sent", outcome.sent.id);
    return redirect(`${next.pathname}${next.search}`);
  }
  const next = new URL(withMailbox("/compose", ownMailbox), url.origin);
  next.searchParams.set("attempt", outcome.attempt.id);
  if (form.draftId) {
    next.searchParams.set("draft", form.draftId);
  }
  return redirect(`${next.pathname}${next.search}`);
}

async function saveComposeDraft(
  env: Env,
  url: URL,
  mailbox: MailboxRecord,
  form: ComposeForm,
  unreadCount: number,
): Promise<Response> {
  const parsed = parseDraftFields({
    to: form.to,
    cc: form.cc,
    subject: form.subject,
    text: form.body,
    in_reply_to: form.inReplyTo,
    references: form.references,
  });
  if (!parsed.ok) {
    return html(
      renderComposePage(env, mailbox, {
        form,
        formError: parsed.hint,
        attempts: await listOutboundAttempts(env, mailbox.id),
        unreadCount,
      }),
      400,
    );
  }
  const saved = form.draftId
    ? await updateDraft(env, mailbox, form.draftId, parsed.fields)
    : await insertDraft(env, mailbox, parsed.fields);
  if (!saved) {
    return html(
      renderComposePage(env, mailbox, {
        form,
        formError: "找不到这封草稿。回到草稿箱再试一次。",
        attempts: await listOutboundAttempts(env, mailbox.id),
        unreadCount,
      }),
      404,
    );
  }
  const next = new URL(composeHref(mailbox, "new", undefined, saved.id), url.origin);
  next.searchParams.set("saved", "1");
  return redirect(`${next.pathname}${next.search}`);
}

async function renderCompose(
  env: Env,
  url: URL,
  mailbox: MailboxRecord | null,
  unreadCount: number,
): Promise<Response> {
  const attempts = mailbox ? await listOutboundAttempts(env, mailbox.id) : [];
  const attemptId = url.searchParams.get("attempt");
  const highlighted =
    mailbox && attemptId ? await getOutboundAttempt(env, mailbox.id, attemptId) : null;
  const mode = parseComposeMode(url.searchParams.get("mode"));
  const messageId = url.searchParams.get("message");
  const draftId = url.searchParams.get("draft");
  let form = emptyComposeForm();
  let formError: string | undefined;
  let prefill: ComposePrefill | null = null;
  let savedDraft = false;

  if (mailbox && draftId) {
    const draft = await getMailboxMessage(env, mailbox.id, draftId);
    if (!draft || draft.folder !== "draft") {
      formError = "找不到这封草稿。回到草稿箱再试一次。";
    } else {
      form = formFromDraft(draft);
      savedDraft = url.searchParams.get("saved") === "1";
    }
  } else if (mailbox && messageId && mode !== "new") {
    const source = await getMailboxMessage(env, mailbox.id, messageId);
    if (!source) {
      formError = "找不到要回复或转发的原信。回到收件箱再试一次。";
    } else {
      prefill = buildComposePrefill(source, mailbox.address, mode);
      form = formFromPrefill(prefill);
    }
  }

  return html(
    renderComposePage(env, mailbox, {
      form,
      formError,
      highlighted,
      attempts,
      mode: prefill?.mode ?? (highlighted ? "new" : mode),
      unreadCount,
      savedDraft,
    }),
  );
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function emptyComposeForm(): ComposeForm {
  return { to: "", cc: "", subject: "", body: "", inReplyTo: "", references: "", draftId: "" };
}

function formFromPrefill(prefill: ComposePrefill): ComposeForm {
  return {
    to: prefill.to,
    cc: prefill.cc,
    subject: prefill.subject,
    body: prefill.body,
    inReplyTo: prefill.inReplyTo,
    references: prefill.references,
    draftId: "",
  };
}

function formFromDraft(row: MessageRecord): ComposeForm {
  return {
    to: row.envelope_to,
    cc: row.header_cc ?? "",
    subject: row.subject ?? "",
    body: row.body_text ?? "",
    inReplyTo: row.in_reply_to ?? "",
    references: row.references_header ?? "",
    draftId: row.id,
  };
}

function pageMethodNotAllowed(): Response {
  return html(renderNotFound(), 405);
}

function boxPath(mailboxId: string, folder: SystemFolder = "inbox"): string {
  const base = `/box/${encodeURIComponent(mailboxId)}`;
  return folder === "inbox" ? base : `${base}?folder=${encodeURIComponent(folder)}`;
}

function messagePath(
  mailboxId: string,
  messageId: string,
  folder: SystemFolder = "inbox",
): string {
  const path = `/box/${encodeURIComponent(mailboxId)}/m/${encodeURIComponent(messageId)}`;
  return folder === "inbox" ? path : `${path}?folder=${encodeURIComponent(folder)}`;
}

function inboxHref(mailbox: MailboxRecord | null): string {
  return mailbox ? boxPath(mailbox.id) : "/";
}

function folderHref(mailbox: MailboxRecord | null, folder: SystemFolder): string {
  return mailbox ? boxPath(mailbox.id, folder) : "/";
}

function withMailbox(path: string, mailbox: MailboxRecord | null): string {
  if (!mailbox) {
    return path;
  }
  return `${path}?mailbox=${encodeURIComponent(mailbox.id)}`;
}

function composeHref(
  mailbox: MailboxRecord | null,
  mode: ComposeMode = "new",
  messageId?: string,
  draftId?: string,
): string {
  const params = new URLSearchParams();
  if (mailbox) {
    params.set("mailbox", mailbox.id);
  }
  if (mode !== "new") {
    params.set("mode", mode);
  }
  if (messageId) {
    params.set("message", messageId);
  }
  if (draftId) {
    params.set("draft", draftId);
  }
  const query = params.toString();
  return query ? `/compose?${query}` : "/compose";
}

function readInboxView(url: URL): { q: string; filter: InboxFilter } {
  return {
    q: parseSearchQuery(url.searchParams.get("q")),
    filter: parseInboxFilter(url.searchParams.get("filter")),
  };
}

function inboxQuery(
  source: URL | { q?: string; filter?: InboxFilter },
  extra: Record<string, string> = {},
): string {
  const q = source instanceof URL ? parseSearchQuery(source.searchParams.get("q")) : (source.q ?? "");
  const filter =
    source instanceof URL ? parseInboxFilter(source.searchParams.get("filter")) : (source.filter ?? "all");
  const params = new URLSearchParams();
  if (q) {
    params.set("q", q);
  }
  if (filter !== "all") {
    params.set("filter", filter);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value) {
      params.set(key, value);
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function safeNext(raw: string, fallback: string): string {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("://")) {
    return fallback;
  }
  return raw;
}

function viewHref(mailbox: MailboxRecord, q: string, filter: InboxFilter): string {
  return `${boxPath(mailbox.id)}${inboxQuery({ q, filter })}`;
}

function messageHref(
  mailbox: MailboxRecord,
  messageId: string,
  q: string,
  filter: InboxFilter,
  extra: Record<string, string> = {},
): string {
  return `${messagePath(mailbox.id, messageId)}${inboxQuery({ q, filter }, extra)}`;
}

function threadPath(mailboxId: string, threadId: string): string {
  return `/box/${encodeURIComponent(mailboxId)}/t/${encodeURIComponent(threadId)}`;
}

function threadHref(
  mailbox: MailboxRecord,
  threadId: string,
  q: string,
  filter: InboxFilter,
): string {
  return `${threadPath(mailbox.id, threadId)}${inboxQuery({ q, filter })}`;
}

async function collectThreadAttachments(
  env: Env,
  mailboxId: string,
  thread: MessageThread,
): Promise<AttachmentRecord[]> {
  const collected: AttachmentRecord[] = [];
  for (const member of thread.messages) {
    const rows = await listMessageAttachments(env, mailboxId, member.id);
    collected.push(...rows);
  }
  return collected;
}

function attachmentsForMessage(
  attachments: AttachmentRecord[],
  messageId: string,
): AttachmentRecord[] {
  return attachments.filter((row) => row.message_id === messageId);
}

function renderInboxPage(
  mailbox: MailboxRecord,
  messages: MessageRecord[],
  selected: MessageRecord | null,
  flags: {
    deleted?: boolean;
    markedUnread?: boolean;
    attachments?: AttachmentRecord[];
    thread?: MessageThread | null;
    unreadCount: number;
    q: string;
    filter: InboxFilter;
  },
): string {
  const q = flags.q;
  const filter = flags.filter;
  const heading =
    filter === "unread" ? "未读" : filter === "starred" ? "星标" : q ? "搜索" : "收件箱";
  const threads = groupMessagesIntoThreads(messages);
  const selectedThread = flags.thread
    ?? (selected ? findThreadForMessage(threads, selected.id) : null);
  const emptyCopy = emptyInboxCopy(messages.length, q, filter);
  const list = messages.length === 0
    ? emptyBlock(emptyCopy)
    : `<ul class="msg-list">${threads.map((thread) => threadRow(mailbox, thread, selectedThread?.id, q, filter)).join("")}</ul>`;

  let reading: string;
  if (selected && selectedThread && selectedThread.messages.length > 1) {
    reading = renderThreadReading(
      mailbox,
      selectedThread,
      selected.id,
      flags.attachments ?? [],
      q,
      filter,
    );
  } else if (selected) {
    reading = renderReading(
      mailbox,
      selected,
      attachmentsForMessage(flags.attachments ?? [], selected.id),
      q,
      filter,
    );
  } else {
    const banners: string[] = [];
    if (flags.deleted) {
      banners.push(`<p class="banner">已移出收件箱。</p>`);
    }
    if (flags.markedUnread) {
      banners.push(`<p class="banner">已标为未读。</p>`);
    }
    reading = `${banners.join("")}<div class="read-inner"><p class="empty">从左侧选一封，或点「写信」。</p></div>`;
  }

  const chips = (["all", "unread", "starred"] as const)
    .map((id) => {
      const label = id === "all" ? "全部" : id === "unread" ? "未读" : "星标";
      const active = filter === id ? " active" : "";
      return `<a class="filter${active}" href="${escapeHtml(viewHref(mailbox, q, id))}">${label}</a>`;
    })
    .join("");

  return layout({
    title: selected?.subject ? `${selected.subject} · Postgrove` : `${heading} · Postgrove`,
    nav: filter === "unread" ? "unread" : "inbox",
    mailbox,
    mode: selected ? "read" : "list",
    simple: false,
    unreadCount: flags.unreadCount,
    body: `<section class="list">
      <div class="list-head">
        <h1>${escapeHtml(heading)}</h1>
        ${folderStrip(mailbox, "inbox")}
        <form class="search-form" method="get" action="${escapeHtml(boxPath(mailbox.id))}">
          <input class="search" type="search" name="q" value="${escapeHtml(q)}" placeholder="搜索发件人、主题或正文" maxlength="200">
          ${filter !== "all" ? `<input type="hidden" name="filter" value="${escapeHtml(filter)}">` : ""}
        </form>
        <div class="filters">${chips}</div>
      </div>
      ${list}
    </section>
    <main class="read">${reading}</main>`,
  });
}

function renderFolderPage(
  mailbox: MailboxRecord,
  folder: SystemFolder,
  messages: MessageRecord[],
  selected: MessageRecord | null,
  flags: {
    deleted?: boolean;
    moved?: boolean;
    justSent?: boolean;
    attachments?: AttachmentRecord[];
    unreadCount: number;
  },
): string {
  const label = FOLDER_LABELS[folder];
  const list = messages.length === 0
    ? emptyBlock(FOLDER_EMPTY[folder])
    : `<ul class="msg-list">${messages.map((row) => folderMessageRow(mailbox, folder, row, selected?.id)).join("")}</ul>`;

  let reading: string;
  if (selected) {
    const sentBanner = flags.justSent
      ? `<p class="banner success">发送成功。这封信现在在已发送。</p>`
      : "";
    reading = `${sentBanner}${renderReading(mailbox, selected, flags.attachments ?? [], "", "all", folder)}`;
  } else {
    const banners: string[] = [];
    if (flags.deleted) {
      banners.push(`<p class="banner">已移入垃圾箱。</p>`);
    }
    if (flags.moved) {
      banners.push(`<p class="banner">已移动到${escapeHtml(label)}。</p>`);
    }
    if (flags.justSent) {
      banners.push(`<p class="banner success">已记下这次发送，可在已发送里打开。</p>`);
    }
    reading = `${banners.join("")}<div class="read-inner"><p class="empty">从左侧选一封，或点「写信」。</p></div>`;
  }

  return layout({
    title: selected?.subject ? `${selected.subject} · Postgrove` : `${label} · Postgrove`,
    nav: folder,
    mailbox,
    mode: selected ? "read" : "list",
    simple: false,
    unreadCount: flags.unreadCount,
    body: `<section class="list">
      <div class="list-head">
        <h1>${escapeHtml(label)}</h1>
        ${folderStrip(mailbox, folder)}
      </div>
      ${list}
    </section>
    <main class="read">${reading}</main>`,
  });
}

function folderStrip(mailbox: MailboxRecord, folder: SystemFolder): string {
  return `<nav class="folder-strip" aria-label="文件夹">
    ${folderNavLinks(folder, (id) => folderHref(mailbox, id))
      .map(
        (item) =>
          `<a class="folder-chip${item.active ? " active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`,
      )
      .join("")}
  </nav>`;
}

function folderMessageRow(
  mailbox: MailboxRecord,
  folder: SystemFolder,
  row: MessageRecord,
  selectedId: string | undefined,
): string {
  const selected = row.id === selectedId ? " selected" : "";
  const subject = row.subject?.trim() ? row.subject : "（无主题）";
  const snippet = row.snippet?.trim() ?? "";
  const peer =
    folder === "sent" || folder === "draft"
      ? row.envelope_to || "（未填写收件人）"
      : row.envelope_from;
  const href =
    folder === "draft"
      ? composeHref(mailbox, "new", undefined, row.id)
      : messagePath(mailbox.id, row.id, folder);
  return `<li>
    <a class="msg${selected}" href="${escapeHtml(href)}">
      <div class="msg-top">
        <span class="from">${escapeHtml(peer)}</span>
        <time class="time" datetime="${escapeHtml(new Date(row.received_at).toISOString())}">${escapeHtml(formatReceived(row.received_at))}</time>
      </div>
      <div class="subject">${escapeHtml(subject)}</div>
      <p class="snippet">${escapeHtml(snippet)}</p>
    </a>
  </li>`;
}

function emptyInboxCopy(count: number, q: string, filter: InboxFilter): string {
  if (count > 0) {
    return "";
  }
  if (q) {
    return `没有匹配「${q}」的信。`;
  }
  if (filter === "unread") {
    return "没有未读的信。";
  }
  if (filter === "starred") {
    return "还没有星标。";
  }
  return "还没有信。域名路由配好后，寄一封到你的地址试试。";
}

function threadRow(
  mailbox: MailboxRecord,
  thread: MessageThread,
  selectedThreadId: string | undefined,
  q: string,
  filter: InboxFilter,
): string {
  const latest = latestThreadMessage(thread);
  const unread = threadHasUnread(thread);
  const starred = latest.is_starred === 1;
  const selected = thread.id === selectedThreadId ? " selected" : "";
  const unreadClass = unread ? " unread" : "";
  const subject = latest.subject?.trim() ? latest.subject : "（无主题）";
  const snippet = latest.snippet?.trim() ?? "";
  const count = thread.messages.length;
  const countBadge =
    count > 1
      ? `<span class="thread-count" title="${count} 封">${count}</span>`
      : "";
  const dot = unread
    ? `<span class="unread-dot" title="未读"></span>`
    : "";
  const href = threadHref(mailbox, thread.id, q, filter);
  const next = selectedThreadId
    ? threadHref(mailbox, selectedThreadId, q, filter)
    : viewHref(mailbox, q, filter);
  const starLabel = starred ? "取消星标" : "星标";
  return `<li class="msg-row">
    <form class="star-form" method="post" action="${escapeHtml(`${messagePath(mailbox.id, latest.id)}/star`)}">
      <input type="hidden" name="starred" value="${starred ? "0" : "1"}">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <button class="star-btn${starred ? " on" : ""}" type="submit" title="${starLabel}" aria-label="${starLabel}">${starred ? "★" : "☆"}</button>
    </form>
    <a class="msg${unreadClass}${selected}" href="${escapeHtml(href)}">
      <div class="msg-top">
        <span class="from">${dot}${escapeHtml(latest.envelope_from)}</span>
        ${countBadge}
        <time class="time" datetime="${escapeHtml(new Date(latest.received_at).toISOString())}">${escapeHtml(formatReceived(latest.received_at))}</time>
      </div>
      <div class="subject">${escapeHtml(subject)}</div>
      <p class="snippet">${escapeHtml(snippet)}</p>
    </a>
  </li>`;
}

function renderReading(
  mailbox: MailboxRecord,
  message: MessageRecord,
  attachments: AttachmentRecord[] = [],
  q = "",
  filter: InboxFilter = "all",
  folder: SystemFolder = "inbox",
): string {
  const label = FOLDER_LABELS[folder];
  const backHref = folder === "inbox" ? viewHref(mailbox, q, filter) : boxPath(mailbox.id, folder);
  return `<div class="read-inner">
    <a class="back" href="${escapeHtml(backHref)}">← ${escapeHtml(label)}</a>
    ${renderReadArticle(mailbox, message, attachments, q, filter, folder)}
  </div>`;
}

function renderThreadReading(
  mailbox: MailboxRecord,
  thread: MessageThread,
  selectedId: string,
  attachments: AttachmentRecord[],
  q: string,
  filter: InboxFilter,
): string {
  const latest = latestThreadMessage(thread);
  const subject = latest.subject?.trim() ? latest.subject : "（无主题）";
  const backHref = viewHref(mailbox, q, filter);
  const cards = thread.messages
    .map((member) => {
      const current = member.id === selectedId ? " current" : "";
      return `<div class="thread-item${current}">${renderReadArticle(
        mailbox,
        member,
        attachmentsForMessage(attachments, member.id),
        q,
        filter,
        "inbox",
      )}</div>`;
    })
    .join("");
  return `<div class="read-inner">
    <a class="back" href="${escapeHtml(backHref)}">← 收件箱</a>
    <p class="thread-summary">${escapeHtml(subject)} · ${thread.messages.length} 封 · 按时间排列</p>
    <div class="thread-stack">${cards}</div>
  </div>`;
}

function renderReadArticle(
  mailbox: MailboxRecord,
  message: MessageRecord,
  attachments: AttachmentRecord[],
  q: string,
  filter: InboxFilter,
  folder: SystemFolder,
): string {
  const subject = message.subject?.trim() ? message.subject : "（无主题）";
  const body = message.body_text?.trim()
    ? escapeHtml(message.body_text)
    : "（没有正文）";
  const replyHref = composeHref(mailbox, "reply", message.id);
  const replyAllHref = composeHref(mailbox, "reply-all", message.id);
  const forwardHref = composeHref(mailbox, "forward", message.id);
  const next = messageHref(mailbox, message.id, q, filter);
  const starred = message.is_starred === 1;
  const starLabel = starred ? "取消星标" : "星标";
  const actions: string[] = [];

  if (folder === "inbox" || folder === "spam") {
    actions.push(`<a class="btn btn-primary" href="${escapeHtml(replyHref)}">回复</a>`);
    actions.push(`<a class="btn" href="${escapeHtml(replyAllHref)}">全部回复</a>`);
    actions.push(`<a class="btn" href="${escapeHtml(forwardHref)}">转发</a>`);
  } else if (folder === "sent") {
    actions.push(`<a class="btn" href="${escapeHtml(forwardHref)}">转发</a>`);
  }

  if (folder === "inbox") {
    actions.push(`<form method="post" action="${escapeHtml(`${messagePath(mailbox.id, message.id)}/star`)}">
          <input type="hidden" name="starred" value="${starred ? "0" : "1"}">
          <input type="hidden" name="next" value="${escapeHtml(next)}">
          <button class="btn${starred ? " star-on" : ""}" type="submit">${starLabel}</button>
        </form>`);
    actions.push(
      message.is_read === 1
        ? `<form method="post" action="${escapeHtml(`${messagePath(mailbox.id, message.id)}/read`)}">
        <input type="hidden" name="read" value="0">
        <button class="btn" type="submit">标为未读</button>
      </form>`
        : `<form method="post" action="${escapeHtml(`${messagePath(mailbox.id, message.id)}/read`)}">
        <input type="hidden" name="read" value="1">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <button class="btn" type="submit">标为已读</button>
      </form>`,
    );
    actions.push(moveForm(mailbox, message.id, "spam", "垃圾邮件"));
  }
  if (folder === "spam" || folder === "trash") {
    actions.push(moveForm(mailbox, message.id, "inbox", "移回收件箱"));
  }
  if (folder !== "trash") {
    actions.push(`<form method="post" action="${escapeHtml(`${messagePath(mailbox.id, message.id, folder)}/delete`)}" onsubmit="return confirm('删除后这封信会进入垃圾箱。确定删除？');">
          <button class="btn btn-danger" type="submit">删除</button>
        </form>`);
  }

  return `<article class="read-card">
      <header class="read-head">
        <h1>${escapeHtml(subject)}</h1>
      </header>
      <div class="meta">
        <div>发件人 <span class="mono">${escapeHtml(message.envelope_from)}</span></div>
        <div>收件人 <span class="mono">${escapeHtml(message.envelope_to)}</span></div>
        ${message.header_cc ? `<div>抄送 <span class="mono">${escapeHtml(message.header_cc)}</span></div>` : ""}
        <div>时间 ${escapeHtml(formatReceived(message.received_at))}</div>
      </div>
      <div class="actions">
        ${actions.join("")}
      </div>
      ${renderAttachmentsHtml(attachments)}
      <pre class="body">${body}</pre>
    </article>`;
}

function moveForm(
  mailbox: MailboxRecord,
  messageId: string,
  folder: SystemFolder,
  label: string,
): string {
  return `<form method="post" action="${escapeHtml(`${messagePath(mailbox.id, messageId)}/move`)}">
          <input type="hidden" name="folder" value="${escapeHtml(folder)}">
          <button class="btn" type="submit">${escapeHtml(label)}</button>
        </form>`;
}

function renderComposePage(
  env: Env,
  mailbox: MailboxRecord | null,
  opts: {
    form: ComposeForm;
    formError?: string;
    highlighted?: OutboundAttemptRecord | null;
    attempts: OutboundAttemptRecord[];
    mode?: ComposeMode;
    unreadCount: number;
    savedDraft?: boolean;
  },
): string {
  const outbound = describeOutbound(env);
  const mode = opts.mode ?? "new";
  const heading = composeHeading(mode);
  const banners: string[] = [];
  if (opts.highlighted) {
    banners.push(attemptBanner(opts.highlighted));
  }
  if (opts.savedDraft) {
    banners.push(`<p class="banner success">草稿已保存。主题和正文已保留，可继续写或从草稿箱打开。</p>`);
  }
  if (opts.formError) {
    banners.push(
      `<p class="banner danger">${escapeHtml(opts.formError)}</p>`,
    );
  }
  if (!opts.highlighted && mode !== "new") {
    banners.push(
      `<p class="banner reply">${escapeHtml(heading)}会走现有出站通道。可改收件人或正文后再发送。</p>`,
    );
  }
  if (!opts.highlighted && outbound.provider === "unset") {
    banners.push(`<p class="banner danger">${escapeHtml(outbound.hint)}</p>`);
  } else if (!opts.highlighted && outbound.provider === "stub") {
    banners.push(`<p class="banner">${escapeHtml(outbound.hint)}</p>`);
  }

  const fromLine = mailbox
    ? `<p class="from-line">发件人 <span class="mono">${escapeHtml(mailbox.address)}</span></p>`
    : `<p class="banner danger">没有可用地址。确认本地已经 migrate 并且 seed。</p>`;

  const threadLine = opts.form.inReplyTo
    ? `<p class="from-line">引用 <span class="mono">In-Reply-To: ${escapeHtml(opts.form.inReplyTo)}</span></p>`
    : "";

  const disabled = mailbox ? "" : " disabled";
  const form = `<form id="compose-form" class="compose-form" method="post" action="${escapeHtml(withMailbox("/compose", mailbox))}">
      ${fromLine}
      ${threadLine}
      <input type="hidden" name="in_reply_to" value="${escapeHtml(opts.form.inReplyTo)}">
      <input type="hidden" name="references" value="${escapeHtml(opts.form.references)}">
      <input type="hidden" name="draft_id" value="${escapeHtml(opts.form.draftId)}">
      <label>收件人
        <input class="search compose-input" name="to" type="text" inputmode="email" autocomplete="email" placeholder="neighbor@example.test" value="${escapeHtml(opts.form.to)}"${disabled}>
      </label>
      <label>抄送
        <input class="search compose-input" name="cc" type="text" inputmode="email" autocomplete="email" placeholder="可选，多人用逗号分隔" value="${escapeHtml(opts.form.cc)}"${disabled}>
      </label>
      <label>主题
        <input class="search compose-input" name="subject" type="text" maxlength="998" value="${escapeHtml(opts.form.subject)}"${disabled}>
      </label>
      <label>正文
        <textarea class="compose-body" name="body" rows="14"${disabled}>${escapeHtml(opts.form.body)}</textarea>
      </label>
      <div class="compose-actions">
        <button class="btn btn-primary" type="submit" name="intent" value="send"${disabled}>发送</button>
        <button class="btn" type="submit" name="intent" value="save"${disabled}>存草稿</button>
      </div>
    </form>
    <script>
      (function () {
        var form = document.getElementById("compose-form");
        if (!form) return;
        form.addEventListener("submit", function (event) {
          var submitter = event.submitter;
          var intent = submitter && submitter.getAttribute("value");
          if (intent === "save") return;
          var to = form.querySelector("input[name=to]");
          if (to && !String(to.value || "").match(/[^\\s@]+@[^\\s@]+\\.[^\\s@]+/)) {
            event.preventDefault();
            if (to.setCustomValidity) to.setCustomValidity("填写至少一个收件人地址后再发送。");
            if (to.reportValidity) to.reportValidity();
            if (to.setCustomValidity) to.setCustomValidity("");
            return;
          }
          var btn = form.querySelector("button[name=intent][value=send]");
          if (btn) {
            btn.disabled = true;
            btn.textContent = "正在发送…";
          }
        });
      })();
    </script>`;

  const history = renderAttemptHistory(opts.attempts, opts.highlighted?.id ?? null);

  return layout({
    title: `${heading} · Postgrove`,
    nav: "compose",
    mailbox,
    mode: "list",
    simple: true,
    unreadCount: opts.unreadCount,
    body: `<main class="page"><div class="page-inner">
      <div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
      <div class="page-card">${banners.join("")}${form}${history}</div>
    </div></main>`,
  });
}

function attemptBanner(row: OutboundAttemptRecord): string {
  if (row.status === "sent") {
    const extra =
      row.provider === "stub"
        ? "已记下这次发送（stub 不真正寄出）。"
        : "已发出。";
    return `<p class="banner success">${escapeHtml(extra)}</p>`;
  }
  const reason = row.error || "outbound_failed";
  const next = row.hint || "检查出站配置或稍后重试。";
  return `<p class="banner danger">没发出去：${escapeHtml(reason)}。${escapeHtml(next)}</p>`;
}

function renderAttemptHistory(
  attempts: OutboundAttemptRecord[],
  highlightedId: string | null,
): string {
  if (attempts.length === 0) {
    return "";
  }
  const items = attempts
    .map((row) => {
      const selected = row.id === highlightedId ? " selected" : "";
      const status =
        row.status === "sent" ? "已发出" : `失败 · ${row.error || "outbound_failed"}`;
      const subject = row.subject?.trim() ? row.subject : "（无主题）";
      return `<li class="attempt${selected}">
        <div class="attempt-top">
          <span class="attempt-status ${row.status}">${escapeHtml(status)}</span>
          <time datetime="${escapeHtml(new Date(row.created_at).toISOString())}">${escapeHtml(formatReceived(row.created_at))}</time>
        </div>
        <div>收件人 <span class="mono">${escapeHtml(row.to_address)}</span></div>
        ${row.cc_address ? `<div>抄送 <span class="mono">${escapeHtml(row.cc_address)}</span></div>` : ""}
        <div>主题 ${escapeHtml(subject)}</div>
        ${row.in_reply_to ? `<div>引用 <span class="mono">${escapeHtml(row.in_reply_to)}</span></div>` : ""}
        <div>提供商 <span class="mono">${escapeHtml(row.provider)}</span></div>
        ${row.hint ? `<p class="attempt-hint">${escapeHtml(row.hint)}</p>` : ""}
      </li>`;
    })
    .join("");
  return `<section class="attempts">
    <h2>最近发送</h2>
    <ul class="attempt-list">${items}</ul>
  </section>`;
}

function renderAddressesPage(
  mailboxes: MailboxRecord[],
  nav: NavId,
  unreadCount = 0,
  error: string | null = null,
): string {
  const current = mailboxes[0] ?? null;
  const banner = error ? `<p class="banner danger">${escapeHtml(error)}</p>` : "";
  const form = `<form class="grove-form" method="post" action="/addresses">
      <label>新地址
        <input class="search" name="address" type="email" required placeholder="notes@example.test">
      </label>
      <label>名称
        <input class="search" name="display_name" placeholder="可选">
      </label>
      <button class="btn btn-primary" type="submit">开一个地址</button>
    </form>
    <p class="banner">主人会话开地址不占成员配额。成员会话会记入该成员的地址配额，超了会明确报错。</p>`;
  let content: string;
  if (mailboxes.length === 0) {
    content = `${emptyBlock("还没有地址。开一个，例如 you@yourdomain。")}${form}`;
  } else {
    content = `<ul class="addr-list">${mailboxes
      .map(
        (box) => `<li>
        <a href="${escapeHtml(boxPath(box.id))}">
          <span class="name">${escapeHtml(box.display_name || box.address)}</span>
          <span class="mono">${escapeHtml(box.address)}</span>
        </a>
      </li>`,
      )
      .join("")}</ul>${form}`;
  }
  return layout({
    title: "地址 · Postgrove",
    nav,
    mailbox: current,
    mode: "list",
    simple: true,
    unreadCount,
    body: `<main class="page"><div class="page-inner">
      <div class="page-head"><h1>地址</h1></div>
      <div class="page-card">${banner}${content}</div>
    </div></main>`,
  });
}

function renderStubPage(
  nav: NavId,
  heading: string,
  mailbox: MailboxRecord | null,
  notes: string[],
  showLogout = false,
  unreadCount = 0,
): string {
  const banners = notes.map((note) => `<p class="banner">${escapeHtml(note)}</p>`).join("");
  const logout = showLogout
    ? `<form id="logout-form" class="logout-form">
        <button class="btn" type="submit">登出</button>
      </form>
      <script>
        (function () {
          var form = document.getElementById("logout-form");
          if (!form) return;
          form.addEventListener("submit", function (event) {
            event.preventDefault();
            fetch("/auth/logout", { method: "POST" }).finally(function () {
              location.href = "/";
            });
          });
        })();
      </script>`
    : "";
  return layout({
    title: `${heading} · Postgrove`,
    nav,
    mailbox,
    mode: "list",
    simple: true,
    unreadCount,
    body: `<main class="page"><div class="page-inner">
      <div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
      <div class="page-card">${banners}${logout}</div>
    </div></main>`,
  });
}

function renderLoginPage(error: string, hint: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录 · Postgrove</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="mode-list">
  <main class="page">
    <div class="page-inner">
      <a class="brand" href="/">${GROVE_MARK}Postgrove</a>
      <div class="page-head"><h1>登录</h1></div>
      <div class="page-card">
        <p class="banner">登录已失效。重新登录后再继续。</p>
        <p class="banner"><code class="mono">${escapeHtml(error)}</code> — ${escapeHtml(hint)}</p>
        <form id="login-form" class="login-form">
          <label>地址
            <input name="address" class="search" type="email" autocomplete="username" value="inbox@example.test" required>
          </label>
          <label>口令
            <input name="token" class="search" type="password" autocomplete="current-password" required>
          </label>
          <button class="btn btn-primary" type="submit">登录</button>
          <p id="login-error" class="banner" hidden></p>
        </form>
      </div>
    </div>
  </main>
  <script>
    (function () {
      var form = document.getElementById("login-form");
      var err = document.getElementById("login-error");
      if (!form || !err) return;
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var data = new FormData(form);
        err.hidden = true;
        fetch("/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address: data.get("address"),
            token: data.get("token")
          })
        }).then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
          .then(function (result) {
            if (result.res.ok) {
              location.href = "/";
              return;
            }
            err.textContent = result.body.hint || result.body.error || "登录失败。";
            err.hidden = false;
          })
          .catch(function () {
            err.textContent = "登录失败。检查网络后重试。";
            err.hidden = false;
          });
      });
    })();
  </script>
</body>
</html>`;
}

function renderForbidden(mailbox: MailboxRecord | null, unreadCount = 0): string {
  return layout({
    title: "无权查看 · Postgrove",
    nav: "inbox",
    mailbox,
    mode: "list",
    simple: true,
    unreadCount,
    body: `<main class="page"><div class="page-inner">
      <div class="page-card">
        <h1>无权查看这个地址</h1>
        <p class="banner">This session is bound to another mailbox. POST /auth/login with that address.</p>
        <p><a href="${escapeHtml(inboxHref(mailbox))}">返回收件箱</a></p>
      </div>
    </div></main>`,
  });
}

function renderNotFound(mailbox: MailboxRecord | null = null, unreadCount = 0): string {
  return layout({
    title: "未找到 · Postgrove",
    nav: "inbox",
    mailbox,
    mode: "list",
    simple: true,
    unreadCount,
    body: `<main class="page"><div class="page-inner">
      <div class="page-card">
        <h1>没有这封信或这个地址</h1>
        <p class="banner">回到收件箱再试一次，或确认本地已经 migrate 并且 seed。</p>
        <p><a href="${escapeHtml(inboxHref(mailbox))}">返回收件箱</a></p>
      </div>
    </div></main>`,
  });
}

function emptyBlock(copy: string): string {
  return `<div class="empty">${EMPTY_ART}<p>${escapeHtml(copy)}</p></div>`;
}

function layout(opts: {
  title: string;
  nav: NavId;
  mailbox: MailboxRecord | null;
  mode: "list" | "read";
  simple: boolean;
  body: string;
  unreadCount?: number;
}): string {
  const inbox = inboxHref(opts.mailbox);
  const unreadHref = opts.mailbox ? `${boxPath(opts.mailbox.id)}?filter=unread` : inbox;
  const compose = withMailbox("/compose", opts.mailbox);
  const settings = withMailbox("/settings", opts.mailbox);
  const unreadCount = opts.unreadCount ?? 0;
  const countBadge =
    unreadCount > 0
      ? `<span class="nav-count" aria-label="${unreadCount} 封未读">${unreadCount}</span>`
      : "";
  const chip = opts.mailbox
    ? `<div class="mailbox-chip"><span class="label">当前地址</span><span class="addr">${escapeHtml(opts.mailbox.address)}</span></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="mode-${opts.mode}">
  <div class="shell${opts.simple ? " simple" : ""}">
    <aside class="nav">
      <a class="brand" href="${escapeHtml(inbox)}">${GROVE_MARK}Postgrove</a>
      <ul class="nav-list">
        ${folderNavLinks(opts.nav, (id) => folderHref(opts.mailbox, id))
          .map((item) => {
            const badge = item.id === "inbox" ? countBadge : "";
            return `<li><a class="${item.active ? "active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}${badge}</a></li>`;
          })
          .join("")}
        <li><a class="${opts.nav === "unread" ? "active" : ""}" href="${escapeHtml(unreadHref)}">未读</a></li>
      </ul>
      <ul class="nav-list nav-tools">
        <li><a class="${opts.nav === "compose" ? "active" : ""}" href="${escapeHtml(compose)}">写信</a></li>
        <li><a class="${opts.nav === "addresses" ? "active" : ""}" href="/addresses">地址</a></li>
        <li><a class="${opts.nav === "admin" ? "active" : ""}" href="/admin">值守</a></li>
        <li><a class="${opts.nav === "settings" ? "active" : ""}" href="${escapeHtml(settings)}">设置</a></li>
      </ul>
      ${chip}
    </aside>
    ${opts.body}
  </div>
  <nav class="mobile-nav" aria-label="主导航">
    <a class="${(SYSTEM_FOLDERS as readonly string[]).includes(opts.nav) ? "active" : ""}" href="${escapeHtml(inbox)}">收件箱${countBadge}</a>
    <a class="${opts.nav === "unread" ? "active" : ""}" href="${escapeHtml(unreadHref)}">未读</a>
    <a class="${opts.nav === "compose" ? "active" : ""}" href="${escapeHtml(compose)}">写信</a>
    <a class="${opts.nav === "settings" ? "active" : ""}" href="${escapeHtml(settings)}">设置</a>
  </nav>
</body>
</html>`;
}
