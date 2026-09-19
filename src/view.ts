import { cookieValue } from "./auth.ts";
import { EMPTY_INBOX_SRC } from "./brand-assets.ts";
import type { Env } from "./env.ts";
import { loadBranding, type SiteBranding } from "./branding.ts";
import { BOX_FOLDERS, boxFolderNavLinks, type SystemFolder } from "./folders.ts";
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
import { emptyNav, type NavContext } from "./ui-nav.ts";

export type { NavContext } from "./ui-nav.ts";
export { emptyNav } from "./ui-nav.ts";

export type Shell = {
  locale: Locale;
  preference: LocalePreference;
  brand: SiteBranding;
  nav: NavContext;
};

export async function resolveShell(request: Request, env: Env): Promise<Shell> {
  const forced = cookieValue(request.headers.get("cookie"), LOCALE_COOKIE);
  const preference: LocalePreference =
    forced === "zh" || forced === "en" ? forced : parseLocalePreference(forced ?? "auto");
  return {
    locale: resolveLocale(request),
    preference,
    brand: await loadBranding(env),
    nav: emptyNav(),
  };
}

export function withNav(shell: Shell, nav: NavContext): Shell {
  return { ...shell, nav };
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

export type EmptyArt = "brand" | "mark" | "none";

export function emptyBlock(copy: string, art: EmptyArt = "mark", alt = ""): string {
  let visual = "";
  if (art === "brand") {
    visual = `<img class="empty-photo" src="${escapeHtml(EMPTY_INBOX_SRC)}" alt="${escapeHtml(alt || copy)}" onerror="this.remove()">`;
  } else if (art === "mark") {
    visual = EMPTY_ART;
  }
  return `<div class="empty">${visual}<p>${escapeHtml(copy)}</p></div>`;
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
  const foldersOpen = (BOX_FOLDERS as readonly string[]).includes(opts.nav) ? " open" : "";
  const folderItems = boxFolderNavLinks(opts.nav, (id) => folderHref(opts.mailbox, id), folderLabels(opts.shell))
    .map(
      (item) =>
        `<li><a class="${item.active ? "active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`,
    )
    .join("");
  const boxItems = thisBoxLinks(opts.shell, opts.nav, settings)
    .map(
      (item) =>
        `<li><a class="${item.active ? "active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`,
    )
    .join("");
  const desk = opts.shell.nav.showAdmin
    ? `<p class="nav-desk"><a class="${opts.nav === "admin" ? "active" : ""}" href="/admin">${escapeHtml(tr(opts.shell, "nav.admin"))}</a></p>`
    : "";
  const moreInner = `${folderItems}${boxItems}${
    opts.shell.nav.showAdmin
      ? `<li><a class="${opts.nav === "admin" ? "active" : ""}" href="/admin">${escapeHtml(tr(opts.shell, "nav.admin"))}</a></li>`
      : ""
  }`;

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
        <li><a class="${opts.nav === "compose" ? "active" : ""}" href="${escapeHtml(compose)}">${escapeHtml(tr(opts.shell, "nav.compose"))}</a></li>
      </ul>
      <div class="nav-group">
        <p class="nav-group-label">${escapeHtml(tr(opts.shell, "nav.mailbox"))}</p>
        <ul class="nav-list">
          <li><a class="${opts.nav === "inbox" ? "active" : ""}" href="${escapeHtml(inbox)}">${escapeHtml(tr(opts.shell, "nav.inbox"))}${countBadge}</a></li>
          <li><a class="${opts.nav === "unread" ? "active" : ""}" href="${escapeHtml(unreadHref)}">${escapeHtml(tr(opts.shell, "nav.unread"))}</a></li>
        </ul>
      </div>
      <details class="nav-group nav-folders"${foldersOpen}>
        <summary class="nav-group-label">${escapeHtml(tr(opts.shell, "nav.folders"))}</summary>
        <ul class="nav-list">${folderItems}</ul>
      </details>
      <div class="nav-group">
        <p class="nav-group-label">${escapeHtml(tr(opts.shell, "nav.this-box"))}</p>
        <ul class="nav-list">${boxItems}</ul>
      </div>
      <ul class="nav-list nav-tools">
        <li><a class="${opts.nav === "settings" ? "active" : ""}" href="${escapeHtml(settings)}">${escapeHtml(tr(opts.shell, "nav.settings"))}</a></li>
      </ul>
      ${desk}
      ${chip}
    </aside>
    <div class="more-bar">
      <details class="more-drawer">
        <summary>${escapeHtml(tr(opts.shell, "nav.more"))}</summary>
        <ul class="nav-list">${moreInner}</ul>
      </details>
    </div>
    ${opts.body}
  </div>
  <nav class="mobile-nav" aria-label="${escapeHtml(tr(opts.shell, "nav.main"))}">
    <a class="${opts.nav === "inbox" ? "active" : ""}" href="${escapeHtml(inbox)}">${escapeHtml(tr(opts.shell, "nav.inbox"))}${countBadge}</a>
    <a class="${opts.nav === "unread" ? "active" : ""}" href="${escapeHtml(unreadHref)}">${escapeHtml(tr(opts.shell, "nav.unread"))}</a>
    <a class="${opts.nav === "compose" ? "active" : ""}" href="${escapeHtml(compose)}">${escapeHtml(tr(opts.shell, "nav.compose"))}</a>
    <a class="${opts.nav === "settings" ? "active" : ""}" href="${escapeHtml(settings)}">${escapeHtml(tr(opts.shell, "nav.settings"))}</a>
  </nav>
</body>
</html>`;
}

function thisBoxLinks(
  shell: Shell,
  nav: NavId,
  settings: string,
): { href: string; label: string; active: boolean }[] {
  const links = [
    {
      href: "/addresses",
      label: tr(shell, "nav.addresses"),
      active: nav === "addresses",
    },
  ];
  if (shell.nav.hasAliases) {
    links.push({
      href: `${settings}#aliases`,
      label: tr(shell, "nav.aliases"),
      active: false,
    });
  }
  if (shell.nav.hasApiKey) {
    links.push({
      href: `${settings}#api-key`,
      label: tr(shell, "nav.api-key"),
      active: false,
    });
  }
  return links;
}
