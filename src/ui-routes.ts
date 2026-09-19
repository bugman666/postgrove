import type { Env } from "./env.ts";
import { listAttachmentsForMessages } from "./attachments.ts";
import {
  AliasInputError,
  createAlias,
  generateAlias,
  listAliases,
  type MailboxAliasRecord,
} from "./aliases.ts";
import { actorUserId, requireOwner, type MailboxActor } from "./auth.ts";
import { parseDraftFields, parseFolder } from "./folders.ts";
import { html, redirect } from "./http.ts";
import { parseLocalePreference, withLocaleCookie } from "./i18n.ts";
import { checkAddressQuota } from "./quotas.ts";
import {
  buildComposePrefill,
  parseComposeMode,
  type ComposePrefill,
} from "./reply.ts";
import { parseSendFields, sendOutbound } from "./send.ts";
import {
  countUnreadInbox,
  createMailbox,
  getMailbox,
  getMailboxMessage,
  getOutboundAttempt,
  insertDraft,
  listFolderMessages,
  listInboxMessageHeads,
  listMailboxesForUser,
  listOutboundAttempts,
  MailboxInputError,
  markReadMany,
  moveMessage,
  setRead,
  setStarred,
  trashMessage,
  updateDraft,
  type MailboxRecord,
} from "./store.ts";
import { bindUserMailbox, getUser, mailboxAllowed } from "./users.ts";
import { resolveShell, type Shell } from "./view.ts";
import { latestThreadMessage } from "./threads.ts";
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
import { openInboxMessageForRead, openThreadForRead } from "./inbox-read.ts";
import {
  renderAddressesPage,
  renderForbidden,
  renderLoginPage,
  renderNotFound,
  renderSettingsPage,
} from "./pages/account.ts";
import {
  emptyComposeForm,
  formFromDraft,
  formFromPrefill,
  renderComposePage,
  type ComposeForm,
} from "./pages/compose.ts";
import { renderFolderPage, renderInboxPage } from "./pages/inbox.ts";
import {
  boxPath,
  composeHref,
  inboxQuery,
  messagePath,
  readInboxView,
  safeNext,
  withMailbox,
} from "./ui-paths.ts";

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
    const opened = await openThreadForRead(env, mailbox.id, threadId, view);
    if (!opened.visible || !opened.thread) {
      return html(renderNotFound(shell, mailbox, unreadCount), 404);
    }
    unreadCount = await countUnreadInbox(env, mailbox.id);
    return html(renderInboxPage(mailbox, opened.listed, latestThreadMessage(opened.thread), {
      attachments: opened.attachments,
      thread: opened.thread,
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
    const markedUnread = existing.folder === "inbox" && existing.is_read !== 1;
    if (markedUnread) {
      await markReadMany(env, mailbox.id, [existing.id]);
    }
    if (url.searchParams.get("reply") === "1") {
      return redirect(composeHref(mailbox, "reply", existing.id));
    }
    unreadCount = await countUnreadInbox(env, mailbox.id);
    const folder = parseFolder(existing.folder);
    const view = readInboxView(url);
    if (folder === "inbox") {
      const opened = await openInboxMessageForRead(env, mailbox.id, existing, view, markedUnread);
      return html(renderInboxPage(mailbox, opened.listed, opened.message, {
        attachments: opened.attachments,
        thread: opened.thread,
        unreadCount,
        shell,
        ...view,
      }));
    }
    const messages = await listFolderMessages(env, mailbox.id, folder);
    const attachments = await listAttachmentsForMessages(env, mailbox.id, [existing.id]);
    return html(renderFolderPage(mailbox, folder, messages, existing, {
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
      const messages = await listInboxMessageHeads(env, mailbox.id, view);
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

function pageMethodNotAllowed(shell: Shell): Response {
  return html(renderNotFound(shell), 405);
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
