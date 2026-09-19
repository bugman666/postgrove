import type { Env } from "./env.ts";
import {
  listMessageAttachments,
  renderAttachmentsHtml,
  type AttachmentRecord,
} from "./attachments.ts";
import {
  AliasInputError,
  createAlias,
  generateAlias,
  listAliases,
  renderAliasPanelHtml,
  type MailboxAliasRecord,
} from "./aliases.ts";
import { actorUserId, requireOwner, type MailboxActor } from "./auth.ts";
import {
  FOLDER_LABELS,
  SYSTEM_FOLDERS,
  folderNavLinks,
  parseDraftFields,
  parseFolder,
  type SystemFolder,
} from "./folders.ts";
import { html, redirect } from "./http.ts";
import { EMPTY_ART, escapeHtml, formatReceived } from "./html.ts";
import {
  folderEmptyKey,
  folderLabelKey,
  parseLocalePreference,
  withLocaleCookie,
} from "./i18n.ts";
import { checkAddressQuota } from "./quotas.ts";
import { describeOutbound } from "./outbound.ts";
import {
  buildComposePrefill,
  composeHeading,
  parseComposeMode,
  type ComposeMode,
  type ComposePrefill,
} from "./reply.ts";
import { parseSendFields, sendOutbound } from "./send.ts";
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
} from "./store.ts";
import { bindUserMailbox, getUser, mailboxAllowed } from "./users.ts";
import {
  brandLink,
  documentLang,
  pageTitle,
  resolveShell,
  tr,
  type Shell,
} from "./view.ts";
import {
  findThreadById,
  findThreadForMessage,
  groupMessagesIntoThreads,
  latestThreadMessage,
  threadHasUnread,
  type MessageThread,
} from "./threads.ts";
import { parseInboxFilter, parseSearchQuery, type InboxFilter } from "./triage.ts";
import {
  HookInputError,
  getHookConfig,
  listDeliveries,
  parseHookConfigBody,
  publicHookConfig,
  saveHookConfig,
  type InboundDeliveryRecord,
  type PublicHookConfig,
} from "./webhooks.ts";

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
  const shell = await resolveShell(request, env);
  const gate = await requireOwner(request, env);
  if (!gate.ok) {
    return unauthorizedPage(shell, gate.response);
  }

  const owner: MailboxActor = gate.principal;
  const path = url.pathname;
  const method = request.method;
  const ownMailbox = await getMailbox(env, owner.mailboxId);
  let unreadCount = ownMailbox ? await countUnreadInbox(env, ownMailbox.id) : 0;

  if (path === "/") {
    if (method !== "GET") {
      return pageMethodNotAllowed(shell);
    }
    if (!ownMailbox) {
      return html(renderAddressesPage(shell, [], "inbox", unreadCount), 200);
    }
    return redirect(boxPath(ownMailbox.id));
  }

  if (path === "/compose") {
    if (method === "POST") {
      return handleComposeSubmit(request, env, url, owner, ownMailbox, unreadCount, shell);
    }
    if (method !== "GET") {
      return pageMethodNotAllowed(shell);
    }
    return renderCompose(env, url, ownMailbox, unreadCount, shell);
  }

  if (path === "/addresses") {
    if (method === "POST") {
      return handleAddressCreate(request, env, owner, unreadCount, shell);
    }
    if (method !== "GET") {
      return pageMethodNotAllowed(shell);
    }
    const boxes = await visibleUiMailboxes(env, owner, ownMailbox);
    return html(renderAddressesPage(shell, boxes, "addresses", unreadCount, url.searchParams.get("error")));
  }

  if (path === "/settings") {
    if (method === "POST") {
      return handleSettingsSave(request, env, owner, ownMailbox, unreadCount, shell);
    }
    if (method !== "GET") {
      return pageMethodNotAllowed(shell);
    }
    return renderSettings(
      env,
      owner,
      ownMailbox,
      unreadCount,
      shell,
      url.searchParams.get("error"),
      url.searchParams.get("saved"),
      url.searchParams.get("lang"),
      url.searchParams.get("alias"),
    );
  }

  const moveMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)\/move$/);
  if (moveMatch) {
    if (method !== "POST") {
      return pageMethodNotAllowed(shell);
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(moveMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(shell, ownMailbox, unreadCount);
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
      return pageMethodNotAllowed(shell);
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(deleteMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(shell, ownMailbox, unreadCount);
    }
    const messageId = decodeURIComponent(deleteMatch[2]);
    await trashMessage(env, mailbox.id, messageId);
    return redirect(`${boxPath(mailbox.id, "trash")}?deleted=1`);
  }

  const starMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)\/star$/);
  if (starMatch) {
    if (method !== "POST") {
      return pageMethodNotAllowed(shell);
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(starMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(shell, ownMailbox, unreadCount);
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
      return pageMethodNotAllowed(shell);
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(flagMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(shell, ownMailbox, unreadCount);
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
      return pageMethodNotAllowed(shell);
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(threadMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(shell, ownMailbox, unreadCount);
    }
    const threadId = decodeURIComponent(threadMatch[2]);
    const view = readInboxView(url);
    const listed = await listInboxMessages(env, mailbox.id, view);
    const visible = findThreadById(groupMessagesIntoThreads(listed), threadId);
    if (!visible) {
      return html(renderNotFound(shell, mailbox, unreadCount), 404);
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
      shell,
      ...view,
    }));
  }

  const readMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)$/);
  if (readMatch) {
    if (method !== "GET") {
      return pageMethodNotAllowed(shell);
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(readMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(shell, ownMailbox, unreadCount);
    }
    const messageId = decodeURIComponent(readMatch[2]);
    const existing = await getMailboxMessage(env, mailbox.id, messageId);
    if (!existing) {
      return html(renderNotFound(shell, mailbox, unreadCount), 404);
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
        shell,
        ...view,
      }));
    }
    return html(renderFolderPage(mailbox, folder, messages, message, {
      attachments,
      unreadCount,
      shell,
    }));
  }

  const boxMatch = path.match(/^\/box\/([^/]+)$/);
  if (boxMatch) {
    if (method !== "GET") {
      return pageMethodNotAllowed(shell);
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(boxMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(shell, ownMailbox, unreadCount);
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
          shell,
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
        shell,
      }),
    );
  }

  return html(renderNotFound(shell, undefined, unreadCount), 404);
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
  shell: Shell,
): Promise<Response> {
  const boxes = await visibleUiMailboxes(env, owner, await getMailbox(env, owner.mailboxId));
  const data = await request.formData();
  const address = stringField(data.get("address"));
  const displayName = stringField(data.get("display_name"));
  const userId = actorUserId(owner);
  if (userId) {
    const user = await getUser(env, userId);
    if (user) {
      const quota = await checkAddressQuota(env, user, shell.locale);
      if (quota) {
        return html(renderAddressesPage(shell, boxes, "addresses", unreadCount, quota.hint), 409);
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
    return html(renderAddressesPage(shell, boxes, "addresses", unreadCount, hint), 400);
  }
}

async function handleSettingsSave(
  request: Request,
  env: Env,
  owner: MailboxActor,
  ownMailbox: MailboxRecord | null,
  unreadCount: number,
  shell: Shell,
): Promise<Response> {
  const data = await request.formData();
  if (stringField(data.get("intent")) === "locale") {
    const preference = parseLocalePreference(stringField(data.get("locale")));
    return withLocaleCookie(redirect("/settings?lang=1"), request, preference);
  }
  if (stringField(data.get("intent")) === "alias") {
    if (!ownMailbox) {
      return renderSettings(env, owner, ownMailbox, unreadCount, shell, "没有当前地址，先登录一个信箱。");
    }
    try {
      if (stringField(data.get("action")) === "generate") {
        await generateAlias(env, ownMailbox);
      } else {
        await createAlias(env, ownMailbox, stringField(data.get("address")) ?? "");
      }
      return redirect("/settings?alias=1");
    } catch (error) {
      const hint = error instanceof AliasInputError ? error.message : "没能保存别名。";
      return renderSettings(env, owner, ownMailbox, unreadCount, shell, hint);
    }
  }
  if (!ownMailbox) {
    return renderSettings(env, owner, ownMailbox, unreadCount, shell, "没有当前地址，先登录一个信箱。");
  }
  const body = {
    webhook_enabled: stringField(data.get("webhook_enabled")) === "1",
    webhook_url: stringField(data.get("webhook_url")),
    webhook_secret: stringField(data.get("webhook_secret")),
    rotate_secret: stringField(data.get("rotate_secret")) === "1",
    forward_enabled: stringField(data.get("forward_enabled")) === "1",
    forward_url: stringField(data.get("forward_url")),
    forward_email: stringField(data.get("forward_email")),
  };
  try {
    parseHookConfigBody(body);
    await saveHookConfig(env, ownMailbox.id, parseHookConfigBody(body));
    return redirect("/settings?saved=1");
  } catch (error) {
    const hint = error instanceof HookInputError ? error.message : "没能保存入站通知。";
    return renderSettings(env, owner, ownMailbox, unreadCount, shell, hint);
  }
}

async function renderSettings(
  env: Env,
  owner: MailboxActor,
  mailbox: MailboxRecord | null,
  unreadCount: number,
  shell: Shell,
  error: string | null = null,
  saved: string | null = null,
  lang: string | null = null,
  aliasSaved: string | null = null,
): Promise<Response> {
  let hook: PublicHookConfig | null = null;
  let deliveries: InboundDeliveryRecord[] = [];
  let aliases: MailboxAliasRecord[] = [];
  if (mailbox) {
    try {
      aliases = await listAliases(env, mailbox.id);
    } catch {
      aliases = [];
    }
    try {
      const row = await getHookConfig(env, mailbox.id);
      hook = row
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
          });
      deliveries = await listDeliveries(env, mailbox.id, 20);
    } catch {
      hook = null;
    }
  }
  const status = error ? 400 : 200;
  return html(
    renderSettingsPage(
      owner,
      mailbox,
      hook,
      deliveries,
      aliases,
      unreadCount,
      shell,
      error,
      saved === "1",
      lang === "1",
      aliasSaved === "1",
    ),
    status,
  );
}

async function unauthorizedPage(shell: Shell, authResponse: Response): Promise<Response> {
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
  return html(renderLoginPage(shell, error, hint), authResponse.status);
}

function forbiddenOrMissing(shell: Shell, ownMailbox: MailboxRecord | null, unreadCount = 0): Response {
  return html(renderForbidden(shell, ownMailbox, unreadCount), ownMailbox ? 403 : 404);
}

async function handleComposeSubmit(
  request: Request,
  env: Env,
  url: URL,
  owner: MailboxActor,
  ownMailbox: MailboxRecord | null,
  unreadCount: number,
  shell: Shell,
): Promise<Response> {
  if (!ownMailbox) {
    return html(
      renderComposePage(env, ownMailbox, {
        form: emptyComposeForm(),
        formError: "没有可用地址。先确认本地已经 migrate 并且 seed，再 POST /auth/login。",
        attempts: [],
        unreadCount,
        shell,
      }),
      404,
    );
  }
  if (!mailboxAllowed(owner, ownMailbox)) {
    return forbiddenOrMissing(shell, ownMailbox, unreadCount);
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
          shell,
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
      return saveComposeDraft(env, url, ownMailbox, form, unreadCount, shell);
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
      return saveComposeDraft(env, url, ownMailbox, form, unreadCount, shell);
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
        shell,
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
  shell: Shell,
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
        shell,
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
        shell,
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
  shell: Shell,
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
      shell,
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

function pageMethodNotAllowed(shell: Shell): Response {
  return html(renderNotFound(shell), 405);
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
    shell: Shell;
  },
): string {
  const q = flags.q;
  const filter = flags.filter;
  const shell = flags.shell;
  const heading =
    filter === "unread"
      ? tr(shell, "nav.unread")
      : filter === "starred"
        ? tr(shell, "nav.starred")
        : q
          ? tr(shell, "heading.search")
          : tr(shell, "nav.inbox");
  const threads = groupMessagesIntoThreads(messages);
  const selectedThread = flags.thread
    ?? (selected ? findThreadForMessage(threads, selected.id) : null);
  const emptyCopy = emptyInboxCopy(shell, messages.length, q, filter);
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
      banners.push(`<p class="banner">${escapeHtml(tr(shell, "banner.deleted-inbox"))}</p>`);
    }
    if (flags.markedUnread) {
      banners.push(`<p class="banner">${escapeHtml(tr(shell, "banner.marked-unread"))}</p>`);
    }
    reading = `${banners.join("")}<div class="read-inner"><p class="empty">${escapeHtml(tr(shell, "empty.pick"))}</p></div>`;
  }

  const chips = (["all", "unread", "starred"] as const)
    .map((id) => {
      const label =
        id === "all"
          ? tr(shell, "filter.all")
          : id === "unread"
            ? tr(shell, "filter.unread")
            : tr(shell, "filter.starred");
      const active = filter === id ? " active" : "";
      return `<a class="filter${active}" href="${escapeHtml(viewHref(mailbox, q, id))}">${escapeHtml(label)}</a>`;
    })
    .join("");

  return layout({
    title: selected?.subject ? pageTitle(shell, selected.subject) : pageTitle(shell, heading),
    nav: filter === "unread" ? "unread" : "inbox",
    mailbox,
    mode: selected ? "read" : "list",
    simple: false,
    unreadCount: flags.unreadCount,
    shell,
    body: `<section class="list">
      <div class="list-head">
        <h1>${escapeHtml(heading)}</h1>
        ${folderStrip(shell, mailbox, "inbox")}
        <form class="search-form" method="get" action="${escapeHtml(boxPath(mailbox.id))}">
          <input class="search" type="search" name="q" value="${escapeHtml(q)}" placeholder="搜索发件人、收件人、主题或正文" maxlength="200">
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
    shell: Shell;
  },
): string {
  const shell = flags.shell;
  const label = tr(shell, folderLabelKey(folder));
  const list = messages.length === 0
    ? emptyBlock(tr(shell, folderEmptyKey(folder)))
    : `<ul class="msg-list">${messages.map((row) => folderMessageRow(mailbox, folder, row, selected?.id)).join("")}</ul>`;

  let reading: string;
  if (selected) {
    const sentBanner = flags.justSent
      ? `<p class="banner success">${escapeHtml(tr(shell, "banner.sent-ok"))}</p>`
      : "";
    reading = `${sentBanner}${renderReading(mailbox, selected, flags.attachments ?? [], "", "all", folder)}`;
  } else {
    const banners: string[] = [];
    if (flags.deleted) {
      banners.push(`<p class="banner">${escapeHtml(tr(shell, "banner.deleted-trash"))}</p>`);
    }
    if (flags.moved) {
      banners.push(`<p class="banner">${escapeHtml(tr(shell, "banner.moved", { folder: label }))}</p>`);
    }
    if (flags.justSent) {
      banners.push(`<p class="banner success">${escapeHtml(tr(shell, "banner.sent-noted"))}</p>`);
    }
    reading = `${banners.join("")}<div class="read-inner"><p class="empty">${escapeHtml(tr(shell, "empty.pick"))}</p></div>`;
  }

  return layout({
    title: selected?.subject ? pageTitle(shell, selected.subject) : pageTitle(shell, label),
    nav: folder,
    mailbox,
    mode: selected ? "read" : "list",
    simple: false,
    unreadCount: flags.unreadCount,
    shell,
    body: `<section class="list">
      <div class="list-head">
        <h1>${escapeHtml(label)}</h1>
        ${folderStrip(shell, mailbox, folder)}
      </div>
      ${list}
    </section>
    <main class="read">${reading}</main>`,
  });
}

function folderStrip(shell: Shell, mailbox: MailboxRecord, folder: SystemFolder): string {
  return `<nav class="folder-strip" aria-label="${escapeHtml(tr(shell, "nav.folders"))}">
    ${folderNavLinks(folder, (id) => folderHref(mailbox, id), folderLabels(shell))
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

function emptyInboxCopy(shell: Shell, count: number, q: string, filter: InboxFilter): string {
  if (count > 0) {
    return "";
  }
  if (q) {
    return tr(shell, "empty.search", { q });
  }
  if (filter === "unread") {
    return tr(shell, "empty.unread");
  }
  if (filter === "starred") {
    return tr(shell, "empty.starred");
  }
  return tr(shell, "empty.inbox");
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
    shell: Shell;
  },
): string {
  const shell = opts.shell;
  const outbound = describeOutbound(env);
  const mode = opts.mode ?? "new";
  const heading = composeHeading(mode);
  const banners: string[] = [];
  if (opts.highlighted) {
    banners.push(attemptBanner(opts.highlighted));
  }
  if (opts.savedDraft) {
    banners.push(`<p class="banner success">${escapeHtml(tr(shell, "banner.draft-saved"))}</p>`);
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
    : `<p class="banner danger">${escapeHtml(tr(shell, "banner.no-mailbox"))}</p>`;

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
    title: pageTitle(shell, heading),
    nav: "compose",
    mailbox,
    mode: "list",
    simple: true,
    unreadCount: opts.unreadCount,
    shell,
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
  shell: Shell,
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
    content = `${emptyBlock(tr(shell, "empty.addresses"))}${form}`;
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
    title: pageTitle(shell, tr(shell, "heading.addresses")),
    nav,
    mailbox: current,
    mode: "list",
    simple: true,
    unreadCount,
    shell,
    body: `<main class="page"><div class="page-inner">
      <div class="page-head"><h1>${escapeHtml(tr(shell, "heading.addresses"))}</h1></div>
      <div class="page-card">${banner}${content}</div>
    </div></main>`,
  });
}

function renderSettingsPage(
  owner: MailboxActor,
  mailbox: MailboxRecord | null,
  hook: PublicHookConfig | null,
  deliveries: InboundDeliveryRecord[],
  aliases: MailboxAliasRecord[],
  unreadCount: number,
  shell: Shell,
  error: string | null,
  saved: boolean,
  langUpdated: boolean,
  aliasSaved: boolean,
): string {
  const who =
    owner.kind === "mailbox"
      ? `你是成员 ${owner.userId}（${owner.role === "admin" ? "值守" : "信箱"}）。会话可打开已绑定的地址。`
      : "这是主人会话（OWNER_TOKEN）。只绑在你登录的那一个地址上。";
  const banners: string[] = [];
  if (error) {
    banners.push(`<p class="banner danger">${escapeHtml(error)}</p>`);
  }
  if (saved) {
    banners.push(`<p class="banner success">${escapeHtml(tr(shell, "banner.hooks-saved"))}</p>`);
  }
  if (langUpdated) {
    banners.push(`<p class="banner success">${escapeHtml(tr(shell, "banner.lang-updated"))}</p>`);
  }
  if (aliasSaved) {
    banners.push(`<p class="banner success">${escapeHtml(tr(shell, "banner.alias-created"))}</p>`);
  }
  banners.push(`<p class="banner">${escapeHtml(who)}</p>`);
  banners.push(`<p class="banner">新信可以推到 webhook，或转发到外部邮箱 / 聊天机器人 URL。失败记在下面，不会静默吞掉。</p>`);

  const form = mailbox
    ? `<form class="grove-form grove-form-stack" method="post" action="/settings">
        <label>Webhook URL
          <input class="search" name="webhook_url" type="url" placeholder="https://hooks.example.test/inbound" value="${escapeHtml(hook?.webhook_url ?? "")}">
        </label>
        <label>Webhook 签名密钥
          <input class="search" name="webhook_secret" type="password" placeholder="${hook?.webhook_secret_set ? "已设置，留空保持" : "留空则生成"}" autocomplete="new-password">
        </label>
        <label>Webhook
          <select name="webhook_enabled">
            <option value="0"${hook?.webhook_enabled ? "" : " selected"}>关闭</option>
            <option value="1"${hook?.webhook_enabled ? " selected" : ""}>开启</option>
          </select>
        </label>
        <label>转发 URL（聊天机器人）
          <input class="search" name="forward_url" type="url" placeholder="https://chat.example.test/hook" value="${escapeHtml(hook?.forward_url ?? "")}">
        </label>
        <label>转发邮箱
          <input class="search" name="forward_email" type="email" placeholder="neighbor@example.test" value="${escapeHtml(hook?.forward_email ?? "")}">
        </label>
        <label>转发
          <select name="forward_enabled">
            <option value="0"${hook?.forward_enabled ? "" : " selected"}>关闭</option>
            <option value="1"${hook?.forward_enabled ? " selected" : ""}>开启</option>
          </select>
        </label>
        <label class="grove-check">
          <input type="checkbox" name="rotate_secret" value="1"> 轮换 webhook 密钥
        </label>
        <button class="btn btn-primary" type="submit">保存入站通知</button>
      </form>`
    : `<p class="banner">没有当前地址，无法保存入站通知。</p>`;

  const deliveryItems = deliveries.length
    ? `<ul class="attempt-list">${deliveries
        .map((row) => {
          const status = row.status === "sent" ? "已送达" : `失败 · ${row.error || "downstream_failed"}`;
          return `<li class="attempt${row.status === "failed" ? " selected" : ""}">
            <div class="attempt-top">
              <span class="attempt-status ${row.status}">${escapeHtml(status)}</span>
              <time>${escapeHtml(formatReceived(row.created_at))}</time>
            </div>
            <div>种类 ${escapeHtml(row.kind === "webhook" ? "webhook" : "转发")}</div>
            <div>目标 <span class="mono">${escapeHtml(row.target)}</span></div>
            ${row.http_status ? `<div>HTTP ${row.http_status}</div>` : ""}
            ${row.hint ? `<p class="attempt-hint">${escapeHtml(row.hint)}</p>` : ""}
          </li>`;
        })
        .join("")}</ul>`
    : `<div class="empty">${EMPTY_ART}<p>${escapeHtml(tr(shell, "empty.delivery-log"))}</p></div>`;

  const logout = `<form id="logout-form" class="logout-form">
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
      </script>`;

  const localePref = shell.preference;
  const languageForm = `<section class="grove-panel">
          <h2>${escapeHtml(tr(shell, "label.language"))}</h2>
          <form class="grove-form" method="post" action="/settings">
            <input type="hidden" name="intent" value="locale">
            <label>${escapeHtml(tr(shell, "label.language"))}
              <select name="locale">
                <option value="auto"${localePref === "auto" ? " selected" : ""}>${escapeHtml(tr(shell, "label.follow-browser"))}</option>
                <option value="zh"${localePref === "zh" ? " selected" : ""}>${escapeHtml(tr(shell, "label.chinese"))}</option>
                <option value="en"${localePref === "en" ? " selected" : ""}>${escapeHtml(tr(shell, "label.english"))}</option>
              </select>
            </label>
            <button class="btn btn-primary" type="submit">${escapeHtml(tr(shell, "label.save-language"))}</button>
          </form>
        </section>`;

  return layout({
    title: pageTitle(shell, tr(shell, "heading.settings")),
    nav: "settings",
    mailbox,
    mode: "list",
    simple: true,
    unreadCount,
    shell,
    body: `<main class="page"><div class="page-inner">
      <div class="page-head"><h1>${escapeHtml(tr(shell, "heading.settings"))}</h1></div>
      <div class="page-card">
        ${banners.join("")}
        ${languageForm}
        ${renderAliasPanelHtml(mailbox, aliases, {
          heading: tr(shell, "heading.aliases"),
          hint: tr(shell, "banner.alias-hint"),
          generate: tr(shell, "label.generate-alias"),
          custom: tr(shell, "label.custom-alias"),
          submit: tr(shell, "label.save-alias"),
          empty: tr(shell, "empty.aliases"),
          primary: tr(shell, "banner.alias-primary"),
        })}
        <section class="grove-panel">
          <h2>入站通知</h2>
          <p class="banner">验签：<span class="mono">HMAC-SHA256</span>，签名串 <span class="mono">\${unix_seconds}.\${raw_json_body}</span>。请求头 <span class="mono">X-Postgrove-Timestamp</span> 与 <span class="mono">X-Postgrove-Signature: v1=&lt;hex&gt;</span>。密钥错了或没带，接收方必须验失败。默认只允许 https；内网 / 元数据 / RFC1918 会被拒绝。</p>
          ${form}
        </section>
        <section class="grove-panel">
          <h2>投递记录</h2>
          ${deliveryItems}
        </section>
        <p class="banner">登出后需要再次 POST /auth/login。成员口令由值守发放。值守台在 /admin，普通成员进不去。入站附件在 R2。</p>
        ${logout}
      </div>
    </div></main>`,
  });
}

function renderLoginPage(shell: Shell, error: string, hint: string): string {
  return `<!DOCTYPE html>
<html lang="${documentLang(shell)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle(shell, tr(shell, "heading.login")))}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="mode-list">
  <main class="page">
    <div class="page-inner">
      ${brandLink(shell, "/")}
      <div class="page-head"><h1>${escapeHtml(tr(shell, "heading.login"))}</h1></div>
      <div class="page-card">
        <p class="banner">${escapeHtml(tr(shell, "banner.login-expired"))}</p>
        <p class="banner"><code class="mono">${escapeHtml(error)}</code> — ${escapeHtml(hint)}</p>
        <form id="login-form" class="login-form">
          <label>地址
            <input name="address" class="search" type="email" autocomplete="username" value="inbox@example.test" required>
          </label>
          <label>口令
            <input name="token" class="search" type="password" autocomplete="current-password" required>
          </label>
          <button class="btn btn-primary" type="submit">${escapeHtml(tr(shell, "brand.login"))}</button>
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

function renderForbidden(shell: Shell, mailbox: MailboxRecord | null, unreadCount = 0): string {
  return layout({
    title: pageTitle(shell, tr(shell, "heading.admin")),
    nav: "inbox",
    mailbox,
    mode: "list",
    simple: true,
    unreadCount,
    shell,
    body: `<main class="page"><div class="page-inner">
      <div class="page-card">
        <h1>无权查看这个地址</h1>
        <p class="banner">This session is bound to another mailbox. POST /auth/login with that address.</p>
        <p><a href="${escapeHtml(inboxHref(mailbox))}">返回收件箱</a></p>
      </div>
    </div></main>`,
  });
}

function renderNotFound(shell: Shell, mailbox: MailboxRecord | null = null, unreadCount = 0): string {
  return layout({
    title: pageTitle(shell, tr(shell, "nav.inbox")),
    nav: "inbox",
    mailbox,
    mode: "list",
    simple: true,
    unreadCount,
    shell,
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

function folderLabels(shell: Shell): Record<SystemFolder, string> {
  return {
    inbox: tr(shell, "nav.inbox"),
    sent: tr(shell, "nav.sent"),
    draft: tr(shell, "nav.draft"),
    trash: tr(shell, "nav.trash"),
    spam: tr(shell, "nav.spam"),
  };
}

function layout(opts: {
  title: string;
  nav: NavId;
  mailbox: MailboxRecord | null;
  mode: "list" | "read";
  simple: boolean;
  body: string;
  unreadCount?: number;
  shell: Shell;
}): string {
  const inbox = inboxHref(opts.mailbox);
  const unreadHref = opts.mailbox ? `${boxPath(opts.mailbox.id)}?filter=unread` : inbox;
  const compose = withMailbox("/compose", opts.mailbox);
  const settings = withMailbox("/settings", opts.mailbox);
  const unreadCount = opts.unreadCount ?? 0;
  const countBadge =
    unreadCount > 0
      ? `<span class="nav-count" aria-label="${unreadCount} ${escapeHtml(tr(opts.shell, "nav.unread"))}">${unreadCount}</span>`
      : "";
  const chip = opts.mailbox
    ? `<div class="mailbox-chip"><span class="label">${escapeHtml(tr(opts.shell, "label.current-mailbox"))}</span><span class="addr">${escapeHtml(opts.mailbox.address)}</span></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="${documentLang(opts.shell)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="mode-${opts.mode}">
  <div class="shell${opts.simple ? " simple" : ""}">
    <aside class="nav">
      ${brandLink(opts.shell, inbox)}
      <ul class="nav-list">
        ${folderNavLinks(opts.nav, (id) => folderHref(opts.mailbox, id), folderLabels(opts.shell))
          .map((item) => {
            const badge = item.id === "inbox" ? countBadge : "";
            return `<li><a class="${item.active ? "active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}${badge}</a></li>`;
          })
          .join("")}
        <li><a class="${opts.nav === "unread" ? "active" : ""}" href="${escapeHtml(unreadHref)}">${escapeHtml(tr(opts.shell, "nav.unread"))}</a></li>
      </ul>
      <ul class="nav-list nav-tools">
        <li><a class="${opts.nav === "compose" ? "active" : ""}" href="${escapeHtml(compose)}">${escapeHtml(tr(opts.shell, "nav.compose"))}</a></li>
        <li><a class="${opts.nav === "addresses" ? "active" : ""}" href="/addresses">${escapeHtml(tr(opts.shell, "nav.addresses"))}</a></li>
        <li><a class="${opts.nav === "admin" ? "active" : ""}" href="/admin">${escapeHtml(tr(opts.shell, "nav.admin"))}</a></li>
        <li><a class="${opts.nav === "settings" ? "active" : ""}" href="${escapeHtml(settings)}">${escapeHtml(tr(opts.shell, "nav.settings"))}</a></li>
      </ul>
      ${chip}
    </aside>
    ${opts.body}
  </div>
  <nav class="mobile-nav" aria-label="${escapeHtml(tr(opts.shell, "nav.main"))}">
    <a class="${(SYSTEM_FOLDERS as readonly string[]).includes(opts.nav) ? "active" : ""}" href="${escapeHtml(inbox)}">${escapeHtml(tr(opts.shell, "nav.inbox"))}${countBadge}</a>
    <a class="${opts.nav === "unread" ? "active" : ""}" href="${escapeHtml(unreadHref)}">${escapeHtml(tr(opts.shell, "nav.unread"))}</a>
    <a class="${opts.nav === "compose" ? "active" : ""}" href="${escapeHtml(compose)}">${escapeHtml(tr(opts.shell, "nav.compose"))}</a>
    <a class="${opts.nav === "settings" ? "active" : ""}" href="${escapeHtml(settings)}">${escapeHtml(tr(opts.shell, "nav.settings"))}</a>
  </nav>
</body>
</html>`;
}
