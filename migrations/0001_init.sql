-- Mailboxes this deployment accepts. Later inbox/admin will list and manage these.
CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY NOT NULL,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_mailboxes_domain ON mailboxes (domain);
CREATE INDEX idx_mailboxes_status ON mailboxes (status);

-- Inbound (and later outbound) message metadata for the inbox list/read views.
-- Body/attachments stay out of this table for now; R2 comes later.
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  rfc_message_id TEXT,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  size_bytes INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'sent', 'draft', 'trash')),
  received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

CREATE INDEX idx_messages_mailbox_received ON messages (mailbox_id, received_at DESC);
CREATE INDEX idx_messages_mailbox_folder ON messages (mailbox_id, folder, received_at DESC);
CREATE UNIQUE INDEX idx_messages_mailbox_rfc_id ON messages (mailbox_id, rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;
