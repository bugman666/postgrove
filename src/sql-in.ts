/** Bound `IN (...)` placeholders for D1 numbered params (`?1`, `?2`, …). */
export const SQL_IN_CHUNK = 80;

export function sqlInPlaceholders(startIndex: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `?${startIndex + i}`).join(", ");
}

export function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function chunkIds(ids: readonly string[], size = SQL_IN_CHUNK): string[][] {
  const unique = uniqueIds(ids);
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    chunks.push(unique.slice(i, i + size));
  }
  return chunks;
}
