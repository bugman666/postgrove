# Postgrove REST API

Token REST for an **own-domain** edge mailbox. This is not a public temp-mail pool and does not talk to third-party disposable providers.

Machine-readable contract: [`docs/openapi.yaml`](openapi.yaml). Plain-text route index: [`docs/llms.txt`](llms.txt). Cookie inbox JSON (`/api/*`) stays on an owner session and is not listed here.

## Auth

Send `Authorization: Bearer pg_…` (mailbox or admin kind) or the deploy `ADMIN_TOKEN`.

| Kind | How you get it | What it can do |
|------|----------------|----------------|
| **mailbox** | Owner `POST /api/tokens`, token `POST /api/v1/tokens`, or admin mint with `kind=mailbox` | REST for **that** mailbox only. Cannot create addresses or mint admin keys. |
| **admin** | Env `ADMIN_TOKEN`, or `POST /admin/tokens` `{ "kind": "admin", "mailbox_id" }` | Cross-mailbox list/create/aliases/keys on `/api/v1` and `/admin/*`. |

The plaintext secret is shown **once**. Later `GET` only has `prefix` + label. Missing or invalid bearer → **401**. Using a mailbox token on another mailbox → **403**.

Mint (owner session, after `POST /auth/login`):

```bash
curl -sS -b /tmp/pg-cookies -X POST http://127.0.0.1:8787/api/tokens \
  -H 'content-type: application/json' \
  -d '{"label":"local-ci"}'
```

Or admin:

```bash
curl -sS -X POST http://127.0.0.1:8787/admin/tokens \
  -H 'Authorization: Bearer change-me-local-admin-token' \
  -H 'content-type: application/json' \
  -d '{"mailbox_id":"11111111-1111-4111-8111-111111111111","label":"local-ci","kind":"mailbox"}'
```

## Examples

Replace `PG_TOKEN` with the minted secret (`pg_…`). Local Worker is `http://127.0.0.1:8787`; remotely use `https://mail.example.com`.

### 1. Catalog (no bearer)

```bash
curl -sS http://127.0.0.1:8787/api/v1
```

Expect `"ok": true`, `"service": "postgrove"`.

### 2. List mailboxes and read mail

```bash
export PG_TOKEN='pg_…'

curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  http://127.0.0.1:8787/api/v1/mailboxes

curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  'http://127.0.0.1:8787/api/v1/mailboxes/11111111-1111-4111-8111-111111111111/messages?folder=inbox'

curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  http://127.0.0.1:8787/api/v1/messages/22222222-2222-4222-8222-222222222223
```

Token REST cannot create addresses (**403**). Admin creates them:

```bash
curl -sS -H 'Authorization: Bearer change-me-local-admin-token' \
  -X POST http://127.0.0.1:8787/admin/mailboxes \
  -H 'content-type: application/json' \
  -d '{"address":"support@example.test","display_name":"Support"}'
```

Opening an unread inbox row marks it read. There is **no** `DELETE` under `/api/v1`.

### 3. Send

```bash
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST http://127.0.0.1:8787/api/v1/send \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: send-hello-1' \
  -d '{"to":"neighbor@example.test","subject":"hello","text":"from token REST"}'
```

Unset / incomplete `OUTBOUND_PROVIDER` fails loud (`outbound_not_configured` **503**). Provider reject → **502**. Daily send cap → **429** `quota_send`. Replay the same `Idempotency-Key` (or JSON `idempotency_key`) to resume the stored attempt.

### 4. Plus-tag aliases (own domain)

Mail to `user+tag@YOUR_DOMAIN` lands in `user@YOUR_DOMAIN`. Explicit aliases must use that mailbox's domain (cross-domain → **400** `alias_domain_forbidden`). Cap: 50 per mailbox.

```bash
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST http://127.0.0.1:8787/api/v1/aliases \
  -H 'content-type: application/json' \
  -d '{"generate":true}'

curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  http://127.0.0.1:8787/api/v1/aliases
```

### 5. Dev inbox — create, wait, extract, close

Short-lived address on **this deployment's domain**. Foreign domains → **400** `own_domain_only`. Generated local parts look like `dev-<12 hex>@YOUR_DOMAIN` and do not use `+tag`.

```bash
# create
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST http://127.0.0.1:8787/api/v1/dev/inboxes \
  -H 'content-type: application/json' \
  -d '{"ttl_seconds":900}'
# → 201 { inbox: { id, address, status, expires_at, mailbox_id } }

# wait (default 8000 ms, cap 20000)
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST "http://127.0.0.1:8787/api/v1/dev/inboxes/$INBOX_ID/wait" \
  -H 'content-type: application/json' \
  -d '{"timeout_ms":8000,"contains":"482193"}'
# match → 200 { message }; no match → 408 wait_timeout

# extract OTP or https link
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST "http://127.0.0.1:8787/api/v1/dev/inboxes/$INBOX_ID/extract" \
  -H 'content-type: application/json' \
  -d '{"kind":"otp"}'

# close (idempotent)
curl -sS -H "Authorization: Bearer $PG_TOKEN" \
  -X POST "http://127.0.0.1:8787/api/v1/dev/inboxes/$INBOX_ID/close"
```

Too many open inboxes → **409** `quota_dev_inboxes`. Another mailbox's token on this inbox → **403**.

## Errors (loud)

Every failure JSON is `{ "ok": false, "error": "…", "hint": "…" }`. Do the next step in `hint`.

| `error` | HTTP | When |
|---------|------|------|
| `unauthorized` | 401 | Missing / invalid / revoked bearer |
| `forbidden` | 403 | Wrong mailbox, mailbox token creating addresses, mailbox token minting admin keys |
| `not_found` | 404 | Unknown mailbox, message, token, alias, or inbox |
| `invalid_request` | 400 | Bad or missing JSON |
| `rate_limited` | 429 | 60 requests / 60s per token (or admin IP). `Retry-After` set |
| `quota_api` | 429 | Daily REST request cap (`quota_requests_daily`; `0` = unlimited) |
| `quota_send` | 429 | Daily REST send cap (`quota_send_daily`; `0` = unlimited) |
| `quota_dev_inboxes` | 409 | Open ephemeral inboxes at `DEV_INBOX_QUOTA` (default 8) |
| `payload_too_large` | 413 | JSON over `REST_BODY_MAX_BYTES` (default 256000) |
| `public_signup_disabled` | 403 | `TURNSTILE_SECRET_KEY` unset |
| `own_domain_only` | 400 | Dev inbox asked for a foreign domain |
| `wait_timeout` | 408 | No matching mail before `timeout_ms` |
| `inbox_closed` / `inbox_expired` | 409 | Dev inbox no longer receives |
| `extract_failed` / `extract_ambiguous` | 422 | OTP / link helper could not pick one value |
| `outbound_not_configured` | 503 | `OUTBOUND_PROVIDER` unset or incomplete |
| `outbound_failed` | 502 | Provider rejected the send |
| `token_lookup_failed` | 503 | D1 `api_tokens` missing — apply migrations |

Public signup (`POST /api/v1/public/signup`) stays off until Turnstile is configured. See [README](../README.md) for cookie `/api/*` and [DEPLOY.md](DEPLOY.md) for a remote Worker.
