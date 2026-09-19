import type { Env } from "./env.ts";
import { utcDay } from "./quotas.ts";

export type GroveStats = {
  users: number;
  messages_today: number;
  storage_mb: number;
  empty: boolean;
};

export function emptyStats(): GroveStats {
  return { users: 0, messages_today: 0, storage_mb: 0, empty: true };
}

export async function loadGroveStats(env: Env, now = Date.now()): Promise<GroveStats> {
  const day = utcDay(now);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + 24 * 60 * 60 * 1000;

  const users = await countSafe(env, `SELECT COUNT(*) AS n FROM users`);
  const messages = await countSafe(
    env,
    `SELECT COUNT(*) AS n FROM messages
     WHERE received_at >= ?1 AND received_at < ?2
       AND folder IN ('inbox', 'sent')`,
    start,
    end,
  );
  const storageBytes = await countSafe(
    env,
    `SELECT COALESCE(SUM(size_bytes), 0) AS n FROM attachments`,
  );
  const storageMb = Math.round((storageBytes / (1024 * 1024)) * 10) / 10;
  const empty = users === 0 && messages === 0 && storageBytes === 0;
  return {
    users,
    messages_today: messages,
    storage_mb: storageMb,
    empty,
  };
}

async function countSafe(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  try {
    let stmt = env.DB.prepare(sql);
    if (binds.length) {
      stmt = stmt.bind(...binds);
    }
    const row = await stmt.first<{ n: number }>();
    const value = Number(row?.n ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
