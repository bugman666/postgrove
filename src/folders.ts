export const SYSTEM_FOLDERS = ["inbox", "sent", "draft", "trash", "spam"] as const;
export type SystemFolder = (typeof SYSTEM_FOLDERS)[number];

/** Chinese labels for the system folders (IA / ROADMAP). Junk aliases to spam. */
export const FOLDER_LABELS: Record<SystemFolder, string> = {
  inbox: "收件箱",
  sent: "已发送",
  draft: "草稿",
  trash: "垃圾箱",
  spam: "垃圾邮件",
};

export const FOLDER_EMPTY: Record<SystemFolder, string> = {
  inbox: "还没有信。域名路由配好后，寄一封到你的地址试试。",
  sent: "还没有已发送的信。写出站邮件后会出现在这里。",
  draft: "还没有草稿。写信时点「存草稿」即可回来继续。",
  trash: "垃圾箱是空的。",
  spam: "没有标记为垃圾邮件的信。",
};

const SUBJECT_MAX = 998;
const BODY_MAX = 256_000;
const HEADER_MAX = 4000;

export interface DraftFields {
  to: string;
  cc: string;
  subject: string;
  text: string;
  inReplyTo: string | null;
  references: string | null;
}

export type ParseDraftResult =
  | { ok: true; fields: DraftFields }
  | { ok: false; error: string; hint: string };

export function parseFolder(raw: string | null | undefined): SystemFolder {
  const key = (raw ?? "").trim().toLowerCase();
  if (key === "junk") {
    return "spam";
  }
  if ((SYSTEM_FOLDERS as readonly string[]).includes(key)) {
    return key as SystemFolder;
  }
  return "inbox";
}

export function isSystemFolder(value: string): value is SystemFolder {
  return (SYSTEM_FOLDERS as readonly string[]).includes(value);
}

export function folderLabel(folder: SystemFolder): string {
  return FOLDER_LABELS[folder];
}

export function snippetFromBody(text: string, max = 140): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  return compact.length <= max ? compact : compact.slice(0, max);
}

export function parseDraftFields(raw: Record<string, unknown>): ParseDraftResult {
  const to = stringField(raw.to);
  const cc = stringField(raw.cc);
  const subjectRaw = stringField(raw.subject);
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

  const inReplyTo = optionalHeader(raw.in_reply_to ?? raw.inReplyTo);
  const references = optionalHeader(raw.references);
  if (inReplyTo && inReplyTo.length > HEADER_MAX) {
    return { ok: false, error: "invalid_request", hint: "In-Reply-To is too long." };
  }
  if (references && references.length > HEADER_MAX) {
    return { ok: false, error: "invalid_request", hint: "References is too long." };
  }

  return {
    ok: true,
    fields: {
      to,
      cc,
      subject: subjectRaw,
      text: textRaw,
      inReplyTo,
      references,
    },
  };
}

export function publicFolderList(): { id: SystemFolder; label: string }[] {
  return SYSTEM_FOLDERS.map((id) => ({ id, label: FOLDER_LABELS[id] }));
}

export function folderNavLinks(
  active: string,
  hrefFor: (folder: SystemFolder) => string,
  labels: Record<SystemFolder, string> = FOLDER_LABELS,
): { id: SystemFolder; label: string; href: string; active: boolean }[] {
  return SYSTEM_FOLDERS.map((id) => ({
    id,
    label: labels[id],
    href: hrefFor(id),
    active: active === id,
  }));
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalHeader(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
