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

P0 inbox on the Worker: list / read / delete against D1, inbound attachments in R2, plus compose/send behind the owner session. Search (LIKE on from / subject / body), unread toggle with a nav count, and star/flag are in. System folders (inbox / sent / drafts / trash / spam) use the existing `messages.folder` column; drafts save and resume on `/compose`. Outbound is pluggable (`stub` / `resend` / `http`). Reply / reply-all / forward prefill compose and send through the same adapters (In-Reply-To / References on reply). The inbox list groups related mail into basic threads (count on the row; open expands in time order). Mailbox-scoped REST tokens live under `/api/v1` (hash at rest, `Authorization: Bearer pg_…`). Public signup is **off** unless Turnstile is configured. Outbound send attachments are a later follow-up. Light-editorial brand art (paper + forest green) lives in [`docs/assets/`](docs/assets/).

## Local development

Requires Node.js 22+ (`npm test` uses `--experimental-strip-types`). No Cloudflare account is needed for the local path.

```bash
npm install
npm run check                    # tsc --noEmit; CI also runs npm test
cp .dev.vars.example .dev.vars   # local SESSION_SECRET, OWNER_TOKEN, ADMIN_TOKEN, OUTBOUND_PROVIDER=stub, attachment caps, optional Turnstile
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
| `inbox@example.test` | Inbox samples plus one draft, one sent, one trash, and one spam row; includes an attachment, a cited reply thread (本周同步), and a subject-fallback pair (办公室钥匙) |
| `empty@example.test` | Empty-inbox copy |

Direct links (same origin as `wrangler dev`):

- Inbox with mail: [http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111](http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111)
- Empty box: [http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111112](http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111112)

Open a row to read the body. Inbox rows are **threads**: a badge shows how many messages share the conversation. Opening a thread (`/box/:id/t/:threadId`) expands members in `received_at` order. An unread inbox row becomes read; opening a multi-message thread marks every inbox member read. **标为未读** on the reading pane flips one message back and the nav unread count updates. **☆ / ★** stars persist in D1. The list search box matches from, subject, and body with SQL `LIKE` (not FTS5). Filter chips: 全部 / 未读 / 星标. Sidebar folders: 收件箱 / 已发送 / 草稿 / 垃圾箱 / 垃圾邮件. **存草稿** keeps subject and body; opening the draft row restores them. Sending a draft promotes that row to 已发送. Delete moves the row to `trash` (it leaves the current folder and shows under 垃圾箱). **回复** / **全部回复** / **转发** open `/compose` with the original message prefilled. Reply sets `To` to the sender, `Re:` on the subject, and `In-Reply-To` / `References` from the stored Message-ID chain. Reply-all puts the original sender plus original To/Cc in To (deduped, minus this mailbox). Forward uses `Fwd:` and quotes the original headers/body; you still pick the new recipient. The seeded 「本地附件种子」row lists `grove-note.txt`; the owner session can download it from `/attachments/33333333-3333-4333-8333-333333333331`. **写信** is a real form (to / cc / subject / body). With `OUTBOUND_PROVIDER=stub` (the example `.dev.vars`) a submit records the attempt in D1, writes a sent message, and does not leave the box. The welcome seed row is already starred so the 星标 filter has something to show.

JSON against the same seeded rows (cookie from `POST /auth/login`):

```bash
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/mailboxes
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/folders
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/mailboxes/11111111-1111-4111-8111-111111111111/messages
curl -sS -b /tmp/pg-cookies 'http://127.0.0.1:8787/api/mailboxes/11111111-1111-4111-8111-111111111111/messages?folder=sent'
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/drafts/22222222-2222-4222-8222-222222222226
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222223
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/threads
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/threads/mid:seed-sync-root@example.test
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

### Search, unread, and star

Search uses **SQL `LIKE`** on `envelope_from`, `subject`, and `body_text` (case-insensitive for ASCII). `%` / `_` in the query are escaped. This is not D1 FTS5 — fine for a single-operator inbox; FTS can come later if the corpus grows.

`GET /api/search` and `GET /api/mailboxes/:id/messages` accept `q` and `filter=unread|starred`. Both call `requireOwner`. The JSON includes `engine: "like"` and `unread_count`.

```bash
# after the login cookie above
curl -sS -b /tmp/pg-cookies 'http://127.0.0.1:8787/api/search?q=确认码'
curl -sS -b /tmp/pg-cookies 'http://127.0.0.1:8787/api/search?q=billing@grove.test'
curl -sS -b /tmp/pg-cookies 'http://127.0.0.1:8787/api/search?q=482193'
curl -sS -b /tmp/pg-cookies 'http://127.0.0.1:8787/api/search?filter=unread'
curl -sS -b /tmp/pg-cookies 'http://127.0.0.1:8787/api/search?filter=starred'

curl -sS -b /tmp/pg-cookies -X POST \
  http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222223/read \
  -H 'content-type: application/json' \
  -d '{"read":true}'

curl -sS -b /tmp/pg-cookies -X POST \
  http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222223/read \
  -H 'content-type: application/json' \
  -d '{"read":false}'

curl -sS -b /tmp/pg-cookies -X POST \
  http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222222/star \
  -H 'content-type: application/json' \
  -d '{"starred":true}'
```

Seeded subjects you can type in the inbox search box: `欢迎使用本地收件箱`, `本月账单已出`, `你的确认码`. Body hit: `482193`. From hit: `billing@grove.test`.

Unauthenticated search / star is **401**:

```bash
curl -sS -o /dev/stderr -w '%{http_code}\n' \
  'http://127.0.0.1:8787/api/search?q=确认码'
curl -sS -o /dev/stderr -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222221/star \
  -H 'content-type: application/json' \
  -d '{"starred":true}'
```

Browser: sign in, use the search box, **未读** in the nav (or the 未读 chip), then **标为未读** / **星标** on a reading pane. Apply `npm run db:migrate:local` so `messages.is_starred` exists.

### Conversation threads

Inbox grouping is **good enough for personal / small-team mail**, not a full Gmail conversation model. No extra D1 column: threads are derived from the current inbox list (same `q` / `filter` as search).

1. **Citation (preferred).** Messages that share `In-Reply-To` / `References` tokens, or whose `rfc_message_id` is cited by another inbox row, become one thread. The stable id is `mid:` plus the root Message-ID (first `References` token, else `In-Reply-To`, else the oldest member's own id), without angle brackets.
2. **Subject fallback.** Rows with **no** citation headers and **not** cited by anyone else group when the normalized subject **and** the from+to participant pair match. Normalization lowercases the subject and repeatedly strips `Re:` / `Fwd:` / `Fw:` / `Forward:` / `回复:` / `转发:` (ASCII and fullwidth colon). Empty subjects stay singleton so blanks do not collapse into one pile.
3. **List / open.** `GET /api/threads` is one row per thread with `message_count`. `GET /api/threads/:id` returns members ordered by `received_at` ascending. The HTML list shows the count; `/box/:id/t/:threadId` expands the stack. Sent / drafts / trash / spam stay flat folder lists.

**Fallback caveats (intentional).** Same subject from different people stays separate. A reply that never sets citation headers will not join the cited thread even if the subject matches. MIME `Re[2]:` / folded headers / missing parents that use different ids are out of scope. Re-seed to see 「本周同步」(citation) and 「办公室钥匙」(subject fallback).

```bash
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/threads
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/threads/mid:seed-sync-root@example.test
curl -sS -o /dev/stderr -w '%{http_code}\n' http://127.0.0.1:8787/api/threads
```

The third call (no cookie) should print `401`. Both JSON routes go through `requireOwner`, same as the rest of `/api/*`.

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

### Open REST API (`/api/v1`) + abuse controls

Token API for automating address and mail ops. Cookie owner `/api/*` (inbox UI JSON) is unchanged and still uses `requireOwner`.

**Tokens are mailbox-scoped.** They bind to `mailbox_id` (today's owner/mailbox model). There is no users table here — multi-user / RBAC is a separate change. A token hashed at rest (`SHA-256`) looks like `pg_…`. Only the hash is stored. The plaintext secret is shown **once** at mint time.

Mint (owner session, bound to the logged-in mailbox):

```bash
curl -sS -b /tmp/pg-cookies -X POST http://127.0.0.1:8787/api/tokens \
  -H 'content-type: application/json' \
  -d '{"label":"local-ci"}'
```

Or admin (any mailbox):

```bash
curl -sS -X POST http://127.0.0.1:8787/admin/tokens \
  -H 'Authorization: Bearer change-me-local-admin-token' \
  -H 'content-type: application/json' \
  -d '{"mailbox_id":"11111111-1111-4111-8111-111111111111","label":"local-ci"}'
```

Expect `201` and `token.token` (`pg_…`). Store it; `GET /api/tokens` / `GET /admin/tokens?mailbox_id=…` only show `prefix` + label. Revoke with `POST /api/tokens/:id/revoke` (owner) or `POST /admin/tokens/:id/revoke` (admin).

```bash
export PG_TOKEN='pg_…'   # paste the minted secret

curl -sS -H "Authorization: Bearer $PG_TOKEN" http://127.0.0.1:8787/api/v1/mailboxes
# token REST cannot create addresses (403). Admin creates them:
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  -X POST http://127.0.0.1:8787/admin/mailboxes \
  -H 'content-type: application/json' \
  -d '{"address":"support@example.test","display_name":"Support"}'
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  http://127.0.0.1:8787/api/v1/mailboxes/11111111-1111-4111-8111-111111111111/messages
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  http://127.0.0.1:8787/api/v1/messages/22222222-2222-4222-8222-222222222223
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST http://127.0.0.1:8787/api/v1/send \
  -H 'content-type: application/json' \
  -d '{"to":"neighbor@example.test","subject":"hello","text":"from token REST"}'
```

Missing or invalid bearer → **401**. Using a token on another mailbox's messages or send → **403**. `POST /api/v1/mailboxes` with a `pg_` token is **403** (`forbidden`: create is admin-only). `GET /api/v1` is a public catalog (no secrets). Apply `npm run db:migrate:local` so `api_tokens` exists (`0008_api_tokens.sql`).

**Create addresses** is not a token REST capability. Admin: `POST /admin/mailboxes` with `ADMIN_TOKEN`. Owner session (cookie UI/API): `POST /api/mailboxes` `{ "address" }` (still one shared `OWNER_TOKEN` to log in as the new address). Public signup is a separate Turnstile-gated path when enabled.

**Public signup (Turnstile, off by default).** `POST /api/v1/public/signup` is **403** `public_signup_disabled` unless `TURNSTILE_SECRET_KEY` is set. When it is set, a Cloudflare Turnstile widget (site key `TURNSTILE_SITE_KEY`) must succeed: the Worker POSTs `secret` + `response` (+ optional `remoteip`) to `https://challenges.cloudflare.com/turnstile/v0/siteverify`. Missing or failed challenge → **403**. Success creates the mailbox and returns a one-time `pg_…` token.

```bash
# default (no TURNSTILE_SECRET_KEY): rejected
curl -sS -o /dev/stderr -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8787/api/v1/public/signup \
  -H 'content-type: application/json' \
  -d '{"address":"guest@example.test","turnstile_token":"xx"}'
```

**Rate and size limits** (documented defaults; in-memory per Worker isolate, same style as login):

| Surface | Default | Over limit |
|---------|---------|------------|
| `POST /auth/login` | 8 / 10 min / IP | **429** + `Retry-After` |
| `/api/v1/*` (after auth) | **60 / 60s** per token (or admin IP) | **429** + `Retry-After` |
| `POST /api/v1/public/signup` | **5 / 10 min / IP** | **429** + `Retry-After` |
| JSON body (`REST_BODY_MAX_BYTES`) | **256000** bytes | **413** `payload_too_large` |
| Outbound `text` / `subject` | 256000 chars / 998 chars (`src/outbound.ts`) | **400** |
| Inbound attachments | 10 MiB / 10 files | inbound reject (see above) |

Override REST knobs with `REST_RATE_LIMIT_MAX`, `REST_RATE_LIMIT_WINDOW_MS`, `SIGNUP_RATE_LIMIT_MAX`, `SIGNUP_RATE_LIMIT_WINDOW_MS`, `REST_BODY_MAX_BYTES` in `.dev.vars` / Worker vars. A new isolate starts a fresh window.

P3 wait-for-code / long-poll is out of scope.

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
# optional public signup (off until both are set):
# npx wrangler secret put TURNSTILE_SECRET_KEY
# npx wrangler secret put TURNSTILE_SITE_KEY
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
| `src/rest.ts` | Token REST `/api/v1` + public signup + admin mint |
| `src/api-tokens.ts` | Opaque `pg_…` tokens (hash at rest, mailbox-scoped) |
| `src/turnstile.ts` | Cloudflare siteverify (public signup only when configured) |
| `src/rate-limit.ts` | In-memory limiter for token API + signup |
| `src/health.ts` | `GET /healthz` |
| `src/inbound.ts` | Email Routing stub persist + attachment limits |
| `src/attachment-limits.ts` | Size / count caps and human-readable over-limit errors |
| `src/attachments.ts` | R2 store / owner download / read-view links |
| `src/mime.ts` | Plain-text body extract + inbound MIME attachments |
| `src/api.ts` | JSON list / read / delete / send / search / star / threads |
| `src/ui.ts` | Inbox HTML + compose / reply / forward form |
| `src/reply.ts` | Reply / reply-all / forward prefill + header helpers |
| `src/threads.ts` | Inbox thread grouping (citation, then subject fallback) |
| `src/triage.ts` | Search `LIKE` helpers + unread / star filters |
| `src/outbound.ts` | Pluggable outbound adapters (`stub` / `resend` / `http`) |
| `src/send.ts` | Validate + persist outbound attempts |
| `migrations/0001_init.sql` | D1 `mailboxes` + `messages` |
| `migrations/0002_message_body.sql` | `messages.body_text` |
| `migrations/0003_outbound_attempts.sql` | D1 `outbound_attempts` |
| `migrations/0004_attachments.sql` | D1 `attachments` metadata (bytes in R2) |
| `migrations/0005_reply_headers.sql` | Inbound To/Cc/Reply-To/References + outbound attempt headers |
| `migrations/0006_message_star.sql` | `messages.is_starred` + unread / star indexes |
| `migrations/0007_mailbox_folders.sql` | Folder / draft indexes (P1) |
| `migrations/0008_api_tokens.sql` | Mailbox-scoped API tokens (hash at rest) |
| `scripts/seed-local.sql` | Local sample mailboxes + messages (not for remote) |
| `scripts/seed-grove-note.txt` | Local sample attachment bytes |
| `wrangler.jsonc` | Worker + D1 + R2 bindings (placeholders) |
| `.dev.vars.example` | Local secret / outbound / attachment-cap / Turnstile / REST limit template |

## License

MIT. See `LICENSE`.

## CI

GitHub Actions runs `npm run check` (`tsc --noEmit`) and `npm test` on pull requests and `main`. No repository secrets are required.

## Contributing

Open an Issue before large features. Keep tone practical; this is a real project, not a form submission. Run `npm run check` before opening a PR.
