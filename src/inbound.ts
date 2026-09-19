import { resolveInboundMailbox } from "./aliases.ts";
import type { Env, InboundEmail } from "./env.ts";
import { attachmentStoreFailedHint, inboundAttachmentRejection } from "./attachment-limits.ts";
import { discardInboundMessageWrites, persistInboundAttachments } from "./attachments.ts";
import { extractAttachments, extractBodies } from "./mime.ts";
import { inboundStorageRejection } from "./quotas.ts";
import { rejectClosedDevInbox } from "./dev-inbox.ts";
import { persistThreadIdOnRecord } from "./store.ts";
import { notifyInbound } from "./webhooks.ts";

export async function handleInbound(message: InboundEmail, env: Env): Promise<void> {
  const resolved = await resolveInboundMailbox(env, message.to);
  if (!resolved) {
    console.log("inbound stub: unknown mailbox", { to: message.to });
    message.setReject("unknown mailbox");
    return;
  }

  const mailbox = resolved.mailbox;
  const envelopeTo = resolved.envelopeTo;

  if (mailbox.status !== "active") {
    console.log("inbound stub: mailbox disabled", { to: envelopeTo });
    message.setReject("mailbox disabled");
    return;
  }
  try {
    const closed = await rejectClosedDevInbox(env, mailbox.id);
    if (closed) {
      console.log("inbound stub: dev inbox closed", { to: envelopeTo, reason: closed });
      message.setReject(closed);
      return;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.log("inbound stub: dev inbox lookup skipped", { detail });
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
      to: envelopeTo,
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
      to: envelopeTo,
      error: storageError.error,
    });
    message.setReject(storageError.hint);
    return;
  }
  const mailboxId = mailbox.id;

  const messageId = crypto.randomUUID();
  const persisted = await persistThreadIdOnRecord(env, mailboxId, {
    id: messageId,
    mailbox_id: mailboxId,
    rfc_message_id: rfcMessageId,
    envelope_from: message.from,
    envelope_to: envelopeTo,
    subject,
    snippet,
    body_text: bodyText,
    header_to: headerTo,
    header_cc: headerCc,
    header_reply_to: headerReplyTo,
    in_reply_to: inReplyTo,
    references_header: referencesHeader,
    size_bytes: message.rawSize,
    is_read: 0,
    is_starred: 0,
    folder: "inbox",
    received_at: now,
    created_at: now,
    thread_id: null,
  });
  try {
    await env.DB.prepare(
      `INSERT INTO messages (
         id, mailbox_id, rfc_message_id, envelope_from, envelope_to,
         subject, snippet, body_text, header_to, header_cc, header_reply_to,
         in_reply_to, references_header, size_bytes, is_read, folder, received_at, created_at,
         thread_id
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, 'inbox', ?15, ?15, ?16)`,
    )
      .bind(
        messageId,
        mailboxId,
        rfcMessageId,
        message.from,
        envelopeTo,
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
        persisted.thread_id ?? null,
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
      // Same fail-loud path as limit / missing-R2 rejects: bounce the sender
      // and drop the D1 row so a retry is not swallowed as a duplicate.
      await discardInboundMessageWrites(env, mailboxId, messageId);
      message.setReject(attachmentStoreFailedHint());
      return;
    }
  }

  console.log("inbound stub: stored", {
    id: messageId,
    mailboxId,
    from: message.from,
    to: envelopeTo,
    subject,
    sizeBytes: message.rawSize,
    attachments: files.length,
  });

  try {
    await notifyInbound(env, {
      mailboxId,
      mailboxAddress: mailbox.address,
      messageId,
      from: message.from,
      to: envelopeTo,
      subject,
      snippet,
      text: bodyText,
      receivedAt: now,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.log("inbound stub: webhook/forward notify failed", { messageId, detail });
  }
}

function header(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

