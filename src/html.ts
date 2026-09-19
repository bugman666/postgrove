export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatReceived(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

export const GROVE_MARK = `<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
  <rect x="3" y="10" width="4" height="10" rx="2" fill="currentColor"/>
  <rect x="10" y="5" width="4" height="15" rx="2" fill="currentColor"/>
  <rect x="17" y="8" width="4" height="12" rx="2" fill="currentColor"/>
</svg>`;

export const EMPTY_ART = `<svg class="empty-art" viewBox="0 0 72 64" fill="none" aria-hidden="true">
  <rect x="8" y="22" width="40" height="28" rx="3" stroke="currentColor" stroke-width="1.6"/>
  <path d="M8 26l20 12 20-12" stroke="currentColor" stroke-width="1.6"/>
  <path d="M54 40v-16l6-9 6 9v16h-12z" stroke="currentColor" stroke-width="1.6"/>
  <path d="M58 40v6" stroke="currentColor" stroke-width="1.6"/>
</svg>`;
