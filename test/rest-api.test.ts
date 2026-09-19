import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  generateApiTokenSecret,
  hashApiToken,
  insertApiToken,
  looksLikeApiToken,
} from "../src/api-tokens.ts";
import { OWNER_SESSION_COOKIE, requireOwner, signOwnerSession } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import {
  DEFAULT_REST_BODY_MAX_BYTES,
  REST_CROSS_MAILBOX_HINT,
  handleOwnerTokenRoutes,
  handleRestRoutes,
} from "../src/rest.ts";
import {
  REST_RATE_LIMIT_MAX,
  resetRateLimitForTests,
} from "../src/rate-limit.ts";
import { parseMailboxAddress } from "../src/store.ts";
import {
  TURNSTILE_SITEVERIFY_URL,
  resetTurnstileFetchForTests,
  setTurnstileFetchForTests,
  verifyTurnstile,
} from "../src/turnstile.ts";

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
const MESSAGE_A = {
  id: "22222222-2222-4222-8222-222222222221",
  mailbox_id: MAILBOX_A.id,
  rfc_message_id: "<seed-a@example.test>",
  envelope_from: "neighbor@example.test",
  envelope_to: MAILBOX_A.address,
  subject: "欢迎使用本地收件箱",
  snippet: "已读种子",
  body_text: "已读种子正文",
  header_to: MAILBOX_A.address,
  header_cc: null,
  header_reply_to: null,
  in_reply_to: null,
  references_header: null,
  size_bytes: 18,
  is_read: 0,
  is_starred: 0,
  folder: "inbox",
  received_at: 1,
  created_at: 1,
};
const MESSAGE_B = {
  ...MESSAGE_A,
  id: "22222222-2222-4222-8222-222222222229",
  mailbox_id: MAILBOX_B.id,
  envelope_to: MAILBOX_B.address,
  subject: "other box",
  body_text: "secret of B",
};

type Row = Record<string, unknown>;

class MemoryD1 {
  mailboxes: Row[] = [
    { ...MAILBOX_A, created_at: 1, updated_at: 1 },
    { ...MAILBOX_B, created_at: 2, updated_at: 2 },
  ];
  messages: Row[] = [{ ...MESSAGE_A }, { ...MESSAGE_B }];
  tokens: Row[] = [];
  attempts: Row[] = [];

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

  rows() {
    const sql = collapse(this.sql);
    const [a, b] = this.binds;
    if (sql.includes("from mailboxes")) {
      if (sql.includes("where address =")) {
        return this.db.mailboxes.filter((row) => row.address === String(a).toLowerCase());
      }
      if (sql.includes("where id =")) {
        return this.db.mailboxes.filter((row) => row.id === a);
      }
      return this.db.mailboxes.slice().sort((left, right) => Number(left.created_at) - Number(right.created_at));
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
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }
    if (sql.includes("from messages")) {
      let rows = this.db.messages.slice();
      if (sql.includes("where id =") && sql.includes("mailbox_id =") && sql.includes("folder = 'inbox'")) {
        rows = rows.filter((row) => row.id === a && row.mailbox_id === b && row.folder === "inbox");
      } else if (sql.includes("where id =") && sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.id === a && row.mailbox_id === b);
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("folder = 'inbox'")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.folder === "inbox");
      } else if (sql.includes("and folder = ?")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.folder === b);
      } else if (sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.received_at) - Number(left.received_at));
    }
    return [];
  }

  mutate() {
    const sql = collapse(this.sql);
    const binds = this.binds;
    if (sql.startsWith("insert into mailboxes")) {
      this.db.mailboxes.push({
        id: binds[0],
        address: binds[1],
        local_part: binds[2],
        domain: binds[3],
        display_name: binds[4],
        status: binds[5],
        created_at: binds[6],
        updated_at: binds[7],
      });
      return 1;
    }
    if (sql.startsWith("insert into api_tokens")) {
      this.db.tokens.push({
        id: binds[0],
        mailbox_id: binds[1],
        token_hash: binds[2],
        token_prefix: binds[3],
        label: binds[4],
        created_at: binds[5],
        revoked_at: null,
      });
      return 1;
    }
    if (sql.includes("update api_tokens set revoked_at")) {
      const row = this.db.tokens.find((item) => item.id === binds[0] && item.revoked_at == null);
      if (!row) {
        return 0;
      }
      row.revoked_at = binds[1];
      return 1;
    }
    if (sql.includes("update messages set is_read")) {
      const row = this.db.messages.find(
        (item) => item.id === binds[0] && item.mailbox_id === binds[1] && item.folder === "inbox",
      );
      if (!row) {
        return 0;
      }
      row.is_read = binds[2];
      return 1;
    }
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
        is_read: binds[14],
        is_starred: binds[15],
        folder: binds[16],
        received_at: binds[17],
        created_at: binds[18],
      });
      return 1;
    }
    if (sql.startsWith("insert into outbound_attempts")) {
      this.db.attempts.push({
        id: binds[0],
        mailbox_id: binds[1],
        from_address: binds[2],
        to_address: binds[3],
        status: binds[10],
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

async function mint(db: MemoryD1, mailboxId = MAILBOX_A.id, label = "test"): Promise<string> {
  const issued = await insertApiToken(env(db), mailboxId, label);
  return issued.token;
}

function bearer(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

beforeEach(() => {
  resetRateLimitForTests();
  resetTurnstileFetchForTests();
});

test("parseMailboxAddress accepts a normal role address", () => {
  assert.deepEqual(parseMailboxAddress(" Support@Example.TEST "), {
    address: "support@example.test",
    localPart: "support",
    domain: "example.test",
  });
  assert.equal(parseMailboxAddress("not-an-email"), null);
});

test("API token hash roundtrip and pg_ prefix", async () => {
  const generated = await generateApiTokenSecret();
  assert.equal(looksLikeApiToken(generated.token), true);
  assert.equal(await hashApiToken(generated.token), generated.hash);
  assert.notEqual(generated.hash, generated.token);
});

test("TC12.1 valid API token lists/creates addresses, lists/reads messages, sends", async () => {
  const db = new MemoryD1();
  const token = await mint(db);
  const testEnv = env(db);

  const listed = await rest(bearer(token, "http://127.0.0.1:8787/api/v1/mailboxes"), testEnv);
  assert.ok(listed);
  assert.equal(listed.status, 200);
  const listedBody = (await listed.json()) as {
    mailboxes: { id: string; address: string }[];
  };
  assert.equal(listedBody.mailboxes.length, 1);
  assert.equal(listedBody.mailboxes[0].id, MAILBOX_A.id);

  const created = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/mailboxes", {
      method: "POST",
      body: JSON.stringify({ address: "support@example.test", display_name: "Support" }),
    }),
    testEnv,
  );
  assert.ok(created);
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { mailbox: { address: string } };
  assert.equal(createdBody.mailbox.address, "support@example.test");

  const messages = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/mailboxes/${MAILBOX_A.id}/messages`),
    testEnv,
  );
  assert.ok(messages);
  assert.equal(messages.status, 200);
  const messagesBody = (await messages.json()) as { messages: { id: string }[] };
  assert.equal(messagesBody.messages.some((row) => row.id === MESSAGE_A.id), true);

  const read = await rest(bearer(token, `http://127.0.0.1:8787/api/v1/messages/${MESSAGE_A.id}`), testEnv);
  assert.ok(read);
  assert.equal(read.status, 200);
  const readBody = (await read.json()) as { message: { body_text: string; is_read: boolean } };
  assert.equal(readBody.message.body_text, MESSAGE_A.body_text);
  assert.equal(readBody.message.is_read, true);

  const sent = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/send", {
      method: "POST",
      body: JSON.stringify({ to: "neighbor@example.test", subject: "hello", text: "from token" }),
    }),
    testEnv,
  );
  assert.ok(sent);
  assert.equal(sent.status, 200);
  const sentBody = (await sent.json()) as { ok: boolean; attempt: { status: string; provider: string } };
  assert.equal(sentBody.ok, true);
  assert.equal(sentBody.attempt.status, "sent");
  assert.equal(sentBody.attempt.provider, "stub");
});

test("TC12.2 missing or invalid token is 401", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);

  const missing = await rest(new Request("http://127.0.0.1:8787/api/v1/mailboxes"), testEnv);
  assert.ok(missing);
  assert.equal(missing.status, 401);
  const missingBody = (await missing.json()) as { error: string };
  assert.equal(missingBody.error, "unauthorized");

  const invalid = await rest(
    bearer("pg_this-is-not-a-real-token-value", "http://127.0.0.1:8787/api/v1/mailboxes"),
    testEnv,
  );
  assert.ok(invalid);
  assert.equal(invalid.status, 401);

  const wrong = await rest(
    bearer("not-a-pg-token", "http://127.0.0.1:8787/api/v1/send", {
      method: "POST",
      body: JSON.stringify({ to: "a@b.test", subject: "x", text: "y" }),
    }),
    testEnv,
  );
  assert.ok(wrong);
  assert.equal(wrong.status, 401);
});

test("TC12.3 mailbox-scoped token cannot read another mailbox", async () => {
  const db = new MemoryD1();
  const token = await mint(db, MAILBOX_A.id);
  const testEnv = env(db);

  const listOther = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/mailboxes/${MAILBOX_B.id}/messages`),
    testEnv,
  );
  assert.ok(listOther);
  assert.equal(listOther.status, 403);
  const listBody = (await listOther.json()) as { error: string; hint: string };
  assert.equal(listBody.error, "forbidden");
  assert.equal(listBody.hint, REST_CROSS_MAILBOX_HINT);

  const readOther = await rest(
    bearer(token, `http://127.0.0.1:8787/api/v1/messages/${MESSAGE_B.id}`),
    testEnv,
  );
  assert.ok(readOther);
  assert.equal(readOther.status, 403);

  const sendOther = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/send", {
      method: "POST",
      body: JSON.stringify({
        mailbox_id: MAILBOX_B.id,
        to: "neighbor@example.test",
        subject: "nope",
        text: "cross",
      }),
    }),
    testEnv,
  );
  assert.ok(sendOther);
  assert.equal(sendOther.status, 403);
});

test("TC12.4 Turnstile public signup rejects missing/failed challenge and allows success", async () => {
  const db = new MemoryD1();
  const closed = await rest(
    new Request("http://127.0.0.1:8787/api/v1/public/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "guest@example.test", turnstile_token: "xx" }),
    }),
    env(db),
  );
  assert.ok(closed);
  assert.equal(closed.status, 403);
  const closedBody = (await closed.json()) as { error: string };
  assert.equal(closedBody.error, "public_signup_disabled");

  const openEnv = env(db, { TURNSTILE_SECRET_KEY: "test-turnstile-secret" });

  setTurnstileFetchForTests(async () => {
    throw new Error("should not call siteverify when token is empty");
  });
  const missing = await rest(
    new Request("http://127.0.0.1:8787/api/v1/public/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.40" },
      body: JSON.stringify({ address: "guest@example.test" }),
    }),
    openEnv,
  );
  assert.ok(missing);
  assert.equal(missing.status, 403);
  const missingBody = (await missing.json()) as { error: string };
  assert.equal(missingBody.error, "turnstile_failed");

  setTurnstileFetchForTests(async (input, init) => {
    assert.equal(String(input), TURNSTILE_SITEVERIFY_URL);
    assert.equal(init?.method, "POST");
    const body = String(init?.body);
    assert.match(body, /secret=test-turnstile-secret/);
    assert.match(body, /response=bad-token/);
    return new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), {
      status: 200,
    });
  });
  const failed = await rest(
    new Request("http://127.0.0.1:8787/api/v1/public/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.41" },
      body: JSON.stringify({ address: "guest@example.test", turnstile_token: "bad-token" }),
    }),
    openEnv,
  );
  assert.ok(failed);
  assert.equal(failed.status, 403);

  setTurnstileFetchForTests(async (_input, init) => {
    const body = String(init?.body);
    assert.match(body, /response=ok-token/);
    assert.match(body, /remoteip=203.0.113.42/);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  const ok = await rest(
    new Request("http://127.0.0.1:8787/api/v1/public/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.42" },
      body: JSON.stringify({ address: "guest@example.test", turnstile_token: "ok-token" }),
    }),
    openEnv,
  );
  assert.ok(ok);
  assert.equal(ok.status, 201);
  const okBody = (await ok.json()) as {
    mailbox: { address: string };
    token: { token: string; prefix: string };
  };
  assert.equal(okBody.mailbox.address, "guest@example.test");
  assert.equal(looksLikeApiToken(okBody.token.token), true);

  const listed = await rest(
    bearer(okBody.token.token, "http://127.0.0.1:8787/api/v1/mailboxes"),
    openEnv,
  );
  assert.ok(listed);
  assert.equal(listed.status, 200);
});

test("TC12.5 over rate is 429 and oversize body is 413 / 400", async () => {
  const db = new MemoryD1();
  const token = await mint(db);
  const limitedEnv = env(db, { REST_RATE_LIMIT_MAX: "2" });

  const first = await rest(bearer(token, "http://127.0.0.1:8787/api/v1/mailboxes"), limitedEnv);
  const second = await rest(bearer(token, "http://127.0.0.1:8787/api/v1/mailboxes"), limitedEnv);
  assert.ok(first && second);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const third = await rest(bearer(token, "http://127.0.0.1:8787/api/v1/mailboxes"), limitedEnv);
  assert.ok(third);
  assert.equal(third.status, 429);
  assert.ok(third.headers.get("retry-after"));
  const limitedBody = (await third.json()) as { error: string; hint: string };
  assert.equal(limitedBody.error, "rate_limited");
  assert.match(limitedBody.hint, /REST API/);

  const huge = "x".repeat(80);
  const oversize = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/send", {
      method: "POST",
      headers: { "content-length": String(huge.length + 40), authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: "neighbor@example.test", subject: "big", text: huge }),
    }),
    env(db, { REST_BODY_MAX_BYTES: "64" }),
  );
  assert.ok(oversize);
  assert.equal(oversize.status, 413);
  const oversizeBody = (await oversize.json()) as { error: string; max_bytes: number };
  assert.equal(oversizeBody.error, "payload_too_large");
  assert.equal(oversizeBody.max_bytes, 64);

  const tooLongText = "y".repeat(DEFAULT_REST_BODY_MAX_BYTES + 1);
  const sendTooBig = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/send", {
      method: "POST",
      body: JSON.stringify({ to: "neighbor@example.test", subject: "ok", text: tooLongText }),
    }),
    env(db),
  );
  assert.ok(sendTooBig);
  assert.ok(sendTooBig.status === 400 || sendTooBig.status === 413);
});

test("owner session mints and revokes a mailbox token", async () => {
  const db = new MemoryD1();
  const cookie = `${OWNER_SESSION_COOKIE}=${await signOwnerSession(SECRET, {
    mailboxId: MAILBOX_A.id,
    address: MAILBOX_A.address,
  })}`;
  const testEnv = env(db);

  const owner = await requireOwner(
    new Request("http://127.0.0.1:8787/api/tokens", { headers: { cookie } }),
    testEnv,
  );
  assert.equal(owner.ok, true);
  if (!owner.ok) {
    throw new Error("expected owner session");
  }

  const minted = await handleOwnerTokenRoutes(
    new Request("http://127.0.0.1:8787/api/tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "local-ci" }),
    }),
    testEnv,
    new URL("http://127.0.0.1:8787/api/tokens"),
    owner.principal,
  );
  assert.ok(minted);
  assert.equal(minted.status, 201);
  const mintedBody = (await minted.json()) as { token: { token: string; id: string; label: string } };
  assert.equal(mintedBody.token.label, "local-ci");
  assert.equal(looksLikeApiToken(mintedBody.token.token), true);

  const listed = await handleOwnerTokenRoutes(
    new Request("http://127.0.0.1:8787/api/tokens", { headers: { cookie } }),
    testEnv,
    new URL("http://127.0.0.1:8787/api/tokens"),
    owner.principal,
  );
  assert.ok(listed);
  assert.equal(listed.status, 200);

  const revoked = await handleOwnerTokenRoutes(
    new Request(`http://127.0.0.1:8787/api/tokens/${mintedBody.token.id}/revoke`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    }),
    testEnv,
    new URL(`http://127.0.0.1:8787/api/tokens/${mintedBody.token.id}/revoke`),
    owner.principal,
  );
  assert.ok(revoked);
  assert.equal(revoked.status, 200);

  const denied = await rest(
    bearer(mintedBody.token.token, "http://127.0.0.1:8787/api/v1/mailboxes"),
    testEnv,
  );
  assert.ok(denied);
  assert.equal(denied.status, 401);
});

test("admin bearer mints a token for a mailbox", async () => {
  const db = new MemoryD1();
  const response = await rest(
    new Request("http://127.0.0.1:8787/admin/tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mailbox_id: MAILBOX_B.id, label: "admin-mint" }),
    }),
    env(db),
  );
  assert.ok(response);
  assert.equal(response.status, 201);
  const body = (await response.json()) as { token: { token: string; mailbox_id: string } };
  assert.equal(body.token.mailbox_id, MAILBOX_B.id);
  assert.equal(looksLikeApiToken(body.token.token), true);
});

test("cookie owner /api stays on the session path (no token regression)", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const unauth = await requireOwner(new Request("http://127.0.0.1:8787/api/mailboxes"), testEnv);
  assert.equal(unauth.ok, false);
  if (!unauth.ok) {
    assert.equal(unauth.response.status, 401);
  }

  const cookie = `${OWNER_SESSION_COOKIE}=${await signOwnerSession(SECRET, {
    mailboxId: MAILBOX_A.id,
    address: MAILBOX_A.address,
  })}`;
  const ok = await requireOwner(
    new Request("http://127.0.0.1:8787/api/mailboxes", { headers: { cookie } }),
    testEnv,
  );
  assert.equal(ok.ok, true);

  const tokenOnly = await rest(
    new Request("http://127.0.0.1:8787/api/v1/mailboxes", { headers: { cookie } }),
    testEnv,
  );
  assert.ok(tokenOnly);
  assert.equal(tokenOnly.status, 401);
});

test("verifyTurnstile posts siteverify and honors success", async () => {
  setTurnstileFetchForTests(async (input, init) => {
    assert.equal(String(input), TURNSTILE_SITEVERIFY_URL);
    assert.match(String(init?.body), /remoteip=198.51.100.9/);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  const ok = await verifyTurnstile({
    secret: "s",
    response: "r",
    remoteip: "198.51.100.9",
  });
  assert.equal(ok.ok, true);

  const empty = await verifyTurnstile({ secret: "s", response: "" });
  assert.equal(empty.ok, false);
});

test("default REST rate limit constant matches README (60/min)", () => {
  assert.equal(REST_RATE_LIMIT_MAX, 60);
  assert.equal(DEFAULT_REST_BODY_MAX_BYTES, 256_000);
});
