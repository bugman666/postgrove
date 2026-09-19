import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../src/env.ts";
import { handleHealth } from "../src/health.ts";
import { describeAuthMode } from "../src/users.ts";

const REQUIRED_TABLES = [
  "mailboxes",
  "messages",
  "outbound_attempts",
  "api_tokens",
  "users",
  "inbound_hooks",
  "inbound_deliveries",
  "dev_inboxes",
  "mailbox_aliases",
];

function env(opts: {
  tables?: string[];
  users?: number;
  throwUsers?: boolean;
  throwTables?: boolean;
} = {}): Env {
  const tables = opts.tables ?? REQUIRED_TABLES;
  return {
    DB: {
      prepare(sql: string) {
        if (sql.includes("sqlite_master")) {
          return {
            async all() {
              if (opts.throwTables) {
                throw new Error("d1 unreachable");
              }
              return { results: tables.map((name) => ({ name })) };
            },
          };
        }
        if (sql.includes("FROM users") && sql.includes("COUNT")) {
          return {
            async first() {
              if (opts.throwUsers) {
                throw new Error("users count failed");
              }
              return { n: opts.users ?? 0 };
            },
          };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    } as unknown as D1Database,
  } as Env;
}

test("GET /healthz ready with no members hints owner_break_glass", async () => {
  const response = await handleHealth(env({ users: 0 }));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ok: boolean;
    db: string;
    auth_mode?: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.db, "ready");
  assert.equal(body.auth_mode, "owner_break_glass");
});

test("GET /healthz ready with members reports auth_mode members", async () => {
  const response = await handleHealth(env({ users: 2 }));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { auth_mode?: string };
  assert.equal(body.auth_mode, "members");
});

test("GET /healthz omits auth_mode when the users count cannot run", async () => {
  const response = await handleHealth(env({ users: 0, throwUsers: true }));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; auth_mode?: string };
  assert.equal(body.ok, true);
  assert.equal(body.auth_mode, undefined);
});

test("GET /healthz migrations_pending stays 503 without auth_mode", async () => {
  const response = await handleHealth(env({ tables: ["mailboxes", "messages"] }));
  assert.equal(response.status, 503);
  const body = (await response.json()) as {
    ok: boolean;
    db: string;
    auth_mode?: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.db, "migrations_pending");
  assert.equal(body.auth_mode, undefined);
});

test("describeAuthMode is null when COUNT throws", async () => {
  assert.equal(await describeAuthMode(env({ throwUsers: true })), null);
  assert.equal(await describeAuthMode(env({ users: 0 })), "owner_break_glass");
  assert.equal(await describeAuthMode(env({ users: 1 })), "members");
});
