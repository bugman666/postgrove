import type { Env } from "./env";
import { html, redirect } from "./http";
import { EMPTY_ART, GROVE_MARK, escapeHtml, formatReceived } from "./html";
import {
  defaultMailbox,
  getInboxMessage,
  getMailbox,
  listInboxMessages,
  listMailboxes,
  markRead,
  trashMessage,
  type MailboxRecord,
  type MessageRecord,
} from "./store";

type NavId = "inbox" | "compose" | "addresses" | "settings";

export async function handleUi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/") {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const wanted = url.searchParams.get("mailbox");
    const mailbox = wanted ? await getMailbox(env, wanted) : await defaultMailbox(env);
    if (!mailbox) {
      return html(renderAddressesPage([], "inbox"), 200);
    }
    return redirect(boxPath(mailbox.id));
  }

  if (path === "/compose") {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const mailbox = await mailboxFromQuery(env, url);
    return html(renderStubPage("compose", "写信", mailbox, [
      "写信尚未接通。出站发送在后续交付。",
      "你现在可以读和删除已收到的信。",
    ]));
  }

  if (path === "/addresses") {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const mailboxes = await listMailboxes(env);
    return html(renderAddressesPage(mailboxes, "addresses"));
  }

  if (path === "/settings") {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const mailbox = await mailboxFromQuery(env, url);
    return html(renderStubPage("settings", "设置", mailbox, [
      "登录与权限是后续工作。本地开发可直接打开已种子的邮箱。",
      "还没收到信？确认 Email Routing 已指向本 Worker。",
    ]));
  }

  const deleteMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)\/delete$/);
  if (deleteMatch) {
    if (method !== "POST") {
      return pageMethodNotAllowed();
    }
    const mailbox = await getMailbox(env, decodeURIComponent(deleteMatch[1]));
    if (!mailbox) {
      return html(renderNotFound(), 404);
    }
    const messageId = decodeURIComponent(deleteMatch[2]);
    await trashMessage(env, mailbox.id, messageId);
    return redirect(`${boxPath(mailbox.id)}?deleted=1`);
  }

  const readMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)$/);
  if (readMatch) {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const mailbox = await getMailbox(env, decodeURIComponent(readMatch[1]));
    if (!mailbox) {
      return html(renderNotFound(), 404);
    }
    const messageId = decodeURIComponent(readMatch[2]);
    const existing = await getInboxMessage(env, mailbox.id, messageId);
    if (!existing) {
      return html(renderNotFound(mailbox), 404);
    }
    if (existing.is_read !== 1) {
      await markRead(env, mailbox.id, existing.id);
    }
    const message = (await getInboxMessage(env, mailbox.id, existing.id)) ?? existing;
    const messages = await listInboxMessages(env, mailbox.id);
    const showReply = url.searchParams.get("reply") === "1";
    return html(renderInboxPage(mailbox, messages, message, { showReply }));
  }

  const boxMatch = path.match(/^\/box\/([^/]+)$/);
  if (boxMatch) {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const mailbox = await getMailbox(env, decodeURIComponent(boxMatch[1]));
    if (!mailbox) {
      return html(renderNotFound(), 404);
    }
    const messages = await listInboxMessages(env, mailbox.id);
    return html(
      renderInboxPage(mailbox, messages, null, {
        deleted: url.searchParams.get("deleted") === "1",
      }),
    );
  }

  return html(renderNotFound(), 404);
}

async function mailboxFromQuery(env: Env, url: URL): Promise<MailboxRecord | null> {
  const wanted = url.searchParams.get("mailbox");
  if (wanted) {
    return getMailbox(env, wanted);
  }
  return defaultMailbox(env);
}

function pageMethodNotAllowed(): Response {
  return html(renderNotFound(), 405);
}

function boxPath(mailboxId: string): string {
  return `/box/${encodeURIComponent(mailboxId)}`;
}

function messagePath(mailboxId: string, messageId: string): string {
  return `${boxPath(mailboxId)}/m/${encodeURIComponent(messageId)}`;
}

function inboxHref(mailbox: MailboxRecord | null): string {
  return mailbox ? boxPath(mailbox.id) : "/";
}

function withMailbox(path: string, mailbox: MailboxRecord | null): string {
  if (!mailbox) {
    return path;
  }
  return `${path}?mailbox=${encodeURIComponent(mailbox.id)}`;
}

function renderInboxPage(
  mailbox: MailboxRecord,
  messages: MessageRecord[],
  selected: MessageRecord | null,
  flags: { showReply?: boolean; deleted?: boolean },
): string {
  const list = messages.length === 0
    ? emptyBlock("还没有信。域名路由配好后，寄一封到你的地址试试。")
    : `<ul class="msg-list">${messages.map((row) => messageRow(mailbox, row, selected?.id)).join("")}</ul>`;

  let reading: string;
  if (selected) {
    reading = renderReading(mailbox, selected, Boolean(flags.showReply));
  } else {
    const banner = flags.deleted
      ? `<p class="banner">已移出收件箱。</p>`
      : "";
    reading = `${banner}<div class="read-inner"><p class="empty">从左侧选一封，或点「写信」。</p></div>`;
  }

  return layout({
    title: selected?.subject ? `${selected.subject} · Postgrove` : "收件箱 · Postgrove",
    nav: "inbox",
    mailbox,
    mode: selected ? "read" : "list",
    simple: false,
    body: `<section class="list">
      <div class="list-head">
        <h1>收件箱</h1>
        <input class="search" type="search" placeholder="即将推出" disabled>
      </div>
      ${list}
    </section>
    <main class="read">${reading}</main>`,
  });
}

function messageRow(
  mailbox: MailboxRecord,
  row: MessageRecord,
  selectedId: string | undefined,
): string {
  const unread = row.is_read !== 1;
  const selected = row.id === selectedId ? " selected" : "";
  const unreadClass = unread ? " unread" : "";
  const subject = row.subject?.trim() ? row.subject : "（无主题）";
  const snippet = row.snippet?.trim() ?? "";
  const dot = unread
    ? `<span class="unread-dot" title="未读"></span>`
    : "";
  return `<li>
    <a class="msg${unreadClass}${selected}" href="${escapeHtml(messagePath(mailbox.id, row.id))}">
      <div class="msg-top">
        <span class="from">${dot}${escapeHtml(row.envelope_from)}</span>
        <time class="time" datetime="${escapeHtml(new Date(row.received_at).toISOString())}">${escapeHtml(formatReceived(row.received_at))}</time>
      </div>
      <div class="subject">${escapeHtml(subject)}</div>
      <p class="snippet">${escapeHtml(snippet)}</p>
    </a>
  </li>`;
}

function renderReading(
  mailbox: MailboxRecord,
  message: MessageRecord,
  showReply: boolean,
): string {
  const subject = message.subject?.trim() ? message.subject : "（无主题）";
  const body = message.body_text?.trim()
    ? escapeHtml(message.body_text)
    : "（没有正文）";
  const replyHref = `${messagePath(mailbox.id, message.id)}?reply=1`;
  const replyBanner = showReply
    ? `<p class="banner reply" id="reply-stub">回复能力将在下一阶段开放；你仍可以新建写信。</p>`
    : `<p class="banner reply" id="reply-stub" hidden>回复能力将在下一阶段开放；你仍可以新建写信。</p>`;

  return `<div class="read-inner">
    <a class="back" href="${escapeHtml(boxPath(mailbox.id))}">← 收件箱</a>
    <article class="read-card">
      <header class="read-head">
        <h1>${escapeHtml(subject)}</h1>
      </header>
      <div class="meta">
        <div>发件人 <span class="mono">${escapeHtml(message.envelope_from)}</span></div>
        <div>收件人 <span class="mono">${escapeHtml(message.envelope_to)}</span></div>
        <div>时间 ${escapeHtml(formatReceived(message.received_at))}</div>
      </div>
      <div class="actions">
        <a class="btn btn-primary" id="reply-btn" href="${escapeHtml(replyHref)}">回复</a>
        <form method="post" action="${escapeHtml(`${messagePath(mailbox.id, message.id)}/delete`)}" onsubmit="return confirm('删除后这封信会离开收件箱。确定删除？');">
          <button class="btn btn-danger" type="submit">删除</button>
        </form>
      </div>
      ${replyBanner}
      <pre class="body">${body}</pre>
    </article>
  </div>
  <script>
    (function () {
      var btn = document.getElementById("reply-btn");
      var stub = document.getElementById("reply-stub");
      if (!btn || !stub) return;
      btn.addEventListener("click", function (event) {
        event.preventDefault();
        stub.hidden = false;
      });
    })();
  </script>`;
}

function renderAddressesPage(mailboxes: MailboxRecord[], nav: NavId): string {
  const current = mailboxes[0] ?? null;
  let content: string;
  if (mailboxes.length === 0) {
    content = `${emptyBlock("还没有地址。创建一个，例如 you@yourdomain。")}
      <p class="banner">创建地址尚未接通。</p>`;
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
      .join("")}</ul>`;
  }
  return layout({
    title: "地址 · Postgrove",
    nav,
    mailbox: current,
    mode: "list",
    simple: true,
    body: `<main class="page"><div class="page-inner">
      <div class="page-head"><h1>地址</h1></div>
      <div class="page-card">${content}</div>
    </div></main>`,
  });
}

function renderStubPage(
  nav: NavId,
  heading: string,
  mailbox: MailboxRecord | null,
  notes: string[],
): string {
  const banners = notes.map((note) => `<p class="banner">${escapeHtml(note)}</p>`).join("");
  return layout({
    title: `${heading} · Postgrove`,
    nav,
    mailbox,
    mode: "list",
    simple: true,
    body: `<main class="page"><div class="page-inner">
      <div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
      <div class="page-card">${banners}</div>
    </div></main>`,
  });
}

function renderNotFound(mailbox: MailboxRecord | null = null): string {
  return layout({
    title: "未找到 · Postgrove",
    nav: "inbox",
    mailbox,
    mode: "list",
    simple: true,
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
}): string {
  const inbox = inboxHref(opts.mailbox);
  const compose = withMailbox("/compose", opts.mailbox);
  const settings = withMailbox("/settings", opts.mailbox);
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
        <li><a class="${opts.nav === "inbox" ? "active" : ""}" href="${escapeHtml(inbox)}">收件箱</a></li>
        <li><a class="${opts.nav === "compose" ? "active" : ""}" href="${escapeHtml(compose)}">写信</a></li>
        <li><a class="${opts.nav === "addresses" ? "active" : ""}" href="/addresses">地址</a></li>
        <li><a class="${opts.nav === "settings" ? "active" : ""}" href="${escapeHtml(settings)}">设置</a></li>
      </ul>
      ${chip}
    </aside>
    ${opts.body}
  </div>
  <nav class="mobile-nav" aria-label="主导航">
    <a class="${opts.nav === "inbox" ? "active" : ""}" href="${escapeHtml(inbox)}">收件箱</a>
    <a class="${opts.nav === "compose" ? "active" : ""}" href="${escapeHtml(compose)}">写信</a>
    <a class="${opts.nav === "addresses" ? "active" : ""}" href="/addresses">地址</a>
    <a class="${opts.nav === "settings" ? "active" : ""}" href="${escapeHtml(settings)}">设置</a>
  </nav>
</body>
</html>`;
}
