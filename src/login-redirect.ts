import type { Env } from "./env.ts";
import {
  countInboxMessages,
  listMailboxes,
  listMailboxesForUser,
  type MailboxRecord,
} from "./store.ts";
import { boxPath } from "./ui-paths.ts";

export type LoginMailboxCandidate = {
  id: string;
  address: string;
  message_count: number;
};

export type LoginLanding = {
  mailbox: { id: string; address: string };
  redirect: string;
};

/**
 * Choose the inbox to open after login.
 *
 * Bound mailbox wins when it already has mail. Otherwise prefer any candidate
 * with `message_count > 0` (seeded inbox, not merely `mailboxes[0]` if empty).
 * Fallback: bound mailbox, then first candidate.
 */
export function pickLoginMailbox(
  candidates: LoginMailboxCandidate[],
  boundMailboxId?: string | null,
): LoginMailboxCandidate | null {
  if (candidates.length === 0) {
    return null;
  }
  const bound = boundMailboxId
    ? candidates.find((row) => row.id === boundMailboxId)
    : undefined;
  if (bound && bound.message_count > 0) {
    return bound;
  }
  const withMail = candidates.find((row) => row.message_count > 0);
  if (withMail) {
    return withMail;
  }
  return bound ?? candidates[0] ?? null;
}

export function loginRedirectPath(mailbox: { id: string } | null | undefined): string {
  return mailbox ? boxPath(mailbox.id) : "/";
}

export async function resolveLoginLanding(
  env: Env,
  options: {
    kind: "owner" | "mailbox";
    bound: { id: string; address: string };
    userId?: string;
    /** When set, pick among these instead of loading from the store. */
    mailboxes?: MailboxRecord[];
  },
): Promise<LoginLanding> {
  const fallback: LoginLanding = {
    mailbox: options.bound,
    redirect: loginRedirectPath(options.bound),
  };
  try {
    const boxes = await loadLoginCandidates(env, options);
    const picked = pickLoginMailbox(boxes, options.bound.id);
    if (!picked) {
      return fallback;
    }
    return {
      mailbox: { id: picked.id, address: picked.address },
      redirect: loginRedirectPath(picked),
    };
  } catch {
    return fallback;
  }
}

async function loadLoginCandidates(
  env: Env,
  options: {
    kind: "owner" | "mailbox";
    bound: { id: string; address: string };
    userId?: string;
    mailboxes?: MailboxRecord[];
  },
): Promise<LoginMailboxCandidate[]> {
  let boxes: MailboxRecord[];
  if (options.mailboxes) {
    boxes = options.mailboxes;
  } else if (options.kind === "mailbox" && options.userId) {
    boxes = await listMailboxesForUser(env, options.userId);
  } else {
    boxes = await listMailboxes(env);
  }
  const active = boxes.filter((row) => !row.status || row.status === "active");
  const candidates: LoginMailboxCandidate[] = [];
  for (const box of active) {
    candidates.push({
      id: box.id,
      address: box.address,
      message_count: await countInboxMessages(env, box.id),
    });
  }
  if (candidates.length === 0 || !candidates.some((row) => row.id === options.bound.id)) {
    candidates.unshift({
      id: options.bound.id,
      address: options.bound.address,
      message_count: await countInboxMessages(env, options.bound.id),
    });
  }
  return candidates;
}
