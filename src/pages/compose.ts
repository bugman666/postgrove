import { humanErrorMessage, layeredBannerHtml } from "../error-banner.ts";
import { describeOutbound } from "../outbound.ts";
import { composeHeading, type ComposeMode, type ComposePrefill } from "../reply.ts";
import type { MailboxRecord, MessageRecord, OutboundAttemptRecord } from "../store.ts";
import { escapeHtml, formatReceived } from "../html.ts";
import { withMailbox } from "../ui-paths.ts";
import { layout, pageTitle, tr, type Shell } from "../view.ts";
import type { Env } from "../env.ts";

export interface ComposeForm {
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyTo: string;
  references: string;
  draftId: string;
}


export function emptyComposeForm(): ComposeForm {
  return { to: "", cc: "", subject: "", body: "", inReplyTo: "", references: "", draftId: "" };
}

export function formFromPrefill(prefill: ComposePrefill): ComposeForm {
  return {
    to: prefill.to,
    cc: prefill.cc,
    subject: prefill.subject,
    body: prefill.body,
    inReplyTo: prefill.inReplyTo,
    references: prefill.references,
    draftId: "",
  };
}

export function formFromDraft(row: MessageRecord): ComposeForm {
  return {
    to: row.envelope_to,
    cc: row.header_cc ?? "",
    subject: row.subject ?? "",
    body: row.body_text ?? "",
    inReplyTo: row.in_reply_to ?? "",
    references: row.references_header ?? "",
    draftId: row.id,
  };
}


export function renderComposePage(
  env: Env,
  mailbox: MailboxRecord | null,
  opts: {
    form: ComposeForm;
    formError?: string;
    highlighted?: OutboundAttemptRecord | null;
    attempts: OutboundAttemptRecord[];
    mode?: ComposeMode;
    unreadCount: number;
    savedDraft?: boolean;
    shell: Shell;
  },
): string {
  const shell = opts.shell;
  const outbound = describeOutbound(env);
  const mode = opts.mode ?? "new";
  const heading = composeHeading(mode);
  const banners: string[] = [];
  if (opts.highlighted) {
    banners.push(attemptBanner(opts.highlighted, shell));
  }
  if (opts.savedDraft) {
    banners.push(`<p class="banner success">${escapeHtml(tr(shell, "banner.draft-saved"))}</p>`);
  }
  if (opts.formError) {
    banners.push(
      layeredBannerHtml({ locale: shell.locale, tone: "danger", message: opts.formError }),
    );
  }
  if (!opts.highlighted && mode !== "new") {
    banners.push(
      `<p class="banner reply">${escapeHtml(heading)}会走现有出站通道。可改收件人或正文后再发送。</p>`,
    );
  }
  if (!opts.highlighted && outbound.provider === "unset") {
    banners.push(
      layeredBannerHtml({
        locale: shell.locale,
        tone: "danger",
        message: tr(shell, "error.outbound-unset"),
        code: "outbound_not_configured",
        detail: outbound.hint,
      }),
    );
  } else if (!opts.highlighted && outbound.provider === "stub") {
    banners.push(`<p class="banner">${escapeHtml(outbound.hint)}</p>`);
  }

  const fromLine = mailbox
    ? `<p class="from-line">发件人 <span class="mono">${escapeHtml(mailbox.address)}</span></p>`
    : `<p class="banner danger">${escapeHtml(tr(shell, "banner.no-mailbox"))}</p>`;

  const threadLine = opts.form.inReplyTo
    ? `<p class="from-line">引用 <span class="mono">In-Reply-To: ${escapeHtml(opts.form.inReplyTo)}</span></p>`
    : "";

  const disabled = mailbox ? "" : " disabled";
  const form = `<form id="compose-form" class="compose-form" method="post" action="${escapeHtml(withMailbox("/compose", mailbox))}">
      ${fromLine}
      ${threadLine}
      <input type="hidden" name="in_reply_to" value="${escapeHtml(opts.form.inReplyTo)}">
      <input type="hidden" name="references" value="${escapeHtml(opts.form.references)}">
      <input type="hidden" name="draft_id" value="${escapeHtml(opts.form.draftId)}">
      <label>收件人
        <input class="search compose-input" name="to" type="text" inputmode="email" autocomplete="email" placeholder="neighbor@example.test" value="${escapeHtml(opts.form.to)}"${disabled}>
      </label>
      <label>抄送
        <input class="search compose-input" name="cc" type="text" inputmode="email" autocomplete="email" placeholder="可选，多人用逗号分隔" value="${escapeHtml(opts.form.cc)}"${disabled}>
      </label>
      <label>主题
        <input class="search compose-input" name="subject" type="text" maxlength="998" value="${escapeHtml(opts.form.subject)}"${disabled}>
      </label>
      <label>正文
        <textarea class="compose-body" name="body" rows="14"${disabled}>${escapeHtml(opts.form.body)}</textarea>
      </label>
      <div class="compose-actions">
        <button class="btn btn-primary" type="submit" name="intent" value="send"${disabled}>发送</button>
        <button class="btn" type="submit" name="intent" value="save"${disabled}>存草稿</button>
      </div>
    </form>
    <script>
      (function () {
        var form = document.getElementById("compose-form");
        if (!form) return;
        form.addEventListener("submit", function (event) {
          var submitter = event.submitter;
          var intent = submitter && submitter.getAttribute("value");
          if (intent === "save") return;
          var to = form.querySelector("input[name=to]");
          if (to && !String(to.value || "").match(/[^\\s@]+@[^\\s@]+\\.[^\\s@]+/)) {
            event.preventDefault();
            if (to.setCustomValidity) to.setCustomValidity("填写至少一个收件人地址后再发送。");
            if (to.reportValidity) to.reportValidity();
            if (to.setCustomValidity) to.setCustomValidity("");
            return;
          }
          var btn = form.querySelector("button[name=intent][value=send]");
          if (btn) {
            btn.disabled = true;
            btn.textContent = "正在发送…";
          }
        });
      })();
    </script>`;

  const history = renderAttemptHistory(opts.attempts, opts.highlighted?.id ?? null);

  return layout({
    title: pageTitle(shell, heading),
    nav: "compose",
    mailbox,
    mode: "list",
    simple: true,
    unreadCount: opts.unreadCount,
    shell,
    body: `<main class="page"><div class="page-inner">
      <div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
      <div class="page-card">${banners.join("")}${form}${history}</div>
    </div></main>`,
  });
}

export function attemptBanner(row: OutboundAttemptRecord, shell: Shell): string {
  if (row.status === "sent") {
    const extra =
      row.provider === "stub"
        ? "已记下这次发送（stub 不真正寄出）。"
        : "已发出。";
    return `<p class="banner success">${escapeHtml(extra)}</p>`;
  }
  if (row.status === "pending") {
    return `<p class="banner">发送还在处理：已记下出站记录，正在向提供商投递（最多 ${row.max_attempts} 次）。</p>`;
  }
  const code = row.error || "outbound_failed";
  const message =
    humanErrorMessage(shell.locale, code) || tr(shell, "error.send-failed");
  return layeredBannerHtml({
    locale: shell.locale,
    tone: "danger",
    message,
    code,
    detail: row.hint,
  });
}

export function renderAttemptHistory(
  attempts: OutboundAttemptRecord[],
  highlightedId: string | null,
): string {
  if (attempts.length === 0) {
    return "";
  }
  const items = attempts
    .map((row) => {
      const selected = row.id === highlightedId ? " selected" : "";
      const status =
        row.status === "sent"
          ? "已发出"
          : row.status === "pending"
            ? "处理中"
            : `失败 · ${row.error || "outbound_failed"}`;
      const subject = row.subject?.trim() ? row.subject : "（无主题）";
      return `<li class="attempt${selected}">
        <div class="attempt-top">
          <span class="attempt-status ${row.status}">${escapeHtml(status)}</span>
          <time datetime="${escapeHtml(new Date(row.created_at).toISOString())}">${escapeHtml(formatReceived(row.created_at))}</time>
        </div>
        <div>收件人 <span class="mono">${escapeHtml(row.to_address)}</span></div>
        ${row.cc_address ? `<div>抄送 <span class="mono">${escapeHtml(row.cc_address)}</span></div>` : ""}
        <div>主题 ${escapeHtml(subject)}</div>
        ${row.in_reply_to ? `<div>引用 <span class="mono">${escapeHtml(row.in_reply_to)}</span></div>` : ""}
        <div>提供商 <span class="mono">${escapeHtml(row.provider)}</span></div>
        ${row.hint ? `<p class="attempt-hint">${escapeHtml(row.hint)}</p>` : ""}
      </li>`;
    })
    .join("");
  return `<section class="attempts">
    <h2>最近发送</h2>
    <ul class="attempt-list">${items}</ul>
  </section>`;
}

