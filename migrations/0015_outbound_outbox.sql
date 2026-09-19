-- Outbox: persist the send as pending with an idempotency key before the
-- provider call. Limited in-request retries update attempt_count in place.
-- Aligns with mainstream outbox / send-status flows (record first, then
-- dispatch). Existing sent/failed rows keep their status; missing keys are
-- backfilled from id so the unique index can land.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt.

CREATE TABLE outbound_attempts_new (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  cc_address TEXT,
  subject TEXT,
  body_text TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  hint TEXT,
  provider_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_attempt_at INTEGER,
  sent_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

INSERT INTO outbound_attempts_new (
  id, mailbox_id, from_address, to_address, cc_address, subject, body_text,
  in_reply_to, references_header, provider, status, error, hint,
  provider_message_id, idempotency_key, attempt_count, max_attempts,
  last_attempt_at, sent_message_id, created_at, updated_at
)
SELECT
  id,
  mailbox_id,
  from_address,
  to_address,
  cc_address,
  subject,
  body_text,
  in_reply_to,
  references_header,
  provider,
  status,
  error,
  hint,
  provider_message_id,
  id,
  CASE WHEN status IN ('sent', 'failed') THEN 1 ELSE 0 END,
  3,
  created_at,
  NULL,
  created_at,
  created_at
FROM outbound_attempts;

DROP TABLE outbound_attempts;
ALTER TABLE outbound_attempts_new RENAME TO outbound_attempts;

CREATE INDEX idx_outbound_attempts_mailbox_created
  ON outbound_attempts (mailbox_id, created_at DESC);

CREATE UNIQUE INDEX idx_outbound_attempts_mailbox_idempotency
  ON outbound_attempts (mailbox_id, idempotency_key);

CREATE INDEX idx_outbound_attempts_pending
  ON outbound_attempts (status, created_at);
