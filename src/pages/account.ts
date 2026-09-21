import type { MailboxAliasRecord } from "../aliases.ts";
import { renderAliasPanelHtml } from "../aliases.ts";
import type { ApiTokenRecord } from "../api-tokens.ts";
import type { MailboxActor } from "../auth.ts";
import { layeredBannerHtml, pageErrorBanner, type PageError } from "../error-banner.ts";
import { EMPTY_ART, escapeHtml, formatReceived } from "../html.ts";
import type { MailboxRecord } from "../store.ts";
import { boxPath, inboxHref } from "../ui-paths.ts";
import { brandLink, documentLang, emptyBlock, layout, pageTitle, tr, type NavId, type Shell } from "../view.ts";
import type { InboundDeliveryRecord, PublicHookConfig } from "../webhooks.ts";

export function renderAddressesPage(
  shell: Shell,
  mailboxes: MailboxRecord[],
  nav: NavId,
  unreadCount = 0,
  error: PageError = null,
): string {
  const current = mailboxes[0] ?? null;
  const banner = pageErrorBanner(shell.locale, error);
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
    content = `${emptyBlock(tr(shell, "empty.addresses"), "brand", tr(shell, "empty.addresses-alt"))}${form}`;
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

export function renderSettingsPage(
  owner: MailboxActor,
  mailbox: MailboxRecord | null,
  hook: PublicHookConfig | null,
  deliveries: InboundDeliveryRecord[],
  aliases: MailboxAliasRecord[],
  tokens: ApiTokenRecord[],
  unreadCount: number,
  shell: Shell,
  error: PageError,
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
    banners.push(pageErrorBanner(shell.locale, error));
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
          const status = row.status === "sent"
            ? "已送达"
            : row.status === "pending"
              ? `待重试 · ${row.error || "pending"}`
              : `失败 · ${row.error || "downstream_failed"}`;
          const attempts = `${row.attempt_count ?? 0}/${row.max_attempts ?? 5}`;
          const next = row.status === "pending" && row.next_attempt_at
            ? `下次 ${formatReceived(row.next_attempt_at)}`
            : "";
          return `<li class="attempt${row.status === "failed" || row.status === "pending" ? " selected" : ""}">
            <div class="attempt-top">
              <span class="attempt-status ${row.status}">${escapeHtml(status)}</span>
              <time>${escapeHtml(formatReceived(row.created_at))}</time>
            </div>
            <div>种类 ${escapeHtml(row.kind === "webhook" ? "webhook" : "转发")}</div>
            <div>目标 <span class="mono">${escapeHtml(row.target)}</span></div>
            <div>尝试 ${escapeHtml(attempts)}${next ? ` · ${escapeHtml(next)}` : ""}</div>
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
        ${renderApiKeyPanel(shell, tokens)}
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

export function renderLoginPage(shell: Shell, error: string, hint: string): string {
  const sessionBanner = error.trim()
    ? layeredBannerHtml({
        locale: shell.locale,
        message: tr(shell, "error.session"),
        code: error,
        detail: hint,
      })
    : "";
  const failCopy = JSON.stringify(tr(shell, "login.fail"));
  const networkCopy = JSON.stringify(tr(shell, "login.network"));
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
        ${sessionBanner}
        <form id="login-form" class="login-form">
          <label>${escapeHtml(tr(shell, "login.address"))}
            <input name="address" class="search" type="email" autocomplete="username" value="inbox@example.test" required>
          </label>
          <label>${escapeHtml(tr(shell, "login.passphrase"))}
            <input name="token" class="search" type="password" autocomplete="current-password" required>
          </label>
          <p class="banner">${escapeHtml(tr(shell, "login.hint"))}</p>
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
            err.textContent = result.body.hint || ${failCopy};
            err.hidden = false;
          })
          .catch(function () {
            err.textContent = ${networkCopy};
            err.hidden = false;
          });
      });
    })();
  </script>
</body>
</html>`;
}

function renderApiKeyPanel(shell: Shell, tokens: ApiTokenRecord[]): string {
  const active = tokens.filter((row) => !row.revoked_at);
  if (active.length === 0) {
    return "";
  }
  const items = active
    .map((row) => {
      const label = row.label?.trim() ? row.label : row.token_prefix;
      return `<li>
        <span class="name">${escapeHtml(label)}</span>
        <span class="mono">${escapeHtml(row.token_prefix)}…</span>
      </li>`;
    })
    .join("");
  return `<section id="api-key" class="grove-panel">
          <h2>${escapeHtml(tr(shell, "nav.api-key"))}</h2>
          <p class="banner">${escapeHtml(tr(shell, "banner.api-key-hint"))}</p>
          <ul class="addr-list">${items}</ul>
        </section>`;
}

export function renderForbidden(shell: Shell, mailbox: MailboxRecord | null, unreadCount = 0): string {
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

export function renderNotFound(shell: Shell, mailbox: MailboxRecord | null = null, unreadCount = 0): string {
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

