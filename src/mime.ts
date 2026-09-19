const SNIPPET_MAX = 240;
const BODY_MAX = 256_000;

export interface ExtractedBody {
  bodyText: string | null;
  snippet: string | null;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export function extractBodies(rawText: string): ExtractedBody {
  const { headers, body } = splitMime(rawText);
  const contentType = headerValue(headers, "content-type") ?? "text/plain";
  let text = textFromPart(headers, body, contentType);
  if (text) {
    text = text.replace(/\r\n/g, "\n").trim();
    if (text.length > BODY_MAX) {
      text = text.slice(0, BODY_MAX);
    }
  }
  if (!text) {
    return { bodyText: null, snippet: null };
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  const snippet =
    collapsed.length > SNIPPET_MAX ? collapsed.slice(0, SNIPPET_MAX) : collapsed;
  return { bodyText: text, snippet: snippet || null };
}

/** Binary-safe MIME walk for inbound attachments (base64 / QP / 8bit). */
export function extractAttachments(raw: Uint8Array | string): ParsedAttachment[] {
  const text = typeof raw === "string" ? raw : bytesToLatin1(raw);
  const { headers, body } = splitMime(text);
  const contentType = headerValue(headers, "content-type") ?? "text/plain";
  return collectAttachments(headers, body, contentType);
}

function splitMime(raw: string): { headers: string; body: string } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  let split = -1;
  let skip = 0;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    split = crlf;
    skip = 4;
  } else if (lf >= 0) {
    split = lf;
    skip = 2;
  }
  if (split < 0) {
    return { headers: raw, body: "" };
  }
  return { headers: raw.slice(0, split), body: raw.slice(split + skip) };
}

function headerValue(headers: string, name: string): string | null {
  const lines = headers.replace(/\r\n/g, "\n").split("\n");
  const folded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && folded.length > 0) {
      folded[folded.length - 1] += " " + line.trim();
    } else {
      folded.push(line);
    }
  }
  const prefix = name.toLowerCase() + ":";
  for (const line of folded) {
    if (line.toLowerCase().startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function textFromPart(headers: string, body: string, contentType: string): string | null {
  if (/multipart\//i.test(contentType)) {
    const boundary = mimeBoundary(contentType);
    if (!boundary) {
      return stripHtml(body) || body.trim() || null;
    }
    const parts = body.split(new RegExp(`(?:^|\n)--${escapeRegExp(boundary)}(?:--)?`, "g"));
    let htmlFallback: string | null = null;
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === "--") {
        continue;
      }
      const { headers: partHeaders, body: partBody } = splitMime(trimmed);
      const partType = headerValue(partHeaders, "content-type") ?? "text/plain";
      if (/text\/plain/i.test(partType)) {
        const text = decodePartText(partHeaders, partBody, partType).trim();
        if (text) {
          return text;
        }
      }
      if (!htmlFallback && /text\/html/i.test(partType)) {
        htmlFallback = stripHtml(decodePartText(partHeaders, partBody, partType));
      }
    }
    return htmlFallback;
  }
  const decoded = decodePartText(headers, body, contentType);
  if (/text\/html/i.test(contentType)) {
    return stripHtml(decoded);
  }
  const text = decoded.trim();
  return text.length > 0 ? text : null;
}

/** Decode RFC 2045 CTE on a text part. 7bit/8bit stay as the already-decoded string. */
function decodePartText(headers: string, body: string, contentType: string): string {
  const encoding = headerValue(headers, "content-transfer-encoding") ?? "7bit";
  const enc = encoding.split(";")[0]?.trim().toLowerCase() ?? "7bit";
  if (enc !== "base64" && enc !== "quoted-printable") {
    return body;
  }
  const bytes = decodeTransfer(body, encoding);
  const charset = mimeParam(contentType, "charset") ?? "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false, ignoreBOM: true }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  }
}

function mimeBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i);
  if (!match) {
    return null;
  }
  return match[1] ?? match[2] ?? null;
}

function stripHtml(html: string): string | null {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectAttachments(
  headers: string,
  body: string,
  contentType: string,
): ParsedAttachment[] {
  if (/multipart\//i.test(contentType)) {
    const boundary = mimeBoundary(contentType);
    if (!boundary) {
      return [];
    }
    const found: ParsedAttachment[] = [];
    for (const part of splitMultipartParts(body, boundary)) {
      const { headers: partHeaders, body: partBody } = splitMime(part);
      const partType = headerValue(partHeaders, "content-type") ?? "text/plain";
      found.push(...collectAttachments(partHeaders, partBody, partType));
    }
    return found;
  }

  if (!isAttachmentPart(headers, contentType)) {
    return [];
  }

  const disposition = headerValue(headers, "content-disposition");
  const encoding = headerValue(headers, "content-transfer-encoding") ?? "7bit";
  const filename = filenameFrom(disposition, contentType);
  const bytes = decodeTransfer(body, encoding);
  const media = contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  return [{ filename, contentType: media, bytes }];
}

function splitMultipartParts(body: string, boundary: string): string[] {
  const token = `--${boundary}`;
  const normalized = body.replace(/\r\n/g, "\n");
  const chunks = normalized.split(token);
  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (i === 0) {
      continue;
    }
    if (chunk.startsWith("--")) {
      break;
    }
    if (chunk.startsWith("\n")) {
      chunk = chunk.slice(1);
    }
    if (chunk.endsWith("\n")) {
      chunk = chunk.slice(0, -1);
    }
    if (chunk.trim().length === 0) {
      continue;
    }
    parts.push(chunk);
  }
  return parts;
}

function isAttachmentPart(headers: string, contentType: string): boolean {
  const disposition = headerValue(headers, "content-disposition") ?? "";
  if (/attachment/i.test(disposition)) {
    return true;
  }
  if (mimeParam(disposition, "filename") || mimeParam(disposition, "filename*")) {
    return true;
  }
  if (mimeParam(contentType, "name")) {
    return true;
  }
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!media || media.startsWith("multipart/") || media === "text/plain" || media === "text/html") {
    return false;
  }
  return true;
}

function filenameFrom(disposition: string | null, contentType: string): string {
  const raw =
    mimeParam(disposition, "filename*") ??
    mimeParam(disposition, "filename") ??
    mimeParam(contentType, "name") ??
    "attachment";
  const cleaned = raw.replace(/[\r\n]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "attachment";
}

function mimeParam(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  const starred = new RegExp(`${escapeRegExp(name)}\\*\\s*=\\s*([^;]+)`, "i");
  const encoded = header.match(starred);
  if (encoded && name.endsWith("*")) {
    let value = encoded[1].trim().replace(/^"(.*)"$/, "$1");
    const parts = value.split("''");
    const data = parts.length === 2 ? parts[1] : value;
    try {
      return decodeURIComponent(data);
    } catch {
      return data;
    }
  }
  const simple = new RegExp(`${escapeRegExp(name)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^;\\s]+)`, "i");
  const match = header.match(simple);
  if (!match) {
    return null;
  }
  let value = match[1].trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\"/g, '"');
  }
  return decodeMimeWords(value);
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset, enc, data) => {
    try {
      const bytes =
        String(enc).toUpperCase() === "B"
          ? base64ToBytes(String(data))
          : quotedPrintableToBytes(String(data).replace(/_/g, " "));
      return new TextDecoder(String(charset) || "utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
    } catch {
      return String(data);
    }
  });
}

function decodeTransfer(body: string, encoding: string): Uint8Array {
  const enc = encoding.split(";")[0]?.trim().toLowerCase() ?? "7bit";
  if (enc === "base64") {
    return base64ToBytes(body.replace(/\s+/g, ""));
  }
  if (enc === "quoted-printable") {
    return quotedPrintableToBytes(body);
  }
  return latin1ToBytes(body);
}

function base64ToBytes(value: string): Uint8Array {
  if (!value) {
    return new Uint8Array();
  }
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return new Uint8Array();
  }
}

function quotedPrintableToBytes(value: string): Uint8Array {
  const unfolded = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i];
    if (ch === "=" && i + 2 < unfolded.length) {
      const hex = unfolded.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(bytes);
}

function bytesToLatin1(bytes: Uint8Array): string {
  let text = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return text;
}

function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}
