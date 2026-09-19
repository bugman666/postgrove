# Postgrove

![Postgrove](docs/assets/pg-readme-hero.jpg)

Personal and small-team **edge mailbox** on Cloudflare Workers.

Open addresses on a domain you own, receive mail at the edge, read it in a web inbox, and keep attachments in R2. Built for self-hosters who do not want to run a full mail server.

> Not affiliated with other Cloudflare mail demos. Educational / self-host use. You are responsible for domain, deliverability, and abuse controls.

## Why Postgrove

- **Your domain** — one Worker, several role addresses (`support@`, `billing@`)
- **Edge-first** — Cloudflare Workers + D1 + R2 + Email Routing
- **Small surface** — create address → receive → read → send
- **Honest scope** — no fake “enterprise suite”; roadmap stays visible
- **Pluggable send** — stub for local/dev, Resend or a generic HTTP hook for real delivery

## Planned MVP

1. Create one or more addresses on your domain
2. Receive mail (Email Routing → Worker → D1)
3. Read in a web inbox (list / open / delete; attachments in R2)
4. Compose and send through a provider you control, including reply / reply-all / forward
5. Failures say what happened and what to do next (auth, missing outbound, routing)

## Out of scope (this milestone)

- Throwaway / anonymous mailboxes
- Calendar, contacts, or replacing a full IMAP/SMTP stack
- Conversation threading (list grouping) — reply headers are set; the thread UI is later
- Attachments on send
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
| **P0 MVP** | Edge mailbox core | Inbound → D1, web inbox, compose/send, R2 attachments, simple auth |
| **P1** | Mailbox completeness | Reply / reply-all / forward, folders + drafts + sent, search / unread / star, basic threads |
| **P2** | Platform | Multi-user + RBAC/quotas, inbound webhooks/forward, open REST + abuse controls, light analytics, i18n, soft branding |
| **P3** | Dev API (own domain) | Wait-for-message / OTP helpers, `+` aliases, API keys & quotas — **not** multi-provider disposable mail hubs |

See Issues under milestones `P0-MVP` … `P3-dev-api`. Longer write-ups: [product brief](docs/PRODUCT_BRIEF_v0.md), [roadmap](docs/ROADMAP.md), [visual system](docs/VISUAL_SYSTEM_v0.md).

## Status

P0 inbox on the Worker: list / read / delete against D1, inbound attachments in R2, plus compose/send behind the owner session. Outbound is pluggable (`stub` / `resend` / `http`). Reply / reply-all / forward prefill compose and send through the same adapters (In-Reply-To / References on reply). Outbound send attachments are a later follow-up. Light-editorial brand art (paper + forest green) lives in [`docs/assets/`](docs/assets/).

## Local development

Requires Node.js 18.17+ (20+ recommended). No Cloudflare account is needed for the local path.

```bash
npm install
npm run check                    # tsc --noEmit; same command as CI
cp .dev.vars.example .dev.vars   # local SESSION_SECRET, OWNER_TOKEN, ADMIN_TOKEN, OUTBOUND_PROVIDER=stub, attachment caps
npm run db:migrate:local
npm run seed:local               # sample mailboxes + messages + one R2 attachment (local only)
npm run dev
```

`wrangler dev` serves the Worker at `http://127.0.0.1:8787` by default.

### Inbox (local)

Inbox HTML (`/`, `/box/:id`, read/delete) and `/api/mailboxes` / `/api/messages` call `requireOwner`. Without a session they return **401** (`unauthorized` plus the same hint as `src/auth.ts`). `/healthz` and inbound Email Routing stay public. `/app.css` stays public so the login page can load.

Browser: open [http://127.0.0.1:8787/](http://127.0.0.1:8787/), sign in with a seeded address and `OWNER_TOKEN` (`change-me-local-owner-token` from `.dev.vars.example`). The session is bound to that address.

Seeded addresses:

| Address | What you should see after login |
|---------|---------------------|
| `inbox@example.test` | Five sample messages, including one with a downloadable attachment and one group thread for reply-all |
| `empty@example.test` | Empty-inbox copy |

Direct links (same origin as `wrangler dev`):

- Inbox with mail: [http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111](http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111)
- Empty box: [http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111112](http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111112)

Open a row to read the body. An unread row becomes read. Delete moves the row to `trash` (it leaves the inbox list; there is no trash folder UI yet). **回复** / **全部回复** / **转发** open `/compose` with the original message prefilled. Reply sets `To` to the sender, `Re:` on the subject, and `In-Reply-To` / `References` from the stored Message-ID chain. Reply-all adds the original To/Cc minus this mailbox. Forward uses `Fwd:` and quotes the original headers/body; you still pick the new recipient. The seeded 「本地附件种子」row lists `grove-note.txt`; the owner session can download it from `/attachments/33333333-3333-4333-8333-333333333331`. **写信** is a real form (to / cc / subject / body). With `OUTBOUND_PROVIDER=stub` (the example `.dev.vars`) a submit records the attempt in D1 and does not leave the box.

JSON against the same seeded rows (cookie from `POST /auth/login`):

```bash
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/mailboxes
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/mailboxes/11111111-1111-4111-8111-111111111111/messages
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222223
curl -sS -b /tmp/pg-cookies -X DELETE http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222221
```

Re-seed with `npm run seed:local` if you want the sample rows and the R2 object back (`INSERT OR IGNORE` will not restore a row you already deleted). To reset the local D1 / R2 files, stop Wrangler, remove `.wrangler/state`, then migrate + seed again.

### Attachments (R2 + size limits)

Inbound MIME parts with `Content-Disposition: attachment` (or a filename / non-text body part) are stored in the `ATTACHMENTS` R2 bucket. Metadata lives in D1 (`attachments`). The read view lists them; `GET /attachments/:id` streams the bytes after `requireOwner`.

| Knob | Where | Default | Role |
|------|--------|---------|------|
| `ATTACHMENTS` | `wrangler.jsonc` `r2_buckets` | binding required | R2 bucket for bytes |
| `ATTACHMENT_MAX_BYTES` | wrangler `vars` / `.dev.vars` | `10485760` (10 MiB) | Max size of one inbound attachment |
| `ATTACHMENT_MAX_COUNT` | wrangler `vars` / `.dev.vars` | `10` | Max attachments stored per inbound message |

Over-limit inbound mail is **rejected** (`message.setReject`) with a human-readable reason that includes the cap, for example: 附件太大（上限 10 MB）… Remove large files or compress and try again. The message is not stored. Missing R2 binding rejects only when the message actually has attachments.

Unauthenticated download is **401** (`unauthorized`, same hint as other owner routes). Another mailbox's session is **403**. There are no public unauthenticated attachment URLs. Virus scanning is out of scope. Compose/send attachments are not in this change.

Local seed object (after `npm run seed:local`):

```bash
curl -sS -b /tmp/pg-cookies -D- \
  http://127.0.0.1:8787/attachments/33333333-3333-4333-8333-333333333331 -o /tmp/grove-note.txt
curl -sS -o /dev/stderr -w '%{http_code}\n' \
  http://127.0.0.1:8787/attachments/33333333-3333-4333-8333-333333333331
```

The second call (no cookie) should print `401`.

Inbound with a small attachment (Wrangler local email endpoint):

```bash
curl --request POST 'http://127.0.0.1:8787/cdn-cgi/local/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=inbox@example.test' \
  --data-raw 'From: sender@example.com
To: inbox@example.test
Subject: inbound with file
Date: Sat, 19 Sep 2026 12:00:00 +0000
Message-ID: <local-attach-1@example.test>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="bnd"

--bnd
Content-Type: text/plain; charset=utf-8

See the note.
--bnd
Content-Type: text/plain; name=note.txt
Content-Disposition: attachment; filename="note.txt"
Content-Transfer-Encoding: base64

aGVsbG8K
--bnd--
'
```

### Health

```bash
curl -sS http://127.0.0.1:8787/healthz
```

Expect JSON with `"ok": true` and `"db": "ready"` after migrations. A `503` with `"migrations_pending"` means the local D1 schema has not been applied.

`GET /healthz` stays public (no session). After this milestone it also expects the `outbound_attempts` table (`npm run db:migrate:local`). The Email Routing handler is also unauthenticated — Cloudflare calls it, not a browser.

### Compose and outbound

`GET`/`POST /compose` and `POST /api/send` call `requireOwner` (same session cookie as Inbox, including the Origin/Referer check on POST). Without a session they return **401** (HTML login page for `/compose`, JSON `unauthorized` + hint for `/api/send`). Reply prefills live at `GET /compose?mode=reply|reply-all|forward&message=<id>` and `GET /api/messages/:id/compose?mode=…`.

Local example uses `OUTBOUND_PROVIDER=stub`: the adapter records the attempt and returns success without sending. Real providers fail **loud** when config is missing or the key is rejected — the row is stored as `failed` and the compose page shows the error plus the next step.

| Env | Role |
|-----|------|
| `OUTBOUND_PROVIDER` | `stub` · `resend` · `http`. Unset → send fails with an actionable hint |
| `RESEND_API_KEY` | Required for `resend` |
| `RESEND_FROM` | Optional From override (verified domain) |
| `OUTBOUND_HTTP_URL` | Required for `http` (POST JSON `{from,to,subject,text}`; optional `cc`, `headers`, `in_reply_to`, `references`) |
| `OUTBOUND_HTTP_TOKEN` | Optional Bearer for the HTTP hook |
| `OUTBOUND_FROM` | Optional From override for any provider |

```bash
# stub success (after login cookie)
curl -sS -b /tmp/pg-cookies -X POST http://127.0.0.1:8787/api/send \
  -H 'content-type: application/json' \
  -d '{"to":"neighbor@example.test","subject":"hello","text":"from local stub"}'

curl -sS -b /tmp/pg-cookies \
  'http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222225/compose?mode=reply-all'

curl -sS -b /tmp/pg-cookies -X POST http://127.0.0.1:8787/api/send \
  -H 'content-type: application/json' \
  -d '{"to":"lead@grove.test","cc":"teammate@grove.test, notes@grove.test","subject":"Re: 本周同步","text":"ack","in_reply_to":"<seed-sync@example.test>","references":"<seed-sync-root@example.test> <seed-sync@example.test>"}'

curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/outbound/attempts
```

Open [http://127.0.0.1:8787/compose](http://127.0.0.1:8787/compose) while signed in to use the form. Recent attempts (including failures) stay on that page.

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

**CSRF (cookie + SameSite=Lax + Origin check).** The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS. Cross-site form POSTs therefore do not send it on modern browsers. Cookie-authenticated writes (`POST /auth/logout`, inbox delete, `POST /compose`, `POST /api/send`, `DELETE /api/messages/…`, anything else that calls `requireOwner` with POST/PUT/PATCH/DELETE) also require `Origin` (or `Referer` if `Origin` is missing) to match this Worker. Same-origin HTML forms and `fetch` already send `Origin`, so the inbox and compose UI did not need a rewrite. Missing both headers is allowed for curl and scripts. That is enough for this MVP.

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
npx wrangler r2 bucket create postgrove-attachments
# confirm wrangler.jsonc r2_buckets.bucket_name matches
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OWNER_TOKEN
npx wrangler secret put ADMIN_TOKEN
# when sending for real:
# npx wrangler secret put RESEND_API_KEY
# set OUTBOUND_PROVIDER=resend as a Worker var (or http + OUTBOUND_HTTP_URL)
npx wrangler deploy
```

Then, in the Cloudflare dashboard, enable Email Routing for your domain and add a rule that sends matching addresses to the `postgrove` Worker.

## Layout

| Path | Role |
|------|------|
| `src/index.ts` | Worker `fetch` + `email` handlers |
| `src/auth.ts` | Owner session + admin bearer; `requireOwner` / `requireAdmin` |
| `src/health.ts` | `GET /healthz` |
| `src/inbound.ts` | Email Routing stub persist + attachment limits |
| `src/attachment-limits.ts` | Size / count caps and human-readable over-limit errors |
| `src/attachments.ts` | R2 store / owner download / read-view links |
| `src/mime.ts` | Plain-text body extract + inbound MIME attachments |
| `src/api.ts` | JSON list / read / delete / send |
| `src/ui.ts` | Inbox HTML + compose / reply / forward form |
| `src/reply.ts` | Reply / reply-all / forward prefill + header helpers |
| `src/outbound.ts` | Pluggable outbound adapters (`stub` / `resend` / `http`) |
| `src/send.ts` | Validate + persist outbound attempts |
| `migrations/0001_init.sql` | D1 `mailboxes` + `messages` |
| `migrations/0002_message_body.sql` | `messages.body_text` |
| `migrations/0003_outbound_attempts.sql` | D1 `outbound_attempts` |
| `migrations/0004_attachments.sql` | D1 `attachments` metadata (bytes in R2) |
| `migrations/0005_reply_headers.sql` | Inbound To/Cc/Reply-To/References + outbound attempt headers |
| `scripts/seed-local.sql` | Local sample mailboxes + messages (not for remote) |
| `scripts/seed-grove-note.txt` | Local sample attachment bytes |
| `wrangler.jsonc` | Worker + D1 + R2 bindings (placeholders) |
| `.dev.vars.example` | Local secret / outbound / attachment-cap template |

## License

MIT. See `LICENSE`.

## CI

GitHub Actions runs `npm run check` (`tsc --noEmit`) on pull requests and `main`. No repository secrets are required.

## Contributing

Open an Issue before large features. Keep tone practical; this is a real project, not a form submission. Run `npm run check` before opening a PR.
