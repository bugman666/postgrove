import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { insertApiToken } from "../src/api-tokens.ts";
import {
  DEV_FORBIDDEN_HINT,
  DEV_INBOX_CLOSED_HINT,
  DEV_OWN_DOMAIN_HINT,
  DEV_WAIT_TIMEOUT_HINT,
  setDevInboxSleepForTests,
} from "../src/dev-inbox.ts";
import type { Env, InboundEmail } from "../src/env.ts";
import { extractFromText } from "../src/extract.ts";
import { handleInbound } from "../src/inbound.ts";
import { resetRateLimitForTests } from "../src/rate-limit.ts";
import { handleRestRoutes } from "../src/rest.ts";
import { insertMessage, type MessageRecord } from "../src/store.ts";

const SECRET = "change-me-local-session-secret";
const ADMIN = "change-me-local-admin-token";
const OWNER = "change-me-local-owner-token";
const MAILBOX_A = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "inbox@example.test",
  local_part: "inbox",
  domain: "example.test",
  display_name: "Local inbox",
  status: "active",
};
const MAILBOX_B = {
  id: "11111111-1111-4111-8111-111111111112",
  address: "empty@example.test",
  local_part: "empty",
  domain: "example.test",
  display_name: "Empty",
  status: "active",
};

type Row = Record<string, unknown>;

class MemoryD1 {
  mailboxes: Row[] = [
    { ...MAILBOX_A, created_at: 1, updated_at: 1 },
    { ...MAILBOX_B, created_at: 2, updated_at: 2 },
  ];
  messages: Row[] = [];
  tokens: Row[] = [];
  inboxes: Row[] = [];

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
    if (sql.includes("from sqlite_master")) {
      return [
        "mailboxes",
        "messages",
        "outbound_attempts",
        "api_tokens",
        "users",
        "inbound_hooks",
        "inbound_deliveries",
        "dev_inboxes",
      ].map((name) => ({ name }));
    }
    if (sql.includes("from users") || sql.includes("from inbound_hooks")) {
      return [];
    }
    if (sql.includes("count(*) as n from dev_inboxes")) {
      let rows = this.db.inboxes.slice();
      if (sql.includes("owner_mailbox_id =")) {
        rows = rows.filter((row) => row.owner_mailbox_id === a && row.status === "open" && Number(row.expires_at) > Number(b));
      } else {
        rows = rows.filter((row) => row.status === "open" && Number(row.expires_at) > Number(a));
      }
      return [{ n: rows.length }];
    }
    if (sql.includes("from dev_inboxes")) {
      let rows = this.db.inboxes.slice();
      if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("where mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      } else if (sql.includes("where owner_mailbox_id =")) {
        rows = rows.filter((row) => row.owner_mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }
    if (sql.includes("distinct domain from mailboxes")) {
      return [...new Set(this.db.mailboxes.map((row) => String(row.domain)))].map((domain) => ({ domain }));
    }
    if (sql.includes("from mailboxes")) {
      if (sql.includes("where address =")) {
        return this.db.mailboxes.filter((row) => row.address === String(a).toLowerCase());
      }
      if (sql.includes("where id =")) {
        return this.db.mailboxes.filter((row) => row.id === a);
      }
      return this.db.mailboxes.slice();
    }
    if (sql.includes("from api_tokens")) {
      let rows = this.db.tokens.slice();
      if (sql.includes("where token_hash =")) {
        rows = rows.filter((row) => row.token_hash === a);
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("where mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows;
    }
    if (sql.includes("from messages")) {
      let rows = this.db.messages.slice();
      if (sql.includes("folder = 'inbox'")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.folder === "inbox");
      } else if (sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.received_at) - Number(left.received_at));
    }
    return [];
  }

  mutate(): number {
    const sql = collapse(this.sql);
    const b = this.binds;
    if (sql.startsWith("insert into mailboxes")) {
      this.db.mailboxes.push({
        id: b[0],
        address: b[1],
        local_part: b[2],
        domain: b[3],
        display_name: b[4],
        status: b[5],
        created_at: b[6],
        updated_at: b[7],
      });
      return 1;
    }
    if (sql.startsWith("insert into api_tokens")) {
      this.db.tokens.push({
        id: b[0],
        mailbox_id: b[1],
        token_hash: b[2],
        token_prefix: b[3],
        label: b[4],
        created_at: b[5],
        revoked_at: null,
      });
      return 1;
    }
    if (sql.startsWith("insert into dev_inboxes")) {
      this.db.inboxes.push({
        id: b[0],
        mailbox_id: b[1],
        owner_mailbox_id: b[2],
        owner_token_id: b[3],
        address: b[4],
        domain: b[5],
        status: b[6],
        expires_at: b[7],
        closed_at: null,
        created_at: b[8],
      });
      return 1;
    }
    if (sql.startsWith("insert into messages")) {
      const starred = sql.includes("is_starred");
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
        is_read: starred ? b[14] : 0,
        is_starred: starred ? b[15] : 0,
        folder: starred ? b[16] : "inbox",
        received_at: starred ? b[17] : b[14],
        created_at: starred ? b[18] : b[14],
      });
      return 1;
    }
    if (sql.includes("update mailboxes set status")) {
      const row = this.db.mailboxes.find((item) => item.id === b[0]);
      if (!row) {
        return 0;
      }
      row.status = b[1];
      row.updated_at = b[2];
      return 1;
    }
    if (sql.includes("update dev_inboxes set status")) {
      const row = this.db.inboxes.find((item) => item.id === b[0]);
      if (!row) {
        return 0;
      }
      row.status = b[1];
      row.closed_at = b[2];
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

function rest(request: Request, testEnv: Env): Promise<Response | null> {
  return handleRestRoutes(request, testEnv);
}

async function mint(db: MemoryD1, mailboxId = MAILBOX_A.id): Promise<string> {
  return (await insertApiToken(env(db), mailboxId, "dev")).token;
}

function bearer(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function createInbox(testEnv: Env, token: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/dev/inboxes", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    testEnv,
  );
  assert.ok(response);
  const payload = await jsonOf(response);
  assert.equal(response.status, 201, JSON.stringify(payload));
  return payload;
}

function seedMessage(mailboxId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    mailbox_id: mailboxId,
    rfc_message_id: `<seed-${now}@example.test>`,
    envelope_from: "verify@grove.test",
    envelope_to: "dev@example.test",
    subject: "Your verification code is 482193",
    snippet: "code 482193",
    body_text: "Your verification code is 482193\nhttps://grove.test/verify?t=abc",
    header_to: null,
    header_cc: null,
    header_reply_to: null,
    in_reply_to: null,
    references_header: null,
    size_bytes: 40,
    is_read: 0,
    is_starred: 0,
    folder: "inbox",
    received_at: now,
    created_at: now,
    ...overrides,
  };
}

beforeEach(() => {
  resetRateLimitForTests();
  setDevInboxSleepForTests(async () => undefined);
});

afterEach(() => {
  setDevInboxSleepForTests(null);
});

test("extract OTP prefers a labeled code and fails loud when ambiguous", () => {
  const labeled = extractFromText("Your verification code is 482193", "otp");
  assert.equal(labeled.ok, true);
  if (labeled.ok) {
    assert.equal(labeled.value, "482193");
    assert.equal(labeled.rule, "labeled_otp");
  }

  const zh = extractFromText("您的验证码是 882211，请勿泄露。", "otp");
  assert.equal(zh.ok, true);
  if (zh.ok) {
    assert.equal(zh.value, "882211");
  }

  const standalone = extractFromText("Use 331122 before it expires.", "otp");
  assert.equal(standalone.ok, true);
  if (standalone.ok) {
    assert.equal(standalone.value, "331122");
    assert.equal(standalone.rule, "standalone_digits");
  }

  const none = extractFromText("hello from 2024, no code here", "otp");
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.equal(none.error, "extract_failed");
    assert.match(none.hint, /未能抽出验证码/);
  }

  const ambiguous = extractFromText("codes 111111 and 222222 arrived", "otp");
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.error, "extract_ambiguous");
  }
});

test("extract link takes labeled https and rejects http-only bodies", () => {
  const labeled = extractFromText("Click to verify https://grove.test/ok?n=1", "link");
  assert.equal(labeled.ok, true);
  if (labeled.ok) {
    assert.equal(labeled.value, "https://grove.test/ok?n=1");
  }

  const httpOnly = extractFromText("open http://grove.test/insecure", "link");
  assert.equal(httpOnly.ok, false);
  if (!httpOnly.ok) {
    assert.equal(httpOnly.error, "extract_failed");
    assert.match(httpOnly.hint, /https:\/\//);
  }

  const custom = extractFromText("token=ZZ-99-AA in the letter", "otp", { pattern: "token=([A-Z0-9-]+)" });
  assert.equal(custom.ok, true);
  if (custom.ok) {
    assert.equal(custom.value, "ZZ-99-AA");
    assert.equal(custom.rule, "custom_pattern");
  }
});

test("TC14.1 create ephemeral inbox on the token's own domain", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const token = await mint(db);
  const created = await createInbox(testEnv, token);
  const inbox = created.inbox as Record<string, unknown>;
  assert.equal(typeof inbox.address, "string");
  assert.match(String(inbox.address), /^dev-[0-9a-f]{12}@example\.test$/);
  assert.equal(inbox.domain, "example.test");
  assert.equal(inbox.status, "open");
  assert.equal(typeof inbox.id, "string");
  assert.ok(Number(inbox.expires_at) > Date.now());
  assert.match(String(created.hint), /自有域名/);
  assert.doesNotMatch(String(created.hint), /临时邮箱池|temp-mail|mail-hub/i);
});

test("create rejects a foreign domain and +tag local parts", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const token = await mint(db);

  const foreign = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/dev/inboxes", {
      method: "POST",
      body: JSON.stringify({ domain: "gmail.com" }),
    }),
    testEnv,
  );
  assert.ok(foreign);
  assert.equal(foreign.status, 400);
  const foreignBody = await jsonOf(foreign);
  assert.equal(foreignBody.error, "own_domain_only");
  assert.equal(foreignBody.hint, DEV_OWN_DOMAIN_HINT);

  const plus = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/dev/inboxes", {
      method: "POST",
      body: JSON.stringify({ local_part: "inbox+qa" }),
    }),
    testEnv,
  );
  assert.ok(plus);
  assert.equal(plus.status, 400);
  const plusBody = await jsonOf(plus);
  assert.match(String(plusBody.hint), /\+tag|#15/);
});

test("TC14.2 wait returns a match and times out with a clear Chinese error", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const token = await mint(db);
  const created = await createInbox(testEnv, token);
  const inbox = created.inbox as Record<string, unknown>;

  const timeout = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/dev/inboxes/${inbox.id}/wait`, {
      method: "POST",
      body: JSON.stringify({ timeout_ms: 40, contains: "no-such-mail" }),
    }),
    testEnv,
  );
  assert.ok(timeout);
  assert.equal(timeout.status, 408);
  const timeoutBody = await jsonOf(timeout);
  assert.equal(timeoutBody.error, "wait_timeout");
  assert.equal(timeoutBody.hint, DEV_WAIT_TIMEOUT_HINT);

  await insertMessage(testEnv, seedMessage(String(inbox.mailbox_id)));
  const hit = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/dev/inboxes/${inbox.id}/wait?timeout_ms=0&contains=482193`),
    testEnv,
  );
  assert.ok(hit);
  const hitBody = await jsonOf(hit);
  assert.equal(hit.status, 200, JSON.stringify(hitBody));
  assert.equal(hitBody.ok, true);
  const message = hitBody.message as Record<string, unknown>;
  assert.match(String(message.body_text), /482193/);
});

test("TC14.3 extract OTP or link from a received message", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const token = await mint(db);
  const created = await createInbox(testEnv, token);
  const inbox = created.inbox as Record<string, unknown>;
  await insertMessage(testEnv, seedMessage(String(inbox.mailbox_id)));

  const otp = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/dev/inboxes/${inbox.id}/extract`, {
      method: "POST",
      body: JSON.stringify({ kind: "otp" }),
    }),
    testEnv,
  );
  assert.ok(otp);
  const otpBody = await jsonOf(otp);
  assert.equal(otp.status, 200, JSON.stringify(otpBody));
  const otpExtract = otpBody.extract as Record<string, unknown>;
  assert.equal(otpExtract.value, "482193");

  const link = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/dev/inboxes/${inbox.id}/extract`, {
      method: "POST",
      body: JSON.stringify({ kind: "link" }),
    }),
    testEnv,
  );
  assert.ok(link);
  const linkBody = await jsonOf(link);
  assert.equal(link.status, 200);
  const linkExtract = linkBody.extract as Record<string, unknown>;
  assert.equal(linkExtract.value, "https://grove.test/verify?t=abc");

  const loud = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/dev/inboxes/${inbox.id}/extract`, {
      method: "POST",
      body: JSON.stringify({ kind: "otp", pattern: "no-such-([0-9]+)" }),
    }),
    testEnv,
  );
  assert.ok(loud);
  assert.equal(loud.status, 422);
  const loudBody = await jsonOf(loud);
  assert.equal(loudBody.error, "extract_failed");
  assert.match(String(loudBody.hint), /未能抽出/);
});

test("TC14.4 close is idempotent and inbound stops receiving", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const token = await mint(db);
  const created = await createInbox(testEnv, token, { local_part: "dev-closed1" });
  const inbox = created.inbox as Record<string, unknown>;

  const first = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/dev/inboxes/${inbox.id}/close`, { method: "POST" }),
    testEnv,
  );
  assert.ok(first);
  const firstBody = await jsonOf(first);
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  assert.equal(firstBody.already_closed, false);
  assert.equal((firstBody.inbox as Record<string, unknown>).status, "closed");

  const second = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/dev/inboxes/${inbox.id}/close`, { method: "POST" }),
    testEnv,
  );
  assert.ok(second);
  const secondBody = await jsonOf(second);
  assert.equal(second.status, 200);
  assert.equal(secondBody.already_closed, true);

  const waitClosed = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/dev/inboxes/${inbox.id}/wait`, {
      method: "POST",
      body: JSON.stringify({ timeout_ms: 0 }),
    }),
    testEnv,
  );
  assert.ok(waitClosed);
  assert.equal(waitClosed.status, 409);
  const waitBody = await jsonOf(waitClosed);
  assert.equal(waitBody.error, "inbox_closed");
  assert.equal(waitBody.hint, DEV_INBOX_CLOSED_HINT);

  const mailbox = db.mailboxes.find((row) => row.id === inbox.mailbox_id);
  assert.equal(mailbox?.status, "disabled");

  let rejected: string | null = null;
  const inbound: InboundEmail = {
    from: "sender@example.test",
    to: String(inbox.address),
    headers: new Headers({
      subject: "after close",
      "message-id": "<after-close@example.test>",
    }),
    raw: new Blob(["hello after close"]).stream(),
    rawSize: 16,
    setReject(reason) {
      rejected = reason;
    },
  };
  await handleInbound(inbound, testEnv);
  assert.equal(rejected, "mailbox disabled");
  assert.equal(db.messages.length, 0);
});

test("TC14.5 missing/invalid token is 401 and cross-tenant is 403", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const tokenA = await mint(db, MAILBOX_A.id);
  const tokenB = await mint(db, MAILBOX_B.id);
  const created = await createInbox(testEnv, tokenA);
  const inbox = created.inbox as Record<string, unknown>;

  const missing = await rest(new Request("http://127.0.0.1:8787/api/v1/dev/inboxes", { method: "POST" }), testEnv);
  assert.ok(missing);
  assert.equal(missing.status, 401);
  assert.equal((await jsonOf(missing)).error, "unauthorized");

  const bad = await rest(
    bearer("pg_this-is-not-a-real-token-value", "http://127.0.0.1:8787/api/v1/dev/inboxes", {
      method: "POST",
      body: "{}",
    }),
    testEnv,
  );
  assert.ok(bad);
  assert.equal(bad.status, 401);

  for (const path of ["wait", "extract", "close"] as const) {
    const cross = await rest(
      bearer(tokenB, `http://127.0.0.1:8787/api/v1/dev/inboxes/${inbox.id}/${path}`, {
        method: "POST",
        body: JSON.stringify(path === "extract" ? { kind: "otp" } : { timeout_ms: 0 }),
      }),
      testEnv,
    );
    assert.ok(cross);
    assert.equal(cross.status, 403, path);
    const body = await jsonOf(cross);
    assert.equal(body.error, "forbidden");
    assert.equal(body.hint, DEV_FORBIDDEN_HINT);
  }
});

test("quota and expire fail loud in Chinese", async () => {
  const db = new MemoryD1();
  const testEnv = env(db, { DEV_INBOX_QUOTA: "1" });
  const token = await mint(db);
  await createInbox(testEnv, token, { local_part: "dev-one" });
  const second = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/dev/inboxes", {
      method: "POST",
      body: JSON.stringify({ local_part: "dev-two" }),
    }),
    testEnv,
  );
  assert.ok(second);
  assert.equal(second.status, 409);
  const quotaBody = await jsonOf(second);
  assert.equal(quotaBody.error, "quota_dev_inboxes");
  assert.match(String(quotaBody.hint), /配额已满/);

  const open = db.inboxes[0];
  assert.ok(open);
  open.expires_at = 1;
  const wait = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/dev/inboxes/${open.id}/wait`, {
      method: "POST",
      body: JSON.stringify({ timeout_ms: 0 }),
    }),
    testEnv,
  );
  assert.ok(wait);
  assert.equal(wait.status, 409);
  const waitBody = await jsonOf(wait);
  assert.equal(waitBody.error, "inbox_expired");
  assert.match(String(waitBody.hint), /已过期/);
});
