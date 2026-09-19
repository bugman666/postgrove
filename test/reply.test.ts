import assert from "node:assert/strict";
import { test } from "node:test";
import { requireOwner } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import {
  buildComposePrefill,
  buildReferences,
  extractAddresses,
  forwardSubject,
  normalizeMessageId,
  parseComposeMode,
  parseRecipientList,
  replyRecipients,
  replySubject,
  type ReplySource,
} from "../src/reply.ts";

const SELF = "inbox@example.test";

function source(overrides: Partial<ReplySource> = {}): ReplySource {
  return {
    envelope_from: "lead@grove.test",
    envelope_to: SELF,
    subject: "本周同步",
    body_text: "先看议程。",
    rfc_message_id: "<seed-sync@example.test>",
    header_to: "inbox@example.test, teammate@grove.test",
    header_cc: "notes@grove.test",
    header_reply_to: null,
    in_reply_to: "<seed-sync-root@example.test>",
    references_header: "<seed-sync-root@example.test>",
    received_at: Date.UTC(2026, 8, 19, 12, 0, 0),
    ...overrides,
  };
}

test("extractAddresses pulls unique lowercase emails from a header", () => {
  assert.deepEqual(
    extractAddresses('Lead <lead@grove.test>, "Teammate" <TEAMMATE@grove.test>'),
    ["lead@grove.test", "teammate@grove.test"],
  );
  assert.deepEqual(extractAddresses(null), []);
});

test("reply prefills To=sender, Re: subject, and In-Reply-To/References", () => {
  const draft = buildComposePrefill(source(), SELF, "reply");
  assert.equal(draft.mode, "reply");
  assert.equal(draft.to, "lead@grove.test");
  assert.equal(draft.cc, "");
  assert.equal(draft.subject, "Re: 本周同步");
  assert.equal(draft.inReplyTo, "<seed-sync@example.test>");
  assert.equal(draft.references, "<seed-sync-root@example.test> <seed-sync@example.test>");
  assert.match(draft.body, /lead@grove\.test 写道/);
  assert.match(draft.body, /> 先看议程。/);
});

test("reply uses Reply-To when present and does not double Re:", () => {
  const draft = buildComposePrefill(
    source({
      header_reply_to: "Lead Replies <lead-replies@grove.test>",
      subject: "Re: 本周同步",
    }),
    SELF,
    "reply",
  );
  assert.equal(draft.to, "lead-replies@grove.test");
  assert.equal(draft.subject, "Re: 本周同步");
});

test("reply-all includes original To/Cc minus self", () => {
  const recipients = replyRecipients(source(), SELF, true);
  assert.deepEqual(recipients.to, ["lead@grove.test", "teammate@grove.test"]);
  assert.deepEqual(recipients.cc, ["notes@grove.test"]);

  const draft = buildComposePrefill(source(), SELF, "reply-all");
  assert.equal(draft.to, "lead@grove.test, teammate@grove.test");
  assert.equal(draft.cc, "notes@grove.test");
  assert.ok(!draft.to.includes(SELF));
  assert.ok(!draft.cc.includes(SELF));
});

test("reply-all without stored To/Cc falls back to sender only", () => {
  const draft = buildComposePrefill(
    source({
      header_to: null,
      header_cc: null,
    }),
    SELF,
    "reply-all",
  );
  assert.equal(draft.to, "lead@grove.test");
  assert.equal(draft.cc, "");
});

test("forward prefills Fwd: subject and original headers/body", () => {
  const draft = buildComposePrefill(source(), SELF, "forward");
  assert.equal(draft.mode, "forward");
  assert.equal(draft.to, "");
  assert.equal(draft.cc, "");
  assert.equal(draft.subject, "Fwd: 本周同步");
  assert.equal(draft.inReplyTo, "");
  assert.equal(draft.references, "");
  assert.match(draft.body, /---------- Forwarded message ----------/);
  assert.match(draft.body, /From: lead@grove\.test/);
  assert.match(draft.body, /Subject: 本周同步/);
  assert.match(draft.body, /To: inbox@example\.test, teammate@grove\.test/);
  assert.match(draft.body, /Cc: notes@grove\.test/);
  assert.match(draft.body, /先看议程。/);
});

test("subject helpers skip an existing prefix", () => {
  assert.equal(replySubject("回复：已有"), "回复：已有");
  assert.equal(forwardSubject("Fwd: already"), "Fwd: already");
  assert.equal(replySubject(null), "Re:");
  assert.equal(forwardSubject("  "), "Fwd:");
});

test("References appends the parent Message-ID without duplicates", () => {
  assert.equal(
    buildReferences("<a@x> <b@x>", "<b@x>"),
    "<a@x> <b@x>",
  );
  assert.equal(normalizeMessageId("plain@id"), "<plain@id>");
  assert.equal(normalizeMessageId(" <keep@id> "), "<keep@id>");
});

test("parseComposeMode only accepts the three reply flows", () => {
  assert.equal(parseComposeMode("reply"), "reply");
  assert.equal(parseComposeMode("reply-all"), "reply-all");
  assert.equal(parseComposeMode("forward"), "forward");
  assert.equal(parseComposeMode("thread"), "new");
});

test("parseRecipientList accepts comma-separated addresses", () => {
  const ok = parseRecipientList("A <a@example.test>, b@example.test", "to", true);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.addresses, ["a@example.test", "b@example.test"]);
  }
  const bad = parseRecipientList("not-an-email", "to", true);
  assert.equal(bad.ok, false);
});

test("compose prefill / send share requireOwner — missing cookie is 401", async () => {
  const env = {
    DB: {} as D1Database,
    SESSION_SECRET: "change-me-local-session-secret",
    OWNER_TOKEN: "change-me-local-owner-token",
    ADMIN_TOKEN: "change-me-local-admin-token",
  } as Env;
  const missing = await requireOwner(
    new Request("http://127.0.0.1:8787/api/messages/x/compose?mode=reply"),
    env,
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.response.status, 401);
  }
});
