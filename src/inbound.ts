import type { Env, InboundEmail } from "./env";
import { inboundAttachmentRejection } from "./attachment-limits";
import { persistInboundAttachments } from "./attachments";
import { extractAttachments, extractBodies } from "./mime";
import { inboundStorageRejection } from "./quotas.ts";

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
  const headerTo = header(message.headers, "to");
  const headerCc = header(message.headers, "cc");
  const headerReplyTo = header(message.headers, "reply-to");
  const inReplyTo = header(message.headers, "in-reply-to");
  const referencesHeader = header(message.headers, "references");
  const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const rawText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(rawBytes);
  const { snippet, bodyText } = extractBodies(rawText);
  const files = extractAttachments(rawBytes);
  const limitError = inboundAttachmentRejection(
    files.map((file) => ({ filename: file.filename, size: file.bytes.byteLength })),
    env,
  );
  if (limitError) {
    console.log("inbound stub: attachment rejected", {
      to: parsedTo.address,
      error: limitError.error,
    });
    message.setReject(limitError.hint);
    return;
  }
  let storageError = null;
  try {
    storageError = await inboundStorageRejection(env, mailbox.id, message.rawSize);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.log("inbound stub: storage quota lookup skipped", { detail });
  }
  if (storageError) {
    console.log("inbound stub: storage quota rejected", {
      to: parsedTo.address,
      error: storageError.error,
    });
    message.setReject(storageError.hint);
    return;
  }
  const mailboxId = mailbox.id;

  const messageId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO messages (
         id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
         subject, snippet, body_text, header_to, header_cc, header_reply_to,
         in_reply_to, references_header, size_bytes, is_read, folder, received_at, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, 'inbox', ?15, ?15)`,
    )
      .bind(
        messageId,
        mailboxId,
        rfcMessageId,
        message.from,
        parsedTo.address,
        subject,
        snippet,
        bodyText,
        headerTo,
        headerCc,
        headerReplyTo,
        inReplyTo,
        referencesHeader,
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

  if (files.length > 0) {
    try {
      await persistInboundAttachments(env, mailboxId, messageId, files, now);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      console.log("inbound stub: attachment store failed", { messageId, detail });
    }
  }

  console.log("inbound stub: stored", {
    id: messageId,
    mailboxId,
    from: message.from,
    to: parsedTo.address,
    subject,
    sizeBytes: message.rawSize,
    attachments: files.length,
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

