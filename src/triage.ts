/** Inbox list filters used by HTML and JSON search. */
export type InboxFilter = "all" | "unread" | "starred";

/** Documented search engine: SQLite LIKE, not FTS5. */
export const SEARCH_ENGINE = "like" as const;

const SEARCH_QUERY_MAX = 200;

export function parseInboxFilter(raw: string | null | undefined): InboxFilter {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "unread" || value === "starred") {
    return value;
  }
  return "all";
}

export function parseSearchQuery(raw: string | null | undefined): string {
  return (raw ?? "").trim().slice(0, SEARCH_QUERY_MAX);
}

export function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function likeContains(value: string): string {
  return `%${escapeLike(value)}%`;
}

/**
 * JS stand-in for the SQL LIKE match (from / subject / body).
 * SQLite LIKE is case-insensitive for ASCII; this lowercases the same way.
 */
export function messageMatchesQuery(
  row: { envelope_from: string; subject: string | null; body_text: string | null },
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const hay = [row.envelope_from, row.subject ?? "", row.body_text ?? ""]
    .join("\n")
    .toLowerCase();
  return hay.includes(needle);
}

export function applyInboxFilter<T extends { is_read: number; is_starred: number }>(
  rows: T[],
  filter: InboxFilter,
): T[] {
  if (filter === "unread") {
    return rows.filter((row) => row.is_read !== 1);
  }
  if (filter === "starred") {
    return rows.filter((row) => row.is_starred === 1);
  }
  return rows;
}
