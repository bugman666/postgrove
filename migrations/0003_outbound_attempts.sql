-- Outbound send attempts. Failures stay readable in the compose UI.
CREATE TABLE outbound_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error TEXT,
  hint TEXT,
  provider_message_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

CREATE INDEX idx_outbound_attempts_mailbox_created
  ON outbound_attempts (mailbox_id, created_at DESC);
