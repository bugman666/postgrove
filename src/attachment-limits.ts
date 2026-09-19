import type { Env } from "./env";

export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_MAX_COUNT = 10;

export interface AttachmentLimits {
  maxBytes: number;
  maxCount: number;
}

export interface AttachmentLimitError {
  error: "attachment_too_large" | "too_many_attachments" | "r2_not_configured";
  hint: string;
  max_bytes: number;
  max_count: number;
  filename?: string;
  size_bytes?: number;
  count?: number;
}

export function attachmentLimits(env: Env): AttachmentLimits {
  return {
    maxBytes: parsePositiveInt(env.ATTACHMENT_MAX_BYTES, DEFAULT_ATTACHMENT_MAX_BYTES),
    maxCount: parsePositiveInt(env.ATTACHMENT_MAX_COUNT, DEFAULT_ATTACHMENT_MAX_COUNT),
  };
}

export function checkAttachmentLimits(
  files: { filename: string; size: number }[],
  limits: AttachmentLimits,
): AttachmentLimitError | null {
  if (files.length > limits.maxCount) {
    return {
      error: "too_many_attachments",
      hint: tooManyHint(files.length, limits.maxCount),
      max_bytes: limits.maxBytes,
      max_count: limits.maxCount,
      count: files.length,
    };
  }
  for (const file of files) {
    if (file.size > limits.maxBytes) {
      return {
        error: "attachment_too_large",
        hint: tooLargeHint(file.filename, file.size, limits.maxBytes),
        max_bytes: limits.maxBytes,
        max_count: limits.maxCount,
        filename: file.filename,
        size_bytes: file.size,
      };
    }
  }
  return null;
}

/** Reason for inbound setReject, or null when the message may be stored. */
export function inboundAttachmentRejection(
  files: { filename: string; size: number }[],
  env: Env,
): AttachmentLimitError | null {
  const limits = attachmentLimits(env);
  const over = checkAttachmentLimits(files, limits);
  if (over) {
    return over;
  }
  if (files.length > 0 && !env.ATTACHMENTS) {
    return {
      error: "r2_not_configured",
      hint: missingR2Hint(),
      max_bytes: limits.maxBytes,
      max_count: limits.maxCount,
    };
  }
  return null;
}

export function tooLargeHint(filename: string, sizeBytes: number, maxBytes: number): string {
  const limit = formatLimit(maxBytes);
  const actual = formatBytes(sizeBytes);
  const label = filename.trim() || "attachment";
  return `附件太大（上限 ${limit}）。「${label}」为 ${actual}。去掉大文件或压缩后再试。 Attachment too large (limit ${limit}). "${label}" is ${actual}. Remove large files or compress and try again.`;
}

export function tooManyHint(count: number, maxCount: number): string {
  return `附件太多（上限 ${maxCount} 个）。这封信有 ${count} 个附件。去掉部分文件后再试。 Too many attachments (limit ${maxCount}). This message has ${count} attachments. Remove some files and try again.`;
}

export function missingR2Hint(): string {
  return "ATTACHMENTS R2 bucket is not bound. Add r2_buckets in wrangler.jsonc (binding ATTACHMENTS) and retry.";
}

/** Reason for inbound setReject when R2 put or attachments-row insert fails after parse. */
export function attachmentStoreFailedHint(): string {
  return "附件未能写入对象存储。这封信未入箱，请稍后重试。 Attachment storage failed. The message was rejected so the sender can retry.";
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${trimDecimal(size / 1024)} KB`;
  }
  return `${trimDecimal(size / (1024 * 1024))} MB`;
}

export function formatMb(bytes: number): string {
  return trimDecimal(bytes / (1024 * 1024));
}

export function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${formatMb(bytes)} MB`;
  }
  if (bytes >= 1024) {
    return `${trimDecimal(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
