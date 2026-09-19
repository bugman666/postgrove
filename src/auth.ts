import { findApiTokenByHash, hashApiToken, looksLikeApiToken } from "./api-tokens.ts";
import type { Env } from "./env";
import { describeAuthMode, findUserByMailboxToken, getUser, listUserMailboxIds } from "./users.ts";

/** Cookie Inbox and other Worker routes should send after owner login. */
export const OWNER_SESSION_COOKIE = "postgrove_session";
/** Separate from the mailbox cookie so ADMIN_TOKEN login does not clobber inbox. */
export const ADMIN_SESSION_COOKIE = "postgrove_admin";

/** Owner session lifetime. Rotate SESSION_SECRET to revoke all sessions. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Login attempts allowed per IP per window. In-memory, per Worker isolate. */
export const LOGIN_RATE_LIMIT_MAX = 8;
/** Fixed window for POST /auth/login (10 minutes). */
export const LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const SESSION_VERSION = 1;
const MIN_SESSION_SECRET_LENGTH = 16;
const MIN_TOKEN_LENGTH = 8;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RATE_LIMIT_PRUNE_AT = 512;

type LoginRateBucket = { count: number; resetAt: number };

/** Best-effort per-isolate counters. A new isolate starts a fresh window. */
const loginAttempts = new Map<string, LoginRateBucket>();

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export type OwnerPrincipal = {
  kind: "owner";
  mailboxId: string;
  address: string;
};

export type MailboxUserPrincipal = {
  kind: "mailbox";
  mailboxId: string;
  address: string;
  userId: string;
  role: "admin" | "mailbox";
  mailboxIds: string[];
};

/** Mailbox-bound session: deploy owner (OWNER_TOKEN) or a users-table member. */
export type MailboxActor = OwnerPrincipal | MailboxUserPrincipal;

export type AdminPrincipal = {
  kind: "admin";
  userId?: string;
  source: "bearer" | "session";
};

export type Principal = MailboxActor | AdminPrincipal;

export type AuthResult<T> =
  | { ok: true; principal: T }
  | { ok: false; response: Response };

interface SessionPayload {
  v: number;
  mid?: string;
  addr?: string;
  uid?: string;
  role?: string;
  exp: number;
}

/**
 * Auth HTTP surface. Returns null when the request is not an auth/admin route
 * so the Worker can keep /healthz public.
 *
 * Owner: POST /auth/login { address, token: OWNER_TOKEN } → HttpOnly cookie.
 * OWNER_TOKEN is one shared secret for every mailbox (not a per-address password).
 * Production: prefer member tokens + admin; OWNER_TOKEN is break-glass only
 * (docs/PRODUCTION_AUTH.md). Mailbox user: same JSON, member token (users table).
 * Inbox calls `requireOwner` and returns `result.response` when `ok` is false.
 *
 * Admin: Authorization: Bearer <ADMIN_TOKEN>, or admin-role session cookie,
 * or POST /admin/session { token: ADMIN_TOKEN } → postgrove_admin cookie.
 * Use `requireAdmin`. Missing credentials → 401; mailbox/owner session → 403.
 *
 * Login is rate-limited per IP. Cookie-authenticated writes also check Origin
 * (or Referer) against this Worker. Rotate SESSION_SECRET to revoke all sessions.
 */
export async function handleAuthRoutes(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/auth/login") {
    return method === "POST" ? handleLogin(request, env) : methodNotAllowed("POST");
  }
  if (path === "/auth/logout") {
    return method === "POST" ? handleLogout(request) : methodNotAllowed("POST");
  }
  if (path === "/auth/session") {
    return method === "GET" ? handleSession(request, env) : methodNotAllowed("GET");
  }
  if (path === "/admin/ping") {
    return method === "GET" ? handleAdminPing(request, env) : methodNotAllowed("GET");
  }
  if (path === "/admin/session") {
    if (method === "GET") {
      return handleAdminSession(request, env);
    }
    if (method === "POST") {
      return handleAdminLogin(request, env);
    }
    return methodNotAllowed("GET, POST");
  }
  if (path === "/admin/logout") {
    return method === "POST" ? handleAdminLogout(request) : methodNotAllowed("POST");
  }
  return null;
}

/** Verify the owner/mailbox session cookie. Inbox list/read/delete should call this. */
export async function requireOwner(
  request: Request,
  env: Env,
): Promise<AuthResult<MailboxActor>> {
  const configured = sessionSecret(env);
  if (!configured.ok) {
    return configured;
  }

  const csrf = rejectCrossOriginMutation(request);
  if (csrf) {
    return { ok: false, response: csrf };
  }

  const token = cookieValue(request.headers.get("cookie"), OWNER_SESSION_COOKIE);
  if (!token) {
    return {
      ok: false,
      response: jsonError(
        401,
        "unauthorized",
        "POST /auth/login with address and token, then send the session cookie.",
      ),
    };
  }

  const principal = await verifyOwnerSession(configured.secret, token);
  if (!principal) {
    return {
      ok: false,
      response: jsonError(
        401,
        "unauthorized",
        "Session expired or invalid. POST /auth/login to obtain a new cookie.",
      ),
    };
  }

  if (principal.kind === "mailbox") {
    const hydrated = await hydrateMailboxUser(env, principal);
    if (!hydrated.ok) {
      return hydrated;
    }
    return { ok: true, principal: hydrated.principal };
  }

  return { ok: true, principal };
}

/**
 * Admin bearer, admin-role mailbox session, or postgrove_admin cookie.
 * No credentials → 401. A mailbox/owner session without admin → 403.
 */
export async function requireAdmin(
  request: Request,
  env: Env,
): Promise<AuthResult<AdminPrincipal>> {
  const configured = adminToken(env);
  if (!configured.ok) {
    return configured;
  }

  const provided = bearerToken(request.headers.get("authorization"));
  if (provided) {
    if (looksLikeApiToken(provided)) {
      try {
        const row = await findApiTokenByHash(env, await hashApiToken(provided));
        if (row && !row.revoked_at && row.kind === "admin") {
          return { ok: true, principal: { kind: "admin", source: "bearer" } };
        }
      } catch {
        // Missing api_tokens columns: fall through to 401.
      }
      return {
        ok: false,
        response: jsonError(
          401,
          "unauthorized",
          "Invalid or revoked admin API token. Mailbox-scoped pg_ keys cannot open admin routes.",
        ),
      };
    }
    if (!timingSafeEqualString(provided, configured.token)) {
      return {
        ok: false,
        response: jsonError(
          401,
          "unauthorized",
          "Send Authorization: Bearer <ADMIN_TOKEN>.",
        ),
      };
    }
    return { ok: true, principal: { kind: "admin", source: "bearer" } };
  }

  const csrf = rejectCrossOriginMutation(request);
  if (csrf) {
    return { ok: false, response: csrf };
  }

  const secret = sessionSecret(env);
  if (!secret.ok) {
    return secret;
  }

  const adminCookie = cookieValue(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  if (adminCookie) {
    const admin = await verifyAdminSession(secret.secret, adminCookie);
    if (admin) {
      return { ok: true, principal: admin };
    }
  }

  const ownerCookie = cookieValue(request.headers.get("cookie"), OWNER_SESSION_COOKIE);
  if (ownerCookie) {
    const actor = await verifyOwnerSession(secret.secret, ownerCookie);
    if (actor?.kind === "mailbox" && actor.role === "admin") {
      const hydrated = await hydrateMailboxUser(env, actor);
      if (!hydrated.ok) {
        return hydrated;
      }
      if (hydrated.principal.kind === "mailbox" && hydrated.principal.role === "admin") {
        return {
          ok: true,
          principal: { kind: "admin", userId: hydrated.principal.userId, source: "session" },
        };
      }
    }
    if (actor) {
      return {
        ok: false,
        response: jsonError(
          403,
          "forbidden",
          "Admin routes need an admin role or Authorization: Bearer <ADMIN_TOKEN>.",
        ),
      };
    }
  }

  return {
    ok: false,
    response: jsonError(
      401,
      "unauthorized",
      "Send Authorization: Bearer <ADMIN_TOKEN>, POST /admin/session, or sign in as an admin-role member.",
    ),
  };
}

/** Admin bearer wins; otherwise an owner/mailbox session is accepted. */
export async function requireAdminOrOwner(
  request: Request,
  env: Env,
): Promise<AuthResult<Principal>> {
  const admin = await requireAdmin(request, env);
  if (admin.ok) {
    return admin;
  }
  if (bearerToken(request.headers.get("authorization"))) {
    return admin;
  }
  return requireOwner(request, env);
}

export function actorUserId(actor: MailboxActor): string | undefined {
  return actor.kind === "mailbox" ? actor.userId : undefined;
}

export async function signOwnerSession(
  secret: string,
  principal: Omit<OwnerPrincipal, "kind">,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  return signSession(secret, {
    v: SESSION_VERSION,
    mid: principal.mailboxId,
    addr: principal.address,
    exp: nowSeconds + SESSION_MAX_AGE_SECONDS,
  });
}

export async function signUserSession(
  secret: string,
  principal: {
    mailboxId: string;
    address: string;
    userId: string;
    role: "admin" | "mailbox";
  },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  return signSession(secret, {
    v: SESSION_VERSION,
    mid: principal.mailboxId,
    addr: principal.address,
    uid: principal.userId,
    role: principal.role,
    exp: nowSeconds + SESSION_MAX_AGE_SECONDS,
  });
}

export async function signAdminSession(
  secret: string,
  userId?: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  return signSession(secret, {
    v: SESSION_VERSION,
    role: "admin",
    uid: userId,
    exp: nowSeconds + SESSION_MAX_AGE_SECONDS,
  });
}

export async function verifyOwnerSession(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<MailboxActor | null> {
  const payload = await readSignedPayload(secret, token, nowSeconds);
  if (!payload?.mid || !payload.addr) {
    return null;
  }
  if (payload.uid && (payload.role === "admin" || payload.role === "mailbox")) {
    return {
      kind: "mailbox",
      mailboxId: payload.mid,
      address: payload.addr,
      userId: payload.uid,
      role: payload.role,
      mailboxIds: [payload.mid],
    };
  }
  return { kind: "owner", mailboxId: payload.mid, address: payload.addr };
}

export async function verifyAdminSession(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AdminPrincipal | null> {
  const payload = await readSignedPayload(secret, token, nowSeconds);
  if (!payload || payload.role !== "admin") {
    return null;
  }
  return payload.uid
    ? { kind: "admin", userId: payload.uid, source: "session" }
    : { kind: "admin", source: "session" };
}

async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = bytesToB64url(await hmacSha256(secret, body));
  return `v1.${body}.${sig}`;
}

async function readSignedPayload(
  secret: string,
  token: string,
  nowSeconds: number,
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return null;
  }
  const body = parts[1];
  const sig = parts[2];
  const expected = bytesToB64url(await hmacSha256(secret, body));
  if (!timingSafeEqualString(sig, expected)) {
    return null;
  }
  const bytes = b64urlToBytes(body);
  if (!bytes) {
    return null;
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as SessionPayload;
  } catch {
    return null;
  }
  if (payload.v !== SESSION_VERSION || typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    return null;
  }
  return payload;
}

async function hydrateMailboxUser(
  env: Env,
  principal: MailboxUserPrincipal,
): Promise<AuthResult<MailboxUserPrincipal>> {
  try {
    const user = await getUser(env, principal.userId);
    if (!user || user.status !== "active") {
      return {
        ok: false,
        response: jsonError(
          403,
          "user_disabled",
          "This member is disabled. Ask an admin to enable the account.",
        ),
      };
    }
    const mailboxIds = await listUserMailboxIds(env, user.id);
    return {
      ok: true,
      principal: {
        kind: "mailbox",
        mailboxId: principal.mailboxId,
        address: principal.address,
        userId: user.id,
        role: user.role,
        mailboxIds,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    return {
      ok: false,
      response: jsonError(
        503,
        "user_lookup_failed",
        "Check the D1 binding and that local migrations have been applied.",
        { detail },
      ),
    };
  }
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const max = Math.max(left.byteLength, right.byteLength);
  let diff = left.byteLength === right.byteLength ? 0 : 1;
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const secret = sessionSecret(env);
  if (!secret.ok) {
    return secret.response;
  }
  const owner = ownerToken(env);
  if (!owner.ok) {
    return owner.response;
  }

  const limited = consumeLoginAttempt(request);
  if (!limited.ok) {
    return limited.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Send JSON { \"address\", \"token\" }.");
  }
  if (!body || typeof body !== "object") {
    return jsonError(400, "invalid_request", "Send JSON { \"address\", \"token\" }.");
  }

  const addressRaw = "address" in body ? body.address : null;
  const tokenRaw = "token" in body ? body.token : null;
  if (typeof addressRaw !== "string" || typeof tokenRaw !== "string") {
    return jsonError(400, "invalid_request", "Send JSON { \"address\", \"token\" }.");
  }

  const address = addressRaw.trim().toLowerCase();
  let mailbox: { id: string; address: string } | null = null;
  try {
    mailbox = await lookupActiveMailbox(env, address);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    return jsonError(
      503,
      "mailbox_lookup_failed",
      "Check the D1 binding and that local migrations have been applied.",
      { detail },
    );
  }
  const tokenOk = timingSafeEqualString(tokenRaw, owner.token);

  if (tokenOk && mailbox) {
    const cookie = await signOwnerSession(secret.secret, {
      mailboxId: mailbox.id,
      address: mailbox.address,
    });
    return json(
      {
        ok: true,
        role: "owner",
        mailbox: { id: mailbox.id, address: mailbox.address },
      },
      200,
      {
        "set-cookie": serializeCookie(
          OWNER_SESSION_COOKIE,
          cookie,
          request,
          SESSION_MAX_AGE_SECONDS,
        ),
      },
    );
  }

  if (mailbox) {
    try {
      const user = await findUserByMailboxToken(env, mailbox.id, tokenRaw);
      if (user) {
        const mailboxIds = await listUserMailboxIds(env, user.id);
        const cookie = await signUserSession(secret.secret, {
          mailboxId: mailbox.id,
          address: mailbox.address,
          userId: user.id,
          role: user.role,
        });
        return json(
          {
            ok: true,
            role: user.role,
            user: { id: user.id, login: user.login, role: user.role },
            mailbox: { id: mailbox.id, address: mailbox.address },
            mailboxes: mailboxIds,
          },
          200,
          {
            "set-cookie": serializeCookie(
              OWNER_SESSION_COOKIE,
              cookie,
              request,
              SESSION_MAX_AGE_SECONDS,
            ),
          },
        );
      }
    } catch {
      // Missing users table or a mailbox-only D1 mock: fall through to 401.
    }
  }

  return jsonError(
    401,
    "unauthorized",
    "Unknown address or invalid token. Use an active mailbox and OWNER_TOKEN, or a member token bound to that address.",
  );
}

function handleLogout(request: Request): Response {
  const csrf = rejectCrossOriginMutation(request);
  if (csrf) {
    return csrf;
  }
  return json({ ok: true }, 200, {
    "set-cookie": serializeCookie(OWNER_SESSION_COOKIE, "", request, 0),
  });
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  const result = await requireOwner(request, env);
  if (!result.ok) {
    return result.response;
  }
  const principal = result.principal;
  if (principal.kind === "mailbox") {
    return json({
      ok: true,
      role: principal.role,
      user: { id: principal.userId, role: principal.role },
      mailbox: { id: principal.mailboxId, address: principal.address },
      mailboxes: principal.mailboxIds,
    });
  }
  return json({
    ok: true,
    role: "owner",
    mailbox: { id: principal.mailboxId, address: principal.address },
  });
}

async function handleAdminPing(request: Request, env: Env): Promise<Response> {
  const result = await requireAdmin(request, env);
  if (!result.ok) {
    return result.response;
  }
  const authMode = await describeAuthMode(env);
  const body: Record<string, unknown> = {
    ok: true,
    role: "admin",
    source: result.principal.source,
  };
  if (authMode) {
    body.auth_mode = authMode;
  }
  return json(body);
}

async function handleAdminSession(request: Request, env: Env): Promise<Response> {
  const result = await requireAdmin(request, env);
  if (!result.ok) {
    return result.response;
  }
  return json({
    ok: true,
    role: "admin",
    source: result.principal.source,
    user_id: result.principal.userId ?? null,
  });
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  const secret = sessionSecret(env);
  if (!secret.ok) {
    return secret.response;
  }
  const admin = adminToken(env);
  if (!admin.ok) {
    return admin.response;
  }

  const limited = consumeLoginAttempt(request);
  if (!limited.ok) {
    return limited.response;
  }

  let tokenRaw: string | null = null;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = await request.json();
      if (body && typeof body === "object" && "token" in body && typeof body.token === "string") {
        tokenRaw = body.token;
      }
    } catch {
      return jsonError(400, "invalid_request", 'Send JSON { "token": "<ADMIN_TOKEN>" }.');
    }
  } else {
    const data = await request.formData();
    const value = data.get("token");
    tokenRaw = typeof value === "string" ? value : null;
  }
  if (!tokenRaw) {
    return jsonError(400, "invalid_request", 'Send JSON { "token": "<ADMIN_TOKEN>" }.');
  }
  if (!timingSafeEqualString(tokenRaw, admin.token)) {
    return jsonError(
      401,
      "unauthorized",
      "Invalid admin token. Use ADMIN_TOKEN from .dev.vars.",
    );
  }

  const cookie = await signAdminSession(secret.secret);
  return json(
    { ok: true, role: "admin", source: "session" },
    200,
    {
      "set-cookie": serializeCookie(
        ADMIN_SESSION_COOKIE,
        cookie,
        request,
        SESSION_MAX_AGE_SECONDS,
      ),
    },
  );
}

function handleAdminLogout(request: Request): Response {
  const csrf = rejectCrossOriginMutation(request);
  if (csrf) {
    return csrf;
  }
  return json({ ok: true }, 200, {
    "set-cookie": serializeCookie(ADMIN_SESSION_COOKIE, "", request, 0),
  });
}

async function lookupActiveMailbox(
  env: Env,
  address: string,
): Promise<{ id: string; address: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id, address, status FROM mailboxes WHERE address = ?1`,
  )
    .bind(address)
    .first<{ id: string; address: string; status: string }>();
  if (!row || row.status !== "active") {
    return null;
  }
  return { id: row.id, address: row.address };
}

/**
 * Reject cookie-authenticated writes whose Origin/Referer is some other site.
 * SameSite=Lax already drops the cookie on most cross-site POSTs; this also
 * covers same-site / different-origin cases (sibling subdomains) and older
 * browsers that still send the cookie. Missing both headers is allowed so
 * curl and scripts keep working — browsers send Origin on POST.
 *
 * GET/HEAD/OPTIONS skip this check (inbox mark-as-read is still a GET).
 */
export function rejectCrossOriginMutation(request: Request): Response | null {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) {
    return null;
  }

  const expected = originOf(request.url);
  const originHeader = request.headers.get("origin");
  if (originHeader) {
    return originsEqual(originHeader, expected)
      ? null
      : csrfRejected("Origin does not match this site. Cookie-authenticated writes must be same-origin.");
  }

  const referer = request.headers.get("referer");
  if (!referer) {
    return null;
  }
  try {
    return originsEqual(new URL(referer).origin, expected)
      ? null
      : csrfRejected("Referer does not match this site. Cookie-authenticated writes must be same-origin.");
  } catch {
    return csrfRejected("Invalid Referer. Cookie-authenticated writes must be same-origin.");
  }
}

function csrfRejected(hint: string): Response {
  return jsonError(403, "csrf_rejected", hint);
}

function originOf(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

function originsEqual(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function consumeLoginAttempt(
  request: Request,
  now = Date.now(),
): { ok: true } | { ok: false; response: Response } {
  const key = loginClientKey(request);
  const existing = loginAttempts.get(key);
  if (!existing || existing.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS });
    pruneLoginAttempts(now);
    return { ok: true };
  }
  if (existing.count >= LOGIN_RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "rate_limited",
          hint: `Too many login attempts from this network. Wait a few minutes and try again (${LOGIN_RATE_LIMIT_MAX} per ${LOGIN_RATE_LIMIT_WINDOW_MS / 60_000} minutes per IP).`,
          retry_after_seconds: retryAfter,
        },
        429,
        { "retry-after": String(retryAfter) },
      ),
    };
  }
  existing.count += 1;
  return { ok: true };
}

function loginClientKey(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) {
    return `ip:${cf}`;
  }
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) {
    return `ip:${forwarded}`;
  }
  return "ip:unknown";
}

function pruneLoginAttempts(now: number): void {
  if (loginAttempts.size < RATE_LIMIT_PRUNE_AT) {
    return;
  }
  for (const [key, bucket] of loginAttempts) {
    if (bucket.resetAt <= now) {
      loginAttempts.delete(key);
    }
  }
}

/** Test helper: drop in-memory login counters. */
export function resetLoginRateLimitForTests(): void {
  loginAttempts.clear();
}

function sessionSecret(
  env: Env,
): { ok: true; secret: string } | { ok: false; response: Response } {
  const secret = env.SESSION_SECRET?.trim() ?? "";
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    return {
      ok: false,
      response: jsonError(
        503,
        "auth_not_configured",
        `Set SESSION_SECRET in .dev.vars (at least ${MIN_SESSION_SECRET_LENGTH} characters). See .dev.vars.example.`,
      ),
    };
  }
  return { ok: true, secret };
}

function ownerToken(
  env: Env,
): { ok: true; token: string } | { ok: false; response: Response } {
  const token = env.OWNER_TOKEN?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      response: jsonError(
        503,
        "auth_not_configured",
        `Set OWNER_TOKEN in .dev.vars (at least ${MIN_TOKEN_LENGTH} characters). See .dev.vars.example.`,
      ),
    };
  }
  return { ok: true, token };
}

function adminToken(
  env: Env,
): { ok: true; token: string } | { ok: false; response: Response } {
  const token = env.ADMIN_TOKEN?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      response: jsonError(
        503,
        "auth_not_configured",
        `Set ADMIN_TOKEN in .dev.vars (at least ${MIN_TOKEN_LENGTH} characters). See .dev.vars.example.`,
      ),
    };
  }
  return { ok: true, token };
}

export function bearerToken(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match ? match[1] : null;
}

export function cookieValue(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (trimmed.slice(0, eq) !== name) {
      continue;
    }
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

function serializeCookie(
  name: string,
  value: string,
  request: Request,
  maxAge: number,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (new URL(request.url).protocol === "https:") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function methodNotAllowed(allow: string): Response {
  return jsonError(405, "method_not_allowed", `Use ${allow}.`, { allow });
}

function json(
  body: Record<string, unknown>,
  status = 200,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      headers.append(key, value);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function jsonError(
  status: number,
  error: string,
  hint: string,
  extra?: Record<string, unknown>,
): Response {
  return json({ ok: false, error, hint, ...extra }, status);
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlToBytes(value: string): Uint8Array | null {
  try {
    const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}
