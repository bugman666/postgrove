-- Local-only sample mailboxes and messages for wrangler / inbox tests.
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
  '11111111-1111-4111-8111-111111111112',
  'empty@example.test',
  'empty',
  'example.test',
  'Empty box',
  'active',
  1789815601000,
  1789815601000
);

INSERT OR IGNORE INTO messages (
  id,
  mailbox_id,
  rfc_message_id,
  envelope_from,
  envelope_to,
  subject,
  snippet,
  body_text,
  size_bytes,
  is_read,
  folder,
  received_at,
  created_at
) VALUES (
  '22222222-2222-4222-8222-222222222221',
  '11111111-1111-4111-8111-111111111111',
  '<seed-welcome@example.test>',
  'neighbor@example.test',
  'inbox@example.test',
  '欢迎使用本地收件箱',
  '这是一封已读的种子信，用来核对阅读页正文。',
  '你好，

这是一封已读的种子信，用来核对阅读页正文。

打开后应保持已读；删除后会离开收件箱（进入垃圾箱，本阶段不提供垃圾箱界面）。',
  220,
  1,
  'inbox',
  1789812000000,
  1789812000000
);

INSERT OR IGNORE INTO messages (
  id,
  mailbox_id,
  rfc_message_id,
  envelope_from,
  envelope_to,
  subject,
  snippet,
  body_text,
  size_bytes,
  is_read,
  folder,
  received_at,
  created_at
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  '<seed-invoice@example.test>',
  'billing@grove.test',
  'inbox@example.test',
  '本月账单已出',
  '本地种子：未读、有发件人、主题和时间，便于核对立列表。',
  '本地种子：未读、有发件人、主题和时间，便于核对立列表。

金额与账号均为虚构，不会产生真实扣款。',
  180,
  0,
  'inbox',
  1789813800000,
  1789813800000
);

INSERT OR IGNORE INTO messages (
  id,
  mailbox_id,
  rfc_message_id,
  envelope_from,
  envelope_to,
  subject,
  snippet,
  body_text,
  size_bytes,
  is_read,
  folder,
  received_at,
  created_at
) VALUES (
  '22222222-2222-4222-8222-222222222223',
  '11111111-1111-4111-8111-111111111111',
  '<seed-code@example.test>',
  'noreply@verify.test',
  'inbox@example.test',
  '你的确认码',
  '确认码 482193。这是未读种子信，打开后应变为已读。',
  '确认码 482193。

这是未读种子信，打开后应变为已读。阅读页的回复会预填写信表单。',
  160,
  0,
  'inbox',
  1789815600000,
  1789815600000
);

INSERT OR IGNORE INTO messages (
  id,
  mailbox_id,
  rfc_message_id,
  envelope_from,
  envelope_to,
  subject,
  snippet,
  body_text,
  size_bytes,
  is_read,
  folder,
  received_at,
  created_at
) VALUES (
  '22222222-2222-4222-8222-222222222224',
  '11111111-1111-4111-8111-111111111111',
  '<seed-attachment@example.test>',
  'files@grove.test',
  'inbox@example.test',
  '本地附件种子',
  '这封信带一个限内附件，阅读页应列出并可下载。',
  '这封信带一个限内附件，阅读页应列出并可下载。

下载地址需要主人会话。未登录访问 /attachments/… 应返回 401。',
  240,
  0,
  'inbox',
  1789816200000,
  1789816200000
);

INSERT OR IGNORE INTO messages (
  id,
  mailbox_id,
  rfc_message_id,
  envelope_from,
  envelope_to,
  subject,
  snippet,
  body_text,
  header_to,
  header_cc,
  header_reply_to,
  in_reply_to,
  references_header,
  size_bytes,
  is_read,
  folder,
  received_at,
  created_at
) VALUES (
  '22222222-2222-4222-8222-222222222225',
  '11111111-1111-4111-8111-111111111111',
  '<seed-sync@example.test>',
  'lead@grove.test',
  'inbox@example.test',
  '本周同步',
  '本地种子：多人 To/Cc，用来核对全部回复的收件人。',
  '本地种子：多人 To/Cc，用来核对全部回复的收件人。

回复应收 To=lead@grove.test；全部回复的 To 还应带上 teammate 与 notes，并去掉自己。',
  'inbox@example.test, teammate@grove.test',
  'notes@grove.test',
  NULL,
  '<seed-sync-root@example.test>',
  '<seed-sync-root@example.test>',
  220,
  0,
  'inbox',
  1789816800000,
  1789816800000
);

INSERT OR IGNORE INTO attachments (
  id,
  message_id,
  mailbox_id,
  filename,
  content_type,
  size_bytes,
  r2_key,
  created_at
) VALUES (
  '33333333-3333-4333-8333-333333333331',
  '22222222-2222-4222-8222-222222222224',
  '11111111-1111-4111-8111-111111111111',
  'grove-note.txt',
  'text/plain',
  84,
  'attachments/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222224/33333333-3333-4333-8333-333333333331/grove-note.txt',
  1789816200000
);
