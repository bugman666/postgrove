import assert from "node:assert/strict";
import { test } from "node:test";
import { listAttachmentsForMessages, type AttachmentRecord } from "../src/attachments.ts";
import { OWNER_SESSION_COOKIE, signOwnerSession } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import { inboxNeedsFullScan, openThreadForRead } from "../src/inbox-read.ts";
import {
  getMailboxMessagesByIds,
  listInboxMessageHeads,
  listInboxMessages,
  markReadMany,
  type MailboxRecord,
  type MessageRecord,
} from "../src/store.ts";
import { handleUi } from "../src/ui.ts";
import { chunkIds, sqlInPlaceholders, uniqueIds } from "../src/sql-in.ts";

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

interface State {
  mailboxes: MailboxRecord[];
  messages: MessageRecord[];
  attachments: AttachmentRecord[];
  sql: string[];
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

function citedConversation(): MessageRecord[] {
  return [
    row({
      id: "root",
      rfc_message_id: "<seed-sync-root@example.test>",
      envelope_from: "lead@grove.test",
      subject: "本周同步",
      snippet: "先看议程",
      body_text: "先看议程。这是根信正文。",
      received_at: 100,
      created_at: 100,
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
      id: "unrelated",
      rfc_message_id: "<invoice@example.test>",
      envelope_from: "billing@grove.test",
      subject: "本月账单已出",
      snippet: "账单",
      body_text: "账单正文不应在会话页展开。",
      is_read: 1,
      received_at: 400,
      created_at: 400,
    }),
  ];
}

function sampleAttachments(): AttachmentRecord[] {
  return [
    {
      id: "att-root",
      message_id: "root",
      mailbox_id: MAILBOX_ID,
      filename: "agenda.txt",
      content_type: "text/plain",
      size_bytes: 12,
      r2_key: "attachments/root/agenda.txt",
      created_at: 100,
    },
    {
      id: "att-reply",
      message_id: "reply",
      mailbox_id: MAILBOX_ID,
      filename: "notes.txt",
      content_type: "text/plain",
      size_bytes: 8,
      r2_key: "attachments/reply/notes.txt",
      created_at: 300,
    },
  ];
}

function freshState(): State {
  return {
    mailboxes: [{ ...MAILBOX }],
    messages: citedConversation(),
    attachments: sampleAttachments(),
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

function parseInIds(sql: string, params: unknown[]): string[] {
  const match = sql.match(/IN \(([^)]+)\)/i);
  if (!match) {
    return [];
  }
  const nums = [...match[1].matchAll(/\?(\d+)/g)].map((item) => Number(item[1]));
  return nums.map((n) => String(params[n - 1] ?? "")).filter(Boolean);
}

function exec(sql: string, params: unknown[], state: State): unknown {
  const text = sql.replace(/\s+/g, " ").trim();
  state.sql.push(text);

  if (/FROM site_settings/i.test(text)) {
    return null;
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

  if (/UPDATE messages SET is_read = 1/i.test(text) && /IN \(/i.test(text)) {
    const mailboxId = String(params[0]);
    const ids = new Set(parseInIds(text, params));
    let changes = 0;
    for (const item of state.messages) {
      if (item.mailbox_id === mailboxId && item.folder === "inbox" && ids.has(item.id) && item.is_read !== 1) {
        item.is_read = 1;
        changes += 1;
      }
    }
    return { changes };
  }

  if (/UPDATE messages SET is_read/i.test(text)) {
    const found = state.messages.find(
      (item) => item.id === params[0] && item.mailbox_id === params[1] && item.folder === "inbox",
    );
    if (!found) {
      return { changes: 0 };
    }
    found.is_read = Number(params[2]);
    return { changes: 1 };
  }

  if (/COUNT\(\*\) AS unread_count/i.test(text)) {
    const mailboxId = String(params[0]);
    return {
      unread_count: state.messages.filter(
        (item) => item.mailbox_id === mailboxId && item.folder === "inbox" && item.is_read === 0,
      ).length,
    };
  }

  if (/FROM attachments/i.test(text)) {
    let rows = state.attachments.filter((item) => item.mailbox_id === params[0]);
    if (/message_id IN/i.test(text)) {
      const ids = new Set(parseInIds(text, params));
      rows = rows.filter((item) => ids.has(item.message_id));
    } else if (/message_id = \?2/i.test(text)) {
      rows = rows.filter((item) => item.message_id === params[1]);
    }
    return rows.sort((a, b) => a.created_at - b.created_at || a.filename.localeCompare(b.filename));
  }

  if (/FROM messages/i.test(text) && /SELECT/i.test(text)) {
    let rows = state.messages.filter((item) => item.folder === "inbox");
    if (/mailbox_id = \?1 AND id IN/i.test(text)) {
      const ids = new Set(parseInIds(text, params));
      rows = rows.filter((item) => item.mailbox_id === params[0] && ids.has(item.id));
      return rows;
    }
    if (/id = \?1 AND mailbox_id = \?2/i.test(text)) {
      return rows.find((item) => item.id === params[0] && item.mailbox_id === params[1]) ?? null;
    }
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
      const q = String(params[1] ?? "").replace(/^%/, "").replace(/%$/, "");
      rows = rows.filter((item) =>
        [item.envelope_from, item.envelope_to, item.subject ?? "", item.body_text ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(q.toLowerCase()),
      );
    }
    if (!/body_text/.test(text) || /IFNULL\(body_text/.test(text) && !/snippet, body_text/.test(text)) {
      rows = rows.map((item) => ({ ...item, body_text: /snippet, body_text/.test(text) ? item.body_text : null }));
    }
    return rows.sort((a, b) => b.received_at - a.received_at);
  }

  return null;
}

async function ownerCookie(): Promise<string> {
  const token = await signOwnerSession(SECRET, { mailboxId: MAILBOX_ID, address: ADDRESS });
  return `${OWNER_SESSION_COOKIE}=${token}`;
}

test("sql-in helpers keep order and chunk", () => {
  assert.equal(sqlInPlaceholders(2, 3), "?2, ?3, ?4");
  assert.deepEqual(uniqueIds(["a", "", "a", "b"]), ["a", "b"]);
  assert.deepEqual(chunkIds(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
  assert.deepEqual(chunkIds([]), []);
});

test("listInboxMessageHeads omits body_text while search still matches it", async () => {
  const state = freshState();
  const heads = await listInboxMessageHeads(env(state), MAILBOX_ID);
  assert.ok(heads.length >= 3);
  assert.ok(heads.every((item) => item.body_text === null));
  const listed = await listInboxMessages(env(state), MAILBOX_ID);
  assert.match(listed.find((item) => item.id === "root")?.body_text ?? "", /先看议程/);

  const hits = await listInboxMessageHeads(env(state), MAILBOX_ID, { q: "先看议程" });
  assert.equal(hits.some((item) => item.id === "root"), true);
  assert.equal(hits[0]?.body_text, null);
});

test("markReadMany and attachment IN lookup are one statement per chunk", async () => {
  const state = freshState();
  const db = env(state);
  state.sql.length = 0;
  const changed = await markReadMany(db, MAILBOX_ID, ["root", "reply-2", "reply", "root"]);
  assert.equal(changed, 3);
  assert.equal(state.messages.filter((item) => item.is_read === 1 && item.id !== "unrelated").length, 3);
  const updates = state.sql.filter((sql) => /UPDATE messages SET is_read = 1/i.test(sql));
  assert.equal(updates.length, 1);
  assert.match(updates[0], /id IN \(\?2, \?3, \?4\)/);

  state.sql.length = 0;
  const atts = await listAttachmentsForMessages(db, MAILBOX_ID, ["root", "reply"]);
  assert.deepEqual(atts.map((item) => item.filename).sort(), ["agenda.txt", "notes.txt"]);
  const attSql = state.sql.filter((sql) => /FROM attachments/i.test(sql));
  assert.equal(attSql.length, 1);
  assert.match(attSql[0], /message_id IN \(\?2, \?3\)/);

  const bodies = await getMailboxMessagesByIds(db, MAILBOX_ID, ["reply", "root"]);
  assert.deepEqual(bodies.map((item) => item.id), ["reply", "root"]);
  assert.match(bodies[1].body_text ?? "", /先看议程/);
});

test("opening a thread scans inbox heads once and does not reload bodies for the whole box", async () => {
  const state = freshState();
  const db = env(state);
  state.sql.length = 0;
  const opened = await openThreadForRead(db, MAILBOX_ID, "mid:seed-sync-root@example.test", {
    q: "",
    filter: "all",
  });
  assert.equal(opened.visible, true);
  assert.ok(opened.thread);
  assert.equal(opened.thread.messages.length, 3);
  assert.match(opened.thread.messages[0].body_text ?? "", /先看议程/);
  assert.equal(opened.attachments.length, 2);
  assert.ok(opened.thread.messages.every((item) => item.is_read === 1));

  const inboxSelects = state.sql.filter(
    (sql) => /SELECT .+ FROM messages/i.test(sql) && /folder = 'inbox'/i.test(sql) && !/id IN/i.test(sql),
  );
  assert.equal(inboxSelects.length, 1, `expected one inbox head scan, got ${inboxSelects.length}: ${inboxSelects.join(" | ")}`);
  assert.equal(inboxSelects[0].includes("snippet, body_text"), false);

  const bodySelects = state.sql.filter((sql) => /FROM messages/i.test(sql) && /id IN/i.test(sql));
  assert.equal(bodySelects.length, 1);
  assert.match(bodySelects[0], /body_text/);

  const markSql = state.sql.filter((sql) => /UPDATE messages SET is_read = 1/i.test(sql));
  assert.equal(markSql.length, 1);
});

test("unread filter still expands the full thread without a second body scan", async () => {
  const state = freshState();
  state.messages.find((item) => item.id === "root")!.is_read = 1;
  const opened = await openThreadForRead(env(state), MAILBOX_ID, "mid:seed-sync-root@example.test", {
    q: "",
    filter: "unread",
  });
  assert.equal(opened.visible, true);
  assert.equal(opened.thread?.messages.length, 3);
  assert.equal(opened.listed.some((item) => item.id === "root" || item.id === "reply"), false);
  assert.ok(inboxNeedsFullScan({ q: "", filter: "unread" }));
  assert.equal(inboxNeedsFullScan({ q: "", filter: "all" }), false);
});

test("GET /box/:id/t/:tid marks the thread read and keeps bodies/attachments", async () => {
  const state = freshState();
  const cookie = await ownerCookie();
  const res = await handleUi(
    new Request("http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111/t/mid:seed-sync-root@example.test", {
      headers: { cookie },
    }),
    env(state),
    new URL("http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111/t/mid:seed-sync-root@example.test"),
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /先看议程。这是根信正文/);
  assert.match(html, /纪要稍后发/);
  assert.match(html, /收到。/);
  assert.match(html, /agenda\.txt/);
  assert.match(html, /notes\.txt/);
  assert.doesNotMatch(html, /账单正文不应在会话页展开/);
  assert.equal(state.messages.find((item) => item.id === "root")?.is_read, 1);
  assert.equal(state.messages.find((item) => item.id === "reply")?.is_read, 1);
  assert.equal(state.messages.find((item) => item.id === "reply-2")?.is_read, 1);

  const inboxBodyScans = state.sql.filter(
    (sql) => /FROM messages/i.test(sql) && /folder = 'inbox'/i.test(sql) && /snippet, body_text/.test(sql),
  );
  assert.equal(inboxBodyScans.length, 0);
});
