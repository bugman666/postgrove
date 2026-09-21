/**
 * Shared in-memory D1 for unit tests.
 *
 * Several files used to each ship a MemoryD1 that understood a slightly
 * different SQL subset. Import this helper instead of forking another copy.
 *
 * Usage:
 *
 *   import { MemoryD1 } from "./helpers/memory-d1.ts";
 *
 *   const db = new MemoryD1({
 *     mailboxes: [{ id, address, status: "active", created_at: 1, updated_at: 1 }],
 *     messages: [{ id, mailbox_id, folder: "inbox", received_at: 1, ... }],
 *   });
 *   const env = { DB: db.asDatabase(), SESSION_SECRET, OWNER_TOKEN, ADMIN_TOKEN };
 *
 * Seed only the tables the test needs. The helper matches SQL used by
 * store / inbound persist / RBAC / token REST / attachments / aliases /
 * webhooks / dev inboxes. If a new query misses, extend this file — do not
 * add another in-file MemoryD1.
 */

export type MemoryRow = Record<string, unknown>;

export interface MemoryD1Seed {
  mailboxes?: MemoryRow[];
  messages?: MemoryRow[];
  users?: MemoryRow[];
  user_mailboxes?: MemoryRow[];
  send_usage?: MemoryRow[];
  api_tokens?: MemoryRow[];
  outbound_attempts?: MemoryRow[];
  attachments?: MemoryRow[];
  mailbox_aliases?: MemoryRow[];
  api_token_usage?: MemoryRow[];
  inbound_hooks?: MemoryRow[];
  inbound_deliveries?: MemoryRow[];
  dev_inboxes?: MemoryRow[];
  site_settings?: MemoryRow[];
}

const KNOWN_TABLES = [
  "mailboxes",
  "messages",
  "outbound_attempts",
  "api_tokens",
  "users",
  "inbound_hooks",
  "inbound_deliveries",
  "dev_inboxes",
  "mailbox_aliases",
  "attachments",
  "site_settings",
] as const;

export class MemoryD1 {
  mailboxes: MemoryRow[];
  messages: MemoryRow[];
  users: MemoryRow[];
  user_mailboxes: MemoryRow[];
  send_usage: MemoryRow[];
  api_tokens: MemoryRow[];
  outbound_attempts: MemoryRow[];
  attachments: MemoryRow[];
  mailbox_aliases: MemoryRow[];
  api_token_usage: MemoryRow[];
  inbound_hooks: MemoryRow[];
  inbound_deliveries: MemoryRow[];
  dev_inboxes: MemoryRow[];
  site_settings: MemoryRow[];

  /** Names used by older in-file fakes — same arrays. */
  get tokens(): MemoryRow[] {
    return this.api_tokens;
  }
  get attempts(): MemoryRow[] {
    return this.outbound_attempts;
  }
  get aliases(): MemoryRow[] {
    return this.mailbox_aliases;
  }
  get usage(): MemoryRow[] {
    return this.api_token_usage;
  }
  get hooks(): MemoryRow[] {
    return this.inbound_hooks;
  }
  get inboxes(): MemoryRow[] {
    return this.dev_inboxes;
  }

  constructor(seed: MemoryD1Seed = {}) {
    this.mailboxes = seed.mailboxes ? seed.mailboxes.map(cloneRow) : [];
    this.messages = seed.messages ? seed.messages.map(cloneRow) : [];
    this.users = seed.users ? seed.users.map(cloneRow) : [];
    this.user_mailboxes = seed.user_mailboxes ? seed.user_mailboxes.map(cloneRow) : [];
    this.send_usage = seed.send_usage ? seed.send_usage.map(cloneRow) : [];
    this.api_tokens = seed.api_tokens ? seed.api_tokens.map(cloneRow) : [];
    this.outbound_attempts = seed.outbound_attempts ? seed.outbound_attempts.map(cloneRow) : [];
    this.attachments = seed.attachments ? seed.attachments.map(cloneRow) : [];
    this.mailbox_aliases = seed.mailbox_aliases ? seed.mailbox_aliases.map(cloneRow) : [];
    this.api_token_usage = seed.api_token_usage ? seed.api_token_usage.map(cloneRow) : [];
    this.inbound_hooks = seed.inbound_hooks ? seed.inbound_hooks.map(cloneRow) : [];
    this.inbound_deliveries = seed.inbound_deliveries ? seed.inbound_deliveries.map(cloneRow) : [];
    this.dev_inboxes = seed.dev_inboxes ? seed.dev_inboxes.map(cloneRow) : [];
    this.site_settings = seed.site_settings ? seed.site_settings.map(cloneRow) : [];
  }

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(this, sql);
  }

  asDatabase(): D1Database {
    return this as unknown as D1Database;
  }
}

export class MemoryStatement {
  db: MemoryD1;
  sql: string;
  binds: unknown[] = [];

  constructor(db: MemoryD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]): this {
    this.binds = args;
    return this;
  }

  async first(): Promise<MemoryRow | null> {
    return this.rows()[0] ?? null;
  }

  async all(): Promise<{ results: MemoryRow[] }> {
    return { results: this.rows() };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: this.mutate() } };
  }

  rows(): MemoryRow[] {
    const sql = collapse(this.sql);
    const [a, b] = this.binds;

    if (sql.includes("from sqlite_master")) {
      return KNOWN_TABLES.map((name) => ({ name }));
    }

    if (sql.includes("count(*) as n from dev_inboxes")) {
      let rows = this.db.dev_inboxes.slice();
      if (sql.includes("owner_mailbox_id =")) {
        rows = rows.filter(
          (row) =>
            row.owner_mailbox_id === a &&
            row.status === "open" &&
            Number(row.expires_at) > Number(b),
        );
      } else {
        rows = rows.filter((row) => row.status === "open" && Number(row.expires_at) > Number(a));
      }
      return [{ n: rows.length }];
    }

    if (sql.includes("from users")) {
      let rows = this.db.users.slice();
      if (sql.includes("from user_mailboxes where mailbox_id")) {
        const ids = new Set(
          this.db.user_mailboxes.filter((row) => row.mailbox_id === a).map((row) => row.user_id),
        );
        rows = rows.filter((row) => ids.has(row.id));
        if (sql.includes("status = 'active'")) {
          rows = rows.filter((row) => row.status === "active");
        }
      } else if (sql.includes("where login =")) {
        rows = rows.filter((row) => String(row.login).toLowerCase() === String(a).toLowerCase());
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      }
      if (sql.includes("select count(*)")) {
        return [{ n: rows.length }];
      }
      return rows;
    }

    if (
      sql.includes("from user_mailboxes") &&
      !sql.includes("from messages") &&
      !sql.includes("from users") &&
      !sql.includes("from mailboxes")
    ) {
      let rows = this.db.user_mailboxes.slice();
      if (sql.includes("where user_id =")) {
        rows = rows.filter((row) => row.user_id === a);
      }
      if (sql.includes("select count(*)")) {
        return [{ n: rows.length }];
      }
      return rows;
    }

    if (sql.includes("from send_usage")) {
      return this.db.send_usage.filter((row) => row.user_id === a && row.day === b);
    }

    if (sql.includes("from mailbox_aliases")) {
      let rows = this.db.mailbox_aliases.slice();
      if (sql.includes("select count(*)")) {
        rows = rows.filter((row) => row.mailbox_id === a);
        return [{ n: rows.length }];
      }
      if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("where local_part =") && sql.includes("and domain =")) {
        rows = rows.filter(
          (row) =>
            String(row.local_part).toLowerCase() === String(a).toLowerCase() &&
            String(row.domain).toLowerCase() === String(b).toLowerCase(),
        );
      } else if (sql.includes("where mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }

    if (sql.includes("from api_tokens")) {
      let rows = this.db.api_tokens.slice();
      if (sql.includes("where token_hash =")) {
        rows = rows.filter((row) => row.token_hash === a);
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("where mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }

    if (sql.includes("from api_token_usage")) {
      return this.db.api_token_usage.filter((row) => row.token_id === a && row.day === b);
    }

    if (sql.includes("from inbound_hooks")) {
      if (sql.includes("where mailbox_id") || sql.includes("mailbox_id =")) {
        return this.db.inbound_hooks.filter((row) => row.mailbox_id === a);
      }
      return this.db.inbound_hooks.slice();
    }

    if (sql.includes("from inbound_deliveries")) {
      let rows = this.db.inbound_deliveries.slice();
      if (sql.includes("delivery_key =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.delivery_key === this.binds[1]);
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("status = 'pending'") && sql.includes("next_attempt_at")) {
        rows = rows.filter(
          (row) =>
            row.status === "pending" &&
            row.next_attempt_at != null &&
            Number(row.next_attempt_at) <= Number(a),
        );
        return rows.sort((left, right) => Number(left.next_attempt_at) - Number(right.next_attempt_at));
      } else if (sql.includes("where mailbox_id") && sql.includes("status =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.status === this.binds[1]);
      } else if (sql.includes("where mailbox_id") || sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      } else if (sql.includes("where status =")) {
        rows = rows.filter((row) => row.status === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }

    if (sql.includes("from attachments")) {
      if (sql.includes("sum(size_bytes)")) {
        const n = this.db.attachments.reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0);
        return [{ n, used: n }];
      }
      let rows = this.db.attachments.slice();
      if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("mailbox_id =") && sql.includes("message_id in")) {
        const ids = new Set(this.binds.slice(1));
        rows = rows.filter((row) => row.mailbox_id === a && ids.has(row.message_id));
      } else if (sql.includes("mailbox_id =") && sql.includes("message_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.message_id === b);
      } else if (sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows;
    }

    if (sql.includes("from site_settings")) {
      return this.db.site_settings.slice();
    }

    if (sql.includes("from dev_inboxes")) {
      let rows = this.db.dev_inboxes.slice();
      if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("where mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      } else if (sql.includes("where owner_mailbox_id =")) {
        rows = rows.filter((row) => row.owner_mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }

    if (sql.includes("distinct domain from mailboxes")) {
      return [...new Set(this.db.mailboxes.map((row) => String(row.domain)))].map((domain) => ({
        domain,
      }));
    }

    if (sql.includes("from mailboxes")) {
      let rows = this.db.mailboxes.slice();
      if (sql.includes("where address =")) {
        rows = rows.filter((row) => row.address === String(a).toLowerCase());
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("select mailbox_id from user_mailboxes")) {
        const ids = new Set(
          this.db.user_mailboxes.filter((row) => row.user_id === a).map((row) => row.mailbox_id),
        );
        rows = rows.filter((row) => ids.has(row.id));
      } else {
        rows = rows
          .slice()
          .sort(
            (left, right) =>
              Number(left.created_at ?? 0) - Number(right.created_at ?? 0) ||
              String(left.address ?? "").localeCompare(String(right.address ?? "")),
          );
      }
      return rows;
    }

    if (sql.includes("from messages")) {
      let rows = this.db.messages.slice();
      if (sql.includes("sum(size_bytes)") || sql.includes("as used")) {
        const ids = new Set(
          this.db.user_mailboxes.filter((row) => row.user_id === a).map((row) => row.mailbox_id),
        );
        const used = rows
          .filter((row) => ids.has(row.mailbox_id))
          .reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0);
        return [{ used }];
      }
      if (sql.includes("select count(*)")) {
        rows = rows.filter((row) => {
          const folder = String(row.folder ?? "");
          if (sql.includes("mailbox_id =") && row.mailbox_id !== a) {
            return false;
          }
          if (sql.includes("folder = 'inbox'") && folder !== "inbox") {
            return false;
          }
          if (sql.includes("is_read = 0") && Number(row.is_read ?? 0) !== 0) {
            return false;
          }
          if (sql.includes("folder in") && folder !== "inbox" && folder !== "sent") {
            return false;
          }
          const at = Number(row.received_at);
          if (typeof a === "number" && typeof b === "number") {
            return at >= a && at < b;
          }
          return true;
        });
        const n = rows.length;
        return [{ n, message_count: n, unread_count: n }];
      }
      if (sql.includes("where id =") && sql.includes("mailbox_id =") && sql.includes("folder = 'inbox'")) {
        rows = rows.filter((row) => row.id === a && row.mailbox_id === b && row.folder === "inbox");
      } else if (sql.includes("where id =") && sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.id === a && row.mailbox_id === b);
      } else if (sql.includes("where id =")) {
        rows = rows.filter((row) => row.id === a);
      } else if (sql.includes("folder = 'inbox'")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.folder === "inbox");
      } else if (sql.includes("folder = ?2") || sql.includes("and folder = ?")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.folder === b);
      } else if (sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      if (sql.includes("like")) {
        const needle = String(b ?? a ?? "")
          .replace(/^%/, "")
          .replace(/%$/, "")
          .toLowerCase();
        rows = rows.filter((row) => {
          const hay = [row.envelope_from, row.envelope_to, row.subject, row.body_text]
            .map((value) => String(value ?? "").toLowerCase())
            .join("\n");
          return hay.includes(needle);
        });
      }
      return rows.sort((left, right) => Number(right.received_at) - Number(left.received_at));
    }

    if (sql.includes("from outbound_attempts")) {
      let rows = this.db.outbound_attempts.slice();
      if (sql.includes("idempotency_key =")) {
        rows = rows.filter((row) => row.mailbox_id === a && row.idempotency_key === b);
      } else if (sql.includes("where id =") && sql.includes("mailbox_id")) {
        rows = rows.filter((row) => row.id === a && row.mailbox_id === b);
      } else if (sql.includes("mailbox_id =")) {
        rows = rows.filter((row) => row.mailbox_id === a);
      }
      return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at));
    }

    return [];
  }

  mutate(): number {
    const sql = collapse(this.sql);
    const binds = this.binds;

    if (sql.startsWith("insert into users")) {
      this.db.users.push({
        id: binds[0],
        login: binds[1],
        display_name: binds[2],
        role: binds[3],
        status: binds[4],
        token_salt: binds[5],
        token_hash: binds[6],
        quota_addresses: binds[7],
        quota_storage_bytes: binds[8],
        quota_send_daily: binds[9],
        created_at: binds[10],
        updated_at: binds[11],
      });
      return 1;
    }

    if (sql.startsWith("insert or ignore into user_mailboxes") || sql.startsWith("insert into user_mailboxes")) {
      const exists = this.db.user_mailboxes.some(
        (row) => row.user_id === binds[0] && row.mailbox_id === binds[1],
      );
      if (!exists) {
        this.db.user_mailboxes.push({
          user_id: binds[0],
          mailbox_id: binds[1],
          created_at: binds[2],
        });
        return 1;
      }
      return 0;
    }

    if (sql.startsWith("insert into mailboxes")) {
      this.db.mailboxes.push({
        id: binds[0],
        address: binds[1],
        local_part: binds[2],
        domain: binds[3],
        display_name: binds[4],
        status: binds[5],
        created_at: binds[6],
        updated_at: binds[7],
      });
      return 1;
    }

    if (sql.startsWith("insert into messages")) {
      const starred = sql.includes("is_starred");
      const rfc = binds[2] == null || binds[2] === "" ? null : binds[2];
      if (
        rfc &&
        this.db.messages.some((row) => row.mailbox_id === binds[1] && row.rfc_message_id === rfc)
      ) {
        throw new Error("UNIQUE constraint failed: idx_messages_mailbox_rfc_id");
      }
      this.db.messages.unshift({
        id: binds[0],
        mailbox_id: binds[1],
        rfc_message_id: rfc,
        envelope_from: binds[3],
        envelope_to: binds[4],
        subject: binds[5],
        snippet: binds[6],
        body_text: binds[7],
        header_to: binds[8],
        header_cc: binds[9],
        header_reply_to: binds[10],
        in_reply_to: binds[11],
        references_header: binds[12],
        size_bytes: binds[13],
        is_read: starred ? binds[14] : 0,
        is_starred: starred ? binds[15] : 0,
        folder: starred ? binds[16] : "inbox",
        received_at: starred ? binds[17] : binds[14],
        created_at: starred ? binds[18] : binds[14],
      });
      return 1;
    }

    if (sql.startsWith("delete from attachments")) {
      const before = this.db.attachments.length;
      this.db.attachments = this.db.attachments.filter((row) => row.id !== binds[0]);
      return before === this.db.attachments.length ? 0 : 1;
    }

    if (sql.startsWith("delete from messages")) {
      const before = this.db.messages.length;
      this.db.messages = this.db.messages.filter(
        (row) => !(row.id === binds[0] && row.mailbox_id === binds[1]),
      );
      return before === this.db.messages.length ? 0 : 1;
    }

    if (sql.startsWith("insert into attachments")) {
      this.db.attachments.push({
        id: binds[0],
        message_id: binds[1],
        mailbox_id: binds[2],
        filename: binds[3],
        content_type: binds[4],
        size_bytes: binds[5],
        r2_key: binds[6],
        created_at: binds[7],
      });
      return 1;
    }

    if (sql.startsWith("insert into api_tokens")) {
      this.db.api_tokens.push({
        id: binds[0],
        mailbox_id: binds[1],
        token_hash: binds[2],
        token_prefix: binds[3],
        label: binds[4],
        created_at: binds[5],
        revoked_at: null,
        kind: binds[6] ?? "mailbox",
        quota_requests_daily: binds[7] ?? 0,
        quota_send_daily: binds[8] ?? 0,
      });
      return 1;
    }

    if (sql.includes("update api_tokens set revoked_at")) {
      const row = this.db.api_tokens.find((item) => item.id === binds[0] && item.revoked_at == null);
      if (!row) {
        return 0;
      }
      row.revoked_at = binds[1];
      return 1;
    }

    if (sql.startsWith("insert into mailbox_aliases")) {
      const dup = this.db.mailbox_aliases.some(
        (row) =>
          String(row.local_part).toLowerCase() === String(binds[2]).toLowerCase() &&
          String(row.domain).toLowerCase() === String(binds[3]).toLowerCase(),
      );
      if (dup) {
        throw new Error("UNIQUE constraint failed: mailbox_aliases");
      }
      this.db.mailbox_aliases.push({
        id: binds[0],
        mailbox_id: binds[1],
        local_part: binds[2],
        domain: binds[3],
        created_at: binds[4],
      });
      return 1;
    }

    if (sql.startsWith("delete from mailbox_aliases")) {
      const before = this.db.mailbox_aliases.length;
      this.db.mailbox_aliases = this.db.mailbox_aliases.filter((row) => row.id !== binds[0]);
      return before === this.db.mailbox_aliases.length ? 0 : 1;
    }

    if (sql.startsWith("insert into api_token_usage")) {
      const day = String(binds[1]);
      const existing = this.db.api_token_usage.find((row) => row.token_id === binds[0] && row.day === day);
      const addReq = sql.includes("request_count = request_count + 1") || Number(binds[2]) === 1;
      const addSend = sql.includes("send_count = send_count + 1") || Number(binds[3]) === 1;
      if (existing) {
        if (addReq) {
          existing.request_count = Number(existing.request_count) + 1;
        }
        if (addSend) {
          existing.send_count = Number(existing.send_count) + 1;
        }
      } else {
        this.db.api_token_usage.push({
          token_id: binds[0],
          day,
          request_count: addReq ? 1 : 0,
          send_count: addSend ? 1 : 0,
        });
      }
      return 1;
    }

    if (sql.startsWith("insert into outbound_attempts")) {
      const mailboxId = binds[1];
      const key = binds[15] ?? binds[0];
      const dup = this.db.outbound_attempts.some(
        (row) => row.mailbox_id === mailboxId && key && row.idempotency_key === key,
      );
      if (dup) {
        throw new Error(
          "UNIQUE constraint failed: outbound_attempts.mailbox_id, outbound_attempts.idempotency_key",
        );
      }
      this.db.outbound_attempts.push({
        id: binds[0],
        mailbox_id: binds[1],
        from_address: binds[2],
        to_address: binds[3],
        cc_address: binds[4],
        subject: binds[5],
        body_text: binds[6],
        in_reply_to: binds[7],
        references_header: binds[8],
        provider: binds[9],
        status: binds[10],
        error: binds[11],
        hint: binds[12],
        provider_message_id: binds[13],
        created_at: binds[14],
        idempotency_key: binds[15],
        attempt_count: binds[16],
        max_attempts: binds[17],
        last_attempt_at: binds[18],
        sent_message_id: binds[19],
        updated_at: binds[20],
      });
      return 1;
    }

    if (sql.startsWith("update outbound_attempts")) {
      const row = this.db.outbound_attempts.find(
        (item) => item.id === binds[0] && item.mailbox_id === binds[1],
      );
      if (!row) {
        return 0;
      }
      row.provider = binds[2];
      row.status = binds[3];
      row.error = binds[4];
      row.hint = binds[5];
      row.provider_message_id = binds[6];
      row.attempt_count = binds[7];
      row.last_attempt_at = binds[8];
      row.sent_message_id = binds[9];
      row.updated_at = binds[10];
      return 1;
    }

    if (sql.startsWith("insert into send_usage")) {
      const existing = this.db.send_usage.find((row) => row.user_id === binds[0] && row.day === binds[1]);
      if (existing) {
        existing.count = Number(existing.count) + 1;
      } else {
        this.db.send_usage.push({ user_id: binds[0], day: binds[1], count: 1 });
      }
      return 1;
    }

    if (sql.startsWith("insert into inbound_hooks")) {
      const row = {
        mailbox_id: binds[0],
        webhook_enabled: binds[1],
        webhook_url: binds[2],
        webhook_secret: binds[3],
        forward_enabled: binds[4],
        forward_url: binds[5],
        forward_email: binds[6],
        updated_at: binds[7],
      };
      const idx = this.db.inbound_hooks.findIndex((item) => item.mailbox_id === row.mailbox_id);
      if (idx >= 0) {
        this.db.inbound_hooks[idx] = row;
      } else {
        this.db.inbound_hooks.push(row);
      }
      return 1;
    }

    if (sql.startsWith("update inbound_hooks set webhook_secret")) {
      const row = this.db.inbound_hooks.find((item) => item.mailbox_id === binds[0]);
      if (!row) {
        return 0;
      }
      row.webhook_secret = binds[1];
      return 1;
    }

    if (sql.startsWith("insert into inbound_deliveries")) {
      const dup = this.db.inbound_deliveries.some(
        (row) => row.mailbox_id === binds[1] && row.delivery_key === binds[10],
      );
      if (dup) {
        throw new Error("UNIQUE constraint failed: inbound_deliveries.mailbox_id, inbound_deliveries.delivery_key");
      }
      this.db.inbound_deliveries.unshift({
        id: binds[0],
        mailbox_id: binds[1],
        message_id: binds[2],
        kind: binds[3],
        channel: binds[4],
        target: binds[5],
        status: binds[6],
        http_status: binds[7],
        error: binds[8],
        hint: binds[9],
        delivery_key: binds[10],
        attempt_count: binds[11],
        max_attempts: binds[12],
        next_attempt_at: binds[13],
        last_attempt_at: binds[14],
        payload_json: binds[15],
        created_at: binds[16],
        updated_at: binds[17],
      });
      return 1;
    }

    if (sql.startsWith("update inbound_deliveries")) {
      const row = this.db.inbound_deliveries.find((item) => item.id === binds[0]);
      if (!row) {
        return 0;
      }
      if (sql.includes("where id =") && sql.includes("status = 'pending'")) {
        if (row.status !== "pending" || row.next_attempt_at == null || Number(row.next_attempt_at) > Number(binds[2])) {
          return 0;
        }
        row.next_attempt_at = binds[1];
        row.updated_at = binds[2];
        return 1;
      }
      row.target = binds[1];
      row.status = binds[2];
      row.http_status = binds[3];
      row.error = binds[4];
      row.hint = binds[5];
      row.attempt_count = binds[6];
      row.next_attempt_at = binds[7];
      row.last_attempt_at = binds[8];
      row.payload_json = binds[9];
      row.updated_at = binds[10];
      return 1;
    }

    if (sql.startsWith("insert into dev_inboxes")) {
      this.db.dev_inboxes.push({
        id: binds[0],
        mailbox_id: binds[1],
        owner_mailbox_id: binds[2],
        owner_token_id: binds[3],
        address: binds[4],
        domain: binds[5],
        status: binds[6],
        expires_at: binds[7],
        closed_at: null,
        created_at: binds[8],
      });
      return 1;
    }

    if (sql.startsWith("insert into site_settings")) {
      this.db.site_settings = [
        { id: 1, site_title: binds[0], logo_url: binds[1], accent: binds[2], updated_at: binds[3] },
      ];
      return 1;
    }

    if (sql.startsWith("update users set status")) {
      const row = this.db.users.find((item) => item.id === binds[0]);
      if (!row) {
        return 0;
      }
      row.status = binds[1];
      row.updated_at = binds[2];
      return 1;
    }

    if (sql.startsWith("update users set quota_addresses")) {
      const row = this.db.users.find((item) => item.id === binds[0]);
      if (!row) {
        return 0;
      }
      row.quota_addresses = binds[1];
      row.quota_storage_bytes = binds[2];
      row.quota_send_daily = binds[3];
      row.updated_at = binds[4];
      return 1;
    }

    if (sql.includes("update mailboxes set status")) {
      const row = this.db.mailboxes.find((item) => item.id === binds[0]);
      if (!row) {
        return 0;
      }
      row.status = binds[1];
      row.updated_at = binds[2];
      return 1;
    }

    if (sql.includes("update dev_inboxes set status")) {
      const row = this.db.dev_inboxes.find((item) => item.id === binds[0]);
      if (!row) {
        return 0;
      }
      row.status = binds[1];
      row.closed_at = binds[2];
      return 1;
    }

    if (sql.includes("update messages set is_read")) {
      const row = this.db.messages.find(
        (item) => item.id === binds[0] && item.mailbox_id === binds[1] && item.folder === "inbox",
      );
      if (!row) {
        return 0;
      }
      row.is_read = binds[2];
      return 1;
    }

    if (sql.includes("set folder = 'trash'")) {
      return this.updateMessages(
        (row) => row.id === binds[0] && row.mailbox_id === binds[1] && row.folder !== "trash",
        (row) => {
          row.folder = "trash";
        },
      );
    }

    if (sql.includes("set folder = ?3")) {
      return this.updateMessages(
        (row) => row.id === binds[0] && row.mailbox_id === binds[1],
        (row) => {
          row.folder = binds[2];
        },
      );
    }

    if (sql.includes("folder = 'sent'") && sql.includes("folder = 'draft'")) {
      return this.updateMessages(
        (row) => row.id === binds[0] && row.mailbox_id === binds[1] && row.folder === "draft",
        (row) => {
          row.folder = "sent";
          row.envelope_from = binds[2];
          row.envelope_to = binds[3];
          row.subject = binds[4];
          row.snippet = binds[5];
          row.body_text = binds[6];
          row.header_cc = binds[7];
          row.in_reply_to = binds[8];
          row.references_header = binds[9];
          row.is_read = 1;
          row.received_at = binds[10];
        },
      );
    }

    if (sql.includes("folder = 'draft'")) {
      return this.updateMessages(
        (row) => row.id === binds[0] && row.mailbox_id === binds[1] && row.folder === "draft",
        (row) => {
          row.envelope_from = binds[2];
          row.envelope_to = binds[3];
          row.subject = binds[4];
          row.snippet = binds[5];
          row.body_text = binds[6];
          row.header_cc = binds[7];
          row.in_reply_to = binds[8];
          row.references_header = binds[9];
          row.received_at = binds[10];
        },
      );
    }

    return 0;
  }

  updateMessages(match: (row: MemoryRow) => boolean, apply: (row: MemoryRow) => void): number {
    let changes = 0;
    for (const row of this.db.messages) {
      if (match(row)) {
        apply(row);
        changes += 1;
      }
    }
    return changes;
  }
}

/** Minimal R2 for persist / download tests. */
export class MemoryR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ key: string }> {
    let bytes: Uint8Array;
    if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    return { key };
  }

  async get(key: string): Promise<{
    body: Uint8Array;
    httpMetadata: { contentType?: string };
  } | null> {
    const row = this.objects.get(key);
    if (!row) {
      return null;
    }
    return { body: row.bytes, httpMetadata: { contentType: row.contentType } };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function cloneRow(row: MemoryRow): MemoryRow {
  return { ...row };
}
