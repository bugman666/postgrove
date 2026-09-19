/** Inbox list filters used by HTML and JSON search. */
export type InboxFilter = "all" | "unread" | "starred";

/** Engine actually used for a search response. */
export type SearchEngine = "fts5" | "like";

export const SEARCH_ENGINE_FTS5: SearchEngine = "fts5";
export const SEARCH_ENGINE_LIKE: SearchEngine = "like";

/** Preferred engine when `messages_fts` is present. API still reports the engine used. */
export const SEARCH_ENGINE = SEARCH_ENGINE_FTS5;

const SEARCH_QUERY_MAX = 200;
const FTS_TOKEN_MAX = 12;
const FTS_TOKEN_RE = /[\p{L}\p{N}]+/gu;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const FTS_KEYWORDS = new Set(["and", "or", "not", "near"]);

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
 * Turn a user query into a safe FTS5 MATCH expression.
 * Strips operators (`AND`/`OR`/`NOT`, `*`, quotes, columns) and keeps letters/digits/CJK.
 * Returns null when nothing searchable remains (caller should yield zero hits).
 */
export function escapeFts5Query(raw: string): string | null {
  const tokens = (raw.match(FTS_TOKEN_RE) ?? []).filter(
    (token) => !FTS_KEYWORDS.has(token.toLowerCase()),
  );
  if (tokens.length === 0) {
    return null;
  }
  const terms = tokens.slice(0, FTS_TOKEN_MAX).map(tokenToFtsTerm).filter(Boolean);
  return terms.length > 0 ? terms.join(" AND ") : null;
}

function tokenToFtsTerm(token: string): string {
  if (CJK_RE.test(token) && token.length > 1) {
    return `"${[...token].join(" ")}"`;
  }
  if (token.length >= 2) {
    return `"${token}"*`;
  }
  if (CJK_RE.test(token)) {
    return `"${token}"`;
  }
  return "";
}

/** Higher is better. Subject outranks from / To; body is last. */
export function searchRankScore(
  row: {
    envelope_from: string;
    envelope_to?: string;
    subject: string | null;
    body_text: string | null;
  },
  q: string,
): number {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    return 0;
  }
  let score = 0;
  if ((row.subject ?? "").toLowerCase().includes(needle)) {
    score += 8;
  }
  if (row.envelope_from.toLowerCase().includes(needle)) {
    score += 4;
  }
  if ((row.envelope_to ?? "").toLowerCase().includes(needle)) {
    score += 3;
  }
  if ((row.body_text ?? "").toLowerCase().includes(needle)) {
    score += 1;
  }
  return score;
}

export function compareSearchRank<
  T extends {
    envelope_from: string;
    envelope_to?: string;
    subject: string | null;
    body_text: string | null;
    received_at?: number;
  },
>(a: T, b: T, q: string): number {
  const delta = searchRankScore(b, q) - searchRankScore(a, q);
  if (delta !== 0) {
    return delta;
  }
  return (b.received_at ?? 0) - (a.received_at ?? 0);
}

/**
 * JS stand-in for the SQL LIKE match (from / subject / body / envelope To).
 * Envelope To is included so +tag aliases stay searchable.
 * SQLite LIKE is case-insensitive for ASCII; this lowercases the same way.
 */
export function messageMatchesQuery(
  row: {
    envelope_from: string;
    envelope_to?: string;
    subject: string | null;
    body_text: string | null;
  },
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const hay = [row.envelope_from, row.envelope_to ?? "", row.subject ?? "", row.body_text ?? ""]
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
