/**
 * OTP / link extract helpers for developer inboxes.
 * Rules are documented in the README (Dev inbox API). Fail loud — never guess.
 */

export type ExtractKind = "otp" | "link";

export type ExtractOk = {
  ok: true;
  kind: ExtractKind;
  value: string;
  rule: string;
};

export type ExtractFail = {
  ok: false;
  error: "extract_failed" | "extract_ambiguous" | "invalid_pattern" | "invalid_kind";
  hint: string;
};

export type ExtractResult = ExtractOk | ExtractFail;

const KIND_HINT = 'kind 必须是 otp 或 link。';

const LABELED_OTP =
  /(?:验证码|校验码|確認碼|确认码|one[-\s]?time(?:\s+(?:pass(?:word|code)?|code))?|passcode|otp|pin(?:\s*code)?|(?:security|login|verification|confirm(?:ation)?)\s+code|\bcode)\s*(?:is|为|：|:|#)?\s*([A-Za-z0-9]{4,8})\b/gi;

const STANDALONE_DIGITS = /(?<![\dA-Za-z])(\d{4,8})(?![\dA-Za-z])/g;

const HTTPS_URL = /https:\/\/[^\s<>"'）)\]】]+/gi;

const LABELED_LINK =
  /(?:verify|confirm|activate|reset|unsubscribe|点击|验证|确认|激活|重置)[^\n]{0,80}(https:\/\/[^\s<>"'）)\]】]+)/i;

const PATTERN_MAX = 200;

export function extractFromText(
  text: string,
  kind: string,
  options: { pattern?: string | null; host?: string | null } = {},
): ExtractResult {
  const hay = text ?? "";
  if (kind !== "otp" && kind !== "link") {
    return { ok: false, error: "invalid_kind", hint: KIND_HINT };
  }

  if (options.pattern) {
    return extractWithPattern(hay, kind, options.pattern);
  }

  if (kind === "otp") {
    return extractOtp(hay);
  }
  return extractLink(hay, options.host ?? null);
}

function extractWithPattern(text: string, kind: ExtractKind, raw: string): ExtractResult {
  const pattern = raw.trim();
  if (!pattern || pattern.length > PATTERN_MAX) {
    return {
      ok: false,
      error: "invalid_pattern",
      hint: `自定义 pattern 无效或过长（最多 ${PATTERN_MAX} 字符）。`,
    };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return {
      ok: false,
      error: "invalid_pattern",
      hint: "自定义 pattern 不是合法正则，无法抽出。",
    };
  }
  const match = re.exec(text);
  if (!match) {
    return {
      ok: false,
      error: "extract_failed",
      hint: kind === "otp" ? otpNoneHint() : linkNoneHint(),
    };
  }
  const value = (match[1] ?? match[0]).trim();
  if (!value) {
    return {
      ok: false,
      error: "extract_failed",
      hint: kind === "otp" ? otpNoneHint() : linkNoneHint(),
    };
  }
  return { ok: true, kind, value, rule: "custom_pattern" };
}

function extractOtp(text: string): ExtractResult {
  const labeled = uniqueCaptures(text, LABELED_OTP);
  if (labeled.length === 1) {
    return { ok: true, kind: "otp", value: labeled[0], rule: "labeled_otp" };
  }
  if (labeled.length > 1) {
    return {
      ok: false,
      error: "extract_ambiguous",
      hint: `抽出验证码失败：正文里有多个不同的标注码（${labeled.join("、")}）。请改用 pattern 或写清要哪一个。`,
    };
  }

  const digits = uniqueCaptures(text, STANDALONE_DIGITS).filter((value) => !isYearLike(value));
  if (digits.length === 1) {
    return { ok: true, kind: "otp", value: digits[0], rule: "standalone_digits" };
  }
  if (digits.length > 1) {
    return {
      ok: false,
      error: "extract_ambiguous",
      hint: `抽出验证码失败：正文里有多个未标注数字（${digits.join("、")}）。请改用带「验证码/code」标注的信，或传 pattern。`,
    };
  }
  return { ok: false, error: "extract_failed", hint: otpNoneHint() };
}

function extractLink(text: string, host: string | null): ExtractResult {
  const labeled = firstHttps(text, LABELED_LINK);
  const all = uniqueHttps(text);
  const filtered = host
    ? all.filter((url) => urlHost(url) === host.trim().toLowerCase())
    : all;

  if (labeled && (!host || urlHost(labeled) === host.trim().toLowerCase())) {
    return { ok: true, kind: "link", value: labeled, rule: "labeled_https" };
  }
  if (filtered.length === 1) {
    return { ok: true, kind: "link", value: filtered[0], rule: host ? "https_host" : "first_https" };
  }
  if (filtered.length > 1 && !host) {
    return { ok: true, kind: "link", value: filtered[0], rule: "first_https" };
  }
  if (host && filtered.length > 1) {
    return {
      ok: false,
      error: "extract_ambiguous",
      hint: `抽出链接失败：该 host 下有多条 https 链接。请收窄 host 或传 pattern。`,
    };
  }
  if (all.length === 0 && /https?:\/\//i.test(text)) {
    return {
      ok: false,
      error: "extract_failed",
      hint: "未能抽出链接：只接受 https:// 地址。",
    };
  }
  return { ok: false, error: "extract_failed", hint: linkNoneHint(host) };
}

function uniqueCaptures(text: string, re: RegExp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = copy.exec(text))) {
    const value = (match[1] ?? match[0]).trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function uniqueHttps(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const copy = new RegExp(HTTPS_URL.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = copy.exec(text))) {
    const value = stripTrailingPunct(match[0]);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function firstHttps(text: string, re: RegExp): string | null {
  const match = new RegExp(re.source, re.flags).exec(text);
  if (!match) {
    return null;
  }
  return stripTrailingPunct(match[1] ?? match[0]);
}

function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?]+$/u, "");
}

function urlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isYearLike(value: string): boolean {
  return value.length === 4 && /^(?:19|20)\d{2}$/.test(value);
}

function otpNoneHint(): string {
  return "未能抽出验证码：正文里没有 4–8 位标注码（验证码/code/OTP），也没有单独的 4–8 位数字。";
}

function linkNoneHint(host?: string | null): string {
  if (host) {
    return `未能抽出链接：正文里没有 host 为 ${host} 的 https:// 地址。`;
  }
  return "未能抽出链接：正文里没有 https:// 地址。";
}

export function combineMessageText(parts: {
  subject?: string | null;
  snippet?: string | null;
  body_text?: string | null;
}): string {
  return [parts.subject, parts.snippet, parts.body_text].filter(Boolean).join("\n");
}
