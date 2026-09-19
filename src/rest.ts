import {
  findApiTokenByHash,
  getApiToken,
  hashApiToken,
  insertApiToken,
  listApiTokens,
  looksLikeApiToken,
  publicToken,
  revokeApiToken,
  type ApiTokenRecord,
} from "./api-tokens.ts";
import { bearerToken, requireAdmin, type AdminPrincipal, type OwnerPrincipal } from "./auth.ts";
import type { Env } from "./env.ts";
import { parseFolder } from "./folders.ts";
import {
  forbiddenJson,
  json,
  methodNotAllowed,
  notFoundJson,
  payloadTooLargeJson,
  unauthorizedJson,
} from "./http.ts";
import {
  REST_RATE_LIMIT_MAX,
  REST_RATE_LIMIT_WINDOW_MS,
  SIGNUP_RATE_LIMIT_MAX,
  SIGNUP_RATE_LIMIT_WINDOW_MS,
  clientKey,
  consumeRateLimit,
  restRateLimitConfig,
  signupRateLimitConfig,
} from "./rate-limit.ts";
import { parseSendFields, sendOutbound } from "./send.ts";
import {
  getInboxMessage,
  getMailbox,
  getMailboxMessage,
  getMessageById,
  insertMailbox,
  listFolderMessages,
  listInboxMessages,
  listMailboxes,
  markRead,
  type MailboxRecord,
  type MessageRecord,
} from "./store.ts";
import { turnstileConfigured, verifyTurnstile } from "./turnstile.ts";

export const DEFAULT_REST_BODY_MAX_BYTES = 256_000;
export const REST_CROSS_MAILBOX_HINT =
  "This API token is bound to another mailbox. Use a token minted for that address.";

type TokenPrincipal = {
  kind: "token";
  tokenId: string;
  mailboxId: string;
  address: string;
};

type RestPrincipal = TokenPrincipal | AdminPrincipal;

type AuthOk<T> = { ok: true; principal: T };
type AuthFail = { ok: false; response: Response };
type AuthResult<T> = AuthOk<T> | AuthFail;

/**
 * Token REST under /api/v1 plus small admin mint/create routes.
 * Cookie owner /api/* stays in src/api.ts (requireOwner).
 */
export async function handleRestRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/v1/public/signup") {
    return request.method === "POST"
      ? handlePublicSignup(request, env)
      : methodNotAllowed("POST");
  }

  if (path === "/admin/mailboxes") {
    return request.method === "POST" ? adminCreateMailbox(request, env) : methodNotAllowed("POST");
  }
  if (path === "/admin/tokens") {
    if (request.method === "GET") {
      return adminListTokens(request, env, url);
    }
    if (request.method === "POST") {
      return adminMintToken(request, env);
    }
    return methodNotAllowed("GET, POST");
  }
  const adminRevoke = path.match(/^\/admin\/tokens\/([^/]+)\/revoke$/);
  if (adminRevoke) {
    return request.method === "POST"
      ? adminRevokeToken(request, env, decodeURIComponent(adminRevoke[1]))
      : methodNotAllowed("POST");
  }

  if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    return handleV1(request, env, url);
  }
  return null;
}

async function handleV1(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/v1" || path === "/api/v1/") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return json({
      ok: true,
      service: "postgrove",
      api: "v1",
      hint: "Send Authorization: Bearer pg_… for mailbox-scoped REST. See README (Open REST API).",
    });
  }

  const oversize = rejectOversize(request, env);
  if (oversize) {
    return oversize;
  }

  const gate = await requireRestAuth(request, env);
  if (!gate.ok) {
    return gate.response;
  }

  const limited = consumeRateLimit(restLimitKey(request, gate.principal), restConfig(env));
  if (!limited.ok) {
    return limited.response;
  }

  const principal = gate.principal;

  if (path === "/api/v1/mailboxes") {
    if (method === "GET") {
      return listAddresses(env, principal);
    }
    if (method === "POST") {
      return createAddress(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  const mailboxMessages = path.match(/^\/api\/v1\/mailboxes\/([^/]+)\/messages$/);
  if (mailboxMessages) {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return listMessages(env, principal, decodeURIComponent(mailboxMessages[1]), url);
  }

  const oneMailbox = path.match(/^\/api\/v1\/mailboxes\/([^/]+)$/);
  if (oneMailbox) {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return readMailbox(env, principal, decodeURIComponent(oneMailbox[1]));
  }

  const oneMessage = path.match(/^\/api\/v1\/messages\/([^/]+)$/);
  if (oneMessage) {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return readMessage(env, principal, decodeURIComponent(oneMessage[1]));
  }

  if (path === "/api/v1/send") {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return sendMessage(request, env, principal);
  }

  return notFoundJson();
}

async function requireRestAuth(request: Request, env: Env): Promise<AuthResult<RestPrincipal>> {
  const provided = bearerToken(request.headers.get("authorization"));
  if (!provided) {
    return {
      ok: false,
      response: unauthorizedJson(
        "Send Authorization: Bearer <API token> (pg_…). Mint one with an owner session (POST /api/tokens) or admin (POST /admin/tokens).",
      ),
    };
  }

  if (looksLikeApiToken(provided)) {
    const hash = await hashApiToken(provided);
    let row: ApiTokenRecord | null;
    try {
      row = await findApiTokenByHash(env, hash);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      return {
        ok: false,
        response: json(
          {
            ok: false,
            error: "token_lookup_failed",
            hint: "Check the D1 binding and that migration 0008_api_tokens.sql has been applied.",
            detail,
          },
          503,
        ),
      };
    }
    if (!row || row.revoked_at) {
      return {
        ok: false,
        response: unauthorizedJson("Invalid or revoked API token."),
      };
    }
    const mailbox = await getMailbox(env, row.mailbox_id);
    if (!mailbox || mailbox.status !== "active") {
      return {
        ok: false,
        response: unauthorizedJson("API token mailbox is missing or disabled."),
      };
    }
    return {
      ok: true,
      principal: {
        kind: "token",
        tokenId: row.id,
        mailboxId: mailbox.id,
        address: mailbox.address,
      },
    };
  }

  const admin = requireAdmin(request, env);
  if (admin.ok) {
    return admin;
  }
  return {
    ok: false,
    response: unauthorizedJson("Invalid API token. Use a pg_… token or the admin bearer."),
  };
}

async function listAddresses(env: Env, principal: RestPrincipal): Promise<Response> {
  if (principal.kind === "admin") {
    const mailboxes = await listMailboxes(env);
    return json({ ok: true, mailboxes: mailboxes.map(publicMailbox) });
  }
  const mailbox = await getMailbox(env, principal.mailboxId);
  if (!mailbox) {
    return notFoundJson();
  }
  return json({ ok: true, mailboxes: [publicMailbox(mailbox)] });
}

async function readMailbox(env: Env, principal: RestPrincipal, idOrAddress: string): Promise<Response> {
  const mailbox = await getMailbox(env, idOrAddress);
  if (!mailbox) {
    return notFoundJson();
  }
  const denied = denyOtherMailbox(principal, mailbox);
  if (denied) {
    return denied;
  }
  return json({ ok: true, mailbox: publicMailbox(mailbox) });
}

async function createAddress(request: Request, env: Env): Promise<Response> {
  const parsed = await readJsonObject(request, env, 'Send JSON { "address" } (optional display_name).');
  if (!parsed.ok) {
    return parsed.response;
  }
  const address = stringField(parsed.body, "address");
  if (!address) {
    return json(
      { ok: false, error: "invalid_request", hint: 'Send JSON { "address" } (optional display_name).' },
      400,
    );
  }
  const created = await insertMailbox(env, {
    address,
    displayName: stringField(parsed.body, "display_name"),
  });
  if (!created.ok) {
    return json({ ok: false, error: created.error, hint: created.hint }, created.error === "address_taken" ? 409 : 400);
  }
  return json({ ok: true, mailbox: publicMailbox(created.mailbox) }, 201);
}

async function listMessages(
  env: Env,
  principal: RestPrincipal,
  mailboxKey: string,
  url: URL,
): Promise<Response> {
  const mailbox = await getMailbox(env, mailboxKey);
  if (!mailbox) {
    return notFoundJson();
  }
  const denied = denyOtherMailbox(principal, mailbox);
  if (denied) {
    return denied;
  }
  const folder = parseFolder(url.searchParams.get("folder"));
  const messages =
    folder === "inbox"
      ? await listInboxMessages(env, mailbox.id, {})
      : await listFolderMessages(env, mailbox.id, folder);
  return json({
    ok: true,
    mailbox: publicMailbox(mailbox),
    folder,
    messages: messages.map(publicMessageListItem),
  });
}

async function readMessage(env: Env, principal: RestPrincipal, messageId: string): Promise<Response> {
  const existing = await getMessageById(env, messageId);
  if (!existing) {
    return notFoundJson();
  }
  const mailbox = await getMailbox(env, existing.mailbox_id);
  if (!mailbox) {
    return notFoundJson();
  }
  const denied = denyOtherMailbox(principal, mailbox);
  if (denied) {
    return denied;
  }
  if (existing.folder === "inbox" && existing.is_read !== 1) {
    await markRead(env, existing.mailbox_id, existing.id);
  }
  const message =
    existing.folder === "inbox"
      ? await getInboxMessage(env, existing.mailbox_id, existing.id)
      : await getMailboxMessage(env, existing.mailbox_id, existing.id);
  if (!message) {
    return notFoundJson();
  }
  return json({ ok: true, message: publicMessageDetail(message) });
}

async function sendMessage(request: Request, env: Env, principal: RestPrincipal): Promise<Response> {
  const parsed = await readJsonObject(
    request,
    env,
    'Send JSON { "to", "subject", "text" } (optional cc, in_reply_to, references, mailbox_id).',
  );
  if (!parsed.ok) {
    return parsed.response;
  }

  const mailboxKey =
    stringField(parsed.body, "mailbox_id") ??
    stringField(parsed.body, "from") ??
    (principal.kind === "token" ? principal.mailboxId : null);
  if (!mailboxKey) {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Admin send needs mailbox_id (or from). Token send uses the bound mailbox.',
      },
      400,
    );
  }
  const mailbox = await getMailbox(env, mailboxKey);
  if (!mailbox) {
    return notFoundJson();
  }
  const denied = denyOtherMailbox(principal, mailbox);
  if (denied) {
    return denied;
  }

  const fields = parseSendFields(parsed.body);
  if (!fields.ok) {
    return json({ ok: false, error: fields.error, hint: fields.hint }, 400);
  }
  const outcome = await sendOutbound(env, mailbox, fields.input);
  return json(
    {
      ok: outcome.attempt.status === "sent",
      attempt: publicAttempt(outcome.attempt),
      sent: outcome.sent ? publicMessageDetail(outcome.sent) : null,
      error: outcome.attempt.error,
      hint: outcome.attempt.hint,
    },
    outcome.httpStatus,
  );
}

async function handlePublicSignup(request: Request, env: Env): Promise<Response> {
  const oversize = rejectOversize(request, env);
  if (oversize) {
    return oversize;
  }

  const limited = consumeRateLimit(`signup:${clientKey(request)}`, signupConfig(env));
  if (!limited.ok) {
    return limited.response;
  }

  const secret = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  if (!turnstileConfigured(secret)) {
    return json(
      {
        ok: false,
        error: "public_signup_disabled",
        hint: "Public signup is off by default. Set TURNSTILE_SECRET_KEY (and TURNSTILE_SITE_KEY for the widget) to enable it, or create addresses with an owner session / admin / API token.",
      },
      403,
    );
  }

  const parsed = await readJsonObject(
    request,
    env,
    'Send JSON { "address", "turnstile_token" } (optional display_name).',
  );
  if (!parsed.ok) {
    return parsed.response;
  }
  const address = stringField(parsed.body, "address");
  const challenge =
    stringField(parsed.body, "turnstile_token") ??
    stringField(parsed.body, "cf-turnstile-response") ??
    stringField(parsed.body, "token");
  if (!address) {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "address", "turnstile_token" } (optional display_name).',
      },
      400,
    );
  }

  const verified = await verifyTurnstile({
    secret,
    response: challenge ?? "",
    remoteip: remoteIp(request) ?? undefined,
  });
  if (!verified.ok) {
    return json({ ok: false, error: verified.error, hint: verified.hint }, 403);
  }

  const created = await insertMailbox(env, {
    address,
    displayName: stringField(parsed.body, "display_name"),
  });
  if (!created.ok) {
    return json({ ok: false, error: created.error, hint: created.hint }, created.error === "address_taken" ? 409 : 400);
  }

  const issued = await insertApiToken(env, created.mailbox.id, "public-signup");
  return json(
    {
      ok: true,
      mailbox: publicMailbox(created.mailbox),
      token: publicToken(issued.record, issued.token),
    },
    201,
  );
}

async function adminCreateMailbox(request: Request, env: Env): Promise<Response> {
  const gate = requireAdmin(request, env);
  if (!gate.ok) {
    return gate.response;
  }
  return createAddress(request, env);
}

async function adminMintToken(request: Request, env: Env): Promise<Response> {
  const gate = requireAdmin(request, env);
  if (!gate.ok) {
    return gate.response;
  }
  const parsed = await readJsonObject(request, env, 'Send JSON { "mailbox_id" } (optional label).');
  if (!parsed.ok) {
    return parsed.response;
  }
  const mailboxKey = stringField(parsed.body, "mailbox_id") ?? stringField(parsed.body, "address");
  if (!mailboxKey) {
    return json(
      { ok: false, error: "invalid_request", hint: 'Send JSON { "mailbox_id" } (optional label).' },
      400,
    );
  }
  return mintForMailbox(env, mailboxKey, stringField(parsed.body, "label"));
}

async function adminListTokens(request: Request, env: Env, url: URL): Promise<Response> {
  const gate = requireAdmin(request, env);
  if (!gate.ok) {
    return gate.response;
  }
  const mailboxKey = url.searchParams.get("mailbox_id") ?? url.searchParams.get("address");
  if (!mailboxKey) {
    return json(
      { ok: false, error: "invalid_request", hint: "Pass mailbox_id (or address) as a query parameter." },
      400,
    );
  }
  const mailbox = await getMailbox(env, mailboxKey);
  if (!mailbox) {
    return notFoundJson();
  }
  const tokens = await listApiTokens(env, mailbox.id);
  return json({ ok: true, mailbox: publicMailbox(mailbox), tokens: tokens.map((row) => publicToken(row)) });
}

async function adminRevokeToken(request: Request, env: Env, tokenId: string): Promise<Response> {
  const gate = requireAdmin(request, env);
  if (!gate.ok) {
    return gate.response;
  }
  const existing = await getApiToken(env, tokenId);
  if (!existing) {
    return notFoundJson();
  }
  const revoked = await revokeApiToken(env, tokenId, null);
  if (!revoked) {
    return notFoundJson();
  }
  return json({ ok: true, token: publicToken(revoked) });
}

/** Owner-session mint / list / revoke (cookie /api/tokens). */
export async function handleOwnerTokenRoutes(
  request: Request,
  env: Env,
  url: URL,
  owner: OwnerPrincipal,
): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/tokens") {
    if (request.method === "GET") {
      const tokens = await listApiTokens(env, owner.mailboxId);
      return json({
        ok: true,
        mailbox: { id: owner.mailboxId, address: owner.address },
        tokens: tokens.map((row) => publicToken(row)),
      });
    }
    if (request.method === "POST") {
      const parsed = await readJsonObject(request, env, 'Send JSON { "label" } (label optional).');
      if (!parsed.ok) {
        return parsed.response;
      }
      return mintForMailbox(env, owner.mailboxId, stringField(parsed.body, "label"));
    }
    return methodNotAllowed("GET, POST");
  }
  const revoke = path.match(/^\/api\/tokens\/([^/]+)\/revoke$/);
  if (revoke) {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const revoked = await revokeApiToken(env, decodeURIComponent(revoke[1]), owner.mailboxId);
    if (!revoked) {
      return notFoundJson();
    }
    return json({ ok: true, token: publicToken(revoked) });
  }
  return null;
}

async function mintForMailbox(env: Env, mailboxKey: string, label: string | null): Promise<Response> {
  const mailbox = await getMailbox(env, mailboxKey);
  if (!mailbox) {
    return notFoundJson();
  }
  if (mailbox.status !== "active") {
    return json(
      { ok: false, error: "mailbox_disabled", hint: "Mint tokens only for an active mailbox." },
      400,
    );
  }
  const issued = await insertApiToken(env, mailbox.id, label);
  return json(
    {
      ok: true,
      mailbox: publicMailbox(mailbox),
      token: publicToken(issued.record, issued.token),
      hint: "Store the token now. Only the hash is kept; the secret is shown once.",
    },
    201,
  );
}

function denyOtherMailbox(principal: RestPrincipal, mailbox: MailboxRecord): Response | null {
  if (principal.kind === "admin") {
    return null;
  }
  if (principal.mailboxId === mailbox.id || principal.address === mailbox.address) {
    return null;
  }
  return forbiddenJson(REST_CROSS_MAILBOX_HINT);
}

export function restBodyMaxBytes(env: Env): number {
  return parsePositiveInt(env.REST_BODY_MAX_BYTES, DEFAULT_REST_BODY_MAX_BYTES);
}

function rejectOversize(request: Request, env: Env): Response | null {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  const max = restBodyMaxBytes(env);
  const raw = request.headers.get("content-length");
  if (!raw) {
    return null;
  }
  const size = Number.parseInt(raw, 10);
  if (!Number.isFinite(size) || size < 0) {
    return null;
  }
  if (size > max) {
    return payloadTooLargeJson(max);
  }
  return null;
}

async function readJsonObject(
  request: Request,
  env: Env,
  hint: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const max = restBodyMaxBytes(env);
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ ok: false, error: "invalid_request", hint }, 400) };
  }
  if (text.length > max) {
    return { ok: false, response: payloadTooLargeJson(max) };
  }
  if (!text.trim()) {
    return { ok: false, response: json({ ok: false, error: "invalid_request", hint }, 400) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, response: json({ ok: false, error: "invalid_request", hint }, 400) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: json({ ok: false, error: "invalid_request", hint }, 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function restLimitKey(request: Request, principal: RestPrincipal): string {
  if (principal.kind === "token") {
    return `rest:token:${principal.tokenId}`;
  }
  return `rest:admin:${clientKey(request)}`;
}

function restConfig(env: Env) {
  return restRateLimitConfig(
    parsePositiveInt(env.REST_RATE_LIMIT_MAX, REST_RATE_LIMIT_MAX),
    parsePositiveInt(env.REST_RATE_LIMIT_WINDOW_MS, REST_RATE_LIMIT_WINDOW_MS),
  );
}

function signupConfig(env: Env) {
  return signupRateLimitConfig(
    parsePositiveInt(env.SIGNUP_RATE_LIMIT_MAX, SIGNUP_RATE_LIMIT_MAX),
    parsePositiveInt(env.SIGNUP_RATE_LIMIT_WINDOW_MS, SIGNUP_RATE_LIMIT_WINDOW_MS),
  );
}

function remoteIp(request: Request): string | null {
  const key = clientKey(request);
  return key.startsWith("ip:") && key !== "ip:unknown" ? key.slice(3) : null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function publicMailbox(row: MailboxRecord) {
  return {
    id: row.id,
    address: row.address,
    display_name: row.display_name,
    status: row.status,
  };
}

function publicMessageListItem(row: MessageRecord) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    from: row.envelope_from,
    to: row.envelope_to,
    subject: row.subject,
    snippet: row.snippet,
    is_read: row.is_read === 1,
    is_starred: row.is_starred === 1,
    folder: row.folder,
    received_at: row.received_at,
  };
}

function publicMessageDetail(row: MessageRecord) {
  return {
    ...publicMessageListItem(row),
    rfc_message_id: row.rfc_message_id,
    body_text: row.body_text,
    header_to: row.header_to,
    header_cc: row.header_cc,
    header_reply_to: row.header_reply_to,
    in_reply_to: row.in_reply_to,
    references: row.references_header,
    size_bytes: row.size_bytes,
  };
}

function publicAttempt(row: {
  id: string;
  mailbox_id: string;
  from_address: string;
  to_address: string;
  cc_address: string | null;
  subject: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  provider: string;
  status: string;
  error: string | null;
  hint: string | null;
  provider_message_id: string | null;
  created_at: number;
}) {
  return {
    id: row.id,
    mailbox_id: row.mailbox_id,
    from: row.from_address,
    to: row.to_address,
    cc: row.cc_address,
    subject: row.subject,
    in_reply_to: row.in_reply_to,
    references: row.references_header,
    provider: row.provider,
    status: row.status,
    error: row.error,
    hint: row.hint,
    provider_message_id: row.provider_message_id,
    created_at: row.created_at,
  };
}
