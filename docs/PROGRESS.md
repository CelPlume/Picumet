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
| Phase 4 | 路径变量 DSL（`{year}/{month}`）、Umami 访问统计、SSO/OIDC 登录、邀请码注册机制、Cloudflare Turnstile 人机验证 | Planned |
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
| 系统设置 | Done | 站点信息、注册/游客开关。Turnstile 配置已随审计 YAGNI-03 清理移除（从未接线）；完整重实现方案见「即将规划」。 |
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

### 2026-09-26 存储拓扑与访问控制专项审计修复批次（`docs/STORAGE_TOPOLOGY_AUDIT.md` / `docs/ACCESS_CONTROL_AUDIT.md`）

两份专项审计的 P0/P1/P2 全部落地（含少量明确记录的残余项）。存储拓扑：

| 发现 | 修复 | 证据 |
| :--- | :--- | :--- |
| TOP-01/02 挂载路径冲突/优先级遮蔽无校验（高） | 创建/更新/一步创建统一 `assertMountPlacement`：同路径 400；嵌套不变量「祖先 priority <= 后代」（等值合法，省略 priority 继承祖先最大值）；被父挂载数据覆盖的路径 409；`findMountForPath` 平局按 created_at/id 稳定决胜 | `mount-placement.test.ts` |
| TOP-03 挂载目录行复用/误删（高） | 挂载点目录行固定身份 `mountfolder:<mountId>`，创建冲突 409（后台自愈容错跳过），删除只按身份（存量复用行不再回收） | `mount-folders.test.ts` |
| TOP-07 Provider 删除引用悬空（高） | 事务内全引用检查（mounts/members/files/sessions/blob/blob_gc/bucket 矩阵）409 + 迁移 0006 把成员/矩阵外键改 RESTRICT | `provider-lifecycle.test.ts` |
| TOP-08 成员移除无检查（中高） | 移除前校验该成员下文件与在途会话 → 409；落桶 Provider 缺失改为 `PROVIDER_MISSING` 诊断错误不再静默换桶 | `provider-lifecycle.test.ts` |
| TOP-16 无根拓扑不可用（高） | **合成根**：无覆盖 `/` 的挂载时，文件页/树、公开浏览、AList fs/list、WebDAV PROPFIND 聚合顶层挂载为虚拟目录（逐挂载 read 门禁；虚拟项 `vroot:` 不可分享/移动/删除，前端全入口门禁；根路径上传 404） | `api-files.test.ts`、`root-view.test.ts`、`public-root.test.ts` |
| TOP-05/14 回退不复查桶级矩阵 / MOVE 旁路矩阵（中高） | failover 每个候选桶按 principalRole 复核挂载级+桶级矩阵（全拒 403）；网关/兼容/分享预览补挂载级矩阵；MOVE/改名改走完整 `requirePermission`（源 delete + 目标 write 含落桶）；S3 LIST 逐文件桶级过滤 | `storage-failover.test.ts`、`move-permission.test.ts` |
| TOP-10 全局内容寻址跨挂载耦合（中高） | 去重收敛到同一挂载（`blob_objects` 复合主键 (hash, mount_id)，迁移 0007）；GC 引用检查保持全局保守；跨挂载同内容各写一份 | `blob-scope.test.ts` |
| TOP-11 挂载 CRUD 多步落库/成员替换丢预留（中） | 配置变更单事务；成员改差异化 UPSERT（保留 quota_reserved）；对账新增**成员级**预留重算 | `provider-lifecycle.test.ts`、`upload-resume.test.ts` |
| TOP-04 单点 DELETE 路径基准粗（中） | 单点/批量/remove.ts 全部改用文件全路径基准 | `delete-quota.test.ts` |
| TOP-12 目录删除按单一属主扣配额（中低） | operations.ts 与 remove.ts 均按子树 `owner_id` 分组扣减，挂载总量单独扣 | `delete-quota.test.ts`、`delete-path-hardening.test.ts` |
| TOP-09 候选上限与 schema 不一致（中低） | `MAX_CANDIDATES` 4 → 20（与成员上限对齐） | `storage-failover.test.ts` |
| TOP-06 副桶 size-only 校验（中） | 内容键直写随对象 metadata 写 `sha256`，回退命中时比对 hash（缺失回退 size）；候选命中/校验失败记日志。残余：暂存→copy 路径无 hash 元数据 | `storage-failover.test.ts` |
| TOP-15 删用户遗留传统路径键对象（低中） | 删除前事务内登记 `orphan_objects`（reason=user_deleted）+ 定时队列重试清理 | `orphan-queue.test.ts` |
| TOP-13 回退桶改变公开性（中） | 池成员 `publicDomain` 保存时全有/全无校验（400）+ 部署文档明示 public_cdn 语义 + 配置界面警示 | `provider-lifecycle.test.ts` |

访问控制：

| 发现 | 修复 | 证据 |
| :--- | :--- | :--- |
| PERM-01 注册即全库全权（高） | 新用户 defaultPath 继承 `role_defaults.default_path`（显式 > 角色默认 > `/`）；默认种子保持 `/`；隔离模式的可见性/写入边界语义与角色设置对新用户生效已入文档 | `user-default-path.test.ts` |
| PERM-10 移动/改名绕过两级矩阵（高） | 见 TOP-05/14 | `move-permission.test.ts` |
| PERM-02 列表/树可见性不一致（中） | 列表与树统一 §4.4a：非 owner/admin 隐藏 private 文件与文件夹（`listChildren` 支持 viewerId 过滤） | `api-files.test.ts` |
| PERM-08 树不复核子目录规则（低） | 树逐目录行以纯函数复核 read，deny 子树连后代隐藏（预加载规则/矩阵，无 N+1 查询） | `api-files.test.ts` |
| PERM-07 级联/前缀 LIKE 未转义（中） | `escapeLikePattern` + `ESCAPE '\'` 扫全仓（级联、move、删除、listDescendants、管理端级联等）；模糊搜索类 LIKE 保持原样并记录 | `api-files.test.ts`、`move-permission.test.ts`、`delete-path-hardening.test.ts` |
| PERM-11 分享创建权限基准父目录（中） | 改文件全路径基准 | `share-file-password.test.ts` 等 |
| PERM-04 AList 直链缺封禁门禁（低中） | `handleDirectLink` 补 `assertNotBanned` | `alist.test.ts` |
| PERM-05 晚绑定出口缺挂载级矩阵（低） | `mountMatrixDecision`/`assertMountMatrixPermission`；网关/兼容/分享预览补判 | `gateway-compat.test.ts` |
| PERM-06 公开列表不滤封禁（低） | gallery 与公开目录列表过滤封禁行 | `public-root.test.ts` |
| PERM-03 public_cdn 配置即匿名公开（中） | 配置界面警示 + 部署文档明示（CDN 直读绕过权限面）；池公有性一致性校验 | `admin.storage` 提示 + docs |
| PERM-09/12/13 语义文档化 | 架构文档补：可见性/游客语义、属主回退与用户规则先于矩阵、匿名无第 9 步兜底 | docs/ARCHITECTURE(_CN) |

### 2026-09-26 全量代码与架构审计修复批次（`docs/FULL_AUDIT_REPORT_2026-09-26.md`）

报告新增发现（SEC-NEW-01..08、D-1..7、DESIGN-NEW-01..07、R-1..5）的代码类修复全部落地。记录项（不做）：SEC-NEW-04 自由模式临时主体回收、DESIGN-NEW-03 multipart 不经内容寻址（边界已写入架构/API 文档）、R-2 round-robin 计数器非原子（调度公平性）、DESIGN-NEW-05（不引入 Web Locks）。

| 发现 | 修复 | 证据 |
| :--- | :--- | :--- |
| SEC-NEW-01 Web multipart 上传断裂（中） | 前端消费 `parts`：预签名分片逐片 PUT 收集 ETag、Worker 模式逐片调用分片端点（补发此前取到但未发送的 CSRF），完成后端按「服务端记录 → 客户端上报 → 桶 `ListParts`」取信；跨源预签名不再带 credentials | `UploadModal.test.tsx`、`upload-resume.test.ts` |
| SEC-NEW-02 Provider 物理定位漂移（中） | `PUT /storage/providers/:id` 对 bucket/endpoint/region/pathPrefix 变更做物理引用检查（文件/在途会话/blob 索引/GC）→ 409；名称/公开域名/密钥放行 | `provider-drift-guards.test.ts` |
| D-1 跨挂载移动绕过挂载上限（高） | 目标挂载 `max_storage` 与成员容量同时持有预留（条件 UPDATE），提交事务内转已用，失败/补偿释放；不足 413 | `move-capacity-guards.test.ts` |
| D-2 移动目标漏查文件夹（中） | 目标冲突文件行 + 目录行双检 → 409 | `move-capacity-guards.test.ts` |
| D-3 blob 跨挂载移动撕裂物理归属（中） | 两侧权限通过后拒绝 blob 跨挂载移动（422）并释放成员预留 | `move-capacity-guards.test.ts` |
| D-4 Move 属主契约矛盾（中） | 统一「属主不变」：目标 user_space 按 `file.ownerId` 判定（移入他人空间 403） | `move-capacity-guards.test.ts` |
| D-5 过期分片会话不 abort（中） | 过期清扫终止 Provider multipart upload，失败登记带 `upload_id` 的清理队列（`cleanupMultipartAborts` 重试）；显式中止失败同样入队 | `upload-lifecycle-fixes.test.ts` |
| D-6 挂载删除 TOCTOU（低中） | 引用检查与删除收敛为一条条件 DELETE（无文件且无在途会话），竞争 409 | `provider-drift-guards.test.ts` |
| D-7 目录重命名只改主行（中） | 同一事务迁移整棵子树（`escapeLikePattern` + `ESCAPE '\'`）、目录行冲突双检、含嵌套挂载点拒绝；顺带修复文件改名 `path` 被写成自身全路径的既有缺陷 | `folder-rename.test.ts` |
| DESIGN-NEW-01 blob_gc 单 hash 键（低中） | 迁移 0008 重建为 `(hash, mount_id)` 复合键（存量回填），索引/回收/对账全链路按复合键 | `blob-scope.test.ts`、`content-addressing.test.ts` |
| DESIGN-NEW-02 成员对账遗漏直写预留（低） | 新增 `quota_reservations` 台账（write.ts / 跨挂载移动登记，释放/落账删除），对账合并「在途会话 + 台账」并清理 TTL 滞留行 | `quota-ledger.test.ts` |
| DESIGN-NEW-04 Tooltip 缺碰撞处理（低） | Portal 到 body + fixed 定位 + 视口翻转/夹紧 + 20rem 折行，箭头跟随锚点 | 浏览器多场景实测（子代理） |
| DESIGN-NEW-06 upload-complete 竞态（中） | 条件 UPDATE 原子领取（`complete_claimed_at`），仅赢家合并/提交；失败释放领取、崩溃领取 5 分钟后可接管 | `upload-lifecycle-fixes.test.ts` |
| DESIGN-NEW-07 审计日志宽行/OFFSET/无保留（低） | 迁移 0009 补 `(created_at,id)`、`(action,created_at,id)` 索引并删除左前缀重复单列索引；管理列表显式列 + 游标分页（去 COUNT）；整小时窗口导出 NDJSON.gz 到 R2（`AUDIT_BUCKET`）+ manifest/rollup 同批落库 + 分批清理（未配置冷层只读不删）；归档清单/下载端点（读取记事件）；趋势合并热表 + rollup | `audit-tiering.test.ts` |
| R-1 flat 上传静默建目录（低） | flat 模式上传到需要新建祖先目录的路径 → 403 | `upload-mode.test.ts` |
| R-3 移动事务内用外层句柄读（低） | 容量转移所需大小在事务外读取一次，事务内只写 | `move-capacity-guards.test.ts` |
| R-4 `MountQuotaRepo.transferUsage` 死代码 | 删除；转移语义收敛到移动提交事务（预留 → 已用） | 代码审阅 |
| R-5 failover hint 可能脱池（信息） | 采纳提示前校验 provider 属目标挂载池（或文件当前落桶） | `storage-failover.test.ts` |
| SEC-NEW-05 分享验证限流偏宽（中） | 生产环境按 IP + 分享 5 次/分钟；连续 9 次失败进入 10 分钟冷却，成功清零（文件级同规则，按分享+文件计失败） | `security-harden.test.ts` |
| SEC-NEW-06 AList 永久路径签名（低中） | `fs/get` 签名改为 24 小时 TTL（过期 403） | `security-harden.test.ts` |
| SEC-NEW-07 S3 `UNSIGNED-PAYLOAD` 无大小策略（低中） | 强制可信 `Content-Length` 且 ≤100 MiB（超限 400、缺失 411），不再无界 `arrayBuffer` | `security-harden.test.ts` |
| SEC-NEW-08 注册 OTP 非 CSPRNG（低） | `crypto.getRandomValues` 拒绝采样生成 6 位码，TTL/一次性/限流不变 | `security-harden.test.ts` |

## 当前基线

- 后端：68 个测试文件 / 583 个 Vitest 用例通过；`tsc --noEmit` 干净。（2026-09-26 全量审计批次新增 5 个回归测试文件）
- 前端：7 个测试文件 / 43 个 Vitest 用例通过；覆盖率门禁通过（92% statements / 75% branches / 83.3% functions / 93.3% lines）；构建成功；`tsc --noEmit` 干净。
- 语言：中文 + 英文。

## 即将规划

近期待办总览：Oracle Cloud provider 实现、路径变量 DSL（`{year}/{month}`）、热文件检测与强制签名 URL、拖拽交互与属性面板编辑的持续验证记录，以及下面四项新规划。

### Umami 访问统计（审计来源二选一）

接入 Umami（自托管或 Umami Cloud）统计站点访问与下载行为；访问统计来源在 D1 审计与 Umami 之间二选一。

- 管理端系统设置新增 Umami 配置：脚本地址、`data-website-id`、启用开关；前端按配置注入 tracker（`<script defer src=… data-website-id=…>`），脚本可配 `data-host-url` 上报地址与 `data-domains` 域名白名单。**拼装与信任边界（专项）**：脚本地址按官方语义即「站点自己的实例」（自托管 `https://<instance>/script.js`，采集端点 `<instance>/api/send`；Umami Cloud 为 `https://cloud.umami.is/script.js`）——它是本项目**唯一的可配置脚本执行面**，写入口按安全敏感设置对待：仅管理员可改 + 审计日志 + URL 校验（仅 `http(s):`、无内嵌凭据、无 fragment、长度上限；loopback http 仅本地联调）、`data-website-id` 按 UUID 校验、`data-domains` 逐项 hostname 校验；只支持白名单 data-* 属性（website-id / host-url / domains / performance / exclude-search / do-not-track；`data-before-send` 指向全局函数名，不支持）；注入一律 `document.createElement('script')` + `setAttribute`，禁止 HTML 字符串拼接（`dangerouslySetInnerHTML` 项目本就禁用）。
- SPA 开箱即用：tracker 自动监听 History API（`pushState`/`replaceState`/`popstate`）记录路由切换 pageview，无需手动打点页面浏览，也避免双重计数。
- 事件上报：文件下载、复制链接等交互用 `umami.track(event, data)` 或 `data-umami-event` 属性上报；事件名上限 50 字符。下载按钮携带文件名/大小等事件数据，使文件下载链接的访问进入统计。
- 审计来源二选一：站点级设置选择 D1 `access_logs`（网关侧逐次日志，仅覆盖 `private_gateway` 流量）或 Umami（前端行为统计）；两者互斥，避免双写双计。
- 边界：`public_cdn` 直链的外部热链访问（如外链图片）不经过页面，JS 无法统计——这类流量仍依赖网关审计或未来的热文件检测。
- CSP 联动（事实核对）：SPA 由 Pages 承载、仓库无 `_headers`/meta CSP——**页面当前没有 CSP**，Worker 的 CSP 只管 Worker 响应，故 tracker 无需放行即可工作；将来若给 Pages 加 CSP，动态实例域需方案（首方代理 `script.js` + `data-host-url` 指回真实实例——官方文档「bypass ad blockers」即此法，或 `script-src https:` 粗放放行），记为待决项而非默认放行。

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

### Cloudflare Turnstile 人机验证（登录 / 注册 / 分享下载 / 直链访问 / 文件下载）

Cloudflare Turnstile 接入方案，管理端可按面开关。背景：初版只有「从未接线」的残件——设置里存 `enable_turnstile`/`turnstile_site_key`、secret 走 env `TURNSTILE_SECRET_KEY`，`RegisterSchema`/`LoginSchema` 收 `turnstileToken` 但零消费，YAGNI-03（2026-09-26）全链路移除；现存残留仅两处：`workers/migrations/0001_initial.sql:342-343` 的种子行与 CSP 对 `challenges.cloudflare.com` 的放行（`workers/src/middleware/global.ts:50,56`，25a3feb 有意保留）。本次为完整重实现。以下平台语义与测试键均取自经 Context7 MCP 检索的官方文档（`/websites/developers_cloudflare_turnstile`，developers.cloudflare.com/turnstile）。

- **平台语义（官方文档核实）**：token ≤2048 字符、300 秒有效、**一次性**——过期/重放时 siteverify 返回 `timeout-or-duplicate`，失败后必须 `turnstile.reset()` 换新 token；服务端校验 `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`（form 编码 `secret`/`response`/可选 `remoteip`/`idempotency_key`）→ `{success, error-codes[], action, cdata, hostname, challenge_ts}`，响应回传 `action` 可做面绑定校验；前端显式渲染 `api.js?render=explicit` + `turnstile.render(el, {sitekey, action, theme, size, appearance, language, callback, 'expired-callback', 'error-callback', 'timeout-callback'})`，生命周期 `getResponse`/`isExpired`/`reset`/`remove`；CSP 作用域要分清：Worker 侧 `script-src` + `frame-src` 已放行 `challenges.cloudflare.com`（`connect-src 'self' https:` 覆盖组件出站），**零改动**——但它只作用于 Worker 出的响应（API JSON 与过渡页 HTML）；SPA 由 Pages 承载、仓库既无 `_headers` 也无 meta CSP——**页面当前没有 CSP**，SPA 上的组件不需要任何 CSP 放行，将来若给 Pages 加 CSP 再评估。
- **官方测试键**（仅测试环境）：sitekey `1x00000000000000000000AA` 恒过 / `2x00000000000000000000AB` 恒不过 / `3x00000000000000000000FF` 强制交互；secret `1x0000000000000000000000000000000AA` 恒过 / `2x0000000000000000000000000000000AA` 恒败 / `3x0000000000000000000000000000000AA` 恒返回 `timeout-or-duplicate`；测试 secret 只接受 dummy token，生产 secret 只接受真实 token。
- **配置模型**（`system_settings` + 新迁移 `0002_turnstile.sql`，当前迁移目录仅 0001）：总开关 `enable_turnstile`（复用 0001 既有种子行）；`turnstile_site_key`（既有行，公开可下发）；`turnstile_secret_key` 新增——DB 内 AES-GCM `enc:` 密文存储（与 SMTP/分享密码同一套 `encryptSecret` 约定），**仅后台设置、不开 env 通道**——单一事实源：密钥与面开关同处一处才能做组合校验与审计，站点管理员改配置不应依赖 `wrangler secret` 这类平台面操作；本地/CI 直接在设置里填官方测试键。区别于 SMTP 的 env 兜底：SMTP 有日零需求（首次注册/找回密码发信要先于管理员登录可用），Turnstile/Umami/OIDC 都是管理员登录后才启用的功能，无日零场景；五个面开关新增行、默认 `false`：`turnstile_login` / `turnstile_register` / `turnstile_share_download` / `turnstile_direct_link` / `turnstile_download`。总开关关 = 全部跳过；开 + 面关 = 该面跳过。迁移仅种子行、含回滚注释，无表结构变更。
- **管理端**：`SettingsSchema` 增上述字段（secret 写后不回读，GET 返回 `***` 掩码）；系统设置新增「人机验证」分组：总开关、sitekey、secret（password 输入）、五个面开关；保存时校验「总开关开 + 任一面开 ⇒ sitekey 与 secret 非空」，否则 400。
- **拼装与注入安全**（专项）：① 写入口校验——sitekey 白名单 `^[0-3]x[0-9A-Za-z_-]{8,64}$`（覆盖官方测试键与生产 `0x4…` 形态；纵深防御、非协议要求），secret 只存不回读；② 全链无「配置值拼代码」——前端组件用 `document.createElement('script')` 注入**固定常量** URL `https://challenges.cloudflare.com/turnstile/v0/api.js`（脚本域不可配置，这点与 Umami 的实例地址不同），sitekey 仅作为 `turnstile.render()` 的对象属性传入，不参与任何 HTML/JS 字符串拼装；③ 过渡页是全项目唯一的服务端 HTML 拼装面，两条动态值（sitekey 管理员可控、目标路径访问者可控）必须属性转义 `&<>"'`——把 `handlers.ts:443` 的局部 `escapeHtml` 提为 `workers/src/utils/html.ts` 共享（第二个消费方出现，就地复制就是重演）；④ 目标路径另做结构约束并在 302 与页面脚本两处复核（只接受同源绝对路径：`/` 开头、拒 `//`、反斜杠、控制字符与 CR/LF）——防开放重定向，也防属性上下文破出；⑤ 过渡页**零内联脚本**：CSP `script-src` 无 `unsafe-inline`（L-1 有意移除），内联插值同时是 `</script>` 破出温床——动态值只走 `data-*` 属性、逻辑走 `'self'` 静态脚本 `GET /api/public/turnstile/pass.js`。
- **公开面**：`GET /api/public/settings` 增 `turnstile: { enabled, siteKey, login, register, shareDownload, directLink, download }`（不含 secret）；前端据此决定是否加载脚本与渲染组件。
- **服务端校验服务**（`workers/src/services/turnstile.ts`，各面复用）：`assertTurnstile(c, token, action)`——面未启用直接返回；token 缺失 403 `TURNSTILE_REQUIRED`；siteverify（`URLSearchParams`，`remoteip` 用 `utils/ip.ts` 的 `requestIp`，10s 超时）`success !== true` → 403 `TURNSTILE_FAILED`（`error-codes` 进服务端日志）；siteverify 网络异常/5xx → **503 fail-closed**（与认证限流 KV 故障 fail-closed 同策略）；响应 `action` 与预期不符 → 403（token 一次性是第一道防线，action 绑定是第二道）。
- **接入面 1 登录**：`POST /api/auth/login`（`workers/src/services/auth/handlers.ts:178`）——`LoginSchema` 重新引入可选 `turnstileToken`（本次连同消费逻辑一次接线，不再「先收下、后接线」），在密码判定**之前**校验（省 bcrypt 开销），`action='login'`。
- **接入面 2 注册**：`POST /api/auth/register`（`auth/handlers.ts:74`）——`RegisterSchema` 重新引入 `turnstileToken`，OTP 校验前验证，`action='register'`。
- **接入面 3 分享下载**：`GET /api/shares/:id/download`（`workers/src/services/shares/handlers.ts:473`）——GET 无 body，token 走请求头 `X-Turnstile-Token`；`gateShareRead` 通过后、签发下载令牌前校验，`action='share_download'`；分享密码验证（verify-password/verify-file）不加验——密码门与人机门不叠放，避免双重摩擦。
- **接入面 4 文件下载**：`GET /api/files/:id/download`（`workers/src/services/files/handlers.ts:356`）——同款请求头，`action='download'`。下载网关 `/api/gateway/download/:token` **不加验**：网关 URL 由浏览器 `<a>`/`window.open` 直取、无法携带头，且令牌本就一次性 + 15 分钟 TTL，签发侧已是闸门；copy-links 不加验（直链/签名链接的消费者是第三方）。
- **接入面 5 直链访问**（path-serve `{origin}{directPrefix}/{path}`，`workers/src/services/files/path-serve.ts:52`）：浏览器导航（`Sec-Fetch-Mode: navigate` 或 `Accept` 含 `text/html`）且无有效 `?sign=` 时，返回 200 **人机验证过渡页**——服务端拼装的最小 HTML（含两个外部脚本：Turnstile 官方 `api.js` 与 `'self'` 静态页面脚本 `GET /api/public/turnstile/pass.js`；动态值只经 `data-*` 属性注入、无内联脚本，拼装与路径约束见上「拼装与注入安全」；文案随 `Accept-Language`）；widget 通过后页面脚本 `POST /api/public/turnstile/verify`（限流复用 `authRateLimitMiddleware`）`{token, action:'direct_link'}` → siteverify 通过后下发 HMAC（`ENCRYPTION_KEY`）签名 cookie `turnstile_pass`（HttpOnly、SameSite=Lax、约 10 分钟、值含过期时间戳、Path 限直链命名空间），302 回原路径；path-serve 见有效 cookie 即放行。非浏览器客户端（无 text/html）→ 403 JSON `TURNSTILE_REQUIRED`（API 调用方拿到明确错误码而非 HTML）。**边界**：AList `/openlist/d` 与 `?sign=` 签名链接不加验（sign 是显式能力凭证，API 面回 HTML 会破坏 PicList）；`public_cdn` 直链物理上不经过 Worker、无法验——开关说明文案需明示该限制。
- **前端组件**（`frontend/src/components/turnstile.tsx`）：脚本懒加载（仅启用时注入 `api.js?render=explicit`）+ 显式渲染；props `{action, onToken}`；`theme` 跟随 theme store（light/dark/auto）、`language` 跟随 i18n（zh-cn/en）、`size: 'flexible'`（响应式，最小宽 300px）、`appearance: 'interaction-only'`；`expired-callback`/`timeout-callback` → `turnstile.reset()` + 清 token + 提示重试；`error-callback` → i18n 错误文案；表单提交收到 403 `TURNSTILE_FAILED` → reset 换新 token（旧 token 已被一次性消费）。
- **页面接线**：`Login.tsx`/`Register.tsx` 按公开设置条件渲染组件，无 token 时提交按钮置灰，body 带 `turnstileToken`；`SharePage.tsx` 下载按钮上方渲染组件，请求带 `X-Turnstile-Token` 头（`apiFetch` 已支持自定义 headers）；文件页下载动作同款带头。i18n zh/en 两份同步（`common.turnstile*` 与管理端分组文案）。
- **测试**：后端 `workers/tests/turnstile.test.ts`（stub fetch siteverify）——开关矩阵（总关/面关跳过）、缺 token 403、验证失败 403、action 不符 403、siteverify 异常 503 fail-closed、dummy secret 恒过/恒败矩阵；path-serve 过渡页——浏览器 UA 无 cookie 得 HTML、有效 cookie 直出、cookie 签名篡改拒绝、非浏览器 403；前端——组件按公开设置门控渲染（未启用不加载脚本）、过期回调清 token、提交失败 reset；覆盖率聚焦新组件与 Login/Register 改动（`Register.test.tsx` 有 CI 门禁先例）。
- **文档联动**：API 参考补 `X-Turnstile-Token` 请求头、`TURNSTILE_REQUIRED`/`TURNSTILE_FAILED` 错误码与公开设置 `turnstile` 字段；架构文档安全设计补「人机验证」小节；部署指南补 Turnstile 密钥申请（Cloudflare Dashboard → Turnstile）与官方测试键说明；UI 指南补五面交互。
- **明确不做（本期）**：pre-clearance（绑定 CF zone WAF，不适用多面 SPA）；过渡页 cookie 跨面复用（短 TTL 足够）；WebDAV/S3 网关/AList API 面（已有 API Key 认证 + 限流）；gallery 下载与找回密码（与分享下载/登录同模式，需要时一键纳入）。

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
