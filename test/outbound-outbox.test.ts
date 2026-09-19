import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../src/env.ts";
import type { OutboundAdapter, OutboundAdapterResult, OutboundDraft } from "../src/outbound.ts";
import {
  OUTBOUND_MAX_ATTEMPTS,
  parseIdempotencyKey,
  readIdempotencyKey,
  sendOutbound,
} from "../src/send.ts";
import {
  getOutboundAttemptByIdempotency,
  listOutboundAttempts,
  type MailboxRecord,
} from "../src/store.ts";

const FROM = "inbox@example.test";
const MAILBOX_ID = "11111111-1111-4111-8111-111111111111";
const MAILBOX: MailboxRecord = {
  id: MAILBOX_ID,
  address: FROM,
  local_part: "inbox",
  domain: "example.test",
  display_name: "Local inbox",
  status: "active",
};
const INPUT = {
  to: "neighbor@example.test",
  cc: "",
  subject: "hello",
  text: "from outbox",
  inReplyTo: null,
  references: null,
};

type Row = Record<string, unknown>;

class MemoryD1 {
  mailboxes: Row[] = [{ ...MAILBOX, created_at: 1, updated_at: 1 }];
  messages: Row[] = [];
  outbound_attempts: Row[] = [];

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
    if (sql.includes("from outbound_attempts")) {
      let rows = this.db.outbound_attempts.slice();
      if (sql.includes("idempotency_key =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.idempotency_key === b);
      } else if (sql.includes("where id =") && sql.includes("mailbox_id")) {
        rows = rows.filter((row) => row.id === a && row.mailbox_id === b);
      } else if (sql.includes("mailbox_id")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }
    if (sql.includes("from messages")) {
      let rows = this.db.messages.slice();
      if (sql.includes("where id =") && sql.includes("mailbox_id")) {
        rows = rows.filter((row) => row.id === a && row.mailbox_id === b);
      } else if (sql.includes("mailbox_id")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows;
    }
    return [];
  }

  mutate(): number {
    const sql = collapse(this.sql);
    const b = this.binds;
    if (sql.startsWith("insert into outbound_attempts")) {
      const mailboxId = b[1];
      const key = b[15];
      const dup = this.db.outbound_attempts.some(
        (row) => row.mailbox_id === mailboxId && row.idempotency_key === key,
      );
      if (dup) {
        throw new Error("UNIQUE constraint failed: outbound_attempts.mailbox_id, outbound_attempts.idempotency_key");
      }
      this.db.outbound_attempts.push({
        id: b[0],
        mailbox_id: b[1],
        from_address: b[2],
        to_address: b[3],
        cc_address: b[4],
        subject: b[5],
        body_text: b[6],
        in_reply_to: b[7],
        references_header: b[8],
        provider: b[9],
        status: b[10],
        error: b[11],
        hint: b[12],
        provider_message_id: b[13],
        created_at: b[14],
        idempotency_key: b[15],
        attempt_count: b[16],
        max_attempts: b[17],
        last_attempt_at: b[18],
        sent_message_id: b[19],
        updated_at: b[20],
      });
      return 1;
    }
    if (sql.startsWith("update outbound_attempts")) {
      const row = this.db.outbound_attempts.find((item) => item.id === b[0] && item.mailbox_id === b[1]);
      if (!row) {
        return 0;
      }
      row.provider = b[2];
      row.status = b[3];
      row.error = b[4];
      row.hint = b[5];
      row.provider_message_id = b[6];
      row.attempt_count = b[7];
      row.last_attempt_at = b[8];
      row.sent_message_id = b[9];
      row.updated_at = b[10];
      return 1;
    }
    if (sql.startsWith("insert into messages")) {
      this.db.messages.unshift({
        id: b[0],
        mailbox_id: b[1],
        rfc_message_id: b[2],
        envelope_from: b[3],
        envelope_to: b[4],
        subject: b[5],
        snippet: b[6],
        body_text: b[7],
        header_to: b[8],
        header_cc: b[9],
        header_reply_to: b[10],
        in_reply_to: b[11],
        references_header: b[12],
        size_bytes: b[13],
        is_read: b[14],
        is_starred: b[15],
        folder: b[16],
        received_at: b[17],
        created_at: b[18],
      });
      return 1;
    }
    return 0;
  }
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function env(db: MemoryD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    SESSION_SECRET: "change-me-local-session-secret",
    OWNER_TOKEN: "change-me-local-owner-token",
    ADMIN_TOKEN: "change-me-local-admin-token",
    OUTBOUND_PROVIDER: "stub",
    ...overrides,
  };
}

class CountingAdapter implements OutboundAdapter {
  readonly name = "stub" as const;
  calls = 0;
  result: OutboundAdapterResult = { ok: true, providerMessageId: "prov-1" };

  async send(_draft: OutboundDraft): Promise<OutboundAdapterResult> {
    this.calls += 1;
    return this.result;
  }
}

class FailAdapter implements OutboundAdapter {
  readonly name = "resend" as const;
  calls = 0;

  async send(_draft: OutboundDraft): Promise<OutboundAdapterResult> {
    this.calls += 1;
    return {
      ok: false,
      error: "outbound_auth_failed",
      hint: "Resend rejected the credentials. Check RESEND_API_KEY.",
      detail: "Invalid API key",
      retryable: false,
    };
  }
}

class FlakyAdapter implements OutboundAdapter {
  readonly name = "http" as const;
  calls = 0;
  failUntil: number;

  constructor(failUntil = 1) {
    this.failUntil = failUntil;
  }

  async send(_draft: OutboundDraft): Promise<OutboundAdapterResult> {
    this.calls += 1;
    if (this.calls <= this.failUntil) {
      return {
        ok: false,
        error: "outbound_failed",
        hint: "HTTP outbound hook returned 503.",
        detail: "unavailable",
        retryable: true,
      };
    }
    return { ok: true, providerMessageId: "prov-retry" };
  }
}

test("parseIdempotencyKey accepts a header-sized key and rejects spaces", () => {
  assert.deepEqual(parseIdempotencyKey(null), { ok: true, key: null });
  assert.deepEqual(parseIdempotencyKey("  send-1  "), { ok: true, key: "send-1" });
  const bad = parseIdempotencyKey("has space");
  assert.equal(bad.ok, false);
  const header = readIdempotencyKey(
    new Request("http://127.0.0.1:8787/api/send", {
      headers: { "Idempotency-Key": "from-header" },
    }),
    { idempotency_key: "from-body" },
  );
  assert.equal(header, "from-header");
});

test("success writes sent folder + attempt status sent", async () => {
  const db = new MemoryD1();
  const adapter = new CountingAdapter();
  const outcome = await sendOutbound(env(db), MAILBOX, INPUT, {
    idempotencyKey: "ok-1",
    adapter,
  });

  assert.equal(outcome.httpStatus, 200);
  assert.equal(outcome.attempt.status, "sent");
  assert.equal(outcome.attempt.idempotency_key, "ok-1");
  assert.equal(outcome.attempt.attempt_count, 1);
  assert.equal(outcome.attempt.provider_message_id, "prov-1");
  assert.ok(outcome.sent);
  assert.equal(outcome.sent.folder, "sent");
  assert.equal(outcome.sent.envelope_to, INPUT.to);
  assert.equal(outcome.attempt.sent_message_id, outcome.sent.id);

  const stored = await getOutboundAttemptByIdempotency(env(db), MAILBOX_ID, "ok-1");
  assert.ok(stored);
  assert.equal(stored.status, "sent");
  assert.equal(stored.sent_message_id, outcome.sent.id);

  const listed = await listOutboundAttempts(env(db), MAILBOX_ID);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "sent");
});

test("idempotent double-submit reuses the attempt and does not call the provider again", async () => {
  const db = new MemoryD1();
  const adapter = new CountingAdapter();
  const first = await sendOutbound(env(db), MAILBOX, INPUT, {
    idempotencyKey: "dup-1",
    adapter,
  });
  const second = await sendOutbound(env(db), MAILBOX, INPUT, {
    idempotencyKey: "dup-1",
    adapter,
  });

  assert.equal(first.httpStatus, 200);
  assert.equal(second.httpStatus, 200);
  assert.equal(second.attempt.id, first.attempt.id);
  assert.equal(second.attempt.status, "sent");
  assert.equal(second.sent?.id, first.sent?.id);
  assert.equal(adapter.calls, 1);
  assert.equal(db.outbound_attempts.length, 1);
  assert.equal(db.messages.filter((row) => row.folder === "sent").length, 1);
});

test("provider fail stores a visible failed attempt and no Sent row", async () => {
  const db = new MemoryD1();
  const adapter = new FailAdapter();
  const outcome = await sendOutbound(env(db), MAILBOX, INPUT, {
    idempotencyKey: "fail-1",
    adapter,
  });

  assert.equal(outcome.httpStatus, 502);
  assert.equal(outcome.sent, null);
  assert.equal(outcome.attempt.status, "failed");
  assert.equal(outcome.attempt.error, "outbound_auth_failed");
  assert.match(outcome.attempt.hint ?? "", /RESEND_API_KEY/);
  assert.equal(outcome.attempt.attempt_count, 1);
  assert.equal(adapter.calls, 1);

  const stored = await getOutboundAttemptByIdempotency(env(db), MAILBOX_ID, "fail-1");
  assert.ok(stored);
  assert.equal(stored.status, "failed");
  assert.equal(stored.error, "outbound_auth_failed");
  assert.equal(db.messages.length, 0);

  const replay = await sendOutbound(env(db), MAILBOX, INPUT, {
    idempotencyKey: "fail-1",
    adapter,
  });
  assert.equal(replay.attempt.id, outcome.attempt.id);
  assert.equal(replay.attempt.status, "failed");
  assert.equal(adapter.calls, 1);
});

test("transient provider failure retries in-request then succeeds", async () => {
  const db = new MemoryD1();
  const adapter = new FlakyAdapter(1);
  const outcome = await sendOutbound(env(db), MAILBOX, INPUT, {
    idempotencyKey: "retry-1",
    adapter,
  });

  assert.equal(outcome.httpStatus, 200);
  assert.equal(outcome.attempt.status, "sent");
  assert.equal(outcome.attempt.attempt_count, 2);
  assert.equal(adapter.calls, 2);
  assert.ok(outcome.sent);
  assert.equal(outcome.sent.folder, "sent");
});

test("transient retries stop at the in-request cap", async () => {
  const db = new MemoryD1();
  const adapter = new FlakyAdapter(OUTBOUND_MAX_ATTEMPTS + 2);
  const outcome = await sendOutbound(env(db), MAILBOX, INPUT, {
    idempotencyKey: "retry-cap",
    adapter,
  });

  assert.equal(outcome.httpStatus, 502);
  assert.equal(outcome.attempt.status, "failed");
  assert.equal(outcome.attempt.attempt_count, OUTBOUND_MAX_ATTEMPTS);
  assert.equal(adapter.calls, OUTBOUND_MAX_ATTEMPTS);
  assert.equal(outcome.sent, null);
});
