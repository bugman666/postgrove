-- Star / flag on inbox rows. Existing messages stay unstarred (DEFAULT 0).
ALTER TABLE messages ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1));

CREATE INDEX idx_messages_mailbox_unread ON messages (mailbox_id, folder, is_read, received_at DESC);
CREATE INDEX idx_messages_mailbox_starred ON messages (mailbox_id, folder, is_starred, received_at DESC);
