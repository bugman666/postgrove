# Postgrove

Personal and small-team **edge mailbox** on Cloudflare Workers.

Open addresses on a domain you own, receive mail at the edge, read it in a web inbox, and keep attachments in R2. Built for self-hosters who do not want to run a full mail server.

> Not affiliated with other Cloudflare mail demos. Educational / self-host use. You are responsible for domain, deliverability, and abuse controls.

## Why Postgrove

- **Your domain** — one Worker, several role addresses (`support@`, `billing@`)
- **Edge-first** — Cloudflare Workers + D1 + R2 + Email Routing
- **Small surface** — create address → receive → read → send
- **Honest scope** — no fake “enterprise suite”; roadmap stays visible

## Planned MVP

1. Create one or more addresses on your domain
2. Receive mail (Email Routing → Worker → D1)
3. Read in a web inbox (list / open / delete; attachments in R2)
4. Compose and send through a provider you control (reply later if we keep it)
5. Failures say what happened and what to do next (auth, missing outbound, routing)

## Out of scope (this milestone)

- Throwaway / anonymous mailboxes
- Calendar, contacts, or replacing a full IMAP/SMTP stack
- Real reply / reply-all / forward (the inbox shows a reply entry only)
- Compose + outbound provider
- Multi-user / RBAC / per-address passwords (one shared `OWNER_TOKEN` until then)

## Stack (intended)

| Piece | Choice |
|-------|--------|
| Runtime | Cloudflare Workers |
| Inbound | Cloudflare Email Routing |
| Data | D1 |
| Files | R2 |
| UI | Lightweight web app (details in Issues) |


## Roadmap (phased)

Capability ideas drawn from mainstream mail UX (e.g. Gmail), Cloudflare edge mailboxes, and developer inbox APIs — **implemented originally**; we do not copy UI, brand, or third-party temp-mail aggregation.

| Phase | Focus | Highlights |
|-------|--------|------------|
| **P0 MVP** | Edge mailbox core | Inbound → D1, web inbox, compose/send, R2 attachments, simple auth; reply **UI stub only** |
| **P1** | Mailbox completeness | Reply / reply-all / forward, folders + drafts + sent, search / unread / star, basic threads |
| **P2** | Platform | Multi-user + RBAC/quotas, inbound webhooks/forward, open REST + abuse controls, light analytics, i18n, soft branding |
| **P3** | Dev API (own domain) | Wait-for-message / OTP helpers, `+` aliases, API keys & quotas — **not** multi-provider disposable mail hubs |

See Issues under milestones `P0-MVP` … `P3-dev-api`. Longer write-ups: [product brief](docs/PRODUCT_BRIEF_v0.md), [roadmap](docs/ROADMAP.md), [visual system](docs/VISUAL_SYSTEM_v0.md).

## Status

P0 inbox on the Worker: list / read / delete against D1, plus a small web UI behind the owner session. Reply and compose are visible stubs only (no send).

## Local development

Requires Node.js 18.17+ (20+ recommended). No Cloudflare account is needed for the local path.

```bash
npm install
npm run check                    # tsc --noEmit; same command as CI
cp .dev.vars.example .dev.vars   # local SESSION_SECRET, OWNER_TOKEN, ADMIN_TOKEN
npm run db:migrate:local
npm run db:seed:local            # sample mailboxes + messages (local only)
npm run dev
```

`wrangler dev` serves the Worker at `http://127.0.0.1:8787` by default.

### Inbox (local)

Inbox HTML (`/`, `/box/:id`, read/delete) and `/api/mailboxes` / `/api/messages` call `requireOwner`. Without a session they return **401** (`unauthorized` plus the same hint as `src/auth.ts`). `/healthz` and inbound Email Routing stay public. `/app.css` stays public so the login page can load.

Browser: open [http://127.0.0.1:8787/](http://127.0.0.1:8787/), sign in with a seeded address and `OWNER_TOKEN` (`change-me-local-owner-token` from `.dev.vars.example`). The session is bound to that address.

Seeded addresses:

| Address | What you should see after login |
|---------|---------------------|
| `inbox@example.test` | Three sample messages (unread / sender / subject / time) |
| `empty@example.test` | Empty-inbox copy |

Direct links (same origin as `wrangler dev`):

- Inbox with mail: [http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111](http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111)
- Empty box: [http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111112](http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111112)

Open a row to read the body. An unread row becomes read. Delete moves the row to `trash` (it leaves the inbox list; there is no trash folder UI yet). The **回复** control only shows a placeholder — it does not send mail.

JSON against the same seeded rows (cookie from `POST /auth/login`):

```bash
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/mailboxes
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/mailboxes/11111111-1111-4111-8111-111111111111/messages
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222223
curl -sS -b /tmp/pg-cookies -X DELETE http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222221
```

Re-seed with `npm run db:seed:local` if you want the sample rows back (`INSERT OR IGNORE` will not restore a row you already deleted). To reset the local D1 file, stop Wrangler, remove `.wrangler/state`, then migrate + seed again.

### Health

```bash
curl -sS http://127.0.0.1:8787/healthz
```

Expect JSON with `"ok": true` and `"db": "ready"` after migrations. A `503` with `"migrations_pending"` means the local D1 schema has not been applied.

`GET /healthz` stays public (no session). The Email Routing handler is also unauthenticated — Cloudflare calls it, not a browser.

### Auth (mailbox owner session + admin bearer)

Design: **owner = signed HttpOnly session cookie** after `POST /auth/login`. **Admin = `Authorization: Bearer <ADMIN_TOKEN>`**. Inbox HTML and JSON call `requireOwner` from `src/auth.ts`.

**Shared `OWNER_TOKEN` vs per-address passwords.** There is one shared `OWNER_TOKEN` for every mailbox. It is not a per-address password. Anyone who has the token can log in as any active address; the session cookie is then bound to that address. Per-user / per-mailbox passwords wait for multi-user (P2). Treat `OWNER_TOKEN` like a deploy secret, not a login you share with guests.

Copy `.dev.vars.example` to `.dev.vars` (gitignored). The example values work locally; change them before any remote deploy and set the same names with `npx wrangler secret put`.

Owner login (needs the seeded address and `OWNER_TOKEN`):

```bash
curl -i -c /tmp/pg-cookies -X POST http://127.0.0.1:8787/auth/login \
  -H 'content-type: application/json' \
  -d '{"address":"inbox@example.test","token":"change-me-local-owner-token"}'
```

Expect `200` and a `set-cookie: postgrove_session=...` header. Then:

```bash
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/auth/session
```

Expect JSON with `"ok": true` and `"role": "owner"`. Without a cookie, the same URL returns **401**:

```bash
curl -sS -o /dev/stderr -w '%{http_code}\n' http://127.0.0.1:8787/auth/session
```

Sign out (clears the cookie on the client; sessions are stateless HMAC tokens):

```bash
curl -i -c /tmp/pg-cookies -X POST http://127.0.0.1:8787/auth/logout
```

**Login rate limit.** `POST /auth/login` allows **8 attempts per 10 minutes per IP** (`CF-Connecting-IP`, else the first `X-Forwarded-For` hop). Over the limit returns **429** with `Retry-After` and a hint such as “Too many login attempts from this network…”. Counters live in Worker memory, so a new isolate starts a fresh window. That is enough for a single-operator MVP; a shared store (Durable Object / KV) can come later if you run many isolates.

**Rotate `SESSION_SECRET` to revoke sessions.** Logout only deletes the cookie in that browser. Tokens are HMAC-signed and are not stored on the server, so they stay valid until expiry (7 days) if someone copied the cookie. To revoke every owner session: put a new `SESSION_SECRET` (`npx wrangler secret put SESSION_SECRET`, or edit `.dev.vars` locally) and redeploy / restart Wrangler. Old cookies fail verify. `OWNER_TOKEN` / `ADMIN_TOKEN` do not rotate sessions; change those when the secret leaked, then rotate `SESSION_SECRET` as well.

**CSRF (cookie + SameSite=Lax + Origin check).** The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS. Cross-site form POSTs therefore do not send it on modern browsers. Cookie-authenticated writes (`POST /auth/logout`, inbox delete, `DELETE /api/messages/…`, anything else that calls `requireOwner` with POST/PUT/PATCH/DELETE) also require `Origin` (or `Referer` if `Origin` is missing) to match this Worker. Same-origin HTML forms and `fetch` already send `Origin`, so the inbox UI did not need a rewrite. Missing both headers is allowed for curl and scripts. That is enough for this MVP.

Still open for P2: a required custom header or double-submit token (so missing-`Origin` clients cannot be used as a CSRF hole), CSRF on GET side effects (mark-as-read), per-address passwords, and an expiring admin bearer.

Admin stub (later mailbox-management routes can reuse `requireAdmin`):

```bash
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  http://127.0.0.1:8787/admin/ping
```

Expect `"role": "admin"`. A missing or wrong bearer returns **401**. Admin is a bearer token, not a cookie, so browser CSRF does not apply the same way. It also does not expire — treat a leaked `ADMIN_TOKEN` as “rotate now”.

### Inbound stub (local Email Routing)

With `wrangler dev` running, post an RFC 5322 message to Wrangler's local email endpoint. The body must include a `Message-ID` header:

```bash
curl --request POST 'http://127.0.0.1:8787/cdn-cgi/local/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=inbox@example.test' \
  --data-raw 'From: sender@example.com
To: inbox@example.test
Subject: Postgrove local stub
Date: Sat, 19 Sep 2026 11:00:00 +0000
Message-ID: <local-stub-1@example.test>
Content-Type: text/plain; charset=utf-8

Hello from a local inbound test.
'
```

Create the address first, then receive. The stub rejects unknown and disabled recipients (no catch-all, no anonymous boxes). After `npm run db:seed:local`, `inbox@example.test` is available. Check Wrangler logs for `inbound stub: stored`. Inspect rows with:

```bash
npx wrangler d1 execute postgrove --local --command \
  "SELECT address FROM mailboxes; SELECT subject, envelope_from, folder, is_read FROM messages;"
```

## Remote placeholders

`wrangler.jsonc` ships with a dummy `database_id`. Replace it after creating a real D1 database. Do not commit account tokens, API keys, or filled `.dev.vars`.

```bash
npx wrangler login
npx wrangler d1 create postgrove
# paste the printed database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OWNER_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Then, in the Cloudflare dashboard, enable Email Routing for your domain and add a rule that sends matching addresses to the `postgrove` Worker.

## Layout

| Path | Role |
|------|------|
| `src/index.ts` | Worker `fetch` + `email` handlers |
| `src/auth.ts` | Owner session + admin bearer; `requireOwner` / `requireAdmin` |
| `src/health.ts` | `GET /healthz` |
| `src/inbound.ts` | Email Routing stub persist |
| `src/api.ts` | JSON list / read / delete |
| `src/ui.ts` | Inbox HTML (list / read / stubs) |
| `migrations/0001_init.sql` | D1 `mailboxes` + `messages` |
| `migrations/0002_message_body.sql` | `messages.body_text` |
| `scripts/seed-local.sql` | Local sample mailboxes + messages (not for remote) |
| `wrangler.jsonc` | Worker + D1 bindings (placeholders) |
| `.dev.vars.example` | Local secret template |

## License

MIT. See `LICENSE`.

## CI

GitHub Actions runs `npm run check` (`tsc --noEmit`) on pull requests and `main`. No repository secrets are required.

## Contributing

Open an Issue before large features. Keep tone practical; this is a real project, not a form submission. Run `npm run check` before opening a PR.
