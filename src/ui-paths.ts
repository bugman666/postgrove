import type { MailboxRecord } from "./store.ts";
import type { SystemFolder } from "./folders.ts";
import type { ComposeMode } from "./reply.ts";
import { parseInboxFilter, parseSearchQuery, type InboxFilter } from "./triage.ts";

export function boxPath(mailboxId: string, folder: SystemFolder = "inbox"): string {
  const base = `/box/${encodeURIComponent(mailboxId)}`;
  return folder === "inbox" ? base : `${base}?folder=${encodeURIComponent(folder)}`;
}

export function messagePath(
  mailboxId: string,
  messageId: string,
  folder: SystemFolder = "inbox",
): string {
  const path = `/box/${encodeURIComponent(mailboxId)}/m/${encodeURIComponent(messageId)}`;
  return folder === "inbox" ? path : `${path}?folder=${encodeURIComponent(folder)}`;
}

export function inboxHref(mailbox: MailboxRecord | null): string {
  return mailbox ? boxPath(mailbox.id) : "/";
}

export function folderHref(mailbox: MailboxRecord | null, folder: SystemFolder): string {
  return mailbox ? boxPath(mailbox.id, folder) : "/";
}

export function withMailbox(path: string, mailbox: MailboxRecord | null): string {
  if (!mailbox) {
    return path;
  }
  return `${path}?mailbox=${encodeURIComponent(mailbox.id)}`;
}

export function composeHref(
  mailbox: MailboxRecord | null,
  mode: ComposeMode = "new",
  messageId?: string,
  draftId?: string,
): string {
  const params = new URLSearchParams();
  if (mailbox) {
    params.set("mailbox", mailbox.id);
  }
  if (mode !== "new") {
    params.set("mode", mode);
  }
  if (messageId) {
    params.set("message", messageId);
  }
  if (draftId) {
    params.set("draft", draftId);
  }
  const query = params.toString();
  return query ? `/compose?${query}` : "/compose";
}

export function readInboxView(url: URL): { q: string; filter: InboxFilter } {
  return {
    q: parseSearchQuery(url.searchParams.get("q")),
    filter: parseInboxFilter(url.searchParams.get("filter")),
  };
}

export function inboxQuery(
  source: URL | { q?: string; filter?: InboxFilter },
  extra: Record<string, string> = {},
): string {
  const q = source instanceof URL ? parseSearchQuery(source.searchParams.get("q")) : (source.q ?? "");
  const filter =
    source instanceof URL ? parseInboxFilter(source.searchParams.get("filter")) : (source.filter ?? "all");
  const params = new URLSearchParams();
  if (q) {
    params.set("q", q);
  }
  if (filter !== "all") {
    params.set("filter", filter);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value) {
      params.set(key, value);
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function safeNext(raw: string, fallback: string): string {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("://")) {
    return fallback;
  }
  return raw;
}

export function viewHref(mailbox: MailboxRecord, q: string, filter: InboxFilter): string {
  return `${boxPath(mailbox.id)}${inboxQuery({ q, filter })}`;
}

export function messageHref(
  mailbox: MailboxRecord,
  messageId: string,
  q: string,
  filter: InboxFilter,
  extra: Record<string, string> = {},
): string {
  return `${messagePath(mailbox.id, messageId)}${inboxQuery({ q, filter }, extra)}`;
}

export function threadPath(mailboxId: string, threadId: string): string {
  return `/box/${encodeURIComponent(mailboxId)}/t/${encodeURIComponent(threadId)}`;
}

export function threadHref(
  mailbox: MailboxRecord,
  threadId: string,
  q: string,
  filter: InboxFilter,
): string {
  return `${threadPath(mailbox.id, threadId)}${inboxQuery({ q, filter })}`;
}
