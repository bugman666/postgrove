import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAttachments, extractBodies } from "../src/mime.ts";

function message(headers: string[], body: string): string {
  return [...headers, "", body].join("\r\n");
}

test("extractBodies decodes text/plain base64 CTE", () => {
  const raw = message(
    [
      "From: sender@example.com",
      "To: inbox@example.test",
      "Subject: plain base64",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ],
    Buffer.from("Hello Grove café", "utf8").toString("base64"),
  );

  const bodies = extractBodies(raw);
  assert.equal(bodies.bodyText, "Hello Grove café");
  assert.match(bodies.snippet ?? "", /Hello Grove/);
  assert.doesNotMatch(bodies.bodyText ?? "", /SGVsbG8/);
});

test("extractBodies decodes text/plain quoted-printable CTE", () => {
  const raw = message(
    [
      "From: sender@example.com",
      "To: inbox@example.test",
      "Subject: plain qp",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
    ],
    "Hello=20Grove=20caf=C3=A9=\r\n!",
  );

  const bodies = extractBodies(raw);
  assert.equal(bodies.bodyText, "Hello Grove café!");
  assert.match(bodies.snippet ?? "", /Hello Grove café/);
  assert.doesNotMatch(bodies.bodyText ?? "", /=20Grove/);
});

test("extractBodies decodes text/html base64 CTE", () => {
  const html = "<p>Readable <b>HTML</b> body</p>";
  const raw = message(
    [
      "From: sender@example.com",
      "To: inbox@example.test",
      "Subject: html base64",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ],
    Buffer.from(html, "utf8").toString("base64"),
  );

  const bodies = extractBodies(raw);
  assert.equal(bodies.bodyText, "Readable HTML body");
  assert.match(bodies.snippet ?? "", /Readable HTML body/);
  assert.doesNotMatch(bodies.bodyText ?? "", /PHA\+/);
});

test("extractBodies decodes text/html quoted-printable CTE", () => {
  const raw = message(
    [
      "From: sender@example.com",
      "To: inbox@example.test",
      "Subject: html qp",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
    ],
    "<p>Caf=C3=A9 <b>Grove</b></p>",
  );

  const bodies = extractBodies(raw);
  assert.equal(bodies.bodyText, "Café Grove");
  assert.match(bodies.snippet ?? "", /Café Grove/);
  assert.doesNotMatch(bodies.bodyText ?? "", /=C3=A9/);
});

test("extractBodies still reads 7bit text without CTE", () => {
  const raw = message(
    [
      "From: sender@example.com",
      "To: inbox@example.test",
      "Subject: seven bit",
      "Content-Type: text/plain; charset=utf-8",
    ],
    "See attached.",
  );

  const bodies = extractBodies(raw);
  assert.equal(bodies.bodyText, "See attached.");
});

test("extractBodies decodes multipart text/plain QP and prefers it over HTML", () => {
  const htmlB64 = Buffer.from("<p>HTML fallback</p>", "utf8").toString("base64");
  const raw = [
    "From: sender@example.com",
    "To: inbox@example.test",
    "Subject: alternative",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Plain=20wins",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    htmlB64,
    "--alt--",
    "",
  ].join("\r\n");

  const bodies = extractBodies(raw);
  assert.equal(bodies.bodyText, "Plain wins");
  assert.doesNotMatch(bodies.bodyText ?? "", /HTML fallback/);
});

test("extractBodies falls back to decoded HTML when no plain part exists", () => {
  const htmlB64 = Buffer.from("<p>Only <em>HTML</em></p>", "utf8").toString("base64");
  const raw = [
    "From: sender@example.com",
    "To: inbox@example.test",
    "Subject: html only",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="only"',
    "",
    "--only",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    htmlB64,
    "--only--",
    "",
  ].join("\r\n");

  const bodies = extractBodies(raw);
  assert.equal(bodies.bodyText, "Only HTML");
});

test("attachment base64 CTE still decodes after body CTE support", () => {
  const payload = Buffer.from("hello grove", "utf8").toString("base64");
  const raw = [
    "From: sender@example.com",
    "To: inbox@example.test",
    "Subject: files",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="bnd"',
    "",
    "--bnd",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "See=20attached.",
    "--bnd",
    "Content-Type: text/plain; name=grove-note.txt",
    'Content-Disposition: attachment; filename="grove-note.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    payload,
    "--bnd--",
    "",
  ].join("\r\n");

  const bodies = extractBodies(raw);
  assert.equal(bodies.bodyText, "See attached.");

  const files = extractAttachments(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "grove-note.txt");
  assert.equal(new TextDecoder().decode(files[0].bytes), "hello grove");
});
