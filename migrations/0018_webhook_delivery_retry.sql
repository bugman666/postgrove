-- Inbound webhook / forward delivery retry: persist pending with a
-- delivery_key before (or after) the first POST, then drain due rows
-- from a Worker cron. Aligns with outbound outbox (0015): record first,
-- dispatch, limited attempts, visible status.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt.
-- Existing sent/failed rows keep their status; attempt_count is backfilled.

CREATE TABLE inbound_deliveries_new (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('webhook', 'forward')),
  channel TEXT NOT NULL CHECK (channel IN ('webhook', 'forward_url', 'forward_email')),
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  http_status INTEGER,
  error TEXT,
  hint TEXT,
  delivery_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

INSERT INTO inbound_deliveries_new (
  id, mailbox_id, message_id, kind, channel, target, status, http_status,
  error, hint, delivery_key, attempt_count, max_attempts, next_attempt_at,
  last_attempt_at, payload_json, created_at, updated_at
)
SELECT
  id,
  mailbox_id,
  message_id,
  kind,
  CASE
    WHEN kind = 'webhook' THEN 'webhook'
    WHEN target LIKE 'http%' THEN 'forward_url'
    ELSE 'forward_email'
  END,
  target,
  status,
  http_status,
  error,
  hint,
  id,
  CASE WHEN status IN ('sent', 'failed') THEN 1 ELSE 0 END,
  5,
  NULL,
  created_at,
  NULL,
  created_at,
  created_at
FROM inbound_deliveries;

DROP TABLE inbound_deliveries;
ALTER TABLE inbound_deliveries_new RENAME TO inbound_deliveries;

CREATE INDEX idx_inbound_deliveries_mailbox_created
  ON inbound_deliveries (mailbox_id, created_at DESC);

CREATE UNIQUE INDEX idx_inbound_deliveries_mailbox_key
  ON inbound_deliveries (mailbox_id, delivery_key);

CREATE INDEX idx_inbound_deliveries_pending
  ON inbound_deliveries (status, next_attempt_at);
