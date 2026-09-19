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

## What's included

This first cut ships:

1. Create one or more addresses on your domain
2. Receive mail (Email Routing → Worker → D1)
3. Read in a web inbox (list / open / delete; attachments in R2)
4. Compose and send through a provider you control, including reply / reply-all / forward
5. Failures say what happened and what to do next (auth, missing outbound, routing)

## Out of scope (this milestone)

- Throwaway / anonymous mailboxes — no third-party temp-mail aggregation
- Calendar, contacts, or replacing a full IMAP/SMTP stack
- Attachments on send
- Per-address passwords as a replacement for `OWNER_TOKEN` (owner token stays as break-glass; members have their own tokens)

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
| **P2** | Platform | Multi-user + RBAC/quotas, inbound webhooks/forward (signed HMAC + delivery log), open REST + abuse controls, light analytics, i18n, soft branding |
| **P3** | Dev API (own domain) | Wait-for-message / OTP helpers, `+` aliases, API keys & quotas — **not** multi-provider disposable mail hubs |

See Issues under milestones `P0-MVP` … `P3-dev-api`. Longer write-ups: [product brief](docs/PRODUCT_BRIEF_v0.md), [roadmap](docs/ROADMAP.md), [visual system](docs/VISUAL_SYSTEM_v0.md).

## Status

First-cut notes: [RELEASE_NOTES_v0.1](docs/RELEASE_NOTES_v0.1.md).

P0 inbox on the Worker: list / read / delete against D1, inbound attachments in R2, plus compose/send behind the owner session. Search (D1 FTS5 on from / To / subject / body, LIKE fallback), unread toggle with a nav count, and star/flag are in. System folders (inbox / sent / drafts / trash / spam) use the existing `messages.folder` column; drafts save and resume on `/compose`. Outbound is pluggable (`stub` / `resend` / `http`). Reply / reply-all / forward prefill compose and send through the same adapters (In-Reply-To / References on reply). The inbox list groups related mail into basic threads (count on the row; open expands in time order). Mailbox-scoped REST tokens live under `/api/v1` (hash at rest, `Authorization: Bearer pg_…`). Tokens are **mailbox** or **admin** kind; mailbox keys stay on one address, admin keys (or `ADMIN_TOKEN`) may act across mailboxes. Optional per-token daily request / send quotas fail loud (`quota_api` / `quota_send`). Plus-tag subaddressing (`user+tag@your-domain`) lands in the primary mailbox; Settings can generate/list aliases on that domain only. Developer ephemeral inboxes (`/api/v1/dev/inboxes`) mint a short-lived address on **this deployment's own domain**, then wait / extract OTP or link / close. Public signup is **off** unless Turnstile is configured. Small-team members (`users` + `user_mailboxes`) have address / storage / daily-send quotas; `/admin` is a forest-token 值守台 (ADMIN_TOKEN or admin role) with a light overview (users / today's mail / attachment MB) and site title / logo / accent (`--pg-color-brand` only). The UI follows `Accept-Language` (en / zh) and can be forced from Settings. Inbound webhooks POST a signed JSON payload; optional forward goes to a chat-bot URL or an external mailbox. Delivery failures stay on `/settings` and `/admin` (never swallowed). Outbound send attachments are a later follow-up. Light-editorial brand art (paper + forest green) lives in [`docs/assets/`](docs/assets/).

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
| `empty@example.test` | Empty-inbox copy. Seeded member `grove` can log in here with `change-me-local-user-token` |

Direct links (same origin as `wrangler dev`):

- Inbox with mail: [http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111](http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111111)
- Empty box: [http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111112](http://127.0.0.1:8787/box/11111111-1111-4111-8111-111111111112)

Open a row to read the body. Inbox rows are **threads**: a badge shows how many messages share the conversation. Opening a thread (`/box/:id/t/:threadId`) expands members in `received_at` order. An unread inbox row becomes read; opening a multi-message thread marks every inbox member read. **标为未读** on the reading pane flips one message back and the nav unread count updates. **☆ / ★** stars persist in D1. The list search box matches from, To (including `+tag`), subject, and body via D1 FTS5 when `messages_fts` is present, otherwise SQL `LIKE`. Filter chips: 全部 / 未读 / 星标. Sidebar folders: 收件箱 / 已发送 / 草稿 / 垃圾箱 / 垃圾邮件. **存草稿** keeps subject and body; opening the draft row restores them. Sending a draft promotes that row to 已发送. Delete moves the row to `trash` (it leaves the current folder and shows under 垃圾箱). **回复** / **全部回复** / **转发** open `/compose` with the original message prefilled. Reply sets `To` to the sender, `Re:` on the subject, and `In-Reply-To` / `References` from the stored Message-ID chain. Reply-all puts the original sender plus original To/Cc in To (deduped, minus this mailbox). Forward uses `Fwd:` and quotes the original headers/body; you still pick the new recipient. The seeded 「本地附件种子」row lists `grove-note.txt`; the owner session can download it from `/attachments/33333333-3333-4333-8333-333333333331`. **写信** is a real form (to / cc / subject / body). With `OUTBOUND_PROVIDER=stub` (the example `.dev.vars`) a submit records the attempt in D1, writes a sent message, and does not leave the box. The welcome seed row is already starred so the 星标 filter has something to show.

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

Over-limit inbound mail is **rejected** (`message.setReject`) with a human-readable reason that includes the cap, for example: 附件太大（上限 10 MB）… Remove large files or compress and try again. The message is not stored. Missing R2 binding rejects only when the message actually has attachments. If R2 put or the `attachments` row insert fails after the D1 message row is written, inbound also **rejects** and deletes that row (plus any partial R2 / attachment writes) so the inbox never shows a body with missing files and a sender retry is not treated as a duplicate `rfc_message_id`.

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

Search uses **D1 FTS5** on `envelope_from`, `envelope_to`, `subject`, and `body_text` when the `messages_fts` virtual table exists (migration `0016_messages_fts.sql`, backfilled and kept in sync by triggers). The MATCH string is sanitized (operators and wildcards stripped; letters, digits, and CJK kept). Subject is ranked above from / To / body (`bm25` column weights). If FTS is unavailable, the same fields fall back to SQL `LIKE` (`%` / `_` escaped, case-insensitive for ASCII). `envelope_to` is how a `+tag` stays findable.

`GET /api/search` and `GET /api/mailboxes/:id/messages` accept `q` and `filter=unread|starred`. Both call `requireOwner`. The JSON includes `engine: "fts5"` or `engine: "like"` (whichever ran) and `unread_count`.

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

Expect JSON with `"ok": true` and `"db": "ready"` after migrations. A `503` with `"migrations_pending"` means the local D1 schema has not been applied. When the `users` table can be counted, the body also includes `auth_mode`: `"owner_break_glass"` if there are no members (day-to-day login is still the shared `OWNER_TOKEN`), or `"members"` if at least one users-table row exists. The field is omitted if the count cannot run — status stays 200/503 as before.

`GET /healthz` stays public (no session). After this milestone it also expects `outbound_attempts`, `api_tokens`, `users`, `inbound_hooks`, `inbound_deliveries`, and `dev_inboxes` (`npm run db:migrate:local`). The Email Routing handler is also unauthenticated — Cloudflare calls it, not a browser. Production auth runbook: [docs/PRODUCTION_AUTH.md](docs/PRODUCTION_AUTH.md).

### Compose and outbound

`GET`/`POST /compose` and `POST /api/send` call `requireOwner` (same session cookie as Inbox, including the Origin/Referer check on POST). Without a session they return **401** (HTML login page for `/compose`, JSON `unauthorized` + hint for `/api/send`). Reply prefills live at `GET /compose?mode=reply|reply-all|forward&message=<id>` and `GET /api/messages/:id/compose?mode=…`.

Local example uses `OUTBOUND_PROVIDER=stub`: the adapter records the attempt and returns success without sending. Real providers fail **loud** when config is missing or the key is rejected — the row is stored as `failed` and the compose page shows the error plus the next step.

Send is outbox-first (mainstream outbox / send-status idea): the Worker writes `outbound_attempts` as `pending` with an **idempotency key** before the provider call, then updates `sent` / `failed` and the Sent folder. Repeat `POST /api/send` or `POST /api/v1/messages` with the same `Idempotency-Key` header or JSON `idempotency_key` returns the original attempt and does not call the provider again. Transient provider errors (network, 429, 5xx) retry inside that request up to 3 times. `wrangler.jsonc` has no cron triggers yet — a scheduled drain of leftover `pending` rows is a later step; replay the same key (or send again) to finish work.

| Env | Role |
|-----|------|
| `OUTBOUND_PROVIDER` | `stub` · `resend` · `http`. Unset → send fails with an actionable hint |
| `RESEND_API_KEY` | Required for `resend` |
| `RESEND_FROM` | Optional From override (verified domain) |
| `OUTBOUND_HTTP_URL` | Required for `http` (POST JSON `{from,to,subject,text}`; optional `cc`, `headers`, `in_reply_to`, `references`). **Operator-trusted env only** — set in `.dev.vars` / `wrangler secret put`. Never accept this URL from the UI. The adapter does **not** run `validateSafeUrl` on it by default (trusted private hooks must keep working). If a Settings field lands, call `assertOutboundHttpUrl` before save. |
| `OUTBOUND_HTTP_TOKEN` | Optional Bearer for the HTTP hook |
| `OUTBOUND_HTTP_STRICT` | Optional. `1` fails loud at adapter resolve when `OUTBOUND_HTTP_URL` is localhost / metadata / RFC1918. Default **off**. |
| `OUTBOUND_FROM` | Optional From override for any provider |

```bash
# stub success (after login cookie)
curl -sS -b /tmp/pg-cookies -X POST http://127.0.0.1:8787/api/send \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 11111111-1111-4111-8111-111111111110' \
  -d '{"to":"neighbor@example.test","subject":"hello","text":"from local stub"}'

curl -sS -b /tmp/pg-cookies \
  'http://127.0.0.1:8787/api/messages/22222222-2222-4222-8222-222222222225/compose?mode=reply-all'

curl -sS -b /tmp/pg-cookies -X POST http://127.0.0.1:8787/api/send \
  -H 'content-type: application/json' \
  -d '{"to":"lead@grove.test","cc":"teammate@grove.test, notes@grove.test","subject":"Re: 本周同步","text":"ack","in_reply_to":"<seed-sync@example.test>","references":"<seed-sync-root@example.test> <seed-sync@example.test>"}'

curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/outbound/attempts
```

Open [http://127.0.0.1:8787/compose](http://127.0.0.1:8787/compose) while signed in to use the form. Recent attempts (including failures) stay on that page.

### Outbound URL safety

`src/safe-url.ts` is a default-deny helper for operator-supplied outbound URLs (inbound webhooks / forward, #11). Policy matches [open-site-health `internal/safeurl`](https://github.com/bugman666/open-site-health/tree/main/internal/safeurl): `http` / `https` only; block `localhost`, `*.localhost`, `localhost.localdomain`, and cloud metadata hostnames; block loopback, RFC1918, unspecified, link-local, multicast, CGNAT `100.64.0.0/10`, and `169.254.169.254`. Literal IPs in the hostname use the same ranges. Public `http` hosts are allowed; private hosts are the gate, not the scheme.

Inbound webhook / forward **save**, **fetch**, and **each redirect hop** call `validateSafeUrl`. Hostnames are re-checked after DNS (blocked if any A/AAAA is private) via `recheckResolvedIps` in `src/safe-url.ts`. The admin logo probe uses the same helper. Redirects are followed manually (`redirect: "manual"`); a hop to metadata / RFC1918 / localhost is recorded as a failed delivery (or rejected on logo save).

Default policy on this path: **https only**. `http://127.0.0.1` (and other private http) is allowed only when `ALLOW_PRIVATE_WEBHOOKS=1`. Public `http` is rejected at the webhook layer even though `validateSafeUrl` itself allows it. A bad config URL returns **400** with a clear hint (`blocked_destination` / `invalid_url`).

`OUTBOUND_HTTP_URL` is **not** an operator-supplied UI field. It is a deploy-time hook the operator already trusts. The `http` adapter does **not** run `validateSafeUrl` on it by default — blindly wrapping the env value would break trusted private hooks (RFC1918 / localhost sidecars). Do not expose it in Settings.

`assertOutboundHttpUrl(raw)` in `src/outbound.ts` is the save-time gate for a future Settings field. There is no UI path today; **call it before persist if one lands** (it wraps `validateSafeUrl`). Optional `OUTBOUND_HTTP_STRICT=1` uses the same helper at adapter resolve so an obvious SSRF env URL fails loud; leave it unset so current operator hooks keep working. See [docs/PRODUCTION_AUTH.md](docs/PRODUCTION_AUTH.md).

Workers `fetch` cannot install a custom dialer (no restricted `DialContext`). Residual DNS-rebinding risk remains if the resolver is skipped.

### Inbound webhooks / forward

When a message is stored, Postgrove can notify a webhook and/or relay to a chat-bot URL or external mailbox. Config is per mailbox.

| Surface | Auth | Role |
|---------|------|------|
| `GET`/`POST /api/hooks` | `requireOwner` | Read / save this mailbox's webhook + forward |
| `GET /api/hooks/attempts` | `requireOwner` | Delivery log for this mailbox |
| `GET`/`POST /admin/hooks` | `requireAdmin` | Same config for any `mailbox_id` |
| `GET /admin/deliveries` | `requireAdmin` | Delivery log (optional `mailbox_id`) |
| `GET`/`POST /settings` | `requireOwner` | Forest-token settings UI (not a cloud-mail clone) |

Unauthorized → **401**. A mailbox/owner session on admin hook routes → **403**.

**Signing algorithm (TC11.2).** POST body is JSON. Headers:

- `X-Postgrove-Timestamp`: unix seconds
- `X-Postgrove-Signature`: `v1=<hex>`
- `X-Postgrove-Event`: `inbound`

Signed string: `` `${timestamp}.${raw_json_body}` `` (UTF-8). MAC: **HMAC-SHA256**, hex digest. A missing or wrong `webhook_secret` must fail verification (constant-time hex compare). Suggested clock skew: ±5 minutes.

**Secret at rest.** D1 stores `webhook_secret` as `enc:v1:` (AES-GCM, key from `SESSION_SECRET`) so a DB dump is not the signing key. Mint and rotate still return the plaintext **once**; later `GET` only has `webhook_secret_set`. Delivery opens the envelope to sign. Leftover plaintext rows (pre-`0014_webhook_secret_envelope.sql`) are wrapped on the next read or save. After a `SESSION_SECRET` rotation, re-rotate hook secrets — old envelopes will not open. A one-way hash (like API tokens) cannot be used here because outbound signing still needs the plaintext.

Payload fields: `event`, `message_id`, `mailbox_id`, `from`, `to`, `subject`, `snippet`, `text`, `received_at`.

Optional **forward URL** POSTs `{ event: "inbound.forward", text, content, from, to, subject, snippet, message_id }` (chat bots that read `text` or `content`). Optional **forward email** uses the existing outbound adapter.

Downstream HTTP errors and SSRF rejects are stored in `inbound_deliveries` and shown on `/settings` and the 值守台. Fancy retries are out of scope.

```bash
# after owner login cookie
curl -sS -b /tmp/pg-cookies -X POST http://127.0.0.1:8787/api/hooks \
  -H 'content-type: application/json' \
  -d '{"webhook_enabled":true,"webhook_url":"https://hooks.example.test/inbound","webhook_secret":"replace-me-hook-secret"}'

curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/hooks
curl -sS -b /tmp/pg-cookies http://127.0.0.1:8787/api/hooks/attempts

# admin
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  'http://127.0.0.1:8787/admin/hooks?mailbox_id=11111111-1111-4111-8111-111111111111'
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  http://127.0.0.1:8787/admin/deliveries
```

Internal/metadata save is **400**:

```bash
curl -sS -b /tmp/pg-cookies -o /dev/stderr -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8787/api/hooks \
  -H 'content-type: application/json' \
  -d '{"webhook_enabled":true,"webhook_url":"http://169.254.169.254/latest/meta-data/"}'
```

### Auth (mailbox owner session + admin bearer)

Design: **owner = signed HttpOnly session cookie** after `POST /auth/login`. **Admin = `Authorization: Bearer <ADMIN_TOKEN>`**. Inbox HTML and JSON call `requireOwner` from `src/auth.ts`.

**Three roles (small-team, not an ACL matrix).**

| Role | How you sign in | What you can do |
|------|-----------------|-----------------|
| **Owner** | `POST /auth/login` with any active address + `OWNER_TOKEN` | Inbox for that address only. Break-glass deploy secret. |
| **Admin** | `Authorization: Bearer <ADMIN_TOKEN>`, `POST /admin/session`, or a `users.role=admin` member session | List/create/disable members, open addresses, read-only mail audit. Admin users skip per-user quotas (`0` = unlimited). |
| **Mailbox user** | `POST /auth/login` with a bound address + that member's token | Only mailboxes listed in `user_mailboxes`. Creating addresses / storing inbound / sending are quota-checked. |

**Shared `OWNER_TOKEN` vs member tokens.** `OWNER_TOKEN` is still one shared secret for every mailbox — not a per-address password. Treat it like a deploy / **break-glass** secret. **Production should prefer member tokens + admin** (`POST /admin/users`, admin-role member or `ADMIN_TOKEN`) for day-to-day login; keep `OWNER_TOKEN` for recovery, not shared operator sign-in. Members get their own token from `POST /admin/users` (returned once). A disabled member cannot keep using an old cookie (`user_disabled`). Operator runbook (rotate / revoke, outbound URL gate): [docs/PRODUCTION_AUTH.md](docs/PRODUCTION_AUTH.md).

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

**Login rate limit.** `POST /auth/login` allows **8 attempts per 10 minutes per IP** (`CF-Connecting-IP`, else the first `X-Forwarded-For` hop). Over the limit returns **429** with `Retry-After` and a hint such as “Too many login attempts from this network…”. When the `RATE_LIMIT` KV namespace is bound, login / REST / signup counters are **shared across isolates** (fixed-window get-then-put; a concurrent race can let a couple of extra requests through). Without the binding, counters stay in Worker memory **per isolate**. Create the namespace with `npx wrangler kv namespace create RATE_LIMIT` and put the id in `wrangler.jsonc`.

**Rotate / revoke.** Logout only deletes the cookie in that browser. Tokens are HMAC-signed and are not stored on the server, so they stay valid until expiry (7 days) if someone copied the cookie.

| Secret | Revoke |
|--------|--------|
| `SESSION_SECRET` | Put a new value and redeploy / restart Wrangler. Old cookies fail verify. Re-rotate inbound hook secrets (envelopes use this key). |
| `OWNER_TOKEN` | New value + redeploy. Does **not** drop cookies — rotate `SESSION_SECRET` too if the owner token leaked. Break-glass only in production. |
| `ADMIN_TOKEN` | Same as owner token. Rotate `SESSION_SECRET` if an admin cookie may have been copied. |
| Member token | Mint a replacement (`POST /admin/users` / 值守台). Disable the member to stop the next request; rotate `SESSION_SECRET` to drop an issued cookie. |
| REST `pg_…` | Mint a new hash row; delete the old one. |

Full table: [docs/PRODUCTION_AUTH.md](docs/PRODUCTION_AUTH.md).

**CSRF (cookie + SameSite=Lax + Origin check).** The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS. Cross-site form POSTs therefore do not send it on modern browsers. Cookie-authenticated writes (`POST /auth/logout`, inbox delete, `POST /compose`, `POST /api/send`, `DELETE /api/messages/…`, anything else that calls `requireOwner` with POST/PUT/PATCH/DELETE) also require `Origin` (or `Referer` if `Origin` is missing) to match this Worker. Same-origin HTML forms and `fetch` already send `Origin`, so the inbox and compose UI did not need a rewrite. Missing both headers is allowed for curl and scripts. That is enough for this MVP.

Still open later: a required custom header or double-submit token (so missing-`Origin` clients cannot be used as a CSRF hole), CSRF on GET side effects (mark-as-read), and an expiring admin bearer.

Admin JSON (reuse `requireAdmin` — bearer, admin cookie, or admin-role member):

```bash
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  http://127.0.0.1:8787/admin/ping
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  http://127.0.0.1:8787/admin/users
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  -X POST http://127.0.0.1:8787/admin/users \
  -H 'content-type: application/json' \
  -d '{"login":"ada","role":"mailbox","quota_addresses":3,"quota_storage_bytes":104857600,"quota_send_daily":50,"mailbox":"ada@example.test"}'
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  http://127.0.0.1:8787/admin/mailboxes
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  http://127.0.0.1:8787/admin/messages
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  http://127.0.0.1:8787/admin/stats
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  http://127.0.0.1:8787/admin/branding
```

Expect `"role": "admin"` on ping. When the `users` table can be counted, ping also includes `auth_mode` (`owner_break_glass` or `members`) — same hint as `/healthz`, non-breaking. A missing bearer/cookie returns **401**. A mailbox/owner session on `/admin/users` returns **403**. Admin bearer is not a cookie, so browser CSRF does not apply the same way; cookie admin writes still check Origin. A leaked `ADMIN_TOKEN` means rotate now.

Browser: [http://127.0.0.1:8787/admin](http://127.0.0.1:8787/admin) is the 值守台 (paper + forest, not an Element admin clone). Paste `ADMIN_TOKEN` or sign in as an admin-role member.

Member login (seeded `grove` on `empty@example.test`):

```bash
curl -i -c /tmp/pg-user -X POST http://127.0.0.1:8787/auth/login \
  -H 'content-type: application/json' \
  -d '{"address":"empty@example.test","token":"change-me-local-user-token"}'
curl -sS -b /tmp/pg-user -X POST http://127.0.0.1:8787/api/addresses \
  -H 'content-type: application/json' \
  -d '{"address":"notes@example.test"}'
```

Quota errors are loud: `quota_addresses` **409**, `quota_storage` **409** (inbound `setReject` uses the same hint), `quota_send` **429**. `0` on a quota column means unlimited.

### Open REST API (`/api/v1`) + abuse controls

Token API for automating address and mail ops. Cookie owner `/api/*` (inbox UI JSON) is unchanged and still uses `requireOwner`.

**Two key kinds.** A token hashed at rest (`SHA-256`) looks like `pg_…`. Only the hash is stored. The plaintext secret is shown **once** at mint time. Member sessions (`users` + `user_mailboxes`) are a separate cookie path; a `pg_` token does not impersonate a member role.

| Kind | How you get it | What it can do |
|------|----------------|----------------|
| **mailbox** (default) | Owner `POST /api/tokens`, token `POST /api/v1/tokens`, or admin mint with `kind=mailbox` | REST for **that** mailbox only. Cannot create addresses, cannot mint admin keys, cannot change another mailbox's aliases/keys. |
| **admin** | Env `ADMIN_TOKEN`, or `POST /admin/tokens` `{ "kind": "admin", "mailbox_id" }` | Same as today's admin bearer on `/api/v1` and `/admin/*`. May list/create aliases and mint/revoke keys across mailboxes. A mailbox `pg_` key cannot mint this kind (**403**). |

`mailbox_id` on an admin-kind `pg_` token is the mint home (the row still needs a mailbox). Authorization follows `kind`, not that home address.

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
  -d '{"mailbox_id":"11111111-1111-4111-8111-111111111111","label":"local-ci","kind":"mailbox","quota_requests_daily":10000,"quota_send_daily":50}'
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

Missing or invalid bearer → **401**. Using a mailbox token on another mailbox's messages, send, aliases, or keys → **403**. `POST /api/v1/mailboxes` with a mailbox `pg_` token is **403** (`forbidden`: create is admin-only). `GET /api/v1` is a public catalog (no secrets). Apply `npm run db:migrate:local` so `api_tokens` and `mailbox_aliases` exist (`0008` + `0013`).

**Aliases (`/api/v1/aliases`).** List/create plus-tag addresses for a mailbox you already own. Domain must match the mailbox primary (cross-domain → **400** `alias_domain_forbidden`). Owner session: `GET|POST /api/aliases`. Token: `GET|POST /api/v1/aliases` and `GET|POST /api/v1/mailboxes/:id/aliases`. Revoke: `POST /api/v1/aliases/:id/revoke` or `POST /api/aliases/:id/revoke`. Settings HTML can generate a `local+<8 hex>@domain` row (XSS-escaped). Cap: **50** aliases per mailbox.

```bash
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST http://127.0.0.1:8787/api/v1/aliases \
  -H 'content-type: application/json' \
  -d '{"generate":true}'
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  http://127.0.0.1:8787/api/v1/aliases
```

Token key admin (same mailbox, or any mailbox with an admin key):

```bash
curl -sS -H "Authorization: Bearer $PG_TOKEN" http://127.0.0.1:8787/api/v1/tokens
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST http://127.0.0.1:8787/api/v1/tokens \
  -H 'content-type: application/json' \
  -d '{"label":"ci","quota_requests_daily":1000}'
```

**Create addresses** is not a token REST capability. Admin: `POST /admin/mailboxes` with `ADMIN_TOKEN`. Owner session (cookie UI/API): `POST /api/mailboxes` `{ "address" }` (still one shared `OWNER_TOKEN` to log in as the new address). Public signup is a separate Turnstile-gated path when enabled.

**Public signup (Turnstile, off by default).** `POST /api/v1/public/signup` is **403** `public_signup_disabled` unless `TURNSTILE_SECRET_KEY` is set. When it is set, a Cloudflare Turnstile widget (site key `TURNSTILE_SITE_KEY`) must succeed: the Worker POSTs `secret` + `response` (+ optional `remoteip`) to `https://challenges.cloudflare.com/turnstile/v0/siteverify`. Missing or failed challenge → **403**. Success creates the mailbox and returns a one-time `pg_…` token.

```bash
# default (no TURNSTILE_SECRET_KEY): rejected
curl -sS -o /dev/stderr -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8787/api/v1/public/signup \
  -H 'content-type: application/json' \
  -d '{"address":"guest@example.test","turnstile_token":"xx"}'
```

**Rate and size limits** (documented defaults; shared KV when `RATE_LIMIT` is bound, otherwise in-memory per isolate):

| Surface | Default | Over limit |
|---------|---------|------------|
| `POST /auth/login` | 8 / 10 min / IP | **429** + `Retry-After` |
| `/api/v1/*` (after auth) | **60 / 60s** per token (or admin IP) | **429** `rate_limited` + `Retry-After` |
| Per-token daily REST requests | **0 = unlimited** (set `quota_requests_daily` at mint, or `REST_QUOTA_REQUESTS_DAILY` as the mint default) | **429** `quota_api` |
| Per-token daily REST sends | **0 = unlimited** (set `quota_send_daily` at mint, or `REST_QUOTA_SEND_DAILY` as the mint default) | **429** `quota_send` |
| `POST /api/v1/public/signup` | **5 / 10 min / IP** | **429** + `Retry-After` |
| JSON body (`REST_BODY_MAX_BYTES`) | **256000** bytes | **413** `payload_too_large` |
| Outbound `text` / `subject` | 256000 chars / 998 chars (`src/outbound.ts`) | **400** |
| Inbound attachments | 10 MiB / 10 files | inbound reject (see above) |
| Aliases per mailbox | **50** | **409** `alias_limit` |

Override REST knobs with `REST_RATE_LIMIT_MAX`, `REST_RATE_LIMIT_WINDOW_MS`, `SIGNUP_RATE_LIMIT_MAX`, `SIGNUP_RATE_LIMIT_WINDOW_MS`, `REST_BODY_MAX_BYTES`, `REST_QUOTA_REQUESTS_DAILY`, `REST_QUOTA_SEND_DAILY` in `.dev.vars` / Worker vars. Bind `RATE_LIMIT` (Workers KV) so login / REST / signup windows are shared across isolates; without it the Worker keeps the in-memory Map (local and tests). KV get-then-put is not atomic — a concurrent race can undershoot the count. Daily quotas live in D1 (`api_token_usage`) and reset at midnight UTC.

### Dev inbox API (own domain only)

Short-lived addresses for automated waits (CI, OTP, magic links) on **the domain you already host**. This is not a public temp-mail pool and does not talk to third-party disposable providers.

A mailbox-scoped `pg_…` token (or the admin bearer) can create an ephemeral inbox. That is separate from `POST /api/v1/mailboxes`, which stays **403** for tokens (permanent addresses remain admin/owner). The new address uses the token's mailbox domain — or `MAIL_DOMAIN` when set. Foreign domains are rejected (`own_domain_only`). Generated local parts look like `dev-<12 hex>@your.domain` and **do not** use `+tag` (aliases are a later surface).

```bash
export PG_TOKEN='pg_…'

# TC14.1 create — usable address on your domain
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST http://127.0.0.1:8787/api/v1/dev/inboxes \
  -H 'content-type: application/json' \
  -d '{"ttl_seconds":900}'
# → 201 { inbox: { id, address, status, expires_at, mailbox_id } }

# TC14.2 wait / long-poll until a match (timeout_ms default 8000, max 20000)
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST "http://127.0.0.1:8787/api/v1/dev/inboxes/$INBOX_ID/wait" \
  -H 'content-type: application/json' \
  -d '{"timeout_ms":8000,"contains":"482193"}'
# match → 200 { message }; no match → 408 wait_timeout 「等待超时：时限内未收到匹配邮件。」

# GET is the same: /wait?timeout_ms=8000&subject=&from=&contains=&since=

# TC14.3 extract OTP or link (fail loud)
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST "http://127.0.0.1:8787/api/v1/dev/inboxes/$INBOX_ID/extract" \
  -H 'content-type: application/json' \
  -d '{"kind":"otp"}'
# or {"kind":"link"} / {"kind":"otp","pattern":"token=([A-Z0-9-]+)","message_id":"…"}

# TC14.4 close (idempotent). Repeat close → 200 already_closed
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST "http://127.0.0.1:8787/api/v1/dev/inboxes/$INBOX_ID/close"
```

Missing or invalid bearer → **401**. Using another mailbox's token on someone else's inbox → **403** 「无权限：不能操作其他租户的开发收件箱。」. Too many open inboxes → **409** `quota_dev_inboxes` 「配额已满：…」. Closed / expired wait → **409**. Apply `0012_dev_inboxes.sql`.

**Wait.** Polls D1 until a message matches `since` (epoch ms, exclusive), `subject`, `from`, or `contains` (case-insensitive, subject + snippet + body). Default `timeout_ms` is 8000; hard cap `DEV_WAIT_MAX_MS` (default 20000) so the Worker never hangs. `timeout_ms=0` is a single check. Optional `extract` (`otp` / `link`) runs the helper after a match (422 if extract fails).

**Extract rules** (documented; no guessing):

| kind | Rule order | Fail loud |
|------|------------|-----------|
| `otp` | 1. Labeled `验证码` / `code` / `OTP` / `verification code` + 4–8 alphanumeric. 2. Else a single standalone 4–8 digit run (years `19xx`/`20xx` ignored). | No match → `extract_failed`. Several different values → `extract_ambiguous`. |
| `link` | 1. Labeled verify/confirm/点击/验证 + `https://`. 2. Else first `https://` in the text. Optional `host` filter. | No https → `extract_failed` (plain `http://` is not accepted). |
| either | `pattern` — JS regex, first capture or full match, max 200 chars. | Invalid regex → `invalid_pattern`. |

**Close / expire.** `POST …/close` disables the mailbox (inbound `setReject`) and sets status `closed`. Calling close again returns `already_closed: true`. TTL default 15 minutes (`DEV_INBOX_TTL_SECONDS`), max 60 minutes. Lazy expire on read/wait/inbound sets `expired` and disables the address.

**Knobs.** `MAIL_DOMAIN`, `DEV_INBOX_QUOTA` (default 8 open per token mailbox; `0` = unlimited), `DEV_INBOX_TTL_SECONDS`, `DEV_INBOX_TTL_MAX_SECONDS`, `DEV_WAIT_MAX_MS`.

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

Create the address first, then receive. The stub rejects unknown and disabled recipients (no catch-all, no anonymous boxes).

**Plus-tag / RFC 5233 subaddressing.** Mail to `inbox+promo@example.test` is delivered to the `inbox@example.test` mailbox. `envelope_to` keeps the original recipient (with `+tag`) so inbox search can find the tag. Explicit aliases (Settings or `POST /api/v1/aliases`) must use that mailbox's own domain.

```bash
curl --request POST 'http://127.0.0.1:8787/cdn-cgi/local/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=inbox+promo@example.test' \
  --data-raw 'From: sender@example.com
To: inbox+promo@example.test
Subject: plus-tag local stub
Date: Sat, 19 Sep 2026 12:00:00 +0000
Message-ID: <local-plus-1@example.test>
Content-Type: text/plain; charset=utf-8

Search for promo to find this row.
'
```

After `npm run db:seed:local`, `inbox@example.test` is available. Check Wrangler logs for `inbound stub: stored`. Inspect rows with:

```bash
npx wrangler d1 execute postgrove --local --command \
  "SELECT address FROM mailboxes; SELECT subject, envelope_from, envelope_to, folder, is_read FROM messages;"
```

## Remote placeholders

`wrangler.jsonc` ships with dummy D1 / KV ids. Replace them after creating a real D1 database and `RATE_LIMIT` namespace. Do not commit account tokens, API keys, or filled `.dev.vars`.

```bash
npx wrangler login
npx wrangler d1 create postgrove
# paste the printed database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler r2 bucket create postgrove-attachments
# confirm wrangler.jsonc r2_buckets.bucket_name matches
npx wrangler kv namespace create RATE_LIMIT
# paste the printed id into wrangler.jsonc kv_namespaces (binding RATE_LIMIT)
# optional preview namespace: npx wrangler kv namespace create RATE_LIMIT --preview
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OWNER_TOKEN   # break-glass only; prefer POST /admin/users
npx wrangler secret put ADMIN_TOKEN
# then create mailbox members — see docs/PRODUCTION_AUTH.md
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
| `src/auth.ts` | Owner session + member session + admin bearer/cookie; `requireOwner` / `requireAdmin` |
| `src/rest.ts` | Token REST `/api/v1` + aliases + public signup + admin mint + `/api/v1/dev/inboxes` |
| `src/dev-inbox.ts` | Ephemeral own-domain inbox create / wait / close |
| `src/extract.ts` | OTP / link extract helpers (documented rules, fail loud) |
| `src/api-tokens.ts` | Opaque `pg_…` tokens (hash at rest; mailbox or admin kind) |
| `src/aliases.ts` | +tag resolve, own-domain alias create/list, Settings panel HTML |
| `src/turnstile.ts` | Cloudflare siteverify (public signup only when configured) |
| `src/rate-limit.ts` | Shared KV (or in-memory fallback) limiter for login / token API / signup |
| `src/users.ts` | Members, token hash, mailbox bindings |
| `src/quotas.ts` | Address / storage / daily-send / per-token API checks (`0` = unlimited) |
| `src/admin.ts` | `/admin` 值守台 + JSON users / mailboxes / audit / inbound deliveries / stats / branding |
| `src/analytics.ts` | Light overview counts (users, today's mail, attachment MB) |
| `src/i18n.ts` | en / zh copy; `Accept-Language` + settings cookie |
| `src/branding.ts` | Site title / logo URL / accent; `validateSafeUrl` + shared DNS IP re-check on logo save and fetch |
| `src/view.ts` | Shared shell (locale + branding) for HTML |
| `src/health.ts` | `GET /healthz` |
| `src/inbound.ts` | Email Routing stub persist + +tag / alias resolve + attachment limits |
| `src/attachment-limits.ts` | Size / count caps and human-readable over-limit errors |
| `src/attachments.ts` | R2 store / owner download / read-view links |
| `src/mime.ts` | Plain-text body extract + inbound MIME attachments |
| `src/api.ts` | JSON list / read / delete / send / search / star / threads / aliases |
| `src/ui.ts` | Inbox HTML + compose / reply / forward form |
| `src/reply.ts` | Reply / reply-all / forward prefill + header helpers |
| `src/threads.ts` | Inbox thread grouping (citation, then subject fallback) |
| `src/triage.ts` | Search FTS5 / LIKE helpers + unread / star filters |
| `src/outbound.ts` | Pluggable outbound adapters (`stub` / `resend` / `http`); `assertOutboundHttpUrl` for a future Settings save |
| `src/safe-url.ts` | SSRF guard + shared `recheckResolvedIps` (webhooks / forward / logo) |
| `docs/PRODUCTION_AUTH.md` | Production: member+admin default; `OWNER_TOKEN` break-glass; rotate/revoke; outbound URL gate |
| `src/webhooks.ts` | Inbound signed webhook + forward; secret enveloped at rest; `validateSafeUrl` on save/fetch/redirect |
| `src/send.ts` | Outbox send: pending + idempotency key, then provider + Sent row |
| `migrations/0001_init.sql` | D1 `mailboxes` + `messages` |
| `migrations/0002_message_body.sql` | `messages.body_text` |
| `migrations/0003_outbound_attempts.sql` | D1 `outbound_attempts` |
| `migrations/0004_attachments.sql` | D1 `attachments` metadata (bytes in R2) |
| `migrations/0005_reply_headers.sql` | Inbound To/Cc/Reply-To/References + outbound attempt headers |
| `migrations/0006_message_star.sql` | `messages.is_starred` + unread / star indexes |
| `migrations/0007_mailbox_folders.sql` | Folder / draft indexes (P1) |
| `migrations/0008_api_tokens.sql` | Mailbox-scoped API tokens (hash at rest) |
| `migrations/0009_users_rbac_quotas.sql` | `users`, `user_mailboxes`, `send_usage` |
| `migrations/0010_inbound_hooks.sql` | `inbound_hooks` + `inbound_deliveries` |
| `migrations/0011_site_settings.sql` | Site title / logo / accent |
| `migrations/0012_dev_inboxes.sql` | Ephemeral developer inboxes (own domain; not +tag aliases) |
| `migrations/0013_aliases_api_key_quotas.sql` | `mailbox_aliases` + token kind/quotas + `api_token_usage` |
| `migrations/0014_webhook_secret_envelope.sql` | `webhook_secret` envelope-at-rest contract (lazy upgrade of leftover plaintext) |
| `migrations/0015_outbound_outbox.sql` | `outbound_attempts` pending + idempotency_key + retry columns |
| `migrations/0016_messages_fts.sql` | `messages_fts` FTS5 index + sync triggers + backfill |
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
