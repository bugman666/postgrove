import type { Env } from "./env";
import { json, methodNotAllowed, notFoundJson } from "./http";
import {
  getInboxMessage,
  getMailbox,
  getMessageById,
  listInboxMessages,
  listMailboxes,
  markRead,
  trashMessage,
  type MailboxRecord,
  type MessageRecord,
} from "./store";

export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/mailboxes") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    const mailboxes = await listMailboxes(env);
    return json({ ok: true, mailboxes: mailboxes.map(publicMailbox) });
  }

  const mailboxMessages = path.match(/^\/api\/mailboxes\/([^/]+)\/messages$/);
  if (mailboxMessages) {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    const mailbox = await getMailbox(env, decodeURIComponent(mailboxMessages[1]));
    if (!mailbox) {
      return notFoundJson();
    }
    const messages = await listInboxMessages(env, mailbox.id);
    return json({
      ok: true,
      mailbox: publicMailbox(mailbox),
      folder: "inbox",
      messages: messages.map(publicMessageListItem),
    });
  }

  const oneMessage = path.match(/^\/api\/messages\/([^/]+)$/);
  if (oneMessage) {
    const messageId = decodeURIComponent(oneMessage[1]);
    if (method === "GET") {
      return readMessage(env, messageId);
    }
    if (method === "DELETE") {
      return deleteMessage(env, messageId);
    }
    return methodNotAllowed("GET, DELETE");
  }

  return notFoundJson();
}

async function readMessage(env: Env, messageId: string): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.is_read !== 1) {
    await markRead(env, existing.mailbox_id, existing.id);
  }
  const message = await getInboxMessage(env, existing.mailbox_id, existing.id);
  if (!message) {
    return notFoundJson();
  }
  return json({ ok: true, message: publicMessageDetail(message) });
}

async function deleteMessage(env: Env, messageId: string): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  const moved = await trashMessage(env, existing.mailbox_id, existing.id);
  if (!moved) {
    return notFoundJson();
  }
  return json({ ok: true, id: existing.id, folder: "trash" });
}

function publicMailbox(row: MailboxRecord) {
  return {
    id: row.id,
    address: row.address,
    display_name: row.display_name,
    status: row.status,
  };
}

function publicMessageListItem(row: MessageRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    from: row.envelope_from,
    to: row.envelope_to,
    subject: row.subject,
    snippet: row.snippet,
    is_read: row.is_read === 1,
    received_at: row.received_at,
  };
}

function publicMessageDetail(row: MessageRecord) {
  return {
    ...publicMessageListItem(row),
    rfc_message_id: row.rfc_message_id,
    body_text: row.body_text,
    folder: row.folder,
    size_bytes: row.size_bytes,
  };
}
