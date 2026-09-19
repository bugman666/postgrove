import type { MessageRecord } from "./store";

export const COMPOSE_MODES = ["new", "reply", "reply-all", "forward"] as const;
export type ComposeMode = (typeof COMPOSE_MODES)[number];

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_FIND_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const RECIPIENT_MAX = 50;

const REPLY_PREFIXES = ["re:", "回复:", "回复："];
const FORWARD_PREFIXES = ["fwd:", "fw:", "forward:", "转发:", "转发："];

export interface ComposePrefill {
  mode: ComposeMode;
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyTo: string;
  references: string;
}

export interface ReplySource {
  envelope_from: string;
  envelope_to: string;
  subject: string | null;
  body_text: string | null;
  rfc_message_id: string | null;
  header_to?: string | null;
  header_cc?: string | null;
  header_reply_to?: string | null;
  in_reply_to?: string | null;
  references_header?: string | null;
  received_at: number;
}

export function parseComposeMode(raw: string | null | undefined): ComposeMode {
  if (raw === "reply" || raw === "reply-all" || raw === "forward") {
    return raw;
  }
  return "new";
}

export function extractAddresses(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  const found = value.match(EMAIL_FIND_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    const email = raw.toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) {
      continue;
    }
    seen.add(email);
    out.push(email);
  }
  return out;
}

export function formatAddressList(addresses: string[]): string {
  return addresses.join(", ");
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed;
  }
  return `<${trimmed}>`;
}

export function buildReferences(
  existing: string | null | undefined,
  parentId: string | null | undefined,
): string {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of (existing ?? "").split(/\s+/)) {
    const id = normalizeMessageId(raw);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    tokens.push(id);
  }
  const parent = normalizeMessageId(parentId);
  if (parent && !seen.has(parent)) {
    tokens.push(parent);
  }
  return tokens.join(" ");
}

function hasPrefix(subject: string, prefixes: string[]): boolean {
  const trimmed = subject.trim();
  return prefixes.some((prefix) => trimmed.toLowerCase().startsWith(prefix.toLowerCase()));
}

export function replySubject(subject: string | null | undefined): string {
  const base = (subject ?? "").trim();
  if (!base) {
    return "Re:";
  }
  if (hasPrefix(base, REPLY_PREFIXES)) {
    return base;
  }
  return `Re: ${base}`;
}

export function forwardSubject(subject: string | null | undefined): string {
  const base = (subject ?? "").trim();
  if (!base) {
    return "Fwd:";
  }
  if (hasPrefix(base, FORWARD_PREFIXES)) {
    return base;
  }
  return `Fwd: ${base}`;
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addresses) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) {
      continue;
    }
    seen.add(email);
    out.push(email);
  }
  return out;
}

function minusSelf(addresses: string[], selfAddress: string): string[] {
  const self = selfAddress.trim().toLowerCase();
  return addresses.filter((address) => address !== self);
}

/**
 * Reply: To = Reply-To or From.
 * Reply-all: To = sender/Reply-To + original To + original Cc
 * (deduped, mailbox address removed). Cc stays empty so the
 * prefill matches a single recipient field.
 */
export function replyRecipients(
  message: ReplySource,
  selfAddress: string,
  all: boolean,
): { to: string[]; cc: string[] } {
  const replyTo = extractAddresses(message.header_reply_to);
  const from = extractAddresses(message.envelope_from);
  const primary = uniqueAddresses(replyTo.length > 0 ? replyTo : from);

  if (!all) {
    return { to: primary, cc: [] };
  }

  const headerTo = extractAddresses(message.header_to);
  const originalTo = headerTo.length > 0 ? headerTo : extractAddresses(message.envelope_to);
  const headerCc = extractAddresses(message.header_cc);
  const to = minusSelf(
    uniqueAddresses([...primary, ...originalTo, ...headerCc]),
    selfAddress,
  );
  if (to.length === 0) {
    return { to: primary, cc: [] };
  }
  return { to, cc: [] };
}

function quoteBody(body: string | null | undefined): string {
  const text = (body ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.trim()) {
    return "> （没有正文）";
  }
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function formatReplyBody(message: ReplySource, when: string): string {
  const who = extractAddresses(message.envelope_from)[0] || message.envelope_from || "unknown";
  return `\n\n在 ${when}，${who} 写道：\n${quoteBody(message.body_text)}\n`;
}

export function formatForwardBody(message: ReplySource, when: string): string {
  const subject = message.subject?.trim() ? message.subject : "（无主题）";
  const to = (message.header_to ?? "").trim() || message.envelope_to;
  const lines = [
    "",
    "",
    "---------- Forwarded message ----------",
    `From: ${message.envelope_from}`,
    `Date: ${when}`,
    `Subject: ${subject}`,
    `To: ${to}`,
  ];
  const cc = (message.header_cc ?? "").trim();
  if (cc) {
    lines.push(`Cc: ${cc}`);
  }
  lines.push("");
  lines.push((message.body_text ?? "").trim() || "（没有正文）");
  lines.push("");
  return lines.join("\n");
}

export function buildComposePrefill(
  message: ReplySource | MessageRecord,
  selfAddress: string,
  mode: ComposeMode,
  formatDate: (ms: number) => string = formatUtcStamp,
): ComposePrefill {
  if (mode === "new") {
    return emptyPrefill();
  }

  const when = formatDate(message.received_at);

  if (mode === "forward") {
    return {
      mode,
      to: "",
      cc: "",
      subject: forwardSubject(message.subject),
      body: formatForwardBody(message, when),
      inReplyTo: "",
      references: "",
    };
  }

  const recipients = replyRecipients(message, selfAddress, mode === "reply-all");
  const parentId = normalizeMessageId(message.rfc_message_id);
  return {
    mode,
    to: formatAddressList(recipients.to),
    cc: formatAddressList(recipients.cc),
    subject: replySubject(message.subject),
    body: formatReplyBody(message, when),
    inReplyTo: parentId ?? "",
    references: buildReferences(message.references_header, parentId),
  };
}

export function emptyPrefill(): ComposePrefill {
  return {
    mode: "new",
    to: "",
    cc: "",
    subject: "",
    body: "",
    inReplyTo: "",
    references: "",
  };
}

export function parseRecipientList(
  raw: unknown,
  field: "to" | "cc",
  required: boolean,
): { ok: true; addresses: string[] } | { ok: false; error: string; hint: string } {
  if (typeof raw !== "string") {
    if (!required) {
      return { ok: true, addresses: [] };
    }
    return {
      ok: false,
      error: "invalid_request",
      hint: 'Send { "to", "subject", "text" } (subject and text may be empty).',
    };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    if (!required) {
      return { ok: true, addresses: [] };
    }
    return {
      ok: false,
      error: "invalid_request",
      hint: "to must be one or more email addresses, for example neighbor@example.test.",
    };
  }

  const addresses = extractAddresses(trimmed);
  if (addresses.length === 0) {
    return {
      ok: false,
      error: "invalid_request",
      hint:
        field === "to"
          ? "to must be one or more email addresses, for example neighbor@example.test."
          : "cc must be email addresses, for example neighbor@example.test.",
    };
  }
  if (addresses.length > RECIPIENT_MAX) {
    return {
      ok: false,
      error: "invalid_request",
      hint: `${field} has too many addresses (max ${RECIPIENT_MAX}).`,
    };
  }
  return { ok: true, addresses };
}

function formatUtcStamp(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

export function composeHeading(mode: ComposeMode): string {
  if (mode === "reply") {
    return "回复";
  }
  if (mode === "reply-all") {
    return "全部回复";
  }
  if (mode === "forward") {
    return "转发";
  }
  return "写信";
}
