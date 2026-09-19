-- Plain-text body for the inbox read view. Attachments stay out of D1 (R2 later).
ALTER TABLE messages ADD COLUMN body_text TEXT;
