export const APP_CSS = `:root {
  --pg-color-bg: #F7F5F0;
  --pg-color-surface: #FFFFFF;
  --pg-color-surface-muted: #EFEBE3;
  --pg-color-border: #D8D2C8;
  --pg-color-text: #1A1A18;
  --pg-color-text-secondary: #5C574F;
  --pg-color-text-tertiary: #8A847A;
  --pg-color-brand: #1B4332;
  --pg-color-brand-emphasis: #2D6A4F;
  --pg-color-accent: #40916C;
  --pg-color-danger: #9B2226;
  --pg-color-warning: #BB3E03;
  --pg-color-success: #2D6A4F;
  --pg-color-focus-ring: #2D6A4F;
  --pg-font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "WenQuanYi Micro Hei", "Noto Sans", sans-serif;
  --pg-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --pg-text-xs: 12px;
  --pg-text-sm: 13px;
  --pg-text-md: 15px;
  --pg-text-lg: 18px;
  --pg-text-xl: 22px;
  --pg-space-1: 4px;
  --pg-space-2: 8px;
  --pg-space-3: 12px;
  --pg-space-4: 16px;
  --pg-space-5: 24px;
  --pg-space-6: 32px;
  --pg-space-7: 48px;
  --pg-space-8: 64px;
  --pg-radius-sm: 6px;
  --pg-radius-md: 10px;
  --pg-radius-lg: 14px;
  --pg-shadow-sm: 0 1px 2px rgba(26, 26, 24, 0.06);
  --pg-nav-width: 200px;
  --pg-list-width: 360px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --pg-color-bg: #121411;
    --pg-color-surface: #1C1F1A;
    --pg-color-surface-muted: #242821;
    --pg-color-border: #3A4038;
    --pg-color-text: #F0EDE6;
    --pg-color-text-secondary: #A8A399;
    --pg-color-text-tertiary: #8A847A;
    --pg-color-brand: #52B788;
    --pg-color-brand-emphasis: #74C69D;
    --pg-color-accent: #52B788;
    --pg-color-danger: #E5383B;
    --pg-color-warning: #E85D04;
    --pg-color-success: #74C69D;
    --pg-color-focus-ring: #74C69D;
    --pg-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.28);
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
}

body {
  font-family: var(--pg-font-sans);
  font-size: var(--pg-text-md);
  line-height: 1.5;
  color: var(--pg-color-text);
  background: var(--pg-color-bg);
}

a {
  color: var(--pg-color-brand-emphasis);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

a:focus-visible,
button:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--pg-color-focus-ring);
  outline-offset: 2px;
}

.shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--pg-nav-width) var(--pg-list-width) 1fr;
}

.shell.simple {
  grid-template-columns: var(--pg-nav-width) 1fr;
}

.nav {
  padding: var(--pg-space-5) var(--pg-space-4);
  border-right: 1px solid var(--pg-color-border);
  background: var(--pg-color-bg);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--pg-space-2);
  color: var(--pg-color-brand);
  font-size: var(--pg-text-lg);
  font-weight: 650;
  letter-spacing: 0.01em;
  margin-bottom: var(--pg-space-5);
  text-decoration: none;
}

.brand:hover {
  color: var(--pg-color-brand-emphasis);
  text-decoration: none;
}

.brand-mark,
.brand-logo {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
}

.brand-logo {
  object-fit: contain;
  border-radius: 4px;
}

.nav-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--pg-space-1);
}

.nav-list a,
.nav-list span {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 var(--pg-space-3);
  border-radius: var(--pg-radius-sm);
  color: var(--pg-color-text);
  text-decoration: none;
  gap: var(--pg-space-2);
}

.nav-count {
  margin-left: auto;
  min-width: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--pg-color-accent);
  color: #F7F5F0;
  font-size: var(--pg-text-xs);
  font-weight: 650;
  line-height: 20px;
  text-align: center;
}

.nav-list a:hover {
  background: var(--pg-color-surface-muted);
  text-decoration: none;
}

.nav-list a.active {
  background: var(--pg-color-surface);
  color: var(--pg-color-brand);
  box-shadow: var(--pg-shadow-sm);
  font-weight: 600;
}

.nav-list .soon {
  color: var(--pg-color-text-tertiary);
}

.nav-tools {
  margin-top: var(--pg-space-4);
  padding-top: var(--pg-space-3);
  border-top: 1px solid var(--pg-color-border);
}

.folder-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pg-space-1);
  margin: 0 0 var(--pg-space-3);
}

.folder-chip {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 var(--pg-space-2);
  border: 1px solid var(--pg-color-border);
  border-radius: 999px;
  background: var(--pg-color-bg);
  color: var(--pg-color-text-secondary);
  font-size: var(--pg-text-xs);
  text-decoration: none;
}

.folder-chip:hover {
  color: var(--pg-color-brand);
  border-color: var(--pg-color-brand);
  text-decoration: none;
}

.folder-chip.active {
  background: var(--pg-color-surface-muted);
  color: var(--pg-color-brand);
  border-color: var(--pg-color-brand);
  font-weight: 600;
}

.compose-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pg-space-2);
}

.mailbox-chip {
  margin-top: var(--pg-space-6);
  padding: var(--pg-space-3);
  border: 1px solid var(--pg-color-border);
  border-radius: var(--pg-radius-md);
  background: var(--pg-color-surface);
}

.mailbox-chip .label {
  display: block;
  font-size: var(--pg-text-xs);
  color: var(--pg-color-text-secondary);
  margin-bottom: var(--pg-space-1);
}

.mailbox-chip .addr {
  font-family: var(--pg-font-mono);
  font-size: var(--pg-text-xs);
  word-break: break-all;
}

.list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--pg-color-surface);
  border-right: 1px solid var(--pg-color-border);
}

.list-head,
.page-head {
  padding: var(--pg-space-4) var(--pg-space-4) var(--pg-space-3);
  border-bottom: 1px solid var(--pg-color-border);
}

.list-head h1,
.page-head h1,
.read-head h1 {
  margin: 0 0 var(--pg-space-2);
  font-size: var(--pg-text-lg);
  font-weight: 650;
  color: var(--pg-color-brand);
}

.search-form {
  margin: 0;
}

.search {
  width: 100%;
  min-height: 40px;
  padding: 0 var(--pg-space-3);
  border: 1px solid var(--pg-color-border);
  border-radius: var(--pg-radius-sm);
  background: var(--pg-color-bg);
  color: var(--pg-color-text);
  font: inherit;
}

.search::placeholder {
  color: var(--pg-color-text-tertiary);
}

.search:disabled {
  color: var(--pg-color-text-tertiary);
  cursor: not-allowed;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pg-space-2);
  margin-top: var(--pg-space-3);
}

.filter {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 var(--pg-space-3);
  border: 1px solid var(--pg-color-border);
  border-radius: 999px;
  color: var(--pg-color-text-secondary);
  font-size: var(--pg-text-sm);
  text-decoration: none;
}

.filter:hover {
  background: var(--pg-color-surface-muted);
  text-decoration: none;
}

.filter.active {
  background: var(--pg-color-brand);
  border-color: var(--pg-color-brand);
  color: #F7F5F0;
  font-weight: 600;
}

.msg-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
}

.msg-row {
  display: grid;
  grid-template-columns: 44px 1fr;
  align-items: stretch;
  border-bottom: 1px solid var(--pg-color-border);
}

.star-form {
  margin: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.star-btn {
  appearance: none;
  min-width: 44px;
  min-height: 44px;
  border: 0;
  background: transparent;
  color: var(--pg-color-text-tertiary);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.star-btn.on,
.btn.star-on {
  color: var(--pg-color-warning);
}

.msg {
  display: block;
  padding: var(--pg-space-3) var(--pg-space-4);
  color: inherit;
  text-decoration: none;
  position: relative;
}

.msg-row .msg {
  border-bottom: 0;
}

.msg:hover {
  background: var(--pg-color-surface-muted);
  text-decoration: none;
}

.msg.selected {
  background: var(--pg-color-surface-muted);
  box-shadow: inset 3px 0 0 var(--pg-color-brand);
}

.msg.unread .subject {
  font-weight: 650;
}

.msg-top {
  display: flex;
  justify-content: space-between;
  gap: var(--pg-space-3);
  align-items: baseline;
}

.from {
  font-size: var(--pg-text-sm);
  color: var(--pg-color-text);
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  font-size: var(--pg-text-xs);
  color: var(--pg-color-text-secondary);
  flex: 0 0 auto;
}

.subject {
  margin: 2px 0;
  font-size: var(--pg-text-md);
}

.snippet {
  margin: 0;
  font-size: var(--pg-text-sm);
  color: var(--pg-color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unread-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--pg-color-accent);
  vertical-align: middle;
}

.thread-count {
  display: inline-block;
  flex: 0 0 auto;
  margin-left: auto;
  min-width: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--pg-color-surface-muted);
  color: var(--pg-color-text-secondary);
  font-size: var(--pg-text-xs);
  font-weight: 650;
  line-height: 18px;
  text-align: center;
}

.msg.unread .thread-count {
  background: var(--pg-color-accent);
  color: #F7F5F0;
}

.thread-summary {
  margin: 0 0 var(--pg-space-3);
  color: var(--pg-color-text-secondary);
  font-size: var(--pg-text-sm);
}

.thread-stack {
  display: flex;
  flex-direction: column;
  gap: var(--pg-space-4);
}

.thread-item.current .read-card {
  box-shadow: inset 3px 0 0 var(--pg-color-brand), var(--pg-shadow-sm);
}

.read,
.page {
  min-width: 0;
  background: var(--pg-color-bg);
}

.read-inner,
.page-inner {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--pg-space-5);
}

.read-card,
.page-card {
  background: var(--pg-color-surface);
  border: 1px solid var(--pg-color-border);
  border-radius: var(--pg-radius-lg);
  box-shadow: var(--pg-shadow-sm);
  padding: var(--pg-space-5);
}

.meta {
  display: grid;
  gap: var(--pg-space-1);
  margin: var(--pg-space-3) 0 var(--pg-space-4);
  font-size: var(--pg-text-sm);
  color: var(--pg-color-text-secondary);
}

.meta .mono {
  font-family: var(--pg-font-mono);
  font-size: var(--pg-text-xs);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pg-space-2);
  margin-bottom: var(--pg-space-4);
}

.btn {
  appearance: none;
  min-height: 44px;
  padding: 0 var(--pg-space-4);
  border-radius: var(--pg-radius-sm);
  border: 1px solid var(--pg-color-border);
  background: var(--pg-color-surface);
  color: var(--pg-color-text);
  font: inherit;
  cursor: pointer;
}

.btn:hover {
  background: var(--pg-color-surface-muted);
}

.btn-primary {
  background: var(--pg-color-brand);
  border-color: var(--pg-color-brand);
  color: #F7F5F0;
}

.btn-primary:hover {
  background: var(--pg-color-brand-emphasis);
  border-color: var(--pg-color-brand-emphasis);
}

.btn:disabled,
.btn-primary:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.btn-danger {
  color: var(--pg-color-danger);
  border-color: var(--pg-color-danger);
}

.btn-danger:hover {
  background: color-mix(in srgb, var(--pg-color-danger) 8%, var(--pg-color-surface));
}

.actions form {
  margin: 0;
}

.body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--pg-text-md);
  line-height: 1.6;
}

.banner {
  margin: 0 0 var(--pg-space-4);
  padding: var(--pg-space-3) var(--pg-space-4);
  border-radius: var(--pg-radius-sm);
  background: var(--pg-color-surface-muted);
  color: var(--pg-color-text-secondary);
  font-size: var(--pg-text-sm);
}

.banner.reply {
  border: 1px solid var(--pg-color-border);
  color: var(--pg-color-text);
}

.banner.success {
  background: color-mix(in srgb, var(--pg-color-success) 12%, var(--pg-color-surface));
  color: var(--pg-color-success);
}

.banner.danger {
  background: color-mix(in srgb, var(--pg-color-danger) 10%, var(--pg-color-surface));
  color: var(--pg-color-danger);
}

.compose-form,
.login-form,
.logout-form {
  display: flex;
  flex-direction: column;
  gap: var(--pg-space-3);
}

.compose-form {
  margin-bottom: var(--pg-space-5);
}

.compose-form label,
.login-form label {
  display: flex;
  flex-direction: column;
  gap: var(--pg-space-1);
  font-size: var(--pg-text-sm);
  color: var(--pg-color-text-secondary);
}

.compose-input {
  color: var(--pg-color-text);
}

.compose-input::placeholder,
.compose-body::placeholder {
  color: var(--pg-color-text-tertiary);
}

.compose-body {
  width: 100%;
  min-height: 240px;
  padding: var(--pg-space-3);
  border: 1px solid var(--pg-color-border);
  border-radius: var(--pg-radius-sm);
  background: var(--pg-color-bg);
  color: var(--pg-color-text);
  font: inherit;
  line-height: 1.6;
  resize: vertical;
}

.from-line {
  margin: 0;
  font-size: var(--pg-text-sm);
  color: var(--pg-color-text-secondary);
}

.from-line .mono {
  font-family: var(--pg-font-mono);
  font-size: var(--pg-text-xs);
}

.attempts h2 {
  margin: 0 0 var(--pg-space-3);
  font-size: var(--pg-text-md);
  font-weight: 650;
  color: var(--pg-color-brand);
}

.attempt-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.attempt {
  padding: var(--pg-space-3) 0;
  border-top: 1px solid var(--pg-color-border);
  font-size: var(--pg-text-sm);
  color: var(--pg-color-text-secondary);
}

.attempt.selected {
  box-shadow: inset 3px 0 0 var(--pg-color-brand);
  padding-left: var(--pg-space-3);
}

.attempt-top {
  display: flex;
  justify-content: space-between;
  gap: var(--pg-space-3);
  margin-bottom: var(--pg-space-1);
}

.attempt-status {
  font-weight: 650;
}

.attempt-status.sent {
  color: var(--pg-color-success);
}

.attempt-status.failed {
  color: var(--pg-color-danger);
}

.attempt .mono {
  font-family: var(--pg-font-mono);
  font-size: var(--pg-text-xs);
}

.attempt-hint {
  margin: var(--pg-space-2) 0 0;
}

.empty {
  padding: var(--pg-space-7) var(--pg-space-4);
  text-align: center;
  color: var(--pg-color-text-secondary);
}

.empty-art {
  width: 72px;
  height: 64px;
  margin: 0 auto var(--pg-space-4);
  color: var(--pg-color-brand);
}

.empty p {
  margin: 0 auto;
  max-width: 28ch;
}

.back {
  display: none;
  margin-bottom: var(--pg-space-3);
  font-size: var(--pg-text-sm);
}

.mobile-nav {
  display: none;
}

.addr-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.addr-list li {
  border-bottom: 1px solid var(--pg-color-border);
}

.addr-list a {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--pg-space-3) 0;
  min-height: 44px;
  color: inherit;
  text-decoration: none;
}

.addr-list a:hover {
  color: var(--pg-color-brand-emphasis);
}

.addr-list .name {
  font-weight: 600;
}

.addr-list .mono {
  font-family: var(--pg-font-mono);
  font-size: var(--pg-text-sm);
  color: var(--pg-color-text-secondary);
}

.login-form,
.logout-form {
  margin-top: var(--pg-space-4);
}

.logout-form {
  align-items: flex-start;
}

.page-inner-wide {
  max-width: 960px;
}

.admin-subnav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pg-space-2);
  margin: 0 0 var(--pg-space-4);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--pg-space-3);
  margin: 0 0 var(--pg-space-5);
}

.stat-card {
  background: var(--pg-color-surface);
  border: 1px solid var(--pg-color-border);
  border-radius: var(--pg-radius-md);
  box-shadow: var(--pg-shadow-sm);
  padding: var(--pg-space-4);
}

.stat-card .label {
  display: block;
  font-size: var(--pg-text-xs);
  color: var(--pg-color-text-secondary);
  margin-bottom: var(--pg-space-1);
}

.stat-card .value {
  font-size: var(--pg-text-xl);
  font-weight: 650;
  color: var(--pg-color-brand);
}

.grove-panel {
  margin: 0 0 var(--pg-space-6);
}

.grove-panel h2 {
  margin: 0 0 var(--pg-space-3);
  color: var(--pg-color-brand);
  font-size: var(--pg-text-lg);
}

.table-wrap {
  overflow-x: auto;
  margin: 0 0 var(--pg-space-4);
}

.grove-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--pg-text-sm);
}

.grove-table th,
.grove-table td {
  text-align: left;
  padding: var(--pg-space-2) var(--pg-space-3);
  border-bottom: 1px solid var(--pg-color-border);
  vertical-align: top;
}

.grove-table th {
  color: var(--pg-color-text-secondary);
  font-weight: 650;
}

.grove-table .mono {
  font-family: var(--pg-font-mono);
  font-size: var(--pg-text-xs);
}

.grove-table .quota-cell {
  color: var(--pg-color-text-secondary);
  font-size: var(--pg-text-xs);
}

.grove-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--pg-space-3);
  align-items: end;
}

.grove-form-stack {
  grid-template-columns: 1fr;
  align-items: stretch;
}

.grove-check {
  flex-direction: row !important;
  align-items: center;
  gap: var(--pg-space-2);
}

.grove-form label {
  display: flex;
  flex-direction: column;
  gap: var(--pg-space-1);
  font-size: var(--pg-text-sm);
  color: var(--pg-color-text-secondary);
}

.grove-form select,
.grove-form input[type="number"] {
  min-height: 44px;
  padding: 0 var(--pg-space-3);
  border: 1px solid var(--pg-color-border);
  border-radius: var(--pg-radius-sm);
  background: var(--pg-color-bg);
  color: var(--pg-color-text);
  font: inherit;
}

@media (min-width: 960px) {
  .folder-strip {
    display: none;
  }
}

@media (max-width: 959px) {
  .shell,
  .shell.simple {
    grid-template-columns: 1fr;
    padding-bottom: 64px;
  }

  .nav {
    display: none;
  }

  body.mode-read .list {
    display: none;
  }

  body.mode-list .read {
    display: none;
  }

  .back {
    display: inline-block;
  }

  .mobile-nav {
    display: flex;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: 56px;
    background: var(--pg-color-surface);
    border-top: 1px solid var(--pg-color-border);
  }

  .mobile-nav a {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--pg-color-text-secondary);
    font-size: var(--pg-text-sm);
    text-decoration: none;
  }

  .mobile-nav a.active {
    color: var(--pg-color-brand);
    font-weight: 650;
  }

  .mobile-nav .nav-count {
    margin-left: 6px;
  }
}
`;
