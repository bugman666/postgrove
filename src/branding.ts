import type { Env } from "./env.ts";
import { validateSafeUrl } from "./safe-url.ts";

export const DEFAULT_SITE_TITLE = "Postgrove";
export const DEFAULT_ACCENT = "#1B4332";
export const TITLE_MAX = 80;
export const LOGO_URL_MAX = 2048;
export const LOGO_FETCH_MAX_REDIRECTS = 3;

export const BRAND_SAVED_HINT = "品牌设置已保存。";
export const BAD_ACCENT_HINT = "主色要用合法的颜色值，例如 #1B4332。";
export const LOGO_FAIL_HINT = "Logo 地址打不开。换一个 https 链接，或先留空。";

const ACCENT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export type SiteBranding = {
  site_title: string;
  logo_url: string | null;
  accent: string;
};

export class BrandingInputError extends Error {
  error: string;
  constructor(error: string, message: string) {
    super(message);
    this.name = "BrandingInputError";
    this.error = error;
  }
}

type FetchImpl = typeof fetch;
let testFetch: FetchImpl | null = null;

/** Test-only fetch override for logo probe. */
export function setLogoFetchForTests(fn: FetchImpl | null): void {
  testFetch = fn;
}

export function defaultBranding(): SiteBranding {
  return {
    site_title: DEFAULT_SITE_TITLE,
    logo_url: null,
    accent: DEFAULT_ACCENT,
  };
}

export function normalizeAccent(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim();
  if (!ACCENT_RE.test(value)) {
    return null;
  }
  if (value.length === 4) {
    const r = value[1];
    const g = value[2];
    const b = value[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return value.toUpperCase();
}

export function sanitizeSiteTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    return DEFAULT_SITE_TITLE;
  }
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return DEFAULT_SITE_TITLE;
  }
  return trimmed.slice(0, TITLE_MAX);
}

export function brandOverrideCss(accent: string): string {
  const hex = normalizeAccent(accent) ?? DEFAULT_ACCENT;
  return `\n:root { --pg-color-brand: ${hex}; }\n`;
}

export function publicBranding(row: SiteBranding): SiteBranding {
  return {
    site_title: row.site_title,
    logo_url: row.logo_url,
    accent: row.accent,
  };
}

export async function loadBranding(env: Env): Promise<SiteBranding> {
  try {
    const row = await env.DB.prepare(
      `SELECT site_title, logo_url, accent FROM site_settings WHERE id = 1`,
    ).first<{ site_title: string; logo_url: string | null; accent: string }>();
    if (!row) {
      return defaultBranding();
    }
    return {
      site_title: sanitizeSiteTitle(row.site_title),
      logo_url: typeof row.logo_url === "string" && row.logo_url.trim() ? row.logo_url.trim() : null,
      accent: normalizeAccent(row.accent) ?? DEFAULT_ACCENT,
    };
  } catch {
    return defaultBranding();
  }
}

export async function saveBranding(
  env: Env,
  input: { site_title?: unknown; logo_url?: unknown; accent?: unknown },
): Promise<SiteBranding> {
  const current = await loadBranding(env);
  const title =
    input.site_title === undefined ? current.site_title : sanitizeSiteTitle(input.site_title);

  let accent = current.accent;
  if (input.accent !== undefined) {
    const parsed = normalizeAccent(input.accent);
    if (!parsed) {
      throw new BrandingInputError("invalid_accent", BAD_ACCENT_HINT);
    }
    accent = parsed;
  }

  let logoUrl = current.logo_url;
  if (input.logo_url !== undefined) {
    logoUrl = await gateLogoUrl(input.logo_url);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO site_settings (id, site_title, logo_url, accent, updated_at)
     VALUES (1, ?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET
       site_title = excluded.site_title,
       logo_url = excluded.logo_url,
       accent = excluded.accent,
       updated_at = excluded.updated_at`,
  )
    .bind(title, logoUrl, accent, now)
    .run();

  return { site_title: title, logo_url: logoUrl, accent };
}

/**
 * Empty is allowed (text mark). Non-empty must pass validateSafeUrl
 * and a live fetch (redirect hops re-checked).
 */
export async function gateLogoUrl(raw: unknown): Promise<string | null> {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > LOGO_URL_MAX) {
    throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
  }
  const checked = validateSafeUrl(trimmed);
  if (!checked.ok) {
    throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
  }
  if (checked.url.protocol !== "https:") {
    throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
  }
  await probeLogoUrl(checked.url.toString());
  return checked.url.toString();
}

export async function probeLogoUrl(raw: string): Promise<void> {
  const fetchImpl = testFetch ?? fetch;
  let current = raw;

  for (let hop = 0; hop <= LOGO_FETCH_MAX_REDIRECTS; hop++) {
    const checked = validateSafeUrl(current);
    if (!checked.ok || checked.url.protocol !== "https:") {
      throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
    }

    let response: Response;
    try {
      response = await fetchImpl(checked.url.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "image/*,*/*;q=0.8" },
      });
    } catch {
      throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
      }
      let next: URL;
      try {
        next = new URL(location, checked.url);
      } catch {
        throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
      }
      current = next.toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
    }
    return;
  }

  throw new BrandingInputError("invalid_logo", LOGO_FAIL_HINT);
}
