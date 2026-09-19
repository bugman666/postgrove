import type { Env, InboundEmail } from "./env";

const SNIPPET_MAX = 240;

export async function handleInbound(message: InboundEmail, env: Env): Promise<void> {
  let parsedTo: AddressParts;
  try {
    parsedTo = splitAddress(message.to);
  } catch {
    message.setReject("invalid recipient");
    return;
  }

  const mailbox = await env.DB.prepare(
    `SELECT id, status FROM mailboxes WHERE address = ?1`,
  )
    .bind(parsedTo.address)
    .first<{ id: string; status: string }>();

  if (!mailbox) {
    console.log("inbound stub: unknown mailbox", { to: parsedTo.address });
    message.setReject("unknown mailbox");
    return;
  }
  if (mailbox.status !== "active") {
    console.log("inbound stub: mailbox disabled", { to: parsedTo.address });
    message.setReject("mailbox disabled");
    return;
  }

  const now = Date.now();
  const subject = header(message.headers, "subject");
  const rfcMessageId = header(message.headers, "message-id");
  const snippet = await snippetFromRaw(message.raw);
  const mailboxId = mailbox.id;

  const messageId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO messages (
         id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
         subject, snippet, size_bytes, is_read, folder, received_at, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 'inbox', ?9, ?9)`,
    )
      .bind(
        messageId,
        mailboxId,
        rfcMessageId,
        message.from,
        parsedTo.address,
        subject,
        snippet,
        message.rawSize,
        now,
      )
      .run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    if (/UNIQUE/i.test(detail) && rfcMessageId) {
      console.log("inbound stub: duplicate rfc_message_id ignored", {
        mailboxId,
        rfcMessageId,
      });
      return;
    }
    throw error;
  }

  console.log("inbound stub: stored", {
    id: messageId,
    mailboxId,
    from: message.from,
    to: parsedTo.address,
    subject,
    sizeBytes: message.rawSize,
  });
}

interface AddressParts {
  address: string;
  localPart: string;
  domain: string;
}

function splitAddress(value: string): AddressParts {
  const address = value.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) {
    throw new Error("invalid address");
  }
  return {
    address,
    localPart: address.slice(0, at),
    domain: address.slice(at + 1),
  };
}

function header(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function snippetFromRaw(raw: ReadableStream<Uint8Array>): Promise<string | null> {
  const text = await new Response(raw).text();
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  let start = 0;
  if (crlf >= 0) {
    start = crlf + 4;
  } else if (lf >= 0) {
    start = lf + 2;
  }
  const body = text.slice(start).replace(/\s+/g, " ").trim();
  if (!body) {
    return null;
  }
  return body.length > SNIPPET_MAX ? body.slice(0, SNIPPET_MAX) : body;
}
