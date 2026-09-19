# Postgrove 视觉体系 v0

> Issue #2 · 原创视觉语言 · 禁止照搬其它 Cloudflare 邮箱项目的配色 / 布局壳 / 插画风格

---

## 1. 气质一句话

**冷静林间工具感**：少装饰、多留白、信息优先。像一片安静的邮箱树林，不是霓虹 SaaS，也不是默认后台组件皮肤。

**Brand art:** light editorial (paper + forest green). Locked stills live in [`docs/assets/`](assets/); polish later.

## 2. Design tokens（建议 CSS 变量名）

### 2.1 颜色 · Light（MVP 必做）

| Token | 值 | 用途 |
|-------|-----|------|
| `--pg-color-bg` | `#F7F5F0` | 页面浅纸底 |
| `--pg-color-surface` | `#FFFFFF` | 卡片 / 阅读面板 |
| `--pg-color-surface-muted` | `#EFEBE3` | 列表斑马 / 次级区 |
| `--pg-color-border` | `#D8D2C8` | 分割线、输入框边 |
| `--pg-color-text` | `#1A1A18` | 主文字 |
| `--pg-color-text-secondary` | `#5C574F` | 次要说明、时间戳 |
| `--pg-color-text-tertiary` | `#8A847A` | 占位、禁用 |
| `--pg-color-brand` | `#1B4332` | 主色（墨绿） |
| `--pg-color-brand-emphasis` | `#2D6A4F` | 悬停 / 强调链接 |
| `--pg-color-accent` | `#40916C` | 未读点、焦点环辅助 |
| `--pg-color-danger` | `#9B2226` | 删除、错误 |
| `--pg-color-warning` | `#BB3E03` | 配额接近上限 |
| `--pg-color-success` | `#2D6A4F` | 发送成功 |
| `--pg-color-focus-ring` | `#2D6A4F` | 焦点环（可见） |

### 2.2 颜色 · Dark（MVP 可选；有则做，无则记路线图）

| Token | 值 |
|-------|-----|
| `--pg-color-bg` | `#121411` |
| `--pg-color-surface` | `#1C1F1A` |
| `--pg-color-surface-muted` | `#242821` |
| `--pg-color-border` | `#3A4038` |
| `--pg-color-text` | `#F0EDE6` |
| `--pg-color-text-secondary` | `#A8A399` |
| `--pg-color-brand` | `#52B788` |
| `--pg-color-brand-emphasis` | `#74C69D` |
| `--pg-color-danger` | `#E5383B` |

系统跟随：`prefers-color-scheme`；设置里可后加手动切换。

### 2.3 字体

| Token | 值 |
|-------|-----|
| `--pg-font-sans` | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif` |
| `--pg-font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace` |
| `--pg-text-xs` | `12px` / `1.4` |
| `--pg-text-sm` | `13px` / `1.45` |
| `--pg-text-md` | `15px` / `1.5` |
| `--pg-text-lg` | `18px` / `1.4` |
| `--pg-text-xl` | `22px` / `1.3` |

规则：界面用 sans；**邮箱地址、Message-ID、技术 ID 用 mono**。

### 2.4 间距与圆角

| Token | 值 |
|-------|-----|
| `--pg-space-1` … `--pg-space-8` | `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64` px |
| `--pg-radius-sm` | `6px` |
| `--pg-radius-md` | `10px` |
| `--pg-radius-lg` | `14px` |
| `--pg-shadow-sm` | `0 1px 2px rgba(26,26,24,.06)` |

### 2.5 动效

- 列表切换、面板展开：`150–200ms` ease  
- **不要**大面积弹跳、闪烁未读动画

## 3. 布局

### 桌面（≥960px）

可选三栏：

1. **导航**（窄，~200px）：收件箱 / 写信 / 地址 / 设置  
2. **列表**（~320–380px）：邮件行；未读左侧色条或圆点（`--pg-color-accent`）  
3. **阅读**（弹性）：主题 + 元信息 + 正文；附件条在正文上或下固定区

无邮件选中时，阅读区显示空状态（见下）。

### 平板 / 手机

- 单栏；列表 → 阅读为推入式详情  
- 底部或顶部 **最多 4 个**主导航：收件箱 · 写信 · 地址 · 设置  
- 触控目标 ≥ 44px

## 4. 空 / 错 / 加载状态（文案可直接用）

| 状态 | 文案 | 视觉 |
|------|------|------|
| 空收件箱 | 还没有信。域名路由配好后，寄一封到你的地址试试。 | 简洁线稿「信封 + 小树」或纯排版；**禁止**卡通堆砌 |
| 未选邮件 | 从左侧选一封，或点「写信」。 | 低对比说明文字即可 |
| 空地址 | 还没有地址。创建一个，例如 `you@yourdomain`。 | 主按钮「创建地址」 |
| 加载列表 | （无文案或极短「加载中」） | 骨架屏 3–5 行，勿转圈霸屏 |
| 发送中 | 正在发送… | 按钮 loading，可取消视实现 |
| 发送失败 | 没发出去：{原因}。检查出站配置或稍后重试。 | danger 色横幅 |
| 附件超限 | 附件太大（上限 {n} MB）。去掉大文件或压缩后再试。 | 行内错误 |
| 鉴权失败 | 登录已失效。重新登录后再继续。 | 全页或模态，单主按钮 |
| 路由未通 | 还没收到信？确认 Email Routing 已指向本 Worker。 | 设置页提示条 |

插画原则：单色或双色线稿，贴合墨绿；可后期补，MVP 用排版空状态也合格。

## 5. 组件备注（给实现）

- 主按钮：实心 brand；次按钮：描边 border + text  
- 输入框：浅底或白底 + border；focus 用 focus-ring，勿仅靠颜色  
- 邮件行：悬停 `surface-muted`；选中左侧 3px brand 条  
- **禁止**：默认 Element/Ant 后台紫蓝壳、大渐变登录英雄区、emoji 标题墙

## 6. 验收清单（设计侧）

- [ ] Light token 可落到 CSS 变量  
- [ ] 桌面列表+阅读、手机单栏可用  
- [ ] 空收件箱 / 空地址 / 鉴权失败 / 附件超限文案已实现或可配置  
- [ ] 无其它 CF 邮箱项目的标志性布局/配色雷同（人工过一眼）

## 7. 变更记录

- 2026-09-19 v0：首版，供 #3 骨架与后续 UI PR 对齐。
