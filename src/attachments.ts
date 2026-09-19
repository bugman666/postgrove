import type { Env } from "./env.ts";
import { requireOwner } from "./auth.ts";
import { mailboxAllowed } from "./users.ts";
import { getMailbox } from "./store.ts";
import { formatBytes, missingR2Hint } from "./attachment-limits.ts";
import { escapeHtml } from "./html.ts";
import { json, methodNotAllowed, notFoundJson, forbiddenJson } from "./http.ts";
import type { ParsedAttachment } from "./mime.ts";
import { chunkIds, sqlInPlaceholders } from "./sql-in.ts";

export {
  attachmentLimits,
  checkAttachmentLimits,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MAX_COUNT,
  formatBytes,
  formatMb,
  inboundAttachmentRejection,
  missingR2Hint,
  tooLargeHint,
  tooManyHint,
} from "./attachment-limits.ts";
export type { AttachmentLimitError, AttachmentLimits } from "./attachment-limits.ts";

export interface AttachmentRecord {
  id: string;
  message_id: string;
  mailbox_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
  created_at: number;
}

const ATTACHMENT_COLUMNS = `id, message_id, mailbox_id, filename, content_type,
  size_bytes, r2_key, created_at`;

export const ATTACHMENT_CSS = `
.attach {
  margin: 0 0 var(--pg-space-4);
  padding: var(--pg-space-3) var(--pg-space-4);
  border: 1px solid var(--pg-color-border);
  border-radius: var(--pg-radius-sm);
  background: var(--pg-color-surface-muted);
}

.attach h2 {
  margin: 0 0 var(--pg-space-2);
  font-size: var(--pg-text-sm);
  font-weight: 650;
  color: var(--pg-color-text-secondary);
}

.attach-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--pg-space-2);
}

.attach-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--pg-space-2) var(--pg-space-3);
  min-height: 44px;
}

.attach-link {
  font-weight: 600;
  word-break: break-all;
}

.attach-meta {
  font-size: var(--pg-text-xs);
  color: var(--pg-color-text-secondary);
  font-family: var(--pg-font-mono);
}

.banner.attach-error {
  color: var(--pg-color-danger);
  border: 1px solid color-mix(in srgb, var(--pg-color-danger) 35%, var(--pg-color-border));
}
`;

export async function handleAttachmentRoutes(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/attachments\/([^/]+)$/);
  if (!match) {
    return null;
  }
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }
  return downloadAttachment(request, env, decodeURIComponent(match[1]));
}

export async function downloadAttachment(
  request: Request,
  env: Env,
  attachmentId: string,
): Promise<Response> {
  const gate = await requireOwner(request, env);
  if (!gate.ok) {
    return gate.response;
  }

  const row = await getAttachmentById(env, attachmentId);
  if (!row) {
    return notFoundJson();
  }
  const mailbox = await getMailbox(env, row.mailbox_id);
  if (!mailbox || !mailboxAllowed(gate.principal, mailbox)) {
    return forbiddenJson();
  }
  if (!env.ATTACHMENTS) {
    return json(
      { ok: false, error: "r2_not_configured", hint: missingR2Hint() },
      503,
    );
  }

  const object = await env.ATTACHMENTS.get(row.r2_key);
  if (!object) {
    return json(
      {
        ok: false,
        error: "not_found",
        hint: "Attachment bytes are missing from R2. Re-seed locally or receive the message again.",
      },
      404,
    );
  }

  const headers = new Headers({
    "content-type": safeDownloadType(row.content_type),
    "content-disposition": contentDisposition(row.filename),
    "content-length": String(row.size_bytes),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  return new Response(object.body, { status: 200, headers });
}

export async function persistInboundAttachments(
  env: Env,
  mailboxId: string,
  messageId: string,
  files: ParsedAttachment[],
  now = Date.now(),
): Promise<AttachmentRecord[]> {
  if (files.length === 0) {
    return [];
  }
  if (!env.ATTACHMENTS) {
    throw new Error(missingR2Hint());
  }

  const stored: AttachmentRecord[] = [];
  for (const file of files) {
    const id = crypto.randomUUID();
    const key = r2Key(mailboxId, messageId, id, file.filename);
    await env.ATTACHMENTS.put(key, file.bytes, {
      httpMetadata: { contentType: safeDownloadType(file.contentType) },
    });
    const row: AttachmentRecord = {
      id,
      message_id: messageId,
      mailbox_id: mailboxId,
      filename: file.filename,
      content_type: file.contentType,
      size_bytes: file.bytes.byteLength,
      r2_key: key,
      created_at: now,
    };
    await env.DB.prepare(
      `INSERT INTO attachments (
         id, message_id, mailbox_id, filename, content_type, size_bytes, r2_key, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        row.id,
        row.message_id,
        row.mailbox_id,
        row.filename,
        row.content_type,
        row.size_bytes,
        row.r2_key,
        row.created_at,
      )
      .run();
    stored.push(row);
  }
  return stored;
}

export async function listMessageAttachments(
  env: Env,
  mailboxId: string,
  messageId: string,
): Promise<AttachmentRecord[]> {
  return listAttachmentsForMessages(env, mailboxId, [messageId]);
}

export async function listAttachmentsForMessages(
  env: Env,
  mailboxId: string,
  messageIds: readonly string[],
): Promise<AttachmentRecord[]> {
  const collected: AttachmentRecord[] = [];
  for (const chunk of chunkIds(messageIds)) {
    const placeholders = sqlInPlaceholders(2, chunk.length);
    const rows = await env.DB.prepare(
      `SELECT ${ATTACHMENT_COLUMNS} FROM attachments
       WHERE mailbox_id = ?1 AND message_id IN (${placeholders})
       ORDER BY created_at ASC, filename ASC`,
    )
      .bind(mailboxId, ...chunk)
      .all<AttachmentRecord>();
    collected.push(...(rows.results ?? []));
  }
  return collected;
}

export async function getAttachmentById(
  env: Env,
  attachmentId: string,
): Promise<AttachmentRecord | null> {
  return env.DB.prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?1`)
    .bind(attachmentId)
    .first<AttachmentRecord>();
}

export function renderAttachmentsHtml(attachments: AttachmentRecord[]): string {
  if (attachments.length === 0) {
    return "";
  }
  const items = attachments
    .map((row) => {
      const href = `/attachments/${encodeURIComponent(row.id)}`;
      return `<li>
        <a class="attach-link" href="${escapeHtml(href)}">${escapeHtml(row.filename)}</a>
        <span class="attach-meta">${escapeHtml(formatBytes(row.size_bytes))} · ${escapeHtml(row.content_type)}</span>
      </li>`;
    })
    .join("");
  return `<section class="attach">
    <h2>附件</h2>
    <ul class="attach-list">${items}</ul>
  </section>`;
}

function r2Key(mailboxId: string, messageId: string, attachmentId: string, filename: string): string {
  return `attachments/${mailboxId}/${messageId}/${attachmentId}/${safeKeyName(filename)}`;
}

function safeKeyName(filename: string): string {
  const base = filename.replace(/^.*[/\\]/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
  const trimmed = base.replace(/^_+|_+$/g, "").slice(0, 80);
  return trimmed.length > 0 ? trimmed : "file";
}

function safeDownloadType(contentType: string): string {
  const media = contentType.split(";")[0]?.trim().toLowerCase() || "";
  if (
    !media ||
    media === "text/html" ||
    media === "image/svg+xml" ||
    media === "application/xhtml+xml" ||
    media === "text/xml" ||
    media === "application/xml"
  ) {
    return "application/octet-stream";
  }
  return media;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'") || "attachment";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

