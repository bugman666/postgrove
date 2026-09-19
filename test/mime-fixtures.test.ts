import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inboundAttachmentRejection } from "../src/attachment-limits.ts";
import { downloadAttachment, persistInboundAttachments } from "../src/attachments.ts";
import { OWNER_SESSION_COOKIE, signOwnerSession } from "../src/auth.ts";
import type { Env, InboundEmail } from "../src/env.ts";
import { handleInbound } from "../src/inbound.ts";
import { extractAttachments, extractBodies, sanitizeAttachmentFilename } from "../src/mime.ts";
import { MemoryD1, MemoryR2 } from "./helpers/memory-d1.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mime");
const SECRET = "change-me-local-session-secret";
const OWNER = "change-me-local-owner-token";
const ADMIN = "change-me-local-admin-token";
const MAILBOX = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "inbox@example.test",
  local_part: "inbox",
  domain: "example.test",
  display_name: "Local inbox",
  status: "active",
  created_at: 1,
  updated_at: 1,
};

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function testEnv(db: MemoryD1, r2?: MemoryR2, overrides: Partial<Env> = {}): Env {
  return {
    DB: db.asDatabase(),
    ATTACHMENTS: r2 as unknown as R2Bucket | undefined,
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
    ADMIN_TOKEN: ADMIN,
    ...overrides,
  };
}

function seededDb(): MemoryD1 {
  return new MemoryD1({ mailboxes: [{ ...MAILBOX }] });
}

function makeInbound(raw: string, to = MAILBOX.address): {
  message: InboundEmail;
  rejected: () => string | null;
} {
  const bytes = new TextEncoder().encode(raw);
  let rejected: string | null = null;
  const headers = new Headers();
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") {
      break;
    }
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers.append(line.slice(0, idx), line.slice(idx + 1).trim());
    }
  }
  return {
    message: {
      from: "sender@example.com",
      to,
      headers,
      raw: new Blob([bytes]).stream(),
      rawSize: bytes.byteLength,
      setReject(reason: string) {
        rejected = reason;
      },
    },
    rejected: () => rejected,
  };
}

test("sanitizeAttachmentFilename keeps basename only", () => {
  assert.equal(sanitizeAttachmentFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeAttachmentFilename("..\\windows\\shadow"), "shadow");
  assert.equal(sanitizeAttachmentFilename(".."), "attachment");
  assert.equal(sanitizeAttachmentFilename("grove-note.txt"), "grove-note.txt");
});

test("nested multipart: prefer inner text/plain and collect the nested file", () => {
  const raw = loadFixture("nested-multipart.eml");
  const bodies = extractBodies(raw);
  assert.match(bodies.bodyText ?? "", /Visible nested plain text/);
  assert.doesNotMatch(bodies.bodyText ?? "", /HTML fallback/);

  const files = extractAttachments(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "nested-note.txt");
  assert.equal(files[0].contentType, "text/plain");
  assert.equal(new TextDecoder().decode(files[0].bytes), "hello nest");
});

test("huge/odd boundary still splits body and attachment", () => {
  const raw = loadFixture("huge-odd-boundary.eml");
  const bodies = extractBodies(raw);
  assert.match(bodies.bodyText ?? "", /odd quoted boundary/);

  const files = extractAttachments(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "odd.bin");
  assert.equal(new TextDecoder().decode(files[0].bytes), "odd");
});

test("lying Content-Type is stored as declared; HTML download is remapped", async () => {
  const raw = loadFixture("lying-content-type.eml");
  const files = extractAttachments(raw);
  assert.equal(files.length, 2);
  const png = files.find((file) => file.filename === "note.html");
  const html = files.find((file) => file.filename === "page.html");
  assert.ok(png);
  assert.ok(html);
  assert.equal(png.contentType, "image/png");
  assert.equal(html.contentType, "text/html");
  assert.match(new TextDecoder().decode(png.bytes), /alert\(1\)/);

  const db = seededDb();
  const r2 = new MemoryR2();
  const env = testEnv(db, r2);
  const stored = await persistInboundAttachments(env, MAILBOX.id, "msg-lie", files, 1);
  assert.equal(stored.length, 2);
  assert.equal(stored.find((row) => row.filename === "note.html")?.content_type, "image/png");

  const htmlRow = stored.find((row) => row.filename === "page.html");
  assert.ok(htmlRow);
  const token = await signOwnerSession(SECRET, { mailboxId: MAILBOX.id, address: MAILBOX.address });
  const response = await downloadAttachment(
    new Request(`http://127.0.0.1:8787/attachments/${htmlRow.id}`, {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    env,
    htmlRow.id,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
});

test("path-traversal filenames are sanitized before persist", async () => {
  const raw = loadFixture("path-traversal-filename.eml");
  const files = extractAttachments(raw);
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((file) => file.filename).sort(),
    ["passwd", "shadow"],
  );

  const db = seededDb();
  const r2 = new MemoryR2();
  const stored = await persistInboundAttachments(testEnv(db, r2), MAILBOX.id, "msg-trav", files, 1);
  assert.equal(stored.length, 2);
  for (const row of stored) {
    assert.doesNotMatch(row.filename, /\.\.|[/\\]/);
    assert.doesNotMatch(row.r2_key, /\.\./);
    assert.doesNotMatch(row.r2_key, /etc\/passwd|windows/i);
  }
  assert.equal(r2.objects.size, 2);
});

test("missing boundary: no attachments; body falls back to the raw part", () => {
  const raw = loadFixture("missing-boundary.eml");
  const files = extractAttachments(raw);
  assert.equal(files.length, 0);

  const bodies = extractBodies(raw);
  assert.match(bodies.bodyText ?? "", /fallback body here/);
});

test("oversized part is rejected loud on the inbound path", async () => {
  const raw = loadFixture("oversized-part.eml");
  const files = extractAttachments(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "huge.bin");
  assert.ok(files[0].bytes.byteLength > 1024);

  const db = seededDb();
  const r2 = new MemoryR2();
  const env = testEnv(db, r2, {
    ATTACHMENT_MAX_BYTES: "1024",
    ATTACHMENT_MAX_COUNT: "10",
  });
  const limit = inboundAttachmentRejection(
    files.map((file) => ({ filename: file.filename, size: file.bytes.byteLength })),
    env,
  );
  assert.ok(limit);
  assert.equal(limit.error, "attachment_too_large");
  assert.match(limit.hint, /huge\.bin/);

  const { message, rejected } = makeInbound(raw);
  await handleInbound(message, env);
  assert.match(rejected() ?? "", /Attachment too large|附件太大/);
  assert.equal(db.messages.length, 0);
  assert.equal(db.attachments.length, 0);
});

test("inbound stores nested multipart body + attachment through MemoryD1", async () => {
  const raw = loadFixture("nested-multipart.eml");
  const db = seededDb();
  const r2 = new MemoryR2();
  const { message, rejected } = makeInbound(raw);
  await handleInbound(message, testEnv(db, r2));
  assert.equal(rejected(), null);
  assert.equal(db.messages.length, 1);
  assert.match(String(db.messages[0].body_text ?? ""), /Visible nested plain text/);
  assert.equal(db.attachments.length, 1);
  assert.equal(db.attachments[0].filename, "nested-note.txt");
  assert.equal(r2.objects.size, 1);
});

test("inbound missing-boundary stores the fallback body and no files", async () => {
  const raw = loadFixture("missing-boundary.eml");
  const db = seededDb();
  const r2 = new MemoryR2();
  const { message, rejected } = makeInbound(raw);
  await handleInbound(message, testEnv(db, r2));
  assert.equal(rejected(), null);
  assert.equal(db.messages.length, 1);
  assert.match(String(db.messages[0].body_text ?? ""), /fallback body here/);
  assert.equal(db.attachments.length, 0);
});
