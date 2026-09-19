import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWNER_SESSION_COOKIE,
  requireOwner,
  signOwnerSession,
} from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import { listInboxMessages, type MailboxRecord, type MessageRecord } from "../src/store.ts";
import {
  citationIds,
  findThreadById,
  groupMessagesIntoThreads,
  latestThreadMessage,
  normalizeThreadSubject,
  participantKey,
  stableThreadId,
} from "../src/threads.ts";

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
