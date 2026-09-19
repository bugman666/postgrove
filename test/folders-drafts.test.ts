import assert from "node:assert/strict";
import { test } from "node:test";
import { requireOwner, OWNER_SESSION_COOKIE, signOwnerSession } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import {
  FOLDER_LABELS,
  folderNavLinks,
  parseDraftFields,
  parseFolder,
  publicFolderList,
  snippetFromBody,
} from "../src/folders.ts";
import {
  getMailbox,
  getMailboxMessage,
  insertDraft,
  insertSentMessage,
  listFolderMessages,
  listInboxMessages,
  moveMessage,
  promoteDraftToSent,
  trashMessage,
  updateDraft,
  type MailboxRecord,
} from "../src/store.ts";
import { MemoryD1, type MemoryRow } from "./helpers/memory-d1.ts";

const SECRET = "change-me-local-session-secret";
const FROM = "inbox@example.test";
const MAILBOX_ID = "11111111-1111-4111-8111-111111111111";
const INBOX_ID = "22222222-2222-4222-8222-222222222221";

const MAILBOX: MailboxRecord = {
  id: MAILBOX_ID,
  address: FROM,
  local_part: "inbox",
  domain: "example.test",
  display_name: "Local inbox",
  status: "active",
};

function messageRow(overrides: MemoryRow): MemoryRow {
  return {
    id: "msg",
    mailbox_id: MAILBOX_ID,
    rfc_message_id: null,
    envelope_from: FROM,
    envelope_to: "neighbor@example.test",
    subject: "主题",
    snippet: "摘要",
    body_text: "正文",
    header_to: "neighbor@example.test",
    header_cc: null,
    header_reply_to: null,
    in_reply_to: null,
    references_header: null,
    size_bytes: 4,
    is_read: 1,
    is_starred: 0,
    folder: "inbox",
    received_at: 1_000,
    created_at: 1_000,
    ...overrides,
  };
}

function seededDb(): MemoryD1 {
  return new MemoryD1({
    mailboxes: [
      {
        ...MAILBOX,
        created_at: 1,
        updated_at: 1,
      },
    ],
    messages: [
      messageRow({
        id: INBOX_ID,
        envelope_from: "neighbor@example.test",
        envelope_to: FROM,
        subject: "欢迎使用本地收件箱",
        snippet: "已读种子",
        body_text: "已读种子正文",
        is_read: 1,
        folder: "inbox",
      }),
    ],
  });
}

function testEnv(db = seededDb()): Env {
  return {
    DB: db.asDatabase(),
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: "change-me-local-owner-token",
    ADMIN_TOKEN: "change-me-local-admin-token",
    OUTBOUND_PROVIDER: "stub",
  };
}

test("parseFolder accepts system folders and junk alias", () => {
  assert.equal(parseFolder("sent"), "sent");
  assert.equal(parseFolder("DRAFT"), "draft");
  assert.equal(parseFolder("junk"), "spam");
  assert.equal(parseFolder("nope"), "inbox");
  assert.deepEqual(
    publicFolderList().map((row) => row.label),
    ["收件箱", "已发送", "草稿", "垃圾箱", "垃圾邮件"],
  );
});

test("parseDraftFields allows empty to; snippet collapses whitespace", () => {
  const parsed = parseDraftFields({ subject: "草稿主题", body: "第一行\n\n第二行" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.fields.to, "");
    assert.equal(parsed.fields.subject, "草稿主题");
    assert.equal(parsed.fields.text, "第一行\n\n第二行");
  }
  assert.equal(snippetFromBody("第一行\n\n第二行"), "第一行 第二行");
});

test("TC7.1 nav lists 收件箱 / 已发送 / 草稿 / 垃圾箱 / 垃圾邮件", () => {
  const links = folderNavLinks("inbox", (folder) =>
    folder === "inbox" ? "/box/x" : `/box/x?folder=${folder}`,
  );
  const labels = links.map((row) => row.label);
  assert.deepEqual(labels, ["收件箱", "已发送", "草稿", "垃圾箱", "垃圾邮件"]);
  assert.equal(links[0].active, true);
  assert.equal(links[1].href, "/box/x?folder=sent");
  assert.equal(FOLDER_LABELS.spam, "垃圾邮件");
});

test("TC7.2 save draft / reopen restores subject and body", async () => {
  const env = testEnv();
  const parsed = parseDraftFields({
    to: "neighbor@example.test",
    subject: "周末散步",
    text: "林间见。",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  const created = await insertDraft(env, MAILBOX, parsed.fields);
  assert.equal(created.folder, "draft");
  assert.equal(created.subject, "周末散步");
  assert.equal(created.body_text, "林间见。");

  const updated = await updateDraft(env, MAILBOX, created.id, {
    ...parsed.fields,
    text: "林间见。带一把伞。",
  });
  assert.ok(updated);
  const reopened = await getMailboxMessage(env, MAILBOX_ID, created.id);
  assert.ok(reopened);
  assert.equal(reopened.folder, "draft");
  assert.equal(reopened.subject, "周末散步");
  assert.equal(reopened.body_text, "林间见。带一把伞。");
});

test("TC7.3 send from draft appears in Sent and leaves Drafts", async () => {
  const env = testEnv();
  const draft = await insertDraft(env, MAILBOX, {
    to: "neighbor@example.test",
    cc: "",
    subject: "从草稿发出",
    text: "正文已写好",
    inReplyTo: null,
    references: null,
  });
  const sent = await promoteDraftToSent(env, MAILBOX, draft.id, {
    to: "neighbor@example.test",
    cc: "",
    subject: "从草稿发出",
    text: "正文已写好",
    inReplyTo: null,
    references: null,
  });
  assert.ok(sent);
  assert.equal(sent.id, draft.id);
  assert.equal(sent.folder, "sent");

  const drafts = await listFolderMessages(env, MAILBOX_ID, "draft");
  assert.equal(drafts.some((row) => row.id === draft.id), false);
  const sentRows = await listFolderMessages(env, MAILBOX_ID, "sent");
  assert.equal(sentRows.some((row) => row.id === draft.id && row.subject === "从草稿发出"), true);
});

test("TC7.4 delete / move to Trash leaves Inbox", async () => {
  const env = testEnv();
  const moved = await trashMessage(env, MAILBOX_ID, INBOX_ID);
  assert.equal(moved, true);
  const inbox = await listInboxMessages(env, MAILBOX_ID);
  assert.equal(inbox.some((row) => row.id === INBOX_ID), false);
  const trash = await listFolderMessages(env, MAILBOX_ID, "trash");
  assert.equal(trash.some((row) => row.id === INBOX_ID && row.folder === "trash"), true);
});

test("TC7.5 successful send is visible in Sent", async () => {
  const env = testEnv();
  const sent = await insertSentMessage(env, MAILBOX, {
    to: "neighbor@example.test",
    cc: "",
    subject: "直接发出",
    text: "看见我就对了",
    inReplyTo: null,
    references: null,
  });
  assert.equal(sent.folder, "sent");
  const rows = await listFolderMessages(env, MAILBOX_ID, "sent");
  assert.equal(rows.some((row) => row.id === sent.id && row.subject === "直接发出"), true);
});

test("TC7.6 folder model stays on forest tokens, not a clone shell", () => {
  const html = folderNavLinks("spam", (folder) => `/${folder}`)
    .map((row) => `<a class="${row.active ? "active" : ""}" href="${row.href}">${row.label}</a>`)
    .join("");
  assert.match(html, /垃圾邮件/);
  assert.doesNotMatch(html, /mx_RoomList|mdc-drawer|el-menu|Element/);
});

test("TC7.7 unauthenticated folder API/pages are 401", async () => {
  const env = testEnv();
  const paths = [
    "/api/folders",
    `/api/mailboxes/${MAILBOX_ID}/messages?folder=sent`,
    `/api/mailboxes/${MAILBOX_ID}/messages?folder=draft`,
    `/api/mailboxes/${MAILBOX_ID}/messages?folder=trash`,
    `/api/mailboxes/${MAILBOX_ID}/messages?folder=spam`,
    "/api/drafts",
    `/box/${MAILBOX_ID}?folder=sent`,
    `/box/${MAILBOX_ID}?folder=draft`,
    `/compose?draft=${INBOX_ID}`,
  ];
  for (const path of paths) {
    const method = path === "/api/drafts" ? "POST" : "GET";
    const gate = await requireOwner(new Request(`http://127.0.0.1:8787${path}`, { method }), env);
    assert.equal(gate.ok, false, path);
    if (!gate.ok) {
      assert.equal(gate.response.status, 401, path);
    }
  }
});

test("owner session can read the mailbox used by folder lists", async () => {
  const env = testEnv();
  const token = await signOwnerSession(SECRET, { mailboxId: MAILBOX_ID, address: FROM });
  const gate = await requireOwner(
    new Request(`http://127.0.0.1:8787/api/mailboxes/${MAILBOX_ID}/messages?folder=sent`, {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    env,
  );
  assert.equal(gate.ok, true);
  const mailbox = await getMailbox(env, MAILBOX_ID);
  assert.equal(mailbox?.address, FROM);
});

test("move to spam uses the folder column and leaves inbox", async () => {
  const env = testEnv();
  const moved = await moveMessage(env, MAILBOX_ID, INBOX_ID, "spam");
  assert.equal(moved, true);
  const inbox = await listInboxMessages(env, MAILBOX_ID);
  assert.equal(inbox.some((row) => row.id === INBOX_ID), false);
  const spam = await listFolderMessages(env, MAILBOX_ID, "spam");
  assert.equal(spam.some((row) => row.id === INBOX_ID && row.folder === "spam"), true);
});
