-- Small-team users, mailbox bindings, and per-user quotas.
-- 0 on a quota column means unlimited (same idea as cloud-mail sendCount/accountCount = 0).
-- Owner (OWNER_TOKEN) and ADMIN_TOKEN stay env secrets; they are not rows here.

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'mailbox')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  token_salt TEXT,
  token_hash TEXT,
  quota_addresses INTEGER NOT NULL DEFAULT 3 CHECK (quota_addresses >= 0),
  quota_storage_bytes INTEGER NOT NULL DEFAULT 104857600 CHECK (quota_storage_bytes >= 0),
  quota_send_daily INTEGER NOT NULL DEFAULT 50 CHECK (quota_send_daily >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_users_role_status ON users (role, status);

CREATE TABLE user_mailboxes (
  user_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mailbox_id),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id) ON DELETE CASCADE
);

CREATE INDEX idx_user_mailboxes_mailbox ON user_mailboxes (mailbox_id);

CREATE TABLE send_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (user_id, day),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
