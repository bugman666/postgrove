import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentLimits,
  checkAttachmentLimits,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MAX_COUNT,
  formatBytes,
  inboundAttachmentRejection,
  tooLargeHint,
  tooManyHint,
} from "../src/attachment-limits.ts";
import { requireOwner } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import { extractAttachments, extractBodies } from "../src/mime.ts";

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

function env(): Env {
  return {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { id: MAILBOX.id, address: MAILBOX.address, status: "active" };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
    ADMIN_TOKEN: ADMIN,
  };
}
