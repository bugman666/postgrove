import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAdmin } from "../src/admin.ts";
import {
  ADMIN_SESSION_COOKIE,
  handleAuthRoutes,
  OWNER_SESSION_COOKIE,
  requireAdmin,
  requireOwner,
  signOwnerSession,
  signUserSession,
} from "../src/auth.ts";
import { handleApi } from "../src/api.ts";
import type { Env } from "../src/env.ts";
import { inboundStorageRejection } from "../src/quotas.ts";
import { sendOutbound } from "../src/send.ts";
import {
  createUser,
  hashUserToken,
  mailboxAllowed,
  type UserRecord,
} from "../src/users.ts";

const SECRET = "change-me-local-session-secret";
const OWNER = "change-me-local-owner-token";
const ADMIN = "change-me-local-admin-token";
const USER_TOKEN = "change-me-local-user-token";
const INBOX = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "inbox@example.test",
  local_part: "inbox",
  domain: "example.test",
  display_name: "Local inbox",
  status: "active",
  created_at: 1,
  updated_at: 1,
};
const EMPTY = {
  id: "11111111-1111-4111-8111-111111111112",
  address: "empty@example.test",
  local_part: "empty",
  domain: "example.test",
  display_name: "Empty box",
  status: "active",
  created_at: 2,
  updated_at: 2,
};

type Row = Record<string, unknown>;

class MemoryD1 {
  users: Row[] = [];
  user_mailboxes: Row[] = [];
  send_usage: Row[] = [];
  mailboxes: Row[] = [{ ...INBOX }, { ...EMPTY }];
  messages: Row[] = [
    {
      id: "22222222-2222-4222-8222-222222222221",
      mailbox_id: INBOX.id,
      envelope_from: "neighbor@example.test",
      envelope_to: INBOX.address,
      subject: "欢迎",
      snippet: "种子",
      size_bytes: 220,
      folder: "inbox",
      received_at: 10,
      created_at: 10,
    },
  ];

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
    if (sql.includes("from users")) {
      let rows = this.db.users.slice();
      if (sql.includes("from user_mailboxes where mailbox_id")) {
        const ids = new Set(
          this.db.user_mailboxes.filter((row) => row.mailbox_id === a).map((row) => row.user_id),
        );
        rows = rows.filter((row) => ids.has(row.id));
        if (sql.includes("status = 'active'")) {
          rows = rows.filter((row) => row.status === "active");
        }
      } else if (sql.includes("where login =")) {
        rows = rows.filter((row) => String(row.login).toLowerCase() === String(a).toLowerCase());
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      }
      return rows;
    }
    if (sql.includes("from user_mailboxes") && !sql.includes("from messages") && !sql.includes("from users") && !sql.includes("from mailboxes")) {
      let rows = this.db.user_mailboxes.slice();
      if (sql.includes("where user_id =")) {
        rows = rows.filter((row) => row.user_id === a);
      }
      if (sql.includes("select count(*)")) {
        return [{ n: rows.length }];
      }
      if (sql.includes("select mailbox_id")) {
        return rows;
      }
      return rows;
    }
    if (sql.includes("from send_usage")) {
      const rows = this.db.send_usage.filter((row) => row.user_id === a && row.day === b);
      return rows;
    }
    if (sql.includes("from mailboxes")) {
      let rows = this.db.mailboxes.slice();
      if (sql.includes("where address =")) {
        rows = rows.filter((row) => row.address === String(a).toLowerCase());
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("select mailbox_id from user_mailboxes")) {
        const ids = new Set(
          this.db.user_mailboxes.filter((row) => row.user_id === a).map((row) => row.mailbox_id),
        );
        rows = rows.filter((row) => ids.has(row.id));
      }
      return rows;
    }
    if (sql.includes("from messages")) {
      let rows = this.db.messages.slice();
      if (sql.includes("sum(size_bytes)") || sql.includes("as used")) {
        const ids = new Set(
          this.db.user_mailboxes.filter((row) => row.user_id === a).map((row) => row.mailbox_id),
        );
        const used = rows
          .filter((row) => ids.has(row.mailbox_id))
          .reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0);
        return [{ used }];
      }
      if (sql.includes("where id =") && sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.id === a && row.mailbox_id === b);
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.received_at) - Number(left.received_at));
    }
    if (sql.includes("from outbound_attempts")) {
      return [];
    }
    return [];
  }

  mutate(): number {
    const sql = collapse(this.sql);
    const binds = this.binds;

    if (sql.startsWith("insert into users")) {
      this.db.users.push({
        id: binds[0],
        login: binds[1],
        display_name: binds[2],
        role: binds[3],
        status: binds[4],
        token_salt: binds[5],
        token_hash: binds[6],
        quota_addresses: binds[7],
        quota_storage_bytes: binds[8],
        quota_send_daily: binds[9],
        created_at: binds[10],
        updated_at: binds[11],
      });
      return 1;
    }
    if (sql.startsWith("insert or ignore into user_mailboxes") || sql.startsWith("insert into user_mailboxes")) {
      const exists = this.db.user_mailboxes.some(
        (row) => row.user_id === binds[0] && row.mailbox_id === binds[1],
      );
      if (!exists) {
        this.db.user_mailboxes.push({
          user_id: binds[0],
          mailbox_id: binds[1],
          created_at: binds[2],
        });
        return 1;
      }
      return 0;
    }
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
    if (sql.startsWith("insert into messages")) {
      this.db.messages.unshift({
        id: binds[0],
        mailbox_id: binds[1],
        envelope_from: binds[3],
        envelope_to: binds[4],
        subject: binds[5],
        snippet: binds[6],
        size_bytes: binds[13],
        folder: binds[16],
        received_at: binds[17],
        created_at: binds[18],
      });
      return 1;
    }
    if (sql.startsWith("insert into outbound_attempts")) {
      return 1;
    }
    if (sql.startsWith("insert into send_usage")) {
      const existing = this.db.send_usage.find((row) => row.user_id === binds[0] && row.day === binds[1]);
      if (existing) {
        existing.count = Number(existing.count) + 1;
      } else {
        this.db.send_usage.push({ user_id: binds[0], day: binds[1], count: 1 });
      }
      return 1;
    }
    if (sql.startsWith("update users set status")) {
      const row = this.db.users.find((item) => item.id === binds[0]);
      if (!row) {
        return 0;
      }
      row.status = binds[1];
      row.updated_at = binds[2];
      return 1;
    }
    if (sql.startsWith("update users set quota_addresses")) {
      const row = this.db.users.find((item) => item.id === binds[0]);
      if (!row) {
        return 0;
      }
      row.quota_addresses = binds[1];
      row.quota_storage_bytes = binds[2];
      row.quota_send_daily = binds[3];
      row.updated_at = binds[4];
      return 1;
    }
    if (sql.startsWith("update mailboxes set status")) {
      const row = this.db.mailboxes.find((item) => item.id === binds[0]);
      if (!row) {
        return 0;
      }
      row.status = binds[1];
      row.updated_at = binds[2];
      return 1;
    }
    return 0;
  }
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function testEnv(db = new MemoryD1(), overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
    ADMIN_TOKEN: ADMIN,
    OUTBOUND_PROVIDER: "stub",
    ...overrides,
  };
}

async function seedMember(
  db: MemoryD1,
  opts: {
    login?: string;
    role?: "admin" | "mailbox";
    mailboxId?: string;
    token?: string;
    quotaAddresses?: number;
    quotaStorage?: number;
    quotaSend?: number;
    status?: "active" | "disabled";
  } = {},
): Promise<UserRecord> {
  const env = testEnv(db);
  const created = await createUser(env, {
    login: opts.login ?? "grove",
    role: opts.role ?? "mailbox",
    token: opts.token ?? USER_TOKEN,
    status: opts.status,
    quotaAddresses: opts.quotaAddresses,
    quotaStorageBytes: opts.quotaStorage,
    quotaSendDaily: opts.quotaSend,
  });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_mailboxes (user_id, mailbox_id, created_at) VALUES (?1, ?2, ?3)`,
  )
    .bind(created.user.id, opts.mailboxId ?? EMPTY.id, Date.now())
    .run();
  return created.user;
}

function cookieHeader(name: string, value: string): string {
  return `${name}=${value}`;
}

test("hashUserToken is stable for the local seed pair", async () => {
  const digest = await hashUserToken(USER_TOKEN, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(digest, "0d9fa095f9fe59e2231dea53a87cd93cdb5e67b55bffb5d31ad2a933d4a0eef8");
});

test("TC10.1 admin can create and list mailbox users", async () => {
  const db = new MemoryD1();
  const env = testEnv(db);
  const created = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/users", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        login: "ada",
        role: "mailbox",
        token: USER_TOKEN,
        mailbox: "ada@example.test",
        quota_addresses: 2,
      }),
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/users"),
  );
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    ok: boolean;
    user: { login: string; role: string };
    mailbox: { address: string } | null;
    token: string;
  };
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.user.login, "ada");
  assert.equal(createdBody.user.role, "mailbox");
  assert.equal(createdBody.mailbox?.address, "ada@example.test");
  assert.equal(createdBody.token, USER_TOKEN);

  const listed = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/users", {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/users"),
  );
  assert.equal(listed.status, 200);
  const listBody = (await listed.json()) as { users: { login: string }[] };
  assert.equal(listBody.users.some((row) => row.login === "ada"), true);
});

test("TC10.2 mailbox session cannot read another mailbox or admin API", async () => {
  const db = new MemoryD1();
  const user = await seedMember(db);
  const env = testEnv(db);
  const token = await signUserSession(SECRET, {
    mailboxId: EMPTY.id,
    address: EMPTY.address,
    userId: user.id,
    role: "mailbox",
  });
  const cookie = cookieHeader(OWNER_SESSION_COOKIE, token);

  const other = await handleApi(
    new Request(`http://127.0.0.1:8787/api/mailboxes/${INBOX.id}/messages`, {
      headers: { cookie },
    }),
    env,
    new URL(`http://127.0.0.1:8787/api/mailboxes/${INBOX.id}/messages`),
  );
  assert.equal(other.status, 403);

  const adminApi = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/users", {
      headers: { cookie },
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/users"),
  );
  assert.equal(adminApi.status, 403);
  const body = (await adminApi.json()) as { error: string };
  assert.equal(body.error, "forbidden");

  const own = await handleApi(
    new Request(`http://127.0.0.1:8787/api/mailboxes/${EMPTY.id}/messages`, {
      headers: { cookie },
    }),
    env,
    new URL(`http://127.0.0.1:8787/api/mailboxes/${EMPTY.id}/messages`),
  );
  assert.equal(own.status, 200);
});

test("TC10.3 admin audit lists users and mail read-only", async () => {
  const db = new MemoryD1();
  await seedMember(db);
  const env = testEnv(db);
  const messages = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/messages", {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/messages"),
  );
  assert.equal(messages.status, 200);
  const body = (await messages.json()) as { audit: boolean; messages: { subject: string }[] };
  assert.equal(body.audit, true);
  assert.equal(body.messages[0]?.subject, "欢迎");

  const write = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
      },
      body: "{}",
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/messages"),
  );
  assert.equal(write.status, 405);
});

test("TC10.4 quotas fail loud for address / storage / send", async () => {
  const db = new MemoryD1();
  const user = await seedMember(db, {
    quotaAddresses: 1,
    quotaStorage: 100,
    quotaSend: 1,
  });
  const env = testEnv(db);

  const address = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/mailboxes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "second@example.test", user_id: user.id }),
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/mailboxes"),
  );
  assert.equal(address.status, 409);
  const addressBody = (await address.json()) as { error: string; hint: string };
  assert.equal(addressBody.error, "quota_addresses");
  assert.match(addressBody.hint, /地址配额/);

  db.messages.push({
    id: "m-used",
    mailbox_id: EMPTY.id,
    size_bytes: 80,
    envelope_from: "a@b.test",
    envelope_to: EMPTY.address,
    folder: "inbox",
    received_at: 1,
    created_at: 1,
  });
  const storage = await inboundStorageRejection(env, EMPTY.id, 50);
  assert.ok(storage);
  assert.equal(storage.error, "quota_storage");
  assert.match(storage.hint, /存储配额/);

  const mailbox = {
    id: EMPTY.id,
    address: EMPTY.address,
    local_part: EMPTY.local_part,
    domain: EMPTY.domain,
    display_name: EMPTY.display_name,
    status: "active",
  };
  const first = await sendOutbound(
    env,
    mailbox,
    { to: "neighbor@example.test", cc: "", subject: "one", text: "hi", inReplyTo: null, references: null },
    { userId: user.id },
  );
  assert.equal(first.httpStatus, 200);
  const second = await sendOutbound(
    env,
    mailbox,
    { to: "neighbor@example.test", cc: "", subject: "two", text: "hi", inReplyTo: null, references: null },
    { userId: user.id },
  );
  assert.equal(second.httpStatus, 429);
  assert.equal(second.attempt.error, "quota_send");
  assert.match(second.attempt.hint ?? "", /发送配额/);
});

test("TC10.5 unauthenticated user/quota routes are 401", async () => {
  const env = testEnv();
  const users = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/users"),
    env,
    new URL("http://127.0.0.1:8787/admin/users"),
  );
  assert.equal(users.status, 401);

  const addresses = await handleApi(
    new Request("http://127.0.0.1:8787/api/addresses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "x@example.test" }),
    }),
    env,
    new URL("http://127.0.0.1:8787/api/addresses"),
  );
  assert.equal(addresses.status, 401);

  const html = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin"),
    env,
    new URL("http://127.0.0.1:8787/admin"),
  );
  assert.equal(html.status, 401);
});

test("OWNER_TOKEN and ADMIN_TOKEN still work as documented", async () => {
  const env = testEnv();
  const login = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: INBOX.address, token: OWNER }),
    }),
    env,
  );
  assert.ok(login);
  assert.equal(login.status, 200);
  const loginBody = (await login.json()) as { role: string };
  assert.equal(loginBody.role, "owner");

  const ping = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/admin/ping", {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env,
  );
  assert.ok(ping);
  assert.equal(ping.status, 200);
});

test("member token logs into the bound mailbox", async () => {
  const db = new MemoryD1();
  const user = await seedMember(db);
  const env = testEnv(db);
  const login = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: EMPTY.address, token: USER_TOKEN }),
    }),
    env,
  );
  assert.ok(login);
  assert.equal(login.status, 200);
  const body = (await login.json()) as { role: string; user: { id: string } };
  assert.equal(body.role, "mailbox");
  assert.equal(body.user.id, user.id);
});

test("disabled member cannot keep using the session", async () => {
  const db = new MemoryD1();
  const user = await seedMember(db);
  const env = testEnv(db);
  await handleAdmin(
    new Request(`http://127.0.0.1:8787/admin/users/${user.id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "disabled" }),
    }),
    env,
    new URL(`http://127.0.0.1:8787/admin/users/${user.id}`),
  );
  const token = await signUserSession(SECRET, {
    mailboxId: EMPTY.id,
    address: EMPTY.address,
    userId: user.id,
    role: "mailbox",
  });
  const gated = await requireOwner(
    new Request("http://127.0.0.1:8787/api/mailboxes", {
      headers: { cookie: cookieHeader(OWNER_SESSION_COOKIE, token) },
    }),
    env,
  );
  assert.equal(gated.ok, false);
  if (!gated.ok) {
    assert.equal(gated.response.status, 403);
  }
});

test("admin-role mailbox session can open admin routes", async () => {
  const db = new MemoryD1();
  const user = await seedMember(db, { login: "keeper", role: "admin", mailboxId: EMPTY.id });
  const env = testEnv(db);
  const token = await signUserSession(SECRET, {
    mailboxId: EMPTY.id,
    address: EMPTY.address,
    userId: user.id,
    role: "admin",
  });
  const listed = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/users", {
      headers: { cookie: cookieHeader(OWNER_SESSION_COOKIE, token) },
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/users"),
  );
  assert.equal(listed.status, 200);
});

test("POST /admin/session issues an admin cookie", async () => {
  const env = testEnv();
  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ADMIN }),
    }),
    env,
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(ADMIN_SESSION_COOKIE));

  const session = await requireAdmin(
    new Request("http://127.0.0.1:8787/admin/users", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    }),
    env,
  );
  assert.equal(session.ok, true);
});

test("owner session stays bound to the login mailbox", async () => {
  const token = await signOwnerSession(SECRET, {
    mailboxId: INBOX.id,
    address: INBOX.address,
  });
  assert.equal(
    mailboxAllowed(
      { kind: "owner", mailboxId: INBOX.id, address: INBOX.address },
      { ...EMPTY, display_name: null },
    ),
    false,
  );
  const env = testEnv();
  const owner = await requireOwner(
    new Request("http://127.0.0.1:8787/x", {
      headers: { cookie: cookieHeader(OWNER_SESSION_COOKIE, token) },
    }),
    env,
  );
  assert.equal(owner.ok, true);
  if (owner.ok) {
    assert.equal(owner.principal.kind, "owner");
  }
});

test("member can create an address under quota", async () => {
  const db = new MemoryD1();
  const user = await seedMember(db, { quotaAddresses: 3 });
  const env = testEnv(db);
  const token = await signUserSession(SECRET, {
    mailboxId: EMPTY.id,
    address: EMPTY.address,
    userId: user.id,
    role: "mailbox",
  });
  const response = await handleApi(
    new Request("http://127.0.0.1:8787/api/addresses", {
      method: "POST",
      headers: {
        cookie: cookieHeader(OWNER_SESSION_COOKIE, token),
        "content-type": "application/json",
        origin: "http://127.0.0.1:8787",
      },
      body: JSON.stringify({ address: "notes@example.test" }),
    }),
    env,
    new URL("http://127.0.0.1:8787/api/addresses"),
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { mailbox: { address: string } };
  assert.equal(body.mailbox.address, "notes@example.test");
});

test("TC10.2 owner session is 403 on admin APIs and other mailboxes", async () => {
  const env = testEnv();
  const token = await signOwnerSession(SECRET, {
    mailboxId: INBOX.id,
    address: INBOX.address,
  });
  const cookie = cookieHeader(OWNER_SESSION_COOKIE, token);

  const adminApi = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/users", { headers: { cookie } }),
    env,
    new URL("http://127.0.0.1:8787/admin/users"),
  );
  assert.equal(adminApi.status, 403);

  const other = await handleApi(
    new Request(`http://127.0.0.1:8787/api/mailboxes/${EMPTY.id}/messages`, {
      headers: { cookie },
    }),
    env,
    new URL(`http://127.0.0.1:8787/api/mailboxes/${EMPTY.id}/messages`),
  );
  assert.equal(other.status, 403);
});

test("TC10.2 member cannot read another mailbox's message", async () => {
  const db = new MemoryD1();
  const user = await seedMember(db);
  const env = testEnv(db);
  const token = await signUserSession(SECRET, {
    mailboxId: EMPTY.id,
    address: EMPTY.address,
    userId: user.id,
    role: "mailbox",
  });
  const response = await handleApi(
    new Request("http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222221", {
      headers: { cookie: cookieHeader(OWNER_SESSION_COOKIE, token) },
    }),
    env,
    new URL("http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222221"),
  );
  assert.equal(response.status, 403);
});

test("TC10.3 admin cannot write the mail audit list", async () => {
  const env = testEnv();
  const headers = {
    authorization: `Bearer ${ADMIN}`,
    "content-type": "application/json",
  };
  for (const method of ["POST", "DELETE", "PUT", "PATCH"]) {
    const response = await handleAdmin(
      new Request("http://127.0.0.1:8787/admin/messages", {
        method,
        headers,
        body: method === "GET" ? undefined : "{}",
      }),
      env,
      new URL("http://127.0.0.1:8787/admin/messages"),
    );
    assert.equal(response.status, 405, method);
  }

  const boxes = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/mailboxes", {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/mailboxes"),
  );
  assert.equal(boxes.status, 200);
});

test("TC10.4 under-quota storage is allowed", async () => {
  const db = new MemoryD1();
  await seedMember(db, { quotaStorage: 500 });
  db.messages.push({
    id: "m-small",
    mailbox_id: EMPTY.id,
    size_bytes: 80,
    envelope_from: "a@b.test",
    envelope_to: EMPTY.address,
    folder: "inbox",
    received_at: 1,
    created_at: 1,
  });
  const allowed = await inboundStorageRejection(testEnv(db), EMPTY.id, 50);
  assert.equal(allowed, null);
});

test("TC10.1 invalid mailbox does not leave a half-created member", async () => {
  const db = new MemoryD1();
  const env = testEnv(db);
  const created = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/users", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ login: "ghost", role: "mailbox", mailbox: "not-an-email" }),
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/users"),
  );
  assert.equal(created.status, 400);
  const listed = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/users", {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/users"),
  );
  const body = (await listed.json()) as { users: { login: string }[] };
  assert.equal(body.users.some((row) => row.login === "ghost"), false);
});

test("TC10.5 admin HTML and quota JSON without a session are 401", async () => {
  const env = testEnv();
  const page = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin"),
    env,
    new URL("http://127.0.0.1:8787/admin"),
  );
  assert.equal(page.status, 401);

  const mailboxes = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/mailboxes"),
    env,
    new URL("http://127.0.0.1:8787/admin/mailboxes"),
  );
  assert.equal(mailboxes.status, 401);

  const messages = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/messages"),
    env,
    new URL("http://127.0.0.1:8787/admin/messages"),
  );
  assert.equal(messages.status, 401);
});
