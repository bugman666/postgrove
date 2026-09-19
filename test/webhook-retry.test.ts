import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { handleAdmin } from "../src/admin.ts";
import { OWNER_SESSION_COOKIE, signOwnerSession } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_BASE_MS,
  drainDueWebhookDeliveries,
  handleScheduled,
  notifyInbound,
  saveHookConfig,
  setWebhookFetchForTests,
  setWebhookResolveForTests,
  verifyWebhookSignature,
} from "../src/webhooks.ts";

const SECRET = "change-me-local-session-secret";
const OWNER = "change-me-local-owner-token";
const ADMIN = "change-me-local-admin-token";
const HOOK_SECRET = "webhook-shared-secret-11";
const INBOX = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "inbox@example.test",
  local_part: "inbox",
  domain: "example.test",
  display_name: "Local inbox",
  status: "active",
};

type Row = Record<string, unknown>;

class MemoryD1 {
  mailboxes: Row[] = [{ ...INBOX }];
  messages: Row[] = [];
  inbound_hooks: Row[] = [];
  inbound_deliveries: Row[] = [];
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
    const [a] = this.binds;
    if (sql.includes("from inbound_hooks")) {
      return this.db.inbound_hooks.filter((row) => row.mailbox_id === a);
    }
    if (sql.includes("from inbound_deliveries")) {
      let rows = this.db.inbound_deliveries.slice();
      if (sql.includes("delivery_key =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.delivery_key === this.binds[1]);
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("status = 'pending'") && sql.includes("next_attempt_at")) {
        rows = rows.filter(
          (row) =>
            row.status === "pending" &&
            row.next_attempt_at != null &&
            Number(row.next_attempt_at) <= Number(a),
        );
        return rows.sort((left, right) => Number(left.next_attempt_at) - Number(right.next_attempt_at));
      } else if (sql.includes("where mailbox_id") && sql.includes("status =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.status === this.binds[1]);
      } else if (sql.includes("where mailbox_id")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      } else if (sql.includes("where status =")) {
        rows = rows.filter((row) => row.status === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }
    if (sql.includes("from mailboxes")) {
      return this.db.mailboxes.filter((row) => row.id === a || row.address === String(a).toLowerCase());
    }
    if (sql.includes("from messages")) {
      return this.db.messages.filter((row) => row.id === a && row.mailbox_id === this.binds[1]);
    }
    return [];
  }

  mutate(): number {
    const sql = collapse(this.sql);
    const b = this.binds;
    if (sql.startsWith("update inbound_hooks set webhook_secret")) {
      const row = this.db.inbound_hooks.find((item) => item.mailbox_id === b[0]);
      if (!row) {
        return 0;
      }
      row.webhook_secret = b[1];
      return 1;
    }
    if (sql.startsWith("insert into inbound_hooks")) {
      const row = {
        mailbox_id: b[0],
        webhook_enabled: b[1],
        webhook_url: b[2],
        webhook_secret: b[3],
        forward_enabled: b[4],
        forward_url: b[5],
        forward_email: b[6],
        updated_at: b[7],
      };
      const idx = this.db.inbound_hooks.findIndex((item) => item.mailbox_id === row.mailbox_id);
      if (idx >= 0) {
        this.db.inbound_hooks[idx] = row;
      } else {
        this.db.inbound_hooks.push(row);
      }
      return 1;
    }
    if (sql.startsWith("insert into inbound_deliveries")) {
      const dup = this.db.inbound_deliveries.some(
        (row) => row.mailbox_id === b[1] && row.delivery_key === b[10],
      );
      if (dup) {
        throw new Error("UNIQUE constraint failed: inbound_deliveries.mailbox_id, inbound_deliveries.delivery_key");
      }
      this.db.inbound_deliveries.unshift({
        id: b[0],
        mailbox_id: b[1],
        message_id: b[2],
        kind: b[3],
        channel: b[4],
        target: b[5],
        status: b[6],
        http_status: b[7],
        error: b[8],
        hint: b[9],
        delivery_key: b[10],
        attempt_count: b[11],
        max_attempts: b[12],
        next_attempt_at: b[13],
        last_attempt_at: b[14],
        payload_json: b[15],
        created_at: b[16],
        updated_at: b[17],
      });
      return 1;
    }
    if (sql.startsWith("update inbound_deliveries")) {
      const row = this.db.inbound_deliveries.find((item) => item.id === b[0]);
      if (!row) {
        return 0;
      }
      if (sql.includes("where id =") && sql.includes("status = 'pending'")) {
        if (row.status !== "pending" || row.next_attempt_at == null || Number(row.next_attempt_at) > Number(b[2])) {
          return 0;
        }
        row.next_attempt_at = b[1];
        row.updated_at = b[2];
        return 1;
      }
      row.target = b[1];
      row.status = b[2];
      row.http_status = b[3];
      row.error = b[4];
      row.hint = b[5];
      row.attempt_count = b[6];
      row.next_attempt_at = b[7];
      row.last_attempt_at = b[8];
      row.payload_json = b[9];
      row.updated_at = b[10];
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
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
    ADMIN_TOKEN: ADMIN,
    OUTBOUND_PROVIDER: "stub",
    ...overrides,
  };
}

async function ownerCookie(): Promise<string> {
  const token = await signOwnerSession(SECRET, {
    mailboxId: INBOX.id,
    address: INBOX.address,
  });
  return `${OWNER_SESSION_COOKIE}=${token}`;
}

function notifyInput(messageId: string) {
  return {
    mailboxId: INBOX.id,
    mailboxAddress: INBOX.address,
    messageId,
    from: "neighbor@example.test",
    to: INBOX.address,
    subject: "retry ping",
    snippet: "hello",
    text: "hello body",
    receivedAt: 1_700_000_000_000,
  };
}

afterEach(() => {
  setWebhookFetchForTests(null);
  setWebhookResolveForTests(null);
});

test("pending delivery retries then marks sent", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/retry",
    webhook_secret: HOOK_SECRET,
  });

  let calls = 0;
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  setWebhookFetchForTests(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("nope", { status: 503 });
    }
    return new Response("ok", { status: 200 });
  });

  const first = await notifyInbound(e, notifyInput("msg-retry-ok"));
  assert.equal(first[0].status, "pending");
  assert.equal(first[0].attempt_count, 1);
  assert.equal(first[0].error, "downstream_failed");
  assert.ok((first[0].next_attempt_at ?? 0) >= first[0].created_at + WEBHOOK_RETRY_BASE_MS);

  const replay = await notifyInbound(e, notifyInput("msg-retry-ok"));
  assert.equal(replay[0].id, first[0].id);
  assert.equal(replay[0].status, "pending");
  assert.equal(calls, 1);

  const drained = await drainDueWebhookDeliveries(e, {
    now: (first[0].next_attempt_at ?? 0) + 1,
  });
  assert.equal(drained.claimed, 1);
  assert.equal(drained.sent, 1);
  assert.equal(calls, 2);
  assert.equal(db.inbound_deliveries[0]?.status, "sent");
  assert.equal(db.inbound_deliveries[0]?.attempt_count, 2);
  assert.equal(db.inbound_deliveries.length, 1);
});

test("max attempts marks the delivery failed", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/cap",
    webhook_secret: HOOK_SECRET,
  });
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  setWebhookFetchForTests(async () => new Response("down", { status: 502 }));

  const first = await notifyInbound(e, notifyInput("msg-retry-cap"));
  assert.equal(first[0].status, "pending");
  assert.equal(first[0].attempt_count, 1);

  let now = (first[0].next_attempt_at ?? 0) + 1;
  for (let i = 2; i <= WEBHOOK_MAX_ATTEMPTS; i++) {
    const drained = await drainDueWebhookDeliveries(e, { now });
    assert.equal(drained.claimed, 1);
    const row = db.inbound_deliveries[0];
    assert.equal(row?.attempt_count, i);
    if (i < WEBHOOK_MAX_ATTEMPTS) {
      assert.equal(drained.pending, 1);
      assert.equal(row?.status, "pending");
      now = Number(row?.next_attempt_at) + 1;
    } else {
      assert.equal(drained.failed, 1);
      assert.equal(row?.status, "failed");
      assert.equal(row?.next_attempt_at, null);
    }
  }

  const extra = await drainDueWebhookDeliveries(e, { now: now + WEBHOOK_RETRY_BASE_MS });
  assert.equal(extra.claimed, 0);
  assert.equal(db.inbound_deliveries[0]?.attempt_count, WEBHOOK_MAX_ATTEMPTS);
});

test("admin drain is 401 without credentials and 403 for a mailbox session", async () => {
  const db = new MemoryD1();
  const e = env(db);
  const url = new URL("http://127.0.0.1:8787/admin/webhook-deliveries/drain");

  const anon = await handleAdmin(new Request(url, { method: "POST" }), e, url);
  assert.equal(anon.status, 401);

  const owner = await handleAdmin(
    new Request(url, {
      method: "POST",
      headers: { cookie: await ownerCookie() },
    }),
    e,
    url,
  );
  assert.equal(owner.status, 403);

  const listUrl = new URL("http://127.0.0.1:8787/admin/deliveries?status=pending");
  const ownerList = await handleAdmin(
    new Request(listUrl, { headers: { cookie: await ownerCookie() } }),
    e,
    listUrl,
  );
  assert.equal(ownerList.status, 403);
});

test("admin drain with bearer processes due rows", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/admin-drain",
    webhook_secret: HOOK_SECRET,
  });
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  let calls = 0;
  setWebhookFetchForTests(async () => {
    calls += 1;
    return calls === 1 ? new Response("no", { status: 500 }) : new Response("ok", { status: 200 });
  });

  const first = await notifyInbound(e, notifyInput("msg-admin-drain"));
  assert.equal(first[0].status, "pending");

  const url = new URL("http://127.0.0.1:8787/admin/webhook-deliveries/drain");
  const tooSoon = await handleAdmin(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    e,
    url,
  );
  assert.equal(tooSoon.status, 200);
  const early = (await tooSoon.json()) as { drain: { claimed: number } };
  assert.equal(early.drain.claimed, 0);

  db.inbound_deliveries[0].next_attempt_at = Date.now() - 1;
  const ok = await handleAdmin(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    e,
    url,
  );
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    drain: { sent: number; claimed: number };
    hook?: { webhook_secret?: string };
  };
  assert.equal(body.drain.claimed, 1);
  assert.equal(body.drain.sent, 1);
  assert.equal("webhook_secret" in body, false);
  assert.equal(JSON.stringify(body).includes(HOOK_SECRET), false);
  assert.equal(db.inbound_deliveries[0]?.status, "sent");
});

test("retry re-runs SSRF checks on the live target URL", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/ok",
    webhook_secret: HOOK_SECRET,
  });
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  const fetched: string[] = [];
  setWebhookFetchForTests(async (input) => {
    fetched.push(String(input));
    return new Response("no", { status: 503 });
  });

  const first = await notifyInbound(e, notifyInput("msg-ssrf-retry"));
  assert.equal(first[0].status, "pending");
  assert.equal(fetched.length, 1);

  // Live URL changed outside the save gate (or later became unsafe).
  // Retry must still run validateSafeUrl + DNS — do not skip SSRF.
  db.inbound_hooks[0].webhook_url = "http://169.254.169.254/latest/meta-data/";
  const drained = await drainDueWebhookDeliveries(e, {
    now: (first[0].next_attempt_at ?? 0) + 1,
  });
  assert.equal(drained.claimed, 1);
  assert.equal(fetched.length, 1);
  assert.equal(db.inbound_deliveries[0]?.error, "blocked_destination");
  assert.match(String(db.inbound_deliveries[0]?.hint), /169\.254|Internal|metadata|rejected/i);
  assert.equal(String(db.inbound_deliveries[0]?.hint).includes(HOOK_SECRET), false);
});

test("each retry mints a fresh signature timestamp", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/ts",
    webhook_secret: HOOK_SECRET,
  });
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  const posts: { timestamp: string; signature: string; body: string }[] = [];
  setWebhookFetchForTests(async (_input, init) => {
    const headers = new Headers(init?.headers);
    posts.push({
      timestamp: headers.get("x-postgrove-timestamp") ?? "",
      signature: headers.get("x-postgrove-signature") ?? "",
      body: String(init?.body),
    });
    return new Response(posts.length === 1 ? "no" : "ok", { status: posts.length === 1 ? 500 : 200 });
  });

  const first = await notifyInbound(e, notifyInput("msg-fresh-ts"));
  assert.equal(first[0].status, "pending");
  const later = (first[0].next_attempt_at ?? Date.now()) + 1;
  const drained = await drainDueWebhookDeliveries(e, { now: later });
  assert.equal(drained.sent, 1);
  assert.equal(posts.length, 2);
  assert.ok(Number(posts[1].timestamp) > Number(posts[0].timestamp));
  assert.notEqual(posts[0].signature, posts[1].signature);

  const body1 = JSON.parse(posts[0].body) as { delivery_id: string; event_id: string };
  const body2 = JSON.parse(posts[1].body) as { delivery_id: string; event_id: string };
  assert.equal(body1.delivery_id, body2.delivery_id);
  assert.equal(body1.event_id, body2.event_id);
  assert.equal(body1.delivery_id, first[0].id);

  const firstOk = await verifyWebhookSignature({
    secret: HOOK_SECRET,
    timestamp: posts[0].timestamp,
    rawBody: posts[0].body,
    signatureHeader: posts[0].signature,
    nowSeconds: Number(posts[0].timestamp),
  });
  const secondOk = await verifyWebhookSignature({
    secret: HOOK_SECRET,
    timestamp: posts[1].timestamp,
    rawBody: posts[1].body,
    signatureHeader: posts[1].signature,
    nowSeconds: Number(posts[1].timestamp),
  });
  assert.equal(firstOk.ok, true);
  assert.equal(secondOk.ok, true);

  const stale = await verifyWebhookSignature({
    secret: HOOK_SECRET,
    timestamp: posts[0].timestamp,
    rawBody: posts[0].body,
    signatureHeader: posts[0].signature,
    nowSeconds: Number(posts[1].timestamp) + 6 * 60,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error, "timestamp_skew");
  }
});

test("cron handler drains due pending rows", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/cron",
    webhook_secret: HOOK_SECRET,
  });
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  let calls = 0;
  setWebhookFetchForTests(async () => {
    calls += 1;
    return calls === 1 ? new Response("no", { status: 503 }) : new Response("ok", { status: 200 });
  });

  const first = await notifyInbound(e, notifyInput("msg-cron"));
  assert.equal(first[0].status, "pending");

  const idle = await handleScheduled(e, { now: first[0].created_at + 1_000 });
  assert.equal(idle.claimed, 0);
  assert.equal(calls, 1);

  const drained = await handleScheduled(e, { now: (first[0].next_attempt_at ?? 0) + 1 });
  assert.equal(drained.claimed, 1);
  assert.equal(drained.sent, 1);
  assert.equal(calls, 2);
  assert.equal(db.inbound_deliveries[0]?.status, "sent");
});
