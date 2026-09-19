# Postgrove audit — v0.2 backlog

## v0.2-polish status

v0.2-polish closed on main (`ecf90e8`, PR [#72](https://github.com/bugman666/postgrove/pull/72) / migration `0018`). This audit was written at `e11c12f` (v0.1.0). Findings below stay as the historical record; use this section for what landed and what is next. Release notes: [`docs/RELEASE_NOTES_v0.2.md`](RELEASE_NOTES_v0.2.md).

**Shipped vs AUDIT (v0.2-polish)**

| Item | Status | Landed as |
|------|--------|-----------|
| P0-1 Body CTE (QP/base64 on text/plain+html) | Shipped | #54 / PR #56 |
| P0-2 Inbound R2 fail-loud (rollback D1 + `setReject`) | Shipped | #55 / PR #57 |
| P2-1 `ui.ts` split + batched thread reads | Shipped | #47 / PR #58 |
| Theme E / outbox (pending + idempotency + limited retry) | Shipped | #48 / PR #59 · `0015` |
| MIME malice fixtures + shared MemoryD1 | Shipped | #49 / PR #60 |
| P2-11 smoke CI + empty-D1 migrate | Shipped | #50 / PR #63 |
| P1-2 Shared rate-limit KV + auth matrix (memory fallback if no binding) | Shipped | #51 / PR #62 |
| P1-1 Production auth / `OWNER_TOKEN` as break-glass (`auth_mode`) | Shipped (token still exists) | #52 / PR #61 |
| Outbound URL gate (`assertOutboundHttpUrl`; `OUTBOUND_HTTP_STRICT` default off) | Shipped | #52 / PR #61 |
| P2-8 UX: nav regroup, empty states, layered errors | Shipped | #53 / PR #69 |
| P2-3 FTS5 search (LIKE fallback) | Shipped | #66 / PR #70 · `0016` |
| Persistent `thread_id` | Shipped | #68 / PR #73 · `0017` |
| P2-12 OpenAPI + `docs/API.md` / `llms.txt` + `docs/DEPLOY.md` | Shipped | #64 / #65 / PR #71 |
| P2-6 webhook retry (pending + scheduled drain) | Shipped | #67 / PR #72 · `0018` |
| P1-10 no bare POST when signing secret is missing | Shipped with #67 | #67 / PR #72 |

**Still open → proposed v0.3-hardening** (docs only here; do not treat this list as an implementation ticket)

Standing engineering rule: [#33](https://github.com/bugman666/postgrove/issues/33) remains **open**.

1. P1-4 DoH fail-open → fail-closed or `SAFE_URL_DNS_FAIL=closed`
2. P1-3 CSRF / GET side effects (mark-read) → Origin+Referer or POST-only
3. P1-6 signup domain allowlist (Turnstile ≠ domain gate)
4. P1-7 extract custom RegExp ReDoS → ban custom or timeout/allowlist
5. P1-8 quota check-then-act races
6. P1-9 inbound no hard size cap before buffering
7. P2-7 CSP / `frame-ancestors`; P2-15 `SESSION_SECRET` dual-use (already documented)

Other backlog rows in sections 2–4 (pagination, trash retention, inbound transaction, outbound attach, HTML preview, unify mailbox insert, …) are unchanged and still later.

---

Audit of **bugman666/postgrove** at `e11c12f` (v0.1.0 shipped). Docs-only: findings and a practical optimization backlog. No large features in this change.

Capability ideas follow mainstream mailbox UX and MIT Workers mail patterns (for example cloud-mail). Do **not** clone AGPL mail-hub source. UI / brand stay original (light editorial, paper + forest).

**Already addressed or explicitly known**

| Item | Status |
|------|--------|
| Webhook secret at rest (`enc:v1:` AES-GCM) | Done — `src/webhooks.ts`, migration `0014`. Tracked as #43 (sometimes cited as #45). |
| Logo probe + webhook DNS re-check (`recheckResolvedIps`) | Done — `src/branding.ts`, `src/safe-url.ts`. Same #43. |
| Shared `OWNER_TOKEN` (one deploy secret opens any active address) | Known, documented. Not a regression. |
| Per-isolate in-memory rate limits | Known, documented. Enough for a single box; not a shared store. |

Engineering policy for future work: [#33](https://github.com/bugman666/postgrove/issues/33).

---

## 1. Architecture snapshot

One Worker, two public entry points: `fetch` (HTTP) and `email` (Cloudflare Email Routing).

```
Email Routing ──► email() ──► inbound.ts
                                 ├ mime.ts (body + attachments)
                                 ├ quotas / attachment-limits
                                 ├ D1 messages + R2 ATTACHMENTS
                                 └ webhooks.ts (signed POST / forward)

Browser / curl ──► fetch()
  /healthz              health.ts          (public)
  /app.css              styles + branding  (public)
  /auth/* /admin/ping   auth.ts
  /api/v1/*             rest.ts  (pg_ tokens, Turnstile signup, dev inboxes)
  /attachments/:id      attachments.ts
  /api/*                api.ts   (cookie session JSON)
  /admin/*              admin.ts
  else                  ui.ts    (HTML inbox / compose / settings)
```

| Layer | Where | Notes |
|-------|--------|--------|
| Auth | `src/auth.ts` (~980 lines) | HMAC session cookie (`postgrove_session` / `_admin`), member tokens, `ADMIN_TOKEN` bearer. Origin check on cookie writes. Login: 8 / 10 min / IP, isolate memory. |
| Inbox data | `src/store.ts` + `migrations/0001`–`0009` | D1 mailboxes / messages / outbound attempts. Folders, star, reply headers. List cap **200**. |
| Platform | `0009`–`0014` | Users + quotas, API tokens, inbound hooks, site settings, dev inboxes, aliases + token daily quotas. |
| Inbound | `src/inbound.ts`, `mime.ts`, `aliases.ts` | Exact address, then `+tag`, then `mailbox_aliases`. Unknown / disabled / closed-dev → `setReject`. |
| Outbound | `src/outbound.ts`, `send.ts` | `stub` / `resend` / `http`. Fail loud. `OUTBOUND_HTTP_URL` is operator-trusted (no `validateSafeUrl`). |
| Webhooks | `src/webhooks.ts` (~1.1k) | HMAC-SHA256 `timestamp.body`; secret enveloped with `SESSION_SECRET`; save/fetch/redirect gated; DNS re-check. |
| REST | `src/rest.ts` (~1.2k) | Mailbox- or admin-kind `pg_` tokens (hash at rest). `/api/v1/dev/inboxes` wait / extract. Signup off without Turnstile. |
| UI | `src/ui.ts` (~1.9k) + `admin.ts` (~1.3k) | Server-rendered HTML strings. `view.ts` + `i18n.ts` (en/zh) + accent-only branding. |
| Tests / CI | `test/*.test.ts`, `.github/workflows/typecheck.yml` | Node 22 `--experimental-strip-types`. CI: `tsc --noEmit` (**`src` only**) + `npm test`. No Wrangler smoke. |

**What v0.1 already does well.** Router in `src/index.ts` is small and ordered. Auth is explicit (timing-safe compares, CSRF notes in README, rotate-`SESSION_SECRET` to revoke). Errors tend to say what happened and what to do next. Webhook / logo SSRF path is the most carefully designed outbound fetch. Brand stays a grove, not a generic admin skin.

**What is still an MVP shape.** HTML and routing live in the same files. Two mailbox-insert helpers. Search is `LIKE`, not FTS. Lists do not page. Rate limits and login counters die when the isolate dies. Inbound MIME is a hand-rolled walker, not a full mail parser.

---

## 2. Findings by severity

### P0 — blocking for mail you would trust

These are the items that keep v0.1 from feeling like a dependable everyday mailbox. None of them are “the Worker is unsafe to run locally.”

#### P0-1 — Plain-text body ignores Content-Transfer-Encoding

`extractAttachments` decodes base64 / quoted-printable. `extractBodies` / `textFromPart` do **not**. A `text/plain; CTE: base64` (or QP) part is stored and shown as the encoded blob.

- `src/mime.ts` — `extractBodies` (≈15–32), `textFromPart` (≈80–111). `decodeTransfer` (≈273) is only on the attachment path.
- `src/inbound.ts` — `extractBodies(rawText)` after a UTF-8 decode of the entire raw message (≈46–48).
- Tests cover attachment CTE (`test/attachments.test.ts`) but not body CTE.

**Why it blocks.** A large share of real messages use QP or base64 on the text part. The reading pane then looks broken even though the bytes arrived.

#### P0-2 — Attachment persist failure is swallowed

After the D1 row is inserted, R2 + `attachments` insert sit in `try/catch` that only `console.log`s. The message appears in the inbox with **no files** and no owner-visible error.

- `src/inbound.ts` ≈118–124.

**Why it blocks.** Silent data loss on the one path users cannot retry (the sender already got a 250). Prefer reject, or mark the message and surface a banner.

---

### P1 — high (security, abuse, or reliability)

#### P1-1 — Shared `OWNER_TOKEN` is still the break-glass login *(known)*

Anyone with the deploy secret can open **any** active address. Members have their own hashed tokens; production should prefer those.

- `src/auth.ts` — `handleLogin`, `ownerToken` (≈821–836).
- `.dev.vars.example`, README Auth section.

#### P1-2 — Rate limits are per isolate *(known)*

Login, REST, and signup counters live in module `Map`s. A new isolate resets the window. Fine for one operator; weak under many isolates or a distributed guess on `OWNER_TOKEN` / signup.

- `src/auth.ts` ≈12–26, 745–786.
- `src/rate-limit.ts` (entire module).

#### P1-3 — CSRF residuals on cookie writes and GET side effects

Documented in README. Missing `Origin` **and** `Referer` is allowed so curl works. Opening a message **GET** marks it read (HTML and JSON).

- `src/auth.ts` — `rejectCrossOriginMutation` ≈702–725.
- `src/ui.ts` ≈256–258 (thread), ≈293–294 (message).
- `src/api.ts` ≈431; `src/rest.ts` ≈405 (`GET` read → `markRead`).

SameSite=Lax stops most cross-site POSTs and subresource GETs. A same-site sibling origin, an older browser, or a top-level GET still move state. For v0.2: require a custom header or double-submit token; mark-read only on POST.

#### P1-4 — DNS re-check fail-open

`recheckResolvedIps` skips the IP gate if DoH throws or returns `null`. A public hostname that later resolves to RFC1918 / metadata can still be fetched. Workers cannot install a restricted dialer; this is the remaining SSRF gap (called out in `safe-url.ts` comments).

- `src/safe-url.ts` ≈118–146, `resolveHostDoH` ≈169–196.
- Callers: `src/webhooks.ts` `safeOutboundFetch` ≈769–796; `src/branding.ts` `probeLogoUrl` ≈180–195.

#### P1-5 — Inbound pipeline is not one transaction

Message insert, R2 puts, attachment rows, and webhook/forward run sequentially. Attachment and notify failures are caught independently (`inbound.ts` ≈118–152). Duplicate `rfc_message_id` returns early (good) but a mid-flight crash can leave a body without files, or files without a notify.

#### P1-6 — Public signup has no domain allowlist

When `TURNSTILE_SECRET_KEY` is set, `POST /api/v1/public/signup` creates any syntactically valid address and mints a `pg_` token. Turnstile stops bots, not `ceo@bank.example` on *your* D1.

- `src/rest.ts` — `handlePublicSignup`.
- `src/store.ts` — `parseMailboxAddress` / `insertMailbox` (no `MAIL_DOMAIN` check).

#### P1-7 — Dev wait holds a Worker request; extract accepts a caller regex

`/api/v1/dev/inboxes/:id/wait` polls every 200 ms up to 20 s (env-capped). That is a long-poll on the isolate, not a queue. `extractFromText(..., { pattern })` compiles a user string as `new RegExp` (max 200 chars) — ReDoS risk on an authenticated token.

- `src/dev-inbox.ts` ≈226–294.
- `src/extract.ts` ≈57–75.

#### P1-8 — Quota checks are check-then-act

Address / storage / send / token daily counters read, then write. Two parallel sends can both pass `checkSendQuota` / `checkTokenSendQuota`.

- `src/quotas.ts` — `checkSendQuota`, `incrementSendUsage`, token variants ≈188–262.
- `src/send.ts` ≈38–102.

#### P1-9 — No hard cap before buffering raw inbound

`handleInbound` reads the entire `message.raw` into a `Uint8Array` and a UTF-8 string, then walks MIME in Latin-1 for attachments (`mime.ts` `bytesToLatin1`). Attachment caps apply after parse. A huge multipart can burn CPU/memory inside the `email` handler before `setReject`.

- `src/inbound.ts` ≈46–49; `src/mime.ts` ≈34–39, 318–324.

#### P1-10 — Webhook POST can go out unsigned if the secret is empty

Save path mints a secret when the hook is enabled. Delivery still POSTs if `webhook_secret` is empty (`signed` is null). Treat “enabled + no secret” as a failed delivery, same as `secret_unreadable`.

- `src/webhooks.ts` ≈575–618.

---

### P2 — polish (product smoothness, structure, docs)

| ID | Finding | Pointers |
|----|---------|----------|
| P2-1 | `ui.ts` (~1.9k) and `admin.ts` (~1.3k) mix routing, forms, and HTML. Hard to change IA without regressions. | `src/ui.ts`, `src/admin.ts` |
| P2-2 | Two mailbox creators (`insertMailbox` vs `createMailbox`) with different error types. REST vs UI/admin drift. | `src/store.ts` ≈79–187 |
| P2-3 | Inbox / folder lists are `LIMIT 200`, no cursor. Search is `LIKE` on from/subject/body (and To in triage), not FTS5. | `src/store.ts` ≈234–266, 286–298; `src/triage.ts` |
| P2-4 | Trash is a folder only — no empty-trash, retention, or purge of expired **dev** mailboxes (rows stay after `expired`). | `src/store.ts` `trashMessage`; `src/dev-inbox.ts` `refreshDevInbox` |
| P2-5 | Star / unread SQL is inbox-scoped (`folder = 'inbox'`). Sent/drafts cannot be starred. | `src/store.ts` `setRead` / `setStarred` |
| P2-6 | Webhook/forward is one-shot. Failures are logged (good) but never retried. | `src/webhooks.ts` `notifyInbound` |
| P2-7 | HTML responses have `nosniff` + `referrer-policy`, no CSP / `frame-ancestors`. Login defaults to `inbox@example.test`. | `src/http.ts` `html`; `src/ui.ts` login form |
| P2-8 | i18n covers nav/empty/quota; login / some admin copy stay hardcoded Chinese. Mobile nav omits folders and addresses. | `src/i18n.ts`, `src/ui.ts` layout |
| P2-9 | Logo probe is a full GET, no byte cap (bandwidth if the URL is huge). Accent-only brand is correct; dark mode is `prefers-color-scheme` only. | `src/branding.ts` ≈180–226; `src/styles.ts` |
| P2-10 | Public `/healthz` lists missing table names and D1 error strings. Fine for self-host; noisy on a public hostname. | `src/health.ts` |
| P2-11 | `tsconfig.json` `include` is `["src"]` — tests are not typechecked in CI. No lint, no Wrangler integration job. | `tsconfig.json`, `.github/workflows/typecheck.yml` |
| P2-12 | README still has “Planned MVP” / a single Status paragraph. `docs/RELEASE_NOTES_v0.1.md` already asks to replace that. | `README.md`, `docs/RELEASE_NOTES_v0.1.md` |
| P2-13 | `wrangler.jsonc` ships a dummy `database_id`. Easy to deploy against the placeholder if someone skips the README. | `wrangler.jsonc` |
| P2-14 | Outbound attach, HTML-mail preview, and IMAP are correctly out of scope — but they are the next UX cliff. Text-only `<pre>` is the safe default. | `src/ui.ts` `renderReadArticle`; README out-of-scope |
| P2-15 | `SESSION_SECRET` signs cookies **and** wraps webhook secrets. Rotate-to-revoke-sessions also breaks hook signing until secrets are re-minted (documented; still a sharp edge). | `src/auth.ts`, `src/webhooks.ts` `webhookSecretAesKey` |

---

## 3. Optimization themes (v0.2)

Effort: **S** = small isolated change · **M** = a focused PR or two · **L** = a milestone slice.

| Theme | Effort | Why it matters |
|-------|--------|----------------|
| **A. Mail fidelity** — decode body CTE in `mime.ts`; optional later: safe HTML preview (sandboxed / text-first), outbound attachments | **M** then **L** | A mailbox that garbles everyday QP/base64 mail will not be used as a daily driver. Keep HTML preview opt-in so XSS stays out. |
| **B. Auth & abuse** — Durable Object or KV limiter; prefer member tokens in prod docs; CSRF header; POST-only read/star; domain allowlist for signup/create | **M** | Turns “honest self-host MVP” into something you can put on a real hostname without hoping isolates stay warm. |
| **C. Split presentation** — `ui.ts` / `admin.ts` → route handlers + `render/*` (or `src/pages`) | **M** | Unblocks i18n completeness, mobile IA, and settings without 2k-line conflict magnets. Keep the grove look; do not restyle as a stock dashboard. |
| **D. Data lifecycle** — cursor pagination; D1 FTS5 when a box grows; empty trash; expire/purge closed dev inboxes + R2 | **M** | `LIMIT 200` and immortal trash are fine for a demo seed, not for months of mail. |
| **E. Delivery reliability** — inbound: fail closed on R2; optional D1 batch; webhook retry + backoff (cap attempts, keep the visible log) | **M** | Matches how people expect mail + hooks to work (cloud-mail style: visible failure, then retry). |
| **F. Extract / wait** — drop or tightly timeout custom regex; shorter wait or 202 + poll | **S**–**M** | Protects the isolate; keeps the OTP helper honest (“fail loud, never guess”). |
| **G. Operator docs & CI** — README “what’s included”; typecheck `test/`; optional `wrangler dev` smoke in CI | **S** | Lowers first-deploy mistakes (dummy D1 id, Planned MVP confusion). |
| **H. Headers & login UX** — CSP on HTML; empty login address; finish en/zh on login/admin | **S** | Cheap trust and a less “local seed” first impression. |

Suggested order for a smooth product: **A (body CTE) + E (R2 fail-closed)** first, then **B**, then **C** so UX work is not fighting a monolith.

---

## 4. Suggested issues (v0.2 / P4-polish)

Open these under a **v0.2** (or **P4-polish**) milestone. Titles are ready to paste. Do not implement AGPL mail-hub flows; stay on this domain.

**v0.2 — reliability & security**

1. Decode inbound MIME transfer encodings for the stored body text
2. Fail closed (or banner) when inbound R2 attachment persist fails
3. Shared rate-limit store (Durable Object or KV) for login / REST / signup
4. Production auth: treat `OWNER_TOKEN` as break-glass; document member-token default
5. CSRF: require a custom header or double-submit; mark-read/star only via POST
6. Domain allowlist for public signup and address create (`MAIL_DOMAIN`)
7. Fail webhook delivery when signing secret is missing; add bounded retries
8. Extract API: remove user-supplied regex or run it with a hard timeout
9. Cap inbound raw size before buffering; bound MIME multipart depth
10. Quota increments under a single D1 write (or accept-and-correct)

**P4-polish — structure & UX**

11. Split `ui.ts` / `admin.ts` into routes + render helpers
12. Unify `insertMailbox` and `createMailbox`
13. Paginate inbox / folder / admin audit lists
14. D1 FTS5 (or equivalent) when `LIKE` is no longer enough
15. Empty trash + retention; purge expired dev inboxes
16. Allow star/unread outside inbox (or say so in the UI)
17. Content-Security-Policy and related HTML security headers
18. Login page: no seeded address; finish en/zh on login and 值守台
19. README: replace Planned MVP with a shipped-surface section (see `docs/RELEASE_NOTES_v0.1.md`)
20. CI: typecheck `test/`; optional local Wrangler smoke
21. Outbound compose attachments (R2 + same size caps)
22. Optional safe HTML reading pane (never raw `innerHTML` of the message)

---

## 5. What not to do

- Do not import or rewrite AGPL mail-hub code. Wait-for-mail / OTP ideas are already in `src/dev-inbox.ts` / `src/extract.ts`.
- Do not replace the light-editorial grove UI with another product’s shell.
- Do not “fix” `OUTBOUND_HTTP_URL` with `validateSafeUrl` unless it becomes a Settings field — it is a deploy-time hook the operator already trusts (README).
- Do not treat isolate rate limits or shared `OWNER_TOKEN` as new bugs; track them as v0.2 hardening.
