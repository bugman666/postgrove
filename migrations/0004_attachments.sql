-- Inbound attachment metadata. Bytes live in the ATTACHMENTS R2 bucket.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages (id),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

CREATE INDEX idx_attachments_message ON attachments (message_id, created_at);
CREATE INDEX idx_attachments_mailbox ON attachments (mailbox_id);
