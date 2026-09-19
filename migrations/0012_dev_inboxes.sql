-- Ephemeral developer inboxes on this deployment's own domain.
-- Not a public temp-mail pool. Do not reuse this table for +tag aliases (#15).
CREATE TABLE dev_inboxes (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL UNIQUE,
  owner_mailbox_id TEXT,
  owner_token_id TEXT,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'expired')),
  expires_at INTEGER NOT NULL,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

CREATE INDEX idx_dev_inboxes_owner_status ON dev_inboxes (owner_mailbox_id, status);
CREATE INDEX idx_dev_inboxes_status_expires ON dev_inboxes (status, expires_at);
CREATE UNIQUE INDEX idx_dev_inboxes_address ON dev_inboxes (address);
