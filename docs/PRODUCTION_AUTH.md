# Production auth and outbound HTTP (operator runbook)

Safer defaults for a real hostname. Local `.dev.vars` placeholders stay fine for `wrangler dev`.

This is the runbook for [issue #52](https://github.com/bugman666/postgrove/issues/52) (audit P1-1). It does **not** add a shared KV / Durable Object rate limiter — that is [#51](https://github.com/bugman666/postgrove/issues/51).

## Prefer member tokens + admin

Day-to-day login on a public Worker should be:

1. **Mailbox members** — `POST /admin/users` (admin-role member or `ADMIN_TOKEN`) mints a per-person token, shown **once**. That person signs in with a bound address + their token.
2. **Admin** — `Authorization: Bearer <ADMIN_TOKEN>`, `POST /admin/session`, or a `users.role=admin` member session.

`OWNER_TOKEN` is a **break-glass deploy secret**. It is one shared string that opens **any** active mailbox. Use it for recovery (lost member token, empty `users` table, first box), not as the shared operator password.

Smoke hint (non-breaking): `GET /healthz` and `GET /admin/ping` include `auth_mode`. `"owner_break_glass"` means the `users` table has no rows — day-to-day login is still the shared owner token. `"members"` means at least one users-table row exists. The field is omitted if the count cannot run (keep health 200/503 as today).

```bash
# create a mailbox member (token returned once)
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  -X POST https://your-worker.example/admin/users \
  -H 'content-type: application/json' \
  -d '{"login":"ada","role":"mailbox","mailbox":"ada@your-domain"}'

# day-to-day login — member token, not OWNER_TOKEN
curl -i -c /tmp/pg-user -X POST https://your-worker.example/auth/login \
  -H 'content-type: application/json' \
  -d '{"address":"ada@your-domain","token":"<member-token-shown-once>"}'
```

Local seed still documents `OWNER_TOKEN=change-me-local-owner-token` so the first inbox opens. Do not reuse that string remotely.

## Rotate and revoke

Sessions are **stateless HMAC** cookies (`postgrove_session` / `postgrove_admin`). Logout only clears that browser. A copied cookie stays valid until expiry (7 days) or secret rotation.

| Secret | What it unlocks | How to rotate / revoke |
|--------|-----------------|------------------------|
| `SESSION_SECRET` | All owner + admin **cookies**, and webhook secret envelopes | `npx wrangler secret put SESSION_SECRET` then redeploy. Old cookies fail verify. Re-rotate inbound hook secrets (envelopes will not open). |
| `OWNER_TOKEN` | Break-glass login as any active address | Put a new value, redeploy. Does **not** drop existing cookies — rotate `SESSION_SECRET` as well if the owner token leaked. |
| `ADMIN_TOKEN` | Bearer `/admin/*` and `POST /admin/session` | Same as owner token: new secret + redeploy. Rotate `SESSION_SECRET` if an admin cookie may have been copied. |
| Member token | One `users` row (hash at rest) | Create a replacement via `POST /admin/users` (or rotate that user's token on the 值守台). Disable the member (`user_disabled`) to kill their next request; rotate `SESSION_SECRET` to drop an already-issued cookie. |
| REST `pg_…` token | `/api/v1` | Mint a new token; revoke / delete the old hash row. Daily quotas are a separate surface. |

Minimum lengths: `SESSION_SECRET` 16 characters; `OWNER_TOKEN` / `ADMIN_TOKEN` 8. Use long random values in production (`openssl rand -hex 32`).

Login / REST / signup counters share a window when the `RATE_LIMIT` KV namespace is bound (`wrangler.jsonc`). Without the binding, counters stay **per isolate** (local / tests). See [docs/DEPLOY.md](DEPLOY.md).

## Outbound HTTP URL — operator-trusted env only

`OUTBOUND_HTTP_URL` is a **deploy-time hook**. Set it in `.dev.vars` or `npx wrangler secret put OUTBOUND_HTTP_URL`. The `http` adapter does **not** run `validateSafeUrl` on it by default. Trusted private hooks (RFC1918, localhost sidecars) must keep working.

Do **not** accept this URL from Settings / the UI. There is no save path today.

If a Settings field lands, call `assertOutboundHttpUrl(raw)` **before persist** (same default-deny policy as inbound webhook / forward / logo: `src/safe-url.ts` `validateSafeUrl`). Then re-check at fetch / redirect hops the same way as webhooks.

Optional hard gate on the **env** value (default **off**):

```
OUTBOUND_HTTP_STRICT=1
```

When set, `resolveOutboundAdapter` fails loud if `OUTBOUND_HTTP_URL` points at localhost, `*.localhost`, metadata hostnames, or literal loopback / RFC1918 / link-local / multicast / CGNAT / unspecified addresses. Unset it (or `0`) to keep a trusted private hook.

`OUTBOUND_HTTP_TOKEN` is optional Bearer for that hook. Rotate it at the hook and in Wrangler together.
