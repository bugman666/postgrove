import { listAttachmentsForMessages, type AttachmentRecord } from "./attachments.ts";
import type { Env } from "./env.ts";
import {
  getMailboxMessagesByIds,
  listInboxMessageHeads,
  markMessagesReadLocally,
  markReadMany,
  type MessageRecord,
} from "./store.ts";
import {
  findThreadById,
  findThreadForMessage,
  groupMessagesIntoThreads,
  type MessageThread,
} from "./threads.ts";
import type { InboxFilter } from "./triage.ts";

export type InboxView = { q: string; filter: InboxFilter };

export function inboxNeedsFullScan(view: InboxView): boolean {
  return Boolean(view.q) || view.filter !== "all";
}

export async function loadInboxHeads(
  env: Env,
  mailboxId: string,
  view: InboxView,
): Promise<{ listed: MessageRecord[]; allInbox: MessageRecord[] }> {
  const listed = await listInboxMessageHeads(env, mailboxId, view);
  if (!inboxNeedsFullScan(view)) {
    return { listed, allInbox: listed };
  }
  return {
    listed,
    allInbox: await listInboxMessageHeads(env, mailboxId, {}),
  };
}

export function applyListedAfterRead(
  listed: MessageRecord[],
  view: InboxView,
  readIds: Iterable<string>,
): MessageRecord[] {
  const updated = markMessagesReadLocally(listed, readIds);
  if (view.filter === "unread") {
    return updated.filter((row) => row.is_read !== 1);
  }
  return updated;
}

export async function hydrateThread(
  env: Env,
  mailboxId: string,
  thread: MessageThread,
  readIds: Iterable<string> = [],
): Promise<{ thread: MessageThread; attachments: AttachmentRecord[] }> {
  const ids = thread.messages.map((row) => row.id);
  const [bodies, attachments] = await Promise.all([
    getMailboxMessagesByIds(env, mailboxId, ids),
    listAttachmentsForMessages(env, mailboxId, ids),
  ]);
  const byId = new Map(bodies.map((row) => [row.id, row]));
  const marked = readIds instanceof Set ? readIds : new Set(readIds);
  return {
    thread: {
      ...thread,
      messages: thread.messages.map((member) => {
        const full = byId.get(member.id) ?? member;
        return marked.has(member.id) ? { ...full, is_read: 1 } : full;
      }),
    },
    attachments,
  };
}

export function unreadInboxIds(messages: readonly MessageRecord[]): string[] {
  return messages
    .filter((row) => row.folder === "inbox" && row.is_read !== 1)
    .map((row) => row.id);
}

export async function openThreadForRead(
  env: Env,
  mailboxId: string,
  threadId: string,
  view: InboxView,
): Promise<{
  visible: boolean;
  listed: MessageRecord[];
  thread: MessageThread | null;
  attachments: AttachmentRecord[];
}> {
  const { listed, allInbox } = await loadInboxHeads(env, mailboxId, view);
  const visible = findThreadById(groupMessagesIntoThreads(listed), threadId);
  if (!visible) {
    return { visible: false, listed, thread: null, attachments: [] };
  }
  const thread = findThreadById(groupMessagesIntoThreads(allInbox), threadId) ?? visible;
  const readIds = unreadInboxIds(thread.messages);
  if (readIds.length > 0) {
    await markReadMany(env, mailboxId, readIds);
  }
  const opened = await hydrateThread(env, mailboxId, thread, readIds);
  return {
    visible: true,
    listed: applyListedAfterRead(listed, view, readIds),
    thread: opened.thread,
    attachments: opened.attachments,
  };
}

export async function openInboxMessageForRead(
  env: Env,
  mailboxId: string,
  message: MessageRecord,
  view: InboxView,
  alreadyMarked = false,
): Promise<{
  listed: MessageRecord[];
  thread: MessageThread | null;
  attachments: AttachmentRecord[];
  message: MessageRecord;
}> {
  const readIds = !alreadyMarked && message.folder === "inbox" && message.is_read !== 1
    ? [message.id]
    : alreadyMarked && message.folder === "inbox"
      ? [message.id]
      : [];
  if (!alreadyMarked && readIds.length > 0) {
    await markReadMany(env, mailboxId, readIds);
  }
  const { listed, allInbox } = await loadInboxHeads(env, mailboxId, view);
  const thread = findThreadForMessage(groupMessagesIntoThreads(allInbox), message.id);
  if (!thread) {
    const attachments = await listAttachmentsForMessages(env, mailboxId, [message.id]);
    const opened = readIds.length > 0 ? { ...message, is_read: 1 } : message;
    return {
      listed: applyListedAfterRead(listed, view, readIds),
      thread: null,
      attachments,
      message: opened,
    };
  }
  const opened = await hydrateThread(env, mailboxId, thread, readIds);
  const selected =
    opened.thread.messages.find((row) => row.id === message.id)
    ?? (readIds.length > 0 ? { ...message, is_read: 1 } : message);
  return {
    listed: applyListedAfterRead(listed, view, readIds),
    thread: opened.thread,
    attachments: opened.attachments,
    message: selected,
  };
}

