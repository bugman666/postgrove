-- Local-only sample mailbox for wrangler / inbound stub tests.
-- Do not apply this file to a remote database.
INSERT OR IGNORE INTO mailboxes (
  id,
  address,
  local_part,
  domain,
  display_name,
  status,
  created_at,
  updated_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'inbox@example.test',
  'inbox',
  'example.test',
  'Local inbox',
  'active',
  1789815600000,
  1789815600000
);
