import type { Env } from "./env";
import {
  listMessageAttachments,
  renderAttachmentsHtml,
  type AttachmentRecord,
} from "./attachments";
import { requireOwner, type OwnerPrincipal } from "./auth";
import { html, redirect } from "./http";
import { EMPTY_ART, GROVE_MARK, escapeHtml, formatReceived } from "./html";
import { describeOutbound } from "./outbound";
import { parseSendFields, sendOutbound } from "./send";
import {
  getInboxMessage,
  getMailbox,
  getOutboundAttempt,
  listInboxMessages,
  listOutboundAttempts,
  markRead,
  trashMessage,
  type MailboxRecord,
  type MessageRecord,
  type OutboundAttemptRecord,
} from "./store";

type NavId = "inbox" | "compose" | "addresses" | "settings";

interface ComposeForm {
  to: string;
  subject: string;
  body: string;
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

  const owner = gate.principal;
  const path = url.pathname;
  const method = request.method;
  const ownMailbox = await getMailbox(env, owner.mailboxId);

  if (path === "/") {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    if (!ownMailbox) {
      return html(renderAddressesPage([], "inbox"), 200);
    }
    return redirect(boxPath(ownMailbox.id));
  }

  if (path === "/compose") {
    if (method === "POST") {
      return handleComposeSubmit(request, env, url, owner, ownMailbox);
    }
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    return renderCompose(env, url, ownMailbox);
  }

  if (path === "/addresses") {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    return html(renderAddressesPage(ownMailbox ? [ownMailbox] : [], "addresses"));
  }

  if (path === "/settings") {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    return html(renderStubPage("settings", "设置", ownMailbox, [
      "会话绑在你登录的地址上。登出后需要再次 POST /auth/login。",
      "还没收到信？确认 Email Routing 已指向本 Worker。",
      describeOutbound(env).hint,
      "入站附件存在 R2。单文件上限见 ATTACHMENT_MAX_BYTES（默认 10 MB），数量上限见 ATTACHMENT_MAX_COUNT（默认 10）。出站写信带附件是后续工作。",
    ], true));
  }

  const deleteMatch = path.match(/^\/box\/([^/]+)\/m\/([^/]+)\/delete$/);
  if (deleteMatch) {
    if (method !== "POST") {
      return pageMethodNotAllowed();
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(deleteMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox);
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
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(readMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox);
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
    const attachments = await listMessageAttachments(env, mailbox.id, message.id);
    const showReply = url.searchParams.get("reply") === "1";
    return html(renderInboxPage(mailbox, messages, message, { showReply, attachments }));
  }

  const boxMatch = path.match(/^\/box\/([^/]+)$/);
  if (boxMatch) {
    if (method !== "GET") {
      return pageMethodNotAllowed();
    }
    const mailbox = await allowedMailbox(env, owner, decodeURIComponent(boxMatch[1]));
    if (!mailbox) {
      return forbiddenOrMissing(ownMailbox);
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

async function allowedMailbox(
  env: Env,
  owner: OwnerPrincipal,
  idOrAddress: string,
): Promise<MailboxRecord | null> {
  const mailbox = await getMailbox(env, idOrAddress);
  if (!mailbox) {
    return null;
  }
  if (mailbox.id !== owner.mailboxId && mailbox.address !== owner.address) {
    return null;
  }
  return mailbox;
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

function forbiddenOrMissing(ownMailbox: MailboxRecord | null): Response {
  return html(renderForbidden(ownMailbox), ownMailbox ? 403 : 404);
}

async function handleComposeSubmit(
  request: Request,
  env: Env,
  url: URL,
  owner: OwnerPrincipal,
  ownMailbox: MailboxRecord | null,
): Promise<Response> {
  if (!ownMailbox) {
    return html(
      renderComposePage(env, ownMailbox, {
        form: emptyComposeForm(),
        formError: "没有可用地址。先确认本地已经 migrate 并且 seed，再 POST /auth/login。",
        attempts: [],
      }),
      404,
    );
  }
  if (ownMailbox.id !== owner.mailboxId && ownMailbox.address !== owner.address) {
    return forbiddenOrMissing(ownMailbox);
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
        }),
        400,
      );
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    form = {
      to: typeof record.to === "string" ? record.to : "",
      subject: typeof record.subject === "string" ? record.subject : "",
      body: typeof record.text === "string" ? record.text : typeof record.body === "string" ? record.body : "",
    };
  } else {
    const data = await request.formData();
    form = {
      to: stringField(data.get("to")),
      subject: stringField(data.get("subject")),
      body: stringField(data.get("body")),
    };
  }

  const parsed = parseSendFields({ to: form.to, subject: form.subject, text: form.body });
  if (!parsed.ok) {
    return html(
      renderComposePage(env, ownMailbox, {
        form,
        formError: parsed.hint,
        attempts: await listOutboundAttempts(env, ownMailbox.id),
      }),
      400,
    );
  }

  const outcome = await sendOutbound(env, ownMailbox, parsed.input);
  const next = new URL(withMailbox("/compose", ownMailbox), url.origin);
  next.searchParams.set("attempt", outcome.attempt.id);
  return redirect(`${next.pathname}${next.search}`);
}

async function renderCompose(
  env: Env,
  url: URL,
  mailbox: MailboxRecord | null,
): Promise<Response> {
  const attempts = mailbox ? await listOutboundAttempts(env, mailbox.id) : [];
  const attemptId = url.searchParams.get("attempt");
  const highlighted =
    mailbox && attemptId ? await getOutboundAttempt(env, mailbox.id, attemptId) : null;
  return html(
    renderComposePage(env, mailbox, {
      form: emptyComposeForm(),
      highlighted,
      attempts,
    }),
  );
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function emptyComposeForm(): ComposeForm {
  return { to: "", subject: "", body: "" };
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
  flags: { showReply?: boolean; deleted?: boolean; attachments?: AttachmentRecord[] },
): string {
  const list = messages.length === 0
    ? emptyBlock("还没有信。域名路由配好后，寄一封到你的地址试试。")
    : `<ul class="msg-list">${messages.map((row) => messageRow(mailbox, row, selected?.id)).join("")}</ul>`;

  let reading: string;
  if (selected) {
    reading = renderReading(
      mailbox,
      selected,
      Boolean(flags.showReply),
      flags.attachments ?? [],
    );
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
  attachments: AttachmentRecord[] = [],
): string {
  const subject = message.subject?.trim() ? message.subject : "（无主题）";
  const body = message.body_text?.trim()
    ? escapeHtml(message.body_text)
    : "（没有正文）";
  const replyHref = `${messagePath(mailbox.id, message.id)}?reply=1`;
  const composeHref = withMailbox("/compose", mailbox);
  const replyBanner = showReply
    ? `<p class="banner reply">回复能力将在下一阶段开放；你仍可以<a href="${escapeHtml(composeHref)}">新建写信</a>。</p>`
    : "";

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
        <a class="btn btn-primary" href="${escapeHtml(replyHref)}">回复</a>
        <form method="post" action="${escapeHtml(`${messagePath(mailbox.id, message.id)}/delete`)}" onsubmit="return confirm('删除后这封信会离开收件箱。确定删除？');">
          <button class="btn btn-danger" type="submit">删除</button>
        </form>
      </div>
      ${replyBanner}
      ${renderAttachmentsHtml(attachments)}
      <pre class="body">${body}</pre>
    </article>
  </div>`;
}

function renderComposePage(
  env: Env,
  mailbox: MailboxRecord | null,
  opts: {
    form: ComposeForm;
    formError?: string;
    highlighted?: OutboundAttemptRecord | null;
    attempts: OutboundAttemptRecord[];
  },
): string {
  const outbound = describeOutbound(env);
  const banners: string[] = [];
  if (opts.highlighted) {
    banners.push(attemptBanner(opts.highlighted));
  }
  if (opts.formError) {
    banners.push(
      `<p class="banner danger">${escapeHtml(opts.formError)}</p>`,
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

  const disabled = mailbox ? "" : " disabled";
  const form = `<form id="compose-form" class="compose-form" method="post" action="${escapeHtml(withMailbox("/compose", mailbox))}">
      ${fromLine}
      <label>收件人
        <input class="search compose-input" name="to" type="email" autocomplete="email" required value="${escapeHtml(opts.form.to)}"${disabled}>
      </label>
      <label>主题
        <input class="search compose-input" name="subject" type="text" maxlength="998" value="${escapeHtml(opts.form.subject)}"${disabled}>
      </label>
      <label>正文
        <textarea class="compose-body" name="body" rows="14"${disabled}>${escapeHtml(opts.form.body)}</textarea>
      </label>
      <button class="btn btn-primary" type="submit"${disabled}>发送</button>
    </form>
    <script>
      (function () {
        var form = document.getElementById("compose-form");
        if (!form) return;
        form.addEventListener("submit", function () {
          var btn = form.querySelector("button[type=submit]");
          if (btn) {
            btn.disabled = true;
            btn.textContent = "正在发送…";
          }
        });
      })();
    </script>`;

  const history = renderAttemptHistory(opts.attempts, opts.highlighted?.id ?? null);

  return layout({
    title: "写信 · Postgrove",
    nav: "compose",
    mailbox,
    mode: "list",
    simple: true,
    body: `<main class="page"><div class="page-inner">
      <div class="page-head"><h1>写信</h1></div>
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
        <div>主题 ${escapeHtml(subject)}</div>
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
  showLogout = false,
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

function renderForbidden(mailbox: MailboxRecord | null): string {
  return layout({
    title: "无权查看 · Postgrove",
    nav: "inbox",
    mailbox,
    mode: "list",
    simple: true,
    body: `<main class="page"><div class="page-inner">
      <div class="page-card">
        <h1>无权查看这个地址</h1>
        <p class="banner">This session is bound to another mailbox. POST /auth/login with that address.</p>
        <p><a href="${escapeHtml(inboxHref(mailbox))}">返回收件箱</a></p>
      </div>
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
