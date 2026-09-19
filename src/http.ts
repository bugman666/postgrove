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
  return json({ ok: false, error: "not_found" }, 404);
}

export function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "method_not_allowed" }, 405, { allow });
}
