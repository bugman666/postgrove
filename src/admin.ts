import type { Env } from "./env.ts";
import { loadGroveStats, type GroveStats } from "./analytics.ts";
import { requireAdmin } from "./auth.ts";
import {
  BRAND_SAVED_HINT,
  BrandingInputError,
  loadBranding,
  publicBranding,
  saveBranding,
} from "./branding.ts";
import { html, json, methodNotAllowed, notFoundJson, quotaJson, redirect } from "./http.ts";
import { EMPTY_ART, escapeHtml, formatReceived } from "./html.ts";
import { resolveLocale } from "./i18n.ts";
import { checkAddressQuota, userUsage, type UserUsageSnapshot } from "./quotas.ts";
import { brandLink, documentLang, pageTitle, resolveShell, tr, type Shell } from "./view.ts";
import {
  createMailbox,
  getMailbox,
  listMailboxes,
  MailboxInputError,
  parseMailboxAddress,
  setMailboxStatus,
  type MailboxRecord,
  type MessageRecord,
} from "./store.ts";
import {
  bindUserMailbox,
  createUser,
  getUser,
  isUserRole,
  isUserStatus,
  listUsers,
  publicUser,
  setUserQuotas,
  setUserStatus,
  UserInputError,
  type UserRecord,
} from "./users.ts";
import {
  HookInputError,
  getHookConfig,
  listDeliveries,
  parseHookConfigBody,
  publicDelivery,
  publicHookConfig,
  saveHookConfig,
  type InboundDeliveryRecord,
} from "./webhooks.ts";

export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/admin" || path === "/admin/" || path === "/admin/overview") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return renderAdminHome(request, env, path.endsWith("/overview") ? "overview" : "desk");
  }

  if (path === "/admin/site") {
    if (method === "GET") {
      const saved = url.searchParams.get("saved") === "1";
      return renderAdminSite(request, env, saved ? BRAND_SAVED_HINT : undefined, false);
    }
    if (method === "POST") {
      return saveAdminSiteForm(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  const gate = await requireAdmin(request, env);
  if (!gate.ok) {
    return gate.response;
  }

  if (path === "/admin/stats") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return listAdminStats(env);
  }

  if (path === "/admin/branding") {
    if (method === "GET") {
      return listAdminBranding(env);
    }
    if (method === "POST") {
      return patchAdminBranding(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  if (path === "/admin/users") {
    if (method === "GET") {
      return listAdminUsers(env);
    }
    if (method === "POST") {
      return createAdminUser(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  const oneUser = path.match(/^\/admin\/users\/([^/]+)$/);
  if (oneUser) {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return patchAdminUser(request, env, decodeURIComponent(oneUser[1]));
  }

  if (path === "/admin/mailboxes") {
    if (method === "GET") {
      return listAdminMailboxes(env);
    }
    if (method === "POST") {
      return createAdminMailbox(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  const oneBox = path.match(/^\/admin\/mailboxes\/([^/]+)$/);
  if (oneBox) {
    if (method !== "POST") {
      return methodNotAllowed("POST");
    }
    return patchAdminMailbox(request, env, decodeURIComponent(oneBox[1]));
  }

  if (path === "/admin/messages") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return listAdminMessages(env, url);
  }

  if (path === "/admin/hooks") {
    if (method === "GET") {
      return getAdminHooks(env, url);
    }
    if (method === "POST") {
      return saveAdminHooks(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  if (path === "/admin/deliveries") {
    if (method !== "GET") {
      return methodNotAllowed("GET");
    }
    return listAdminDeliveries(env, url);
  }

  return notFoundJson();
}

async function listAdminStats(env: Env): Promise<Response> {
  try {
    const stats = await loadGroveStats(env);
    return json({
      ok: true,
      stats: {
        users: stats.users,
        messages_today: stats.messages_today,
        storage_mb: stats.storage_mb,
      },
    });
  } catch (error) {
    return migrateHint(error);
  }
}

async function listAdminBranding(env: Env): Promise<Response> {
  try {
    const brand = await loadBranding(env);
    return json({ ok: true, branding: publicBranding(brand) });
  } catch (error) {
    return migrateHint(error);
  }
}

async function patchAdminBranding(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "site_title", "logo_url", "accent" }.',
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "site_title", "logo_url", "accent" }.',
      },
      400,
    );
  }
  try {
    const saved = await saveBranding(env, body as Record<string, unknown>);
    return json({ ok: true, branding: publicBranding(saved), hint: BRAND_SAVED_HINT });
  } catch (error) {
    if (error instanceof BrandingInputError) {
      return json({ ok: false, error: error.error, hint: error.message }, 400);
    }
    return migrateHint(error);
  }
}

async function listAdminUsers(env: Env): Promise<Response> {
  try {
    const users = await listUsers(env);
    const rows = [];
    for (const user of users) {
      const usage = await userUsage(env, user.id);
      rows.push(publicUser(user, usage));
    }
    return json({ ok: true, users: rows });
  } catch (error) {
    return migrateHint(error);
  }
}

async function createAdminUser(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "login", "role": "mailbox"|"admin" } (optional token, display_name, quotas, mailbox).',
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "login", "role": "mailbox"|"admin" }.',
      },
      400,
    );
  }

  const record = body as Record<string, unknown>;
  const login = typeof record.login === "string" ? record.login : "";
  const roleRaw = typeof record.role === "string" ? record.role : "mailbox";
  if (!isUserRole(roleRaw)) {
    return json(
      { ok: false, error: "invalid_request", hint: 'role must be "mailbox" or "admin".' },
      400,
    );
  }

  const mailboxAddress = typeof record.mailbox === "string" ? record.mailbox.trim() : "";
  if (mailboxAddress) {
    if (!parseMailboxAddress(mailboxAddress)) {
      return json(
        { ok: false, error: "invalid_address", hint: "Address must look like local@domain.tld." },
        400,
      );
    }
    try {
      const existing = await getMailbox(env, mailboxAddress);
      if (existing) {
        return json(
          { ok: false, error: "address_taken", hint: "That address is already in this grove." },
          400,
        );
      }
    } catch (error) {
      return migrateHint(error);
    }
  }

  try {
    const created = await createUser(env, {
      login,
      displayName: typeof record.display_name === "string" ? record.display_name : null,
      role: roleRaw,
      token: typeof record.token === "string" ? record.token : null,
      quotaAddresses: optionalNumber(record.quota_addresses),
      quotaStorageBytes: optionalNumber(record.quota_storage_bytes),
      quotaSendDaily: optionalNumber(record.quota_send_daily),
    });

    let mailbox: MailboxRecord | null = null;
    if (mailboxAddress) {
      mailbox = await createMailbox(env, {
        address: mailboxAddress,
        displayName: created.user.display_name,
      });
      await bindUserMailbox(env, created.user.id, mailbox.id);
    }

    return json(
      {
        ok: true,
        user: publicUser(created.user),
        token: created.token,
        mailbox: mailbox ? publicMailbox(mailbox) : null,
      },
      201,
    );
  } catch (error) {
    if (error instanceof UserInputError || error instanceof MailboxInputError) {
      return json({ ok: false, error: error.error, hint: error.message }, 400);
    }
    return migrateHint(error);
  }
}

async function patchAdminUser(request: Request, env: Env, userId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "status": "active"|"disabled" } and/or quota fields.',
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "status": "active"|"disabled" } and/or quota fields.',
      },
      400,
    );
  }

  const record = body as Record<string, unknown>;
  try {
    let user = await getUser(env, userId);
    if (!user) {
      return notFoundJson();
    }
    if (typeof record.status === "string") {
      if (!isUserStatus(record.status)) {
        return json(
          { ok: false, error: "invalid_request", hint: 'status must be "active" or "disabled".' },
          400,
        );
      }
      user = await setUserStatus(env, user.id, record.status);
    }
    if (
      record.quota_addresses !== undefined ||
      record.quota_storage_bytes !== undefined ||
      record.quota_send_daily !== undefined
    ) {
      user = await setUserQuotas(env, userId, {
        quotaAddresses: optionalNumber(record.quota_addresses),
        quotaStorageBytes: optionalNumber(record.quota_storage_bytes),
        quotaSendDaily: optionalNumber(record.quota_send_daily),
      });
    }
    if (!user) {
      return notFoundJson();
    }
    const usage = await userUsage(env, user.id);
    return json({ ok: true, user: publicUser(user, usage) });
  } catch (error) {
    return migrateHint(error);
  }
}

async function listAdminMailboxes(env: Env): Promise<Response> {
  try {
    const boxes = await listMailboxes(env);
    return json({ ok: true, mailboxes: boxes.map(publicMailbox) });
  } catch (error) {
    return migrateHint(error);
  }
}

async function createAdminMailbox(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "address" } (optional display_name, user_id).',
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "address" } (optional display_name, user_id).',
      },
      400,
    );
  }
  const record = body as Record<string, unknown>;
  const address = typeof record.address === "string" ? record.address : "";
  const displayName = typeof record.display_name === "string" ? record.display_name : null;
  const userId = typeof record.user_id === "string" ? record.user_id.trim() : "";

  try {
    let user: UserRecord | null = null;
    if (userId) {
      user = await getUser(env, userId);
      if (!user) {
        return json({ ok: false, error: "not_found", hint: "Unknown user_id." }, 404);
      }
      const quota = await checkAddressQuota(env, user, resolveLocale(request));
      if (quota) {
        return quotaJson(quota.error, quota.hint, { used: quota.used, limit: quota.limit });
      }
    }
    const mailbox = await createMailbox(env, { address, displayName });
    if (user) {
      await bindUserMailbox(env, user.id, mailbox.id);
    }
    return json({ ok: true, mailbox: publicMailbox(mailbox) }, 201);
  } catch (error) {
    if (error instanceof MailboxInputError) {
      return json({ ok: false, error: error.error, hint: error.message }, 400);
    }
    return migrateHint(error);
  }
}

async function patchAdminMailbox(request: Request, env: Env, mailboxId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      { ok: false, error: "invalid_request", hint: 'Send JSON { "status": "active"|"disabled" }.' },
      400,
    );
  }
  const statusRaw =
    body && typeof body === "object" ? (body as Record<string, unknown>).status : null;
  if (statusRaw !== "active" && statusRaw !== "disabled") {
    return json(
      { ok: false, error: "invalid_request", hint: 'Send JSON { "status": "active"|"disabled" }.' },
      400,
    );
  }
  const mailbox = await setMailboxStatus(env, mailboxId, statusRaw);
  if (!mailbox) {
    return notFoundJson();
  }
  return json({ ok: true, mailbox: publicMailbox(mailbox) });
}

async function getAdminHooks(env: Env, url: URL): Promise<Response> {
  const mailboxId = url.searchParams.get("mailbox_id")?.trim() ?? "";
  if (!mailboxId) {
    return json(
      { ok: false, error: "invalid_request", hint: "Pass mailbox_id to read inbound hook config." },
      400,
    );
  }
  try {
    const mailbox = await getMailbox(env, mailboxId);
    if (!mailbox) {
      return notFoundJson();
    }
    const row = await getHookConfig(env, mailbox.id);
    return json({
      ok: true,
      mailbox: publicMailbox(mailbox),
      hook: row
        ? publicHookConfig(row)
        : publicHookConfig({
            mailbox_id: mailbox.id,
            webhook_enabled: 0,
            webhook_url: null,
            webhook_secret: null,
            forward_enabled: 0,
            forward_url: null,
            forward_email: null,
            updated_at: 0,
          }),
    });
  } catch (error) {
    return migrateHint(error);
  }
}

async function saveAdminHooks(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "mailbox_id", "webhook_url" } (optional secret, forward_url, forward_email).',
      },
      400,
    );
  }
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_request",
        hint: 'Send JSON { "mailbox_id", "webhook_url" }.',
      },
      400,
    );
  }
  const record = body as Record<string, unknown>;
  const mailboxId = typeof record.mailbox_id === "string" ? record.mailbox_id.trim() : "";
  if (!mailboxId) {
    return json({ ok: false, error: "invalid_request", hint: "mailbox_id is required." }, 400);
  }
  try {
    const mailbox = await getMailbox(env, mailboxId);
    if (!mailbox) {
      return notFoundJson();
    }
    const input = parseHookConfigBody(body);
    const saved = await saveHookConfig(env, mailbox.id, input);
    return json({
      ok: true,
      mailbox: publicMailbox(mailbox),
      hook: publicHookConfig(saved.row, saved.secretOnce ?? undefined),
    });
  } catch (error) {
    if (error instanceof HookInputError) {
      return json({ ok: false, error: error.error, hint: error.message }, 400);
    }
    return migrateHint(error);
  }
}

async function listAdminDeliveries(env: Env, url: URL): Promise<Response> {
  const mailboxId = url.searchParams.get("mailbox_id")?.trim() || undefined;
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  try {
    const deliveries = await listDeliveries(env, mailboxId, limit);
    return json({
      ok: true,
      deliveries: deliveries.map(publicDelivery),
    });
  } catch (error) {
    return migrateHint(error);
  }
}

async function listAdminMessages(env: Env, url: URL): Promise<Response> {
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
  try {
    const rows = await env.DB.prepare(
      `SELECT id, mailbox_id, envelope_from, envelope_to, subject, snippet, folder,
              size_bytes, received_at
       FROM messages
       ORDER BY received_at DESC, created_at DESC
       LIMIT ?1`,
    )
      .bind(limit)
      .all<MessageRecord>();
    return json({
      ok: true,
      audit: true,
      messages: (rows.results ?? []).map((row) => ({
        id: row.id,
        mailbox_id: row.mailbox_id,
        from: row.envelope_from,
        to: row.envelope_to,
        subject: row.subject,
        snippet: row.snippet,
        folder: row.folder,
        size_bytes: row.size_bytes,
        received_at: row.received_at,
      })),
    });
  } catch (error) {
    return migrateHint(error);
  }
}

async function renderAdminHome(
  request: Request,
  env: Env,
  panel: "overview" | "desk",
): Promise<Response> {
  const shell = await resolveShell(request, env);
  const gate = await requireAdmin(request, env);
  if (!gate.ok) {
    return adminGatePage(shell, gate.response);
  }

  try {
    const stats = await loadGroveStats(env);
    if (panel === "overview") {
      return html(renderAdminOverview(shell, stats));
    }
    const users = await listUsers(env);
    const boxes = await listMailboxes(env);
    const usageById = new Map<string, UserUsageSnapshot>();
    for (const user of users) {
      usageById.set(user.id, await userUsage(env, user.id));
    }
    const mailRows = await env.DB.prepare(
      `SELECT id, mailbox_id, envelope_from, envelope_to, subject, snippet, folder,
              size_bytes, received_at
       FROM messages
       ORDER BY received_at DESC, created_at DESC
       LIMIT 20`,
    ).all<MessageRecord>();
    let deliveries: InboundDeliveryRecord[] = [];
    try {
      deliveries = await listDeliveries(env, undefined, 20);
    } catch {
      deliveries = [];
    }
    return html(
      renderAdminDashboard(shell, stats, users, boxes, usageById, mailRows.results ?? [], deliveries),
    );
  } catch (error) {
    return migrateHint(error);
  }
}

async function renderAdminSite(request: Request, env: Env, notice?: string, danger = false): Promise<Response> {
  const shell = await resolveShell(request, env);
  const gate = await requireAdmin(request, env);
  if (!gate.ok) {
    return adminGatePage(shell, gate.response);
  }
  return html(renderAdminSitePage(shell, notice, danger));
}

async function saveAdminSiteForm(request: Request, env: Env): Promise<Response> {
  const shell = await resolveShell(request, env);
  const gate = await requireAdmin(request, env);
  if (!gate.ok) {
    return adminGatePage(shell, gate.response);
  }
  const data = await request.formData();
  try {
    await saveBranding(env, {
      site_title: String(data.get("site_title") ?? ""),
      logo_url: String(data.get("logo_url") ?? ""),
      accent: String(data.get("accent") ?? ""),
    });
    return redirect("/admin/site?saved=1");
  } catch (error) {
    const hint = error instanceof BrandingInputError ? error.message : tr(shell, "banner.logo-fail");
    return renderAdminSite(request, env, hint, true);
  }
}

function adminGatePage(shell: Shell, response: Response): Response {
  const status = response.status;
  if (status === 403) {
    return html(renderAdminForbidden(shell), 403);
  }
  if (status === 503) {
    return response;
  }
  return html(renderAdminLogin(shell), 401);
}

function renderAdminLogin(shell: Shell): string {
  return `<!DOCTYPE html>
<html lang="${documentLang(shell)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle(shell, tr(shell, "heading.admin")))}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="mode-list">
  <main class="page">
    <div class="page-inner">
      ${brandLink(shell, "/")}
      <div class="page-head"><h1>${escapeHtml(tr(shell, "heading.admin"))}</h1></div>
      <div class="page-card">
        <p class="banner">${escapeHtml(tr(shell, "banner.admin-forbidden"))}</p>
        <form id="admin-login" class="login-form">
          <label>值守口令
            <input name="token" class="search" type="password" autocomplete="current-password" required>
          </label>
          <button class="btn btn-primary" type="submit">${escapeHtml(tr(shell, "brand.enter"))}</button>
          <p id="admin-login-error" class="banner danger" hidden></p>
        </form>
      </div>
    </div>
  </main>
  <script>
    (function () {
      var form = document.getElementById("admin-login");
      var err = document.getElementById("admin-login-error");
      if (!form || !err) return;
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var data = new FormData(form);
        err.hidden = true;
        fetch("/admin/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: data.get("token") })
        }).then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
          .then(function (result) {
            if (result.res.ok) {
              location.href = "/admin";
              return;
            }
            err.textContent = result.body.hint || result.body.error || "值守口令不对。";
            err.hidden = false;
          })
          .catch(function () {
            err.textContent = "没连上。检查网络后重试。";
            err.hidden = false;
          });
      });
    })();
  </script>
</body>
</html>`;
}

function renderAdminForbidden(shell: Shell): string {
  return `<!DOCTYPE html>
<html lang="${documentLang(shell)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle(shell, tr(shell, "heading.admin")))}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="mode-list">
  <main class="page">
    <div class="page-inner">
      ${brandLink(shell, "/")}
      <div class="page-card">
        <h1>${escapeHtml(tr(shell, "heading.admin"))}</h1>
        <p class="banner">${escapeHtml(tr(shell, "banner.admin-forbidden"))}</p>
        <p><a href="/">${escapeHtml(tr(shell, "nav.inbox"))}</a></p>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function renderAdminDashboard(
  shell: Shell,
  stats: GroveStats,
  users: UserRecord[],
  boxes: MailboxRecord[],
  usageById: Map<string, UserUsageSnapshot>,
  messages: MessageRecord[],
  deliveries: InboundDeliveryRecord[],
): string {
  const userRows = users.length
    ? users
        .map((user) => {
          const usage = usageById.get(user.id);
          const quotas = `${fmtQuota(usage?.addresses ?? 0, user.quota_addresses)} 址 · ${fmtBytesQuota(usage?.storage_bytes ?? 0, user.quota_storage_bytes)} · ${fmtQuota(usage?.send_today ?? 0, user.quota_send_daily)} 封/日`;
          const disableLabel = user.status === "active" ? "停用" : "启用";
          const nextStatus = user.status === "active" ? "disabled" : "active";
          return `<tr>
            <td><span class="name">${escapeHtml(user.display_name || user.login)}</span><div class="mono">${escapeHtml(user.login)}</div></td>
            <td>${escapeHtml(user.role === "admin" ? "值守" : "信箱")}</td>
            <td>${escapeHtml(user.status === "active" ? "在岗" : "停用")}</td>
            <td class="quota-cell">${escapeHtml(quotas)}</td>
            <td>
              <button class="btn" data-user-status="${escapeHtml(user.id)}" data-next="${nextStatus}" type="button">${disableLabel}</button>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5">${emptyLine(tr(shell, "empty.members"))}</td></tr>`;

  const boxRows = boxes.length
    ? boxes
        .map(
          (box) => `<tr>
            <td class="mono">${escapeHtml(box.address)}</td>
            <td>${escapeHtml(box.display_name || "—")}</td>
            <td>${escapeHtml(box.status === "active" ? "接收中" : "已停")}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="3">${emptyLine(tr(shell, "empty.boxes"))}</td></tr>`;

  const mailRows = messages.length
    ? messages
        .map((row) => {
          const subject = row.subject?.trim() ? row.subject : "（无主题）";
          return `<tr>
            <td>${escapeHtml(formatReceived(row.received_at))}</td>
            <td class="mono">${escapeHtml(row.envelope_from)}</td>
            <td class="mono">${escapeHtml(row.envelope_to)}</td>
            <td>${escapeHtml(subject)}</td>
            <td>${escapeHtml(row.folder)}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5">${emptyLine(tr(shell, "empty.mail"))}</td></tr>`;

  const deliveryRows = deliveries.length
    ? deliveries
        .map((row) => {
          const status = row.status === "sent" ? "已送达" : `失败 · ${row.error || "downstream_failed"}`;
          const note = row.hint || (row.http_status ? `HTTP ${row.http_status}` : "—");
          return `<tr>
            <td>${escapeHtml(formatReceived(row.created_at))}</td>
            <td>${escapeHtml(row.kind === "webhook" ? "webhook" : "转发")}</td>
            <td class="mono">${escapeHtml(row.target)}</td>
            <td>${escapeHtml(status)}</td>
            <td>${escapeHtml(note)}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5">${emptyLine(tr(shell, "empty.deliveries"))}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="${documentLang(shell)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle(shell, tr(shell, "heading.admin")))}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="mode-list">
  <div class="shell simple">
    <aside class="nav">
      ${brandLink(shell, "/")}
      ${adminSideNav(shell, "desk")}
    </aside>
    <main class="page">
      <div class="page-inner page-inner-wide">
        <div class="page-head">
          <h1>${escapeHtml(tr(shell, "heading.admin"))}</h1>
          <form id="admin-logout">
            <button class="btn" type="submit">${escapeHtml(tr(shell, "brand.leave"))}</button>
          </form>
        </div>
        ${adminSubnav(shell, "desk")}
        ${renderStatCards(shell, stats)}
        <p class="banner">小团队够用：成员、地址、配额、入站投递。邮件列表只读，不在这里改信。0 表示不限额。Webhook 失败会出现在下面，不会被吞掉。</p>

        <section class="grove-panel">
          <h2>成员</h2>
          <div class="table-wrap">
            <table class="grove-table">
              <thead><tr><th>登录</th><th>角色</th><th>状态</th><th>配额用量</th><th></th></tr></thead>
              <tbody>${userRows}</tbody>
            </table>
          </div>
          <form id="create-user" class="grove-form">
            <label>登录名 <input class="search" name="login" required placeholder="ada"></label>
            <label>显示名 <input class="search" name="display_name" placeholder="Ada"></label>
            <label>角色
              <select name="role">
                <option value="mailbox">信箱</option>
                <option value="admin">值守</option>
              </select>
            </label>
            <label>口令 <input class="search" name="token" type="password" placeholder="留空则当场生成"></label>
            <label>地址上限 <input class="search" name="quota_addresses" type="number" min="0" placeholder="3，0=不限"></label>
            <label>存储字节 <input class="search" name="quota_storage_bytes" type="number" min="0" placeholder="104857600"></label>
            <label>日发送 <input class="search" name="quota_send_daily" type="number" min="0" placeholder="50"></label>
            <label>首个地址 <input class="search" name="mailbox" placeholder="ada@example.test"></label>
            <button class="btn btn-primary" type="submit">加入成员</button>
          </form>
          <p id="create-user-msg" class="banner" hidden></p>
        </section>

        <section class="grove-panel">
          <h2>地址</h2>
          <div class="table-wrap">
            <table class="grove-table">
              <thead><tr><th>地址</th><th>名称</th><th>状态</th></tr></thead>
              <tbody>${boxRows}</tbody>
            </table>
          </div>
          <form id="create-box" class="grove-form">
            <label>地址 <input class="search" name="address" required placeholder="notes@example.test"></label>
            <label>名称 <input class="search" name="display_name" placeholder="可选"></label>
            <label>绑给成员 ID <input class="search" name="user_id" placeholder="可选 UUID"></label>
            <button class="btn btn-primary" type="submit">开一个地址</button>
          </form>
          <p id="create-box-msg" class="banner" hidden></p>
        </section>

        <section class="grove-panel">
          <h2>入站投递</h2>
          <p class="banner">签名算法：HMAC-SHA256，签名串 <span class="mono">\${timestamp}.\${raw_json_body}</span>，头 <span class="mono">X-Postgrove-Signature: v1=&lt;hex&gt;</span>。内网 / 元数据 URL 会被拒绝。</p>
          <div class="table-wrap">
            <table class="grove-table">
              <thead><tr><th>时间</th><th>种类</th><th>目标</th><th>状态</th><th>说明</th></tr></thead>
              <tbody>${deliveryRows}</tbody>
            </table>
          </div>
          <form id="save-hooks" class="grove-form">
            <label>地址 ID <input class="search" name="mailbox_id" required placeholder="UUID"></label>
            <label>Webhook URL <input class="search" name="webhook_url" placeholder="https://hooks.example.test/inbound"></label>
            <label>签名密钥 <input class="search" name="webhook_secret" type="password" placeholder="留空则生成"></label>
            <label>Webhook
              <select name="webhook_enabled">
                <option value="1">开启</option>
                <option value="0">关闭</option>
              </select>
            </label>
            <label>转发 URL <input class="search" name="forward_url" placeholder="https://chat.example.test/hook"></label>
            <label>转发邮箱 <input class="search" name="forward_email" placeholder="neighbor@example.test"></label>
            <label>转发
              <select name="forward_enabled">
                <option value="0">关闭</option>
                <option value="1">开启</option>
              </select>
            </label>
            <button class="btn btn-primary" type="submit">保存入站通知</button>
          </form>
          <p id="save-hooks-msg" class="banner" hidden></p>
        </section>

        <section class="grove-panel">
          <h2>近期信件（只读）</h2>
          <div class="table-wrap">
            <table class="grove-table">
              <thead><tr><th>时间</th><th>发件人</th><th>收件人</th><th>主题</th><th>文件夹</th></tr></thead>
              <tbody>${mailRows}</tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  </div>
  <script>
    (function () {
      function show(id, text, danger) {
        var el = document.getElementById(id);
        if (!el) return;
        el.hidden = !text;
        el.textContent = text || "";
        el.className = danger ? "banner danger" : "banner success";
      }
      function readForm(form) {
        var data = new FormData(form);
        var out = {};
        data.forEach(function (value, key) {
          var text = String(value || "").trim();
          if (text) out[key] = text;
        });
        ["quota_addresses", "quota_storage_bytes", "quota_send_daily"].forEach(function (key) {
          if (out[key] !== undefined) out[key] = Number(out[key]);
        });
        return out;
      }
      var userForm = document.getElementById("create-user");
      if (userForm) {
        userForm.addEventListener("submit", function (event) {
          event.preventDefault();
          fetch("/admin/users", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(readForm(userForm))
          }).then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
            .then(function (result) {
              if (!result.res.ok) {
                show("create-user-msg", result.body.hint || result.body.error, true);
                return;
              }
              var token = result.body.token ? " 口令（只显示一次）：" + result.body.token : "";
              show("create-user-msg", "成员已加入。" + token, false);
              setTimeout(function () { location.reload(); }, 1200);
            })
            .catch(function () { show("create-user-msg", "请求失败。", true); });
        });
      }
      var boxForm = document.getElementById("create-box");
      if (boxForm) {
        boxForm.addEventListener("submit", function (event) {
          event.preventDefault();
          fetch("/admin/mailboxes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(readForm(boxForm))
          }).then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
            .then(function (result) {
              if (!result.res.ok) {
                show("create-box-msg", result.body.hint || result.body.error, true);
                return;
              }
              show("create-box-msg", "地址已开好。", false);
              setTimeout(function () { location.reload(); }, 800);
            })
            .catch(function () { show("create-box-msg", "请求失败。", true); });
        });
      }
      var hookForm = document.getElementById("save-hooks");
      if (hookForm) {
        hookForm.addEventListener("submit", function (event) {
          event.preventDefault();
          var payload = readForm(hookForm);
          if (payload.webhook_enabled !== undefined) payload.webhook_enabled = payload.webhook_enabled === "1" || payload.webhook_enabled === 1;
          if (payload.forward_enabled !== undefined) payload.forward_enabled = payload.forward_enabled === "1" || payload.forward_enabled === 1;
          fetch("/admin/hooks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          }).then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
            .then(function (result) {
              if (!result.res.ok) {
                show("save-hooks-msg", result.body.hint || result.body.error, true);
                return;
              }
              var secret = result.body.hook && result.body.hook.webhook_secret
                ? " 签名密钥（只显示一次）：" + result.body.hook.webhook_secret
                : "";
              show("save-hooks-msg", "入站通知已保存。" + secret, false);
              setTimeout(function () { location.reload(); }, 1200);
            })
            .catch(function () { show("save-hooks-msg", "请求失败。", true); });
        });
      }
      document.querySelectorAll("[data-user-status]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          fetch("/admin/users/" + btn.getAttribute("data-user-status"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: btn.getAttribute("data-next") })
          }).then(function () { location.reload(); });
        });
      });
      var logout = document.getElementById("admin-logout");
      if (logout) {
        logout.addEventListener("submit", function (event) {
          event.preventDefault();
          fetch("/admin/logout", { method: "POST" }).finally(function () {
            location.href = "/admin";
          });
        });
      }
    })();
  </script>
</body>
</html>`;
}

function renderAdminOverview(shell: Shell, stats: GroveStats): string {
  return `<!DOCTYPE html>
<html lang="${documentLang(shell)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle(shell, tr(shell, "heading.overview")))}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="mode-list">
  <div class="shell simple">
    <aside class="nav">
      ${brandLink(shell, "/")}
      ${adminSideNav(shell, "overview")}
    </aside>
    <main class="page">
      <div class="page-inner page-inner-wide">
        <div class="page-head">
          <h1>${escapeHtml(tr(shell, "heading.overview"))}</h1>
          <form id="admin-logout">
            <button class="btn" type="submit">${escapeHtml(tr(shell, "brand.leave"))}</button>
          </form>
        </div>
        ${adminSubnav(shell, "overview")}
        ${renderStatCards(shell, stats)}
      </div>
    </main>
  </div>
  ${adminLogoutScript()}
</body>
</html>`;
}

function renderAdminSitePage(shell: Shell, notice?: string, danger = false): string {
  const banner = notice
    ? `<p class="banner ${danger ? "danger" : "success"}">${escapeHtml(notice)}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="${documentLang(shell)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle(shell, tr(shell, "heading.site")))}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="mode-list">
  <div class="shell simple">
    <aside class="nav">
      ${brandLink(shell, "/")}
      ${adminSideNav(shell, "site")}
    </aside>
    <main class="page">
      <div class="page-inner">
        <div class="page-head">
          <h1>${escapeHtml(tr(shell, "heading.site"))}</h1>
          <form id="admin-logout">
            <button class="btn" type="submit">${escapeHtml(tr(shell, "brand.leave"))}</button>
          </form>
        </div>
        ${adminSubnav(shell, "site")}
        <div class="page-card">
          ${banner}
          <form class="grove-form grove-form-stack" method="post" action="/admin/site">
            <label>${escapeHtml(tr(shell, "label.site-title"))}
              <input class="search" name="site_title" maxlength="80" value="${escapeHtml(shell.brand.site_title)}">
            </label>
            <label>${escapeHtml(tr(shell, "label.logo-url"))}
              <input class="search" name="logo_url" type="url" placeholder="https://example.test/logo.svg" value="${escapeHtml(shell.brand.logo_url ?? "")}">
            </label>
            <label>${escapeHtml(tr(shell, "label.accent"))}
              <input class="search" name="accent" value="${escapeHtml(shell.brand.accent)}" placeholder="#1B4332">
            </label>
            <button class="btn btn-primary" type="submit">${escapeHtml(tr(shell, "label.save-brand"))}</button>
          </form>
        </div>
      </div>
    </main>
  </div>
  ${adminLogoutScript()}
</body>
</html>`;
}

function renderStatCards(shell: Shell, stats: GroveStats): string {
  const empty = stats.empty
    ? `<div class="empty">${EMPTY_ART}<p>${escapeHtml(tr(shell, "empty.analytics"))}</p></div>`
    : "";
  return `<section class="grove-panel">
    <h2>${escapeHtml(tr(shell, "heading.overview"))}</h2>
    ${empty}
    <div class="stat-grid">
      <article class="stat-card">
        <span class="label">${escapeHtml(tr(shell, "stat.users"))}</span>
        <div class="value">${stats.users}</div>
      </article>
      <article class="stat-card">
        <span class="label">${escapeHtml(tr(shell, "stat.messages-today"))}</span>
        <div class="value">${stats.messages_today}</div>
      </article>
      <article class="stat-card">
        <span class="label">${escapeHtml(tr(shell, "stat.storage"))}</span>
        <div class="value">${stats.storage_mb} MB</div>
      </article>
    </div>
  </section>`;
}

function adminSideNav(shell: Shell, active: "overview" | "desk" | "site"): string {
  return `<ul class="nav-list">
        <li><a href="/">${escapeHtml(tr(shell, "nav.inbox"))}</a></li>
        <li><a class="active" href="/admin">${escapeHtml(tr(shell, "nav.admin"))}</a></li>
      </ul>
      <ul class="nav-list nav-tools">
        <li><a class="${active === "overview" ? "active" : ""}" href="/admin/overview">${escapeHtml(tr(shell, "nav.overview"))}</a></li>
        <li><a class="${active === "desk" ? "active" : ""}" href="/admin">${escapeHtml(tr(shell, "nav.members"))}</a></li>
        <li><a class="${active === "site" ? "active" : ""}" href="/admin/site">${escapeHtml(tr(shell, "nav.site"))}</a></li>
      </ul>`;
}

function adminSubnav(shell: Shell, active: "overview" | "desk" | "site"): string {
  return `<nav class="admin-subnav" aria-label="${escapeHtml(tr(shell, "heading.admin"))}">
    <a class="filter${active === "overview" ? " active" : ""}" href="/admin/overview">${escapeHtml(tr(shell, "nav.overview"))}</a>
    <a class="filter${active === "desk" ? " active" : ""}" href="/admin">${escapeHtml(tr(shell, "nav.members"))}</a>
    <a class="filter${active === "site" ? " active" : ""}" href="/admin/site">${escapeHtml(tr(shell, "nav.site"))}</a>
  </nav>`;
}

function adminLogoutScript(): string {
  return `<script>
    (function () {
      var logout = document.getElementById("admin-logout");
      if (!logout) return;
      logout.addEventListener("submit", function (event) {
        event.preventDefault();
        fetch("/admin/logout", { method: "POST" }).finally(function () {
          location.href = "/admin";
        });
      });
    })();
  </script>`;
}

function publicMailbox(row: MailboxRecord) {
  return {
    id: row.id,
    address: row.address,
    display_name: row.display_name,
    status: row.status,
  };
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function migrateHint(error: unknown): Response {
  const detail = error instanceof Error ? error.message : "unknown";
  return json(
    {
      ok: false,
      error: "migrations_pending",
      hint: "Apply D1 migrations (npm run db:migrate:local), then retry.",
      detail,
    },
    503,
  );
}

function emptyLine(copy: string): string {
  return `${EMPTY_ART}<p>${escapeHtml(copy)}</p>`;
}

function fmtQuota(used: number, limit: number): string {
  return limit === 0 ? `${used}/∞` : `${used}/${limit}`;
}

function fmtBytesQuota(used: number, limit: number): string {
  const round = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${n} B`);
  return limit === 0 ? `${round(used)}/∞` : `${round(used)}/${round(limit)}`;
}
