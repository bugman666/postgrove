import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleAuthRoutes,
  OWNER_SESSION_COOKIE,
  resetLoginRateLimitForTests,
  signUserSession,
  verifyOwnerSession,
} from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import {
  loginRedirectPath,
  pickLoginMailbox,
} from "../src/login-redirect.ts";
import { renderLoginPage } from "../src/pages/account.ts";
import { handleUi } from "../src/ui.ts";
import { bindUserMailbox, createUser } from "../src/users.ts";
import { emptyNav, type Shell } from "../src/view.ts";
import { MemoryD1 } from "./helpers/memory-d1.ts";

const SECRET = "change-me-local-session-secret";
const OWNER = "change-me-local-owner-token";
const ADMIN = "change-me-local-admin-token";
const USER_TOKEN = "change-me-local-user-token";

const EMPTY = {
  id: "11111111-1111-4111-8111-111111111112",
  address: "empty@example.test",
  local_part: "empty",
  domain: "example.test",
  display_name: "Empty box",
  status: "active",
  created_at: 1,
  updated_at: 1,
};

const INBOX = {
  id: "11111111-1111-4111-8111-111111111111",
  address: "inbox@example.test",
  local_part: "inbox",
  domain: "example.test",
  display_name: "Local inbox",
  status: "active",
  created_at: 2,
  updated_at: 2,
};

function seededDb(): MemoryD1 {
  return new MemoryD1({
    mailboxes: [{ ...EMPTY }, { ...INBOX }],
    messages: [
      {
        id: "22222222-2222-4222-8222-222222222221",
        mailbox_id: INBOX.id,
        envelope_from: "neighbor@example.test",
        envelope_to: INBOX.address,
        subject: "欢迎",
        snippet: "种子",
        folder: "inbox",
        is_read: 0,
        received_at: 10,
        created_at: 10,
      },
    ],
  });
}

function testEnv(db = seededDb(), overrides: Partial<Env> = {}): Env {
  return {
    DB: db.asDatabase(),
    SESSION_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
    ADMIN_TOKEN: ADMIN,
    ...overrides,
  };
}

function shell(): Shell {
  return {
    locale: "zh",
    preference: "zh",
    brand: { site_title: "Postgrove", logo_url: null, accent: "#1B4332" },
    nav: emptyNav(),
  };
}

test("pickLoginMailbox prefers a box with mail over an earlier empty box", () => {
  const empty = { id: EMPTY.id, address: EMPTY.address, message_count: 0 };
  const withMail = { id: INBOX.id, address: INBOX.address, message_count: 3 };

  assert.deepEqual(pickLoginMailbox([empty, withMail]), withMail);
  assert.deepEqual(pickLoginMailbox([empty, withMail], EMPTY.id), withMail);
  assert.deepEqual(pickLoginMailbox([empty, withMail], INBOX.id), withMail);
  assert.deepEqual(pickLoginMailbox([empty, { ...withMail, message_count: 0 }], EMPTY.id), empty);
  assert.equal(pickLoginMailbox([]), null);
  assert.equal(loginRedirectPath(withMail), `/box/${INBOX.id}`);
  assert.equal(loginRedirectPath(null), "/");
});

test("owner login lands on the seeded mailbox that has mail, not mailboxes[0]", async () => {
  resetLoginRateLimitForTests();
  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.70",
      },
      body: JSON.stringify({ address: EMPTY.address, token: OWNER }),
    }),
    testEnv(),
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ok: boolean;
    role: string;
    mailbox: { id: string; address: string };
    redirect: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.role, "owner");
  assert.equal(body.mailbox.id, INBOX.id);
  assert.equal(body.mailbox.address, INBOX.address);
  assert.equal(body.redirect, `/box/${INBOX.id}`);
  assert.equal(response.headers.get("location"), `/box/${INBOX.id}`);

  const cookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${OWNER_SESSION_COOKIE}=([^;]+)`).exec(cookie);
  assert.ok(match);
  const principal = await verifyOwnerSession(SECRET, decodeURIComponent(match[1]));
  assert.equal(principal?.mailboxId, INBOX.id);
  assert.equal(principal?.address, INBOX.address);
});

test("member login bound to an empty box still redirects to a box with mail", async () => {
  resetLoginRateLimitForTests();
  const db = seededDb();
  const env = testEnv(db);
  const created = await createUser(env, {
    login: "grove",
    role: "mailbox",
    token: USER_TOKEN,
  });
  await bindUserMailbox(env, created.user.id, EMPTY.id);
  await bindUserMailbox(env, created.user.id, INBOX.id);

  const response = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.71",
      },
      body: JSON.stringify({ address: EMPTY.address, token: USER_TOKEN }),
    }),
    env,
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    role: string;
    mailbox: { id: string };
    redirect: string;
  };
  assert.equal(body.role, "mailbox");
  assert.equal(body.mailbox.id, EMPTY.id);
  assert.equal(body.redirect, `/box/${INBOX.id}`);
  assert.equal(response.headers.get("location"), `/box/${INBOX.id}`);
});

test("GET / with a member session bound to an empty box redirects to mail", async () => {
  const db = seededDb();
  const env = testEnv(db);
  const created = await createUser(env, {
    login: "grove",
    role: "mailbox",
    token: USER_TOKEN,
  });
  await bindUserMailbox(env, created.user.id, EMPTY.id);
  await bindUserMailbox(env, created.user.id, INBOX.id);
  const token = await signUserSession(SECRET, {
    mailboxId: EMPTY.id,
    address: EMPTY.address,
    userId: created.user.id,
    role: "mailbox",
  });
  const response = await handleUi(
    new Request("http://127.0.0.1:8787/", {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    }),
    env,
    new URL("http://127.0.0.1:8787/"),
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `/box/${INBOX.id}`);
});

test("login page follows the server redirect field instead of a hardcoded home", () => {
  const html = renderLoginPage(shell(), "unauthorized", "POST /auth/login with address and token.");
  assert.match(html, /loginRedirectTarget/);
  assert.match(html, /body\.redirect/);
  assert.match(html, /headers\.get\("Location"\)/);
  assert.doesNotMatch(html, /location\.href = "\/"/);
});
