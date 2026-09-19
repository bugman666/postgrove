import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { handleAdmin } from "../src/admin.ts";
import { handleApi } from "../src/api.ts";
import {
  OWNER_SESSION_COOKIE,
  requireAdmin,
  requireOwner,
  signOwnerSession,
} from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import {
  WEBHOOK_SECRET_ENVELOPE_PREFIX,
  envelopeWebhookSecret,
  gateHookUrl,
  getHookConfig,
  isEnvelopedWebhookSecret,
  notifyInbound,
  openWebhookSecret,
  parseHookConfigBody,
  publicHookConfig,
  saveHookConfig,
  setWebhookFetchForTests,
  setWebhookResolveForTests,
  signWebhookBody,
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
    if (sql.includes("from inbound_hooks")) {
      return this.db.inbound_hooks.filter((row) => row.mailbox_id === a);
    }
    if (sql.includes("from inbound_deliveries")) {
      let rows = this.db.inbound_deliveries.slice();
      if (sql.includes("where mailbox_id")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }
    if (sql.includes("from mailboxes")) {
      let rows = this.db.mailboxes.slice();
      if (sql.includes("where address =")) {
        rows = rows.filter((row) => row.address === String(a).toLowerCase());
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      }
      return rows;
    }
    if (sql.includes("from users")) {
      return [];
    }
    if (sql.includes("from messages")) {
      return this.db.messages.slice();
    }
    if (sql.includes("from outbound_attempts")) {
      let rows = this.db.outbound_attempts.slice();
      if (sql.includes("idempotency_key =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.idempotency_key === b);
      } else if (sql.includes("where id =") && sql.includes("mailbox_id")) {
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
      this.db.inbound_deliveries.unshift({
        id: b[0],
        mailbox_id: b[1],
        message_id: b[2],
        kind: b[3],
        target: b[4],
        status: b[5],
        http_status: b[6],
        error: b[7],
        hint: b[8],
        created_at: b[9],
      });
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
        size_bytes: b[13],
        folder: "inbox",
        received_at: b[14],
        created_at: b[14],
      });
      return 1;
    }
    if (sql.startsWith("insert into outbound_attempts")) {
      this.db.outbound_attempts.push({
        id: b[0],
        mailbox_id: b[1],
        status: b[10],
        idempotency_key: b[15],
      });
      return 1;
    }
    if (sql.startsWith("insert into sent") || sql.includes("insert into messages")) {
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

afterEach(() => {
  setWebhookFetchForTests(null);
  setWebhookResolveForTests(null);
});

test("TC11.5 gateHookUrl rejects localhost / metadata / RFC1918 via validateSafeUrl", () => {
  for (const raw of [
    "http://127.0.0.1/hook",
    "http://localhost/hook",
    "https://foo.localhost/hook",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.8/hook",
    "http://192.168.1.9/hook",
    "http://metadata.google.internal/",
  ]) {
    const result = gateHookUrl(raw, false, "webhook_url");
    assert.equal(result.ok, false, raw);
    if (!result.ok) {
      assert.equal(result.error, "blocked_destination");
      assert.match(result.hint, /rejected|https|not allowed|Internal/i);
    }
  }
  const publicHttp = gateHookUrl("http://hooks.example.test/in", false, "webhook_url");
  assert.equal(publicHttp.ok, false);
  if (!publicHttp.ok) {
    assert.match(publicHttp.hint, /https/i);
  }
  const httpsOk = gateHookUrl("https://hooks.example.test/in", false, "webhook_url");
  assert.equal(httpsOk.ok, true);
  const localOk = gateHookUrl("http://127.0.0.1:8788/hook", true, "webhook_url");
  assert.equal(localOk.ok, true);
});

test("TC11.5 save config with internal URL is 400 + hint", async () => {
  const db = new MemoryD1();
  const request = new Request("http://127.0.0.1:8787/api/hooks", {
    method: "POST",
    headers: {
      cookie: await ownerCookie(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      webhook_enabled: true,
      webhook_url: "http://169.254.169.254/latest/meta-data/",
      webhook_secret: HOOK_SECRET,
    }),
  });
  const response = await handleApi(request, env(db), new URL(request.url));
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string; hint: string };
  assert.equal(body.error, "blocked_destination");
  assert.match(body.hint, /169\.254|not allowed|Internal|metadata/i);
});

test("TC11.1 inbound POSTs signed payload to configured webhook", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/inbound",
    webhook_secret: HOOK_SECRET,
  });

  let posted: { url: string; headers: Headers; body: string } | null = null;
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  setWebhookFetchForTests(async (input, init) => {
    const url = String(input);
    if (url.includes("hooks.example.test")) {
      posted = {
        url,
        headers: new Headers(init?.headers),
        body: String(init?.body),
      };
      return new Response("ok", { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  });

  await notifyInbound(e, {
    mailboxId: INBOX.id,
    mailboxAddress: INBOX.address,
    messageId: "msg-signed",
    from: "neighbor@example.test",
    to: INBOX.address,
    subject: "webhook ping",
    snippet: "Hello from inbound.",
    text: "Hello from inbound.",
    receivedAt: Date.now(),
  });
  assert.ok(posted);
  const payload = JSON.parse(posted.body) as {
    event: string;
    from: string;
    to: string;
    subject: string;
  };
  assert.equal(payload.event, "inbound");
  assert.equal(payload.to, INBOX.address);
  assert.equal(payload.from, "neighbor@example.test");
  assert.equal(payload.subject, "webhook ping");
  const verified = await verifyWebhookSignature({
    secret: HOOK_SECRET,
    timestamp: posted.headers.get("x-postgrove-timestamp") ?? "",
    rawBody: posted.body,
    signatureHeader: posted.headers.get("x-postgrove-signature"),
  });
  assert.equal(verified.ok, true);
  assert.equal(db.inbound_deliveries[0]?.status, "sent");
  assert.equal(db.inbound_deliveries[0]?.kind, "webhook");
});

test("TC11.2 wrong or missing secret fails verification", async () => {
  const rawBody = JSON.stringify({ event: "inbound", message_id: "m1" });
  const signed = await signWebhookBody(HOOK_SECRET, rawBody, 1_700_000_000);
  const ok = await verifyWebhookSignature({
    secret: HOOK_SECRET,
    timestamp: signed.timestamp,
    rawBody,
    signatureHeader: signed.signature,
    nowSeconds: 1_700_000_000,
  });
  assert.equal(ok.ok, true);

  const wrong = await verifyWebhookSignature({
    secret: "other-secret-value",
    timestamp: signed.timestamp,
    rawBody,
    signatureHeader: signed.signature,
    nowSeconds: 1_700_000_000,
  });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) {
    assert.equal(wrong.error, "bad_signature");
  }

  const missing = await verifyWebhookSignature({
    secret: HOOK_SECRET,
    timestamp: signed.timestamp,
    rawBody,
    signatureHeader: null,
    nowSeconds: 1_700_000_000,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error, "missing_signature");
  }
});

test("TC11.3 optional forward URL receives a chat payload", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    forward_enabled: true,
    forward_url: "https://chat.example.test/hook",
  });
  let posted: unknown;
  setWebhookResolveForTests(async () => ["203.0.113.20"]);
  setWebhookFetchForTests(async (input, init) => {
    if (String(input).includes("chat.example.test")) {
      posted = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    }
    return new Response("no", { status: 500 });
  });
  const deliveries = await notifyInbound(e, {
    mailboxId: INBOX.id,
    mailboxAddress: INBOX.address,
    messageId: "msg-forward",
    from: "neighbor@example.test",
    to: INBOX.address,
    subject: "hello bot",
    snippet: "ping",
    text: "ping body",
    receivedAt: Date.now(),
  });
  assert.equal(deliveries.length, 1, JSON.stringify(deliveries));
  assert.equal(
    deliveries[0].status,
    "sent",
    `${deliveries[0].error}: ${deliveries[0].hint}`,
  );
  assert.equal(deliveries[0].kind, "forward");
  const body = posted as { text: string; content: string; event: string };
  assert.equal(body.event, "inbound.forward");
  assert.match(body.text, /hello bot/);
  assert.equal(body.content, body.text);
});

test("TC11.4 downstream failure is stored and visible to admin", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/down",
    webhook_secret: HOOK_SECRET,
  });
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  setWebhookFetchForTests(async () => new Response("nope", { status: 502 }));
  await notifyInbound(e, {
    mailboxId: INBOX.id,
    mailboxAddress: INBOX.address,
    messageId: "msg-fail",
    from: "neighbor@example.test",
    to: INBOX.address,
    subject: "fail",
    snippet: "x",
    text: "x",
    receivedAt: Date.now(),
  });
  assert.equal(db.inbound_deliveries[0]?.status, "failed");
  assert.equal(db.inbound_deliveries[0]?.error, "downstream_failed");
  assert.match(String(db.inbound_deliveries[0]?.hint), /502|not swallowed|Check/i);

  const response = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/deliveries", {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    e,
    new URL("http://127.0.0.1:8787/admin/deliveries"),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    deliveries: Array<{ status: string; error: string }>;
  };
  assert.equal(body.deliveries[0].status, "failed");
  assert.equal(body.deliveries[0].error, "downstream_failed");
});

test("redirect Location is re-checked with validateSafeUrl", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/start",
    webhook_secret: HOOK_SECRET,
  });
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  setWebhookFetchForTests(async (input) => {
    if (String(input).includes("/start")) {
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    }
    return new Response("should-not-follow", { status: 200 });
  });
  const deliveries = await notifyInbound(e, {
    mailboxId: INBOX.id,
    mailboxAddress: INBOX.address,
    messageId: "msg-redir",
    from: "neighbor@example.test",
    to: INBOX.address,
    subject: "redir",
    snippet: null,
    text: null,
    receivedAt: Date.now(),
  });
  assert.equal(deliveries[0].status, "failed");
  assert.equal(deliveries[0].error, "blocked_destination");
});

test("DNS re-check blocks a hostname that resolves to RFC1918", async () => {
  const db = new MemoryD1();
  const e = env(db);
  await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/private",
    webhook_secret: HOOK_SECRET,
  });
  setWebhookResolveForTests(async () => ["10.1.2.3"]);
  let fetched = false;
  setWebhookFetchForTests(async () => {
    fetched = true;
    return new Response("ok", { status: 200 });
  });
  const deliveries = await notifyInbound(e, {
    mailboxId: INBOX.id,
    mailboxAddress: INBOX.address,
    messageId: "msg-dns",
    from: "neighbor@example.test",
    to: INBOX.address,
    subject: "dns",
    snippet: null,
    text: null,
    receivedAt: Date.now(),
  });
  assert.equal(fetched, false);
  assert.equal(deliveries[0].status, "failed");
  assert.equal(deliveries[0].error, "blocked_destination");
  assert.match(String(deliveries[0].hint), /10\.1\.2\.3|DNS|resolved/i);
});

test("TC11.6 unauthorized config/log is 401; mailbox session on admin is 403", async () => {
  const db = new MemoryD1();
  const e = env(db);

  const noAuth = await handleApi(
    new Request("http://127.0.0.1:8787/api/hooks"),
    e,
    new URL("http://127.0.0.1:8787/api/hooks"),
  );
  assert.equal(noAuth.status, 401);

  const noAuthLog = await handleApi(
    new Request("http://127.0.0.1:8787/api/hooks/attempts"),
    e,
    new URL("http://127.0.0.1:8787/api/hooks/attempts"),
  );
  assert.equal(noAuthLog.status, 401);

  const adminNoAuth = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/hooks?mailbox_id=" + INBOX.id),
    e,
    new URL("http://127.0.0.1:8787/admin/hooks?mailbox_id=" + INBOX.id),
  );
  assert.equal(adminNoAuth.status, 401);

  const ownerOnAdmin = await requireAdmin(
    new Request("http://127.0.0.1:8787/admin/deliveries", {
      headers: { cookie: await ownerCookie() },
    }),
    e,
  );
  assert.equal(ownerOnAdmin.ok, false);
  if (!ownerOnAdmin.ok) {
    assert.equal(ownerOnAdmin.response.status, 403);
  }

  const ownerOk = await requireOwner(
    new Request("http://127.0.0.1:8787/api/hooks", {
      headers: { cookie: await ownerCookie() },
    }),
    e,
  );
  assert.equal(ownerOk.ok, true);
});

test("owner can save a public https webhook", async () => {
  const db = new MemoryD1();
  const request = new Request("http://127.0.0.1:8787/api/hooks", {
    method: "POST",
    headers: {
      cookie: await ownerCookie(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      webhook_enabled: true,
      webhook_url: "https://hooks.example.test/ok",
      webhook_secret: HOOK_SECRET,
    }),
  });
  const response = await handleApi(request, env(db), new URL(request.url));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    hook: { webhook_url: string; signing: { alg: string } };
  };
  assert.equal(body.hook.webhook_url, "https://hooks.example.test/ok");
  assert.equal(body.hook.signing.alg, "hmac-sha256");
});

test("parseHookConfigBody rejects a non-object", () => {
  assert.throws(() => parseHookConfigBody(null));
});

test("webhook_secret is stored enveloped; verify still works; rotate shows once", async () => {
  const db = new MemoryD1();
  const e = env(db);
  const saved = await saveHookConfig(e, INBOX.id, {
    webhook_enabled: true,
    webhook_url: "https://hooks.example.test/inbound",
    webhook_secret: HOOK_SECRET,
  });
  const stored = String(db.inbound_hooks[0]?.webhook_secret ?? "");
  assert.ok(isEnvelopedWebhookSecret(stored));
  assert.ok(stored.startsWith(WEBHOOK_SECRET_ENVELOPE_PREFIX));
  assert.notEqual(stored, HOOK_SECRET);
  assert.equal(stored.includes(HOOK_SECRET), false);
  assert.equal(saved.secretOnce, HOOK_SECRET);
  assert.equal(saved.row.webhook_secret, stored);
  assert.equal(await openWebhookSecret(e, stored), HOOK_SECRET);

  const listed = publicHookConfig(saved.row);
  assert.equal(listed.webhook_secret_set, true);
  assert.equal("webhook_secret" in listed, false);

  const get = await handleApi(
    new Request("http://127.0.0.1:8787/api/hooks", {
      headers: { cookie: await ownerCookie() },
    }),
    e,
    new URL("http://127.0.0.1:8787/api/hooks"),
  );
  assert.equal(get.status, 200);
  const getBody = (await get.json()) as { hook: { webhook_secret?: string; webhook_secret_set: boolean } };
  assert.equal(getBody.hook.webhook_secret_set, true);
  assert.equal(getBody.hook.webhook_secret, undefined);

  let posted: { headers: Headers; body: string } | null = null;
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  setWebhookFetchForTests(async (input, init) => {
    if (String(input).includes("hooks.example.test")) {
      posted = { headers: new Headers(init?.headers), body: String(init?.body) };
      return new Response("ok", { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  });
  await notifyInbound(e, {
    mailboxId: INBOX.id,
    mailboxAddress: INBOX.address,
    messageId: "msg-enveloped",
    from: "neighbor@example.test",
    to: INBOX.address,
    subject: "secret",
    snippet: null,
    text: null,
    receivedAt: Date.now(),
  });
  assert.ok(posted);
  const verified = await verifyWebhookSignature({
    secret: HOOK_SECRET,
    timestamp: posted.headers.get("x-postgrove-timestamp") ?? "",
    rawBody: posted.body,
    signatureHeader: posted.headers.get("x-postgrove-signature"),
  });
  assert.equal(verified.ok, true);

  const rotated = await saveHookConfig(e, INBOX.id, { rotate_secret: true });
  assert.ok(rotated.secretOnce);
  assert.notEqual(rotated.secretOnce, HOOK_SECRET);
  const rotatedStored = String(db.inbound_hooks[0]?.webhook_secret ?? "");
  assert.ok(isEnvelopedWebhookSecret(rotatedStored));
  assert.notEqual(rotatedStored, rotated.secretOnce);
  assert.equal(rotatedStored.includes(rotated.secretOnce ?? ""), false);
  assert.equal(await openWebhookSecret(e, rotatedStored), rotated.secretOnce);
  const rotatePublic = publicHookConfig(rotated.row, rotated.secretOnce ?? undefined);
  assert.equal(rotatePublic.webhook_secret, rotated.secretOnce);

  const afterRotate = await handleApi(
    new Request("http://127.0.0.1:8787/api/hooks", {
      headers: { cookie: await ownerCookie() },
    }),
    e,
    new URL("http://127.0.0.1:8787/api/hooks"),
  );
  const afterBody = (await afterRotate.json()) as { hook: { webhook_secret?: string } };
  assert.equal(afterBody.hook.webhook_secret, undefined);
});

test("legacy plaintext webhook_secret is wrapped on read and still signs", async () => {
  const db = new MemoryD1();
  const e = env(db);
  db.inbound_hooks.push({
    mailbox_id: INBOX.id,
    webhook_enabled: 1,
    webhook_url: "https://hooks.example.test/legacy",
    webhook_secret: HOOK_SECRET,
    forward_enabled: 0,
    forward_url: null,
    forward_email: null,
    updated_at: 1,
  });
  const row = await getHookConfig(e, INBOX.id);
  assert.ok(row);
  assert.ok(isEnvelopedWebhookSecret(row.webhook_secret ?? ""));
  assert.notEqual(row.webhook_secret, HOOK_SECRET);
  assert.equal(db.inbound_hooks[0]?.webhook_secret, row.webhook_secret);
  assert.equal(await openWebhookSecret(e, row.webhook_secret ?? ""), HOOK_SECRET);

  let posted: { headers: Headers; body: string } | null = null;
  setWebhookResolveForTests(async () => ["203.0.113.10"]);
  setWebhookFetchForTests(async (_input, init) => {
    posted = { headers: new Headers(init?.headers), body: String(init?.body) };
    return new Response("ok", { status: 200 });
  });
  await notifyInbound(e, {
    mailboxId: INBOX.id,
    mailboxAddress: INBOX.address,
    messageId: "msg-legacy",
    from: "neighbor@example.test",
    to: INBOX.address,
    subject: "legacy",
    snippet: null,
    text: null,
    receivedAt: Date.now(),
  });
  assert.ok(posted);
  const verified = await verifyWebhookSignature({
    secret: HOOK_SECRET,
    timestamp: posted.headers.get("x-postgrove-timestamp") ?? "",
    rawBody: posted.body,
    signatureHeader: posted.headers.get("x-postgrove-signature"),
  });
  assert.equal(verified.ok, true);
});

test("envelopeWebhookSecret round-trips and rejects a different SESSION_SECRET", async () => {
  const e = env(new MemoryD1());
  const wrapped = await envelopeWebhookSecret(e, HOOK_SECRET);
  assert.ok(isEnvelopedWebhookSecret(wrapped));
  assert.equal(await openWebhookSecret(e, wrapped), HOOK_SECRET);
  await assert.rejects(
    () => openWebhookSecret({ ...e, SESSION_SECRET: "other-session-secret-1" }, wrapped),
    /unreadable_webhook_secret/,
  );
});
