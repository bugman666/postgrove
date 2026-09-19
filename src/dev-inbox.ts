import type { AdminPrincipal } from "./auth.ts";
import type { Env } from "./env.ts";
import { combineMessageText, extractFromText } from "./extract.ts";
import { forbiddenJson, json, methodNotAllowed, notFoundJson } from "./http.ts";
import {
  getMailbox,
  insertMailbox,
  listInboxMessages,
  parseMailboxAddress,
  setMailboxStatus,
  type MailboxRecord,
  type MessageRecord,
} from "./store.ts";

export const DEV_INBOX_QUOTA_DEFAULT = 8;
export const DEV_INBOX_TTL_DEFAULT = 15 * 60;
export const DEV_INBOX_TTL_MAX = 60 * 60;
export const DEV_WAIT_DEFAULT_MS = 8_000;
export const DEV_WAIT_MAX_MS = 20_000;
export const DEV_WAIT_POLL_MS = 200;

export const DEV_OWN_DOMAIN_HINT =
  "仅支持本站自有域名，不是公共临时邮箱池。请使用部署域名或已有邮箱的域名。";
export const DEV_FORBIDDEN_HINT = "无权限：不能操作其他租户的开发收件箱。";
export const DEV_WAIT_TIMEOUT_HINT = "等待超时：时限内未收到匹配邮件。";
export const DEV_INBOX_CLOSED_HINT = "收件箱已关闭，不再接收邮件。";
export const DEV_INBOX_EXPIRED_HINT = "收件箱已过期，不再接收邮件。";

const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,46})$/;
const DEV_INBOX_COLUMNS =
  "id, mailbox_id, owner_mailbox_id, owner_token_id, address, domain, status, expires_at, closed_at, created_at";

export type TokenPrincipal = {
  kind: "token";
  tokenId: string;
  mailboxId: string;
  address: string;
};

export type DevPrincipal = TokenPrincipal | AdminPrincipal;

export interface DevInboxRecord {
  id: string;
  mailbox_id: string;
  owner_mailbox_id: string | null;
  owner_token_id: string | null;
  address: string;
  domain: string;
  status: "open" | "closed" | "expired";
  expires_at: number;
  closed_at: number | null;
  created_at: number;
}

type JsonBody = Record<string, unknown>;

let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Test helper: skip wall-clock waits without changing timeout math. */
export function setDevInboxSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export async function handleDevInboxRoutes(
  request: Request,
  env: Env,
  url: URL,
  principal: DevPrincipal,
): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (path === "/api/v1/dev/inboxes") {
    if (method === "GET") {
      return listDevInboxes(env, principal);
    }
    if (method === "POST") {
      return createDevInbox(request, env, principal);
    }
    return methodNotAllowed("GET, POST");
  }

  const wait = path.match(/^\/api\/v1\/dev\/inboxes\/([^/]+)\/wait$/);
  if (wait) {
    if (method !== "GET" && method !== "POST") {
      return methodNotAllowed("GET, POST");
    }
    return waitDevInbox(request, env, url, principal, decodeURIComponent(wait[1]));
  }

  const extract = path.match(/^\/api\/v1\/dev\/inboxes\/([^/]+)\/extract$/);
  if (extract) {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return extractDevInbox(request, env, principal, decodeURIComponent(extract[1]));
  }

  const close = path.match(/^\/api\/v1\/dev\/inboxes\/([^/]+)\/close$/);
  if (close) {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return closeDevInbox(env, principal, decodeURIComponent(close[1]));
  }

  const one = path.match(/^\/api\/v1\/dev\/inboxes\/([^/]+)$/);
  if (one) {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return readDevInbox(env, principal, decodeURIComponent(one[1]));
  }

  return notFoundJson();
}

async function createDevInbox(request: Request, env: Env, principal: DevPrincipal): Promise<Response> {
  const parsed = await readJsonObject(request, true);
  if (!parsed.ok) {
    return parsed.response;
  }
  const now = Date.now();
  const domainResult = await resolveOwnDomain(env, principal, stringField(parsed.body, "domain"), now);
  if (!domainResult.ok) {
    return json({ ok: false, error: domainResult.error, hint: domainResult.hint }, domainResult.status);
  }

  const ttl = parseTtlSeconds(parsed.body.ttl_seconds, env);
  if (!ttl.ok) {
    return json({ ok: false, error: ttl.error, hint: ttl.hint }, 400);
  }

  const quota = await checkDevInboxQuota(env, principal, now);
  if (quota) {
    return json({ ok: false, error: quota.error, hint: quota.hint, used: quota.used, limit: quota.limit }, 409);
  }

  const requestedLocal = stringField(parsed.body, "local_part");
  if (requestedLocal) {
    const localError = validateLocalPart(requestedLocal);
    if (localError) {
      return json({ ok: false, error: "invalid_address", hint: localError }, 400);
    }
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const localPart = requestedLocal ?? randomLocalPart();
    const address = `${localPart}@${domainResult.domain}`;
    const created = await insertMailbox(env, {
      address,
      displayName: stringField(parsed.body, "display_name") ?? "Dev inbox",
    }, now);
    if (!created.ok) {
      if (created.error === "address_taken" && !requestedLocal) {
        continue;
      }
      return json(
        { ok: false, error: created.error, hint: created.hint },
        created.error === "address_taken" ? 409 : 400,
      );
    }

    const row: DevInboxRecord = {
      id: crypto.randomUUID(),
      mailbox_id: created.mailbox.id,
      owner_mailbox_id: principal.kind === "token" ? principal.mailboxId : null,
      owner_token_id: principal.kind === "token" ? principal.tokenId : null,
      address: created.mailbox.address,
      domain: created.mailbox.domain,
      status: "open",
      expires_at: now + ttl.seconds * 1000,
      closed_at: null,
      created_at: now,
    };
    await insertDevInboxRow(env, row);
    return json(
      {
        ok: true,
        inbox: publicDevInbox(row),
        mailbox: publicMailbox(created.mailbox),
        hint: "这是本站自有域名上的开发收件箱，不是公共临时邮箱。用完请 close。",
      },
      201,
    );
  }

  return json(
    { ok: false, error: "address_taken", hint: "生成的本地部分冲突，请重试或指定 local_part。" },
    409,
  );
}

async function listDevInboxes(env: Env, principal: DevPrincipal): Promise<Response> {
  const now = Date.now();
  const rows =
    principal.kind === "admin"
      ? await env.DB.prepare(
          `SELECT ${DEV_INBOX_COLUMNS} FROM dev_inboxes ORDER BY created_at DESC LIMIT 100`,
        ).all<DevInboxRecord>()
      : await env.DB.prepare(
          `SELECT ${DEV_INBOX_COLUMNS} FROM dev_inboxes
           WHERE owner_mailbox_id = ?1
           ORDER BY created_at DESC LIMIT 100`,
        )
          .bind(principal.mailboxId)
          .all<DevInboxRecord>();
  const refreshed = [];
  for (const row of rows.results ?? []) {
    refreshed.push(await refreshDevInbox(env, row, now));
  }
  return json({ ok: true, inboxes: refreshed.map(publicDevInbox) });
}

async function readDevInbox(env: Env, principal: DevPrincipal, id: string): Promise<Response> {
  const loaded = await loadOwnedInbox(env, principal, id);
  if (!loaded.ok) {
    return loaded.response;
  }
  return json({ ok: true, inbox: publicDevInbox(loaded.inbox) });
}

async function waitDevInbox(
  request: Request,
  env: Env,
  url: URL,
  principal: DevPrincipal,
  id: string,
): Promise<Response> {
  const loaded = await loadOwnedInbox(env, principal, id);
  if (!loaded.ok) {
    return loaded.response;
  }
  if (loaded.inbox.status !== "open") {
    return closedResponse(loaded.inbox);
  }

  const parsed = request.method === "POST" ? await readJsonObject(request, true) : { ok: true as const, body: {} };
  if (!parsed.ok) {
    return parsed.response;
  }

  const timeoutMs = clampWaitTimeout(firstNumber(parsed.body.timeout_ms, url.searchParams.get("timeout_ms")), env);
  const filter = {
    since: firstNumber(parsed.body.since, url.searchParams.get("since")),
    subject: firstString(parsed.body.subject, url.searchParams.get("subject")),
    from: firstString(parsed.body.from, url.searchParams.get("from")),
    contains: firstString(parsed.body.contains, url.searchParams.get("contains")),
  };
  const extractKind = firstString(parsed.body.extract, url.searchParams.get("extract"));

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const live = await refreshDevInbox(env, loaded.inbox);
    if (live.status !== "open") {
      return closedResponse(live);
    }
    const match = await findMatchingMessage(env, live.mailbox_id, filter);
    if (match) {
      if (extractKind) {
        const extracted = extractFromText(combineMessageText(match), extractKind, {
          pattern: firstString(parsed.body.pattern, url.searchParams.get("pattern")),
          host: firstString(parsed.body.host, url.searchParams.get("host")),
        });
        if (!extracted.ok) {
          return json({ ok: false, ...extracted, inbox: publicDevInbox(live), message: publicMessage(match) }, 422);
        }
        return json({
          ok: true,
          inbox: publicDevInbox(live),
          message: publicMessage(match),
          extract: extracted,
        });
      }
      return json({ ok: true, inbox: publicDevInbox(live), message: publicMessage(match) });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return json(
        {
          ok: false,
          error: "wait_timeout",
          hint: DEV_WAIT_TIMEOUT_HINT,
          timeout_ms: timeoutMs,
          inbox: publicDevInbox(live),
        },
        408,
      );
    }
    await sleepImpl(Math.min(DEV_WAIT_POLL_MS, remaining));
  }
}

async function extractDevInbox(
  request: Request,
  env: Env,
  principal: DevPrincipal,
  id: string,
): Promise<Response> {
  const loaded = await loadOwnedInbox(env, principal, id);
  if (!loaded.ok) {
    return loaded.response;
  }
  if (loaded.inbox.status !== "open") {
    return closedResponse(loaded.inbox);
  }

  const parsed = await readJsonObject(request, false);
  if (!parsed.ok) {
    return parsed.response;
  }
  const kind = stringField(parsed.body, "kind") ?? "otp";
  const messageId = stringField(parsed.body, "message_id");
  const messages = await listInboxMessages(env, loaded.inbox.mailbox_id, {});
  const message = messageId ? messages.find((row) => row.id === messageId) ?? null : messages[0] ?? null;
  if (!message) {
    return json(
      {
        ok: false,
        error: "extract_failed",
        hint: messageId ? "未能抽出：指定的邮件不在这个开发收件箱。" : "未能抽出：这个开发收件箱还没有邮件。",
      },
      422,
    );
  }

  const extracted = extractFromText(combineMessageText(message), kind, {
    pattern: stringField(parsed.body, "pattern"),
    host: stringField(parsed.body, "host"),
  });
  if (!extracted.ok) {
    return json({ ok: false, ...extracted, message: publicMessage(message) }, extracted.error === "invalid_kind" || extracted.error === "invalid_pattern" ? 400 : 422);
  }
  return json({ ok: true, inbox: publicDevInbox(loaded.inbox), message: publicMessage(message), extract: extracted });
}

async function closeDevInbox(env: Env, principal: DevPrincipal, id: string): Promise<Response> {
  const loaded = await loadOwnedInbox(env, principal, id);
  if (!loaded.ok) {
    return loaded.response;
  }
  if (loaded.inbox.status !== "open") {
    return json({
      ok: true,
      already_closed: true,
      inbox: publicDevInbox(loaded.inbox),
    });
  }
  const now = Date.now();
  const closed = await markDevInbox(env, loaded.inbox, "closed", now);
  return json({ ok: true, already_closed: false, inbox: publicDevInbox(closed) });
}

export async function rejectClosedDevInbox(env: Env, mailboxId: string, now = Date.now()): Promise<string | null> {
  const row = await getDevInboxByMailboxId(env, mailboxId);
  if (!row) {
    return null;
  }
  const live = await refreshDevInbox(env, row, now);
  if (live.status === "open") {
    return null;
  }
  return live.status === "expired" ? "mailbox expired" : "mailbox disabled";
}

async function loadOwnedInbox(
  env: Env,
  principal: DevPrincipal,
  id: string,
): Promise<{ ok: true; inbox: DevInboxRecord } | { ok: false; response: Response }> {
  const row = await getDevInbox(env, id);
  if (!row) {
    return { ok: false, response: notFoundJson() };
  }
  const live = await refreshDevInbox(env, row);
  if (principal.kind === "token") {
    if (live.owner_mailbox_id !== principal.mailboxId) {
      return { ok: false, response: forbiddenJson(DEV_FORBIDDEN_HINT) };
    }
  }
  return { ok: true, inbox: live };
}

async function refreshDevInbox(env: Env, row: DevInboxRecord, now = Date.now()): Promise<DevInboxRecord> {
  if (row.status === "open" && row.expires_at <= now) {
    return markDevInbox(env, row, "expired", now);
  }
  return row;
}

async function markDevInbox(
  env: Env,
  row: DevInboxRecord,
  status: "closed" | "expired",
  now: number,
): Promise<DevInboxRecord> {
  await env.DB.prepare(`UPDATE dev_inboxes SET status = ?2, closed_at = ?3 WHERE id = ?1`)
    .bind(row.id, status, now)
    .run();
  await setMailboxStatus(env, row.mailbox_id, "disabled", now);
  return { ...row, status, closed_at: now };
}

async function insertDevInboxRow(env: Env, row: DevInboxRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dev_inboxes (
       id, mailbox_id, owner_mailbox_id, owner_token_id, address, domain,
       status, expires_at, closed_at, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)`,
  )
    .bind(
      row.id,
      row.mailbox_id,
      row.owner_mailbox_id,
      row.owner_token_id,
      row.address,
      row.domain,
      row.status,
      row.expires_at,
      row.created_at,
    )
    .run();
}

async function getDevInbox(env: Env, id: string): Promise<DevInboxRecord | null> {
  return env.DB.prepare(`SELECT ${DEV_INBOX_COLUMNS} FROM dev_inboxes WHERE id = ?1`)
    .bind(id)
    .first<DevInboxRecord>();
}

async function getDevInboxByMailboxId(env: Env, mailboxId: string): Promise<DevInboxRecord | null> {
  return env.DB.prepare(`SELECT ${DEV_INBOX_COLUMNS} FROM dev_inboxes WHERE mailbox_id = ?1`)
    .bind(mailboxId)
    .first<DevInboxRecord>();
}

async function resolveOwnDomain(
  env: Env,
  principal: DevPrincipal,
  requested: string | null,
  _now: number,
): Promise<
  | { ok: true; domain: string }
  | { ok: false; error: "own_domain_only" | "invalid_address"; hint: string; status: number }
> {
  const configured = env.MAIL_DOMAIN?.trim().toLowerCase() ?? "";
  const known = await listKnownDomains(env);
  const allowed = new Set<string>(known);
  if (configured) {
    allowed.add(configured);
  }

  if (principal.kind === "token") {
    const parsed = parseMailboxAddress(principal.address);
    const tokenDomain = parsed?.domain ?? "";
    if (!tokenDomain || (allowed.size > 0 && !allowed.has(tokenDomain))) {
      return { ok: false, error: "own_domain_only", hint: DEV_OWN_DOMAIN_HINT, status: 400 };
    }
    if (configured && tokenDomain !== configured) {
      return { ok: false, error: "own_domain_only", hint: DEV_OWN_DOMAIN_HINT, status: 400 };
    }
    if (requested && requested.toLowerCase() !== tokenDomain) {
      return { ok: false, error: "own_domain_only", hint: DEV_OWN_DOMAIN_HINT, status: 400 };
    }
    return { ok: true, domain: tokenDomain };
  }

  const domain = (requested ?? configured).toLowerCase();
  if (!domain) {
    if (known[0]) {
      return { ok: true, domain: known[0] };
    }
    return {
      ok: false,
      error: "own_domain_only",
      hint: "仅支持本站自有域名：尚未配置 MAIL_DOMAIN，也没有已存在的邮箱域名。",
      status: 400,
    };
  }
  if (!domain.includes(".") || /\s/.test(domain)) {
    return { ok: false, error: "invalid_address", hint: "domain 必须是本站已有的邮箱域名。", status: 400 };
  }
  if (allowed.size > 0 && !allowed.has(domain)) {
    return { ok: false, error: "own_domain_only", hint: DEV_OWN_DOMAIN_HINT, status: 400 };
  }
  return { ok: true, domain };
}

async function listKnownDomains(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT DISTINCT domain FROM mailboxes`).all<{ domain: string }>();
  return (rows.results ?? []).map((row) => String(row.domain).toLowerCase()).filter(Boolean);
}

async function checkDevInboxQuota(
  env: Env,
  principal: DevPrincipal,
  now: number,
): Promise<{ error: "quota_dev_inboxes"; hint: string; used: number; limit: number } | null> {
  const limit = parsePositiveInt(env.DEV_INBOX_QUOTA, DEV_INBOX_QUOTA_DEFAULT);
  if (limit === 0) {
    return null;
  }
  const used =
    principal.kind === "token"
      ? await countOpenDevInboxes(env, now, principal.mailboxId)
      : await countOpenDevInboxes(env, now, null);
  if (used >= limit) {
    return {
      error: "quota_dev_inboxes",
      hint: `配额已满：打开的开发收件箱已达上限（已用 ${used} / 上限 ${limit}）。先 close 再用，或提高 DEV_INBOX_QUOTA。`,
      used,
      limit,
    };
  }
  return null;
}

async function countOpenDevInboxes(env: Env, now: number, ownerMailboxId: string | null): Promise<number> {
  if (ownerMailboxId) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM dev_inboxes
       WHERE owner_mailbox_id = ?1 AND status = 'open' AND expires_at > ?2`,
    )
      .bind(ownerMailboxId, now)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM dev_inboxes WHERE status = 'open' AND expires_at > ?1`,
  )
    .bind(now)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function findMatchingMessage(
  env: Env,
  mailboxId: string,
  filter: { since: number | null; subject: string | null; from: string | null; contains: string | null },
): Promise<MessageRecord | null> {
  const rows = await listInboxMessages(env, mailboxId, {});
  for (const row of rows) {
    if (filter.since != null && row.received_at <= filter.since) {
      continue;
    }
    if (filter.subject && !includesInsensitive(row.subject, filter.subject)) {
      continue;
    }
    if (filter.from && !includesInsensitive(row.envelope_from, filter.from)) {
      continue;
    }
    if (filter.contains) {
      const hay = combineMessageText(row);
      if (!includesInsensitive(hay, filter.contains)) {
        continue;
      }
    }
    return row;
  }
  return null;
}

function closedResponse(inbox: DevInboxRecord): Response {
  const expired = inbox.status === "expired";
  return json(
    {
      ok: false,
      error: expired ? "inbox_expired" : "inbox_closed",
      hint: expired ? DEV_INBOX_EXPIRED_HINT : DEV_INBOX_CLOSED_HINT,
      inbox: publicDevInbox(inbox),
    },
    409,
  );
}

function validateLocalPart(raw: string): string | null {
  const local = raw.trim().toLowerCase();
  if (local.includes("+")) {
    return "开发收件箱不用 +tag（别名留给 #15）。请用普通本地部分，例如 dev-ab12。";
  }
  if (!LOCAL_PART_RE.test(local)) {
    return "local_part 只能是小写字母、数字、点、下划线或短横线。";
  }
  return null;
}

function randomLocalPart(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `dev-${hex}`;
}

function parseTtlSeconds(
  raw: unknown,
  env: Env,
): { ok: true; seconds: number } | { ok: false; error: "invalid_request"; hint: string } {
  const fallback = parsePositiveInt(env.DEV_INBOX_TTL_SECONDS, DEV_INBOX_TTL_DEFAULT);
  const max = Math.min(DEV_INBOX_TTL_MAX, parsePositiveInt(env.DEV_INBOX_TTL_MAX_SECONDS, DEV_INBOX_TTL_MAX) || DEV_INBOX_TTL_MAX);
  if (raw == null || raw === "") {
    return { ok: true, seconds: Math.min(fallback, max) };
  }
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < 30) {
    return { ok: false, error: "invalid_request", hint: "ttl_seconds 最少 30 秒。" };
  }
  return { ok: true, seconds: Math.min(Math.floor(value), max) };
}

function clampWaitTimeout(raw: number | null, env: Env): number {
  const max = parsePositiveInt(env.DEV_WAIT_MAX_MS, DEV_WAIT_MAX_MS);
  if (raw == null) {
    return Math.min(DEV_WAIT_DEFAULT_MS, max);
  }
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.min(Math.floor(raw), max);
}

function publicDevInbox(row: DevInboxRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    address: row.address,
    domain: row.domain,
    status: row.status,
    expires_at: row.expires_at,
    closed_at: row.closed_at,
    created_at: row.created_at,
  };
}

function publicMailbox(row: MailboxRecord) {
  return {
    id: row.id,
    address: row.address,
    display_name: row.display_name,
    status: row.status,
  };
}

function publicMessage(row: MessageRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    from: row.envelope_from,
    to: row.envelope_to,
    subject: row.subject,
    snippet: row.snippet,
    body_text: row.body_text,
    received_at: row.received_at,
  };
}

async function readJsonObject(
  request: Request,
  allowEmpty: boolean,
): Promise<{ ok: true; body: JsonBody } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ ok: false, error: "invalid_request", hint: "请发送 JSON 对象。" }, 400) };
  }
  if (!text.trim()) {
    if (allowEmpty) {
      return { ok: true, body: {} };
    }
    return { ok: false, response: json({ ok: false, error: "invalid_request", hint: '请发送 JSON，例如 { "kind": "otp" }。' }, 400) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, response: json({ ok: false, error: "invalid_request", hint: "JSON 无法解析。" }, 400) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: json({ ok: false, error: "invalid_request", hint: "请发送 JSON 对象。" }, 400) };
  }
  return { ok: true, body: parsed as JsonBody };
}

function stringField(body: JsonBody, key: string): string | null {
  const value = body[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstString(bodyValue: unknown, queryValue: string | null): string | null {
  if (typeof bodyValue === "string" && bodyValue.trim()) {
    return bodyValue.trim();
  }
  const query = queryValue?.trim();
  return query ? query : null;
}

function firstNumber(bodyValue: unknown, queryValue: string | null): number | null {
  if (typeof bodyValue === "number" && Number.isFinite(bodyValue)) {
    return bodyValue;
  }
  if (typeof bodyValue === "string" && bodyValue.trim()) {
    const parsed = Number(bodyValue);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (queryValue && queryValue.trim()) {
    const parsed = Number(queryValue);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function includesInsensitive(hay: string | null | undefined, needle: string): boolean {
  return (hay ?? "").toLowerCase().includes(needle.toLowerCase());
}

