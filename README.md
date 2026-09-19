# Postgrove

Personal and small-team **edge mailbox** on Cloudflare Workers.

Open addresses on a domain you own, receive mail at the edge, read it in a later web inbox, and keep attachments in R2. Built for self-hosters who do not want to run a full mail server.

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
- Inbox chrome and visual tokens (separate issue; this repo’s Worker has no UI yet)

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

See Issues under milestones `P0-MVP` … `P3-dev-api`.

## Status

Worker scaffold only: health endpoint, D1 schema, Email Routing stub. No inbox UI in this step.

## Local development

Requires Node.js 18.17+ (20+ recommended). No Cloudflare account is needed for the local path.

```bash
npm install
cp .dev.vars.example .dev.vars   # optional; no secrets required for this scaffold
npm run db:migrate:local
npm run db:seed:local            # sample mailbox inbox@example.test
npm run dev
```

`wrangler dev` serves the Worker at `http://127.0.0.1:8787` by default.

### Health

```bash
curl -sS http://127.0.0.1:8787/healthz
```

Expect JSON with `"ok": true` and `"db": "ready"` after migrations. A `503` with `"migrations_pending"` means the local D1 schema has not been applied.

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
  "SELECT address FROM mailboxes; SELECT subject, envelope_from, snippet FROM messages;"
```

## Remote placeholders

`wrangler.jsonc` ships with a dummy `database_id`. Replace it after creating a real D1 database. Do not commit account tokens, API keys, or filled `.dev.vars`.

```bash
npx wrangler login
npx wrangler d1 create postgrove
# paste the printed database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler deploy
```

Then, in the Cloudflare dashboard, enable Email Routing for your domain and add a rule that sends matching addresses to the `postgrove` Worker.

## Layout

| Path | Role |
|------|------|
| `src/index.ts` | Worker `fetch` + `email` handlers |
| `src/health.ts` | `GET /healthz` |
| `src/inbound.ts` | Email Routing stub persist |
| `migrations/0001_init.sql` | D1 `mailboxes` + `messages` |
| `scripts/seed-local.sql` | Local sample mailbox (not for remote) |
| `wrangler.jsonc` | Worker + D1 bindings (placeholders) |
| `.dev.vars.example` | Local secret template |

## License

MIT. See `LICENSE`.

## Contributing

Open an Issue before large features. Keep tone practical; this is a real project, not a form submission.
