import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { handleAdmin } from "../src/admin.ts";
import { handleApi } from "../src/api.ts";
import { insertApiToken } from "../src/api-tokens.ts";
import { handleAuthRoutes, OWNER_SESSION_COOKIE, signOwnerSession } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import { resetRateLimitForTests } from "../src/rate-limit.ts";
import { handleRestRoutes } from "../src/rest.ts";

const SECRET = "change-me-local-session-secret";
const OWNER = "change-me-local-owner-token";
const ADMIN = "change-me-local-admin-token";
const MAILBOX_A = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "inbox@example.test",
  local_part: "inbox",
  domain: "example.test",
  display_name: "Local inbox",
  status: "active",
  created_at: 1,
  updated_at: 1,
};
const MAILBOX_B = {
  id: "11111111-1111-4111-8111-111111111112",
  address: "empty@example.test",
  local_part: "empty",
  domain: "example.test",
  display_name: "Empty",
  status: "active",
  created_at: 2,
  updated_at: 2,
};

type Row = Record<string, unknown>;

class MemoryD1 {
  mailboxes: Row[] = [{ ...MAILBOX_A }, { ...MAILBOX_B }];
  messages: Row[] = [];
  tokens: Row[] = [];
  attempts: Row[] = [];
  users: Row[] = [];

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
      return rows;
    }
    if (sql.includes("from users")) {
      return this.db.users.slice();
    }
    if (sql.includes("from messages") && sql.includes("count(*)")) {
      return [{ unread_count: 0 }];
    }
    return [];
  }

  mutate() {
    const sql = collapse(this.sql);
    const binds = this.binds;
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
    if (sql.startsWith("insert into messages")) {
      this.db.messages.push({
        id: binds[0],
        mailbox_id: binds[1],
        folder: binds[16],
      });
      return 1;
    }
    if (sql.startsWith("insert into outbound_attempts")) {
      this.db.attempts.push({
        id: binds[0],
        mailbox_id: binds[1],
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

/** Same order as `src/index.ts` fetch (auth → REST → /api → /admin). */
async function fetchWorker(request: Request, testEnv: Env): Promise<Response> {
  const url = new URL(request.url);
  const auth = await handleAuthRoutes(request, testEnv);
  if (auth) {
    return auth;
  }
  const rest = await handleRestRoutes(request, testEnv);
  if (rest) {
    return rest;
  }
  if (url.pathname.startsWith("/api/")) {
    return handleApi(request, testEnv, url);
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return handleAdmin(request, testEnv, url);
  }
  throw new Error(`auth matrix does not cover ${url.pathname}`);
}

function bearer(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, { ...init, headers });
}

const SEND_A = {
  method: "POST",
  body: JSON.stringify({
    mailbox_id: MAILBOX_A.id,
    to: "neighbor@example.test",
    subject: "matrix",
    text: "hello",
  }),
} satisfies RequestInit;

type ActorName = "anon" | "mailbox" | "other" | "adminBearer" | "adminPg" | "ownerCookie";

type Fixture = {
  env: Env;
  request: (actor: ActorName, url: string, init?: RequestInit) => Request;
};

async function fixture(): Promise<Fixture> {
  const db = new MemoryD1();
  const testEnv = env(db);
  const mailboxToken = (await insertApiToken(testEnv, MAILBOX_A.id, "mailbox")).token;
  const otherToken = (await insertApiToken(testEnv, MAILBOX_B.id, "other")).token;
  const adminPg = (await insertApiToken(testEnv, MAILBOX_A.id, "ops", { kind: "admin" })).token;
  const ownerCookie = `${OWNER_SESSION_COOKIE}=${await signOwnerSession(SECRET, {
    mailboxId: MAILBOX_A.id,
    address: MAILBOX_A.address,
  })}`;

  const tokens: Record<Exclude<ActorName, "anon" | "ownerCookie">, string> = {
    mailbox: mailboxToken,
    other: otherToken,
    adminBearer: ADMIN,
    adminPg,
  };

  return {
    env: testEnv,
    request(actor, url, init = {}) {
      if (actor === "anon") {
        return new Request(url, init);
      }
      if (actor === "ownerCookie") {
        const headers = new Headers(init.headers);
        headers.set("cookie", ownerCookie);
        return new Request(url, { ...init, headers });
      }
      return bearer(tokens[actor], url, init);
    },
  };
}

beforeEach(() => {
  resetRateLimitForTests();
});

const CASES: Array<{
  actor: ActorName;
  path: string;
  init?: RequestInit;
  status: number;
}> = [
  { actor: "anon", path: "/api/mailboxes", status: 401 },
  { actor: "mailbox", path: "/api/mailboxes", status: 401 },
  { actor: "other", path: "/api/mailboxes", status: 401 },
  { actor: "adminBearer", path: "/api/mailboxes", status: 401 },
  { actor: "adminPg", path: "/api/mailboxes", status: 401 },
  { actor: "ownerCookie", path: "/api/mailboxes", status: 200 },

  { actor: "anon", path: "/api/v1/mailboxes", status: 401 },
  { actor: "mailbox", path: "/api/v1/mailboxes", status: 200 },
  { actor: "other", path: "/api/v1/mailboxes", status: 200 },
  { actor: "adminBearer", path: "/api/v1/mailboxes", status: 200 },
  { actor: "adminPg", path: "/api/v1/mailboxes", status: 200 },
  { actor: "ownerCookie", path: "/api/v1/mailboxes", status: 401 },

  { actor: "mailbox", path: `/api/v1/mailboxes/${MAILBOX_A.id}`, status: 200 },
  { actor: "other", path: `/api/v1/mailboxes/${MAILBOX_A.id}`, status: 403 },
  { actor: "adminBearer", path: `/api/v1/mailboxes/${MAILBOX_A.id}`, status: 200 },
  { actor: "adminPg", path: `/api/v1/mailboxes/${MAILBOX_A.id}`, status: 200 },

  { actor: "anon", path: "/api/v1/send", init: SEND_A, status: 401 },
  { actor: "mailbox", path: "/api/v1/send", init: SEND_A, status: 200 },
  { actor: "other", path: "/api/v1/send", init: SEND_A, status: 403 },
  { actor: "adminBearer", path: "/api/v1/send", init: SEND_A, status: 200 },
  { actor: "adminPg", path: "/api/v1/send", init: SEND_A, status: 200 },
  { actor: "ownerCookie", path: "/api/v1/send", init: SEND_A, status: 401 },

  { actor: "anon", path: "/admin/ping", status: 401 },
  { actor: "mailbox", path: "/admin/ping", status: 401 },
  { actor: "other", path: "/admin/ping", status: 401 },
  { actor: "adminBearer", path: "/admin/ping", status: 200 },
  { actor: "adminPg", path: "/admin/ping", status: 200 },
  { actor: "ownerCookie", path: "/admin/ping", status: 403 },

  { actor: "anon", path: "/admin/users", status: 401 },
  { actor: "mailbox", path: "/admin/users", status: 401 },
  { actor: "adminBearer", path: "/admin/users", status: 200 },
  { actor: "adminPg", path: "/admin/users", status: 200 },
  { actor: "ownerCookie", path: "/admin/users", status: 403 },

  { actor: "anon", path: "/auth/session", status: 401 },
  { actor: "mailbox", path: "/auth/session", status: 401 },
  { actor: "adminBearer", path: "/auth/session", status: 401 },
  { actor: "ownerCookie", path: "/auth/session", status: 200 },
];

test("auth matrix: anon / mailbox pg_ / other-mailbox / admin / owner cookie", async () => {
  const setup = await fixture();
  for (const row of CASES) {
    const response = await fetchWorker(
      setup.request(row.actor, `http://127.0.0.1:8787${row.path}`, row.init),
      setup.env,
    );
    assert.equal(
      response.status,
      row.status,
      `${row.actor} ${row.init?.method ?? "GET"} ${row.path} expected ${row.status}, got ${response.status}`,
    );
  }
});
