# Deploy Postgrove

One-path checklist for a Worker on a domain you control. Educational / self-host use — you are responsible for the domain, deliverability, and abuse controls. See the README disclaimer.

Do **not** commit secrets, filled `.dev.vars`, or live D1 / KV ids that belong to a private account. `.dev.vars` is gitignored; `wrangler.jsonc` ships dummy ids.

## 1. Prerequisites

- [ ] Cloudflare account that can run Workers, D1, R2, KV, and Email Routing
- [ ] A domain you control, added to that account (DNS on Cloudflare)
- [ ] Node.js 22+
- [ ] Wrangler (`npx wrangler` from this repo is enough)
- [ ] Long random values for secrets (for example `openssl rand -hex 32`)

If `wrangler login` fails, check the account can create Workers, then retry.

## 2. Bootstrap

Names below match `wrangler.jsonc` and `.dev.vars.example`.

| Binding / name | Kind | What it is |
|----------------|------|------------|
| `DB` | D1 | `database_name`: `postgrove`. Replace dummy `database_id`. Local preview: `postgrove-local` |
| `ATTACHMENTS` | R2 | `bucket_name`: `postgrove-attachments`. Local preview: `postgrove-attachments-local` |
| `RATE_LIMIT` | KV | Shared login / REST / signup counters. Replace dummy `id`. Local preview: `postgrove-rate-limit-local` |
| `SESSION_SECRET` | secret | HMAC for session cookies (min 16 characters). Rotate to revoke every cookie |
| `OWNER_TOKEN` | secret | Break-glass login for any active address (min 8). Not a per-address password |
| `ADMIN_TOKEN` | secret | Bearer for `/admin/*` (min 8) |
| `OUTBOUND_PROVIDER` | var | `stub` · `resend` · `http`. Unset → send fails loud |
| `RESEND_API_KEY` | secret | Required when `OUTBOUND_PROVIDER=resend` |
| `RESEND_FROM` | var | Optional From override (verified Resend domain) |
| `OUTBOUND_HTTP_URL` | secret | Required when `OUTBOUND_PROVIDER=http`. Operator-trusted only |
| `OUTBOUND_HTTP_TOKEN` | secret | Optional Bearer for that hook |
| `OUTBOUND_HTTP_STRICT` | var | `1` rejects localhost / RFC1918 hook URLs. Default off |
| `OUTBOUND_FROM` | var | Optional From override (wins over `RESEND_FROM`) |
| `TURNSTILE_SECRET_KEY` | secret | Enables `POST /api/v1/public/signup` |
| `TURNSTILE_SITE_KEY` | secret / var | Widget site key (pair with the secret) |
| `MAIL_DOMAIN` | var | Own domain for ephemeral `/api/v1/dev/inboxes` |
| `ATTACHMENT_MAX_BYTES` | var | Default `10485760` (already in `wrangler.jsonc` `vars`) |
| `ATTACHMENT_MAX_COUNT` | var | Default `10` |

Optional REST / signup / dev-inbox knobs (same names as `.dev.vars.example`): `REST_RATE_LIMIT_MAX`, `REST_RATE_LIMIT_WINDOW_MS`, `REST_BODY_MAX_BYTES`, `REST_QUOTA_REQUESTS_DAILY`, `REST_QUOTA_SEND_DAILY`, `SIGNUP_RATE_LIMIT_MAX`, `SIGNUP_RATE_LIMIT_WINDOW_MS`, `DEV_INBOX_QUOTA`, `DEV_INBOX_TTL_SECONDS`, `DEV_INBOX_TTL_MAX_SECONDS`, `DEV_WAIT_MAX_MS`, `ALLOW_PRIVATE_WEBHOOKS`.

```bash
npx wrangler login

npx wrangler d1 create postgrove
# paste the printed database_id into wrangler.jsonc → d1_databases[0].database_id

npm run db:migrate:remote

npx wrangler r2 bucket create postgrove-attachments
# confirm wrangler.jsonc r2_buckets[0].bucket_name is postgrove-attachments

npx wrangler kv namespace create RATE_LIMIT
# paste the printed id into wrangler.jsonc → kv_namespaces[0].id
# optional: npx wrangler kv namespace create RATE_LIMIT --preview
#           paste preview_id (binding stays RATE_LIMIT)

npx wrangler secret put SESSION_SECRET
npx wrangler secret put OWNER_TOKEN    # break-glass only
npx wrangler secret put ADMIN_TOKEN

# optional public signup (off until both are set):
# npx wrangler secret put TURNSTILE_SECRET_KEY
# npx wrangler secret put TURNSTILE_SITE_KEY

# when sending for real:
# npx wrangler secret put RESEND_API_KEY
# or: npx wrangler secret put OUTBOUND_HTTP_URL
#     npx wrangler secret put OUTBOUND_HTTP_TOKEN

npx wrangler deploy
```

Set `OUTBOUND_PROVIDER` (and `MAIL_DOMAIN`, attachment caps) as Worker vars — `wrangler.jsonc` `vars` or the dashboard. Do not put live secrets in `wrangler.jsonc`.

If deploy fails, check: dummy `database_id` / `RATE_LIMIT` `id` still `00000000-…`; R2 `bucket_name` mismatch; secret names spelled exactly as the table; Node 22+.

If `/healthz` returns **503** `migrations_pending`, run `npm run db:migrate:remote` and retry. Health expects `mailboxes`, `messages`, `outbound_attempts`, `api_tokens`, `users`, `inbound_hooks`, `inbound_deliveries`, `dev_inboxes`, and `mailbox_aliases`.

## 3. Email Routing checklist

Inbound is the Worker `email` handler (`src/index.ts` → `src/inbound.ts`). Cloudflare calls it; there is no public HTTP inbound URL.

- [ ] Domain is on this Cloudflare account and Email Routing is **enabled**
- [ ] MX points at Cloudflare Email Routing (dashboard shows the current hosts)
- [ ] SPF includes Cloudflare's Email Routing include (dashboard copy)
- [ ] A routing rule sends mail to the **`postgrove`** Worker:
  - catch-all → Send to Worker → `postgrove`, or
  - one custom address (`support@YOUR_DOMAIN`) → same Worker
- [ ] The address already exists in Postgrove (`POST /admin/mailboxes` or the owner UI). Unknown recipients are rejected (`unknown mailbox`) — there is no catch-all store
- [ ] Plus-tag works without an extra rule: `user+tag@YOUR_DOMAIN` lands in `user@YOUR_DOMAIN` (`envelope_to` keeps the tag)

**Mail not arriving — check in order**

1. `GET https://YOUR_DOMAIN/healthz` is **200** `"db": "ready"`. If not, migrations / D1 binding.
2. Cloudflare Email Routing overview: domain verified, MX green.
3. The rule target is this Worker name (`postgrove` in `wrangler.jsonc`), not another Worker.
4. The recipient exists and `status` is `active`. Disabled / closed / expired dev inboxes `setReject` (`mailbox disabled` / `mailbox expired`).
5. Attachment over `ATTACHMENT_MAX_BYTES` / `ATTACHMENT_MAX_COUNT` is rejected with a human-readable cap. Storage quota (`quota_storage`) also rejects inbound.
6. Worker logs: look for `inbound stub: stored` vs `unknown mailbox` / `mailbox disabled` / `attachment rejected`.
7. Local substitute: `wrangler dev` + `POST /cdn-cgi/local/email` (see README inbound stub).

If MX is correct but the Worker never logs the message, the rule is not hitting this Worker. If the Worker logs `unknown mailbox`, create the address first.

## 4. Outbound

| `OUTBOUND_PROVIDER` | Required secrets / vars | What happens |
|---------------------|-------------------------|--------------|
| `stub` | none | Records the attempt in D1. Does not leave the box. Fine for a first deploy smoke |
| `resend` | `RESEND_API_KEY`; optional `RESEND_FROM` / `OUTBOUND_FROM` | Real send. From domain must be verified in Resend |
| `http` | `OUTBOUND_HTTP_URL`; optional `OUTBOUND_HTTP_TOKEN` | POST JSON `{from,to,subject,text}` (optional `cc`, headers). Operator-trusted env only — not a Settings field |
| unset / typo | — | Send fails loud: `outbound_not_configured` or `unknown_provider` **503**. Row stored as `failed` |

Optional `OUTBOUND_HTTP_STRICT=1` rejects localhost / metadata / RFC1918 hook URLs at adapter resolve. Leave it unset so a trusted private hook keeps working.

If send fails, check: `OUTBOUND_PROVIDER` spelling; `RESEND_API_KEY` / `OUTBOUND_HTTP_URL` present; Resend domain verified; attempt row on `/compose` or `GET /api/outbound/attempts` (owner session). Replay the same `Idempotency-Key` to finish a leftover `pending` row (no cron drain yet).

## 5. Auth reminder

Read [docs/PRODUCTION_AUTH.md](PRODUCTION_AUTH.md) before you leave a public hostname on the shared owner token.

Day-to-day login should be **member tokens + admin** (`POST /admin/users`, then `POST /auth/login` with that member token). `OWNER_TOKEN` stays break-glass: one string opens **any** active address.

After deploy, create at least one mailbox member. `GET /healthz` and `GET /admin/ping` include `auth_mode`: `"owner_break_glass"` means the `users` table is empty; `"members"` means at least one row exists.

If login fails, check: secret names (`SESSION_SECRET` ≥ 16 chars, `OWNER_TOKEN` / `ADMIN_TOKEN` ≥ 8); you are not reusing `.dev.vars.example` placeholders on a public host; `auth_mode` on `/healthz`.

## 6. Optional demo deploy

A public demo is fine for education. Do **not** commit demo secrets, and do not treat a public demo as a temp-mail service.

- [ ] Use a domain you control. Keep own-domain framing in any demo copy
- [ ] Put secrets with `wrangler secret put` only. Dummy ids in git stay dummy
- [ ] Prefer `OUTBOUND_PROVIDER=stub` unless you have verified outbound and accept bounce / abuse risk
- [ ] Leave public signup **off** (`TURNSTILE_SECRET_KEY` unset) unless you want Turnstile-gated creates
- [ ] Create member tokens; do not paste `OWNER_TOKEN` into a public README
- [ ] You are responsible for abuse: rate limits (`RATE_LIMIT` KV), quotas, and Email Routing destination rules

If the demo starts receiving unsolicited mail, tighten the routing rule (named addresses instead of catch-all) and rotate `OWNER_TOKEN` / `ADMIN_TOKEN` / `SESSION_SECRET`.

## 7. Smoke

After `npx wrangler deploy`:

- [ ] `curl -sS https://YOUR_DOMAIN/healthz` → `"ok": true`, `"db": "ready"`. Note `auth_mode`
- [ ] `curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" https://YOUR_DOMAIN/admin/ping` → `"role": "admin"`
- [ ] Create an address (`POST /admin/mailboxes`) or log in to the web inbox
- [ ] Prefer `POST /admin/users` then login with the member token ([PRODUCTION_AUTH.md](PRODUCTION_AUTH.md))
- [ ] Send a real inbound message to that address. It should appear in `/` or `GET /api/v1/mailboxes/:id/messages`
- [ ] Open the row. If it has an attachment, download it while signed in (`GET /attachments/:id`). Unauthenticated download is **401**
- [ ] Optional: compose with `OUTBOUND_PROVIDER=stub` and confirm a sent row

If health is 200 but login is 401, the secrets on this Worker are not the values you used in curl. If inbound never shows, go back to the Email Routing checklist.
