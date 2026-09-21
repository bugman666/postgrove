import { cookieValue } from "./auth.ts";

export const LOCALE_COOKIE = "postgrove_locale";
export const LOCALE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export type Locale = "zh" | "en";
export type LocalePreference = Locale | "auto";

type Vars = Record<string, string | number>;

const ZH: Record<string, string> = {
  "nav.inbox": "收件箱",
  "nav.unread": "未读",
  "nav.starred": "星标",
  "nav.sent": "已发送",
  "nav.draft": "草稿",
  "nav.trash": "垃圾箱",
  "nav.spam": "垃圾邮件",
  "nav.compose": "写信",
  "nav.addresses": "地址",
  "nav.settings": "设置",
  "nav.admin": "值守",
  "nav.overview": "概览",
  "nav.site": "站点",
  "nav.members": "成员",
  "nav.folders": "文件夹",
  "nav.main": "主导航",
  "nav.mailbox": "邮箱",
  "nav.this-box": "本箱",
  "nav.more": "更多",
  "nav.aliases": "别名",
  "nav.api-key": "API Key",
  "empty.inbox": "还没有信。域名路由配好后，寄一封到你的地址试试。",
  "empty.sent": "还没有已发送的信。写出站邮件后会出现在这里。",
  "empty.draft": "还没有草稿。写信时点「存草稿」即可回来继续。",
  "empty.trash": "垃圾箱是空的。",
  "empty.spam": "没有标记为垃圾邮件的信。",
  "empty.search": "没有匹配的信。换个词试试。",
  "empty.inbox-alt": "空收件箱",
  "empty.addresses-alt": "空地址",
  "empty.unread": "没有未读的信。",
  "empty.starred": "还没有星标。",
  "empty.pick": "从左侧选一封，或点「写信」。",
  "empty.addresses": "还没有地址。创建一个，例如 you@yourdomain。",
  "empty.members": "还没有成员。下面开一个信箱用户。",
  "empty.boxes": "还没有地址。",
  "empty.mail": "林子里还没落下信件。",
  "empty.deliveries": "还没有入站投递。配好 webhook 或转发后，新信会记在这里。",
  "empty.delivery-log": "还没有投递记录。新信到达后会出现在这里。",
  "empty.analytics": "还没有数据。有流量后这里会更新。",
  "quota.addresses-full": "地址配额已满（已用 {used} / 上限 {limit}）。向值守申请提高配额，或停用一个旧地址后再开新的。",
  "quota.storage-full": "存不下了：附件或邮件体积已达上限。删信或请管理员扩容。",
  "quota.send-full": "发不出去：已达今日发送上限。",
  "quota.send-low": "还剩不多：今日发送 {n}/{max}。明天再试或请管理员调高配额。",
  "quota.storage-used": "存储配额不足（已用 {used}，本封 {incoming}，上限 {limit}）。清一清旧信或提高该成员的存储配额。",
  "quota.send-used": "今日发送配额已用完（{used} / {limit}，UTC {day}）。明天零点（UTC）重置，或向值守申请提高日发送上限。",
  "quota.api-used": "今日 API 请求配额已用完（{used} / {limit}，UTC {day}）。明天零点（UTC）重置，或为这把钥匙提高日请求上限。",
  "heading.aliases": "别名",
  "empty.aliases": "还没有别名。在本域生成一个 +tag，寄到 user+tag@你的域名 会进同一个信箱。",
  "label.generate-alias": "生成本域 +tag",
  "label.custom-alias": "自定义别名（必须是本域）",
  "label.save-alias": "添加别名",
  "banner.alias-hint": "Gmail 式 +tag：寄到 主地址+标签@本域 会落入同一信箱，并可按标签搜索。只能用这个信箱已经拥有的域名。",
  "banner.alias-primary": "主地址",
  "banner.alias-created": "别名已添加。寄到这个地址会进当前信箱。",
  "banner.deleted-inbox": "已移出收件箱。",
  "banner.marked-unread": "已标为未读。",
  "banner.deleted-trash": "已移入垃圾箱。",
  "banner.moved": "已移动到{folder}。",
  "banner.sent-ok": "发送成功。这封信现在在已发送。",
  "banner.sent-noted": "已记下这次发送，可在已发送里打开。",
  "banner.draft-saved": "草稿已保存。主题和正文已保留，可继续写或从草稿箱打开。",
  "banner.no-mailbox": "没有可用地址。确认本地已经 migrate 并且 seed。",
  "banner.hooks-saved": "入站通知已保存。密钥若刚生成，只在 API 响应里出现一次。",
  "banner.lang-updated": "界面语言已更新。",
  "banner.brand-saved": "品牌设置已保存。",
  "banner.bad-accent": "主色要用合法的颜色值，例如 #1B4332。",
  "banner.logo-fail": "Logo 地址打不开。换一个 https 链接，或先留空。",
  "banner.admin-forbidden": "这里只有管理员能进。若你该有权限，请用 admin 凭证登录。",
  "banner.login-expired": "登录已失效。重新登录后再继续。",
  "banner.details": "详情",
  "banner.api-key-hint": "完整密钥只在创建时出现一次。用 API 管理这把钥匙。",
  "error.session": "登录已失效。重新登录后再继续。",
  "error.outbound-unset": "还不能发信。在设置里接上出站提供商后再试。",
  "error.send-failed": "没发出去。检查出站配置或稍后重试。",
  "error.quota-full": "发不出去：已达今日发送上限。",
  "error.attach-over": "附件太大（上限 {n} MB）。去掉大文件或压缩后再试。",
  "error.webhook-blocked": "这个地址不能用（内网或受限目标）。换一个公网 https 地址。",
  "filter.all": "全部",
  "filter.unread": "未读",
  "filter.starred": "星标",
  "heading.search": "搜索",
  "heading.login": "登录",
  "login.address": "地址",
  "login.passphrase": "口令",
  "login.hint": "本地默认 OWNER_TOKEN=change-me-local-owner-token（.dev.vars）。勿在生产复用，见 docs/PRODUCTION_AUTH.md。",
  "login.fail": "登录失败。重新登录后再继续。",
  "login.network": "登录失败。检查网络后重试。",
  "heading.settings": "设置",
  "heading.addresses": "地址",
  "heading.admin": "值守台",
  "heading.overview": "概览",
  "heading.site": "站点",
  "heading.members": "成员",
  "stat.users": "用户",
  "stat.messages-today": "今日邮件",
  "stat.storage": "存储",
  "label.language": "界面语言",
  "label.follow-browser": "跟随浏览器",
  "label.chinese": "中文",
  "label.english": "English",
  "label.save-language": "保存语言",
  "label.site-title": "站点名",
  "label.logo-url": "Logo 地址",
  "label.accent": "主色",
  "label.save-brand": "保存品牌",
  "label.current-mailbox": "当前地址",
  "brand.login": "登录",
  "brand.enter": "进入值守",
  "brand.leave": "离开值守",
};

const EN: Record<string, string> = {
  "nav.inbox": "Inbox",
  "nav.unread": "Unread",
  "nav.starred": "Starred",
  "nav.sent": "Sent",
  "nav.draft": "Drafts",
  "nav.trash": "Trash",
  "nav.spam": "Spam",
  "nav.compose": "Compose",
  "nav.addresses": "Addresses",
  "nav.settings": "Settings",
  "nav.admin": "Desk",
  "nav.overview": "Overview",
  "nav.site": "Site",
  "nav.members": "Members",
  "nav.folders": "Folders",
  "nav.main": "Main",
  "nav.mailbox": "Mailbox",
  "nav.this-box": "This box",
  "nav.more": "More",
  "nav.aliases": "Aliases",
  "nav.api-key": "API Key",
  "empty.inbox": "No mail yet. After routing is set, send a message to your address.",
  "empty.sent": "Nothing sent yet. Outbound mail will land here.",
  "empty.draft": "No drafts. Save one from compose and come back later.",
  "empty.trash": "Trash is empty.",
  "empty.spam": "No mail marked as spam.",
  "empty.search": "No matching messages. Try another search.",
  "empty.inbox-alt": "Empty inbox",
  "empty.addresses-alt": "Empty addresses",
  "empty.unread": "No unread mail.",
  "empty.starred": "No starred mail yet.",
  "empty.pick": "Pick a message, or compose a new one.",
  "empty.addresses": "No addresses yet. Create one, e.g. you@yourdomain.",
  "empty.members": "No members yet. Add a mailbox user below.",
  "empty.boxes": "No addresses yet.",
  "empty.mail": "No letters in the grove yet.",
  "empty.deliveries": "No inbound deliveries yet. After a webhook or forward is set, new mail is logged here.",
  "empty.delivery-log": "No delivery records yet. They appear when new mail arrives.",
  "empty.analytics": "还没有数据。有流量后这里会更新。",
  "quota.addresses-full": "Address quota is full (used {used} / limit {limit}). Ask an admin to raise the cap, or retire an old address.",
  "quota.storage-full": "This mailbox is out of storage. Delete mail or ask an admin to raise the cap.",
  "quota.send-full": "Cannot send: the daily send limit is reached.",
  "quota.send-low": "Almost out: sent {n}/{max} today. Try tomorrow or ask an admin to raise the quota.",
  "quota.storage-used": "Not enough storage (used {used}, this message {incoming}, cap {limit}). Clear old mail or raise this member's storage quota.",
  "quota.send-used": "Daily send quota is used up ({used} / {limit}, UTC {day}). It resets at midnight UTC, or ask an admin to raise it.",
  "quota.api-used": "Daily API request quota is used up ({used} / {limit}, UTC {day}). It resets at midnight UTC, or raise this key's daily request cap.",
  "heading.aliases": "Aliases",
  "empty.aliases": "No aliases yet. Generate a +tag on this domain; mail to user+tag@your-domain lands in the same mailbox.",
  "label.generate-alias": "Generate a +tag on this domain",
  "label.custom-alias": "Custom alias (this domain only)",
  "label.save-alias": "Add alias",
  "banner.alias-hint": "Gmail-style +tag: mail to primary+tag@this-domain lands in the same mailbox and is searchable by the tag. Only the mailbox's own domain is allowed.",
  "banner.alias-primary": "Primary address",
  "banner.alias-created": "Alias added. Mail to this address lands in the current mailbox.",
  "banner.deleted-inbox": "Moved out of the inbox.",
  "banner.marked-unread": "Marked unread.",
  "banner.deleted-trash": "Moved to trash.",
  "banner.moved": "Moved to {folder}.",
  "banner.sent-ok": "Sent. This message is now in Sent.",
  "banner.sent-noted": "Send recorded. Open it from Sent.",
  "banner.draft-saved": "Draft saved. Subject and body are kept.",
  "banner.no-mailbox": "No address available. Migrate and seed locally, then sign in.",
  "banner.hooks-saved": "Inbound notify saved. A newly generated secret appears once in the API response.",
  "banner.lang-updated": "Language updated.",
  "banner.brand-saved": "Branding saved.",
  "banner.bad-accent": "Accent must be a valid color, for example #1B4332.",
  "banner.logo-fail": "That logo URL could not be opened. Use an https link, or leave it empty.",
  "banner.admin-forbidden": "Only admins can open the duty desk. Sign in with admin credentials if you should have access.",
  "banner.login-expired": "Your session expired. Sign in again to continue.",
  "banner.details": "Details",
  "banner.api-key-hint": "The full key is shown once when created. Manage keys through the API.",
  "error.session": "Your session expired. Sign in again to continue.",
  "error.outbound-unset": "Cannot send yet. Connect an outbound provider in Settings, then try again.",
  "error.send-failed": "The message was not sent. Check outbound settings or try again later.",
  "error.quota-full": "Cannot send: the daily send limit is reached.",
  "error.attach-over": "Attachment too large (limit {n} MB). Remove large files or compress and try again.",
  "error.webhook-blocked": "That address cannot be used (private or blocked target). Use a public https URL.",
  "filter.all": "All",
  "filter.unread": "Unread",
  "filter.starred": "Starred",
  "heading.search": "Search",
  "heading.login": "Sign in",
  "login.address": "Address",
  "login.passphrase": "Passphrase",
  "login.hint": "Local default OWNER_TOKEN=change-me-local-owner-token in .dev.vars. Do not reuse in production; see docs/PRODUCTION_AUTH.md.",
  "login.fail": "Sign-in failed. Sign in again to continue.",
  "login.network": "Sign-in failed. Check the network and retry.",
  "heading.settings": "Settings",
  "heading.addresses": "Addresses",
  "heading.admin": "Duty desk",
  "heading.overview": "Overview",
  "heading.site": "Site",
  "heading.members": "Members",
  "stat.users": "Users",
  "stat.messages-today": "Today's mail",
  "stat.storage": "Storage",
  "label.language": "Language",
  "label.follow-browser": "Match browser",
  "label.chinese": "中文",
  "label.english": "English",
  "label.save-language": "Save language",
  "label.site-title": "Site title",
  "label.logo-url": "Logo URL",
  "label.accent": "Accent",
  "label.save-brand": "Save branding",
  "label.current-mailbox": "Current address",
  "brand.login": "Sign in",
  "brand.enter": "Enter desk",
  "brand.leave": "Leave desk",
};

const TABLES: Record<Locale, Record<string, string>> = { zh: ZH, en: EN };

/** Never throws. Missing keys fall back to the other locale, then the key itself. */
export function t(locale: Locale, key: string, vars?: Vars): string {
  const primary = TABLES[locale] ?? ZH;
  const other = locale === "zh" ? EN : ZH;
  let text = primary[key] ?? other[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

export function parseLocalePreference(raw: unknown): LocalePreference {
  if (raw === "en" || raw === "zh" || raw === "auto") {
    return raw;
  }
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "en" || lower.startsWith("en-")) {
      return "en";
    }
    if (lower === "zh" || lower.startsWith("zh-")) {
      return "zh";
    }
    if (lower === "auto") {
      return "auto";
    }
  }
  return "auto";
}

export function localeFromAcceptLanguage(header: string | null): Locale {
  if (!header) {
    return "zh";
  }
  const parts = header.split(",").map((part) => {
    const [tag, ...params] = part.trim().split(";");
    let q = 1;
    for (const param of params) {
      const match = /q\s*=\s*([0-9.]+)/i.exec(param);
      if (match) {
        q = Number(match[1]);
      }
    }
    return { tag: (tag ?? "").trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
  });
  parts.sort((a, b) => b.q - a.q);
  for (const part of parts) {
    if (part.tag === "zh" || part.tag.startsWith("zh-")) {
      return "zh";
    }
    if (part.tag === "en" || part.tag.startsWith("en-")) {
      return "en";
    }
  }
  return "zh";
}

export function resolveLocale(request: Request): Locale {
  const forced = cookieValue(request.headers.get("cookie"), LOCALE_COOKIE);
  if (forced === "zh" || forced === "en") {
    return forced;
  }
  return localeFromAcceptLanguage(request.headers.get("accept-language"));
}

export function localeCookieHeader(
  request: Request,
  preference: LocalePreference,
): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  if (preference === "auto") {
    return `${LOCALE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  return `${LOCALE_COOKIE}=${preference}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOCALE_MAX_AGE_SECONDS}${secure}`;
}

export function withLocaleCookie(
  response: Response,
  request: Request,
  preference: LocalePreference,
): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", localeCookieHeader(request, preference));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function htmlLang(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en";
}

export function folderLabelKey(folder: string): string {
  switch (folder) {
    case "sent":
      return "nav.sent";
    case "draft":
      return "nav.draft";
    case "trash":
      return "nav.trash";
    case "spam":
      return "nav.spam";
    default:
      return "nav.inbox";
  }
}

export function folderEmptyKey(folder: string): string {
  switch (folder) {
    case "sent":
      return "empty.sent";
    case "draft":
      return "empty.draft";
    case "trash":
      return "empty.trash";
    case "spam":
      return "empty.spam";
    default:
      return "empty.inbox";
  }
}
