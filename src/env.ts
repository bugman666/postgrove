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
