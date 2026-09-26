# Picumet 实施进度

本文档记录产品范围与实施状态。已完成并写入架构、API、UI、开发指南的功能不再在此重复；这里保留状态跟踪、决策记录、即将与将来的规划。

## 状态标记

| 标记 | 含义 |
| :--- | :--- |
| Done | 已实现、已测试、已验证。 |
| In progress | 已实现；验证或打磨未完成。 |
| Planned | 已列入范围但尚未构建。 |
| Rejected | 明确不在范围内。 |

## 路线图

| 阶段 | 范围 | 状态 |
| :--- | :--- | :--- |
| Phase 1 | 核心平台：认证、文件、配额、角色、存储源、系统设置 | Done |
| Phase 2 | 上传（分片/断点续传）、预览、分享、管理面板、API 密钥、WebDAV、自由模式 | Done |
| Phase 3 | AWS S3、外观主题、管理员登录、公告关闭 | 基本完成；Oracle provider 待实现 |
| Phase 4 | 路径变量 DSL（`{year}/{month}`）、Umami 访问统计、SSO/OIDC 登录、邀请码注册机制 | Planned |
| 未来 | monorepo 双后端：Workers 版 + Go 高性能版（跨桶复制/DR、无配额长任务） | Planned |

## 功能区域

| 区域 | 状态 | 说明 |
| :--- | :--- | :--- |
| 部署：Cloudflare Pages + Workers | Done | Vercel 与 EdgeOne 已拒绝。 |
| 存储提供商 | Done | R2 与 S3 已实现；Oracle 待做；其余 9 家已拒绝。 |
| 文件浏览（卡片/列表/树视图） | Done | `GET /api/files` + `GET /api/files/tree`，排序、搜索、分页、扁平树视图。 |
| 上传（单文件） | Done | 会话制并原子预留配额。 |
| 上传（分片 / 大文件） | Done | 断点续传 + 服务端分片记录。 |
| 硬删除 | Done | 元数据优先事务，对象异步清理。 |
| 重命名 | Done | `PUT /api/files/:id`。 |
| 移动（Saga） | Done | 源删除 + 目标写入权限校验。 |
| 预览：图片 / 视频 / 音频 / 代码 | Done | 图片缩放/旋转；视频 canvas 缩略图；highlight.js 预转义。 |
| 选择与多选 | Done | 网格 + 列表，列表视图支持范围选择。 |
| 拖拽排序与拖拽移动 | In progress | 拖拽移动可用；验证记录待补。 |
| 每文件夹视图记忆 | Done | 存在 `localStorage`。 |
| 属性面板 | Done | 任意尺寸均为右侧 drawer（网格不重排）；标题/颜色/封面/emoji 编辑。 |
| 挂载点视图 + 桶泳道图 | Done | 管理端全部文件挂载点视图与仪表盘泳道图，数据来自 `/api/admin/mount-tree`。 |
| 公告显示策略 | Done | §27 `display_mode`/`interval_seconds`/`kind`；banner 策略 + toast 弹窗。 |
| 复制链接 | Done | 多文件 dialog；直链/HTML/Markdown/BBCode；公开直链或签名 URL。 |
| 分享 | Done | 密码、过期时间、下载次数限制、二维码。 |
| 三级文件可见性 | Done | `private` / `users` / `public`；`public` 需要 `can_publish` 加审核批准；文件夹级联。 |
| 用户自建访问规则 | Done | 针对单个文件为其他用户授予/拒绝 `read`/`download`；需要 `can_grant`；来源排序 admin > user > system。 |
| 能力位 | Done | `can_publish` / `can_share` / `can_grant` 存在 users 上，管理员可编辑，服务端强制。 |
| 公开空间 gallery | Done | 匿名列表 / 下载链接 / 密码验证，仅限过审公开文件；属主与管理员下载免密。 |
| 外观 | Done | 浅色/深色/跟随系统、强调色（HSL + YIQ 前景）、模糊、背景图/URL、文件夹预览开关。纯色背景已移除。 |
| i18n（中 / 英） | Done | |
| 响应式布局 | Done | 桌面/平板/手机；浮动操作栏在 350-1080 px 验证过。 |
| 用户 | Done | 注册、登录、邮箱验证、游客角色、自由模式。 |
| 权限与配额 | Done | 3 角色、路径 ACL、文件/路径密码、存储与文件数配额。下载限速与月度流量配额已拒绝。 |
| 存储配置 | Done | 挂载点、CDN 域名、路径前缀、排序、签名；内容哈希寻址（§F）去重同内容；存储池（§E）跨 provider 摊铺。复制/DR 与路径 DSL 待做。 |
| 存储核心加固 | Done | Range 读取（经统一 `serveObject` 的 206/416）、`ProviderError` 分类、批量删除（每批 ≤1000 + 逐对象回退）、Delimiter 列目录、>5 GB 移动用 `UploadPartCopy`。 |
| Provider 统一 | Done | 类型由 `endpoint` 推导（`r2` / `s3`；`oracle` 并入 `s3`）；迁移 `0005`；`upload_domain` 移除。 |
| 管理端 | Done | 仪表盘、用户、存储、挂载点、规则、分享、文件、日志。访问统计见「即将规划」。 |
| 系统设置 | Done | 站点信息、注册/游客开关。Turnstile 配置已随审计 YAGNI-03 清理移除（从未接线）。 |
| API 密钥 + 兼容协议 | Done | `pk_x.sk_y` 不透明令牌、WebDAV、PicGo/PicList、Lsky Pro V2、AList/OpenList shim、S3 兼容网关（对外中转面）。 |
| 安全 | Done | CSP、CSRF、限流、路径遍历、SSRF、SQL 参数化、原子下载令牌。热文件检测与强制签名 URL planned。 |
| 图片编辑器链接（Squoosh） | Done | |
| 视频/音频播放器 | Done | |

## 已拒绝的决策

| 决策 | 原因 |
| :--- | :--- |
| 回收站 | 移除以避免对象存储与数据库之间的软删除不一致。 |
| 下载限速 / 月度流量配额 | 存储与文件数配额已覆盖需求。 |
| 把 Picumet 用作 S3 存储后端（入站存储面） | 只做对外中转网关（S3 兼容网关已实现，见架构文档与 API 参考的「S3 兼容网关」）；不提供对象存储入站面。 |
| 其余 9 家提供商（B2、IDrive、GCS、COS、OSS、OBS、Scaleway、Filebase、Kodo） | 不在范围内。 |
| 客户端加密 | 不做；敏感路径链接改用签名 URL。 |
| Vercel / EdgeOne 托管 | 只用 Cloudflare。 |
| 登录失败退避与账户锁定 | 认证类端点的 IP 限流（生产 fail-closed）已覆盖；不做账户锁定。 |
| Refresh token 双令牌 | 单 JWT（7 天 HttpOnly Cookie）+ `session_version` 撤销已覆盖同一需求。 |
| 找回密码按邮箱限流（每小时 3 次） | 复用通用速率限制；重置令牌 15 分钟有效且一次性消费。 |
| 文件版本控制 | 早期产品评审明确不做；版本历史交由对象存储侧能力承担。 |
| URL 元信息抓取 | 早期产品评审明确不做。 |
| 自定义文件别名 / 短链 | 早期产品评审明确不做；现有短链是分享生成的 `shortCode` 与 `/i/:id` 图床短链，非用户自定义别名。 |

## 安全审计闭环

每个修复都有回归测试锁住。见 `workers/tests/security-regressions.test.ts`、`workers/tests/s3-provider.test.ts`、`frontend/src/lib/escape.test.ts` 与 `frontend/src/pages/Register.test.tsx`。

| 风险 | 修复 | 证据 |
| :--- | :--- | :--- |
| 自由模式凭据明文存 KV（高危） | AES-256-GCM 加密 + 短 TTL、随机 `sid` Cookie、IP 绑定 | 加密/解密/篡改用例 |
| API 密钥 IP 白名单未强制（高危） | `apiKeyAuthMiddleware` 对非白名单 IP 返回 `403` | 白名单内/外用例 |
| 分片恒为空、无断点续传契约（高危） | 服务端 `parts_completed`、`GET /parts` 续传契约、跳过合并前 HEAD | 续传流程：缺口 → 拒绝 → 完成 |
| `/register` 缺失、忘记密码为占位（高危） | 独立 `/register` 与 `/reset-password` 页面调用真实 API | 注册提交/失败用例 |
| 下载令牌非原子消费（中危） | KV 的 get→delete 换成原子 `DELETE ... RETURNING` | 单次消费与重复 401 用例 |
| 限流 fail-open（中危） | 认证/敏感写端点在 KV 故障时 fail-closed（`503`） | 生产环境 KV 故障用例 |
| S3/Oracle provider 测试 + 能力矩阵（中危） | 预签名分片 URL 单元测试（本地签名）；Oracle 待做 | S3 provider 用例 |
| highlight.js 转义 + 前端回归（中危） | `escapeHtml` 预转义作纵深防御 | 转义用例 |
| CI/CD + 覆盖率门禁（中危） | `.github/workflows/ci.yml`（bun，仅 CI）、前端覆盖率门禁、路由懒加载 | 覆盖率行 100% |

### 2026-09-26 代码审计修复批次（`docs/CODE_AUDIT_REPORT.md`）

全量修复报告 P0/P1/P2 项（SMTP/SEC-05 按决策暂缓）。安全审计闭环：

| 发现 | 修复 | 证据 |
| :--- | :--- | :--- |
| SEC-01 跨挂载点移动文件夹子树滞留源挂载点（高危） | `moveWithSaga` 阻断跨挂载文件夹移动（422）；清扫任务自愈存量孤儿子树（跳过嵌套挂载行）后再对账容量 | `move-cross-mount.test.ts`、`upload-resume.test.ts` |
| SEC-02 更新 Provider 绕过 endpoint SSRF 校验（高危） | 更新路径复用 `validateEndpoint`（空串切回绑定放行） | `admin-provider-update.test.ts` |
| SEC-03 IP 解析信任可伪造 XFF 首段（高危） | 统一 `utils/ip.ts`（cf.connectingIp → CF-Connecting-IP → X-Real-IP → XFF 受控回退），全部调用点迁移 | `api-key-ip.test.ts` 伪造头用例 |
| SEC-04 分享出口绕过文件级密码（高危） | 分享令牌不再由分享密码推导 passwordVerified；新增 `POST /shares/:id/verify-file`（cookie+KV 按文件记录）；预览/网关按文件当前 accessPassword 复核 | `share-file-password.test.ts` |
| SEC-05 SMTP 未启用 TLS 且 connect 未导入（高危） | **暂缓**（用户决策，SMTP 未配置） | — |
| SEC-06 AList 登录缺协议面授权（中危） | 登录 + 全部 fs/* 统一 `assertApiKeyProtocol(api, 'api')` | `alist.test.ts` 协议矩阵 |
| SEC-07 站点资源中转重定向未复核（中危） | `redirect: manual` 逐跳 validateEndpoint，≤3 跳 | `site-asset.test.ts` |
| SEC-08 生产错误响应泄露内部异常（中危） | 非 ApiError 生产环境固定「服务器内部错误」+ 服务端日志留痕 | `error-response.test.ts` |
| SEC-09 SigV4 整包校验无上限且重复哈希（中危） | 签名载荷 100 MiB 上限（读前按 content-length 拒绝）；payload 哈希复用 | `s3gw.test.ts` |
| SEC-10 verify-password 绕过权限初检（中危） | 密码校验前执行 download 权限判定（显式 conditions：真实 IP + passwordVerified） | `share-password.test.ts` |
| SEC-11 上传异常预留滞留（中危） | 失败路径统一释放三层预留 + 标 `aborted`；清扫回收 verifying/failed 过期会话；预留对账自愈 | `upload-resume.test.ts` |
| SEC-12 publicDomain 不拒私网（低危） | httpsUrl 增加 isPrivateHost 校验（localhost 豁免） | `admin-provider-update.test.ts` |
| DESIGN-01 权限条件接口未接入 | 删除 `getConditions`/`checkPasswordProtection` 死代码；规则创建面移除条件字段；存量行 fail-closed 契约测试 | `permission.test.ts` |
| DESIGN-02 分享创建/配额对账 N+1 | 批量 IN 查询 + GROUP BY 聚合 + 预留自愈 | 各任务单测 |
| DESIGN-03 I/O 超时分散 | 前端 apiFetch 默认 30s、上传暂停真实中止；S3 控制面 15s 超时（SMTP 部分随 SEC-05 暂缓） | — |
| DESIGN-04/05/06 前端 | 下载统一 apiFetch；代码预览 2 MiB 上限；预览 URL 缓存 10 分钟 TTL | — |
| YAGNI-01..04 | 死代码删除（useFolderOptions/getProviderCfg/toFileListItem 二次导出）；公告撤回接入后端 + 前端同步；inviteCode/Turnstile 全链路移除；coverUrl/manualPosition 文档标注预留契约 | `announcement-dismiss.test.ts` |

## 当前基线

- 后端：51 个测试文件 / 486 个 Vitest 用例通过；`tsc --noEmit` 干净。（2026-09-26 审计修复批次自 46/452 起新增 5 个回归测试文件）
- 前端：4 个测试文件 / 27 个 Vitest 用例通过；覆盖率门禁通过（92% statements / 75% branches / 83.3% functions / 93.3% lines）；构建成功；`tsc --noEmit` 干净。
- 语言：中文 + 英文。

## 即将规划

近期待办总览：Oracle Cloud provider 实现、路径变量 DSL（`{year}/{month}`）、热文件检测与强制签名 URL、拖拽交互与属性面板编辑的持续验证记录，以及下面三项新规划。

### Umami 访问统计（审计来源二选一）

接入 Umami（自托管或 Umami Cloud）统计站点访问与下载行为；访问统计来源在 D1 审计与 Umami 之间二选一。

- 管理端系统设置新增 Umami 配置：脚本地址、`data-website-id`、启用开关；前端按配置注入 tracker（`<script defer src=… data-website-id=…>`），脚本可配 `data-host-url` 上报地址与 `data-domains` 域名白名单。
- SPA 开箱即用：tracker 自动监听 History API（`pushState`/`replaceState`/`popstate`）记录路由切换 pageview，无需手动打点页面浏览，也避免双重计数。
- 事件上报：文件下载、复制链接等交互用 `umami.track(event, data)` 或 `data-umami-event` 属性上报；事件名上限 50 字符。下载按钮携带文件名/大小等事件数据，使文件下载链接的访问进入统计。
- 审计来源二选一：站点级设置选择 D1 `access_logs`（网关侧逐次日志，仅覆盖 `private_gateway` 流量）或 Umami（前端行为统计）；两者互斥，避免双写双计。
- 边界：`public_cdn` 直链的外部热链访问（如外链图片）不经过页面，JS 无法统计——这类流量仍依赖网关审计或未来的热文件检测。
- CSP 联动：启用后 CSP 的 `script-src` / `connect-src` 需放行 Umami 域。

### SSO / OIDC 登录

支持第三方身份登录：GitHub、Google 与自托管 OIDC 提供商（authentik、logto、casdoor）。

- 通用 OIDC 提供商走 authorization code + `state`（支持 PKCE），经 `/.well-known/openid-configuration` discovery 与 JWKS 验签 `id_token`，覆盖 Google 与自托管三家；管理端按提供商配置 issuer、client id/secret 与启用开关。
- GitHub 特例：GitHub 的 OAuth 流程不签发 `id_token`（官方 discovery 文档仅面向 MCP 客户端），因此 GitHub 走 OAuth2 web application flow，回调后用 access token 请求 `/user` 与 `/user/emails`，取 primary 且 verified 的邮箱。
- 账号关联：邮箱一致自动关联既有账号；不一致时按注册开关决定自动注册或拒绝。
- 登录态与本地账号一致：发放同一 JWT（HttpOnly Cookie），沿用 `session_version` 撤销。
- 前端：登录/注册页新增「使用 … 继续」按钮与回调路由，处理错误态并补齐 i18n 文案。

### 邀请码注册机制

在开放注册之上叠加受邀注册：管理员在系统设置控制开关与生成权限，用户在个性化设置生成并管理自己的邀请码、查看受邀记录。

- 管理端系统设置新建「注册设置」分组：把现有「开放注册」「允许访客」两个开关从安全设置挪入，并新增四个设置项——是否开启邀请码、开启后邀请码是否必填（必填 = 无码不可注册）、生成权限（全部用户 / 仅管理员）、用户最大邀请码生成数量（默认 5）。
- 码值格式：6 位数字 + 大小写字母（`[0-9A-Za-z]{6}`，约 5.7×10^10 组合），crypto 随机生成，唯一约束 + 碰撞重试，匹配区分大小写。
- 数据模型：新迁移建 `invite_codes` 表（码值、名称、创建人、创建时间）与核销关联（`users.invited_by_code_id` 或独立核销表）；一个邀请码可被多人使用，按码聚合展示受邀用户；本次不做使用上限与过期。
- 用户端：个性化设置「修改密码」下方新增邀请码区块，仅对有生成权限的用户显示——点击开启后批量生成多个邀请码，累计数量不超过「用户最大邀请码生成数量」（默认 5），每个邀请码可设置名称、可见创建时间，并可查看受邀用户的用户名、所用邀请码与注册时间（YYYYMMDD）。
- 注册链路：开启且必填时注册表单展示邀请码输入（复用既有 i18n key），非必填时选填；校验在注册 handler 内完成，格式不符、码无效或未开启返回明确错误码；核销与建号在同一事务内原子完成，防并发重复核销。
- 契约闭环：注册 schema 曾长期接受 `inviteCode` 但从未消费，该预留字段已按审计 YAGNI-03 于 2026-09-26 从 `RegisterSchema`/`shared/types.ts` 删除（连同 Turnstile 残留）；本机制落地时随实现重新引入字段与校验，不再「先收下、后接线」。
- API：用户端 `POST /api/invites`（批量生成）与 `GET /api/invites`（自己的码与受邀记录）；管理端四个设置项走既有 `PATCH /api/admin/settings`；注册校验复用既有注册限流。
- 测试：注册门控（关闭 / 开启必填无码 / 格式不符 / 错码 / 有效码）、生成权限矩阵（全部用户 / 仅管理员 × 管理员 / 普通用户）、生成数量上限（达到上限后拒绝）、核销原子性。
- 文档联动：API 参考补端点与错误码；UI 指南补注册页输入与个性化设置区块（落地前，UI 指南「注册收集可选邀请码」的说法仍与代码不符）。

## 将来规划（monorepo：Workers 版 + Go 高性能版）

仓库以 monorepo 形态维护两个后端：Workers 版（现状默认）与 Go 高性能版。移植遵循契约冻结：API 路径、响应形状、错误码、Cookie 语义原样移植，前端只改 CORS origin——把约 2.2 万行前端完全排除在风险外。

R2 的去留是独立的政策决策：R2 本身讲 S3 协议，可当作普通 S3 endpoint 保留（后端不再依赖 CF 绑定）；要绝对零 CF 时把 provider 指向 AWS S3/MinIO 即可，对象不用搬，前端 Pages 同理可留可走。

### 运行时与依赖映射

| Cloudflare 依赖 | 替代 | 说明 |
| :--- | :--- | :--- |
| D1（SQLite 元数据） | PostgreSQL | 11 个 repo、SQLite 方言 SQL 逐条移植。 |
| KV（CSRF/限流/OTP/自由模式/`serve:loc`/`pool:down`/seed） | Redis | 现用法全是简单 get/set + TTL，Redis 是天然落点。 |
| R2 绑定（`R2BindingProvider`） | S3 provider | 代码已有 `S3Provider`；R2 本身讲 S3 协议，可当普通 endpoint 保留。 |
| `*/10 * * * *` Cron（预留释放/blob GC/对账/分享过期/挂载自愈） | Go 内置 ticker + Redis 分布式锁 | 任务按设计幂等（自愈式），重复执行安全。 |
| `ctx.waitUntil` / `scheduled` 后台语义 | goroutine + 生命周期管理 | 显式处理优雅退出/信号。 |
| WHATWG 流/Range/分片 | `io.Reader`/`io.Writer` + `aws-sdk-go-v2` | multipart、`UploadPartCopy`、Range 全有现成 SDK。 |
| bcryptjs（CPU 配额焦虑） | argon2id | OWASP 当前首选；无 Workers 10ms CPU 限制后可放心用。 |
| SMTP/加密/预签名 | 不变 | 已有外部实现或 Go 等价物（jose→golang-jwt，AES-GCM 标准库）。 |

### 高性能版本实际买到什么

- CPU：Workers Free 10ms/请求、Paid 默认 30s（上限 5 分钟）→ 无配额，argon2id 与加解密不再受 CPU 限制；免费版 bcrypt 10 轮约 80ms 直接超限是已知痛点。
- 请求体：Workers 免费/Pro 单请求 100MB 上限，大文件上传触发 503 内存溢出 → Go 无限流式。
- 并发：Workers 单 isolate 128MB、单请求 6 连接 → Go 全并发 + 连接池。
- 冷启动：Workers 启动上限 1s → 常驻进程。
- 数据库：D1 单库 10GB、无行锁与真事务语义 → PG 行级锁、事务、JSONB、EXPLAIN、分区。
- 解锁能力：跨桶同步/镜像（§E/§G 预留的旗舰功能）、长任务、真后台作业。
- 可观测：pprof、slog、Prometheus——Workers 上没有的完整工具链。

### 移植原则

1. 契约冻结，前端零改动：API 路径、响应形状、错误码、Cookie 语义原样移植，前端只改 CORS origin。
2. 权限引擎按测试等价移植：10 步判定链 + 桶级/挂载级角色矩阵 + 合成游客规则，逐条对照 `bucket-role-matrix.test.ts`（653 行）与 `mount-role-matrix.test.ts`（541 行），判定逻辑零漂移；这些测试是安全网。
3. 数据迁移走双轨：KV 瞬态数据直接丢弃重建；D1 经 `wrangler d1 export` → pgloader 或自定义 ETL 进 PG；对象留在桶内（S3 API 照常访问）。迁移期 Hertz 与 Workers 并行跑，代理层切流，失败可回滚。
4. R2 去留是唯一的政策决策：R2 可保留为 S3 endpoint；绝对零 CF 则改指 AWS S3/MinIO，对象不用搬。
5. Redis 用法升级：现 KV 限流是读-改-写，Go 端改原子 `INCR` + `EXPIRE` 或固定窗口 Lua，多实例才正确；`pool:down` 熔断、`serve:loc` 提示、自由模式会话、全部 OTP/token 都是 TTL 型，落 Redis 零压力。
6. 调度器单体内置：一个 ticker goroutine + Redis `SET NX EX` 选主锁，多实例部署安全；任务本就幂等，重复执行无害；pg_cron 是备选。
7. 并发正确性是 Go 端最隐蔽的坑：Workers 单 isolate 单线程，Go 全并发——请求作用域状态（如 `principal.ts` 的按请求缓存）风险低，但熔断器与任何模块级缓存必须 mutex/atomic 或下沉 Redis，全程跑 `-race`。
8. 大包流式走标准库网络栈：Hertz 官方建议 >1MB 请求用 go net 而非 netpoll（LT 模型大包吃内存）；下载网关/WebDAV/代理上传用 `standard.NewTransporter` + `SetBodyStream(-1)` chunked，避开隐式关闭坑（hertz#1309）。
9. 运维成本单列一期：Docker Compose（app + PG + Redis）、Caddy/Traefik 自动 TLS、pg_dump/WAL 备份、pgbouncer、监控告警；买的是性能与自主，必须规划运维。
10. 性能基线先立后比：移植前在 Workers 上跑一轮基线留档（AGENTS.md 现成：文件列表 P50<200ms 等），Go 版上线后同场景复测——高性能要用数据证明。

### 同路径多存储备份 / DR

现状：`mount_providers` 把每个对象在成员间摊铺——每文件一份。读取已在成员间容灾（§G），但没有复制时桶丢失即其对象丢失。同路径的两个挂载点不会合并：`MountRepo.findMountForPath` 按优先级再深度取一个，只有第一个挂载点会服务该路径。

| 条目 | 决策 | 目标 |
| :--- | :--- | :--- |
| 同路径多存储备份 / DR | 同路径多挂载变为复制（镜像），而非摊铺 | Go 高性能版 |

规划的管理面：管理存储页上每个挂载一个**「自动跨桶同步」**开关。该开关只在 Go 高性能版可用；Workers 版不实现该能力，控件文档约定为环境门控、必须渲染为禁用（而非隐藏）。池化（§E）与读容灾（§G）今天即可用——开关只打开后台复制。

- 目标模型：`file_replicas(file_id, provider_id, etag, size, status, verified_at)`，`file_metadata.provider_id` 保留为主副本。写扇出（主同步、副本异步经队列）、读容灾、逐副本删除与 GC、校验/修复任务。
- 可借鉴的先例：rclone 的 `union` 后端（`create_policy=all` 镜像写每个上游、`epmfs`/`lus` 摊铺、`:ro`/`:nc`/`:writeback` 标签）、MinIO site replication（active-active / active-passive，异步扫描器重排队失败对象）、SeaweedFS 机架/DC 感知放置。
- 为什么不是一个开关：
  - 无跨 provider 事务或原子 CAS：部分副本写入需要补偿/修复任务，没有 generation/ETag 校验时并发覆盖会分叉。
  - 容灾读可能服务陈旧副本；严格新鲜度要为每次读付一次 HEAD。
  - 预签名/直链绑定单一 provider 域名（`buildFileAccessUrl`）；切换副本会让链接失效，除非所有链接都走一个代理域名（R2 Worker 出口免费；S3/Oracle 会产生 Worker 出口费）。
  - 分片上传必须把每个分片写到每个副本，或事后重传（CopyObject 实践上仅同 provider）。
  - N× 物理存储成本；`least_used` 之类的池启发式对镜像挂载毫无意义（每个成员都需要完整数据集）。
- 首选的平台级路径：provider 侧复制（R2 的持久性来自复制 + 纠删码；可用处启用桶复制/版本化）加既有对账任务；应用层扇出属于 Go 高性能版，那里写路径允许优化（流式多写、校验和）。

## 原始规格残留（2026-09-25 审计）

对照原始规格与代码的缺口审计（`docs/SPEC_DOC_GAP_REPORT.md`）确认以下设想未落地。记录在此避免读者按旧规格寻找不存在的实现；判定口径以实际代码为准。

| 条目 | 现状与说明 |
| :--- | :--- |
| JWT 多密钥轮换（`JWT_SECRETS` 新签旧验） | 未实现。密钥泄露的替代手段：`users.session_version` 递增撤销旧 JWT + 更换密钥。 |
| 找回密码按邮箱限流（每小时 3 次） | 未实现。复用通用速率限制；重置令牌 15 分钟有效、一次性消费。 |
| 路径变量模式（`/users/:userId/*`）与扩展名模式（`/images/*.{jpg,png}`） | 不支持。`pathMatches` 只实现精确、`/*` 与 `/**`，含 `:` 的模式恒不匹配——权限规则只支持这两种通配。`utils/path.ts` 的 `matchPriority` 是零引用残留，排序实际由 `permissions/check.ts` 的 `sortRules` 完成。 |
| 对账报告审核与清理闭环 | 写入侧真实（删除/覆盖/移动/内容寻址失败都会写 `orphan_objects`）；`reconciliation_reports` 的 `createReport` / `listReports` 与孤儿列表查询零调用方，无管理端点与界面——表与仓库方法为预留，暂未接线。 |
| 日志脱敏 `sanitizeForLog` | 残留：`shared/errors.ts` 实现了敏感键替换（`***REDACTED***`）但零调用方，当前没有任何日志走脱敏；接线或删除之前不要当成现存行为。 |
| 热文件检测与强制签名 URL | 原始规格设想未落地；保留在「即将规划」（planned），不是已完成行为。 |

按当前实现重写的访问模式对比（原始规格的三模式表不成立——`decideAccessMode` 永不返回 `signed_redirect`，现实只有两态；详见架构文档「分享服务」）：

| 维度 | `public_cdn` | `private_gateway` |
| :--- | :--- | :--- |
| 条件 | provider 配置了公网直链域名且文件无密码 | 其余所有情况 |
| 实时权限检查 | 发链接时判定，之后不再校验 | 每次下载经网关与权限判定 |
| 流量与计费 | provider / CDN 出口 | Workers 出口（R2 免费，S3/Oracle 计费） |
| 限速与并发 | 不经过 Picumet，无法限速 | 受下载限速与传输并发约束 |
| 撤销 | 对象删除/改名或改 publicDomain 前链接一直可用 | 令牌一次性、15 分钟有效 |
| 统计 | 无逐次日志（Umami 接入后由前端事件覆盖页面内行为） | 网关写 `access_logs` 并计数 |

相关指南：[架构](ARCHITECTURE_CN.md)、[API 参考](API_CN.md)、[前端指南](UI_CN.md)、[开发指南](DEVELOPMENT_CN.md)、[部署指南](DEPLOYMENT_CN.md)。
