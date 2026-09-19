import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../src/env.ts";
import {
  handleAuthRoutes,
  requireAdmin,
  requireAdminOrOwner,
  requireOwner,
  signOwnerSession,
  timingSafeEqualString,
  verifyOwnerSession,
  OWNER_SESSION_COOKIE,
} from "../src/auth.ts";

const SECRET = "change-me-local-session-secret";
const OWNER = "change-me-local-owner-token";
const ADMIN = "change-me-local-admin-token";
const MAILBOX = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "inbox@example.test",
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: fakeDb(MAILBOX),
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
    ADMIN_TOKEN: ADMIN,
    ...overrides,
  };
}

function fakeDb(row: { id: string; address: string; status?: string } | null): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              if (!row) {
                return null;
              }
              return { id: row.id, address: row.address, status: row.status ?? "active" };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

test("timingSafeEqualString matches equal strings", () => {
  assert.equal(timingSafeEqualString("abc", "abc"), true);
  assert.equal(timingSafeEqualString("abc", "abd"), false);
  assert.equal(timingSafeEqualString("abc", "ab"), false);
});

test("sign/verify owner session roundtrip", async () => {
  const token = await signOwnerSession(SECRET, {
    mailboxId: MAILBOX.id,
    address: MAILBOX.address,
  });
  const principal = await verifyOwnerSession(SECRET, token);
  assert.deepEqual(principal, {
    kind: "owner",
    mailboxId: MAILBOX.id,
    address: MAILBOX.address,
  });
});

test("tampered or expired session is rejected", async () => {
  const token = await signOwnerSession(SECRET, {
    mailboxId: MAILBOX.id,
    address: MAILBOX.address,
  });
  assert.equal(await verifyOwnerSession(SECRET, token + "x"), null);
  assert.equal(await verifyOwnerSession("wrong-secret-value!!", token), null);
  const expired = await signOwnerSession(
    SECRET,
    { mailboxId: MAILBOX.id, address: MAILBOX.address },
    Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60,
  );
  assert.equal(await verifyOwnerSession(SECRET, expired), null);
});

test("GET /auth/session without cookie is 401", async () => {
  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/auth/session"),
    env(),
  );
  assert.ok(response);
  assert.equal(response.status, 401);
  const body = (await response.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "unauthorized");
});

test("GET /admin/ping without bearer is 401", async () => {
  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/admin/ping"),
    env(),
  );
  assert.ok(response);
  assert.equal(response.status, 401);
});

test("GET /admin/ping with admin bearer succeeds", async () => {
  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/admin/ping", {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env(),
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; role: string };
  assert.equal(body.ok, true);
  assert.equal(body.role, "admin");
});

test("login issues a session cookie for an active mailbox", async () => {
  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: MAILBOX.address, token: OWNER }),
    }),
    env(),
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`${OWNER_SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/i);
  const body = (await response.json()) as { role: string; mailbox: { address: string } };
  assert.equal(body.role, "owner");
  assert.equal(body.mailbox.address, MAILBOX.address);

  const token = cookieValue(cookie);
  const session = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/auth/session", {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    env(),
  );
  assert.ok(session);
  assert.equal(session.status, 200);
});

test("login with a wrong token is 401", async () => {
  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: MAILBOX.address, token: "nope-nope" }),
    }),
    env(),
  );
  assert.ok(response);
  assert.equal(response.status, 401);
});

test("requireOwner / requireAdmin helpers match the HTTP surface", async () => {
  const missing = await requireOwner(new Request("http://127.0.0.1:8787/x"), env());
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.response.status, 401);
  }

  const token = await signOwnerSession(SECRET, {
    mailboxId: MAILBOX.id,
    address: MAILBOX.address,
  });
  const owner = await requireOwner(
    new Request("http://127.0.0.1:8787/x", {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    env(),
  );
  assert.equal(owner.ok, true);

  const admin = requireAdmin(
    new Request("http://127.0.0.1:8787/x", {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env(),
  );
  assert.equal(admin.ok, true);

  const either = await requireAdminOrOwner(
    new Request("http://127.0.0.1:8787/x", {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env(),
  );
  assert.equal(either.ok, true);
  if (either.ok) {
    assert.equal(either.principal.kind, "admin");
  }
});

test("auth routes do not claim /healthz", async () => {
  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/healthz"),
    env(),
  );
  assert.equal(response, null);
});

test("missing secrets fail closed with 503", async () => {
  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: MAILBOX.address, token: OWNER }),
    }),
    env({ SESSION_SECRET: "", OWNER_TOKEN: "", ADMIN_TOKEN: "" }),
  );
  assert.ok(response);
  assert.equal(response.status, 503);
});

function cookieValue(setCookie: string): string {
  const match = new RegExp(`${OWNER_SESSION_COOKIE}=([^;]+)`).exec(setCookie);
  assert.ok(match);
  return match[1];
}
