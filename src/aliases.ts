import type { Env } from "./env.ts";
import { escapeHtml } from "./html.ts";
import { getMailbox, parseMailboxAddress, type MailboxRecord } from "./store.ts";

export const MAX_ALIASES_PER_MAILBOX = 50;
export const ALIAS_TAG_BYTES = 4;

export type AliasErrorCode =
  | "invalid_address"
  | "alias_domain_forbidden"
  | "alias_taken"
  | "alias_primary"
  | "alias_limit"
  | "not_found";

export class AliasInputError extends Error {
  readonly error: AliasErrorCode;

  constructor(error: AliasErrorCode, hint: string) {
    super(hint);
    this.error = error;
  }
}

export interface MailboxAliasRecord {
  id: string;
  mailbox_id: string;
  local_part: string;
  domain: string;
  created_at: number;
}

export interface AddressParts {
  address: string;
  localPart: string;
  domain: string;
}

export interface InboundResolve {
  mailbox: { id: string; status: string; address: string };
  envelopeTo: string;
  via: "exact" | "plus_tag" | "alias";
}

const ALIAS_COLUMNS = "id, mailbox_id, local_part, domain, created_at" as const;

/**
 * RFC 5233 / Gmail-like subaddress: first `+` starts the tag.
 * `user+tag@domain` and `user+tag+more@domain` both strip to `user@domain`.
 * A leading `+` is not a tag (`+tag@domain` stays as-is and will not match a mailbox).
 */
export function stripPlusTag(localPart: string): { localPart: string; tag: string | null } {
  const plus = localPart.indexOf("+");
  if (plus <= 0) {
    return { localPart, tag: null };
  }
  return {
    localPart: localPart.slice(0, plus),
    tag: localPart.slice(plus + 1),
  };
}

export function splitRecipient(value: string): AddressParts {
  const address = value.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) {
    throw new Error("invalid address");
  }
  return {
    address,
    localPart: address.slice(0, at),
    domain: address.slice(at + 1),
  };
}

export function primaryAddressFromPlusTag(value: string): AddressParts {
  const parsed = splitRecipient(value);
  const stripped = stripPlusTag(parsed.localPart);
  if (!stripped.tag && stripped.localPart === parsed.localPart) {
    return parsed;
  }
  return {
    address: `${stripped.localPart}@${parsed.domain}`,
    localPart: stripped.localPart,
    domain: parsed.domain,
  };
}

export function aliasAddress(row: Pick<MailboxAliasRecord, "local_part" | "domain">): string {
  return `${row.local_part}@${row.domain}`;
}

export function publicAlias(row: MailboxAliasRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    address: aliasAddress(row),
    local_part: row.local_part,
    domain: row.domain,
    created_at: row.created_at,
  };
}

export function generatePlusTag(): string {
  const bytes = new Uint8Array(ALIAS_TAG_BYTES);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function proposedGeneratedAddress(mailbox: MailboxRecord, tag = generatePlusTag()): string {
  return `${mailbox.local_part}+${tag}@${mailbox.domain}`;
}

/**
 * Resolve an inbound envelope recipient to a mailbox.
 * Order: exact address, then +tag strip to the primary local, then mailbox_aliases.
 * envelopeTo is always the original recipient (so search can find the tag).
 */
export async function resolveInboundMailbox(
  env: Env,
  recipient: string,
): Promise<InboundResolve | null> {
  let parsed: AddressParts;
  try {
    parsed = splitRecipient(recipient);
  } catch {
    return null;
  }

  const exact = await lookupMailboxRow(env, parsed.address);
  if (exact) {
    return { mailbox: exact, envelopeTo: parsed.address, via: "exact" };
  }

  const primary = primaryAddressFromPlusTag(parsed.address);
  if (primary.address !== parsed.address) {
    const plusMailbox = await lookupMailboxRow(env, primary.address);
    if (plusMailbox) {
      return { mailbox: plusMailbox, envelopeTo: parsed.address, via: "plus_tag" };
    }
    const plusAlias = await findAliasByAddress(env, primary.localPart, primary.domain);
    if (plusAlias) {
      const mailbox = await lookupMailboxRowById(env, plusAlias.mailbox_id);
      if (mailbox) {
        return { mailbox, envelopeTo: parsed.address, via: "alias" };
      }
    }
  }

  const alias = await findAliasByAddress(env, parsed.localPart, parsed.domain);
  if (alias) {
    const mailbox = await lookupMailboxRowById(env, alias.mailbox_id);
    if (mailbox) {
      return { mailbox, envelopeTo: parsed.address, via: "alias" };
    }
  }

  return null;
}

export async function listAliases(env: Env, mailboxId: string): Promise<MailboxAliasRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${ALIAS_COLUMNS} FROM mailbox_aliases
     WHERE mailbox_id = ?1
     ORDER BY created_at DESC`,
  )
    .bind(mailboxId)
    .all<MailboxAliasRecord>();
  return rows.results ?? [];
}

export async function getAlias(env: Env, aliasId: string): Promise<MailboxAliasRecord | null> {
  return env.DB.prepare(`SELECT ${ALIAS_COLUMNS} FROM mailbox_aliases WHERE id = ?1`)
    .bind(aliasId)
    .first<MailboxAliasRecord>();
}

export async function findAliasByAddress(
  env: Env,
  localPart: string,
  domain: string,
): Promise<MailboxAliasRecord | null> {
  return env.DB.prepare(
    `SELECT ${ALIAS_COLUMNS} FROM mailbox_aliases
     WHERE local_part = ?1 AND domain = ?2`,
  )
    .bind(localPart.toLowerCase(), domain.toLowerCase())
    .first<MailboxAliasRecord>();
}

export async function countAliases(env: Env, mailboxId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM mailbox_aliases WHERE mailbox_id = ?1`,
  )
    .bind(mailboxId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function createAlias(
  env: Env,
  mailbox: MailboxRecord,
  rawAddress: string,
  now = Date.now(),
): Promise<MailboxAliasRecord> {
  const parsed = parseMailboxAddress(rawAddress);
  if (!parsed) {
    throw new AliasInputError(
      "invalid_address",
      "Alias must look like local+tag@your-domain (one address, no spaces).",
    );
  }
  assertOwnDomain(mailbox, parsed.domain);
  if (parsed.address === mailbox.address) {
    throw new AliasInputError(
      "alias_primary",
      "That address is already the mailbox primary. Generate a +tag instead.",
    );
  }
  const takenByMailbox = await getMailbox(env, parsed.address);
  if (takenByMailbox) {
    throw new AliasInputError(
      "alias_taken",
      "That address already belongs to another mailbox in this grove.",
    );
  }
  const takenByAlias = await findAliasByAddress(env, parsed.localPart, parsed.domain);
  if (takenByAlias) {
    throw new AliasInputError("alias_taken", "That alias is already listed. Choose another tag.");
  }
  const used = await countAliases(env, mailbox.id);
  if (used >= MAX_ALIASES_PER_MAILBOX) {
    throw new AliasInputError(
      "alias_limit",
      `This mailbox already has ${MAX_ALIASES_PER_MAILBOX} aliases. Revoke one before adding another.`,
    );
  }

  const row: MailboxAliasRecord = {
    id: crypto.randomUUID(),
    mailbox_id: mailbox.id,
    local_part: parsed.localPart,
    domain: parsed.domain,
    created_at: now,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO mailbox_aliases (id, mailbox_id, local_part, domain, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(row.id, row.mailbox_id, row.local_part, row.domain, row.created_at)
      .run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    if (/UNIQUE/i.test(detail)) {
      throw new AliasInputError("alias_taken", "That alias is already listed. Choose another tag.");
    }
    throw error;
  }
  return row;
}

export async function generateAlias(
  env: Env,
  mailbox: MailboxRecord,
  now = Date.now(),
): Promise<MailboxAliasRecord> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const address = proposedGeneratedAddress(mailbox);
    try {
      return await createAlias(env, mailbox, address, now);
    } catch (error) {
      if (error instanceof AliasInputError && error.error === "alias_taken") {
        continue;
      }
      throw error;
    }
  }
  throw new AliasInputError("alias_taken", "Could not mint a unique +tag. Retry.");
}

export async function deleteAlias(
  env: Env,
  aliasId: string,
  mailboxId: string | null,
): Promise<MailboxAliasRecord | null> {
  const existing = await getAlias(env, aliasId);
  if (!existing) {
    return null;
  }
  if (mailboxId && existing.mailbox_id !== mailboxId) {
    return null;
  }
  await env.DB.prepare(`DELETE FROM mailbox_aliases WHERE id = ?1`).bind(aliasId).run();
  return existing;
}

export function assertOwnDomain(mailbox: MailboxRecord, domain: string): void {
  if (domain.trim().toLowerCase() !== mailbox.domain.toLowerCase()) {
    throw new AliasInputError(
      "alias_domain_forbidden",
      `Aliases must use this mailbox's own domain (${mailbox.domain}). Cross-domain aliases are not allowed.`,
    );
  }
}

export function aliasHttpStatus(error: AliasErrorCode): number {
  if (error === "alias_taken") {
    return 409;
  }
  if (error === "not_found") {
    return 404;
  }
  if (error === "alias_limit") {
    return 409;
  }
  return 400;
}

/** Settings panel snippet. Addresses are HTML-escaped (no raw local parts). */
export function renderAliasPanelHtml(
  mailbox: MailboxRecord | null,
  aliases: MailboxAliasRecord[],
  copy: {
    heading: string;
    hint: string;
    generate: string;
    custom: string;
    submit: string;
    empty: string;
    primary: string;
  },
): string {
  if (!mailbox) {
    return `<section class="grove-panel">
          <h2>${escapeHtml(copy.heading)}</h2>
          <p class="banner">${escapeHtml(copy.empty)}</p>
        </section>`;
  }
  const items = aliases.length
    ? `<ul class="addr-list">${aliases
        .map((row) => {
          const address = aliasAddress(row);
          return `<li>
        <span class="mono">${escapeHtml(address)}</span>
      </li>`;
        })
        .join("")}</ul>`
    : `<p class="banner">${escapeHtml(copy.empty)}</p>`;
  return `<section class="grove-panel">
          <h2>${escapeHtml(copy.heading)}</h2>
          <p class="banner">${escapeHtml(copy.hint)}</p>
          <p class="banner">${escapeHtml(copy.primary)} <span class="mono">${escapeHtml(mailbox.address)}</span></p>
          ${items}
          <form class="grove-form" method="post" action="/settings">
            <input type="hidden" name="intent" value="alias">
            <input type="hidden" name="action" value="generate">
            <button class="btn btn-primary" type="submit">${escapeHtml(copy.generate)}</button>
          </form>
          <form class="grove-form" method="post" action="/settings">
            <input type="hidden" name="intent" value="alias">
            <input type="hidden" name="action" value="create">
            <label>${escapeHtml(copy.custom)}
              <input class="search" name="address" type="email" placeholder="${escapeHtml(`${mailbox.local_part}+shop@${mailbox.domain}`)}">
            </label>
            <button class="btn" type="submit">${escapeHtml(copy.submit)}</button>
          </form>
        </section>`;
}

async function lookupMailboxRow(
  env: Env,
  address: string,
): Promise<{ id: string; status: string; address: string } | null> {
  return env.DB.prepare(`SELECT id, status, address FROM mailboxes WHERE address = ?1`)
    .bind(address)
    .first<{ id: string; status: string; address: string }>();
}

async function lookupMailboxRowById(
  env: Env,
  mailboxId: string,
): Promise<{ id: string; status: string; address: string } | null> {
  return env.DB.prepare(`SELECT id, status, address FROM mailboxes WHERE id = ?1`)
    .bind(mailboxId)
    .first<{ id: string; status: string; address: string }>();
}
