export function json(
  body: Record<string, unknown>,
  status = 200,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export function css(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}

export function redirect(location: string, status = 303): Response {
  return new Response(null, {
    status,
    headers: { location, "cache-control": "no-store" },
  });
}

export function notFoundJson(): Response {
  return json({ ok: false, error: "not_found", hint: "Unknown mailbox or message." }, 404);
}

export function forbiddenJson(hint?: string): Response {
  return json(
    {
      ok: false,
      error: "forbidden",
      hint:
        hint ??
        "This session is bound to another mailbox. POST /auth/login with that address.",
    },
    403,
  );
}

export function unauthorizedJson(hint = "Send Authorization: Bearer <API token> (pg_…)."): Response {
  return json({ ok: false, error: "unauthorized", hint }, 401);
}

export function payloadTooLargeJson(maxBytes: number): Response {
  return json(
    {
      ok: false,
      error: "payload_too_large",
      hint: `JSON body is too large (limit ${maxBytes} bytes). Shrink the payload and retry. See README rate / size limits.`,
      max_bytes: maxBytes,
    },
    413,
  );
}

export function quotaJson(
  error: "quota_addresses" | "quota_storage" | "quota_send",
  hint: string,
  extra?: Record<string, unknown>,
): Response {
  const status = error === "quota_send" ? 429 : 409;
  return json({ ok: false, error, hint, ...extra }, status);
}

export function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "method_not_allowed" }, 405, { allow });
}
