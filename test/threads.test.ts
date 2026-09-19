import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWNER_SESSION_COOKIE,
  requireOwner,
  signOwnerSession,
} from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import { handleInbound } from "../src/inbound.ts";
import {
  ensureMailboxThreadIds,
  insertSentMessage,
  listInboxMessages,
  listInboxMessagesByThreadId,
  persistThreadIdOnRecord,
  type MailboxRecord,
  type MessageRecord,
} from "../src/store.ts";
import {
  citationIds,
  findThreadById,
  groupMessagesByStoredThreadId,
  groupMessagesIntoThreads,
  latestThreadMessage,
  normalizeThreadSubject,
  participantKey,
  resolveThreadIdForInsert,
  stableThreadId,
} from "../src/threads.ts";
import type { InboundEmail } from "../src/env.ts";

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
    thread_id: null,
    ...partial,
  };
}

function citedConversation(): MessageRecord[] {
  return [
    row({
      id: "root",
      rfc_message_id: "<seed-sync-root@example.test>",
      envelope_from: "lead@grove.test",
      subject: "本周同步",
      snippet: "先看议程",
      body_text: "先看议程。",
      received_at: 100,
      created_at: 100,
    }),
    row({
      id: "reply",
      rfc_message_id: "<seed-sync@example.test>",
      envelope_from: "teammate@grove.test",
      subject: "Re: 本周同步",
      snippet: "收到",
      body_text: "收到。",
      in_reply_to: "<seed-sync-root@example.test>",
      references_header: "<seed-sync-root@example.test>",
      received_at: 300,
      created_at: 300,
    }),
    row({
      id: "reply-2",
      rfc_message_id: "<seed-sync-reply@example.test>",
      envelope_from: "notes@grove.test",
      subject: "Re: 本周同步",
      snippet: "纪要稍后发",
      body_text: "纪要稍后发。",
      in_reply_to: "<seed-sync@example.test>",
      references_header: "<seed-sync-root@example.test> <seed-sync@example.test>",
      received_at: 200,
      created_at: 200,
    }),
    row({
      id: "unrelated",
      rfc_message_id: "<invoice@example.test>",
      envelope_from: "billing@grove.test",
      subject: "本月账单已出",
      snippet: "账单",
      body_text: "账单",
      received_at: 400,
      created_at: 400,
    }),
  ];
}

function subjectFallbackConversation(): MessageRecord[] {
  return [
    row({
      id: "keys-1",
      envelope_from: "neighbor@example.test",
      envelope_to: ADDRESS,
      subject: "办公室钥匙",
      snippet: "第一封",
      body_text: "第一封",
      received_at: 10,
    }),
    row({
      id: "keys-2",
      envelope_from: ADDRESS,
      envelope_to: "neighbor@example.test",
      subject: "Re: 办公室钥匙",
      snippet: "第二封",
      body_text: "第二封",
      received_at: 20,
    }),
    row({
      id: "other-people",
      envelope_from: "other@grove.test",
      envelope_to: ADDRESS,
      subject: "办公室钥匙",
      snippet: "别人的同主题",
      body_text: "别人的同主题",
      received_at: 30,
    }),
  ];
}

interface State {
  mailboxes: MailboxRecord[];
  messages: MessageRecord[];
}

function freshState(messages = citedConversation()): State {
  return {
    mailboxes: [{ ...MAILBOX }],
    messages,
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
    if (/mailbox_id = \?1/i.test(text)) {
      rows = rows.filter((item) => item.mailbox_id === params[0]);
    }
    return rows.sort((a, b) => b.received_at - a.received_at);
  }

  return null;
}

async function ownerCookie(): Promise<string> {
  const token = await signOwnerSession(SECRET, { mailboxId: MAILBOX_ID, address: ADDRESS });
  return `${OWNER_SESSION_COOKIE}=${token}`;
}

test("normalizeThreadSubject strips repeated Re:/Fwd: prefixes", () => {
  assert.equal(normalizeThreadSubject("Re: Re: 办公室钥匙"), "办公室钥匙");
  assert.equal(normalizeThreadSubject("Fwd: 本周同步"), "本周同步");
  assert.equal(normalizeThreadSubject("回复：已有"), "已有");
  assert.equal(normalizeThreadSubject("  "), "");
  assert.equal(participantKey(row({ id: "x", envelope_from: "A@Grove.test", envelope_to: ADDRESS })), "a@grove.test,inbox@example.test");
});

test("TC9.1 messages linked by In-Reply-To / References are one thread with a count", () => {
  const threads = groupMessagesIntoThreads(citedConversation());
  assert.equal(threads.length, 2);
  const sync = threads.find((thread) => thread.messages.some((item) => item.id === "root"));
  assert.ok(sync);
  assert.equal(sync.kind, "citation");
  assert.equal(sync.messages.length, 3);
  assert.equal(sync.id, "mid:seed-sync-root@example.test");
  assert.deepEqual(sync.messages.map((item) => item.id).sort(), ["reply", "reply-2", "root"]);
  const invoice = threads.find((thread) => thread.messages.some((item) => item.id === "unrelated"));
  assert.ok(invoice);
  assert.equal(invoice.messages.length, 1);
});

test("TC9.1 replies that only share a missing parent Message-ID still group", () => {
  const threads = groupMessagesIntoThreads([
    row({
      id: "a",
      rfc_message_id: "<a@x>",
      in_reply_to: "<missing-root@x>",
      references_header: "<missing-root@x>",
      received_at: 1,
    }),
    row({
      id: "b",
      rfc_message_id: "<b@x>",
      in_reply_to: "<missing-root@x>",
      received_at: 2,
    }),
  ]);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].messages.length, 2);
  assert.equal(citationIds(threads[0].messages[0])[0], "<missing-root@x>");
});

test("TC9.2 opening a thread lists members in received_at order", () => {
  const threads = groupMessagesIntoThreads(citedConversation());
  const sync = findThreadById(threads, "mid:seed-sync-root@example.test");
  assert.ok(sync);
  assert.deepEqual(
    sync.messages.map((item) => item.id),
    ["root", "reply-2", "reply"],
  );
  assert.ok(sync.messages[0].received_at <= sync.messages[1].received_at);
  assert.ok(sync.messages[1].received_at <= sync.messages[2].received_at);
  assert.match(sync.messages[0].body_text ?? "", /先看议程/);
  assert.match(sync.messages[2].body_text ?? "", /收到/);
});

test("TC9.3 subject-only fallback groups Re: variants for the same participants", () => {
  const threads = groupMessagesIntoThreads(subjectFallbackConversation());
  const keys = threads.find((thread) => thread.kind === "subject" && thread.messages.length === 2);
  assert.ok(keys);
  assert.deepEqual(
    keys.messages.map((item) => item.id),
    ["keys-1", "keys-2"],
  );
  assert.equal(keys.id, stableThreadId(keys.messages, "subject"));
  const other = threads.find((thread) => thread.messages.some((item) => item.id === "other-people"));
  assert.ok(other);
  assert.equal(other.messages.length, 1);
});

test("empty subjects do not collapse into one fallback thread", () => {
  const threads = groupMessagesIntoThreads([
    row({ id: "blank-a", subject: "", envelope_from: "a@x.test", received_at: 1 }),
    row({ id: "blank-b", subject: "   ", envelope_from: "a@x.test", received_at: 2 }),
  ]);
  assert.equal(threads.length, 2);
});

test("TC9.4 unauthenticated thread API and UI paths are 401", async () => {
  const blank = env(freshState());
  for (const path of [
    "/api/threads",
    "/api/threads/mid:seed-sync-root@example.test",
    "/box/11111111-1111-4111-8111-111111111111/t/mid:seed-sync-root@example.test",
  ]) {
    const missing = await requireOwner(new Request(`http://127.0.0.1:8787${path}`), blank);
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.response.status, 401);
      const body = (await missing.response.json()) as { error: string };
      assert.equal(body.error, "unauthorized");
    }
  }

  const token = await signOwnerSession(SECRET, { mailboxId: MAILBOX_ID, address: ADDRESS });
  const ok = await requireOwner(
    new Request("http://127.0.0.1:8787/api/threads", {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    blank,
  );
  assert.equal(ok.ok, true);
});

test("authenticated inbox list groups into threads with counts and time order", async () => {
  const state = freshState();
  const messages = await listInboxMessages(env(state), MAILBOX_ID);
  const threads = groupMessagesIntoThreads(messages);
  const sync = findThreadById(threads, "mid:seed-sync-root@example.test");
  assert.ok(sync);
  assert.equal(sync.kind, "citation");
  assert.equal(sync.messages.length, 3);
  assert.deepEqual(
    sync.messages.map((item) => item.id),
    ["root", "reply-2", "reply"],
  );
  assert.equal(latestThreadMessage(sync).id, "reply");
  const cookie = await ownerCookie();
  assert.match(cookie, /postgrove_session=/);
});

test("citation root id is mid: from the first References token", () => {
  const reply = row({
    id: "only-reply",
    rfc_message_id: "<child@x>",
    in_reply_to: "<parent@x>",
    references_header: "<seed-sync-root@example.test> <parent@x>",
    received_at: 2,
  });
  assert.equal(stableThreadId([reply], "citation"), "mid:seed-sync-root@example.test");
});

test("a reply that only cites its parent inherits the conversation root id", () => {
  const root = row({
    id: "root",
    rfc_message_id: "<root@x>",
    subject: "本周同步",
    received_at: 1,
    thread_id: "mid:root@x",
  });
  const parent = row({
    id: "parent",
    rfc_message_id: "<parent@x>",
    in_reply_to: "<root@x>",
    references_header: "<root@x>",
    received_at: 2,
    thread_id: "mid:root@x",
  });
  const late = row({
    id: "late",
    rfc_message_id: "<late@x>",
    in_reply_to: "<parent@x>",
    references_header: "<parent@x>",
    received_at: 3,
  });
  const windowOnly = groupMessagesIntoThreads([late]);
  assert.equal(windowOnly[0]?.id, "mid:parent@x");

  const resolved = resolveThreadIdForInsert(late, [root, parent]);
  assert.equal(resolved.threadId, "mid:root@x");
  assert.equal(resolved.kind, "citation");
});

test("stored thread_id keeps citation members grouped when the root is outside the window", () => {
  const rootId = "mid:root@x";
  const root = row({
    id: "root",
    rfc_message_id: "<root@x>",
    subject: "本周同步",
    received_at: 1,
    thread_id: rootId,
  });
  const parent = row({
    id: "parent",
    rfc_message_id: "<parent@x>",
    in_reply_to: "<root@x>",
    references_header: "<root@x>",
    received_at: 2,
    thread_id: rootId,
  });
  const fillers = Array.from({ length: 3 }, (_, index) =>
    row({
      id: `fill-${index}`,
      rfc_message_id: `<fill-${index}@x>`,
      subject: `filler ${index}`,
      envelope_from: `n${index}@grove.test`,
      received_at: 10 + index,
      thread_id: `solo:fill-${index}`,
    }),
  );
  const late = row({
    id: "late",
    rfc_message_id: "<late@x>",
    in_reply_to: "<parent@x>",
    references_header: "<parent@x>",
    received_at: 50,
    thread_id: rootId,
  });
  const window = [...fillers, late];
  const recomputed = groupMessagesIntoThreads(window);
  assert.equal(findThreadById(recomputed, rootId), null);
  assert.equal(recomputed.find((thread) => thread.messages.some((item) => item.id === "late"))?.id, "mid:parent@x");

  const stored = groupMessagesByStoredThreadId(window);
  const thread = findThreadById(stored, rootId);
  assert.ok(thread);
  assert.equal(thread.kind, "citation");
  assert.deepEqual(thread.messages.map((item) => item.id), ["late"]);
  assert.equal(findThreadById(groupMessagesByStoredThreadId([root, parent, late]), rootId)?.messages.length, 3);
});

test("persist + open by stored id returns the citation root outside the list window", async () => {
  const db = new ThreadMemoryD1();
  const testEnv = persistEnv(db);
  const root = await persistThreadIdOnRecord(
    testEnv,
    MAILBOX_ID,
    row({
      id: "root",
      rfc_message_id: "<root@x>",
      subject: "本周同步",
      received_at: 1,
      created_at: 1,
    }),
  );
  db.messages.push(root);
  const parent = await persistThreadIdOnRecord(
    testEnv,
    MAILBOX_ID,
    row({
      id: "parent",
      rfc_message_id: "<parent@x>",
      in_reply_to: "<root@x>",
      references_header: "<root@x>",
      subject: "Re: 本周同步",
      received_at: 2,
      created_at: 2,
    }),
  );
  db.messages.push(parent);
  for (let index = 0; index < 5; index += 1) {
    const fill = await persistThreadIdOnRecord(
      testEnv,
      MAILBOX_ID,
      row({
        id: `fill-${index}`,
        rfc_message_id: `<fill-${index}@x>`,
        subject: `filler ${index}`,
        envelope_from: `n${index}@grove.test`,
        received_at: 10 + index,
        created_at: 10 + index,
      }),
    );
    db.messages.push(fill);
  }
  const late = await persistThreadIdOnRecord(
    testEnv,
    MAILBOX_ID,
    row({
      id: "late",
      rfc_message_id: "<late@x>",
      in_reply_to: "<parent@x>",
      references_header: "<parent@x>",
      subject: "Re: 本周同步",
      received_at: 50,
      created_at: 50,
    }),
  );
  db.messages.push(late);

  assert.equal(root.thread_id, "mid:root@x");
  assert.equal(parent.thread_id, "mid:root@x");
  assert.equal(late.thread_id, "mid:root@x");

  const listed = db.messages
    .filter((item) => item.folder === "inbox")
    .sort((a, b) => b.received_at - a.received_at)
    .slice(0, 6);
  assert.equal(listed.some((item) => item.id === "root"), false);
  const windowThreads = groupMessagesByStoredThreadId(listed as MessageRecord[]);
  assert.ok(findThreadById(windowThreads, "mid:root@x"));

  const members = await listInboxMessagesByThreadId(testEnv, MAILBOX_ID, "mid:root@x");
  assert.deepEqual(members.map((item) => item.id), ["root", "parent", "late"]);
});

test("backfill assigns the same ids as groupMessagesIntoThreads", async () => {
  const db = new ThreadMemoryD1();
  const testEnv = persistEnv(db);
  for (const message of citedConversation()) {
    db.messages.push({ ...message, thread_id: null });
  }
  const assigned = await ensureMailboxThreadIds(testEnv, MAILBOX_ID);
  assert.ok(assigned >= 4);
  const expected = groupMessagesIntoThreads(citedConversation());
  for (const thread of expected) {
    for (const member of thread.messages) {
      const stored = db.messages.find((item) => item.id === member.id);
      assert.equal(stored?.thread_id, thread.id, member.id);
    }
  }
});

test("inbound insert persists a citation thread_id", async () => {
  const db = new ThreadMemoryD1();
  db.messages.push(
    row({
      id: "root",
      rfc_message_id: "<inbound-root@x>",
      subject: "Weekly sync",
      received_at: 1,
      thread_id: "mid:inbound-root@x",
    }),
  );
  const raw = [
    "From: teammate@grove.test",
    "To: inbox@example.test",
    "Subject: Re: Weekly sync",
    "Message-ID: <inbound-reply@x>",
    "In-Reply-To: <inbound-root@x>",
    "References: <inbound-root@x>",
    "",
    "Got it.",
    "",
  ].join("\r\n");
  await handleInbound(inboundMail(raw), persistEnv(db));
  const stored = db.messages.find((item) => item.rfc_message_id === "<inbound-reply@x>");
  assert.ok(stored);
  assert.equal(stored.thread_id, "mid:inbound-root@x");
});

test("outbound send path persists thread_id from In-Reply-To / References", async () => {
  const db = new ThreadMemoryD1();
  db.messages.push(
    row({
      id: "root",
      rfc_message_id: "<out-root@x>",
      subject: "本周同步",
      received_at: 1,
      thread_id: "mid:out-root@x",
    }),
  );
  const sent = await insertSentMessage(
    persistEnv(db),
    MAILBOX,
    {
      to: "lead@grove.test",
      cc: "",
      subject: "Re: 本周同步",
      text: "收到。",
      inReplyTo: "<out-root@x>",
      references: "<out-root@x>",
    },
    9,
  );
  assert.equal(sent.folder, "sent");
  assert.equal(sent.thread_id, "mid:out-root@x");
  assert.equal(db.messages.find((item) => item.id === sent.id)?.thread_id, "mid:out-root@x");
});

type Row = Record<string, unknown>;

class ThreadMemoryD1 {
  mailboxes: Row[] = [{ ...MAILBOX, created_at: 1, updated_at: 1 }];
  messages: Row[] = [];

  prepare(sql: string) {
    return new ThreadMemoryStatement(this, sql);
  }
}

class ThreadMemoryStatement {
  db: ThreadMemoryD1;
  sql: string;
  binds: unknown[] = [];

  constructor(db: ThreadMemoryD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.binds = args;
    return this;
  }

  async first() {
    return this.rows()[0] ?? null;
  }

  async all() {
    return { results: this.rows() };
  }

  async run() {
    return { meta: { changes: this.mutate() } };
  }

  rows(): Row[] {
    const sql = collapse(this.sql);
    const [a, b] = this.binds;
    if (sql.includes("from mailboxes")) {
      if (sql.includes("where address =")) {
        return this.db.mailboxes.filter((row) => row.address === String(a).toLowerCase());
      }
      if (sql.includes("where id =")) {
        return this.db.mailboxes.filter((row) => row.id === a);
      }
      return this.db.mailboxes;
    }
    if (sql.includes("from messages")) {
      let rows = this.db.messages.slice();
      if (sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      if (sql.includes("folder = 'inbox'")) {
        rows = rows.filter((row) => row.folder === "inbox");
      }
      if (sql.includes("thread_id is null")) {
        rows = rows.filter((row) => row.thread_id == null || row.thread_id === "");
      }
      if (sql.includes("thread_id = ?2")) {
        rows = rows.filter((row) => row.thread_id === b);
      }
      if (sql.includes("rfc_message_id in") || sql.includes("in_reply_to in")) {
        const ids = inBindValues(this.sql, this.binds);
        rows = rows.filter(
          (row) => ids.includes(String(row.rfc_message_id ?? "")) || ids.includes(String(row.in_reply_to ?? "")),
        );
      } else if (sql.includes("thread_id in")) {
        const ids = inBindValues(this.sql, this.binds);
        rows = rows.filter((row) => ids.includes(String(row.thread_id ?? "")));
      } else if (/\bid in \(/i.test(sql) && !sql.startsWith("update")) {
        const ids = inBindValues(this.sql, this.binds);
        rows = rows.filter((row) => ids.includes(String(row.id)));
      }
      return rows.sort((left, right) => Number(left.received_at) - Number(right.received_at));
    }
    if (sql.includes("from users") || sql.includes("from inbound_hooks") || sql.includes("from dev_inboxes")) {
      return [];
    }
    return [];
  }

  mutate(): number {
    const sql = collapse(this.sql);
    const binds = this.binds;
    if (sql.startsWith("insert into messages")) {
      const inbound = !sql.includes("is_starred");
      this.db.messages.unshift({
        id: binds[0],
        mailbox_id: binds[1],
        rfc_message_id: binds[2],
        envelope_from: binds[3],
        envelope_to: binds[4],
        subject: binds[5],
        snippet: binds[6],
        body_text: binds[7],
        header_to: binds[8],
        header_cc: binds[9],
        header_reply_to: binds[10],
        in_reply_to: binds[11],
        references_header: binds[12],
        size_bytes: binds[13],
        is_read: inbound ? 0 : binds[14],
        is_starred: inbound ? 0 : binds[15],
        folder: inbound ? "inbox" : binds[16],
        received_at: inbound ? binds[14] : binds[17],
        created_at: inbound ? binds[14] : binds[18],
        thread_id: inbound ? binds[15] : binds[19],
      });
      return 1;
    }
    if (sql.startsWith("update messages set thread_id")) {
      const threadId = binds[1];
      const ids = new Set(inBindValues(this.sql, this.binds));
      let changes = 0;
      for (const row of this.db.messages) {
        if (row.mailbox_id === binds[0] && ids.has(String(row.id))) {
          row.thread_id = threadId;
          changes += 1;
        }
      }
      return changes;
    }
    return 0;
  }
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function inBindValues(sql: string, params: unknown[]): string[] {
  const match = sql.match(/IN \(([^)]+)\)/i);
  if (!match) {
    return [];
  }
  const nums = [...match[1].matchAll(/\?(\d+)/g)].map((item) => Number(item[1]));
  return nums.map((n) => String(params[n - 1] ?? "")).filter(Boolean);
}

function persistEnv(db: ThreadMemoryD1): Env {
  return {
    DB: db as unknown as D1Database,
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
    ADMIN_TOKEN: ADMIN,
  };
}

function inboundMail(raw: string): InboundEmail {
  const headers = new Headers();
  for (const line of raw.split("\r\n")) {
    if (!line) {
      break;
    }
    const at = line.indexOf(":");
    if (at > 0) {
      headers.set(line.slice(0, at), line.slice(at + 1).trim());
    }
  }
  return {
    from: "teammate@grove.test",
    to: ADDRESS,
    headers,
    raw: new Blob([raw]).stream(),
    rawSize: raw.length,
    setReject() {},
  };
}
