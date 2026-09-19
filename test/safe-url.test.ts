import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isBlockedHostname,
  isBlockedIp,
  isIpLiteral,
  recheckResolvedIps,
  validateSafeUrl,
} from "../src/safe-url.ts";

test("https public URL is allowed", () => {
  const result = validateSafeUrl("https://example.org/hooks");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.url.hostname, "example.org");
    assert.equal(result.url.protocol, "https:");
  }
});

test("http to a public host is allowed (scheme is not the private gate)", () => {
  const result = validateSafeUrl("http://example.org/status");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.url.protocol, "http:");
  }
});

test("public literal IPv4 is allowed", () => {
  assert.equal(validateSafeUrl("http://8.8.8.8/").ok, true);
  assert.equal(validateSafeUrl("http://172.15.0.1/").ok, true);
  assert.equal(validateSafeUrl("http://172.32.0.1/").ok, true);
});

test("localhost and metadata hostnames are blocked", () => {
  for (const raw of [
    "http://localhost/",
    "http://LOCALHOST/foo",
    "http://localhost.localdomain/",
    "http://foo.localhost/",
    "http://metadata/",
    "http://metadata.google.internal/",
    "http://METADATA.GOOG/",
  ]) {
    const result = validateSafeUrl(raw);
    assert.equal(result.ok, false, raw);
    if (!result.ok) {
      assert.equal(result.error, "blocked_destination");
      assert.match(result.hint, /not allowed|scheme/i);
    }
  }
});

test("loopback, RFC1918, link-local metadata, and CGNAT IPs are blocked", () => {
  for (const raw of [
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/healthz",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://169.254.169.254/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://100.64.0.1/",
    "http://[::ffff:127.0.0.1]/",
  ]) {
    const result = validateSafeUrl(raw);
    assert.equal(result.ok, false, raw);
    if (!result.ok) {
      assert.equal(result.error, "blocked_destination");
    }
  }
});

test("allowPrivate accepts private http hosts and still rejects bad schemes", () => {
  assert.equal(validateSafeUrl("http://127.0.0.1/", { allowPrivate: true }).ok, true);
  assert.equal(validateSafeUrl("http://localhost/", { allowPrivate: true }).ok, true);
  assert.equal(validateSafeUrl("http://10.1.2.3/hook", { allowPrivate: true }).ok, true);
  assert.equal(validateSafeUrl("http://192.168.0.9/", { allowPrivate: true }).ok, true);
  assert.equal(validateSafeUrl("http://169.254.169.254/", { allowPrivate: true }).ok, true);

  const ftp = validateSafeUrl("ftp://127.0.0.1/", { allowPrivate: true });
  assert.equal(ftp.ok, false);
  if (!ftp.ok) {
    assert.equal(ftp.error, "blocked_destination");
    assert.match(ftp.hint, /http or https/);
  }
});

test("non-http(s) schemes are blocked", () => {
  for (const raw of [
    "ftp://example.org",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "gopher://example.org",
    "data:text/plain,hi",
  ]) {
    const result = validateSafeUrl(raw);
    assert.equal(result.ok, false, raw);
    if (!result.ok) {
      assert.equal(result.error, "blocked_destination");
      assert.match(result.hint, /http or https/);
    }
  }
});

test("empty and relative URLs are blocked", () => {
  for (const raw of ["", "   ", "/hooks", "example.org", "//example.org/path"]) {
    const result = validateSafeUrl(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    if (!result.ok) {
      assert.equal(result.error, "invalid_url");
      assert.match(result.hint, /absolute http\(s\)/);
    }
  }
});

test("isBlockedHostname is case-insensitive and matches *.localhost", () => {
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isBlockedHostname("LOCALHOST"), true);
  assert.equal(isBlockedHostname("localhost.localdomain"), true);
  assert.equal(isBlockedHostname("metadata.google.internal"), true);
  assert.equal(isBlockedHostname("metadata.goog"), true);
  assert.equal(isBlockedHostname("metadata"), true);
  assert.equal(isBlockedHostname("svc.localhost"), true);
  assert.equal(isBlockedHostname("example.org"), false);
  assert.equal(isBlockedHostname("localhost.com"), false);
});

test("isBlockedIp covers IPv4/IPv6 textual ranges", () => {
  assert.equal(isBlockedIp("127.0.0.1"), true);
  assert.equal(isBlockedIp("10.9.8.7"), true);
  assert.equal(isBlockedIp("192.168.0.1"), true);
  assert.equal(isBlockedIp("172.16.0.1"), true);
  assert.equal(isBlockedIp("169.254.169.254"), true);
  assert.equal(isBlockedIp("100.64.0.1"), true);
  assert.equal(isBlockedIp("0.0.0.0"), true);
  assert.equal(isBlockedIp("224.0.0.1"), true);
  assert.equal(isBlockedIp("8.8.8.8"), false);
  assert.equal(isBlockedIp("172.15.0.1"), false);
  assert.equal(isBlockedIp("1.1.1.1"), false);

  assert.equal(isBlockedIp("::1"), true);
  assert.equal(isBlockedIp("::"), true);
  assert.equal(isBlockedIp("fe80::1"), true);
  assert.equal(isBlockedIp("fc00::1"), true);
  assert.equal(isBlockedIp("ff02::1"), true);
  assert.equal(isBlockedIp("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIp("::ffff:8.8.8.8"), false);
  assert.equal(isBlockedIp("2001:4860:4860::8888"), false);
  assert.equal(isBlockedIp("not-an-ip"), false);
});

test("isIpLiteral accepts textual IPv4/IPv6", () => {
  assert.equal(isIpLiteral("8.8.8.8"), true);
  assert.equal(isIpLiteral("127.0.0.1"), true);
  assert.equal(isIpLiteral("::1"), true);
  assert.equal(isIpLiteral("[::1]"), true);
  assert.equal(isIpLiteral("cdn.example.test"), false);
});

test("recheckResolvedIps rejects a hostname that resolves to RFC1918", async () => {
  const blocked = await recheckResolvedIps("cdn.example.test", {
    resolveHost: async () => ["10.1.2.3"],
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.error, "blocked_destination");
    assert.match(blocked.hint, /10\.1\.2\.3/);
  }

  const publicOk = await recheckResolvedIps("cdn.example.test", {
    resolveHost: async () => ["203.0.113.10"],
  });
  assert.equal(publicOk.ok, true);

  const skip = await recheckResolvedIps("cdn.example.test", {
    resolveHost: async () => null,
  });
  assert.equal(skip.ok, true);

  const literal = await recheckResolvedIps("8.8.8.8", {
    resolveHost: async () => {
      throw new Error("should not resolve a literal");
    },
  });
  assert.equal(literal.ok, true);
});
