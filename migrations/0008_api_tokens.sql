-- Opaque REST API tokens for /api/v1. The secret is hashed at rest (SHA-256 hex).
-- Bound to mailbox_id on today's owner/mailbox model — no users table.
-- #10 (multi-user / RBAC) can attach user_id later without rewriting this table.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id)
);

CREATE INDEX idx_api_tokens_mailbox ON api_tokens (mailbox_id);
CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens (token_hash);
CREATE INDEX idx_api_tokens_active ON api_tokens (mailbox_id, revoked_at);
