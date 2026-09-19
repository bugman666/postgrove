import { extractAddresses, normalizeMessageId } from "./reply.ts";
import type { MessageRecord } from "./store.ts";

export type ThreadKind = "citation" | "subject";

export interface MessageThread {
  id: string;
  kind: ThreadKind;
  messages: MessageRecord[];
}

const SUBJECT_PREFIXES = [
  "re:",
  "fwd:",
  "fw:",
  "forward:",
  "回复:",
  "回复：",
  "转发:",
  "转发：",
];

/**
 * Strip repeated Re:/Fwd: (and Chinese) prefixes. Empty / whitespace-only
 * subjects stay empty so they do not collapse into one catch-all thread.
 */
export function normalizeThreadSubject(subject: string | null | undefined): string {
  let value = (subject ?? "").trim().toLowerCase();
  let changed = true;
  while (changed && value) {
    changed = false;
    for (const prefix of SUBJECT_PREFIXES) {
      if (value.startsWith(prefix)) {
        value = value.slice(prefix.length).trim();
        changed = true;
      }
    }
  }
  return value;
}

export function parseMessageIdTokens(value: string | null | undefined): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of (value ?? "").split(/\s+/)) {
    const id = normalizeMessageId(raw);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    tokens.push(id);
  }
  return tokens;
}

export function citationIds(message: {
  in_reply_to?: string | null;
  references_header?: string | null;
}): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...parseMessageIdTokens(message.in_reply_to),
    ...parseMessageIdTokens(message.references_header),
  ]) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    tokens.push(id);
  }
  return tokens;
}

export function participantKey(message: {
  envelope_from: string;
  envelope_to: string;
}): string {
  const found = uniqueSorted([
    ...extractAddresses(message.envelope_from),
    ...extractAddresses(message.envelope_to),
  ]);
  if (found.length > 0) {
    return found.join(",");
  }
  return uniqueSorted(
    [message.envelope_from, message.envelope_to].map((value) => value.trim().toLowerCase()).filter(Boolean),
  ).join(",");
}

export function subjectFallbackKey(message: {
  subject: string | null;
  envelope_from: string;
  envelope_to: string;
}): string | null {
  const subject = normalizeThreadSubject(message.subject);
  if (!subject) {
    return null;
  }
  return `${subject}\0${participantKey(message)}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function stripAngles(id: string): string {
  return id.startsWith("<") && id.endsWith(">") ? id.slice(1, -1) : id;
}

function fnv1aHex(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    if (this.parent[index] !== index) {
      this.parent[index] = this.find(this.parent[index]);
    }
    return this.parent[index];
  }

  union(left: number, right: number): void {
    const rootLeft = this.find(left);
    const rootRight = this.find(right);
    if (rootLeft !== rootRight) {
      this.parent[rootRight] = rootLeft;
    }
  }
}

function compareReceived(left: MessageRecord, right: MessageRecord): number {
  return left.received_at - right.received_at || left.created_at - right.created_at;
}

function isCitationInvolved(
  message: MessageRecord,
  citedIds: Set<string>,
): boolean {
  if (citationIds(message).length > 0) {
    return true;
  }
  const own = normalizeMessageId(message.rfc_message_id);
  return Boolean(own && citedIds.has(own));
}

export function stableThreadId(members: MessageRecord[], kind: ThreadKind): string {
  const ordered = members.slice().sort(compareReceived);
  if (kind === "citation") {
    for (const message of ordered) {
      const root = parseMessageIdTokens(message.references_header)[0]
        ?? parseMessageIdTokens(message.in_reply_to)[0];
      if (root) {
        return `mid:${stripAngles(root)}`;
      }
    }
    for (const message of ordered) {
      const own = normalizeMessageId(message.rfc_message_id);
      if (own) {
        return `mid:${stripAngles(own)}`;
      }
    }
    return `solo:${ordered[0]?.id ?? "empty"}`;
  }

  const first = ordered[0];
  if (!first) {
    return "solo:empty";
  }
  const key = subjectFallbackKey(first);
  if (!key) {
    return `solo:${first.id}`;
  }
  return `subj:${fnv1aHex(key)}`;
}

/**
 * Group a mailbox list into conversations.
 *
 * 1. Citation: union messages that share In-Reply-To / References tokens,
 *    or whose Message-ID is cited by another row.
 * 2. Subject fallback: remaining messages with the same normalized subject
 *    and the same participant pair (from+to). Empty subjects stay singleton.
 */
export function groupMessagesIntoThreads(messages: MessageRecord[]): MessageThread[] {
  const size = messages.length;
  const union = new UnionFind(size);
  const byRfc = new Map<string, number[]>();
  const byCitation = new Map<string, number[]>();
  const citedIds = new Set<string>();

  for (let index = 0; index < size; index += 1) {
    const own = normalizeMessageId(messages[index].rfc_message_id);
    if (own) {
      const list = byRfc.get(own) ?? [];
      list.push(index);
      byRfc.set(own, list);
    }
    for (const id of citationIds(messages[index])) {
      citedIds.add(id);
      const cited = byCitation.get(id) ?? [];
      cited.push(index);
      byCitation.set(id, cited);
    }
  }

  for (const [id, indexes] of byCitation) {
    for (let offset = 1; offset < indexes.length; offset += 1) {
      union.union(indexes[0], indexes[offset]);
    }
    const known = byRfc.get(id);
    if (!known) {
      continue;
    }
    for (const rfcIndex of known) {
      union.union(indexes[0], rfcIndex);
    }
  }

  const citationRoots = new Set<number>();
  for (let index = 0; index < size; index += 1) {
    if (isCitationInvolved(messages[index], citedIds)) {
      citationRoots.add(union.find(index));
    }
  }

  const bySubject = new Map<string, number[]>();
  for (let index = 0; index < size; index += 1) {
    if (citationRoots.has(union.find(index))) {
      continue;
    }
    const key = subjectFallbackKey(messages[index]);
    if (!key) {
      continue;
    }
    const list = bySubject.get(key) ?? [];
    list.push(index);
    bySubject.set(key, list);
  }
  for (const indexes of bySubject.values()) {
    for (let offset = 1; offset < indexes.length; offset += 1) {
      union.union(indexes[0], indexes[offset]);
    }
  }

  const groups = new Map<number, MessageRecord[]>();
  for (let index = 0; index < size; index += 1) {
    const root = union.find(index);
    const list = groups.get(root) ?? [];
    list.push(messages[index]);
    groups.set(root, list);
  }

  const threads: MessageThread[] = [];
  for (const members of groups.values()) {
    const ordered = members.slice().sort(compareReceived);
    const kind: ThreadKind = ordered.some((message) => isCitationInvolved(message, citedIds))
      ? "citation"
      : "subject";
    threads.push({
      id: stableThreadId(ordered, kind),
      kind,
      messages: ordered,
    });
  }

  return threads.sort((left, right) => {
    const latestLeft = left.messages[left.messages.length - 1];
    const latestRight = right.messages[right.messages.length - 1];
    return (
      latestRight.received_at - latestLeft.received_at
      || latestRight.created_at - latestLeft.created_at
    );
  });
}

export function findThreadById(
  threads: MessageThread[],
  threadId: string,
): MessageThread | null {
  const key = threadId.trim();
  if (!key) {
    return null;
  }
  return threads.find((thread) => thread.id === key) ?? null;
}

export function findThreadForMessage(
  threads: MessageThread[],
  messageId: string,
): MessageThread | null {
  return threads.find((thread) => thread.messages.some((row) => row.id === messageId)) ?? null;
}

export function latestThreadMessage(thread: MessageThread): MessageRecord {
  return thread.messages[thread.messages.length - 1];
}

export function threadHasUnread(thread: MessageThread): boolean {
  return thread.messages.some((row) => row.is_read !== 1);
}

export function threadHasStar(thread: MessageThread): boolean {
  return thread.messages.some((row) => row.is_starred === 1);
}
