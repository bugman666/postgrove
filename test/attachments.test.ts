import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentLimits,
  attachmentStoreFailedHint,
  checkAttachmentLimits,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MAX_COUNT,
  formatBytes,
  inboundAttachmentRejection,
  tooLargeHint,
  tooManyHint,
} from "../src/attachment-limits.ts";
import { persistInboundAttachments } from "../src/attachments.ts";
import { requireOwner } from "../src/auth.ts";
import type { Env, InboundEmail } from "../src/env.ts";
import { handleInbound } from "../src/inbound.ts";
import { extractAttachments, extractBodies, type ParsedAttachment } from "../src/mime.ts";

const SECRET = "change-me-local-session-secret";
const OWNER = "change-me-local-owner-token";
const ADMIN = "change-me-local-admin-token";
const MAILBOX = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "inbox@example.test",
};

test("default and configured attachment limits", () => {
  const defaults = attachmentLimits({} as Env);
  assert.equal(defaults.maxBytes, DEFAULT_ATTACHMENT_MAX_BYTES);
  assert.equal(defaults.maxCount, DEFAULT_ATTACHMENT_MAX_COUNT);

  const custom = attachmentLimits({
    ATTACHMENT_MAX_BYTES: "2048",
    ATTACHMENT_MAX_COUNT: "3",
  } as Env);
  assert.equal(custom.maxBytes, 2048);
  assert.equal(custom.maxCount, 3);
});

test("over-limit size and count use human-readable errors", () => {
  const limits = { maxBytes: 1024, maxCount: 2 };
  const size = checkAttachmentLimits([{ filename: "huge.bin", size: 2048 }], limits);
  assert.ok(size);
  assert.equal(size.error, "attachment_too_large");
  assert.match(size.hint, /上限 1 KB/);
  assert.match(size.hint, /huge\.bin/);
  assert.match(size.hint, /Attachment too large \(limit 1 KB\)/);
  assert.match(size.hint, /compress and try again/i);
  assert.equal(size.hint, tooLargeHint("huge.bin", 2048, 1024));

  const count = checkAttachmentLimits(
    [
      { filename: "a.txt", size: 1 },
      { filename: "b.txt", size: 1 },
      { filename: "c.txt", size: 1 },
    ],
    limits,
  );
  assert.ok(count);
  assert.equal(count.error, "too_many_attachments");
  assert.match(count.hint, /上限 2 个/);
  assert.match(count.hint, /Too many attachments/);
  assert.equal(count.hint, tooManyHint(3, 2));
});

test("inbound rejection includes the configured cap", () => {
  const env = {
    ATTACHMENT_MAX_BYTES: "1024",
    ATTACHMENT_MAX_COUNT: "10",
    ATTACHMENTS: {} as R2Bucket,
  } as Env;
  const over = inboundAttachmentRejection([{ filename: "big.txt", size: 3000 }], env);
  assert.ok(over);
  assert.equal(over.error, "attachment_too_large");
  assert.match(over.hint, /上限 1 KB/);
  assert.match(over.hint, /Attachment too large \(limit 1 KB\)/);

  const missingR2 = inboundAttachmentRejection([{ filename: "ok.txt", size: 12 }], {
    ATTACHMENT_MAX_BYTES: "1024",
  } as Env);
  assert.ok(missingR2);
  assert.equal(missingR2.error, "r2_not_configured");
  assert.match(missingR2.hint, /ATTACHMENTS R2/);

  const ok = inboundAttachmentRejection([{ filename: "ok.txt", size: 12 }], env);
  assert.equal(ok, null);
});

test("formatBytes is readable", () => {
  assert.equal(formatBytes(84), "84 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
});

test("extractAttachments reads a multipart base64 part", () => {
  const payload = Buffer.from("hello grove", "utf8").toString("base64");
  const raw = [
    "From: sender@example.com",
    "To: inbox@example.test",
    "Subject: files",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="bnd"',
    "",
    "--bnd",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    "--bnd",
    "Content-Type: text/plain; name=grove-note.txt",
    'Content-Disposition: attachment; filename="grove-note.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    payload,
    "--bnd--",
    "",
  ].join("\r\n");

  const bodies = extractBodies(raw);
  assert.match(bodies.bodyText ?? "", /See attached/);

  const files = extractAttachments(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "grove-note.txt");
  assert.equal(files[0].contentType, "text/plain");
  assert.equal(new TextDecoder().decode(files[0].bytes), "hello grove");
});

test("attachment persist hint is bilingual and actionable", () => {
  const hint = attachmentStoreFailedHint();
  assert.match(hint, /附件未能写入对象存储/);
  assert.match(hint, /Attachment storage failed/);
  assert.match(hint, /retry/i);
});

test("persistInboundAttachments writes R2 objects and D1 rows", async () => {
  const r2 = new MemoryR2();
  const db = new MemoryD1();
  const files = [parsedFile("grove-note.txt", "hello grove")];
  const stored = await persistInboundAttachments(
    persistEnv(db, r2),
    MAILBOX.id,
    MESSAGE_ID,
    files,
    1_700_000_000_000,
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.filename, "grove-note.txt");
  assert.equal(db.attachments.length, 1);
  assert.equal(db.attachments[0]?.message_id, MESSAGE_ID);
  assert.equal(r2.objects.size, 1);
  const key = stored[0]?.r2_key ?? "";
  assert.match(key, new RegExp(`^attachments/${MAILBOX.id}/${MESSAGE_ID}/`));
  assert.equal(new TextDecoder().decode(r2.objects.get(key)), "hello grove");
});

test("persistInboundAttachments rolls back earlier writes when a later R2 put fails", async () => {
  const r2 = new MemoryR2();
  r2.failPutAfter = 1;
  const db = new MemoryD1();
  const files = [
    parsedFile("one.txt", "first"),
    parsedFile("two.txt", "second"),
  ];
  await assert.rejects(
    () => persistInboundAttachments(persistEnv(db, r2), MAILBOX.id, MESSAGE_ID, files),
    /R2 put failed/,
  );
  assert.equal(db.attachments.length, 0);
  assert.equal(r2.objects.size, 0);
  assert.equal(r2.putCalls, 2);
  assert.equal(r2.deleteCalls, 1);
});

test("inbound R2 persist failure rejects and does not leave a body without files", async () => {
  const r2 = new MemoryR2();
  r2.failPut = true;
  const db = new MemoryD1();
  const mail = inboundAttachmentMail();
  await handleInbound(mail.message, inboundEnv(db, r2));
  assert.equal(mail.rejected(), attachmentStoreFailedHint());
  assert.equal(db.messages.length, 0);
  assert.equal(db.attachments.length, 0);
  assert.equal(r2.objects.size, 0);
  assert.equal(db.hooksLookups, 0);
});

test("inbound happy-path attachment ingest stores the message and files", async () => {
  const r2 = new MemoryR2();
  const db = new MemoryD1();
  const mail = inboundAttachmentMail();
  await handleInbound(mail.message, inboundEnv(db, r2));
  assert.equal(mail.rejected(), null);
  assert.equal(db.messages.length, 1);
  assert.equal(db.messages[0]?.subject, "files");
  assert.equal(db.attachments.length, 1);
  assert.equal(db.attachments[0]?.filename, "grove-note.txt");
  assert.equal(db.attachments[0]?.message_id, db.messages[0]?.id);
  assert.equal(r2.objects.size, 1);
  const key = String(db.attachments[0]?.r2_key ?? "");
  assert.equal(new TextDecoder().decode(r2.objects.get(key)), "hello grove");
});

test("unauthenticated attachment download is 401 via requireOwner", async () => {
  const missing = await requireOwner(
    new Request("http://127.0.0.1:8787/attachments/33333333-3333-4333-8333-333333333331"),
    env(),
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.response.status, 401);
    const body = (await missing.response.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "unauthorized");
  }
});

const MESSAGE_ID = "22222222-2222-4222-8222-222222222224";

type Row = Record<string, unknown>;

class MemoryR2 {
  objects = new Map<string, Uint8Array>();
  failPut = false;
  failPutAfter: number | null = null;
  putCalls = 0;
  deleteCalls = 0;

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void> {
    this.putCalls += 1;
    if (this.failPut || (this.failPutAfter !== null && this.putCalls > this.failPutAfter)) {
      throw new Error("R2 put failed");
    }
    this.objects.set(key, toBytes(value));
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls += 1;
    this.objects.delete(key);
  }
}

class MemoryD1 {
  mailboxes: Row[] = [{ ...MAILBOX, status: "active" }];
  messages: Row[] = [];
  attachments: Row[] = [];
  hooksLookups = 0;

  prepare(sql: string) {
    return new MemoryStatement(this, sql);
  }
}

class MemoryStatement {
  db: MemoryD1;
  sql: string;
  binds: unknown[] = [];

  constructor(db: MemoryD1, sql: string) {
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
      return this.db.mailboxes.slice();
    }
    if (sql.includes("from mailbox_aliases") || sql.includes("from dev_inboxes") || sql.includes("from users")) {
      return [];
    }
    if (sql.includes("from inbound_hooks")) {
      this.db.hooksLookups += 1;
      return [];
    }
    if (sql.includes("from attachments")) {
      let rows = this.db.attachments.slice();
      if (sql.includes("where mailbox_id =") && sql.includes("and message_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.message_id === b);
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      }
      return rows.sort((left, right) => Number(left.created_at) - Number(right.created_at));
    }
    if (sql.includes("from messages")) {
      return this.db.messages.slice();
    }
    return [];
  }

  mutate() {
    const sql = collapse(this.sql);
    const binds = this.binds;
    if (sql.startsWith("insert into messages")) {
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
        is_read: 0,
        is_starred: 0,
        folder: "inbox",
        received_at: binds[14],
        created_at: binds[14],
      });
      return 1;
    }
    if (sql.startsWith("insert into attachments")) {
      this.db.attachments.push({
        id: binds[0],
        message_id: binds[1],
        mailbox_id: binds[2],
        filename: binds[3],
        content_type: binds[4],
        size_bytes: binds[5],
        r2_key: binds[6],
        created_at: binds[7],
      });
      return 1;
    }
    if (sql.startsWith("delete from attachments")) {
      const before = this.db.attachments.length;
      this.db.attachments = this.db.attachments.filter((row) => row.id !== binds[0]);
      return before === this.db.attachments.length ? 0 : 1;
    }
    if (sql.startsWith("delete from messages")) {
      const before = this.db.messages.length;
      this.db.messages = this.db.messages.filter(
        (row) => !(row.id === binds[0] && row.mailbox_id === binds[1]),
      );
      return before === this.db.messages.length ? 0 : 1;
    }
    return 0;
  }
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function persistEnv(db: MemoryD1, r2: MemoryR2): Env {
  return {
    DB: db as unknown as D1Database,
    ATTACHMENTS: r2 as unknown as R2Bucket,
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
    ADMIN_TOKEN: ADMIN,
  };
}

function inboundEnv(db: MemoryD1, r2: MemoryR2): Env {
  return persistEnv(db, r2);
}

function env(): Env {
  return persistEnv(new MemoryD1(), new MemoryR2());
}

function parsedFile(filename: string, text: string): ParsedAttachment {
  return {
    filename,
    contentType: "text/plain",
    bytes: new TextEncoder().encode(text),
  };
}

function inboundAttachmentMail(): { message: InboundEmail; rejected: () => string | null } {
  let reason: string | null = null;
  const payload = Buffer.from("hello grove", "utf8").toString("base64");
  const raw = [
    "From: sender@example.com",
    "To: inbox@example.test",
    "Subject: files",
    "Message-ID: <r2-fail-loud@example.test>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="bnd"',
    "",
    "--bnd",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    "--bnd",
    "Content-Type: text/plain; name=grove-note.txt",
    'Content-Disposition: attachment; filename="grove-note.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    payload,
    "--bnd--",
    "",
  ].join("\r\n");
  return {
    message: {
      from: "sender@example.com",
      to: MAILBOX.address,
      headers: new Headers({
        subject: "files",
        "message-id": "<r2-fail-loud@example.test>",
      }),
      raw: new Blob([raw]).stream(),
      rawSize: raw.length,
      setReject(value: string) {
        reason = value;
      },
    },
    rejected: () => reason,
  };
}

function toBytes(value: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}
