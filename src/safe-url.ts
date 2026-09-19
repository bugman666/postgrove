/**
 * Default-deny SSRF guard for operator-supplied outbound URLs.
 *
 * Policy matches open-site-health `internal/safeurl` (http(s) only; block
 * localhost / metadata hostnames and private / link-local / multicast /
 * CGNAT / metadata addresses). Rewritten for Workers — no custom dialer.
 *
 * Call at save time and again at fetch time. DNS rebinding and redirect
 * hops are the caller's job: Workers `fetch` cannot install a restricted
 * dialer. Re-validate each Location if you follow redirects yourself.
 * `redirect: "follow"` leaves residual risk after a public first hop.
 *
 * `ALLOW_PRIVATE_WEBHOOKS=1` is a documented caller convention for local
 * http hooks. This module only honors `opts.allowPrivate`; it does not
 * read the environment.
 */

export type ValidateSafeUrlOptions = {
  /** Accept private / loopback / link-local / metadata destinations. */
  allowPrivate?: boolean;
};

export type ValidateSafeUrlResult =
  | { ok: true; url: URL }
  | { ok: false; error: string; hint: string };

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
]);

export function validateSafeUrl(
  raw: string,
  opts?: ValidateSafeUrlOptions,
): ValidateSafeUrlResult {
  const allowPrivate = opts?.allowPrivate === true;
  if (typeof raw !== "string" || raw.trim() === "") {
    return invalidUrl("Provide an absolute http(s) URL.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalidUrl("Provide an absolute http(s) URL.");
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return blocked(`URL scheme must be http or https (got ${scheme || "none"}).`);
  }

  const host = normalizeHostname(url.hostname);
  if (host === "") {
    return blocked("URL is missing a host.");
  }

  if (!allowPrivate && isBlockedHostname(host)) {
    return blocked(`Host "${host}" is not allowed as an outbound target.`);
  }

  if (!allowPrivate && isBlockedIp(host)) {
    return blocked(`Address ${host} is not allowed as an outbound target.`);
  }

  return { ok: true, url };
}

/** Case-insensitive; also matches any `*.localhost` label. */
export function isBlockedHostname(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "") {
    return false;
  }
  if (BLOCKED_HOSTNAMES.has(normalized)) {
    return true;
  }
  return normalized.endsWith(".localhost");
}

/** True when `ip` is a textual IPv4/IPv6 address in a blocked range. */
export function isBlockedIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) {
    return false;
  }
  if (parsed.version === 4) {
    return isBlockedIpv4(parsed.octets);
  }
  if (isIpv4Mapped(parsed.hextets)) {
    return isBlockedIpv4(ipv4MappedOctets(parsed.hextets));
  }
  return isBlockedIpv6(parsed.hextets);
}

function invalidUrl(hint: string): ValidateSafeUrlResult {
  return { ok: false, error: "invalid_url", hint };
}

function blocked(hint: string): ValidateSafeUrlResult {
  return { ok: false, error: "blocked_destination", hint };
}

function normalizeHostname(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  while (value.endsWith(".")) {
    value = value.slice(0, -1);
  }
  return value;
}

type ParsedIp =
  | { version: 4; octets: number[] }
  | { version: 6; hextets: number[] };

function parseIp(text: string): ParsedIp | null {
  const raw = normalizeHostname(text);
  if (raw === "") {
    return null;
  }
  if (raw.includes(":")) {
    const hextets = parseIpv6(raw);
    return hextets ? { version: 6, hextets } : null;
  }
  const octets = parseIpv4(raw);
  return octets ? { version: 4, octets } : null;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    octets.push(n);
  }
  return octets;
}

function parseIpv6(text: string): number[] | null {
  let value = text;
  const zone = value.indexOf("%");
  if (zone !== -1) {
    value = value.slice(0, zone);
  }
  if (value === "" || value.includes(":::")) {
    return null;
  }

  const sides = value.split("::");
  if (sides.length > 2) {
    return null;
  }

  const left = parseIpv6Groups(sides[0] ?? "", false);
  const right = parseIpv6Groups(sides[1] ?? "", true);
  if (!left || !right) {
    return null;
  }

  if (sides.length === 1) {
    return left.length === 8 ? left : null;
  }

  const fill = 8 - left.length - right.length;
  if (fill < 1) {
    return null;
  }
  return [...left, ...Array<number>(fill).fill(0), ...right];
}

function parseIpv6Groups(part: string, allowIpv4Tail: boolean): number[] | null {
  if (part === "") {
    return [];
  }
  const tokens = part.split(":");
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "") {
      return null;
    }
    if (allowIpv4Tail && i === tokens.length - 1 && token.includes(".")) {
      const v4 = parseIpv4(token);
      if (!v4) {
        return null;
      }
      out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(token)) {
      return null;
    }
    out.push(Number.parseInt(token, 16));
  }
  return out;
}

function isIpv4Mapped(hextets: number[]): boolean {
  return (
    hextets.length === 8 &&
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  );
}

function ipv4MappedOctets(hextets: number[]): number[] {
  return [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff];
}

function isBlockedIpv4(octets: number[]): boolean {
  const ip = ipv4ToInt(octets);
  // loopback 127.0.0.0/8
  if (inCidrV4(ip, ipv4ToInt([127, 0, 0, 0]), 8)) {
    return true;
  }
  // RFC1918
  if (
    inCidrV4(ip, ipv4ToInt([10, 0, 0, 0]), 8) ||
    inCidrV4(ip, ipv4ToInt([172, 16, 0, 0]), 12) ||
    inCidrV4(ip, ipv4ToInt([192, 168, 0, 0]), 16)
  ) {
    return true;
  }
  // unspecified 0.0.0.0
  if (ip === 0) {
    return true;
  }
  // link-local unicast 169.254.0.0/16 (covers 169.254.169.254)
  if (inCidrV4(ip, ipv4ToInt([169, 254, 0, 0]), 16)) {
    return true;
  }
  // multicast 224.0.0.0/4 (includes link-local multicast 224.0.0.0/24)
  if (inCidrV4(ip, ipv4ToInt([224, 0, 0, 0]), 4)) {
    return true;
  }
  // CGNAT 100.64.0.0/10
  return inCidrV4(ip, ipv4ToInt([100, 64, 0, 0]), 10);
}

function isBlockedIpv6(hextets: number[]): boolean {
  const first = hextets[0] ?? 0;
  const isZero = hextets.every((part) => part === 0);
  // unspecified ::
  if (isZero) {
    return true;
  }
  // loopback ::1
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1) {
    return true;
  }
  // unique local fc00::/7
  if ((first & 0xfe00) === 0xfc00) {
    return true;
  }
  // link-local unicast fe80::/10
  if ((first & 0xffc0) === 0xfe80) {
    return true;
  }
  // multicast ff00::/8 (includes ff01::/16 and ff02::/16)
  if ((first & 0xff00) === 0xff00) {
    return true;
  }
  return false;
}

function ipv4ToInt(octets: number[]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function inCidrV4(ip: number, prefix: number, bits: number): boolean {
  if (bits <= 0) {
    return true;
  }
  const mask = bits >= 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (prefix & mask);
}
