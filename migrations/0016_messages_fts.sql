-- FTS5 index for mailbox search (from / To / subject / body).
-- Triggers keep new writes in sync. Backfill existing rows after CREATE
-- because triggers do not fire for rows already in `messages`.
-- LIKE remains the runtime fallback when the virtual table is missing
-- (unit-test fakes / older snapshots).
--
-- Aligns with mainstream mailbox search (token index, rank subject first)
-- and architecture P2-3 / theme D.

CREATE VIRTUAL TABLE messages_fts USING fts5(
  envelope_from,
  envelope_to,
  subject,
  body_text,
  message_id UNINDEXED,
  mailbox_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

INSERT INTO messages_fts (
  envelope_from, envelope_to, subject, body_text, message_id, mailbox_id
)
SELECT
  envelope_from,
  envelope_to,
  IFNULL(subject, ''),
  IFNULL(body_text, ''),
  id,
  mailbox_id
FROM messages;

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (
    envelope_from, envelope_to, subject, body_text, message_id, mailbox_id
  ) VALUES (
    new.envelope_from,
    new.envelope_to,
    IFNULL(new.subject, ''),
    IFNULL(new.body_text, ''),
    new.id,
    new.mailbox_id
  );
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF
  envelope_from, envelope_to, subject, body_text
ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts (
    envelope_from, envelope_to, subject, body_text, message_id, mailbox_id
  ) VALUES (
    new.envelope_from,
    new.envelope_to,
    IFNULL(new.subject, ''),
    IFNULL(new.body_text, ''),
    new.id,
    new.mailbox_id
  );
END;
