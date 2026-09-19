# Postgrove

Personal and small-team **edge mailbox** on Cloudflare Workers.

Create addresses under your domain, read mail in a clean web inbox, send through a provider you control, and keep attachments in R2. Built for self-hosters who want a focused mailbox without running a full mail server.

> Not affiliated with other Cloudflare mail demos. Educational / self-host use. You are responsible for domain, deliverability, and abuse controls.

## Why Postgrove

- **Your domain, your rules** — multiple addresses, one Worker deployment
- **Edge-first** — Cloudflare Workers + D1 + R2 + Email Routing
- **Small surface** — inbox, compose, attachments, admin basics first
- **Honest scope** — no fake “enterprise suite”; roadmap stays visible

## Planned MVP

1. Catch inbound mail (Email Routing → Worker) and store messages in D1
2. Web inbox (list / read / delete) with responsive layout
3. Outbound send via a pluggable SMTP/API provider (e.g. Resend or similar)
4. Attachments in R2 with size limits
5. Simple auth for mailbox owners + admin

## Stack (intended)

| Piece | Choice |
|-------|--------|
| Runtime | Cloudflare Workers |
| Inbound | Cloudflare Email Routing |
| Data | D1 |
| Files | R2 |
| UI | Lightweight web app (details in Issues) |

## Status

Scaffolding. See Issues and the MVP milestone.

## License

MIT (to be confirmed in `LICENSE`).

## Contributing

Open an Issue before large features. Keep tone practical; this is a real project, not a form submission.