import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  AliasInputError,
  createAlias,
  generateAlias,
  primaryAddressFromPlusTag,
  renderAliasPanelHtml,
  resolveInboundMailbox,
  stripPlusTag,
} from "../src/aliases.ts";
import { insertApiToken, looksLikeApiToken } from "../src/api-tokens.ts";
import { handleApi } from "../src/api.ts";
import { OWNER_SESSION_COOKIE, requireOwner, signOwnerSession } from "../src/auth.ts";
import type { Env, InboundEmail } from "../src/env.ts";
import { handleInbound } from "../src/inbound.ts";
import { REST_CROSS_MAILBOX_HINT, handleRestRoutes } from "../src/rest.ts";
import { REST_RATE_LIMIT_MAX, resetRateLimitForTests } from "../src/rate-limit.ts";
import { listInboxMessages } from "../src/store.ts";

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
  aliases: Row[] = [];
  usage: Row[] = [];
  users: Row[] = [];
  hooks: Row[] = [];

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
    const [a, b, c] = this.binds;
    if (sql.includes("from sqlite_master")) {
      return [
        "mailboxes",
        "messages",
        "outbound_attempts",
        "api_tokens",
        "users",
        "inbound_hooks",
        "inbound_deliveries",
        "mailbox_aliases",
      ].map((name) => ({ name }));
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
    if (sql.includes("from mailbox_aliases")) {
      let rows = this.db.aliases.slice();
      if (sql.includes("select count(*)")) {
        rows = rows.filter((row) => row.mailbox_id === a);
        return [{ n: rows.length }];
      }
      if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("where local_part =") && sql.includes("and domain =")) {
        rows = rows.filter(
          (row) =>
            String(row.local_part).toLowerCase() === String(a).toLowerCase() &&
            String(row.domain).toLowerCase() === String(b).toLowerCase(),
        );
      } else if (sql.includes("where mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
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
    if (sql.includes("from api_token_usage")) {
      return this.db.usage.filter((row) => row.token_id === a && row.day === b);
    }
    if (sql.includes("from users")) {
      return this.db.users.slice();
    }
    if (sql.includes("from inbound_hooks")) {
      return this.db.hooks.filter((row) => row.mailbox_id === a);
    }
    if (sql.includes("from messages")) {
      let rows = this.db.messages.slice();
      if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.folder === "inbox");
      }
      if (sql.includes("like")) {
        const needle = String(b ?? "")
          .replace(/^%/, "")
          .replace(/%$/, "")
          .toLowerCase();
        rows = rows.filter((row) => {
          const hay = [row.envelope_from, row.envelope_to, row.subject, row.body_text]
            .map((value) => String(value ?? "").toLowerCase())
            .join("\n");
          return hay.includes(needle);
        });
      }
      return rows.sort((left, right) => Number(right.received_at) - Number(left.received_at));
    }
    if (sql.includes("from site_settings")) {
      return [];
    }
    return [];
  }

  mutate() {
    const sql = collapse(this.sql);
    const binds = this.binds;
    if (sql.startsWith("insert into mailbox_aliases")) {
      const dup = this.db.aliases.some(
        (row) =>
          String(row.local_part).toLowerCase() === String(binds[2]).toLowerCase() &&
          String(row.domain).toLowerCase() === String(binds[3]).toLowerCase(),
      );
      if (dup) {
        throw new Error("UNIQUE constraint failed: mailbox_aliases");
      }
      this.db.aliases.push({
        id: binds[0],
        mailbox_id: binds[1],
        local_part: binds[2],
        domain: binds[3],
        created_at: binds[4],
      });
      return 1;
    }
    if (sql.startsWith("delete from mailbox_aliases")) {
      const before = this.db.aliases.length;
      this.db.aliases = this.db.aliases.filter((row) => row.id !== binds[0]);
      return before === this.db.aliases.length ? 0 : 1;
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
        kind: binds[6] ?? "mailbox",
        quota_requests_daily: binds[7] ?? 0,
        quota_send_daily: binds[8] ?? 0,
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
    if (sql.startsWith("insert into api_token_usage")) {
      const day = String(binds[1]);
      const existing = this.db.usage.find((row) => row.token_id === binds[0] && row.day === day);
      const addReq = sql.includes("request_count = request_count + 1") || Number(binds[2]) === 1;
      const addSend = sql.includes("send_count = send_count + 1") || Number(binds[3]) === 1;
      if (existing) {
        if (addReq) {
          existing.request_count = Number(existing.request_count) + 1;
        }
        if (addSend) {
          existing.send_count = Number(existing.send_count) + 1;
        }
      } else {
        this.db.usage.push({
          token_id: binds[0],
          day,
          request_count: addReq ? 1 : 0,
          send_count: addSend ? 1 : 0,
        });
      }
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
        is_read: 0,
        is_starred: 0,
        folder: "inbox",
        received_at: binds[14],
        created_at: binds[14],
      });
      return 1;
    }
    if (sql.startsWith("insert into outbound_attempts") || sql.startsWith("insert into messages")) {
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

function bearer(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

function inboundMail(to: string, opts: { subject?: string; id?: string; body?: string } = {}): {
  message: InboundEmail;
  rejected: () => string | null;
} {
  let reason: string | null = null;
  const subject = opts.subject ?? "plus tag note";
  const id = opts.id ?? `plus-${crypto.randomUUID()}`;
  const body = opts.body ?? "hello plus-tag";
  const raw = `From: sender@example.test
To: ${to}
Subject: ${subject}
Message-ID: <${id}@example.test>
Content-Type: text/plain

${body}
`;
  return {
    message: {
      from: "sender@example.test",
      to,
      headers: new Headers({
        subject,
        "message-id": `<${id}@example.test>`,
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

beforeEach(() => {
  resetRateLimitForTests();
});

test("plus-tag helpers follow RFC 5233 / Gmail-like first +", () => {
  assert.deepEqual(stripPlusTag("inbox+promo"), { localPart: "inbox", tag: "promo" });
  assert.deepEqual(stripPlusTag("inbox+promo+extra"), { localPart: "inbox", tag: "promo+extra" });
  assert.deepEqual(stripPlusTag("+only"), { localPart: "+only", tag: null });
  assert.deepEqual(primaryAddressFromPlusTag("Inbox+Shop@Example.TEST"), {
    address: "inbox@example.test",
    localPart: "inbox",
    domain: "example.test",
  });
});

test("TC15.1 mail to user+tag@domain lands in the primary mailbox and is searchable", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const resolved = await resolveInboundMailbox(testEnv, "inbox+promo@example.test");
  assert.ok(resolved);
  assert.equal(resolved.mailbox.id, MAILBOX_A.id);
  assert.equal(resolved.envelopeTo, "inbox+promo@example.test");
  assert.equal(resolved.via, "plus_tag");

  const mail = inboundMail("inbox+promo@example.test", {
    subject: "promo drop",
    body: "use tag promo",
    id: "plus-promo-1",
  });
  await handleInbound(mail.message, testEnv);
  assert.equal(mail.rejected(), null);
  assert.equal(db.messages.length, 1);
  assert.equal(db.messages[0]?.mailbox_id, MAILBOX_A.id);
  assert.equal(db.messages[0]?.envelope_to, "inbox+promo@example.test");

  const hits = await listInboxMessages(testEnv, MAILBOX_A.id, { q: "promo" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.envelope_to, "inbox+promo@example.test");
});

test("TC15.2 alias generate/list is own-domain only; illegal domain is 400", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const mailbox = { ...MAILBOX_A };

  const generated = await generateAlias(testEnv, mailbox);
  assert.equal(generated.domain, "example.test");
  assert.match(generated.local_part, /^inbox\+[0-9a-f]{8}$/);

  await assert.rejects(
    () => createAlias(testEnv, mailbox, "inbox+x@evil.test"),
    (error: unknown) => {
      assert.ok(error instanceof AliasInputError);
      assert.equal(error.error, "alias_domain_forbidden");
      return true;
    },
  );

  const token = (await insertApiToken(testEnv, MAILBOX_A.id, "alias-user")).token;
  const listed = await rest(bearer(token, "http://127.0.0.1:8787/api/v1/aliases"), testEnv);
  assert.ok(listed);
  assert.equal(listed.status, 200);
  const listedBody = (await listed.json()) as { aliases: { address: string }[] };
  assert.equal(listedBody.aliases.some((row) => row.address === `${generated.local_part}@example.test`), true);

  const created = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/aliases", {
      method: "POST",
      body: JSON.stringify({ address: "notes@example.test" }),
    }),
    testEnv,
  );
  assert.ok(created);
  assert.equal(created.status, 201);
  const viaAlias = await resolveInboundMailbox(testEnv, "notes@example.test");
  assert.ok(viaAlias);
  assert.equal(viaAlias.mailbox.id, MAILBOX_A.id);
  assert.equal(viaAlias.via, "alias");

  const rejected = await rest(
    bearer(token, "http://127.0.0.1:8787/api/v1/aliases", {
      method: "POST",
      body: JSON.stringify({ address: "inbox+x@other.test" }),
    }),
    testEnv,
  );
  assert.ok(rejected);
  assert.equal(rejected.status, 400);
  const rejectedBody = (await rejected.json()) as { error: string };
  assert.equal(rejectedBody.error, "alias_domain_forbidden");

  const html = renderAliasPanelHtml(
    mailbox,
    [{ id: "a1", mailbox_id: mailbox.id, local_part: "<script>alert(1)</script>", domain: "example.test", created_at: 1 }],
    {
      heading: "Aliases",
      hint: "hint",
      generate: "Generate",
      custom: "Custom",
      submit: "Add",
      empty: "empty",
      primary: "Primary",
    },
  );
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);
});

test("TC15.3 admin vs mailbox keys: authz, bad key 401, cross-tenant 403", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);
  const userToken = (await insertApiToken(testEnv, MAILBOX_A.id, "user")).token;
  const otherToken = (await insertApiToken(testEnv, MAILBOX_B.id, "other")).token;
  const adminMint = await rest(
    new Request("http://127.0.0.1:8787/admin/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ mailbox_id: MAILBOX_A.id, label: "ops", kind: "admin" }),
    }),
    testEnv,
  );
  assert.ok(adminMint);
  assert.equal(adminMint.status, 201);
  const adminBody = (await adminMint.json()) as { token: { token: string; kind: string } };
  assert.equal(adminBody.token.kind, "admin");
  assert.equal(looksLikeApiToken(adminBody.token.token), true);

  const userSelf = await rest(bearer(userToken, "http://127.0.0.1:8787/api/v1/mailboxes"), testEnv);
  assert.ok(userSelf);
  assert.equal(userSelf.status, 200);
  const userSelfBody = (await userSelf.json()) as { mailboxes: { id: string }[] };
  assert.equal(userSelfBody.mailboxes.length, 1);

  const adminAll = await rest(bearer(adminBody.token.token, "http://127.0.0.1:8787/api/v1/mailboxes"), testEnv);
  assert.ok(adminAll);
  assert.equal(adminAll.status, 200);
  const adminAllBody = (await adminAll.json()) as { mailboxes: { id: string }[] };
  assert.equal(adminAllBody.mailboxes.length, 2);

  const bad = await rest(
    bearer("pg_this-is-not-a-real-token-value", "http://127.0.0.1:8787/api/v1/aliases"),
    testEnv,
  );
  assert.ok(bad);
  assert.equal(bad.status, 401);

  const cross = await rest(
    bearer(userToken, `http://127.0.0.1:8787/api/v1/mailboxes/${MAILBOX_B.id}/aliases`),
    testEnv,
  );
  assert.ok(cross);
  assert.equal(cross.status, 403);
  const crossBody = (await cross.json()) as { error: string; hint: string };
  assert.equal(crossBody.error, "forbidden");
  assert.equal(crossBody.hint, REST_CROSS_MAILBOX_HINT);

  const otherDenied = await rest(
    bearer(otherToken, `http://127.0.0.1:8787/api/v1/mailboxes/${MAILBOX_A.id}/aliases`, {
      method: "POST",
      body: JSON.stringify({ generate: true }),
    }),
    testEnv,
  );
  assert.ok(otherDenied);
  assert.equal(otherDenied.status, 403);

  const mintAdminDenied = await rest(
    bearer(userToken, "http://127.0.0.1:8787/api/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ kind: "admin", label: "nope" }),
    }),
    testEnv,
  );
  assert.ok(mintAdminDenied);
  assert.equal(mintAdminDenied.status, 403);

  const adminAlias = await rest(
    bearer(adminBody.token.token, `http://127.0.0.1:8787/api/v1/mailboxes/${MAILBOX_B.id}/aliases`, {
      method: "POST",
      body: JSON.stringify({ generate: true }),
    }),
    testEnv,
  );
  assert.ok(adminAlias);
  assert.equal(adminAlias.status, 201);
});

test("TC15.4 over rate is 429; over API quota is quota_api; under succeeds", async () => {
  const db = new MemoryD1();
  const limitedEnv = env(db, { REST_RATE_LIMIT_MAX: "2" });
  const rateToken = (await insertApiToken(limitedEnv, MAILBOX_A.id, "rate")).token;
  const first = await rest(bearer(rateToken, "http://127.0.0.1:8787/api/v1/mailboxes"), limitedEnv);
  const second = await rest(bearer(rateToken, "http://127.0.0.1:8787/api/v1/mailboxes"), limitedEnv);
  assert.ok(first && second);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const third = await rest(bearer(rateToken, "http://127.0.0.1:8787/api/v1/mailboxes"), limitedEnv);
  assert.ok(third);
  assert.equal(third.status, 429);
  const rateBody = (await third.json()) as { error: string };
  assert.equal(rateBody.error, "rate_limited");

  resetRateLimitForTests();
  const quotaEnv = env(db);
  const quotaToken = (
    await insertApiToken(quotaEnv, MAILBOX_A.id, "quota", { quotaRequestsDaily: 2 })
  ).token;
  const q1 = await rest(bearer(quotaToken, "http://127.0.0.1:8787/api/v1/mailboxes"), quotaEnv);
  const q2 = await rest(bearer(quotaToken, "http://127.0.0.1:8787/api/v1/mailboxes"), quotaEnv);
  assert.ok(q1 && q2);
  assert.equal(q1.status, 200);
  assert.equal(q2.status, 200);
  const q3 = await rest(bearer(quotaToken, "http://127.0.0.1:8787/api/v1/mailboxes"), quotaEnv);
  assert.ok(q3);
  assert.equal(q3.status, 429);
  const quotaBody = (await q3.json()) as { error: string; used: number; limit: number };
  assert.equal(quotaBody.error, "quota_api");
  assert.equal(quotaBody.limit, 2);
  assert.equal(REST_RATE_LIMIT_MAX, 60);
});

test("TC15.5 unauthenticated manage keys / change aliases is 401; cookie owner can manage own aliases", async () => {
  const db = new MemoryD1();
  const testEnv = env(db);

  const unauthAlias = await rest(
    new Request("http://127.0.0.1:8787/api/v1/aliases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generate: true }),
    }),
    testEnv,
  );
  assert.ok(unauthAlias);
  assert.equal(unauthAlias.status, 401);

  const unauthToken = await rest(
    new Request("http://127.0.0.1:8787/api/v1/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    }),
    testEnv,
  );
  assert.ok(unauthToken);
  assert.equal(unauthToken.status, 401);

  const cookieApi = await handleApi(
    new Request("http://127.0.0.1:8787/api/aliases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generate: true }),
    }),
    testEnv,
    new URL("http://127.0.0.1:8787/api/aliases"),
  );
  assert.equal(cookieApi.status, 401);

  const cookie = `${OWNER_SESSION_COOKIE}=${await signOwnerSession(SECRET, {
    mailboxId: MAILBOX_A.id,
    address: MAILBOX_A.address,
  })}`;
  const owner = await requireOwner(
    new Request("http://127.0.0.1:8787/api/aliases", { headers: { cookie } }),
    testEnv,
  );
  assert.equal(owner.ok, true);

  const created = await handleApi(
    new Request("http://127.0.0.1:8787/api/aliases", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ generate: true }),
    }),
    testEnv,
    new URL("http://127.0.0.1:8787/api/aliases"),
  );
  assert.equal(created.status, 201);
});
