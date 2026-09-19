const SNIPPET_MAX = 240;
const BODY_MAX = 256_000;

export interface ExtractedBody {
  bodyText: string | null;
  snippet: string | null;
}

export function extractBodies(rawText: string): ExtractedBody {
  const { headers, body } = splitMime(rawText);
  const contentType = headerValue(headers, "content-type") ?? "text/plain";
  let text = textFromPart(body, contentType);
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

function textFromPart(body: string, contentType: string): string | null {
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
      const { headers, body: partBody } = splitMime(trimmed);
      const partType = headerValue(headers, "content-type") ?? "text/plain";
      if (/text\/plain/i.test(partType)) {
        const text = partBody.trim();
        if (text) {
          return text;
        }
      }
      if (!htmlFallback && /text\/html/i.test(partType)) {
        htmlFallback = stripHtml(partBody);
      }
    }
    return htmlFallback;
  }
  if (/text\/html/i.test(contentType)) {
    return stripHtml(body);
  }
  const text = body.trim();
  return text.length > 0 ? text : null;
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
