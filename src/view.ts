import { cookieValue } from "./auth.ts";
import type { Env } from "./env.ts";
import { loadBranding, type SiteBranding } from "./branding.ts";
import { GROVE_MARK, escapeHtml } from "./html.ts";
import {
  LOCALE_COOKIE,
  htmlLang,
  parseLocalePreference,
  resolveLocale,
  t,
  type Locale,
  type LocalePreference,
} from "./i18n.ts";

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
