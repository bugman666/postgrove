import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_INBOX_SRC } from "../src/brand-assets.ts";
import { errorScene, humanErrorMessage, layeredBannerHtml } from "../src/error-banner.ts";
import { t } from "../src/i18n.ts";
import { emptyInboxCopy, inboxEmptyArt, renderInboxPage } from "../src/pages/inbox.ts";
import { attemptBanner } from "../src/pages/compose.ts";
import { renderAddressesPage, renderLoginPage } from "../src/pages/account.ts";
import type { MailboxRecord, OutboundAttemptRecord } from "../src/store.ts";
import { emptyNav, layout, type Shell } from "../src/view.ts";

const MAILBOX: MailboxRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "you@yourdomain",
  local_part: "you",
  domain: "yourdomain",
  display_name: "You",
  status: "active",
};

function shell(overrides: Partial<Shell> = {}): Shell {
  return {
    locale: "zh",
    preference: "zh",
    brand: { site_title: "Postgrove", logo_url: null, accent: "#1B4332" },
    nav: emptyNav(),
    ...overrides,
  };
}

function failedAttempt(error: string, hint: string): OutboundAttemptRecord {
  return {
    id: "att-1",
    mailbox_id: MAILBOX.id,
    from_address: MAILBOX.address,
    to_address: "neighbor@example.test",
    cc_address: null,
    subject: "hi",
    body_text: "hi",
    in_reply_to: null,
    references_header: null,
    provider: "http",
    provider_message_id: null,
    status: "failed",
    error,
    hint,
    created_at: 1,
    idempotency_key: "k1",
    attempt_count: 1,
    max_attempts: 3,
    last_attempt_at: 1,
    sent_message_id: null,
    updated_at: 1,
  };
}

test("empty-state copy matches #53 en/zh", () => {
  assert.equal(t("zh", "empty.inbox"), "还没有信。域名路由配好后，寄一封到你的地址试试。");
  assert.equal(t("en", "empty.inbox"), "No mail yet. After routing is set, send a message to your address.");
  assert.equal(t("zh", "empty.addresses"), "还没有地址。创建一个，例如 you@yourdomain。");
  assert.equal(t("en", "empty.addresses"), "No addresses yet. Create one, e.g. you@yourdomain.");
  assert.equal(t("zh", "empty.search"), "没有匹配的信。换个词试试。");
  assert.equal(t("en", "empty.search"), "No matching messages. Try another search.");
  assert.equal(t("zh", "empty.pick"), "从左侧选一封，或点「写信」。");
  assert.equal(t("en", "empty.pick"), "Pick a message, or compose a new one.");
  assert.equal(emptyInboxCopy(shell(), 0, "", "all"), t("zh", "empty.inbox"));
  assert.equal(emptyInboxCopy(shell({ locale: "en" }), 0, "invoice", "all"), t("en", "empty.search"));
  assert.equal(inboxEmptyArt("", "all"), "brand");
  assert.equal(inboxEmptyArt("invoice", "all"), "none");
  assert.equal(EMPTY_INBOX_SRC, "/assets/pg-empty-inbox.jpg");
});

test("empty inbox uses brand art with short alt; search has copy only", () => {
  const inbox = renderInboxPage(MAILBOX, [], null, {
    unreadCount: 0,
    q: "",
    filter: "all",
    shell: shell(),
  });
  assert.match(inbox, /还没有信。域名路由配好后，寄一封到你的地址试试。/);
  assert.match(inbox, /src="\/assets\/pg-empty-inbox\.jpg"/);
  assert.match(inbox, /alt="空收件箱"/);
  assert.match(inbox, /onerror="this\.remove\(\)"/);

  const search = renderInboxPage(MAILBOX, [], null, {
    unreadCount: 0,
    q: "no-such-letter",
    filter: "all",
    shell: shell(),
  });
  assert.match(search, /没有匹配的信。换个词试试。/);
  assert.doesNotMatch(search, /empty-photo/);
  assert.match(search, /从左侧选一封，或点「写信」。/);

  const addresses = renderAddressesPage(shell(), [], "addresses");
  assert.match(addresses, /还没有地址。创建一个，例如 you@yourdomain。/);
  assert.match(addresses, /empty-photo/);
  assert.match(addresses, /alt="空地址"/);
});

test("layered banners keep codes under Details", () => {
  assert.equal(errorScene("unauthorized"), "session");
  assert.equal(errorScene("outbound_not_configured"), "outbound_unset");
  assert.equal(errorScene("outbound_failed"), "send_failed");
  assert.equal(errorScene("quota_send"), "quota_full");
  assert.equal(errorScene("attachment_too_large"), "attach_over");
  assert.equal(errorScene("blocked_destination"), "webhook_blocked");
  assert.equal(humanErrorMessage("zh", "unauthorized"), "登录已失效。重新登录后再继续。");
  assert.equal(humanErrorMessage("zh", "outbound_not_configured"), "还不能发信。在设置里接上出站提供商后再试。");
  assert.equal(humanErrorMessage("zh", "outbound_failed"), "没发出去。检查出站配置或稍后重试。");
  assert.equal(humanErrorMessage("zh", "quota_send"), "发不出去：已达今日发送上限。");
  assert.equal(humanErrorMessage("zh", "attachment_too_large", { n: 10 }), "附件太大（上限 10 MB）。去掉大文件或压缩后再试。");
  assert.equal(humanErrorMessage("zh", "blocked_destination"), "这个地址不能用（内网或受限目标）。换一个公网 https 地址。");

  const banner = layeredBannerHtml({
    locale: "zh",
    tone: "danger",
    message: humanErrorMessage("zh", "outbound_failed"),
    code: "outbound_failed",
    detail: "Resend rejected the From domain.",
  });
  assert.match(banner, /<p class="banner-lead">没发出去。检查出站配置或稍后重试。<\/p>/);
  assert.match(banner, /<details class="banner-details">/);
  assert.match(banner, /<code class="mono">outbound_failed<\/code>/);
  const lead = banner.slice(0, banner.indexOf("banner-details"));
  assert.doesNotMatch(lead, /outbound_failed/);

  const send = attemptBanner(failedAttempt("outbound_failed", "provider said no"), shell());
  assert.match(send, /没发出去。检查出站配置或稍后重试。/);
  assert.match(send, /<code class="mono">outbound_failed<\/code>/);
  assert.doesNotMatch(send.split("banner-details")[0] ?? send, />outbound_failed</);

  const login = renderLoginPage(shell(), "unauthorized", "POST /auth/login with address and token.");
  assert.match(login, /登录已失效。重新登录后再继续。/);
  assert.match(login, /<code class="mono">unauthorized<\/code>/);
  assert.doesNotMatch(login.split("banner-details")[0] ?? login, />unauthorized</);
});

test("personal nav: four primary tabs; watch desk only for admin", () => {
  const member = layout({
    title: "Inbox",
    nav: "inbox",
    mailbox: MAILBOX,
    mode: "list",
    simple: false,
    unreadCount: 2,
    shell: shell(),
    body: "<main></main>",
  });
  const mobile = member.match(/<nav class="mobile-nav"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.match(mobile, />收件箱</);
  assert.match(mobile, />未读</);
  assert.match(mobile, />写信</);
  assert.match(mobile, />设置</);
  assert.equal((mobile.match(/<a /g) ?? []).length, 4);
  assert.doesNotMatch(mobile, /\/admin/);
  assert.doesNotMatch(member, /class="nav-desk"/);
  assert.match(member, /nav-mailbox|nav.mailbox|邮箱/);
  assert.match(member, />文件夹</);
  assert.match(member, />本箱</);
  assert.match(member, /href="\/addresses"/);
  assert.doesNotMatch(member, /#aliases/);
  assert.doesNotMatch(member, /#api-key/);

  const admin = layout({
    title: "Inbox",
    nav: "inbox",
    mailbox: MAILBOX,
    mode: "list",
    simple: false,
    unreadCount: 0,
    shell: shell({ nav: { showAdmin: true, hasAliases: true, hasApiKey: true } }),
    body: "<main></main>",
  });
  const adminMobile = admin.match(/<nav class="mobile-nav"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.equal((adminMobile.match(/<a /g) ?? []).length, 4);
  assert.doesNotMatch(adminMobile, /\/admin/);
  assert.match(admin, /class="nav-desk"/);
  assert.match(admin, /href="\/admin"/);
  assert.match(admin, /#aliases/);
  assert.match(admin, /#api-key/);
});
