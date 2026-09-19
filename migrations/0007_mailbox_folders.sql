-- Expand messages.folder CHECK to include spam (Junk).
-- Runs after 0006_message_star.sql, so is_starred is copied and kept.
-- Recreates indexes from init + star so list/unread/star queries stay valid.

PRAGMA foreign_keys = OFF;

CREATE TABLE messages_folders (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  rfc_message_id TEXT,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  size_bytes INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
  folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'sent', 'draft', 'trash', 'spam')),
  received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  body_text TEXT,
  header_to TEXT,
  header_cc TEXT,
  header_reply_to TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

INSERT INTO messages_folders (
  id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
  subject, snippet, size_bytes, is_read, is_starred, folder, received_at, created_at,
  body_text, header_to, header_cc, header_reply_to, in_reply_to, references_header
)
SELECT
  id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
  subject, snippet, size_bytes, is_read, is_starred, folder, received_at, created_at,
  body_text, header_to, header_cc, header_reply_to, in_reply_to, references_header
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_folders RENAME TO messages;

CREATE INDEX idx_messages_mailbox_received ON messages (mailbox_id, received_at DESC);
CREATE INDEX idx_messages_mailbox_folder ON messages (mailbox_id, folder, received_at DESC);
CREATE UNIQUE INDEX idx_messages_mailbox_rfc_id ON messages (mailbox_id, rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;
CREATE INDEX idx_messages_mailbox_unread ON messages (mailbox_id, folder, is_read, received_at DESC);
CREATE INDEX idx_messages_mailbox_starred ON messages (mailbox_id, folder, is_starred, received_at DESC);

PRAGMA foreign_keys = ON;
