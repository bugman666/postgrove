import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApi } from "../src/api.ts";
import { OWNER_SESSION_COOKIE, signOwnerSession } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import {
  listInboxMessages,
  searchInboxMessages,
  type MailboxRecord,
  type MessageRecord,
} from "../src/store.ts";
import {
  compareSearchRank,
  escapeFts5Query,
  SEARCH_ENGINE_FTS5,
  SEARCH_ENGINE_LIKE,
  searchRankScore,
} from "../src/triage.ts";

const SECRET = "change-me-local-session-secret";
const OWNER = "change-me-local-owner-token";
const ADMIN = "change-me-local-admin-token";
const MAILBOX_ID = "11111111-1111-4111-8111-111111111111";
const ADDRESS = "inbox@example.test";

const MAILBOX: MailboxRecord = {
  id: MAILBOX_ID,
  address: ADDRESS,
  local_part: "inbox",
  domain: "example.test",
  display_name: "Local inbox",
  status: "active",
};

function row(partial: Partial<MessageRecord> & { id: string }): MessageRecord {
  return {
    mailbox_id: MAILBOX_ID,
    rfc_message_id: `<${partial.id}@example.test>`,
    envelope_from: "sender@example.test",
    envelope_to: ADDRESS,
    subject: null,
    snippet: null,
    body_text: null,
    header_to: null,
    header_cc: null,
    header_reply_to: null,
    in_reply_to: null,
    references_header: null,
    size_bytes: 100,
    is_read: 0,
    is_starred: 0,
    folder: "inbox",
    received_at: 1,
    created_at: 1,
    ...partial,
  };
}

function rankingMessages(): MessageRecord[] {
  return [
    row({
      id: "body-hit",
      envelope_from: "notes@grove.test",
      subject: "Weekly notes",
      body_text: "Please review the invoice before Friday.",
      received_at: 300,
    }),
    row({
      id: "subject-hit",
      envelope_from: "billing@grove.test",
      subject: "Invoice for March",
      body_text: "Attached is the statement.",
      received_at: 100,
    }),
    row({
      id: "from-hit",
      envelope_from: "invoice-bot@grove.test",
      subject: "Hello",
      body_text: "No money talk here.",
      received_at: 200,
    }),
  ];
}

interface State {
  mailboxes: MailboxRecord[];
  messages: MessageRecord[];
  fts: boolean;
  sql: string[];
}

function freshState(fts = false): State {
  return {
    mailboxes: [{ ...MAILBOX }],
    messages: rankingMessages(),
    fts,
    sql: [],
  };
}

function env(state: State): Env {
  return {
    DB: fakeDb(state),
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
    ADMIN_TOKEN: ADMIN,
  };
}

function fakeDb(state: State): D1Database {
  const bound = (sql: string, params: unknown[]) => ({
    async first() {
      const result = exec(sql, params, state);
      if (Array.isArray(result)) {
        return result[0] ?? null;
      }
      return result;
    },
    async all() {
      const result = exec(sql, params, state);
      const results = Array.isArray(result) ? result : result ? [result] : [];
      return { results };
    },
    async run() {
      return { meta: { changes: 0 } };
    },
  });

  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return bound(sql, params);
        },
        ...bound(sql, []),
      };
    },
  } as unknown as D1Database;
}

function exec(sql: string, params: unknown[], state: State): unknown {
  const text = sql.replace(/\s+/g, " ");
  state.sql.push(text);

  if (/sqlite_master/i.test(text) && /messages_fts/i.test(text)) {
    return state.fts ? { ok: 1 } : null;
  }

  if (/FROM mailboxes/i.test(text)) {
    if (/WHERE address/i.test(text)) {
      const key = String(params[0] ?? "").toLowerCase();
      return state.mailboxes.find((box) => box.address === key) ?? null;
    }
    if (/WHERE id/i.test(text)) {
      return state.mailboxes.find((box) => box.id === params[0]) ?? null;
    }
    return state.mailboxes[0] ?? null;
  }

  if (/COUNT\(\*\) AS unread_count/i.test(text)) {
    return {
      unread_count: state.messages.filter(
        (item) => item.mailbox_id === String(params[0]) && item.folder === "inbox" && item.is_read === 0,
      ).length,
    };
  }

  if (/messages_fts MATCH/i.test(text)) {
    const mailboxId = String(params[0]);
    const tokens = ftsTokensFromMatch(String(params[1] ?? ""));
    let rows = state.messages.filter((item) => item.mailbox_id === mailboxId && item.folder === "inbox");
    if (/is_read = 0/i.test(text)) {
      rows = rows.filter((item) => item.is_read === 0);
    }
    if (/is_starred = 1/i.test(text)) {
      rows = rows.filter((item) => item.is_starred === 1);
    }
    const needle = tokens.join("");
    rows = rows.filter((item) => tokens.every((token) => haystack(item).includes(token)));
    return rows.sort((a, b) => compareSearchRank(a, b, needle));
  }

  if (/FROM messages/i.test(text) && /SELECT/i.test(text)) {
    let rows = state.messages.filter((item) => item.folder === "inbox");
    if (/mailbox_id = \?1/i.test(text)) {
      rows = rows.filter((item) => item.mailbox_id === params[0]);
    }
    if (/is_read = 0/i.test(text)) {
      rows = rows.filter((item) => item.is_read === 0);
    }
    if (/is_starred = 1/i.test(text)) {
      rows = rows.filter((item) => item.is_starred === 1);
    }
    if (/LIKE/i.test(text)) {
      const q = fromLikeContains(String(params[1] ?? ""));
      rows = rows.filter((item) => haystack(item).includes(q.toLowerCase()));
    }
    return rows.sort((a, b) => b.received_at - a.received_at);
  }

  return null;
}

function haystack(item: MessageRecord): string {
  return [item.envelope_from, item.envelope_to, item.subject ?? "", item.body_text ?? ""]
    .join("\n")
    .toLowerCase();
}

function fromLikeContains(pattern: string): string {
  let inner = pattern;
  if (inner.startsWith("%")) {
    inner = inner.slice(1);
  }
  if (inner.endsWith("%")) {
    inner = inner.slice(0, -1);
  }
  return inner.replace(/\\%/g, "%").replace(/\\_/g, "_").replace(/\\\\/g, "\\");
}

function ftsTokensFromMatch(match: string): string[] {
  return [...match.matchAll(/"([^"]+)"/g)].map((item) => item[1].replace(/\*$/, "").replace(/ /g, "").toLowerCase());
}

test("FTS5 query escape strips operators and keeps searchable tokens", () => {
  assert.equal(escapeFts5Query("  invoice  "), '"invoice"*');
  assert.equal(escapeFts5Query("billing@grove.test"), '"billing"* AND "grove"* AND "test"*');
  assert.equal(escapeFts5Query("本月账单已出"), '"本 月 账 单 已 出"');
  assert.equal(escapeFts5Query("账"), '"账"');
  assert.equal(escapeFts5Query("%"), null);
  assert.equal(escapeFts5Query("*"), null);
  assert.equal(escapeFts5Query('AND OR NOT "" ^^'), null);
  assert.equal(escapeFts5Query("foo AND bar"), '"foo"* AND "bar"*');
  assert.equal(escapeFts5Query("subject:invoice^2"), '"subject"* AND "invoice"*');
  assert.equal(escapeFts5Query("a"), null);
  assert.equal(escapeFts5Query("100%_off"), '"100"* AND "off"*');
});

test("ranking basics: subject beats from beats body", () => {
  const [bodyHit, subjectHit, fromHit] = rankingMessages();
  assert.ok(searchRankScore(subjectHit, "invoice") > searchRankScore(fromHit, "invoice"));
  assert.ok(searchRankScore(fromHit, "invoice") > searchRankScore(bodyHit, "invoice"));
  const ordered = [bodyHit, fromHit, subjectHit].sort((a, b) => compareSearchRank(a, b, "invoice"));
  assert.deepEqual(
    ordered.map((item) => item.id),
    ["subject-hit", "from-hit", "body-hit"],
  );
});

test("search falls back to LIKE when messages_fts is missing", async () => {
  const state = freshState(false);
  const found = await searchInboxMessages(env(state), MAILBOX_ID, { q: "invoice" });
  assert.equal(found.engine, SEARCH_ENGINE_LIKE);
  assert.ok(found.messages.some((item) => item.id === "subject-hit"));
  assert.ok(state.sql.some((sql) => /LIKE/i.test(sql)));
  assert.ok(state.sql.every((sql) => !/MATCH/i.test(sql)));
});

test("search uses FTS5 MATCH and ranks subject first when the index exists", async () => {
  const state = freshState(true);
  const found = await searchInboxMessages(env(state), MAILBOX_ID, { q: "invoice" });
  assert.equal(found.engine, SEARCH_ENGINE_FTS5);
  assert.deepEqual(
    found.messages.map((item) => item.id),
    ["subject-hit", "from-hit", "body-hit"],
  );
  assert.ok(state.sql.some((sql) => /messages_fts MATCH/i.test(sql)));
  assert.ok(state.sql.some((sql) => /bm25\(messages_fts, 4.0, 3.0, 8.0, 1.0\)/i.test(sql)));
  assert.ok(state.sql.every((sql) => !/LIKE/i.test(sql)));
});

test("FTS5 sanitizer yields zero hits for operator-only queries", async () => {
  const state = freshState(true);
  const found = await searchInboxMessages(env(state), MAILBOX_ID, { q: "% AND OR *" });
  assert.equal(found.engine, SEARCH_ENGINE_FTS5);
  assert.deepEqual(found.messages, []);
  assert.ok(state.sql.every((sql) => !/MATCH/i.test(sql)));
});

test("listInboxMessages still returns the FTS hit set without an engine field", async () => {
  const hits = await listInboxMessages(env(freshState(true)), MAILBOX_ID, { q: "invoice" });
  assert.equal(hits[0]?.id, "subject-hit");
});

test("GET /api/search reports the engine that ran", async () => {
  const token = await signOwnerSession(SECRET, { mailboxId: MAILBOX_ID, address: ADDRESS });
  const likeState = freshState(false);
  const likeRes = await handleApi(
    new Request("http://127.0.0.1:8787/api/search?q=invoice", {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    env(likeState),
    new URL("http://127.0.0.1:8787/api/search?q=invoice"),
  );
  assert.equal(likeRes.status, 200);
  const likeBody = (await likeRes.json()) as { engine: string; messages: { id: string }[] };
  assert.equal(likeBody.engine, SEARCH_ENGINE_LIKE);
  assert.ok(likeBody.messages.some((item) => item.id === "subject-hit"));

  const ftsState = freshState(true);
  const ftsRes = await handleApi(
    new Request("http://127.0.0.1:8787/api/search?q=invoice", {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    env(ftsState),
    new URL("http://127.0.0.1:8787/api/search?q=invoice"),
  );
  assert.equal(ftsRes.status, 200);
  const ftsBody = (await ftsRes.json()) as { engine: string; messages: { id: string }[] };
  assert.equal(ftsBody.engine, SEARCH_ENGINE_FTS5);
  assert.deepEqual(
    ftsBody.messages.map((item) => item.id),
    ["subject-hit", "from-hit", "body-hit"],
  );
});
