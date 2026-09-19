import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWNER_SESSION_COOKIE,
  requireOwner,
  signOwnerSession,
} from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import {
  countUnreadInbox,
  listInboxMessages,
  setRead,
  setStarred,
  type MailboxRecord,
  type MessageRecord,
} from "../src/store.ts";
import {
  applyInboxFilter,
  escapeLike,
  likeContains,
  messageMatchesQuery,
  parseInboxFilter,
  parseSearchQuery,
  SEARCH_ENGINE,
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

function sampleMessages(): MessageRecord[] {
  return [
    row({
      id: "welcome",
      envelope_from: "neighbor@example.test",
      subject: "欢迎使用本地收件箱",
      snippet: "这是一封已读的种子信",
      body_text: "你好，这是一封已读的种子信，用来核对阅读页正文。",
      is_read: 1,
      is_starred: 1,
      received_at: 100,
    }),
    row({
      id: "invoice",
      envelope_from: "billing@grove.test",
      subject: "本月账单已出",
      snippet: "本地种子：未读",
      body_text: "本地种子：未读、有发件人、主题和时间。",
      is_read: 0,
      is_starred: 0,
      received_at: 200,
    }),
    row({
      id: "code",
      envelope_from: "noreply@verify.test",
      subject: "你的确认码",
      snippet: "确认码 482193",
      body_text: "确认码 482193。这是未读种子信。",
      is_read: 0,
      is_starred: 0,
      received_at: 300,
    }),
  ];
}

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

interface State {
  mailboxes: MailboxRecord[];
  messages: MessageRecord[];
}

function freshState(): State {
  return {
    mailboxes: [{ ...MAILBOX }],
    messages: sampleMessages(),
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
      const result = exec(sql, params, state);
      const changes =
        result && typeof result === "object" && "changes" in result
          ? Number((result as { changes: number }).changes)
          : 0;
      return { meta: { changes } };
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

  if (/UPDATE messages SET is_read/i.test(text)) {
    const found = inboxRow(state, String(params[0]), String(params[1]));
    if (!found) {
      return { changes: 0 };
    }
    found.is_read = Number(params[2]);
    return { changes: 1 };
  }

  if (/UPDATE messages SET is_starred/i.test(text)) {
    const found = inboxRow(state, String(params[0]), String(params[1]));
    if (!found) {
      return { changes: 0 };
    }
    found.is_starred = Number(params[2]);
    return { changes: 1 };
  }

  if (/COUNT\(\*\) AS unread_count/i.test(text)) {
    const mailboxId = String(params[0]);
    const unread_count = state.messages.filter(
      (item) => item.mailbox_id === mailboxId && item.folder === "inbox" && item.is_read === 0,
    ).length;
    return { unread_count };
  }

  if (/FROM messages/i.test(text) && /SELECT/i.test(text)) {
    let rows = state.messages.filter((item) => item.folder === "inbox");
    if (/id = \?1 AND mailbox_id = \?2/i.test(text)) {
      return rows.find((item) => item.id === params[0] && item.mailbox_id === params[1]) ?? null;
    }
    if (/id = \?1 AND folder/i.test(text) && !/mailbox_id = \?1/i.test(text)) {
      return rows.find((item) => item.id === params[0]) ?? null;
    }
    if (/mailbox_id = \?1/i.test(text)) {
      rows = rows.filter((item) => item.mailbox_id === params[0]);
    }
    if (/is_read = 0/i.test(text)) {
      rows = applyInboxFilter(rows, "unread");
    }
    if (/is_starred = 1/i.test(text)) {
      rows = applyInboxFilter(rows, "starred");
    }
    if (/LIKE/i.test(text)) {
      const q = fromLikeContains(String(params[1] ?? ""));
      rows = rows.filter((item) => messageMatchesQuery(item, q));
    }
    return rows.sort((a, b) => b.received_at - a.received_at);
  }

  return null;
}

function inboxRow(state: State, messageId: string, mailboxId: string): MessageRecord | undefined {
  return state.messages.find(
    (item) => item.id === messageId && item.mailbox_id === mailboxId && item.folder === "inbox",
  );
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

test("search helpers: LIKE escape and from/subject/body match", () => {
  assert.equal(SEARCH_ENGINE, "like");
  assert.equal(parseInboxFilter("unread"), "unread");
  assert.equal(parseInboxFilter("starred"), "starred");
  assert.equal(parseInboxFilter("nope"), "all");
  assert.equal(parseSearchQuery("  确认码  "), "确认码");
  assert.equal(escapeLike("100%_off\\x"), "100\\%\\_off\\\\x");
  assert.equal(likeContains("账单"), "%账单%");

  const invoice = sampleMessages()[1];
  assert.equal(messageMatchesQuery(invoice, "本月账单已出"), true);
  assert.equal(messageMatchesQuery(invoice, "billing@grove.test"), true);
  assert.equal(messageMatchesQuery(invoice, "未读、有发件人"), true);
  assert.equal(messageMatchesQuery(invoice, "确认码"), false);
});

test("TC8.7 unauthenticated search and star APIs are 401", async () => {
  const blank = env(freshState());
  const search = await requireOwner(new Request("http://127.0.0.1:8787/api/search?q=确认码"), blank);
  assert.equal(search.ok, false);
  if (!search.ok) {
    assert.equal(search.response.status, 401);
    const body = (await search.response.json()) as { error: string };
    assert.equal(body.error, "unauthorized");
  }

  const star = await requireOwner(
    new Request("http://127.0.0.1:8787/api/messages/welcome/star", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ starred: true }),
    }),
    blank,
  );
  assert.equal(star.ok, false);
  if (!star.ok) {
    assert.equal(star.response.status, 401);
  }

  const token = await signOwnerSession(SECRET, { mailboxId: MAILBOX_ID, address: ADDRESS });
  const ok = await requireOwner(
    new Request("http://127.0.0.1:8787/api/search?q=确认码", {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    blank,
  );
  assert.equal(ok.ok, true);
});

test("TC8.1–8.3 search hits subject, from, and body", async () => {
  const state = freshState();
  const db = env(state);

  const subject = await listInboxMessages(db, MAILBOX_ID, { q: "本月账单已出" });
  assert.deepEqual(subject.map((item) => item.id), ["invoice"]);

  const from = await listInboxMessages(db, MAILBOX_ID, { q: "billing@grove.test" });
  assert.deepEqual(from.map((item) => item.id), ["invoice"]);

  const body = await listInboxMessages(db, MAILBOX_ID, { q: "482193" });
  assert.deepEqual(body.map((item) => item.id), ["code"]);
});

test("LIKE wildcards in the query do not match every row", async () => {
  const hits = await listInboxMessages(env(freshState()), MAILBOX_ID, { q: "%" });
  assert.equal(hits.length, 0);
});

test("TC8.4 read/unread toggle updates unread count", async () => {
  const state = freshState();
  const db = env(state);
  assert.equal(await countUnreadInbox(db, MAILBOX_ID), 2);

  assert.equal(await setRead(db, MAILBOX_ID, "code", true), true);
  assert.equal(state.messages.find((item) => item.id === "code")?.is_read, 1);
  assert.equal(await countUnreadInbox(db, MAILBOX_ID), 1);

  assert.equal(await setRead(db, MAILBOX_ID, "code", false), true);
  assert.equal(state.messages.find((item) => item.id === "code")?.is_read, 0);
  assert.equal(await countUnreadInbox(db, MAILBOX_ID), 2);
});

test("TC8.5 star/unstar persists and starred filter works", async () => {
  const state = freshState();
  const db = env(state);

  assert.equal(await setStarred(db, MAILBOX_ID, "invoice", true), true);
  assert.equal(state.messages.find((item) => item.id === "invoice")?.is_starred, 1);

  const starred = await listInboxMessages(db, MAILBOX_ID, { filter: "starred" });
  assert.deepEqual(starred.map((item) => item.id).sort(), ["invoice", "welcome"]);
  assert.ok(starred.every((item) => item.is_starred === 1));

  assert.equal(await setStarred(db, MAILBOX_ID, "invoice", false), true);
  assert.equal(state.messages.find((item) => item.id === "invoice")?.is_starred, 0);
});

test("TC8.6 unread filter view only lists unread rows", async () => {
  const unread = await listInboxMessages(env(freshState()), MAILBOX_ID, { filter: "unread" });
  assert.ok(unread.length > 0);
  assert.ok(unread.every((item) => item.is_read === 0));
  assert.ok(unread.some((item) => item.id === "invoice"));
  assert.ok(unread.some((item) => item.subject === "本月账单已出"));
});
