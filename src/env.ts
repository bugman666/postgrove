export interface Env {
  DB: D1Database;
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
