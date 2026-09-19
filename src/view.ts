import { cookieValue } from "./auth.ts";
import type { Env } from "./env.ts";
import { loadBranding, type SiteBranding } from "./branding.ts";
import { SYSTEM_FOLDERS, folderNavLinks, type SystemFolder } from "./folders.ts";
import { EMPTY_ART, GROVE_MARK, escapeHtml } from "./html.ts";
import {
  LOCALE_COOKIE,
  htmlLang,
  parseLocalePreference,
  resolveLocale,
  t,
  type Locale,
  type LocalePreference,
} from "./i18n.ts";
import type { MailboxRecord } from "./store.ts";
import { boxPath, folderHref, inboxHref, withMailbox } from "./ui-paths.ts";

export type Shell = {
  locale: Locale;
  preference: LocalePreference;
  brand: SiteBranding;
};

export async function resolveShell(request: Request, env: Env): Promise<Shell> {
  const forced = cookieValue(request.headers.get("cookie"), LOCALE_COOKIE);
  const preference: LocalePreference =
    forced === "zh" || forced === "en" ? forced : parseLocalePreference(forced ?? "auto");
  return {
    locale: resolveLocale(request),
    preference,
    brand: await loadBranding(env),
  };
}

export function tr(shell: Shell, key: string, vars?: Record<string, string | number>): string {
  return t(shell.locale, key, vars);
}

export function brandLink(shell: Shell, href: string): string {
  const title = escapeHtml(shell.brand.site_title);
  const mark = shell.brand.logo_url
    ? `<img class="brand-logo" src="${escapeHtml(shell.brand.logo_url)}" alt="${title}">`
    : GROVE_MARK;
  return `<a class="brand" href="${escapeHtml(href)}">${mark}${title}</a>`;
}

export function documentLang(shell: Shell): string {
  return htmlLang(shell.locale);
}

export function pageTitle(shell: Shell, heading: string): string {
  return `${heading} · ${shell.brand.site_title}`;
}

export type NavId = SystemFolder | "unread" | "compose" | "addresses" | "settings" | "admin";

export function emptyBlock(copy: string): string {
  return `<div class="empty">${EMPTY_ART}<p>${escapeHtml(copy)}</p></div>`;
}

export function folderLabels(shell: Shell): Record<SystemFolder, string> {
  return {
    inbox: tr(shell, "nav.inbox"),
    sent: tr(shell, "nav.sent"),
    draft: tr(shell, "nav.draft"),
    trash: tr(shell, "nav.trash"),
    spam: tr(shell, "nav.spam"),
  };
}

export function layout(opts: {
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
