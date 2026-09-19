import type { AttachmentRecord } from "../attachments.ts";
import { renderAttachmentsHtml } from "../attachments.ts";
import { FOLDER_LABELS, type SystemFolder } from "../folders.ts";
import { escapeHtml, formatReceived } from "../html.ts";
import { folderEmptyKey, folderLabelKey } from "../i18n.ts";
import type { MailboxRecord, MessageRecord } from "../store.ts";
import {
  findThreadForMessage,
  groupMessagesByStoredThreadId,
  latestThreadMessage,
  threadHasUnread,
  type MessageThread,
} from "../threads.ts";
import type { InboxFilter } from "../triage.ts";
import {
  boxPath,
  composeHref,
  messageHref,
  messagePath,
  threadHref,
  viewHref,
} from "../ui-paths.ts";
import { emptyBlock, layout, pageTitle, tr, type Shell } from "../view.ts";

export function attachmentsForMessage(
  attachments: AttachmentRecord[],
  messageId: string,
): AttachmentRecord[] {
  return attachments.filter((row) => row.message_id === messageId);
}

export function renderInboxPage(
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
  const threads = groupMessagesByStoredThreadId(messages);
  const selectedThread = flags.thread
    ?? (selected ? findThreadForMessage(threads, selected.id) : null);
  const emptyCopy = emptyInboxCopy(shell, messages.length, q, filter);
  const list = messages.length === 0
    ? emptyBlock(emptyCopy, inboxEmptyArt(q, filter), inboxEmptyAlt(shell, q, filter))
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

export function renderFolderPage(
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
      </div>
      ${list}
    </section>
    <main class="read">${reading}</main>`,
  });
}

export function inboxEmptyArt(q: string, filter: InboxFilter): "brand" | "mark" | "none" {
  if (q) {
    return "none";
  }
  if (filter === "all") {
    return "brand";
  }
  return "mark";
}

export function inboxEmptyAlt(shell: Shell, q: string, filter: InboxFilter): string {
  if (q || filter !== "all") {
    return "";
  }
  return tr(shell, "empty.inbox-alt");
}

export function folderMessageRow(
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

export function emptyInboxCopy(shell: Shell, count: number, q: string, filter: InboxFilter): string {
  if (count > 0) {
    return "";
  }
  if (q) {
    return tr(shell, "empty.search");
  }
  if (filter === "unread") {
    return tr(shell, "empty.unread");
  }
  if (filter === "starred") {
    return tr(shell, "empty.starred");
  }
  return tr(shell, "empty.inbox");
}

export function threadRow(
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

export function renderReading(
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

export function renderThreadReading(
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

export function renderReadArticle(
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

export function moveForm(
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

