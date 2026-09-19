-- Inbound webhook / forward config and delivery attempts.
-- Failures stay readable in settings and the admin 值守台 (never silent).

CREATE TABLE inbound_hooks (
  mailbox_id TEXT PRIMARY KEY NOT NULL,
  webhook_enabled INTEGER NOT NULL DEFAULT 0 CHECK (webhook_enabled IN (0, 1)),
  webhook_url TEXT,
  webhook_secret TEXT,
  forward_enabled INTEGER NOT NULL DEFAULT 0 CHECK (forward_enabled IN (0, 1)),
  forward_url TEXT,
  forward_email TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

CREATE TABLE inbound_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('webhook', 'forward')),
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  http_status INTEGER,
  error TEXT,
  hint TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

CREATE INDEX idx_inbound_deliveries_mailbox_created
  ON inbound_deliveries (mailbox_id, created_at DESC);
