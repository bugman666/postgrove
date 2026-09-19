import type { Env } from "./env";
import { requireOwner, type OwnerPrincipal } from "./auth";
import { forbiddenJson, json, methodNotAllowed, notFoundJson } from "./http";
import { buildComposePrefill, parseComposeMode } from "./reply";
import { parseSendFields, sendOutbound } from "./send";
import {
  getInboxMessage,
  getMailbox,
  getMessageById,
  listInboxMessages,
  listOutboundAttempts,
  markRead,
  trashMessage,
  type MailboxRecord,
  type MessageRecord,
  type OutboundAttemptRecord,
} from "./store";

export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const gate = await requireOwner(request, env);
  if (!gate.ok) {
    return gate.response;
  }

  const path = url.pathname;
  const method = request.method;
  const owner = gate.principal;

  if (path === "/api/send") {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return sendMessage(request, env, owner);
  }

  if (path === "/api/outbound/attempts") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    const mailbox = await getMailbox(env, owner.mailboxId);
    if (!mailbox) {
      return notFoundJson();
    }
    const attempts = await listOutboundAttempts(env, mailbox.id);
    return json({
      ok: true,
      mailbox: publicMailbox(mailbox),
      attempts: attempts.map(publicAttempt),
    });
  }

  if (path === "/api/mailboxes") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    const mailbox = await getMailbox(env, owner.mailboxId);
    if (!mailbox) {
      return notFoundJson();
    }
    return json({ ok: true, mailboxes: [publicMailbox(mailbox)] });
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
    if (!sameMailbox(owner, mailbox)) {
      return forbiddenJson();
    }
    const messages = await listInboxMessages(env, mailbox.id);
    return json({
      ok: true,
      mailbox: publicMailbox(mailbox),
      folder: "inbox",
      messages: messages.map(publicMessageListItem),
    });
  }

  const composeMatch = path.match(/^\/api\/messages\/([^/]+)\/compose$/);
  if (composeMatch) {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return composePrefill(env, owner, decodeURIComponent(composeMatch[1]), url);
  }

  const oneMessage = path.match(/^\/api\/messages\/([^/]+)$/);
  if (oneMessage) {
    const messageId = decodeURIComponent(oneMessage[1]);
    if (method === "GET") {
      return readMessage(env, owner, messageId);
    }
    if (method === "DELETE") {
      return deleteMessage(env, owner, messageId);
    }
    return methodNotAllowed("GET, DELETE");
  }

  return notFoundJson();
}

async function sendMessage(
  request: Request,
  env: Env,
  owner: OwnerPrincipal,
): Promise<Response> {
  const mailbox = await getMailbox(env, owner.mailboxId);
  if (!mailbox) {
    return notFoundJson();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: "Send JSON { \"to\", \"subject\", \"text\" } (optional cc, in_reply_to, references).",
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: "Send JSON { \"to\", \"subject\", \"text\" } (optional cc, in_reply_to, references).",
      },
      400,
    );
  }

  const parsed = parseSendFields(body as Record<string, unknown>);
  if (!parsed.ok) {
    return json({ ok: false, error: parsed.error, hint: parsed.hint }, 400);
  }

  const outcome = await sendOutbound(env, mailbox, parsed.input);
  return json(
    {
      ok: outcome.attempt.status === "sent",
      attempt: publicAttempt(outcome.attempt),
      error: outcome.attempt.error,
      hint: outcome.attempt.hint,
    },
    outcome.httpStatus,
  );
}

function publicAttempt(row: OutboundAttemptRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    from: row.from_address,
    to: row.to_address,
    cc: row.cc_address,
    subject: row.subject,
    in_reply_to: row.in_reply_to,
    references: row.references_header,
    provider: row.provider,
    status: row.status,
    error: row.error,
    hint: row.hint,
    provider_message_id: row.provider_message_id,
    created_at: row.created_at,
  };
}

async function readMessage(
  env: Env,
  owner: OwnerPrincipal,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.mailbox_id !== owner.mailboxId) {
    return forbiddenJson();
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

async function composePrefill(
  env: Env,
  owner: OwnerPrincipal,
  messageId: string,
  url: URL,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.mailbox_id !== owner.mailboxId) {
    return forbiddenJson();
  }
  const mailbox = await getMailbox(env, owner.mailboxId);
  if (!mailbox) {
    return notFoundJson();
  }
  const mode = parseComposeMode(url.searchParams.get("mode"));
  if (mode === "new") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: "mode must be reply, reply-all, or forward.",
      },
      400,
    );
  }
  const draft = buildComposePrefill(existing, mailbox.address, mode);
  return json({
    ok: true,
    mode,
    message_id: existing.id,
    draft: {
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      text: draft.body,
      in_reply_to: draft.inReplyTo || null,
      references: draft.references || null,
    },
  });
}

async function deleteMessage(
  env: Env,
  owner: OwnerPrincipal,
  messageId: string,
): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  if (existing.mailbox_id !== owner.mailboxId) {
    return forbiddenJson();
  }
  const moved = await trashMessage(env, existing.mailbox_id, existing.id);
  if (!moved) {
    return notFoundJson();
  }
  return json({ ok: true, id: existing.id, folder: "trash" });
}

function sameMailbox(owner: OwnerPrincipal, mailbox: MailboxRecord): boolean {
  return mailbox.id === owner.mailboxId || mailbox.address === owner.address;
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
    header_to: row.header_to,
    header_cc: row.header_cc,
    header_reply_to: row.header_reply_to,
    in_reply_to: row.in_reply_to,
    references: row.references_header,
    folder: row.folder,
    size_bytes: row.size_bytes,
  };
}
