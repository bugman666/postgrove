-- Persist conversation id so grouping stays stable across the inbox
-- LIMIT 200 list window. Assignment matches src/threads.ts:
-- citation threads use mid:<root Message-ID> from References / In-Reply-To;
-- otherwise subject fallback uses subj:<hash> (or solo:<id>).
-- Existing rows are backfilled in the Worker from the same rules.
-- Follows 0016 FTS (#66). #67 owns 0018; do not reuse this number.

ALTER TABLE messages ADD COLUMN thread_id TEXT;

CREATE INDEX idx_messages_mailbox_thread_received
  ON messages (mailbox_id, thread_id, received_at);
