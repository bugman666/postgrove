import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { handleAdmin } from "../src/admin.ts";
import { loadGroveStats } from "../src/analytics.ts";
import {
  ADMIN_SESSION_COOKIE,
  OWNER_SESSION_COOKIE,
  handleAuthRoutes,
  requireAdmin,
  requireOwner,
  signOwnerSession,
  signUserSession,
} from "../src/auth.ts";
import {
  BAD_ACCENT_HINT,
  BRAND_SAVED_HINT,
  DEFAULT_ACCENT,
  LOGO_FAIL_HINT,
  brandOverrideCss,
  gateLogoUrl,
  saveBranding,
  setLogoFetchForTests,
  setLogoResolveForTests,
} from "../src/branding.ts";
import type { Env } from "../src/env.ts";
import { handleApi } from "../src/api.ts";
import { LOCALE_COOKIE, localeFromAcceptLanguage, t } from "../src/i18n.ts";
import { createUser } from "../src/users.ts";
import { validateSafeUrl } from "../src/safe-url.ts";
import { brandLink, resolveShell } from "../src/view.ts";

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
};

type Row = Record<string, unknown>;

class MemoryD1 {
  users: Row[] = [];
  user_mailboxes: Row[] = [];
  mailboxes: Row[] = [{ ...INBOX }];
  messages: Row[] = [];
  attachments: Row[] = [];
  site_settings: Row[] = [
    { id: 1, site_title: "Postgrove", logo_url: null, accent: DEFAULT_ACCENT, updated_at: 0 },
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
      return ["mailboxes", "messages", "users", "attachments", "site_settings"].map((name) => ({
        name,
      }));
    }
    if (sql.includes("from site_settings")) {
      return this.db.site_settings.slice();
    }
    if (sql.includes("from attachments")) {
      if (sql.includes("sum(size_bytes)")) {
        const n = this.db.attachments.reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0);
        return [{ n }];
      }
      return this.db.attachments.slice();
    }
    if (sql.includes("from users")) {
      if (sql.includes("select count(*)")) {
        return [{ n: this.db.users.length }];
      }
      let rows = this.db.users.slice();
      if (sql.includes("where login =")) {
        rows = rows.filter((row) => String(row.login).toLowerCase() === String(a).toLowerCase());
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      }
      return rows;
    }
    if (sql.includes("from user_mailboxes")) {
      return this.db.user_mailboxes.filter((row) => row.user_id === a);
    }
    if (sql.includes("from messages")) {
      let rows = this.db.messages.slice();
      if (sql.includes("select count(*)")) {
        rows = rows.filter((row) => {
          const at = Number(row.received_at);
          const folder = String(row.folder);
          if (sql.includes("folder in")) {
            if (folder !== "inbox" && folder !== "sent") {
              return false;
            }
          }
          if (typeof a === "number" && typeof b === "number") {
            return at >= a && at < b;
          }
          return true;
        });
        return [{ n: rows.length }];
      }
      return rows.sort((left, right) => Number(right.received_at) - Number(left.received_at));
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
    return [];
  }

  mutate(): number {
    const sql = collapse(this.sql);
    const b = this.binds;
    if (sql.startsWith("insert into users")) {
      this.db.users.push({
        id: b[0],
        login: b[1],
        display_name: b[2],
        role: b[3],
        status: b[4],
        token_salt: b[5],
        token_hash: b[6],
        quota_addresses: b[7],
        quota_storage_bytes: b[8],
        quota_send_daily: b[9],
        created_at: b[10],
        updated_at: b[11],
      });
      return 1;
    }
    if (sql.startsWith("insert or ignore into user_mailboxes") || sql.startsWith("insert into user_mailboxes")) {
      this.db.user_mailboxes.push({ user_id: b[0], mailbox_id: b[1], created_at: b[2] });
      return 1;
    }
    if (sql.startsWith("insert into site_settings")) {
      this.db.site_settings = [
        { id: 1, site_title: b[0], logo_url: b[1], accent: b[2], updated_at: b[3] },
      ];
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

function adminHeaders(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${ADMIN}`, ...extra };
}

afterEach(() => {
  setLogoFetchForTests(null);
  setLogoResolveForTests(null);
});

test("TC13.1 admin stats show user count, today's mail, and storage MB", async () => {
  const db = new MemoryD1();
  const env = testEnv(db);
  await createUser(env, { login: "ada", role: "mailbox", token: USER_TOKEN });
  await createUser(env, { login: "bea", role: "admin", token: "second-user-token-1" });
  const now = Date.now();
  db.messages.push(
    {
      id: "m-today-in",
      mailbox_id: INBOX.id,
      folder: "inbox",
      received_at: now,
      size_bytes: 10,
    },
    {
      id: "m-today-out",
      mailbox_id: INBOX.id,
      folder: "sent",
      received_at: now,
      size_bytes: 10,
    },
    {
      id: "m-draft",
      mailbox_id: INBOX.id,
      folder: "draft",
      received_at: now,
      size_bytes: 10,
    },
    {
      id: "m-old",
      mailbox_id: INBOX.id,
      folder: "inbox",
      received_at: now - 3 * 24 * 60 * 60 * 1000,
      size_bytes: 10,
    },
  );
  db.attachments.push({ id: "a1", size_bytes: 2 * 1024 * 1024 });

  const stats = await loadGroveStats(env, now);
  assert.equal(stats.users, 2);
  assert.equal(stats.messages_today, 2);
  assert.equal(stats.storage_mb, 2);
  assert.equal(stats.empty, false);

  const json = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/stats", { headers: adminHeaders() }),
    env,
    new URL("http://127.0.0.1:8787/admin/stats"),
  );
  assert.equal(json.status, 200);
  const body = (await json.json()) as {
    stats: { users: number; messages_today: number; storage_mb: number };
  };
  assert.equal(body.stats.users, 2);
  assert.equal(body.stats.messages_today, 2);
  assert.equal(body.stats.storage_mb, 2);

  const page = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/overview", { headers: adminHeaders() }),
    env,
    new URL("http://127.0.0.1:8787/admin/overview"),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, />2</);
  assert.match(html, /2 MB/);
  assert.match(html, /概览|Overview/);
  assert.doesNotMatch(html, /neon|皮肤包|theme-pack/i);
});

test("TC13.1 empty analytics copy when the grove is quiet", async () => {
  const env = testEnv();
  const page = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/overview", { headers: adminHeaders() }),
    env,
    new URL("http://127.0.0.1:8787/admin/overview"),
  );
  const html = await page.text();
  assert.match(html, /还没有数据。有流量后这里会更新。/);
});

test("TC13.2 en/zh switch works and missing keys do not crash", async () => {
  assert.equal(t("zh", "nav.inbox"), "收件箱");
  assert.equal(t("en", "nav.inbox"), "Inbox");
  assert.equal(t("en", "banner.lang-updated"), "Language updated.");
  assert.equal(t("zh", "banner.lang-updated"), "界面语言已更新。");
  assert.equal(t("en", "missing.no-such-key"), "missing.no-such-key");
  assert.equal(t("zh", "missing.no-such-key"), "missing.no-such-key");
  assert.equal(localeFromAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8"), "zh");
  assert.equal(localeFromAcceptLanguage("en-US,en;q=0.8"), "en");
  assert.equal(localeFromAcceptLanguage(null), "zh");

  const env = testEnv();
  const cookie = `${OWNER_SESSION_COOKIE}=${await signOwnerSession(SECRET, { mailboxId: INBOX.id, address: INBOX.address })}`;
  const english = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/overview", {
      headers: { ...adminHeaders(), "accept-language": "en" },
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/overview"),
  );
  assert.equal(english.status, 200);
  const enHtml = await english.text();
  assert.match(enHtml, />Inbox</);
  assert.match(enHtml, />Overview</);
  assert.doesNotMatch(enHtml, /收件箱/);

  const forced = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/overview", {
      headers: { ...adminHeaders(), cookie: `${LOCALE_COOKIE}=zh`, "accept-language": "en" },
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/overview"),
  );
  const zhHtml = await forced.text();
  assert.match(zhHtml, />收件箱</);
  assert.match(zhHtml, />概览</);

  const switched = await handleApi(
    new Request("http://127.0.0.1:8787/api/locale", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ locale: "en" }),
    }),
    env,
    new URL("http://127.0.0.1:8787/api/locale"),
  );
  assert.equal(switched.status, 200);
  const switchedBody = (await switched.json()) as { hint: string; locale: string };
  assert.equal(switchedBody.hint, "Language updated.");
  assert.equal(switchedBody.locale, "en");
  assert.match(switched.headers.get("set-cookie") ?? "", /postgrove_locale=en/);
});

test("TC13.3 site title, logo, and accent show on public login; not a neon pack", async () => {
  const db = new MemoryD1();
  const env = testEnv(db);
  setLogoFetchForTests(async () => new Response("ok", { status: 200 }));
  const saved = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/branding", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        site_title: "Grove Mail",
        logo_url: "https://cdn.example.test/mark.svg",
        accent: "#2d6a4f",
      }),
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/branding"),
  );
  assert.equal(saved.status, 200);
  const savedBody = (await saved.json()) as { hint: string; branding: { accent: string } };
  assert.equal(savedBody.hint, BRAND_SAVED_HINT);
  assert.equal(savedBody.branding.accent, "#2D6A4F");

  const login = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin", { headers: { "accept-language": "en" } }),
    env,
    new URL("http://127.0.0.1:8787/admin"),
  );
  assert.equal(login.status, 401);
  const html = await login.text();
  assert.match(html, /Grove Mail/);
  assert.match(html, /cdn\.example\.test\/mark\.svg/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /neon|皮肤市场|theme store/i);
  assert.doesNotMatch(html, /OWNER_TOKEN|ADMIN_TOKEN|SESSION_SECRET|RESEND_API_KEY/);
  const shell = await resolveShell(
    new Request("http://127.0.0.1:8787/", { headers: { "accept-language": "en" } }),
    env,
  );
  const mark = brandLink(shell, "/");
  assert.match(mark, /Grove Mail/);
  assert.match(mark, /brand-logo/);

  const css = brandOverrideCss("#2D6A4F");
  assert.equal(css.includes("--pg-color-brand: #2D6A4F"), true);
  assert.doesNotMatch(css, /--pg-color-brand-emphasis|--pg-color-accent|@import/);
});

test("TC13.3 XSS title is escaped and bad accent/logo are rejected via validateSafeUrl", async () => {
  const db = new MemoryD1();
  const env = testEnv(db);

  const xss = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/branding", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        site_title: `<img src=x onerror="alert(1)">`,
        accent: DEFAULT_ACCENT,
      }),
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/branding"),
  );
  assert.equal(xss.status, 200);
  const login = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin"),
    env,
    new URL("http://127.0.0.1:8787/admin"),
  );
  const html = await login.text();
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror="alert\(1\)">/);

  const badColor = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/branding", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ accent: "#1B4332;}body{color:red" }),
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/branding"),
  );
  assert.equal(badColor.status, 400);
  const colorBody = (await badColor.json()) as { hint: string };
  assert.equal(colorBody.hint, BAD_ACCENT_HINT);

  const blocked = validateSafeUrl("https://169.254.169.254/latest/meta-data");
  assert.equal(blocked.ok, false);

  const unsafeLogo = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/branding", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ logo_url: "https://169.254.169.254/latest/meta-data" }),
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/branding"),
  );
  assert.equal(unsafeLogo.status, 400);
  const logoBody = (await unsafeLogo.json()) as { hint: string };
  assert.equal(logoBody.hint, LOGO_FAIL_HINT);

  setLogoFetchForTests(async () => {
    throw new Error("offline");
  });
  const fetchFail = await saveBranding(env, { logo_url: "https://cdn.example.test/missing.png" }).catch(
    (error: { message?: string }) => error,
  );
  assert.equal((fetchFail as { message?: string }).message, LOGO_FAIL_HINT);
});

test("TC13.4 unauthenticated stats and branding mutate are 401; mailbox is 403", async () => {
  const db = new MemoryD1();
  const env = testEnv(db);
  const created = await createUser(env, { login: "grove", role: "mailbox", token: USER_TOKEN });
  const ownerCookie = `${OWNER_SESSION_COOKIE}=${await signOwnerSession(SECRET, { mailboxId: INBOX.id, address: INBOX.address })}`;
  const memberCookie = `${OWNER_SESSION_COOKIE}=${await signUserSession(SECRET, {
    userId: created.id,
    mailboxId: INBOX.id,
    address: INBOX.address,
    role: "mailbox",
  })}`;

  for (const path of ["/admin/stats", "/admin/branding", "/admin/overview", "/admin/site"]) {
    const anon = await handleAdmin(
      new Request(`http://127.0.0.1:8787${path}`),
      env,
      new URL(`http://127.0.0.1:8787${path}`),
    );
    assert.ok(anon.status === 401 || anon.status === 403, `${path} anon ${anon.status}`);
  }

  const mutate = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/branding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_title: "Nope" }),
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/branding"),
  );
  assert.equal(mutate.status, 401);

  const ownerStats = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/stats", { headers: { cookie: ownerCookie } }),
    env,
    new URL("http://127.0.0.1:8787/admin/stats"),
  );
  assert.equal(ownerStats.status, 403);

  const memberBrand = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/branding", {
      method: "POST",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      body: JSON.stringify({ site_title: "Nope" }),
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/branding"),
  );
  assert.equal(memberBrand.status, 403);

  const gated = await requireAdmin(new Request("http://127.0.0.1:8787/admin/stats"), env);
  assert.equal(gated.ok, false);
  if (!gated.ok) {
    assert.equal(gated.response.status, 401);
  }
  const ownerGate = await requireOwner(
    new Request("http://127.0.0.1:8787/settings", { headers: { cookie: ownerCookie } }),
    env,
  );
  assert.equal(ownerGate.ok, true);
});

test("logo probe rejects metadata hosts and DNS to a private IP", async () => {
  const db = new MemoryD1();
  const env = testEnv(db);

  await assert.rejects(
    () => gateLogoUrl("https://metadata.google.internal/logo.png"),
    (error: unknown) => error instanceof Error && error.message === LOGO_FAIL_HINT,
  );
  await assert.rejects(
    () => gateLogoUrl("https://169.254.169.254/latest/meta-data"),
    (error: unknown) => error instanceof Error && error.message === LOGO_FAIL_HINT,
  );

  let fetched = false;
  setLogoResolveForTests(async () => ["10.1.2.3"]);
  setLogoFetchForTests(async () => {
    fetched = true;
    return new Response("ok", { status: 200 });
  });
  const blocked = await saveBranding(env, { logo_url: "https://cdn.example.test/mark.svg" }).catch(
    (error: { message?: string }) => error,
  );
  assert.equal(fetched, false);
  assert.equal((blocked as { message?: string }).message, LOGO_FAIL_HINT);

  setLogoResolveForTests(async () => ["203.0.113.10"]);
  const saved = await saveBranding(env, { logo_url: "https://cdn.example.test/mark.svg" });
  assert.equal(saved.logo_url, "https://cdn.example.test/mark.svg");
});

test("admin cookie can open overview and site pages", async () => {
  const env = testEnv();
  const login = await handleAuthRoutes(
    new Request("http://127.0.0.1:8787/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ADMIN }),
    }),
    env,
  );
  assert.ok(login);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(ADMIN_SESSION_COOKIE));

  const page = await handleAdmin(
    new Request("http://127.0.0.1:8787/admin/site", {
      headers: { cookie: cookie.split(";")[0] },
    }),
    env,
    new URL("http://127.0.0.1:8787/admin/site"),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /站点|Site/);
  assert.match(html, /#1B4332/);
});
