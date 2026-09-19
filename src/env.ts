export interface Env {
  DB: D1Database;
  /** HMAC secret for owner session cookies. Fail closed if unset. */
  SESSION_SECRET?: string;
  /** Shared mailbox-owner token accepted by POST /auth/login. */
  OWNER_TOKEN?: string;
  /** Bearer token for /admin/* (Authorization: Bearer …). */
  ADMIN_TOKEN?: string;
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
