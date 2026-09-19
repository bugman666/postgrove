import { listAliases } from "./aliases.ts";
import { listApiTokens } from "./api-tokens.ts";
import type { MailboxActor } from "./auth.ts";
import type { Env } from "./env.ts";
import type { MailboxRecord } from "./store.ts";

export type NavContext = {
  showAdmin: boolean;
  hasAliases: boolean;
  hasApiKey: boolean;
};

export function emptyNav(): NavContext {
  return { showAdmin: false, hasAliases: false, hasApiKey: false };
}

export function isMailboxAdmin(actor: MailboxActor | null | undefined): boolean {
  return actor?.kind === "mailbox" && actor.role === "admin";
}

export async function resolveNavContext(
  env: Env,
  actor: MailboxActor | null | undefined,
  mailbox: MailboxRecord | null | undefined,
): Promise<NavContext> {
  const showAdmin = isMailboxAdmin(actor);
  if (!mailbox) {
    return { showAdmin, hasAliases: false, hasApiKey: false };
  }
  let hasAliases = false;
  let hasApiKey = false;
  try {
    const aliases = await listAliases(env, mailbox.id);
    hasAliases = aliases.length > 0;
  } catch {
    hasAliases = false;
  }
  try {
    const tokens = await listApiTokens(env, mailbox.id);
    hasApiKey = tokens.some((row) => !row.revoked_at);
  } catch {
    hasApiKey = false;
  }
  return { showAdmin, hasAliases, hasApiKey };
}
