import type { Env } from "./env";

export const OUTBOUND_PROVIDERS = ["stub", "resend", "http"] as const;
export type OutboundProviderName = (typeof OUTBOUND_PROVIDERS)[number];

export interface OutboundDraft {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface OutboundAdapterResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  hint?: string;
  detail?: string;
}

export interface OutboundAdapter {
  readonly name: OutboundProviderName;
  send(draft: OutboundDraft): Promise<OutboundAdapterResult>;
}

export type AdapterResolve =
  | { ok: true; adapter: OutboundAdapter }
  | { ok: false; error: string; hint: string };

export interface SendInput {
  to: string;
  subject: string;
  text: string;
}

export type ParseSendResult =
  | { ok: true; input: SendInput }
  | { ok: false; error: string; hint: string };

const SUBJECT_MAX = 998;
const BODY_MAX = 256_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseSendFields(raw: {
  to?: unknown;
  subject?: unknown;
  text?: unknown;
  body?: unknown;
}): ParseSendResult {
  if (typeof raw.to !== "string") {
    return {
      ok: false,
      error: "invalid_request",
      hint: "Send { \"to\", \"subject\", \"text\" } (subject and text may be empty).",
    };
  }
  const to = raw.to.trim().toLowerCase();
  if (!to || !EMAIL_RE.test(to)) {
    return {
      ok: false,
      error: "invalid_request",
      hint: "to must be a single email address, for example neighbor@example.test.",
    };
  }

  const subjectRaw = typeof raw.subject === "string" ? raw.subject : "";
  const textRaw =
    typeof raw.text === "string"
      ? raw.text
      : typeof raw.body === "string"
        ? raw.body
        : "";

  if (subjectRaw.length > SUBJECT_MAX) {
    return {
      ok: false,
      error: "invalid_request",
      hint: `subject is too long (max ${SUBJECT_MAX} characters).`,
    };
  }
  if (textRaw.length > BODY_MAX) {
    return {
      ok: false,
      error: "invalid_request",
      hint: `text is too long (max ${BODY_MAX} characters).`,
    };
  }

  return {
    ok: true,
    input: { to, subject: subjectRaw.trim(), text: textRaw },
  };
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Pick the outbound adapter from env. Unset / incomplete real providers
 * fail closed with a next-step hint — never a silent drop.
 */
export function resolveOutboundAdapter(env: Env): AdapterResolve {
  const name = (env.OUTBOUND_PROVIDER ?? "").trim().toLowerCase();
  if (!name) {
    return {
      ok: false,
      error: "outbound_not_configured",
      hint: "Set OUTBOUND_PROVIDER to stub (local/dev, records without sending), resend (needs RESEND_API_KEY), or http (needs OUTBOUND_HTTP_URL). See .dev.vars.example.",
    };
  }
  if (name === "stub") {
    return { ok: true, adapter: new StubAdapter() };
  }
  if (name === "resend") {
    const apiKey = env.RESEND_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return {
        ok: false,
        error: "outbound_not_configured",
        hint: "OUTBOUND_PROVIDER=resend needs RESEND_API_KEY (wrangler secret put RESEND_API_KEY, or .dev.vars locally). Verify the From domain in Resend.",
      };
    }
    return { ok: true, adapter: new ResendAdapter(apiKey) };
  }
  if (name === "http") {
    const url = env.OUTBOUND_HTTP_URL?.trim() ?? "";
    if (!url) {
      return {
        ok: false,
        error: "outbound_not_configured",
        hint: "OUTBOUND_PROVIDER=http needs OUTBOUND_HTTP_URL (POST JSON {from,to,subject,text}). Optional OUTBOUND_HTTP_TOKEN is sent as Bearer.",
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        ok: false,
        error: "outbound_not_configured",
        hint: "OUTBOUND_HTTP_URL must be an absolute http(s) URL.",
      };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        ok: false,
        error: "outbound_not_configured",
        hint: "OUTBOUND_HTTP_URL must start with https:// (or http:// for local hooks).",
      };
    }
    return {
      ok: true,
      adapter: new HttpAdapter(url, env.OUTBOUND_HTTP_TOKEN?.trim() || null),
    };
  }
  return {
    ok: false,
    error: "unknown_provider",
    hint: `Unknown OUTBOUND_PROVIDER="${name}". Use stub, resend, or http.`,
  };
}

export function outboundFromAddress(env: Env, mailboxAddress: string): string {
  const override = env.OUTBOUND_FROM?.trim() || env.RESEND_FROM?.trim();
  return override || mailboxAddress;
}

export function describeOutbound(env: Env): { provider: string; hint: string } {
  const resolved = resolveOutboundAdapter(env);
  if (!resolved.ok) {
    return { provider: (env.OUTBOUND_PROVIDER ?? "").trim() || "unset", hint: resolved.hint };
  }
  if (resolved.adapter.name === "stub") {
    return {
      provider: "stub",
      hint: "出站：stub。发送会记入出站记录，不会真正寄出。",
    };
  }
  if (resolved.adapter.name === "resend") {
    return {
      provider: "resend",
      hint: "出站：Resend。From 域名需要在 Resend 完成验证。",
    };
  }
  return {
    provider: "http",
    hint: "出站：HTTP 钩子。Worker 会 POST JSON 到 OUTBOUND_HTTP_URL。",
  };
}

export class StubAdapter implements OutboundAdapter {
  readonly name = "stub" as const;

  async send(_draft: OutboundDraft): Promise<OutboundAdapterResult> {
    return { ok: true, providerMessageId: `stub-${crypto.randomUUID()}` };
  }
}

export class ResendAdapter implements OutboundAdapter {
  readonly name = "resend" as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async send(draft: OutboundDraft): Promise<OutboundAdapterResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: draft.from,
          to: [draft.to],
          subject: draft.subject || "(no subject)",
          text: draft.text || " ",
        }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      return {
        ok: false,
        error: "outbound_failed",
        hint: "Could not reach Resend. Check network egress and retry.",
        detail,
      };
    }
    return parseProviderResponse(response, "Resend", "Check RESEND_API_KEY and that the From domain is verified in Resend.");
  }
}

export class HttpAdapter implements OutboundAdapter {
  readonly name = "http" as const;
  private readonly url: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(url: string, token: string | null, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async send(draft: OutboundDraft): Promise<OutboundAdapterResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: draft.from,
          to: draft.to,
          subject: draft.subject,
          text: draft.text,
        }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      return {
        ok: false,
        error: "outbound_failed",
        hint: "Could not reach OUTBOUND_HTTP_URL. Check the URL and retry.",
        detail,
      };
    }
    return parseProviderResponse(
      response,
      "HTTP outbound hook",
      "Check OUTBOUND_HTTP_URL (and OUTBOUND_HTTP_TOKEN if the hook requires Bearer).",
    );
  }
}

async function parseProviderResponse(
  response: Response,
  label: string,
  configHint: string,
): Promise<OutboundAdapterResult> {
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
  }

  if (response.ok) {
    return { ok: true, providerMessageId: extractProviderId(parsed) };
  }

  const providerMessage = extractProviderMessage(parsed) ?? raw.slice(0, 240) ?? "";
  const unauthorized = response.status === 401 || response.status === 403;
  return {
    ok: false,
    error: unauthorized ? "outbound_auth_failed" : "outbound_failed",
    hint: unauthorized
      ? `${label} rejected the credentials. ${configHint}`
      : `${label} returned ${response.status}. ${configHint}`,
    detail: providerMessage || `HTTP ${response.status}`,
  };
}

function extractProviderId(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ["id", "message_id", "messageId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function extractProviderMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ["message", "error", "hint"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
