-- Plus-tag listing + API key kinds / daily quotas.
-- Inbound +tag is derive-only (RFC 5233 / Gmail-like local+tag@domain → primary).
-- This table stores generated or explicit aliases so Settings / REST can list them.
-- Alias domain must match the mailbox's own domain (no cross-domain catch-all).
-- 0 on a quota column means unlimited (same convention as users.quota_*).

CREATE TABLE mailbox_aliases (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  local_part TEXT NOT NULL COLLATE NOCASE,
  domain TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_mailbox_aliases_addr ON mailbox_aliases (local_part, domain);
CREATE INDEX idx_mailbox_aliases_mailbox ON mailbox_aliases (mailbox_id);

ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'mailbox';
ALTER TABLE api_tokens ADD COLUMN quota_requests_daily INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_tokens ADD COLUMN quota_send_daily INTEGER NOT NULL DEFAULT 0;

CREATE TABLE api_token_usage (
  token_id TEXT NOT NULL,
  day TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  PRIMARY KEY (token_id, day),
  FOREIGN KEY (token_id) REFERENCES api_tokens (id) ON DELETE CASCADE
);
