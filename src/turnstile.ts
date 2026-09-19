/**
 * Cloudflare Turnstile siteverify.
 *
 * Pattern studied from maillab/cloud-mail (MIT) turnstile-service:
 * POST application/x-www-form-urlencoded to
 * https://challenges.cloudflare.com/turnstile/v0/siteverify
 * with secret + response + optional remoteip.
 * Rewritten here — not pasted.
 */

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileVerifyResult =
  | { ok: true }
  | { ok: false; error: string; hint: string };

export interface TurnstileVerifyInput {
  secret: string;
  response: string;
  remoteip?: string;
  fetchImpl?: typeof fetch;
}

export function turnstileConfigured(secret: string | undefined): boolean {
  return Boolean(secret?.trim());
}

export async function verifyTurnstile(input: TurnstileVerifyInput): Promise<TurnstileVerifyResult> {
  const secret = input.secret.trim();
  const response = input.response.trim();
  if (!secret) {
    return {
      ok: false,
      error: "turnstile_not_configured",
      hint: "Set TURNSTILE_SECRET_KEY to enable public signup. See .dev.vars.example.",
    };
  }
  if (!response) {
    return {
      ok: false,
      error: "turnstile_failed",
      hint: "Missing Turnstile token. Send JSON { \"address\", \"turnstile_token\" } from a widget that uses TURNSTILE_SITE_KEY.",
    };
  }

  const body = new URLSearchParams({
    secret,
    response,
  });
  if (input.remoteip) {
    body.set("remoteip", input.remoteip);
  }

  const fetchImpl = input.fetchImpl ?? turnstileFetchImpl;
  let http: Response;
  try {
    http = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    return {
      ok: false,
      error: "turnstile_unavailable",
      hint: `Could not reach Cloudflare Turnstile siteverify. Check Worker egress and retry. (${detail})`,
    };
  }

  let parsed: unknown;
  try {
    parsed = await http.json();
  } catch {
    return {
      ok: false,
      error: "turnstile_failed",
      hint: "Turnstile siteverify returned a non-JSON body. Retry, or check TURNSTILE_SECRET_KEY.",
    };
  }

  if (!http.ok || !isSuccess(parsed)) {
    return {
      ok: false,
      error: "turnstile_failed",
      hint: "Turnstile challenge failed. Complete the widget again, or check TURNSTILE_SECRET_KEY / site key pair.",
    };
  }
  return { ok: true };
}

function isSuccess(parsed: unknown): boolean {
  return Boolean(parsed && typeof parsed === "object" && (parsed as { success?: unknown }).success === true);
}

let turnstileFetchImpl: typeof fetch = fetch;

/** Test helper: mock siteverify (no live Cloudflare in CI). */
export function setTurnstileFetchForTests(fn: typeof fetch): void {
  turnstileFetchImpl = fn;
}

export function resetTurnstileFetchForTests(): void {
  turnstileFetchImpl = fetch;
}
