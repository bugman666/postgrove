import type { Env } from "./env";

const REQUIRED_TABLES = [
  "mailboxes",
  "messages",
  "outbound_attempts",
  "api_tokens",
  "users",
  "inbound_hooks",
  "inbound_deliveries",
  "dev_inboxes",
  "mailbox_aliases",
] as const;

export async function handleHealth(env: Env): Promise<Response> {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };

  try {
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('mailboxes', 'messages', 'outbound_attempts', 'api_tokens', 'users', 'inbound_hooks', 'inbound_deliveries', 'dev_inboxes', 'mailbox_aliases')`,
    ).all<{ name: string }>();

    const present = new Set((rows.results ?? []).map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((name) => !present.has(name));
    const ready = missing.length === 0;

    if (ready) {
      return json({ ok: true, service: "postgrove", db: "ready", missing }, 200, headers);
    }

    return json(
      {
        ok: false,
        service: "postgrove",
        db: "migrations_pending",
        missing,
        hint: "Apply D1 migrations (npm run db:migrate:local), then retry.",
      },
      503,
      headers,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    return json(
      {
        ok: false,
        service: "postgrove",
        db: "error",
        error: detail,
        hint: "Check the D1 binding and that the local database is reachable.",
      },
      503,
      headers,
    );
  }
}

function json(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
