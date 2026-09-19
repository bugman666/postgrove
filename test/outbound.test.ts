import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../src/env.ts";
import {
  OWNER_SESSION_COOKIE,
  requireOwner,
  signOwnerSession,
} from "../src/auth.ts";
import {
  HttpAdapter,
  parseSendFields,
  ResendAdapter,
  resolveOutboundAdapter,
  StubAdapter,
} from "../src/outbound.ts";

const SECRET = "change-me-local-session-secret";
const FROM = "inbox@example.test";
const MAILBOX_ID = "11111111-1111-4111-8111-111111111111";

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: "change-me-local-owner-token",
    ADMIN_TOKEN: "change-me-local-admin-token",
    OUTBOUND_PROVIDER: "stub",
    ...overrides,
  };
}

test("TC6.5 resolveOutboundAdapter: unset fails loud", () => {
  const resolved = resolveOutboundAdapter(env({ OUTBOUND_PROVIDER: "" }));
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error, "outbound_not_configured");
    assert.match(resolved.hint, /OUTBOUND_PROVIDER/);
    assert.match(resolved.hint, /stub/);
  }
});

test("resolveOutboundAdapter: resend without key fails loud", () => {
  const resolved = resolveOutboundAdapter(env({ OUTBOUND_PROVIDER: "resend" }));
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error, "outbound_not_configured");
    assert.match(resolved.hint, /RESEND_API_KEY/);
  }
});

test("resolveOutboundAdapter: http without URL fails loud", () => {
  const resolved = resolveOutboundAdapter(env({ OUTBOUND_PROVIDER: "http" }));
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.match(resolved.hint, /OUTBOUND_HTTP_URL/);
  }
});

test("resolveOutboundAdapter: unknown provider fails loud", () => {
  const resolved = resolveOutboundAdapter(env({ OUTBOUND_PROVIDER: "smtp" }));
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error, "unknown_provider");
  }
});

test("resolveOutboundAdapter: stub is selected", () => {
  const resolved = resolveOutboundAdapter(env());
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.adapter.name, "stub");
  }
});

test("StubAdapter records no network send and returns an id", async () => {
  const result = await new StubAdapter().send({
    from: FROM,
    to: "neighbor@example.test",
    subject: "hi",
    text: "body",
  });
  assert.equal(result.ok, true);
  assert.match(result.providerMessageId ?? "", /^stub-/);
});

test("ResendAdapter fails loud on 401", async () => {
  const adapter = new ResendAdapter("re_fake", async () =>
    new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }),
  );
  const result = await adapter.send({
    from: FROM,
    to: "neighbor@example.test",
    subject: "hi",
    text: "body",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "outbound_auth_failed");
  assert.equal(result.retryable, false);
  assert.match(result.hint ?? "", /RESEND_API_KEY/);
  assert.match(result.detail ?? "", /Invalid API key/);
});

test("ResendAdapter marks 503 as retryable", async () => {
  const adapter = new ResendAdapter("re_fake", async () =>
    new Response(JSON.stringify({ message: "unavailable" }), { status: 503 }),
  );
  const result = await adapter.send({
    from: FROM,
    to: "neighbor@example.test",
    subject: "hi",
    text: "body",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "outbound_failed");
  assert.equal(result.retryable, true);
});

test("ResendAdapter forwards cc plus In-Reply-To / References", async () => {
  let posted: unknown;
  const adapter = new ResendAdapter("re_fake", async (_url, init) => {
    posted = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  });
  const result = await adapter.send({
    from: FROM,
    to: "lead@grove.test, teammate@grove.test",
    cc: "notes@grove.test",
    subject: "Re: 本周同步",
    text: "ack",
    headers: {
      "In-Reply-To": "<seed-sync@example.test>",
      References: "<seed-sync-root@example.test> <seed-sync@example.test>",
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(posted, {
    from: FROM,
    to: ["lead@grove.test", "teammate@grove.test"],
    cc: ["notes@grove.test"],
    subject: "Re: 本周同步",
    text: "ack",
    headers: {
      "In-Reply-To": "<seed-sync@example.test>",
      References: "<seed-sync-root@example.test> <seed-sync@example.test>",
    },
  });
});

test("HttpAdapter posts JSON and reads provider id", async () => {
  let posted: unknown;
  const adapter = new HttpAdapter("https://hooks.example.test/send", "tok", async (_url, init) => {
    posted = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "http-1" }), { status: 200 });
  });
  const result = await adapter.send({
    from: FROM,
    to: "neighbor@example.test",
    subject: "hi",
    text: "body",
  });
  assert.equal(result.ok, true);
  assert.equal(result.providerMessageId, "http-1");
  assert.deepEqual(posted, {
    from: FROM,
    to: "neighbor@example.test",
    subject: "hi",
    text: "body",
  });
});

test("parseSendFields rejects a missing or invalid to", () => {
  const missing = parseSendFields({ subject: "x", text: "y" });
  assert.equal(missing.ok, false);
  const bad = parseSendFields({ to: "not-an-email", subject: "x", text: "y" });
  assert.equal(bad.ok, false);
  const ok = parseSendFields({ to: " Neighbor@Example.TEST ", subject: "Hi", body: "Hello" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.input.to, "neighbor@example.test");
    assert.equal(ok.input.text, "Hello");
    assert.equal(ok.input.cc, "");
    assert.equal(ok.input.inReplyTo, null);
    assert.equal(ok.input.references, null);
  }

  const reply = parseSendFields({
    to: "lead@grove.test, teammate@grove.test",
    cc: "notes@grove.test, lead@grove.test",
    subject: "Re: 本周同步",
    text: "ack",
    in_reply_to: "<seed-sync@example.test>",
    references: "<seed-sync-root@example.test> <seed-sync@example.test>",
  });
  assert.equal(reply.ok, true);
  if (reply.ok) {
    assert.equal(reply.input.to, "lead@grove.test, teammate@grove.test");
    assert.equal(reply.input.cc, "notes@grove.test");
    assert.equal(reply.input.inReplyTo, "<seed-sync@example.test>");
    assert.equal(reply.input.references, "<seed-sync-root@example.test> <seed-sync@example.test>");
  }
});

test("compose/send share requireOwner — missing cookie is 401", async () => {
  const missing = await requireOwner(new Request("http://127.0.0.1:8787/compose"), env());
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.response.status, 401);
    const body = (await missing.response.json()) as { error: string; hint: string };
    assert.equal(body.error, "unauthorized");
    assert.match(body.hint, /auth\/login/);
  }

  const token = await signOwnerSession(SECRET, {
    mailboxId: MAILBOX_ID,
    address: FROM,
  });
  const owner = await requireOwner(
    new Request("http://127.0.0.1:8787/api/send", {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    env(),
  );
  assert.equal(owner.ok, true);
});
