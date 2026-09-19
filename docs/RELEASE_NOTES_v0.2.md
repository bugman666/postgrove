# Postgrove v0.2 — 发版说明

**一句话**：自有域名边缘邮箱的成熟化一刀——搜索更准、会话更稳、发信可重试、文档可跟、界面更好读。仍不是公共临时邮。

对照：[`docs/AUDIT_v0.2.md`](AUDIT_v0.2.md) 与 Issue [#33](https://github.com/bugman666/postgrove/issues/33)。技术核对：main 含 PR [#72](https://github.com/bugman666/postgrove/pull/72) / migration `0018`。首发见 [`docs/RELEASE_NOTES_v0.1.md`](RELEASE_NOTES_v0.1.md)。

## 相对 v0.1 你多了什么

### 读与找

- **FTS5 搜索**（失败回落 LIKE；API `engine`=`fts5`/`like`）— #66 / PR #70 · migration `0016`
- **持久 `thread_id`**（入站/出站写入；跨页不拆串）— #68 / PR #73 · migration `0017`

### 发与投递

- **出站 outbox**：先 `pending`+幂等键再打 provider；同键重放不重复寄；请求内有限重试 — #48 / PR #59 · migration `0015`
- **入站 webhook 重投**：**已合**。pending + scheduled drain；admin 可见；仍走 SSRF + 签验 — #67 / PR #72 · migration `0018`

### 安全与可靠

- **共享限流**（`RATE_LIMIT` KV 固定窗；无 binding 回落内存）+ 鉴权矩阵 — #51 / PR #62
- **生产鉴权 / 出站 URL 门槛**（`PRODUCTION_AUTH.md`；`assertOutboundHttpUrl`；`OUTBOUND_HTTP_STRICT` 默认关）— #52 / PR #61
- P0：**正文 CTE**（text/plain+html 与附件同路 base64/QP）— #54 / PR #56
- P0：**入站附件 R2 失败勿吞**（回滚 D1 + `setReject`）— #55 / PR #57

### 体验

- 个人导航分组；移动端 ≤4 主入口；值守独立 — #53 / PR #69
- 空收件箱接品牌图；搜索无结果专用文案
- 错误横幅：人话主句 + 折叠「详情」

### 开发者与运维

- OpenAPI 3 + `docs/API.md` + `docs/llms.txt` — #64 / PR #71
- 一路径 `docs/DEPLOY.md` — #65 / PR #71
- MIME 夹具 + 共享 MemoryD1 — #49 / PR #60
- 本地 smoke + 空库 migrate CI — #50 / PR #63

### 工程债

- `ui.ts` → routes/pages；打开线程批量 mark-read / 附件 — #47 / PR #58

## 技术对照

| 项 | Issue | PR | Migration |
|----|-------|-----|-----------|
| Outbox | #48 | #59 | `0015` |
| FTS5 | #66 | #70 | `0016` |
| Persistent `thread_id` | #68 | #73 | `0017` |
| Webhook retry | #67 | #72 | `0018` |
| Shared rate-limit + auth matrix | #51 | #62 | — |
| Production auth + outbound URL gate | #52 | #61 | — |
| Body CTE | #54 | #56 | — |
| Inbound R2 fail-closed | #55 | #57 | — |
| Nav / empty / error UX | #53 | #69 | — |
| OpenAPI + DEPLOY | #64 / #65 | #71 | — |
| MIME fixtures + MemoryD1 | #49 | #60 | — |
| Smoke + empty-D1 CI | #50 | #63 | — |
| UI split + batched thread reads | #47 | #58 | — |

## migration 链（main）

`0014` webhook secret 信封 → `0015` outbox → `0016` FTS → `0017` thread_id → `0018` webhook retry

## 刻意仍不做

- 第三方临时邮聚合 / 多提供商即抛池
- 日历、通讯录、完整 IMAP 替代
- 换肤商店、重型 BI
- 美术大改（浅色编辑风锁定；精修延后）

## 部署者须知

见 [`docs/DEPLOY.md`](DEPLOY.md)、[`docs/PRODUCTION_AUTH.md`](PRODUCTION_AUTH.md)。你负责域名、Routing、出站额度与滥用面。公开注册默认关。

本地：Node 22+，`npm i && npm run check && npm test`。

## 品牌

纸底 + 墨绿；[`docs/assets/`](assets/)。

## Quality / release gate

### Automated (CI)
- `npm run check` + `npm test` on Node 22
- Empty local D1: `wrangler d1 migrations apply postgrove --local --persist-to <tmp>` (0001→0018)

### Local smoke (`npm run smoke:local`)
Needs `db:migrate:local` + `seed:local` + `wrangler dev`. Covers #44 gate **S1–S5, S8**:
1. Login (seed + `OWNER_TOKEN`; unauth → 401)
2. Inbox read / delete → trash
3. Compose (stub attempt + Sent)
4. Reply / forward prefills + stub send
5. Attachment download; unauth → 401
8. Dev API: create → wait(408) → extract OTP → close (idempotent)

Optional (manual / known if skipped): S6 search·unread·star, S7 webhook (+ cron drain after #67), S9 `+tag`.

### Tag checklist
`check` + `test` + empty-D1 migrate + `smoke:local` green before `v0.2.0`.

## 下一步

- 打 tag `v0.2.0` + GitHub Release（正文可用本文）
- [#33](https://github.com/bugman666/postgrove/issues/33) 仍是工程约定，未关；hardening 见 AUDIT 文首「v0.3-hardening」
