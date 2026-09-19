import type { Env } from "./env";

const REQUIRED_TABLES = ["mailboxes", "messages"] as const;

export async function handleHealth(env: Env): Promise<Response> {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };

  try {
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('mailboxes', 'messages')`,
    ).all<{ name: string }>();

    const present = new Set((rows.results ?? []).map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((name) => !present.has(name));
    const ready = missing.length === 0;

    return json(
      {
        ok: ready,
        service: "postgrove",
        db: ready ? "ready" : "migrations_pending",
        missing,
      },
      ready ? 200 : 503,
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
