export interface Env {
  DB: D1Database;
  /** R2 bucket for inbound attachment bytes. */
  ATTACHMENTS?: R2Bucket;
  /** HMAC secret for owner session cookies. Rotate to revoke all sessions. */
  SESSION_SECRET?: string;
  /** Shared secret for every mailbox (not a per-address password). */
  OWNER_TOKEN?: string;
  /** Bearer token for /admin/* (Authorization: Bearer …). */
  ADMIN_TOKEN?: string;
  /** stub | resend | http. Unset fails loud on send (no silent drop). */
  OUTBOUND_PROVIDER?: string;
  /** Required when OUTBOUND_PROVIDER=resend. */
  RESEND_API_KEY?: string;
  /** Optional From override for Resend (verified domain). */
  RESEND_FROM?: string;
  /** Required when OUTBOUND_PROVIDER=http. POST JSON {from,to,subject,text} plus optional cc/headers. */
  OUTBOUND_HTTP_URL?: string;
  /** Optional Bearer token for the HTTP outbound hook. */
  OUTBOUND_HTTP_TOKEN?: string;
  /** Optional From override for any provider (wins over RESEND_FROM). */
  OUTBOUND_FROM?: string;
  /** Per-attachment size cap in bytes (default 10485760 = 10 MiB). */
  ATTACHMENT_MAX_BYTES?: string;
  /** Max attachments stored per inbound message (default 10). */
  ATTACHMENT_MAX_COUNT?: string;
  /** Cloudflare Turnstile secret. When set, POST /api/v1/public/signup is open (challenge required). */
  TURNSTILE_SECRET_KEY?: string;
  /** Cloudflare Turnstile site key for a public widget (optional; documented for operators). */
  TURNSTILE_SITE_KEY?: string;
  /** Max JSON body size for /api/v1 and public signup (default 256000). */
  REST_BODY_MAX_BYTES?: string;
  /** Token API requests per window (default 60). */
  REST_RATE_LIMIT_MAX?: string;
  /** Token API window in ms (default 60000). */
  REST_RATE_LIMIT_WINDOW_MS?: string;
  /** Public signup attempts per window (default 5). */
  SIGNUP_RATE_LIMIT_MAX?: string;
  /** Public signup window in ms (default 600000). */
  SIGNUP_RATE_LIMIT_WINDOW_MS?: string;
}

/** Envelope fields used by the Email Routing stub. */
export interface InboundEmail {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  setReject(reason: string): void;
}
