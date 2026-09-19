-- Inbound header fields needed for reply / reply-all / forward.
-- Not a conversation/thread model (that stays on the later threads issue).
ALTER TABLE messages ADD COLUMN header_to TEXT;
ALTER TABLE messages ADD COLUMN header_cc TEXT;
ALTER TABLE messages ADD COLUMN header_reply_to TEXT;
ALTER TABLE messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE messages ADD COLUMN references_header TEXT;

-- Outbound attempts record the same headers so send history matches the wire.
ALTER TABLE outbound_attempts ADD COLUMN cc_address TEXT;
ALTER TABLE outbound_attempts ADD COLUMN in_reply_to TEXT;
ALTER TABLE outbound_attempts ADD COLUMN references_header TEXT;
