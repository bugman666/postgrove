import { formatMb } from "./attachment-limits.ts";
import { escapeHtml } from "./html.ts";
import { t, type Locale } from "./i18n.ts";

export type ErrorScene =
  | "session"
  | "outbound_unset"
  | "send_failed"
  | "quota_full"
  | "attach_over"
  | "webhook_blocked";

const SCENE_KEY: Record<ErrorScene, string> = {
  session: "error.session",
  outbound_unset: "error.outbound-unset",
  send_failed: "error.send-failed",
  quota_full: "error.quota-full",
  attach_over: "error.attach-over",
  webhook_blocked: "error.webhook-blocked",
};

/** Map provider / API codes to the six covered banner scenes. */
export function errorScene(code: string | null | undefined): ErrorScene | null {
  switch ((code ?? "").trim()) {
    case "unauthorized":
    case "session_expired":
      return "session";
    case "outbound_not_configured":
    case "unknown_provider":
      return "outbound_unset";
    case "outbound_failed":
    case "outbound_auth_failed":
    case "outbound_url_blocked":
      return "send_failed";
    case "quota_send":
      return "quota_full";
    case "attachment_too_large":
    case "too_many_attachments":
      return "attach_over";
    case "blocked_destination":
      return "webhook_blocked";
    default:
      return null;
  }
}

export function humanErrorMessage(
  locale: Locale,
  code: string | null | undefined,
  vars?: { n?: number },
): string {
  const scene = errorScene(code);
  if (!scene) {
    return "";
  }
  if (scene === "attach_over") {
    return t(locale, SCENE_KEY[scene], { n: vars?.n ?? 10 });
  }
  return t(locale, SCENE_KEY[scene]);
}

export function attachLimitMb(maxBytes?: number | null): number {
  if (!maxBytes || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return 10;
  }
  const mb = Number(formatMb(maxBytes));
  return Number.isFinite(mb) && mb > 0 ? mb : 10;
}

export type PageError =
  | {
      message: string;
      code?: string | null;
      detail?: string | null;
      maxBytes?: number | null;
    }
  | string
  | null
  | undefined;

/**
 * Banner: human main sentence (what happened + next step).
 * Codes and provider text live under collapsible Details — never alone in the lead.
 */
export function layeredBannerHtml(opts: {
  locale: Locale;
  message: string;
  code?: string | null;
  detail?: string | null;
  tone?: "danger" | "success" | "reply" | "";
}): string {
  const tone = opts.tone ? ` ${opts.tone}` : "";
  const code = opts.code?.trim() ?? "";
  const detail = opts.detail?.trim() ?? "";
  const lead = opts.message.trim();
  const details =
    code || detail
      ? `<details class="banner-details">
    <summary>${escapeHtml(t(opts.locale, "banner.details"))}</summary>
    <div class="banner-details-body">
      ${code ? `<code class="mono">${escapeHtml(code)}</code>` : ""}
      ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
    </div>
  </details>`
      : "";
  return `<div class="banner${tone}" role="status">
    <p class="banner-lead">${escapeHtml(lead)}</p>
    ${details}
  </div>`;
}

export function pageErrorBanner(locale: Locale, error: PageError): string {
  if (!error) {
    return "";
  }
  const parsed = typeof error === "string" ? { message: error } : error;
  const human = humanErrorMessage(locale, parsed.code, { n: attachLimitMb(parsed.maxBytes) });
  const message = human || parsed.message;
  const detail =
    parsed.detail ??
    (human && parsed.message && parsed.message !== human ? parsed.message : null);
  return layeredBannerHtml({
    locale,
    tone: "danger",
    message,
    code: parsed.code,
    detail,
  });
}
