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
| Phase 3 | AWS S3、外观主题、管理员登录、公告关闭 | 基本完成；Oracle 无专属代码——迁移 0005 已把 `oracle` 类型折叠为 `s3`，经 S3 兼容协议接入（前端有预设，OCI 实测与专属测试未做），见「功能区域」存储提供商行 |
| Phase 4 | 路径变量 DSL（`{year}/{month}`）、Umami 访问统计、SSO/OIDC 登录、Cloudflare Turnstile 人机验证 | Umami 访问统计 Done；邀请码注册机制已提前完成（见「功能区域」与 2026-09-30 追加二）；SSO/OIDC 登录 Done（见 2026-09-30 追加五）；其余 Planned |
| 未来 | monorepo 双后端：Workers 版 + Go 高性能版（跨桶复制/DR、无配额长任务） | Planned |

## 功能区域

| 区域 | 状态 | 说明 |
| :--- | :--- | :--- |
| 部署：Cloudflare Pages + Workers | Done | Vercel 与 EdgeOne 已拒绝。 |
| 存储提供商 | Done | R2 与 S3 已实现；Oracle 经 S3 兼容协议接入但**无专属代码**（迁移 0005 把 `oracle` 折叠为 `s3`，`frontend/src/lib/storage-presets.ts` 提供 OCI compat endpoint 预设，能力矩阵见架构文档；OCI 实测与专属测试未做）；其余 9 家已拒绝。自建 S3 兼容（RustFS / MinIO 等）经 `s3` 类型协议可用，但 endpoint 受公网 80/443 校验约束（见「即将规划 — 自建 S3 兼容存储的内网接入受限」）。 |
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
| 邀请码注册 | Done | 迁移 0010：注册门控 + 事务内原子核销、用户端生成/受邀记录、管理端「注册设置」分组；详见 2026-09-30 追加二。 |
| 第三方登录（SSO / OIDC） | Done | 迁移 0012：Google / GitHub（单例）与自定义 OIDC 来源、`/sso/complete` 补充注册、身份与令牌落库；详见 2026-09-30 追加五。 |
| 权限与配额 | Done | 3 角色、路径 ACL、文件/路径密码、存储与文件数配额。下载限速与月度流量配额已拒绝。 |
| 存储配置 | Done | 挂载点、CDN 域名、路径前缀、排序、签名；内容哈希寻址（§F）去重同内容；存储池（§E）跨 provider 摊铺。复制/DR 与路径 DSL 待做。 |
| 存储核心加固 | Done | Range 读取（经统一 `serveObject` 的 206/416）、`ProviderError` 分类、批量删除（每批 ≤1000 + 逐对象回退）、Delimiter 列目录、>5 GB 移动用 `UploadPartCopy`。 |
| Provider 统一 | Done | 类型由 `endpoint` 推导（`r2` / `s3`；`oracle` 并入 `s3`）；迁移 `0005`；`upload_domain` 移除。 |
| 管理端 | Done | 仪表盘、用户、存储、挂载点、规则、分享、文件、日志。访问统计来源可切 Umami（见下）。 |
| 访问统计（Umami） | Done | 站点级来源二选一（D1 `access_logs` / Umami 前端统计）；脚本面配置 + tracker 注入 + 下载/复制链接事件上报，详见「2026-09-30 追加：Umami 访问统计」。 |
| 系统设置 | Done | 站点信息；「注册设置」分组：开放注册/访客开关（自安全设置挪入）+ 邀请码四项（开关/必填/生成权限/每用户上限）。Turnstile 配置已随审计 YAGNI-03 清理移除（从未接线）；完整重实现方案见「即将规划」。 |
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

### 2026-09-27 全盘实验室验证修复批次（`docs/LAB_TEST_REPORT_2026-09-26.md`）

对实验室全链路验证（445 项检查 / 37 失败）的修复批次。B1/B3（302 直连 + 令牌 TTL 复用）按报告标注「待决策」未实施。

| 组 | 修复 | 关键落点 |
| :--- | :--- | :--- |
| F-01 | workerd 缺 DOMParser → S3 XML 响应解析全挂 | `@aws-sdk/xml-builder` 整包替换为 vendored 纯 JS 解析器（`workers/src/shims/aws-xml-builder.ts`），`wrangler.toml [alias]` 与 vitest alias 同步；bundle 0 处 DOMParser |
| F-15 | 主桶进程死亡（裸 TypeError）不回退副桶 | s3.ts `getObject/headObject/copyObjectMultipart`、content.ts 暂存复制失败统一 `throw toProviderError(err)`，failover 候选循环可分类回退 |
| F-05/F-06 | upload-complete 无占用判定 500；预签名覆盖属主对象 | 会话创建即做祖先目录自愈 + 他人占用/目录占用 409（不签发 URL）；complete 前置占用复核（触碰对象前失败）、同属主覆盖走 updateFileTx + legacyCleanup + 配额差值 |
| F-02/H1-H3 | 会话路径不登记内容索引 | complete 事务内经唯一入口 `registerContentObject` 登记 `(hash, mount_id)`；raw 响应透出 `deduped`；complete 审计带真实 deduped；`resolveFile` 读时惰性补登记（L0，零扫描） |
| F-03 | flat 语义双路径相反 | `ensureFolders` 跳过挂载根本身（身份行在父挂载命名空间）：flat 挂载根上传 200、嵌套需新建祖先 403（两通道一致）；会话创建接入 ensureFolders |
| F-04 | D1 LIKE 模式 50 上限 → 深路径列表 500 | `escapeLikePattern` 全仓退役；前缀/子树/深度 1 目录改写为范围 + substr 谓词（`prefixMatch/subtreeMatch/childFolderMatch`），模糊搜索改 `instr()`；12+ 调用点全迁移 |
| F-07 | 匿名经矩阵读 private；public_cdn 不校验可见性 | 引擎 6.5 步：guest + `visibility !== 'public'` 在矩阵/属主回退前硬拒绝；path-serve 签名与可见性分拆（public_cdn 只豁免签名）；`/api/public/fs` 目录行可见性传入引擎并逐项过滤 |
| F-09 | share 不在矩阵词表 → 非属主可分享他人文件 | 引擎第 9 步不再无条件放行 share：share 只属属主回退（第 7 步）或显式规则；`/api/shares` 非属主 403 |
| F-10 | 按文件授权被 defaultPath 边界拦截 | 引擎第 3 步：显式指向本主体的 user-origin allow 规则豁免边界（带密码/IP 条件的规则不参与豁免） |
| F-17/F-17b | guest_visibility none 无 deny；view 列表不可达 | `syntheticGuestRule` 对 none 生成 deny 合成规则（effect 决胜压过 public 合成 allow）；`/api/public/fs` 目录内存在 view 级子项时放行浏览面（逐项过滤不变） |
| F-18 | gallery 签发点未预检封禁 | `GET /api/gallery/:id/download` 签发前 `assertNotBanned`（与 path-serve 同源） |
| F-14 | SMTP `connect is not defined` | `utils/smtp.ts` 重写：真实 `cloudflare:sockets` 导入、隐式 TLS/STARTTLS（`smtp_secure` 设置端到端消费）、10s/30s 超时、点填充；workers typecheck/test 绿 |
| F-12 | 上游错误文本经 ApiError/shim 直出 | admin 测试邮件、uploads 分片合并（改 `502 UPSTREAM_ERROR` + 服务端日志）、alist/lsky shim（非 ApiError 稳定文案）、s3gw DeleteObjects XML、readiness `detail` 枚举化 |
| F-08 | settings PATCH 静默丢弃未知键 | `SettingsSchema.strict()`；响应回显 `savedKeys` |
| F-11 | keys 创建响应 id/keyId 错配 | `id` = 数据库行 id（与列表/删除同源），保留 `keyId`；DELETE 兼容 `pk_…` |
| F-13 | siteLogo/Favicon 写层不校验私网 | schema 层 `validateEndpoint` 校验（与取件层同口径），`''`/null = 清空 |
| L-01 | 直链不受任何限速 | `app.use('/*')` 挂 `downloadRateLimitMiddleware`；`isDownloadPath` 覆盖直链路径形态 |
| L-02 | 限速仅生产生效，staging 不可回归 | `rateLimitsEnforced(env)`：production 或 `RATE_LIMIT_FORCE=true`；五处早退统一收敛 |
| O1 | settings/me 重复调用 | App.tsx 收敛为各一次、删除 raw 预热 |
| O2 | 骨架屏 350ms 人为驻留 | `useMinLoading` 默认 120ms |
| O3 | 入场阶梯长尾 | REVEAL_STEP 40→20、FINE 25→12、MAX_INDEX 9→5、INNER_BASE 60→30 |
| O4 | 列表缩略图 N+1 | `GET /api/files` 内联 `items[].thumbUrl`（媒体、1h 签名）与 `items[].previewItems`（前 4 子项）；前端 `useFilePreviewUrl` 命中 thumbUrl 零请求、FolderPreviewGrid 优先内联数据 |
| O6 | 列表 COUNT(*) 双查询 | `listChildren` 用 `COUNT(*) OVER ()` 随行返回总数 |
| P-01..P-08 | 媒体预览 401 / 放大裁剪 / 旋转回旋 / 控件位置 / 关闭按钮 / 自适应 / 2×2 1:1 / 重复下载 | 媒体预览改签名直链（回退一次性令牌转 blob）、错误文案按状态码；缩放改布局尺寸（width%），舞台可滚动；旋转单调递增；控件移至底部居中、仅图标；去底部关闭按钮；媒体 object-contain 填满舞台；预览格 aspect-square 严格 1:1；预览 URL 按 id+updatedAt 缓存（TTL 内复用） |

### 2026-09-28 追加二：预览管线重构修复 + txt/md + 日志分页统一 + 审计设置

用户实测反馈（txt 可预览、md 空白、图片视频「网络错误」toast 开关各两次）定位出 P-01 改造的三处叠加缺陷，连带完成两项功能需求：

| 项 | 修复 | 关键落点 |
| :--- | :--- | :--- |
| 预览「网络错误」 | 预览一律走一次性令牌 → **单次 fetch → blob**（同源、可重复 Range、拓扑无关）。此前的 formats.direct 在 S3 provider 上是跨源预签名 URL（CORS/拓扑不可达），同源 Worker 直链在 dev 又被 Vite SPA fallback 截胡（非 /api 路径返回 index.html）——任何直链消费都不可靠 | `data.ts#usePreviewMediaUrl` 重写为只签令牌；直链仅保留给「复制链接」外贴 |
| 令牌竞态 | 令牌只能消费一次：<img> 直接吃令牌会与 blob fetch 赛跑（双消费，输家 401）。现在令牌只被**一个**消费者（单次 fetch）处理；媒体吃 objectURL、文本吃 blob.text()，转换期渲染骨架、失败渲染错误态（不再让媒体元素加载注定 401 的死令牌） | `preview.tsx` 单一消费 effect + `tokenPending`/`mediaFailed` 状态 |
| 死令牌缓存 | imageUrlCache 缓存令牌 URL 10 分钟 → 重开预览命中死令牌必 401（「关闭再开各弹两次」）。令牌不再进缓存，每次打开重新签发 | `data.ts`（预览与网格缩略两处） |
| md 空白 | `.md` 同时命中 CODE_EXT 与 MARKDOWN_EXT，文本 effect 的 isCode 分支优先把文本写进代码 content，md 分支读 plainContent 恒空 | 抓取 effect 先判 isMarkdown；集成测试锁定 |
| toast ×N | 媒体 onError 依赖 status-ref；失败改为渲染错误态组件（带重新下载），错误文案按状态码 | `PreviewTooLarge`（retry 形态） |
| TXT 预览 | `.txt`/`.log` 双击即开：`<pre>` 文本节点原样展示（自动折行），2 MiB 上限同代码 | `isText`/TEXT_EXT |
| Markdown 渲染 | react-markdown 10 + remark-gfm 4（默认转义原始 HTML，无 rehype-raw，无文档级 innerHTML 面）；围栏代码块沿用 highlight.js；`.md-preview` 样式仅消费设计 token | `markdown-preview.tsx` + `lib/hljs.ts`（语言注册单例，修掉组件侧副作用注册） |
| 代码预览双转义 | 既有代码路径 `escapeHtml` 预转义与 hljs 自身转义叠加（`<` 显示 `&lt;`） | 传原始文本给 `hljs.highlightAuto`（输出契约即转义） |
| 日志分页统一（§8） | `GET /api/admin/logs` 从游标分页改为**页码/条数/总数**契约（`listPage`：窗口函数 `COUNT(*) OVER()` 随行返回总数 + 窄列），管理端日志页换用共享 `Pagination`（页码跳转 + 每页条数 20/50/100 + 总数），样式令牌与其它管理页同源 | `LogRepo.listPage`（listCursor/旧 list/游标编解码删除）、`admin/handlers.ts`、`admin/Logs.tsx` |
| 审计设置 | 系统设置新增「日志审计」：记录等级（all/essential/security）+ 记录项目（auth/upload/download/share/admin/failure 多选）。中心门禁在 `LogRepo.create`（60s 进程内缓存 + 保存即失效），三处事务内直插点在事务前判定（D1 事务禁读）。语义：essential=不记成功下载/读取（失败恒记）；security=仅认证/管理/失败；项目关闭=该组不记（failure 横切独立） | `db/repos/system.ts`（policy + `isActionLoggable`/`invalidateAuditPolicyCache`）、`admin/schemas.ts`、`admin/handlers.ts`（strict 键 + savedKeys 回显）、`admin/Settings.tsx`、直插点 write/operations/uploads |

E2E（运行栈实测）：security 级别下下载不入账、登录照记；恢复 all 后下载重新入账；日志分页契约由 `audit-tiering.test.ts` 页码版锁定；策略语义由 `audit-policy.test.ts`（5 例）锁定；预览管线由 `preview-integration.test.tsx`（StrictMode + mock fetch 链路 4 例）锁定。

### 2026-09-28 追加三：预览体验批次（穿透/尺寸模式/适应/导航）+ S3 上传修复

用户实测反馈四项 + 测试中发现两处 S3 上传阻塞缺陷：

| 项 | 修复 | 关键落点 |
| :--- | :--- | :--- |
| 预览穿透（拖动选择文本/图片触发下层 lasso） | `Dialog` 根元素标 `data-overlay-root`；lasso `onPointerDown` 对 overlay 内指针直接忽略；文件页 `select-none` 对 overlay 内恢复 `select-text`（拖动选文本/拖图片不再穿透到文件选择） | `ui/dialog.tsx`、`files/lasso.ts`、`pages/Files.tsx` |
| 尺寸模式设置 | 外观设置新增「图片/视频预览尺寸」：fit=适应窗口（默认，整图完整显示无滚动条）/ original=按原始像素（舞台可滚动）；localStorage 记忆，手机/桌面共用；预览弹窗底部一键切换，缩放/旋转控件仅在 original 档显示（fit 档显示原始尺寸信息） | `stores/theme.ts`（previewSizeMode）、`preview.tsx`、`settings/Personalization.tsx` |
| 竖图溢出窗口 | fit 档改为 `object-contain` 一次成型：内层容器 `h-full w-full`（去掉 min-h-full —— 它让父被 img 撑开、`max-h-full` 百分比失去基准，9:16 竖图渲染 1800px 高需滚动）。宽图贴宽、长图贴高、方图贴高，全部无滚动条；手机视口实测 195×585 全入窗 | `preview.tsx`（isFit 分支） |
| 上一个/下一个 | 预览弹窗底部导航按钮（图片/视频、序列>1 时显示），调用方在当前显示序列的媒体 id 中定位相邻项；aria 用 `files.prevItem/nextItem`（上一个/下一个，非分页语义） | `preview.tsx` props + `Files.tsx` onNavigate |
| S3 PUT 自动 checksum 头 | SDK v3.700+ 默认 `WHEN_SUPPORTED`：PUT 附 `x-amz-checksum-crc32`，S3 兼容网关（VersityGW/MinIO）预签名校验拒未签名头 → 500。`S3Client` 显式 `requestChecksumCalculation: 'WHEN_REQUIRED'`（完整性由 ETag/Content-Length 保证） | `storage/s3.ts` |
| S3 PUT MissingContentLength | S3 协议 chunked PUT（无 Content-Length）被拒；`writeContentAddressed` 的 FixedLengthStream 包裹从 R2 扩展到 S3（declaredSize 已知时发 Content-Length） | `storage/content.ts` |

E2E（真浏览器实测，1280×800 与 375×812 双视口）：竖图 fit 渲染 184×553/195×585 全入窗无滚动；宽图 1233×411 贴宽；方图 553×553 贴高；original 档渲染 1800×600 原始像素；导航序列 square→tall→wide→prev 全部正确切换。

### 2026-09-28 追加：txt 预览与 Markdown 格式化渲染

| 项 | 修复 | 关键落点 |
| :--- | :--- | :--- |
| TXT 预览 | `.txt`/`.log` 双击即开预览：`<pre>` 文本节点原样展示（自动折行），不经任何 HTML 管线；2 MiB 上限同代码预览 | `lib/utils.ts` 新增 `TEXT_EXT`/`isText`；`Files.tsx` 双击门放行；`preview.tsx` 新增 isText 分支 |
| Markdown 渲染 | `.md`/`.markdown` 用 react-markdown + remark-gfm 格式化渲染（标题/列表/表格/任务列表/删除线）；源内原始 HTML 一律按文本输出（默认无 rehype-raw，无文档级 innerHTML 面）；围栏代码块沿用 highlight.js 高亮 | 新增 `components/files/markdown-preview.tsx` + `.md-preview` 样式（`index.css`，仅设计 token）；新增依赖 react-markdown 10 / remark-gfm 4 |
| 高亮管线收敛 | 语言注册抽到 `lib/hljs.ts` 单例（代码预览与 md 围栏共用）；修正既有代码预览的双重转义显示缺陷（`escapeHtml` 预转义与 hljs 自身转义叠加，HTML 内容显示 `&lt;`）——hljs 输出契约即转义实体，传原始文本 | `lib/hljs.ts`；`preview.tsx` 代码路径改为 `hljs.highlightAuto(text)` |
| 回归 | `markdown-preview.test.tsx` 8 例：格式化渲染、GFM 表格、XSS 边界（script/img 按文本）、围栏转义与语言高亮、分类器 | frontend/src/components/files/markdown-preview.test.tsx |

### 2026-09-28 追加四：预览设置收敛 + 缩略图流量门禁缓存 + 用户菜单重排

| 项 | 修复 | 关键落点 |
| :--- | :--- | :--- |
| 预览行为卡收敛 | 个性化页把「图片/视频预览尺寸（适应/原图）+ 右键单击行为 + 右键多选 + 文件夹图片/视频预览」合并进同一张「预览行为」卡；i18n 键补齐（`settings.appearance.previewBehavior/previewSizeMode/mediaPreviews*` 等原引用不存在导致显示裸 key，死键 `admin.previewMode*` 删除迁入 `settings.appearance.*`），两档文案按用户口径精简（适应 = 适应窗口大小显示；原图 = 按原始尺寸显示） | `pages/settings/Personalization.tsx`；`lib/i18n/zh.ts` + `en.ts` |
| 缩放两档可用 | 预览弹窗 zoom 改为弹窗本地状态：适应档 zoom>1 内层撑大为 `zoom*100%`（布局式放大、保持 contain、四向可滚动、缩放后舞台滚动居中），原图档 `width=natural×zoom`；缩放不再改写全局尺寸模式；上一个/下一个在图片/视频两档均可用 | `components/files/preview.tsx` |
| 缩略图流量门禁 | 「文件夹图片/视频预览」默认关闭：关闭时不签发下载令牌、不产生任何媒体字节（文件夹卡片/网格/列表/视频抽帧全走类型图标）；预览弹窗（显式动作）不受限 | `components/files/data.ts` `useFilePreviewUrl` 消费 `mediaPreviewsEnabled`（`stores/theme.ts`，localStorage 持久化） |
| 缩略图 LRU 缓存 | 令牌 → 单次 fetch → blob → objectURL 进模块级 LRU（80 条，键 `id:updatedAt`，淘汰/替换即 revoke）；文件夹卡片 2×2 格、网格/列表缩略、视频抽帧共用——退出文件夹再进入零请求瞬间出图（整页刷新后 objectURL 失效重新下载属预期） | `components/files/data.ts` |
| 用户菜单重排 | 菜单头部左两行（邮箱 + 昵称）右 40px 小头像（高度恰为两行文本）；分隔线下文件数量 + 存储空间用量进度条（复用 `/api/auth/me` 的 quota 与 `settings.filesUsed`/`settings.profile.storageSpace` 文案）；再分隔线下依次文件、设置、管理，底部退出登录 | `components/layout/widgets.tsx` `UserMenu` |
| 清理 | 删除中断会话遗留的 scratch 探针测试（前端 10 文件/56 例 → 9 文件/55 例） | 删除 `frontend/src/scratch-blob.test.ts` |

实测（本地 lab，Chromium）：默认关闭下 samples 目录零媒体请求；开启后 images 文件夹 17/18 缩略出图（1 个 6 字节损坏 fixture 正确回退图标）；SPA 离开再进入新增下载请求 0；适应档放大后舞台双向可滚动且 `previewSizeMode` 保持 fit；original 档 1800×600 原始像素可滚动；上一张/下一张顺序切换；用户菜单各区按设计渲染。

### 2026-09-29 追加五：滑块复刻重构（单文件 pill slider）

| 项 | 修复 | 关键落点 |
| :--- | :--- | :--- |
| 视觉复刻 | 复刻 Breno Lasserre「You gotta love sliders」的 pill slider 并按项目规范调整：圆角矩形轨道 `rounded-md`（与输入框/按钮同半径）+ 左侧同高浅强调色填充（`bg-primary/20`，比强调色浅一档）+ 细竖条拇指（`h-3.5 w-1`）+ 档位锚点（只标可落值档位，`bg-foreground/15`，不做白色锚点）；标签/数值内嵌轨道两侧（`pl-5`/`pr-4`）；0 档贴左、最大档贴右（两端仅留半拇指宽全见内缩） | `components/ui/slider.tsx`；`index.css` `.pill-slider-*` |
| 单文件收敛 | 全部滑块收敛 `ui/slider.tsx`（`BlurSlider`/`MotionSlider`/`FilesPerRowSlider` + 基础 `PillSlider`），不同位置引入传不同标签文案与档位区间、锚点数量随档位生成；删除 `components/settings/` 三个滑块文件，Personalization 移除外层 Label（标签内嵌胶囊）并按端别传标签文案；孤儿 i18n 键 `settings.blurLevel`/`settings.motionLevel` 删除 | `components/ui/slider.tsx`；`pages/settings/Personalization.tsx`；`lib/i18n/zh.ts` + `en.ts` |
| 交互状态 | hover 轨道/填充轻微压暗并加深拇指；按住只加深拇指，轨道尺寸、标签和数值保持稳定；松开回到 hover/rest 层次；填充与拇指使用短促 ease-out 位移，不做橡皮筋外扩或越界回弹 | `index.css`；`components/ui/slider.tsx` |

实测（WSL）：前端 `tsc --noEmit` 与 `vite build` 通过；新增 slider 回归测试覆盖 range 无障碍值、离散档位、按下/松开状态和边界夹取。当前 WSL Node 18 的 jsdom 依赖触发 `ERR_REQUIRE_ESM`，Vitest 无法启动 worker，测试执行受环境依赖阻断。

### 2026-09-29 追加六：大文件上传实测与修复（动态分片 + 合并超时）

| 项 | 修复 | 关键落点 |
| :--- | :--- | :--- |
| 动态分片大小 | 进入分片模式后按 `max(8 MiB, ceil(fileSize / MAX_MULTIPART_PARTS=650) 向上取整 MiB)` 计算分片大小——把大文件分片数压在 S3 兼容引擎的安全分片数上界内（VersityGW 1.8.0 实测 650 片合并 OK / 800 片 `InternalError`，815 片经应用层合并 502）；小文件（≤650×8 MiB）保持 8 MiB 不变，前端按 `ceil(size/totalParts)` 推导切片无需改动 | `uploads/handlers.ts` 新增 `resolveMultipartPartSize` + `MAX_MULTIPART_PARTS`；`workers/tests/upload-part-size.test.ts` 5 例 |
| 合并超时 | S3 provider `CompleteMultipartUpload` / `ListParts` 从 15s `METADATA_TIMEOUT_MS` 改为 5 分钟 `MERGE_TIMEOUT_MS`——合并时长随总字节数线性增长（593 片 6.4 GiB 合并实测 58s），15s 档必然 `AbortError: Request aborted` → 502 | `storage/s3.ts` |
| 实测脚本 | 新增 `scripts/lab/16_big_iso.py`（任意本地大文件全链路：会话→逐片→合并→元数据→网关下载 SHA-256 对比→清理；S3 预签名 / R2 绑定双路径、分片重试、`--keep`）与 `scripts/lab/mpu_probe.ts`（直连引擎探测 multipart-complete 分片数上限）；docs/LAB_TEST_GUIDE 增 §12 用法 | `scripts/lab/` |
| 实测结论 | Win11 6.36 GiB / 593 片（11 MiB）S3 预签名全链路通过：上传 49 MiB/s、合并 58s、网关下载 59 MiB/s、SHA-256 一致；R2 绑定 815 片 6.4 GiB 同样全链路通过（SHA-256 一致）；修复前 815 片合并 502（15s AbortError） | docs/LAB_TEST_REPORT §19（2026-09-29 追加） |

### 2026-09-30 追加：动画速度两档 + 等待体验（§36）

| 项 | 变更 | 关键落点 |
| :--- | :--- | :--- |
| 动画速度两档 | 个性化设置「动画效果」下方新增**高效/舒适**二选一（与主题选择同款行内两列，**仅「全部动画」档可见**）；落在 `<html data-motion-speed>`，CSS 只在舒适档覆写 token：时长 `--duration-fast/base/slow` 300ms/600ms/1s（高效 210/420/700）、错峰倍率 2（高效 1.4）、入场族（卡片 `.reveal`、表格行 `.reveal-row`、下拉菜单与其逐项）在时长之上再乘 `--motion-entrance-scale` 1.25；**默认/关闭档一律高效时长**（`applyTheme` 与档位一起判定） | `stores/theme.ts`、`index.css`、`pages/settings/Personalization.tsx`、`components/ui/slider.tsx` 未改、i18n 两份 |
| 每行卡片数置顶 | 外观卡内三个滑块顺序改为 **每行卡片数 → 模糊强度 → 动画效果**（速度开关挂在动画效果之下），`innerDelay` 序号随之平移 | `pages/settings/Personalization.tsx` |
| 弹窗/抽屉独立时长 | 新增 `--duration-overlay`（高效 300ms / 舒适 420ms）：每次开关都要等的交互面不再吃 1.4 倍放慢；遮罩与面板均改用它，卸载计时改 `motionDurationMs('--duration-overlay')`（原硬编码 `EXIT_MS = 300` 会掐断舒适档）；tabs/侧栏指示器仍走 `--duration-base` | `index.css`、`components/ui/dialog.tsx`、`drawer.tsx`、`lib/utils.ts`（新增 `motionDurationMs`） |
| 弹窗/抽屉过渡被吞修复 | 打开改为 `useLayoutEffect` + 强制一次 `getBoundingClientRect()` 把「关闭态」钉进计算值再切 `entered`——双 rAF 挡不住 React 调度：条件挂载时 `mounted` 与 `entered` 可能合并进同一次 commit，元素首帧即终态（右键菜单还在逐项入场时点「属性」必现）；关闭改 `transitionend` 驱动卸载 + token 兜底（过滤 `e.target === panel`） | `components/ui/dialog.tsx`、`drawer.tsx` |
| Tailwind 任意时长类失效 | 实测 Tailwind v3.4 **静默丢弃** `duration-[var(--x)]` / `duration-[420ms]`（规则不产出 → 退化成 `transition-*` 自带 150ms，"弹窗没有动画"的根因）；7 处改用任意属性写法 `[transition-duration:var(--duration-overlay)]`；toast 的 `duration-[350ms]` 同类失效一并修正为 `[transition-duration:350ms]` | `components/ui/{dialog,drawer,tabs,toast}.tsx`、`components/ui/indicator.ts`、`components/layout/AppShell.tsx` |
| 骨架屏驻留 | `useMinLoading` 默认最短驻留 120ms → **50ms**（只做防闪底噪；数据更晚到达仍立即切换，不延迟请求） | `hooks/useMinLoading.ts` |
| 骨架屏表观 | `AppSkeleton` 根元素去掉实底 `bg-background`（实底会盖掉壁纸与玻璃观感）；`main.tsx` 以副作用 import `./stores/theme` 让外观设置**在启动即 applyTheme**——认证检查/路由懒加载期间的等待也长在用户自己的壁纸、明暗与模糊上（此前主题只在懒加载页面里落地）；骨架微光保持 `animate-pulse` 固定 2s，不随档位变化 | `components/ui/skeleton.tsx`、`main.tsx` |
| 实测 | 高效遮罩/面板 0.3s、舒适 0.42s（`transitionend.elapsedTime` = 420ms）、卸载均晚于过渡结束；菜单入场中（延迟 0/30/60/150ms）点「属性」4/4 次完整播放；骨架驻留实测 48ms（即时回包）、慢请求（166ms）无附加等待；舒适档在 `default`/`off` 档回落为 `data-motion-speed="efficient"` | 浏览器实测 + 识图核对外观卡顺序 |

### 2026-09-30 追加二：邀请码注册机制（Phase 4 提前落地）

按「即将规划 — 邀请码注册机制」原方案全量落地（规划文本已移除；契约见 API/ARCHITECTURE/UI 文档，服务文档 `workers/src/services/invites/README.md`）：

| 项 | 实现 | 关键落点 |
| :--- | :--- | :--- |
| 迁移 0010 | `invite_codes` 表（码值 UNIQUE、创建人删除级联）+ `users.invited_by_code_id` 核销列（FK ON DELETE SET NULL）+ 4 个「注册设置」种子键（`invite_enabled` / `invite_required` / `invite_generation` / `invite_max_per_user`），含回滚注释与索引 EXPLAIN 说明 | `workers/migrations/0010_invite_codes.sql` |
| 管理端「注册设置」分组 | 「开放注册」「允许访客」开关自安全设置卡挪入；新增 开启邀请码 / 邀请码必填（未开启置灰）/ 生成权限（全部用户 / 仅管理员）/ 每用户最大生成数量（1-100，默认 5）；`SettingsSchema` strict + GET/PATCH 往返；卡片顺序 站点/注册/安全 + SMTP/公告 | `admin/schemas.ts`、`admin/handlers.ts`、`admin/Settings.tsx` |
| 邀请码服务 | `POST /api/invites`（批量 count 1-10 + name 备注，UNIQUE 碰撞重试，累计上限 `403 INVITE_LIMIT`）与 `GET /api/invites`（自己的码倒序 + 按码聚合受邀用户 + `max`）；两端点同受生成权限门禁（admin_only 非管理员 403）；码值 `[0-9A-Z]{6}` crypto 随机（`randomString` 通道）；设置读取 fail-safe（开关缺行 = 关闭） | `services/invites/`、`db/repos/invites.ts` |
| 注册链路 | `RegisterSchema` 增 `inviteCode`（校验在 handler，按场景返回具体错误码）：未开启+带码 `INVITE_NOT_ENABLED` → 必填缺码 `INVITE_CODE_REQUIRED` → 格式 `INVITE_CODE_FORMAT` → 存在性 `INVITE_CODE_INVALID`；`UserRepo.createUser` 改**事务内**插入（users 含 `invited_by_code_id` + user_quotas 同成败），码行并发消失时 FK 使整体回滚 = 核销原子性 | `auth/schemas.ts`、`auth/handlers.ts`、`db/repos/users.ts` |
| 公开设置与门控 | `GET /api/public/settings` 透出 `inviteEnabled` / `inviteRequired` / `inviteGeneration`；注册页据此渲染邀请码输入（必填/选填标签，输入即过滤 `[0-9A-Z]{6}` 并转大写）；个性化页据 generation + 本人角色判定区块可见（site store `loaded` 后判定，后端 403 整块隐藏） | `public/handlers.ts`、`stores/site.ts`、`pages/Register.tsx` |
| 用户端邀请码卡 | 个性化设置「修改密码」下方「邀请码」卡（仅对有生成权限的用户显示；显示时右列两卡 reveal 序号顺延 3/4 → 4/5）接入 **`Tabs` 组件**二选一（「邀请码」/「邀请的人」）：Tab 1 为生成表单 + 邀请码表格（名称 / 邀请码 / 创建时间）；Tab 2 为受邀用户汇总表（用户名 / 使用的邀请码 / 注册时间，支持按用户名或注册时间排序，默认按注册时间降序）；**视觉一致性**：两表共享 `INVITE_GRID`，中间列（码值）与右侧列（时间）X 轴像素级绝对对齐；两表行内边距统一为 `py-2.5`（间距完全一致）；可复制码与使用码尺寸统一调为等小药丸（`text-xs px-1.5 py-0.5`，59×20px）；创建时间与注册时间字号统一为 `text-sm`（14px），注册时间双语格式化（中文 `YYYY/MM/DD`，英文 `MM/DD/YYYY`） | `pages/settings/Personalization.tsx` |
| 管理端用户列表 | 表格在「注册时间」后新增「邀请人」与「邀请码」两列（受邀时显示邀请码创建人与码值，未受邀显示 `-`），全表单元格内边距收紧至 `px-2.5` / `10px`，两列均支持点击表头升降序排序；`UserRepo.listUsers` 一次 LEFT JOIN 取回，无 N+1 查询 | `workers/src/db/repos/users.ts`、`frontend/src/pages/admin/Users.tsx` |
| i18n | `admin.settingsRegistration/inviteCodes/invite*`、`admin.users.{invitedBy,inviteCode}`、`auth.inviteCode(Optional)`、`settings.invites.*`（含汇总表 `colUsername`、`colCode`、`colRegisteredAt`、`invitedCount`）中英两份同步 | `lib/i18n/zh.ts` + `en.ts` |
| 测试 | workers `invite-codes.test.ts` 19 例：注册门控矩阵（关闭/关闭带码/必填缺码/格式/错码/有效码/选填无码/同码多人）、核销原子性（FK 失败回滚、无孤儿配额行）、生成权限矩阵（POST/GET 同门禁）、批量格式与唯一性、累计上限、按码聚合、管理端用户列表带出邀请人与邀请码及搜索过滤回归、设置往返与公开透出；前端 `Register.test.tsx` 覆盖率门禁通过 | `workers/tests/`、`frontend/src/pages/` |
| E2E（运行栈实测） | 本地 dev（wrangler + vite + Chromium）：必填开启无码提交显示「注册需要邀请码」、非必填时标注「邀请码（选填）」、错码显示「邀请码无效」；admin 生成命名码 `T2UHJ9/e2e-verify`（已生成 3/5、名称输入清空、新码置顶），该码注册 `e2e_invitee` 成功（跳 `/login?registered=1`）；管理端用户管理表格 8 列核对（内边距 10px，`e2e_invitee` 行带出邀请人 `admin` 与邀请码 `T2UHJ9`，未受邀显示 `-`）；个性化设置卡片双 Tab（邀请码 / 邀请的人）切换正常，两表共享 `INVITE_GRID` 像素级对齐、行距与时间字号一致 | 浏览器实测 + vision 识图核对 |
| **越权加固（按管理员 / 普通用户 / guest 分档复查后修复）** | ① **生成门禁补开关**：`canGenerateInvites` 原先只判 `invite_generation`，机制关闭时普通用户仍能调 API 铸码（UI 隐藏、API 放行）。改为三档：管理员恒可（可在开启前预生成）、**guest 角色一律不可**（仅下载的受限角色签发邀请码等同授予注册能力）、其余用户须 `invite_enabled && all_users`；前端 `canGenerateInvites` 同步分档，API 与 UI 同口径。② **数量上限收敛为单事务**：`countByUser` + `create` 原为事务外先查后写，并发请求各自读到同一计数可越过 `invite_max_per_user`（TOCTOU）；现包进 `db.transaction`，`InviteRepo` 写入面放宽为 `Db \| Tx`。③ 已核实无洞：注册 `role: 'user'` 硬编码且 schema 非 passthrough（`role: 'admin'` 注入无效）、`invited_by_code_id` 仅来自按码查库结果、`userRole` 取自 DB 行并与 JWT 交叉校验、`listByUser`/`listInvitedUsers` 均按自身码收敛、用户自助接口不可改角色与核销关系、自由模式不签 `auth_token` 故无法触达 `/api/invites` | `services/invites/invites.ts`、`services/invites/handlers.ts`、`db/repos/invites.ts`、`pages/settings/Personalization.tsx` |
| 越权回归测试 | `invite-codes.test.ts` 增至 25 例，新增 6 例：关闭机制时普通用户 POST/GET 均 403 而管理员 201、guest 角色在「开启 + all_users」下仍 403、admin_only 双条件（开关 + 权限）下 403/201、注册 body 注入 `role: 'admin'` 仍建普通用户、**并发生成不越过上限**（两个并发请求仅一个 201 且库中仅 1 条）、用户自助接口无法改角色/核销关系；同步把 3 个编码旧宽松契约的既有用例改为「普通用户生成须先开启机制」，并让管理端用户列表用例不再依赖管理员累计码数（上限放开至 100） | `workers/tests/invite-codes.test.ts` |

### 2026-09-30 追加五：管理端编辑用户支持重置密码

| 项 | 实现 | 关键落点 |
| :--- | :--- | :--- |
| 契约 | `PUT /api/admin/users/:id` 新增可选 `password`（8–128 位；空串 = 不修改），与既有 `role/status/defaultPath/maxStorage/maxFiles/capabilities/permissions` 同一入口；响应回显 `passwordChanged` | `admin/schemas.ts`、`admin/handlers.ts`、docs/API(_CN).md |
| 安全语义 | 走 bcrypt `hashPassword`（与用户端改密同源）；**改密递增 `session_version`**，该用户已签发 JWT 立即失效需重新登录；每次改密写 `admin_password_reset` 审计（`auditActionGroup` 未知动作保守归 `admin` 分组，日志只记操作者/对象用户/路径，不含密码）；非管理员调用仍被 `adminMiddleware` 403 | `admin/handlers.ts`、`utils/crypto.ts` |
| 前端 | 用户管理编辑弹窗在存储上限/文件上限之后以分隔线划出「重置密码」分区（placeholder「留空则不修改」+ 会话失效提示），打开弹窗时清空；提交前前端先拦长度不足 8 位（后端 schema 同步强校验）；`admin.users.newPassword(Placeholder/Hint)`、`passwordTooShort` 中英两份 | `pages/admin/Users.tsx`、`lib/i18n/{zh,en}.ts`、docs/UI(_CN).md |
| 测试 | 新增 `admin-user-password.test.ts` 6 例：改密后新密码可登录且旧密码 401、会话版本递增且旧 JWT 401、空串不改密（哈希与在途会话均保留）、不足 8 位 400 且不落库、审计留痕且日志不含密码、非管理员 403 | `workers/tests/admin-user-password.test.ts` |
| E2E（运行栈实测） | 管理端打开 `tester01` 编辑弹窗 → 「重置密码」分区可见（`type=password`、placeholder「留空则不修改」、`autocomplete=new-password`）；填 `short7c` 保存被前端拦下（弹窗不关、toast「密码长度至少 8 位」）；填 `e2e-reset-pass-2026` 保存成功、弹窗关闭、列表不变；随后 `tester01` 旧密码登录 **401**、新密码登录 **200**；D1 查到审计行 `admin_password_reset` | 浏览器实测 + DB 核对 |

### 2026-09-30 追加四：验证码分段输入 + 用量展示样式 + 动效复刻批次（§37）

| 项 | 变更 | 关键落点 |
| :--- | :--- | :--- |
| 验证码 6 位统一 | 三处邮箱验证码（注册 / 改密 / 换绑）统一走新增的 `randomDigits(6)`：CSPRNG **逐字节拒绝采样**（剔除 ≥250 的取值）消除 `% 10` 偏置；改密与换绑两处从 `Math.random` 换到 CSPRNG（与注册 OTP 同源），schema 正则同步 `^\d{6}$` | `workers/src/utils/crypto.ts` 新增 `randomDigits`；`services/auth/handlers.ts`、`services/users/handlers.ts`、`services/{auth,users}/schemas.ts`；`workers/tests/password-code.test.ts`、`security-harden.test.ts` |
| OTP 分段输入 | `InputOTP` 重写：默认 6 位；新增 `mode="alphanumeric"`（邀请码 `[0-9A-Z]` 自动大写）、`error` 抖动态、`ariaLabelKey`；格子 `flex-1` 拉伸（原固定 w-9），native input 文本透明 + 覆盖层绘制字符；动效复刻 interior.dev / moumenlab（字符浮入 220ms、激活格 1.06s 闪烁光标、错误整行抖动 320ms），**功能性微反馈 → 默认档位即生效** | `frontend/src/components/ui/input-otp.tsx` 全量重写、`index.css`「OTP 分段输入」小节、`input-otp.test.tsx` |
| 注册页 OTP 行 | 邮箱框独占一行，其下**常驻**「OTP ＋ 右侧发送验证码按钮」行（总宽与邮箱框一致，实测 384 = 384）；发送按钮从邮箱行移到此行；邀请码改用 `InputOTP`（alphanumeric）+ 格式说明；`INVALID_OTP` 触发抖动恢复。**改邮箱/改密两处同样接上 OTP**（此前改邮箱的 OTP 仅在发码后出现） | `pages/Register.tsx`、`pages/settings/Personalization.tsx`、`pages/Register.test.tsx` |
| 用量展示样式 | 个性化「主题」卡新增**用量展示样式**（进度条 / 运动圆环）二选一，与文件图标风格、文件夹显示同卡；独占整行、两个选项左右并列（`sm:col-span-2` + `grid-cols-2`）；个人资料卡与右上角头像菜单共用 `UsageDisplay` | `stores/theme.ts` 新增 `usageStyle`；新文件 `components/ui/usage.tsx`；`widgets.tsx`、`Personalization.tsx`、i18n 两份 |
| 运动圆环卡片 | 复刻 kokonutui apple-activity-card：外环=存储（红）/ 内环=文件（青），渐变描边 + 圆头 + 灰轨，**环间 4px 空隙**（Apple 紧凑嵌套）；布局为**文字紧贴环左侧、文字右对齐、整块右对齐卡片**，两行（实际四行）文本与环盒同高；绘制动效（`stroke-dashoffset` 逐环 160ms 错峰 + 整环 scale 0.8 淡入 + 信息列滑入）**按图表归类 → 默认档位即生效** | `components/ui/usage.tsx`、`index.css`「用量展示」小节 |
| 圆环不渲染的坑 | React `useId()` 返回带冒号的 id（`:r0:`），拼进 `url(#…)` 片段引用解析失败 → 圆环只剩灰轨。清洗为 `[a-zA-Z0-9_-]` 后正常 | `components/ui/usage.tsx` |
| Toast 堆叠 | 从 HeroUI v3 顶部堆叠改为 **Sonner 式右下堆叠**（transitions.dev banner-stacking 复刻）：356px 右下固定，最新在底 depth 0，后方层上移 12px 露沿 + 0.06/层缩小 + 微模糊，最多 3 条、第 4 条触发最旧退场；入场 `is-enter` + `useLayoutEffect` 强制 reflow 同任务释放；悬停**几何判定**展开（间隙无元素，`:hover` 覆盖不到）并暂停计时。**深度层不改卡片透明度**（只位移/缩放/模糊）。**关闭档不堆叠**（竖直静态列表 + 立即移除） | `components/ui/toast.tsx` 全量重写、`index.css`「Toast 堆叠」小节 |
| 开关双回弹 | 复刻 transitions.dev toggle：拇指走 CSS `translate` + `--switch-travel`（sm 8 / default 12 / lg 20px），默认档普通位移过渡，**「全部动画」档**叠加 overshoot 双回弹 keyframes（350ms + `cubic-bezier(0.34,1.35,0.64,1)`），`is-init` 门控（首次交互后才播，避免挂载即播 off 动画） | `components/ui/core.tsx` `Switch`、`index.css`「开关」小节 |
| 按钮加载态 | 复刻 interior.dev loading-button：内容面与加载面（spinner + 同文案）作为 **grid 同格叠放**的两个面，容器宽度 = 最宽面 → **进入加载不改变按钮宽度**（实测恒定 84px）；交叉淡化 220ms（opacity + 3px 位移 + 3px 模糊），走全局时长门控（关闭档瞬时切换）；加载中置 `aria-busy` | `components/ui/core.tsx` `Button`、`index.css`「按钮加载态」小节 |
| 验证 | 浏览器实测：注册页 OTP 行宽度 384 = 邮箱框 384；头像菜单正常展开（含双环，4 个 circle）；toast 堆叠 depth 0/1/2 顶部 842/829/820（后方各上移 ~11px 露沿）；关闭档 0 个堆叠 banner + 3 条平铺竖列 + 圆环动画 0.01ms；开关回弹 `switch-bounce-on` 0.35s；按钮加载前后宽度均 84px、aria-busy 切换。测试：workers 75 文件 / 652 例、前端 11 文件 / 70 例、覆盖率门禁与构建全绿 | 本地 dev 栈（wrangler 8787 + vite 5173）、`bun run test` / `test:coverage` / `build` |

### 2026-09-30 追加五：Toast 玻璃层级修复 + 品牌资源缓存 + 管理端排序（§38）

| 项 | 变更 | 关键落点 |
| :--- | :--- | :--- |
| Toast 玻璃面归位（三档统一） | 用户实测「**还是透明的，按理说不该透而是模糊**」。根因三重，逐条修复：① `.toast-banner` 是带 `transform` 的定位容器，其内再套一层带 `backdrop-filter` 的卡片 → Chromium 把子元素的 backdrop-filter 提升为**自身**背景采样，页面内容采样不到，磨砂静默失效。改为 **banner 自身就是玻璃面**（`glass-surface glass-blur`），删除内层卡片容器。② 移除 `will-change: transform, opacity`（升格合成层同样截断采样）。③ **弃用 `glass-surface-popover`**——该类专供「悬在白卡之上」的弹层，会把不透明度再让 0.12（下限 0.5），比卡片更透；toast 属独立浮层，改走与卡片/侧栏/顶栏同一大表面配方。实测三档：off = `rgb(255,255,255)` + `backdrop: none`；default = `rgba(255,255,255,0.72)` + `blur(20px) saturate(1.5)`；frosted（有壁纸）= `rgba(255,255,255,0.6)` + `blur(16px)`；另补 `.no-blur .glass-surface` 实底规则 | `frontend/src/components/ui/toast.tsx`、`frontend/src/index.css`「Toast 堆叠」小节 |
| 后方层不再透字 | 半透明玻璃叠半透明玻璃时，后方层照常渲染文字会形成「重影脏字」。折叠态 `reveal = isFront \|\| spread` 为假时内容层 `opacity-0 pointer-events-none`，只露干净磨砂上沿；悬停展开后内容淡入。浏览器实测折叠态「无重叠文字透出」、展开态 5 条内容全清晰 | 同上 |
| 多条堆叠不限条数 | 移除「第 4 条到达即把最旧一条打 `leaving` 移除」的硬上限（用户：可以多个堆叠，只是**堆叠层最多为 3**，多了不显示堆叠但展开显示）。改为队列不限条，折叠态仅 depth 0/1/2 可见（`opacity: 1`），depth ≥ 3 隐藏（`opacity: 0` + `pointer-events: none`）；悬停展开时**全部**可见，位移按各自 `ResizeObserver` 实测高度累加 | `frontend/src/components/ui/toast.tsx` |
| 品牌资源持久化缓存 | 新增 `frontend/src/lib/image-cache.ts`：Logo / Favicon / 用户头像加载成功后以 **Data URL（base64）写入 `localStorage`**（键 `picumet:asset:<kind>`，含原 URL + 时间戳）；刷新时首帧**同步**读缓存渲染，**零网络请求**；仅当配置 URL 变化才重拉并替换（2MB 上限 + 存储失败静默） | `frontend/src/lib/image-cache.ts`、`Logo.tsx`、`widgets.tsx`（`Avatar`）、`stores/site.ts` |
| 头像加载修复（CORS） | 用户反馈「头像加载不出来，如果不是网络问题」。定位：头像外链 `https://gastigado.cnies.org/d/elements/bdrabbit.jpg` **302 → my.microsoftpersonalcontent.com 带 tempauth 的临时地址且无 CORS 头** → 浏览器 `fetch` 抛 `TypeError: Failed to fetch`；Canvas 兜底设了 `crossOrigin='anonymous'` 反而把 `<img>` 一并打成不可用（实测 `IMAGE ONERROR FAILED (CORS BLOCKED)`）。修复三步：① **`site-asset` 中转新增 `kind=avatar`**，只中转 `users.avatar_url` 中**已登记**的地址（`SELECT id FROM users WHERE avatar_url = ?`），仍走 `validateEndpoint` + 逐跳重定向校验 + 8MB 上限（防开放代理不开口子）；② 前端一律经 `assetProxyUrl()` **同源**拉取，绕开 CORS 与防盗链并复用边缘缓存（`max-age=604800`）；③ 四级回落 `Data URL 缓存 → 中转地址 → 原始外链 → 首字母头像`，加载失败不卡死错误态。实测 `src` 落 `data:image/jpeg;base64,…`、`naturalWidth 1080` | `workers/src/services/public/site-asset.ts`、`frontend/src/lib/image-cache.ts`、`Logo.tsx`、`widgets.tsx` |
| Favicon 默认图标 | 未配置 favicon 时使用 **Picumet 默认图标**（左上角 Logo 去掉文字的矢量图），并落地静态文件 `frontend/public/favicon.svg`（此前 `index.html` 引用 `/favicon.svg` 但文件缺失）；配置的自定义 favicon 加载失败亦回落该默认图标；`stores/site.ts` 抽出 `applyFavicon()`，先查缓存 → `Image` 探测成功后 `cacheAsset` → 失败回落默认 | `frontend/public/favicon.svg`、`frontend/src/stores/site.ts`、`frontend/src/lib/image-cache.ts` |
| 左上角 Logo 尺寸 32 | `AppShell` / `Landing` / `FreeMode` 三处顶栏 Logo 由 `size={40}` 改为 `size={32}`（登录/注册等居中页保持 48，浏览/分享页 24） | `AppShell.tsx`、`Landing.tsx`、`FreeMode.tsx` |
| 管理端「安全设置」上移 | 系统设置页左列改为 **站点 → 安全 → 日志审计 → 访问统计**，右列 公告 / 注册 / SMTP；「安全设置」卡从右列末尾（`revealDelay(6)`）移到左列第 2 位并整体重排 reveal 序号（站点 0 / 安全 1 / 日志 2 / 统计 3 / 公告 4 / 注册 5 / SMTP 6），卡内 `innerDelay` 序号同步。浏览器实测卡片顺序为 `["站点设置","安全设置","日志审计","访问统计","公告","注册设置","SMTP 邮件"]` | `frontend/src/pages/admin/Settings.tsx` |
| 验证 | 浏览器实测：头像正常加载（`data:image/jpeg;base64,…` naturalWidth 1080）；toast 三档玻璃参数与卡片一致且**毛玻璃真正生效**（视口截图经视觉核对：卡片叠在设置项上、背后内容被虚化）；折叠态无透字、展开态 5 条全清晰；顶栏 Logo `styleH: 32px`；管理端卡片顺序如上。测试：workers **75 文件 / 656 例**（新增 `site-asset.test.ts` 头像中转 4 例）、前端 11 文件 / 70 例，两端 `tsc --noEmit` 与 `bun run build` 全绿 | 本地 dev 栈（wrangler 8787 + vite 5173）、`bun run test` / `typecheck` / `build` |

### 2026-09-30 追加六：复选框 shadcn 基准 + spring-check 勾选动效（§39）

| 项 | 变更 | 关键落点 |
| :--- | :--- | :--- |
| 基准样式对齐 shadcn | 按 shadcn `radix-nova` 复选框重做：`size-4` + `rounded-[4px]` + `border border-input` + `focus-visible:ring-[3px] ring-ring/50` + `after:absolute after:-inset-x-3 after:-inset-y-2`。命中区实测由 16×16 扩到 **40×32**（Tailwind `after:*` 工具类自带 `content: var(--tw-content)`，基类默认 `--tw-content: ""`，无需另写 `content-*`）；未选态仍走项目小型控件玻璃配方（`glass-control` + `--glass-alpha`） | `frontend/src/components/ui/checkbox.tsx` |
| 默认档复刻 shadcn 原生动画 | shadcn 默认动效 = 元素自身 `transition-colors` + **指示器 `transition-none`（无图标动画）**。实测默认档 `transition-property` 仅 `color, background-color, border-color`，勾选 60ms 内瞬时到位 | `index.css`「复选框」小节 |
| 「全部动画」档复刻 spring-check | 引入项目首个 **`@property`**：把进度量 `--cb-t` 注册为 `<number>`（未注册的自定义属性不可插值），由它推导四路读数（同 reactbits `readings()`）：`fill = scale(max(0,var(--cb-t)))`（自中心涨出、**过冲涨过满格**）、`box = scale(1 + 0.35·max(0,var(--cb-t)-1))`（盒体随过冲微涨，SWELL 系数同源）、`tick` 用 `pathLength=1` 归一化后 `stroke-dashoffset: calc(1 - clamp(0,var(--cb-t),1))` 描边画出/收回、`word` 明暗。缓动 `cubic-bezier(0.34,1.9,0.64,1)` 460ms。**实测过冲峰值 1.213 = spring-check `bounce=0.2` 的 20% 过冲**（box 峰值 1.075 ≈ 1+0.35×0.2；`t=0.5` 冻结时对勾正好画一半）。组件侧零档位分支，四路读数全在 CSS | `index.css`、`components/ui/checkbox.tsx` |
| 文字明暗按项目语义反转 | spring-check 是「待办」隐喻（勾选 = 完成 → 文字变淡 + 删除线）；本项目是「开关」隐喻，故**反转为未勾选变淡（0.45）、勾选恢复正常（1）**，且**两个方向都不画删除线**（`text-decoration: none`，`strike` 线不移植）。`CheckboxWithLabel` 把 `data-checked` 放包裹层，`--cb-t` 经 `@property{inherits:true}` 继承给复选框与文字。实测：未选 0.45 / 已选 1 / 两态 `text-decoration-line: none` | `index.css`、`components/ui/checkbox.tsx` |
| 两个过渡声明坑 | ① 不写 Tailwind `transition-colors` 类——utilities 层与 `.cb`（components 层）同优先级且后出现会覆盖掉 `--cb-t` 过渡，颜色过渡改在 `index.css` 声明；② `[data-motion='all'] .cb`（0,2,0）盖过同元素 `.transition-opacity`，**必须把 `opacity` 列入该过渡**，否则文件页选择框悬停淡入退化瞬变（`explorer.tsx`）。按下反馈另用 `--cb-press`(0.92) + `:active` 免 JS 分离 | `index.css` |
| 验证 | 浏览器实测：三档 transition-property 分别为 `…, --cb-t` / 仅三色 / 仅三色；弹簧轨迹 `--cb-t` 0→1.213→1 与 fill/box 同步；放大 10× 目视对勾完整、`t=0.5` 半画；命中区 40×32；文字明暗 `0.45 → 1` 且无删除线。测试：前端 **12 文件 / 76 例**、`tsc --noEmit` 与 `bun run build` 全绿 | 本地 dev 栈（wrangler 8787 + vite 5173） |

### 2026-09-30 追加三：Umami 访问统计（Phase 4）

按「即将规划 — Umami 访问统计」原方案全量落地（规划文本已移除；契约见 API/ARCHITECTURE/UI 文档）。官方语义经 Context7 MCP 核实（`/websites/umami_is`，docs.umami.is）：tracker 以 `data-website-id` / `data-host-url` / `data-domains` / `data-performance` / `data-exclude-search` / `data-do-not-track` 配置，`umami.track(event, data)` 上报自定义事件、**事件名上限 50 字符且有事件名才带数据**，SPA 页面浏览由 tracker 自动记录。

| 项 | 实现 | 关键落点 |
| :--- | :--- | :--- |
| 迁移 0011 | 9 个设置种子键（`stats_source` / `umami_enabled` / `umami_script_url` / `umami_website_id` / `umami_host_url` / `umami_domains` / `umami_performance` / `umami_exclude_search` / `umami_do_not_track`），仅种子行无表结构变更，含回滚注释 | `workers/migrations/0011_umami.sql` |
| 校验与装配（单一事实源） | `validateUmamiUrl`（仅 `http(s):`、无内嵌凭据、无 fragment、≤500 字符；`http` 仅回环主机本地联调——**不套用 `validateEndpoint` 的私网/端口白名单**：脚本由浏览器加载、无 SSRF 面，本地实例常跑非标端口）、`isUmamiWebsiteId`（UUID）、`validateUmamiDomains`（逗号分隔裸 hostname，借 URL 解析器拒 scheme/路径/端口/凭据）、`resolveUmamiPublicConfig`（来源+开关+复核三道门才下发，否则 null；可选 hostUrl/domains 脏值只丢该项）、`UMAMI_SETTINGS_MAP`（兼审计筛选用键集合） | `workers/src/utils/umami.ts` |
| 管理端写入口 | `SettingsSchema` 增 9 字段（URL/UUID/域名 refine，''/null = 清空）；`statsSource='umami'` 时按**落库后生效值**校验脚本地址与 Website ID，缺失/无效 → 400（否则公开面静默不注入，管理员以为开了）；命中任一访问统计面键的保存写 `settings_update` 审计日志（记键不记值）；`save()` 改为透传后端错误文案 | `admin/schemas.ts`、`admin/handlers.ts`、`admin/Settings.tsx` |
| 公开配置 | `GET /api/public/settings` 增 `umami` 字段（`null` = 不注入）；下发前经 `resolveUmamiPublicConfig` 复核，DB 落脏值也不注入 | `public/handlers.ts`、`shared/types.ts` |
| 前端注入器 | `document.createElement` + `setAttribute` 注入 `defer` 脚本，六个白名单 `data-*` 逐个挑选（`data-before-send` 这类指向全局函数名的事件面不支持）；幂等（页面生命周期只注入一次）；`trackUmami` 事件名截断到 50 字符、tracker 未就绪静默 no-op、异常不影响业务；**只按本次服务端响应注入**（不吃 localStorage 缓存——管理员关掉后不得凭旧值注入） | `frontend/src/lib/umami.ts`、`stores/site.ts` |
| 事件接线 | 文件下载（`file_download`，带文件名/大小）、分享页下载（`share_download`，同款数据）、复制链接三处（弹窗/单文件/批量，均 `copy_link`） | `pages/Files.tsx`、`pages/SharePage.tsx` |
| 管理端「访问统计」卡 | 来源二选一（`D1 审计日志` / `Umami 前端统计`），选 Umami 时才展开脚本面：启用开关、脚本地址、Website ID、上报地址、域名白名单 + 三个采集行为开关（性能指标/排除搜索参数/遵循 DNT）；保存失败透传后端文案。卡片布局：左栏 站点/日志审计/访问统计，右栏 公告/注册设置/SMTP/安全（日志审计自安全卡独立成卡，限流留在安全卡） | `pages/admin/Settings.tsx`、`lib/i18n/{zh,en}.ts` |
| 测试 | workers `umami-settings.test.ts` 16 例：URL 校验矩阵（https 任意主机/http 仅回环/非 http(s)/凭据/fragment/超长/空）、UUID、域名白名单矩阵、公开装配四道门 + 可选项脏值丢弃、`SettingsSchema` 整表单接受与 4 类拒绝、来源切 umami 未配置 → 400、配置完整 PATCH/GET 往返 + 公开下发、写入口审计行、来源切回 d1 后公开为 null；前端 `lib/umami.test.ts` 8 例：未启用不注入、属性白名单（含未知键不落到脚本）、幂等、事件转发/截断/空名、tracker 未就绪 no-op | `workers/tests/umami-settings.test.ts`、`frontend/src/lib/umami.test.ts` |
| E2E（运行栈实测） | 本地 dev（wrangler + vite + Chromium + 假 umami 实例 `http://localhost:9999/script.js`）：管理端 API 配置后公开下发完整 `umami` 配置；文件页真实加载注入 `script[data-website-id]`（属性实测恰为 src/defer/data-website-id/data-domains/data-exclude-search/data-performance，无 data-before-send）且假脚本执行成功；行菜单点「下载」产生 `file_download`（`{ name: "README_CN.md", size: 6884 }`），网关随之 200；来源切回 `d1` 后公开 `umami` 为 null、0 注入、脚本不加载 | 浏览器实测 + API 日志核对 |
| 已知边界 | `public_cdn` 外链直读不经页面，JS 无法统计（仍依赖网关审计或未来的热文件检测）；SPA 页面当前无 CSP（Pages 承载、仓库无 `_headers`/meta CSP），tracker 无需放行即可工作，将来给 Pages 加 CSP 需定方案（已记为待决项，见架构文档安全设计） | docs/ARCHITECTURE(_CN).md |
### 2026-09-30 追加八：复选框无白边 + 日志列宽 + DatePicker 弹出式交互与首帧直出（§40）

| 项 | 变更 | 关键落点 |
| :--- | :--- | :--- |
| 复选框去掉白边轮廓 | `Checkbox` 勾选态改走 `border border-primary bg-primary text-primary-foreground` 一体化纯色，删除多余的内衬 `.cb-fill` 图层，消除按钮内边框与填充层之间的缝隙与双重轮廓。全站 4 处裸 `<input type="checkbox">` 与 2 处手动 label 全部迁移至 `<CheckboxWithLabel>`（`admin/Users.tsx` 4 处、`admin/storage/Mounts.tsx` 2 处、`admin/Permissions.tsx`、`settings/ApiKeys.tsx`） | `components/ui/checkbox.tsx`、`index.css`、`Users.tsx`、`Mounts.tsx`、`Permissions.tsx`、`ApiKeys.tsx` |
| 日志审计第一列列宽 | `LOG_ROW_GRID` 第一列（操作）由 `104px` 拓宽至 **`168px`**，长操作名（如 `sso_provider_create` 19 字符）不再溢出侵入第二列「路径」，表头与表体双表对齐保持一致 | `pages/admin/Logs.tsx` |
| 3D 滚轮日期选择器重构 | 新增 `components/ui/date-picker.tsx`（导出 `DatePicker`、`DateRangePicker`、`WheelPicker`）：① **弹出式交互**：点击类似下拉菜单的触发输入框在 body Portal 弹出 3D 滚轮浮层（取代直接内嵌巨型滚轮导致挤占卡片高度的缺陷）；② **首帧直出**：解决滚轮数字空白问题——彻底移除 `mask-image`（Chromium 遇到 mask-image 会把 3D 上下文压平成 2D 并隐形数字），移除全局 `backface-visibility: hidden`；容器声明 `w-full shrink-0` 结合内联高度 160px（**禁止使用 `flex-1 min-w-0`**，它在 `flex-col` 父级内会触发垂直轴 `flex-basis: 0%` 导致高度被压垮为 0px 并被 `overflow-hidden` 全切）；首帧在 JSX 样式直算并在 `useLayoutEffect` 中同步刷入 `paint()`；③ **渐变透明度自中间向两端增大**（中间 100% 不透明、向上下边缘平滑淡化至 0% 完全透明）：彻底移除上下实底白块覆盖条，由 `Math.max(0, 1 - (dist / cutoff) ** 1.35)` 纯净驱动，杜绝遮盖数字的刺眼白块；④ **单套字体体系**：删除原版两套重叠的 `<ul>`，所有项使用单套 `text-base`（16px）基线，激活项居中动态赋予 primary 色与 700 字重，彻底消除双重列表导致的重影重字；⑤ **激活条去上下线**：中心指示条改为纯色软高亮衬底（`bg-primary/15 rounded-lg`），无上下边框线；⑥ **触发输入框材质对齐**：使用标准 Input 同款 `border border-input bg-transparent dark:bg-input/30 shadow-sm`，无多余二次 `glass-control`，弹窗 `.glass-dialog` 多级模糊自然透出；⑦ **浮层复用规范**：采用 `DROPDOWN_MENU_CLASS`（`shadow-md`、`border border-border/60`、`rounded-xl`），内部无嵌套双重卡片；⑧ **语言自适应排序**：中文 `YYYY/MM/DD`，英文 `MM/DD/YYYY`，时分秒放日期右侧 | `components/ui/date-picker.tsx`、`components/files/ShareDialog.tsx`、`components/share/AdminShareSettingsDialog.tsx`、`pages/admin/Settings.tsx`、`components/charts/TrendCard.tsx`、`lib/i18n/{zh,en}.ts` |
| 全站现有时间组件替换 | ① `ShareDialog.tsx`（创建分享链接）：绝对过期时间从原生 `datetime-local` 替换为 `<DatePicker value={absoluteAt} onChange={setAbsoluteAt} includeTime />`；② `AdminShareSettingsDialog.tsx`（管理端分享设置）：延长时间从 `datetime-local` 替换为 `<DatePicker value={expiresInput} onChange={setExpiresInput} includeTime />`；③ `admin/Settings.tsx`（公告设置）：`until` 截止时间替换为 `<DatePicker value={newUntil} onChange={setNewUntil} includeTime />`；④ `TrendCard.tsx`（仪表盘趋势图自定义区间）：起止日期输入框替换为 `<DateRangePicker from={customInput.from} to={customInput.to} onChange={...} includeTime={false} />`，起止放两个组件，自适应语言日期顺序 | 同上 |
| 验证 | 浏览器实测：① 复选框勾选态纯色一体、无白边轮廓；② 日志审计第一列 168px 实测 `hasCollision: false`；③ DatePicker 触发框与常规 Input 样式 100% 对齐（`bg-transparent dark:bg-input/30 shadow-sm`）；④ 浮层单层一体化无双重卡片盒、中间激活行无上下线条；⑤ 滚轮全部 6 列（年/月/日/时/分/秒）数字清晰可见且单字体无重影；⑥ 语言切换实测中英文日期列顺序与格式回显正确。测试：前端 **12 文件 / 78 例**、workers 75 文件 / 656 例、构建全绿 | 本地 dev 栈（wrangler 8787 + vite 5173） |
### 2026-09-30 追加七：SSO / OIDC 登录（Phase 4，迁移 0012）

按「即将规划 — SSO / OIDC 登录」全量落地。协议面**未引入 Auth.js**（经 Context7 核实官方文档后决策，理由见架构文档「SSO / OIDC 登录服务」）：其 provider 列表是构建期静态配置、自带 session/adapter 表、登录态由它自己签发 Cookie，与本项目「D1 运行时配置 + 自签 JWT Cookie + 自定义补充注册页」三处冲突；改用已有依赖 `jose` + `fetch` 直连实现。服务文档：`workers/src/services/sso/README.md`。

| 项 | 实现 | 关键落点 |
| :--- | :--- | :--- |
| 迁移 0012 | `sso_providers`（`kind` ∈ google/github/oidc、名称、issuer、`client_id`、`client_secret` 密文、单源开关）+ **部分唯一索引** `WHERE kind IN ('google','github')` 保证两者各只有一条 + `sso_identities`（`(provider_id, subject)` 唯一 + `user_id` + 档案快照 + `access_token`/`refresh_token`/`token_type`/`scope`/`expires_at`，外键级联）+ `sso_enabled` 总开关种子键；含回滚注释与索引 EXPLAIN 说明 | `workers/migrations/0012_sso.sql` |
| 协议层 | discovery（KV 缓存 1h，文档里的 authorization/token/jwks/userinfo 端点**逐个复核地址白名单**）、授权跳转（state + PKCE S256 + OIDC nonce）、code 换 token（`token_endpoint_auth_methods_supported` 决定 post/basic）、`id_token` 经 issuer JWKS **本地**验签（`iss`/`aud`/`nonce`，失败不区分原因只写服务端日志）、档案归一化（OIDC claims → sub/email/email_verified/username/display_name/avatar_url，缺 email 回退 userinfo） | `services/sso/oidc.ts` |
| GitHub 特例 | 不签发 `id_token` → OAuth2 web application flow，回调后取 `/user` 与 `/user/emails`，只认 primary 且 `verified` 的邮箱（公开资料邮箱不采信） | `services/sso/oidc.ts` |
| 归属判定 | ① `(provider_id, subject)` 已关联 → 直接登录（刷新凭据与档案快照）② 提供方**已验证**邮箱命中既有账号 → 自动关联并登录（顺带补 `email_verified=1`）③ 其余 → 暂存档案 + 一次性令牌（KV 15 分钟）→ `302` 到前端 `/sso/complete` | `services/sso/handlers.ts` |
| 补充注册 | `GET /api/auth/sso/pending`（只回展示字段，不含令牌）+ `POST /api/auth/sso/complete`：用户**自填**邮箱 / 用户名 / 密码，与 `/register` 同源的注册总闸、邮箱验证码（共用 `email:otp:register:*`，一次消费）、邀请码门控；建号 + 身份关联（令牌加密落库）+ 发放与密码登录**完全相同**的 JWT Cookie | `services/sso/handlers.ts`、`services/auth/session.ts`（抽出 `setAuthCookie` 单一出口） |
| 邮箱验证判定 | 提供方已验证所用邮箱 → 免验证码（等价于邮箱控制权证明）；否则「站点开启邮箱验证 **或** 站点配置了 `smtp_host`」→ 必须通过验证码。`mailAvailable` 直接解析 `smtp_host`（迁移种子把空值写成 JSON 串 `""`，走 `resolveSmtpConfig` 会误判为已配置） | `services/sso/handlers.ts` |
| 管理端 | 「注册设置」卡新增总开关 + 「OIDC 设置」弹窗（形态对齐「默认用户设置」弹窗）：来源列表（名称 / 类型徽章 / **可复制回调地址** / 单源开关 / 编辑 / 删除）+ 内联编辑区（类型 / 名称 / Issuer / Client ID / Secret / Scope / 启用）；`client_secret` 写入不回读（`''`/`******` = 保持原值），列表只回掩码；CRUD 写 `sso_provider_*` 审计（记键不记值），总开关写 `settings_update`；改 issuer/clientId 清 discovery 缓存 | `services/admin/sso.ts`、`pages/admin/SsoProvidersDialog.tsx`、`pages/admin/Settings.tsx` |
| 地址白名单 | issuer 生产口径同 `validateEndpoint`（公网 http(s)、端口 80/443、拒私网/回环/内嵌凭据、issuer 不带 query/fragment），非生产额外放行回环主机与任意端口（本地 IdP 联调）；端点每次请求前复核（DB 脏值也不放行） | `services/sso/config.ts` |
| 公开面与前端 | `GET /api/public/settings` 增 `sso = { enabled, providers:[{id,kind,name}] }`；登录/注册页「使用 {{name}} 继续」按钮（`components/sso-buttons.tsx`，整页跳转 `/api/auth/sso/{id}/start`，关闭或无来源时不渲染）；回调错误只回 `?sso_error=<码>`，文案在前端按码映射；新增页面 `/sso/complete`（用户名/邮箱/验证码行/密码/邀请码 + 「使用 … 提供的信息」一键预填，提交后写 auth store 再跳 `/files`） | `services/public/handlers.ts`、`stores/site.ts`、`components/sso-buttons.tsx`、`pages/SsoComplete.tsx`、`App.tsx`、i18n 两份 |
| 测试 | `workers/tests/sso.test.ts` 22 例（真 RS256 假 IdP + 本地验签）：来源 CRUD 与单例约束、issuer 校验矩阵（回环/私网/非标端口/查询串/生产口径 400）、密钥掩码与保持原值、discovery 缓存失效、级联删除、公开面开关、`/start` 的 state/PKCE/nonce 与 token 请求带 `code_verifier`+`client_secret`、无身份 → 补充注册、验证码建号（令牌 `enc:` 落库可解密）、提供方已验证邮箱自动关联 / 未验证不关联、既有身份直接登录不新建账号、state 一次性与来源不匹配、nonce/aud 不符回码、注册关闭、邀请码必填缺码、提供方已验证免验证码、GitHub 全链路；前端 `pages/SsoComplete.test.tsx` 6 例（预填、验证码门控、邀请码过滤与提交、待办失效错误态、提交失败不跳转） | `workers/tests/sso.test.ts`、`frontend/src/pages/SsoComplete.test.tsx` |
| E2E（运行栈实测） | 本地 dev 栈（wrangler 8787 + vite 5173 + 假 OIDC 提供方 `localhost:9443` + lab SMTP sink 1025 + Chromium）：管理端「注册设置」开总开关 → 「OIDC 设置」新增来源（自定义 OIDC / 公司 SSO / issuer / client id+secret）→ 列表回显掩码与回调地址、PATCH 设置 200、公开设置透出 `sso.enabled=true` 与来源；**未登录上下文**登录页出现「使用 公司 SSO 继续」→ 点击后经 IdP（日志核对：authorize 带 state/nonce/code_challenge、token 带 code_verifier+client_secret、回调前取 JWKS）→ 落到 `/sso/complete`（标题/预填按钮/验证码行/邀请码 6 格全部渲染）→ 一键预填出 `smokeuser` + `smoke.user@idp.test` → 发送验证码（sink 收到邮件，取码）→ 提交 `201` 并跳 `/files`（刷新后仍登录、`/api/auth/me` 200）；D1 核对：`sso_identities` 行 subject=`smoke-subject-1`、`access_token`/`refresh_token` 为 `enc:` 密文、`expires_at` 未来；用户行 `email_verified=1` + 邀请码核销；再次发起同一来源**直接登录**（无补充注册页）。冒烟后已回滚 dev 库的临时来源/用户与总开关 | 浏览器实测 + `docker exec` 读 sink + `wrangler d1 execute --local` 核对 |

### 2026-09-30 追加六：登录支持「用户名或邮箱」

| 项 | 实现 | 关键落点 |
| :--- | :--- | :--- |
| 取用户收敛 | 新增 `UserRepo.findByLoginIdentifier`：裁剪两端空白后**先按用户名精确匹配**（保持既有登录语义与热路径完全不变，用户名大小写敏感），未命中且含 `@` 时按 `lower(email) = lower(?)` 匹配——邮箱列是 BINARY 排序且注册按原样存储，用 SQL 侧小写比对让存量大小写混合邮箱同样能登录（**无需数据迁移**）；查不到返回 null | `db/repos/users.ts` |
| 登录接口 | `/api/auth/login` 改用该方法；**错误形状不变**：标识不存在与密码错误回同一 `401 INVALID_CREDENTIALS`「用户名或密码错误」，`login_failed` 审计照常落库（标识已解析到用户时带 `user_id`，便于按用户排查）。请求体字段名仍为 `username`（兼容约 20 个测试文件与既有客户端），语义在 schema 注释与文档中明确为「登录标识」 | `services/auth/handlers.ts`、`services/auth/schemas.ts` |
| 登录页 | 首个输入框改为「用户名或邮箱」（`login.identifier` + `login.identifierPlaceholder`，`autoComplete="username"`，提交前裁剪空白）；新增 key 而非改 `login.username`——后者被注册页、SSO 完成页、SMTP 用户名、WebDAV 凭据文案共用，改值会误伤 | `pages/Login.tsx`、`lib/i18n/{zh,en}.ts` |
| 测试 | 新增 `login-identifier.test.ts` 8 例：用户名登录回归、邮箱登录回填同一账号、邮箱大小写无关（`Li.Mixed@Test.local` 用小写登录）、两端空白裁剪、邮箱+错密码 401、不存在标识/错密码/不存在邮箱三者错误码与文案完全一致（无账号枚举）、`login_failed` 审计落库且带 `user_id`、空串 400 与纯空白统一 401 | `workers/tests/login-identifier.test.ts` |
| E2E（运行栈实测） | 登录页标签「用户名或邮箱」、placeholder `username / name@example.com`、`autocomplete=username`；邮箱 `tester01@test.local` 登录跳 `/files`；`  tester01  `（两侧空白）用户名登录同样成功；`TESTER01@TEST.LOCAL` 大写邮箱登录 **200**；不存在的邮箱与错误密码均为 **401 + INVALID_CREDENTIALS +「用户名或密码错误」**（三者一致） | 浏览器实测 + API 核对 |
| 过程中修正的一处实现缺陷 | 最初把邮箱回退写成「输入转小写后精确查」，方向反了（注册按原样存储，转小写反而查不到大小写混合邮箱）——首轮测试即以「大小写无关登录 401」暴露，改为 SQL 侧 `lower(email)` 比对后通过 | 同 `db/repos/users.ts` |

### 2026-09-30 追加八：SSO / OIDC 安全审计修复（迁移 0013）

按 `code-audit` skill（standard 模式：10 维覆盖矩阵 + JS/TS 语义提示）对本批 SSO 面做了一次审计：自审（sink 驱动：SQL 参数化、`fetch` 目标、React DOM sink、`??`/`||` 空值口径、`jwtVerify` 算法面）+ 独立 `security-reviewer` 子代理对抗式复查（枚举端点与分支 → 逐一验证可达性，产出 9 项发现，其中「无发现」的维度也给出证据）。全部发现已落地修复，每项都有回归测试。

| 发现（严重度） | 修复 | 证据 / 关键落点 |
| :--- | :--- | :--- |
| **H1 授权事务未与发起浏览器绑定**：`state` 与 pending 令牌只存在 KV 与 URL 里，任何浏览器拿到回调/补注册链接都能完成登录 → 攻击者用自己的账号跑完授权、把链接丢给受害者，受害者即获得**攻击者账号**的会话（登录 CSRF / 会话固定，CWE-352/384）；pending 令牌同理会把身份关联到攻击者的 subject | `/start` 追加 `sso_tx` 绑定 Cookie（值 = state，HttpOnly + `SameSite=Lax`（回调是跨站顶层 GET，Strict 会丢）+ Path 限 `/api/auth/sso`），回调必须携带同值 Cookie（常量时间比较）且**任何回调尝试即作废 state**；回调分支 3 追加 `sso_pending`（值 = 待办令牌），`/pending` 与 `/complete` 都必须携带 | `services/sso/handlers.ts`（`appendBindCookie`/`assertBindCookie`）；`sso.test.ts` 绑定 Cookie 分组 4 例 |
| **M2 验证码判定用提供方档案而非提交值**：提供方验证过 A 邮箱即整场免验证码 → 可用 B 邮箱（他人地址）无验证注册，抢占该地址并套取该用户后续的 SSO 自动关联（账号植入 / 邮箱占地） | `emailVerificationRequired()` 改为以**本次提交的邮箱**为准（`/pending` 用待填档案里的邮箱代表表单值，`/complete` 传真实提交值）；前端同步（用户把邮箱改成非提供方已验证地址时立即显示验证码行） | `services/sso/handlers.ts`、`pages/SsoComplete.tsx`（`otpRowVisible`）；`sso.test.ts` 邮箱验证码分组 + 前端 2 例 |
| **M3 自动关联无条件信任提供方 `email_verified`**：自定义 OIDC 的 issuer 只过地址白名单，若该 IdP 允许自填邮箱并回 `true`，即可接管任意既有账号 | 新增逐来源开关 `sso_providers.trust_email_verified`（迁移 `0013`）：内置 google/github 默认开（端点固定、邮箱验证由提供方保证），自定义 oidc 默认关（需管理员显式开启）；关闭时命中既有账号不关联、落到补充注册页并按 `409 ALREADY_EXISTS` 提示改用密码登录；自动关联另写 `sso_link` 审计 | `migrations/0013_sso_trust.sql`、`db/repos/sso.ts`、`services/admin/sso.ts`、`SsoProvidersDialog.tsx`（开关 + 常驻风险说明）；`sso.test.ts` 信任开关分组 2 例 |
| **M4 邮箱大小写：唯一性精确匹配 / 登录 `lower(email)` 解析**：同一邮箱的大小写变体可建出两个账号，登录按 `lower(email) LIMIT 1` 解析 → 其中一个账号永远登不进去（且自动关联命中错行） | 新增 `UserRepo.findByEmailInsensitive`（`lower(email) = lower(?)`），注册、注册发码、改绑邮箱与 SSO 自动关联/补充注册查重**统一**改走它；`/complete` 对大小写变体返回 `409` | `db/repos/users.ts`、`services/{auth,users,sso}/handlers.ts`；`sso.test.ts` 大小写分组 2 例 |
| **M5 上游请求跟随重定向（SSRF）**：白名单只校验初始地址，恶意/被入侵的提供方可用 302 把带 `client_secret` 的 token 请求或带 Bearer token 的 userinfo 读取引向内网/云元数据；另：userinfo 端点使用时未复检、缓存中的 discovery 未复检 | `fetchJson` 一律 `redirect: 'manual'`，3xx 直接失败（`SSO_UPSTREAM_REDIRECT`）；discovery 缓存读取与 userinfo 使用前均复核地址白名单；文档必须声明 `issuer` 且与配置一致 | `services/sso/oidc.ts`；`sso.test.ts` 上游分组 2 例 |
| **L6 `/pending` 与 `/complete` 不复检 `provider.enabled`**：停用来源的在途令牌仍可建号（最长 15 分钟） | 两处均复检 `enabled`（与 `/start`、`/callback` 同口径） | `services/sso/handlers.ts`；`sso.test.ts` 停用来源 1 例 |
| **L7 pending 上下文把提供方令牌明文写 KV**：与「凭据一律 `enc:` 密文」的既定不变量不一致 | 回调时即加密后再暂存（`tokens: sealed`），`/complete` 直接落库不重复加密 | `services/sso/handlers.ts`；`sso.test.ts` 1 例断言 KV 值不含明文令牌 |
| **L8 非生产 fail-open 默认**：回环 issuer 原先只按 `ENVIRONMENT !== 'production'` 放行——`ENVIRONMENT` 拼错（`prod`/未设置）就会在生产静默开放回环 SSRF 面 | 改为必须显式 `SSO_ALLOW_LOOPBACK=true` **且**非生产；`wrangler.toml [vars]` / `.dev.vars.example` 加该变量（生产不设） | `services/sso/config.ts`、`shared/types.ts`、`wrangler.toml`；`sso.test.ts` 1 例（生产带开关仍拒；`prod` 未开开关拒；非生产+开关放行） |
| **I9 空值口径不一致**：`scopes: ''` 创建时落库、更新时归一为 `null`（`/start` 把 `''` 当已设置并发出空 scope）；`clientSecret: ''`「保持原值」契约因 schema `.min(1)` 不可达（死分支）；discovery 文档缺 `issuer` 时跳过一致性校验 | 创建/更新统一 `scopes?.trim() \|\| null`；`/start` 再兜一层 `\|\| DEFAULT_SCOPES[kind]`；更新 schema 显式放宽 `clientSecret` 允许空串（契约可达）；文档必须声明 `issuer` | `services/sso/schemas.ts`、`services/admin/sso.ts`、`services/sso/handlers.ts`；`sso.test.ts` 更新来源 1 例 + 空 scope 1 例 |

**审计中经实测抓到的一处实现缺陷（对「安全修复」自身的回归）**：绑定校验最初无条件清 Cookie，导致 `GET /pending` 一读就把 `sso_pending` 清掉，后续真实建号的那次 `POST /complete` 必然 `SSO_PENDING_INVALID`——单元测试没抓到是因为测试侧的「浏览器」始终拿着自己记的 Cookie 值替实现兜底。修复为「只在失败时清、`sso_tx` 通过校验后清、`sso_pending` 成功建号后清」，并把测试 harness 升级为**极简 Cookie jar**（响应里删掉的 Cookie，测试侧也一并忘掉），补 1 例覆盖「`/pending` 与失败的 `/complete` 之后 Cookie 仍可用、成功后失效」。运行栈实测全链路重新通过（见下）。

**覆盖矩阵**（standard）：D1 注入 ✅（仓内 SQL 全参数化，`sso` 仓库 SET 子句来自静态列映射，值走占位符）、D2 认证 ✅、D3 授权 ✅（含逐端点的 admin 路由 + 绑定 Cookie + 停用复检）、D4 原型污染 ✅（zod 非 strict 剥离未知键；无 `Object.assign(req.body)`）、D5 文件操作 ➖（该面无文件路径入参）、D6 SSRF ✅、D7 加密 ✅（`enc:` AES-GCM、jose 验签挡算法混淆、CSPRNG 令牌）、D8 配置 ✅（新错误码不回内部细节；fail-open 默认已收紧）、D9 业务逻辑 ✅（登录 CSRF、验证码基准、流程跳过、Mass Assignment、XSS sink）、D10 供应链 ➖（未新增依赖）。

**E2E（运行栈实测，审计修复后重跑）**：本地 dev 栈（wrangler 8787 + vite 5173 + 假 OIDC 提供方 9443 + lab SMTP sink 1025 + Chromium）——登录页 SSO 按钮 → IdP（state/nonce/PKCE/code_verifier/client_secret/JWKS 全链路）→ `/sso/complete` 表单渲染（证明 `sso_pending` 经 Vite 代理正确回传）→ **负向实测**：清掉绑定 Cookie 后用同一令牌请求 `/pending` 与 `/complete` 均 `400 SSO_PENDING_INVALID`（链接转发不再可用，且未建任何账号）→ 重新走完整流程（预填 → 邀请码 `WQ0BB0` → 从 sink 取 OTP）`POST /api/auth/sso/complete` **201** 并落地 `/files`，D1 核对 `sso_identities` 令牌为 `enc:` 密文、用户 `email_verified=1` + 邀请码核销。冒烟后已回滚 dev 库的临时来源/用户与总开关。



### 2026-09-30 追加九：变更范围测试覆盖审计（只读盘点 + 两处真实缺口回归）

对「相对上一提交的全部未提交变更」做了一次变更范围测试覆盖审计：先按 `git status` / `git diff` 划定变更面（**审计快照**为 59 改 + 33 新增目录项 / 42 个未跟踪文件，前端 / workers / docs 三分；本条批次内该面仍在变动，数字以快照为准），再逐个变更源文件核对**行为**是否被现有用例触达，而非只看文件是否存在。

| 项 | 结论 | 证据 |
| :--- | :--- | :--- |
| 覆盖良好（无需补测） | 邀请码（注册门控矩阵 / 核销原子性 / 三档越权 / 数量上限 / 聚合列表）、SSO / OIDC（来源 CRUD 与单例约束、issuer 校验矩阵含生产口径、绑定 Cookie 登录 CSRF、验证码以提交邮箱为准、信任开关、大小写无关邮箱、上游重定向拒绝、停用复检、KV 不落明文令牌）、Umami（`utils/umami` 单元 + schema + PATCH/GET 往返 + 审计 + 公开装配 + 前端注入器白名单/幂等/截断）、管理端改密（会话版本递增 / 空串不改 / 审计留痕 / 403）、登录标识收敛（用户名/邮箱、空白裁剪、无账号枚举、审计）、站点资源中转（防开放代理 / 逐跳重定向 / 3 跳上限 / 头像 kind） | `workers/tests/{invite-codes,sso,umami-settings,admin-user-password,login-identifier,site-asset}.test.ts`、`frontend/src/{lib/umami,pages/SsoComplete}.test.tsx` |
| 缺口 1（已补测） | **`utils/crypto.ts` 的 `randomDigits` 零覆盖**：它是注册 / 改密 / 换绑三处一次性验证码的同源生成器（本次从可预测的 `Math.random` 迁到 CSPRNG 逐字节拒绝采样），属安全敏感面却只有调用点、无任何直接断言 | 新增 `workers/tests/ssrf-crypto.test.ts` 的 `randomDigits` 分组 5 例：长度精确且全数字（含 0/1/40）、**>= 250 的字节被丢弃**、**剔除 250..255 后十个数字严格等频（各 25/250）**、前导零保留、真实 CSPRNG 批量样本覆盖 0..9。后两条用脚本化 CSPRNG（`__setCryptoOverrideForTests`）把字节序列固定，逐条钉住「拒绝采样」这一不变量 |
| 缺口 2（已补测） | **`lib/image-cache.ts` 零覆盖**：本批次新增模块，承载 Logo / Favicon / 头像的首帧同步直出（localStorage Data URL）、URL 变更失效与经自家 Worker 中转拉取，是「刷新不再触网」这一用户体验承诺的唯一实现 | 新增 `frontend/src/lib/image-cache.test.ts` 14 例：中转地址构造（kind 参与路径 + URL 编码；站内相对地址与 `data:` 不套中转）、缓存命中 / **管理员改地址即失效**（不得拿旧图当新图直出）、脏 localStorage 不抛错、拉取成功落盘键为**原配置地址**而非中转地址（否则换 kind 串图）、非 2xx 与超 2MB 上限拒收且不落盘、网络异常静默 null、写入被拒（隐私模式 / 配额满）仍返回可用 Data URL |
| 变异验证（非空跑） | 两组新测试都做过**变异验证**：删掉 `image-cache` 的 `entry.url === url` 判定与 2MB 上限 → 2 例失败；删掉 `randomDigits` 的 `buf[i] < 250` 拒绝采样 → 2 例失败。确认断言真的在钉行为，不是恒真 | 变异后 `Tests 2 failed | 12 passed` / `Tests 2 failed | 11 passed` |
| i18n 一致性 | `zh.ts` / `en.ts` 叶子键 **1237 : 1237 完全对齐**（无单侧键）；11 个含字面点号的键（`admin.auditLevel.*` / `admin.auditGroup.*` / 新增 `admin.statsSource.d1|umami`）实测经 i18next 正常解析出中文文案（i18next 对未命中路径有扁平键回退），非缺陷 | 扁平化比对脚本 + i18next 探针 |
| 文档同步 | 本批新增的邀请码 / SSO / 登录标识 / Umami / 改密 / 品牌资源缓存 / 验证码分段输入等条目在 `docs/PROGRESS.md`、`docs/API(_CN).md`、`docs/ARCHITECTURE(_CN).md`、`docs/UI(_CN).md` 与 AGENTS.md 变更记录中均已存在，无缺项；仅需补本条审计记录与基线用例数 | 本文件 + `AGENTS.md` |

**已知遗留（非本批引入，报告备查）**：`docs/PROGRESS.md` 的「2026-09-30 追加」编号在多次追加中被重复占用——**追加五 2 处、追加六 2 处、追加八 2 处**（追加二/三/四/七各 1 处），且条目物理顺序与编号不一致（追加八出现在追加七之前，追加三/五散落其间），检索时易误定位；本条取当时未占用的「追加九」，未去动既有编号以免打乱他处交叉引用（`AGENTS.md` 变更记录中已有多处按编号引用这些条目）。

### 2026-10-06：模糊强度第四档「Aero 玻璃」（复刻 Win7 DWM 玻璃）

个性化设置「模糊效果」滑块由三档扩为四档，新增最高档 `aero`——Win7 Aero 玻璃（Authentic / Energetic / Reflective / Open）的 Web 复刻。设计手法取自四个参考实现（`7.css` 的 `--w7-w-glass` 斜向条纹 + 角光、`makeaero` 窗体 box-shadow 栈与 specular 高光、`7-Aero-Stylesheet` 内侧白倒角、`win7site` 聚焦投影），按项目既有「token 门控 + 组件零分支」架构落地：

| 层 | 内容 | 实现位置 |
| :--- | :--- | :--- |
| 档位类型与 token | `BlurLevel` 增 `'aero'`；`applyTheme` 在根元素挂 `.glass-aero`，`--glass-alpha` = 有壁纸 0.22（浅）/0.28（深）、无壁纸 0.26/0.3（全站最低——玻璃后文字可辨但略模糊，接近 7-Aero-Stylesheet 任务栏 `#00000016` ≈ 0.09 + blur 5px 的极透配方，远低于 frosted 的白 0.6），`--glass-blur` = 12px（全站最小半径）；弹层在 aero 档覆写填充 `hsl(var(--popover) / max(0.2, α-0.02))` + 同一片 fixed 条纹玻璃板（基础类 0.5 下限在低 α 下会反向比卡片更实），`.glass-dialog` 下限 0.6 既有补偿公式不变 | `stores/theme.ts`、`index.css` |
| 强调色 tint | background-image **最底层**叠低强度平铺色桶 `hsl(var(--primary) / 0.07)`（深色 0.09；弹窗 0.06）——makeaero 手法「色度烤进 tint、高光全强度叠加」，玻璃随个性化强调色泛色（默认 #4e80ee 即 Win7 蓝玻璃观感）；`.glass-surface` / `.glass-surface-popover` / `.glass-dialog` / `.item-surface` 四类面都带 | `index.css`「Aero 玻璃」节 |
| 色度增益 | backdrop `saturate(1.5)` → `1.8`（DWM 玻璃的饱和度提升，壁纸轮廓透出更鲜艳），覆盖 `.glass-blur` / `.glass-control` / `.item-surface`，`.glass-dialog` 在自身补偿公式内同步（blur ×0.92 + brightness 1.75 保持不变） | `index.css`「Aero 玻璃」节 |
| 斜向反光条纹 | 54° 多段亮暗交替渐变，`background-attachment: fixed` 钉在视口——全站玻璃共享同一片「玻璃板」，滚动时条纹不动（7.css 手法）；大面板（`.glass-surface`）、弹窗与弹层菜单消费；文件项（`.item-surface`，数量大）不给 fixed 条纹（大量 fixed 背景拖慢滚动重绘），只吃 tint + 顶部高光 | `index.css` |
| 高光与立体感 | 顶部镜面高光（峰值 0.32、18% 内衰减完）+ 左上/右上 135°/225° 角部光泽 + 底部沉影（0.04、12%），比例收小与低不透明度玻璃协调；全部走 `background-image` 叠层（绘制在半透明底色之上、内容之下）；`.item-surface` 的 hover/selected 状态类声明在后且特异性同阶，状态切换照常覆盖，条纹不与其打架 | `index.css` |
| 柔和投影与倒角 | 只给「窗口」面：`.glass-dialog`（`0 24px 64px` 长投影 + `0 0 36px hsl(var(--primary)/0.16)` 强调色环境光晕 + `inset 0 0 0 1px` 内侧白倒角 + 内部白泛光）、`.glass-surface-popover`（柔投影 + 上缘内高光）；**不覆写** `.glass-surface` 与 toast——`ring`/`focus-visible` 与 toast 堆叠深度都走 box-shadow，整条覆写会丢键盘焦点环 / 破坏「后方层 shadow-none」的堆叠表达 | `index.css` |
| 文件项适配 | `.item-surface`（文件页网格卡片 / 列表行 / 分享卡 = 三视图）在 aero 档补 tint + 顶部高光（透明度与模糊走共享 token）；hover/selected 状态类声明在后照常整层覆盖 | `index.css` |
| 文字发光 | 四类玻璃面文字带同色系光晕 `0 0 6px` + `0 0 12px`（7.css 标题 8× `0 0 10px #fff` / makeaero 4× `0 0 4px #fff` 手法）——低不透明度下垫亮文字身后的玻璃增强可读性，`text-shadow` 继承到面内所有文本；深色模式反转暗晕 `rgb(0 0 0 / 0.45)`（字幕式压暗） | `index.css` |
| 深浅模式 | `.dark.glass-aero` 各一套强度：暗色高光减半、条纹白带更细、底部沉影加深，投影整体加重 | `index.css` |
| 滑块与文案 | `BlurSlider` 四档（锚点/读屏值由 `BLUR_LEVELS` 数组长度自动推导）；`common.blurAero` / `common.blurDescAero` 中英两份语言包同步 | `components/ui/slider.tsx`、`lib/i18n/{zh,en}.ts` |
| 回归 | `slider.test.tsx`：锚点数 3→4，新增第 4 档取值断言（`aria-valuetext` + 描述文案联动） | `components/ui/slider.test.tsx` |

设计约束（写入 docs/UI_CN.md）：条纹/投影**不落到** `.item-surface` 与 toast；box-shadow 覆写面只限无 ring 需求的弹窗与弹层面。`off`/`default`/`frosted` 不挂 `.glass-aero`，装饰层全部失效；aero 与 `.no-blur` 互斥（同一 `blurLevel` 单值），无需交叉规则。

### 2026-10-06：默认强调色换 `#4e80ee` + 默认 favicon 同步换色

- **默认强调色** `#D8632B` → **`#4e80ee`**（`stores/theme.ts` 的 `DEFAULT.accentColor`）；`ACCENT_PRESETS` 首位同步替换，第二位放 `#c96a3a`（原默认橙的调和版），其余预设保留。已存过个性化强调色的用户不受影响（localStorage 原值优先）。
- **默认 favicon / 兜底图标**换色：`frontend/public/favicon.svg` 与 `lib/image-cache.ts` 的 `DEFAULT_FAVICON_SVG`（首帧兜底 data URL）内 `#D8632B` → `#4e80ee`；`Logo` 组件的默认矢量图标走 `currentColor text-primary` 自动跟随新强调色，无需改动。
- **落地页回退值**（`landing.css` JS 未生效时的 `--primary`）：明暗两块 `19.4 69% 50.8%` → `221 82% 62%`、`--primary-foreground` → `210 40% 98%`（YIQ 125.6 < 128 → 白字，与旧默认橙同侧；浅色模式运行时仍有 AA 压暗循环兜底）。
- 浅色模式下 `#4e80ee`（YIQ 125.6）白字对比 3.7:1 不达 AA，`applyTheme` 的既有压暗循环自动把它压到 ≈ L56%（对比 ≥4.5:1）后才停——与旧默认橙同一机制，无需新代码。
- 文档同步：docs/UI_CN.md / UI.md「强调色」「落地页独立」两节、AGENTS.md 前端 UI 规则「落地页独立」条目与本变更历史。

### 2026-10-06：过滚动效果（Overscroll Effect）滑块 + 全局引擎

个性化设置「动画效果」下方新增**过滚动效果**三选一滑块（默认关，仅动画默认/全部档显示），配全局事件引擎。物理参数取自 `~/scroll-test` 四个参考实现：

| 项 | 内容 | 位置 |
| :--- | :--- | :--- |
| 档位与门控 | `OverscrollLevel = 'stretch' \| 'off' \| 'rubberBand'`（默认 off）；`applyTheme` 落 `<html data-overscroll>`；滑块 `OverscrollSlider` 三档锚点自动推导，**仅动画默认/全部档显示**（关闭档没有可回弹的动效）；`common.overscroll*` 中英文案 | `stores/theme.ts`、`components/ui/slider.tsx`、`lib/i18n/{zh,en}.ts` |
| 引擎 | `lib/overscroll.ts`（main.tsx 模块级装载）：window 级 wheel/touch 监听（wheel/touchmove non-passive），事件目标向上找最近纵向滚动容器；容器停在边缘且输入继续外推才消费（preventDefault 阻断滚动链接）；滚轮停顿 150ms / 触摸松手即回弹；反向输入线性回退、越过起点交还原生滚动 | `lib/overscroll.ts` |
| 拉伸回弹（Android 12） | 内容**原位变形、无整体位移**：`scaleY(1 + s)`，`s = 0.016·pull + 0.016·(1 − e^(−pull·e/0.33))`（pull = 累计越界 px / 视口高度），transform-origin 钉在被拉的边（flutter alignment 映射）；**拉伸程度舒适 1.0 / 高效 0.75（cap 0.10/0.08）**；缩回**舒适 400ms / 高效 340ms** `Curves.decelerate`；**仅真实滚动溢出容器生效**——预留高度但内容不满的卡片（管理端表格等）跳过，避免整块空卡片抖动 | `lib/overscroll.ts` |
| 橡皮筋（iOS） | 整页拉出：`disp = dir·(1 − 1/(raw/range·0.55 + 1))·range`（cap 0.4·range，**位移距离高效 = 舒适的 1/2**）；松手阻尼谐振闭式解 `offset(t) = (c1 + c2·t)·e^(−λt)`（λ = 2π/0.575，c2 带触摸速度可轻微过冲，阈值 0.1px / 10px/s），**最短播放高效 600ms / 舒适 400ms**（小振幅时间轴放慢，杜绝「瞬间消失」） | `lib/overscroll.ts` |
| 目标规则 | **卡片页面全部卡片作为一个整体回弹**：变换目标 = 指针落点卡片向上最近一个含 ≥2 张顶层卡片的公共包裹层（单卡 → 卡片本身；候选含 nav → 退回卡片，侧栏不跟随）；卡片外滚动区域回落为滚动上下文本身，但跳过含侧栏/导航的布局框架——页面标题、描述文字、侧栏永不跟随 | `lib/overscroll.ts` |
| 门控 | `data-overscroll=off`（默认）零拦截；`data-motion=off` 与 `prefers-reduced-motion` 不生效；档位切换经 MutationObserver 实时归位 | `lib/overscroll.ts` |
| 已知权衡 | 拉拽进行中 transform 祖先使后代 backdrop-filter 短暂退化为自身采样（同「Toast 玻璃层级」约束），回弹结束清空 transform 即恢复 | — |
| 回归 | `slider.test.tsx` 增过滚动滑块用例（3 锚点、默认 off、两端取值与描述联动） | `components/ui/slider.test.tsx` |

### 2026-10-07：aero 可读性与滑块反馈

- **aero 文字发光重构**：`.glass-aero` 上新增 `--aero-text-glow` 变量统一分发，覆盖面扩到 `.glass-control`（tab 栏/按钮/滑块面，此前零光晕）与 `.radio-option`（`radio-group.tsx` 选项行新增挂点类）；强度经两轮反馈收敛到两层弱光晕 `0 0 1px + 0 0 6px`（浅色白晕 / 深色暗晕；四层强版喧宾夺主，按「大幅减弱」定档）。（`index.css`、`components/ui/radio-group.tsx`）
- **滑块标签/数值对比交换**：左标签 `text-muted-foreground` → `text-foreground`（黑），右数值 → `text-muted-foreground`（灰）——常量标签承担最重视线，随档位变化的数值退后。（`components/ui/slider.tsx`）
- **锚点重影修复**：已被填充覆盖的档位锚点随值隐藏（半透明填充叠半透明锚点会晕成重影），`.pill-slider-tick` 过渡补 opacity；首末锚点维持贴轨道两端（「内缩 2/3 文字距」方案经用户确认后回退）。（`components/ui/slider.tsx`、`index.css`）
- 验证：`tsc --noEmit` 干净，前端 13 文件 / 93 用例全绿，`vite build` 通过；浏览器实测滑块几何（锚点 2/480 贴边、文字 20/16 内缩、覆盖锚点 opacity 0）与六类面文字光晕计算值。

### 2026-10-07（追加）：玻璃一致性 / 过滚动拉伸改位移 / 管理页结构批次

- **reveal 残留修复**：入场动画 `fill both → backwards`——both 结束后永久持有 from 帧 `blur(0px)` filter + 恒等 transform：filter 残留使包装层成 backdrop root（仪表盘趋势卡整卡无磨砂、用户管理工具栏无光晕），transform 残留令后代 fixed 条纹错位（存储管理纹理与全站不一致）；常见坑点同步。（`index.css`）
- **Tab 面板入场去 opacity**：`animate-fade-in` → `animate-tab-in`（translate-only）——opacity 动画祖先是 backdrop root，存储管理页「进入先半透明、动画结束才覆盖模糊」的根因。（`components/ui/tabs.tsx`、`index.css`）
- **图表 tooltip 玻璃化**：evilcharts tooltip default 变体 `bg-background` 实底 → `glass-surface-popover glass-blur`（随四档门控）。（`components/charts/evilcharts/ui/recharts-tooltip.tsx`）
- **aero 浮动面**：弹窗/抽屉/弹层/Toast 填充统一 `α-0.04`（下限 0.16），白倒角/泛光收敛（0.42/0.07、弹层 0.3）——用户反馈白边大于高光光线、相对卡片太实。（`index.css`）
- **过滚动拉伸维持原位 scaleY**（曾按建议改整体位移，实测与橡皮筋趋同后按用户要求还原）；会话期间 mover 挂 `data-ovs-active` 条纹层切元素锚定（fixed 条纹在 transform 下首帧跳变）；移除「仅真实溢出容器」门槛；导航栏（header landmark）永不参与。（`lib/overscroll.ts`、`index.css`）
- **管理页结构**：存储管理「添加」按钮与 TabsList 同行右对齐（addTick 信号下发）；管理页计数文字删除（admin.users.total / admin.itemCount / admin.permissions.ruleCount 及孤儿键清理），工具行改右对齐；「默认用户设置」角色列表与「桶设置」左侧导航补滑动指示器 + hover 统一强调色淡化；挂载的桶拖动排序恒可用（去策略门控）、行点击跳转移除；「添加桶」菜单改项目 Checkbox（div[role=menuitemcheckbox]，button 不嵌 button）；「具体桶」改名「桶设置」；TabsList 指示器改 `bg-primary/10` 半透明 tint。（`pages/admin/Storage.tsx`、`storage/{Providers,Mounts}.tsx`、`pages/admin/{Users,Permissions}.tsx`、`components/ui/tabs.tsx`、`checkbox.tsx`、`lib/i18n/{zh,en}.ts`）
- **骨架长在玻璃卡里**（用户选定方案）：admin Settings 七卡与 settings ApiKeys 卡片壳常驻、卡内行骨架（CardRowsSkeleton）+ 数据到位内层 `animate-fade-in` 150ms 淡入，缓解骨架→aero 闪烁。（`pages/admin/Settings.tsx`、`pages/settings/ApiKeys.tsx`）
- **aero 文字发光 / checkbox**：`--aero-text-glow` 变量分发 + glass-control/radio-option 覆盖（大幅减弱两层光晕）；滑块标签/数值对比交换、覆盖锚点隐藏；checkbox「全部动画」档未勾选文字变灰移除。（`index.css`、`radio-group.tsx`、`slider.tsx`、`checkbox` 相关）

### 2026-10-11（追加）：S3 网关 MinIO 式根路径入口（无路径前缀）

结构性问题：minio-go 只接受 `host[:port]` 作为 endpoint（经 Context7 核实 minio-go `New(endpoint)` 契约），SigV4 签名覆盖完整请求路径，`/s3` 前缀既不能藏在反代后面也无法改写签名——Alexandrie 等 minio-go 客户端对 `https://{domain}/s3` 全部 403。本次不新增域名，在既有站点基址上直接可用：

- **根路径入口（SigV4 判别）**：Worker 顶层中间件——携带 SigV4 签名（`Authorization: AWS4-HMAC-SHA256` 头或 `X-Amz-Signature` 预签名参数）的请求进 S3 网关（bucket = 路径首段），未签名请求走常规路由；签名判别在所有中间件之前，DB 由 `getDb` 从 `c.env.DB` 兜底构建。`parseS3RequestPath` 兼容两种形态（`/s3` 前缀剥离后无前导 `/`；根路径剥离前导 `/`）。（`workers/src/index.ts`、`services/s3gw/handlers.ts`）
- **Pages 转发**：`_middleware.ts` 在协议通道判定中前置 SigV4 检测——否则 `GET /uploads?X-Amz-Signature=…`（无扩展名）会被当成 SPA 路由返回 index.html。（`frontend/functions/_middleware.ts`）
- **速配信息**：创建密钥响应 `configs.s3.endpoint` 从 `${base}/s3` 改为裸基址 `base`（MinIO 式直接可填）；协议勾选标签 `s3` → 「S3 / MinIO」；旧 `/s3` 前缀入口保留（存量客户端无需迁移），bucket/key 解析两种模式同语义。（`services/keys/handlers.ts`、`ApiKeys.tsx`、i18n zh/en）
- **测试**：`tests/s3gw.test.ts` 新增根路径套件 3 例（真实 AWS SDK 以无前缀 endpoint 完成 PUT/GET/HEAD/ListBuckets、根路径预签名 GET 匿名下载、未签名请求不进网关）；`tests/gateway-compat.test.ts` endpoint 契约更新为裸基址。workers 86 文件 / 784 例全绿；前端 93 例全绿。
- **文档**：`docs/API.md` / `API_CN.md` S3 网关章节改「双入口」（裸域名推荐 + `/s3` 兼容），客户端配置与判别语义同步。

### 2026-10-11（追加二）：用户空间按用户隔离 + 网关密钥零规则可用 + 模板上传根修复

用户实测反馈批次（注册常规账号全链路复测）：

- **user_space 根改为按用户隔离**：`resolveUserSpaceRoot` 从「根 = defaultPath 本身」改为 `<defaultPath>/<username>`（defaultPath 末段已是用户名则直接用，避免 `/users/alice/alice`；defaultPath 为 `/` 或越出挂载边界回落 `<mountPath>/<username>`）——`/public` 角色默认路径下每个用户拿到独立子目录 `/public/<username>`，他人目录写入 403。（`services/files/upload-mode.ts`、`tests/user-space-root.test.ts` 重写）
- **网关密钥零规则可用（403 根因）**：UI 创建的密钥没有任何路径规则，引擎第 10 步默认拒绝使 compat/WebDAV/S3 全部写通道 403（「无权执行此操作」）——这是用户 key5 全部 403 的真正根因，与 user_space 无关。修复：引擎第 9 步属主兜底扩展到 apiKey 主体（沿用属主 defaultPath/defaultPermissions，principal.ts 已装载），叠加既有第 4 步密钥权限交集与各入口 assertKeyScope 作用域；生产实测原 key5 同路径 PUT 200。（`services/permissions/check.ts`、`tests/gateway-compat.test.ts` 新增 3 例）
- **模板上传根修复（第二处 403 根因）**：对话框默认模板 `/uploads/{year}/{month}/` 的密钥此前**完全不能上传**——作用域判定拿「渲染后目标 vs 未渲染模板根」比较，永假。新增 `renderUploadRoot()`，compat/WebDAV/S3/AList 四通道作用域判定统一先按当前时间展开模板；实测对象真实落位 `/uploads/2026/10/`。（`utils/path.ts`、`upload-bytes.ts`、`webdav`、`alist`、`s3gw`、回归 1 例）
- **密钥默认上传根 = 用户空间目录**：创建密钥省略 uploadPath 时，user_space 挂载上的普通用户默认为其用户空间目录；显式越界 400「上传根目录必须位于你的用户空间内」；前端对话框留空 + placeholder 说明。速配信息补全上传路径：`bearer.pathHint`/`openlist.pathHint`（此前仅 WebDAV 有 webpathHint）、`s3.keyPrefixHint`（桶首段之外的 key 前缀）——四协议复制配置均含完整上传路径。（`services/keys/handlers.ts`、`ApiKeys.tsx`、i18n zh/en）
- **S3 桶级子资源（Alexandrie 启动握手）**：`HEAD /{bucket}` BucketExists、`GET ?location` LocationConstraint、`PUT ?policy` SetBucketPolicy（接受并忽略，匿名可读由 path-serve 可见性语义实现）、`PUT /{bucket}` MakeBucket（作用域内建目录行，走 assertWritable）。minio-go 后端启动硬依赖这组调用（缺失即 os.Exit(1)），生产实测三连 200/204。（`services/s3gw/handlers.ts`）
- **i18n**：补缺失的 `common.add`（个性化设置「添加」按钮裸 key）。
- **测试**：workers 86 文件 / 790 例、前端 93 例全绿；`tsc --noEmit` 两端干净。
- **生产实测**（新建常规账号 probetest1，注册走邀请码 + D1 OTP 全流程）：默认密钥 uploadPath=/public/probetest1、四协议配置含完整路径；S3 PUT `/public/probetest1/dire/2026/10/` 200（年月真实落位）、WebDAV 201、compat 200；越界写 `/public/excnies/` 403；越界 uploadPath 400；Alexandrie 握手三连通过；签名直链匿名 200。**已知边界**：未签名匿名直读受站点级 `allow_guest_access=false` 门控（当前生产为 false）——Alexandrie 生成的是未签名裸 URL，图片对外可见需开启游客访问或改用签名直链。
- **文档**：`API(_CN)` 创建密钥（默认值/授权模型/模板作用域/configs 提示字段）与 S3 网关（桶级子资源）同步；`ARCHITECTURE(_CN)` §28 用户空间语义。

### 2026-10-12：游客可见性继承与级联（图床对接缺口闭环）

用户实测（Alexandrie 经 S3 网关对接 Picumet）暴露的最后缺口：站点开启「允许访客」后匿名 GET 仍 403——文件属性面板的游客可见性（`guest_visibility`）**既不级联也不被新上传继承**，且 UI 文案「跟随角色默认（游客仅可下载）」与引擎实际语义（NULL = 不额外开放）相悖（架构文档 191 行的旧意图引擎从未实现）。

- **新建行继承**：`inheritGuestVisibility`——新建文件/目录行继承**最近祖先目录行**的非 NULL `guest_visibility`（参数化 substr 前缀匹配，免疫 LIKE 转义；上传自愈创建的中间目录同样继承）。`FileRepo.createFile/createFileTx` 增 `guestVisibility` 列绑定。（`services/files/write.ts`、`db/repos/files.ts`）
- **文件夹级联**：`PUT /api/files/:id` 设置 `guestVisibility` 时对 folder **级联子树**（与可见性级联同形，范围 + substr 谓词）——「文件夹允许游客下载」对既有子项立即生效。
- **文案纠偏**：属性面板 `guestInherit` 改「不单独设置（游客不可访问）」、分组名/描述改为「游客访问（子目录与新上传文件自动继承）」，与引擎语义一致；刻意**不**实现「NULL 跟随角色默认放行」——合成规则先于匿名硬拒绝（F-07），NULL 放行会在 guest_access 开启时把 private 文件一并暴露。
- **测试**：新增 `tests/guest-inherit.test.ts` 3 例（深路径继承含自愈目录、无祖先设置保持 NULL、级联收敛既有子树）；workers 87 文件 / 793 例全绿。
- **文档**：`ARCHITECTURE(_CN)` 游客可见性语义（继承 + 级联 + 不放行 NULL 的理由）、`API(_CN)` `PUT /api/files/:id` 字段语义同步。
- **生产实测（Alexandrie 对接配方全链路）**：admin 密钥 uploadPath=/ → `PUT /drie/u1/node1.jpg` 200（`<userId>/<nodeId>.<ext>` 布局）、BucketExists/MakeBucket/SetBucketPolicy 全过；`/drie` 设「游客仅可下载」（级联）→ **匿名 GET 200** 返回内容一致。测试密钥与对象已清理，`/drie-backups` 目录保留（Alexandrie 备份桶）。

### 2026-10-12（追加）：S3 网关业务异常 XML 映射（409 裸 500 修复）+ Alexandrie 面板侧配置落地

- **S3 网关 `onError`**：`upsertFileObject` 等抛出的 `ApiError`（占用 409 / 404 / 413…）此前在根路径挂载上未经映射直接裸 500（s3RootApi 独立 Hono 实例无全局 errorHandler）。新增 `s3gwRoutes.onError` 把业务异常映射为 S3 XML（409 OperationAborted / 404 NoSuchKey / 413 EntityTooLarge / 501 NotImplemented），根路径与 `/s3` 挂载同语义。回归 1 例（SDK 复现他人占用 → 409 XML，属主对象完好）。（`services/s3gw/handlers.ts`、`tests/s3gw.test.ts`）
- **面板侧配置（硬自测通过）**：admin 创建 `alexandrie-root` 密钥（uploadPath=/，桶根任意路径写入 200）；`/public/excnies/dire` 设「游客仅可下载」（级联）；`/drie-backups` 预建。**无痕自测 `GET /public/excnies/dire/scope-ok.txt` → 200 `scope-check`**；既有 png 匿名 200。workers 87 文件 / 794 例全绿。

### 2026-10-12（追加二）：CORS 白名单通配符 + 弹窗管理

- **设置消费修复（真 bug）**：系统设置 `allowed_origins` 此前只存不用——`corsHeaders` 中间件仅读环境变量；且同源回退改造时误删了 `Access-Control-Allow-Origin` 反射头，白名单命中的跨源响应也不带头。中间件改为「同源回退 → 环境变量精确 → 设置表白名单（含通配）」三段判定，命中即反射来源 + 凭据头。
- **通配符**：`https://*.example.com` 命中任意层级子域与裸域；scheme 与端口严格（条目未写端口时来源不得带显式端口）；通配符只允许主机名首段，非法条目恒不匹配（`utils/cors.ts` 的 `originMatches` 纯函数 + `parseOriginList` + 60s 进程缓存的 `loadCorsOrigins` / `invalidateCorsCache`）。
- **白名单并集**：环境变量 `ALLOWED_ORIGINS` 与设置表条目始终叠加；管理端保存 `allowed_origins` 走 `settings_update` 审计（记键不记值）+ 同 isolate 缓存立即失效。
- **管理端 UI**：安全卡片的纯文本输入替换为「CORS 白名单」弹窗 + 表格（IP 封禁弹窗同款玻璃面：来源 / 删除 / 添加行，删除走 ConfirmDialog），增删立即经既有设置保存落库。
- **域名族归属**：`https://*.cnies.org / *.hxcn.space / *.hxcn.dev / *.hxcn.top` 写在 `deploy/wrangler.production.toml` 的 `ALLOWED_ORIGINS`（未追踪上线配置，域名族属部署配置不入迁移）；生产库 `allowed_origins` 保持既有两个精确来源，两者运行时并集叠加。
- **测试**：`tests/cors-origins.test.ts` 6 例（通配/端口/scheme 语义、预检反射、缓存失效即时生效、审计）；workers 88 文件 / 800 例全绿。
- **生产实测**：`files.cnies.org / app.hxcn.space / blog.hxcn.top / hxcn.dev（裸域）/ picumet.pages.dev` 预检均反射 ACAO + credentials；`stranger.example.com / evil-cnies.org`（后缀伪装）无 ACAO。

### 2026-10-12（追加三）：人机验证接入（Turnstile / reCAPTCHA 双提供方）

「即将规划」中的人机验证方案落地（用户提供生产密钥，七面全开上线）：

- **服务端**（`services/captcha.ts`）：`assertCaptcha(c, action, token)` —— 面未启用放行；token 缺失 403 `CAPTCHA_REQUIRED`；siteverify 失败/action 不符 403 `CAPTCHA_FAILED`；网络异常/5xx 503 `CAPTCHA_UNAVAILABLE`（fail-closed）。双提供方 siteverify（官方文档核实，契约同构）：Turnstile `challenges.cloudflare.com/turnstile/v0/siteverify`、reCAPTCHA `www.google.com/recaptcha/api/siteverify`（v2 无 action 跳过比对）。配置进程内 60s 缓存，保存即失效。
- **七面接线**：login（密码校验前，省 bcrypt）、register（OTP 前）、share_download（分享下载令牌签发，`X-Turnstile-Token` 头）、upload（`upload-session` 签发，API 密钥通道不经过）、password_change（`PUT /users/me/password` 旧密码校验前）、email_verify（`/users/me/email/send-otp` 换绑发码前）、password_reset（`/forgot-password` 发信前，不暴露邮箱存在性语义不变）。
- **配置**：设置键 `captcha_provider/captcha_enabled/captcha_site_key/captcha_secret_key（enc: 密文）/captcha_face_*`（迁移 0018 种子，七面默认关）；管理端系统设置右列新增「人机验证」卡片（类 OIDC 卡片：提供方下拉 + 总开关 + Site Key + Secret 写后掩码 + 七面开关，启用校验缺钥 400）；公开设置下发 `captcha`（provider/enabled/siteKey/各面，无 secret）；保存写 `settings_update` 审计 + 缓存失效。
- **客户端**（`components/captcha.tsx`）：双提供方显式渲染小部件（脚本 URL 固定常量，主题/语言跟随，interaction-only）+ `useCaptchaGate` hook（多请求场景每次调用前 reset 并等待新 token，30s 超时）。页面接线：登录（表单 + 忘记密码弹窗）、注册、分享下载（点击先出小部件，token 就绪后同入口重放）、上传弹窗（`sr-only` 挂载，批量上传每文件自动刷新 token 无需重复交互）、个性化（改密 + 换绑邮箱）；`TURNSTILE_FAILED/REQUIRED` → reset + toast。
- **测试**：`tests/captcha.test.ts` 8 例（siteverify stub 矩阵：成功/失败/action 不符/网络异常/面未启用放行/reCAPTCHA 端点与无 action；管理端保存加密落库 + 掩码回读 + 公开下发无 secret + 审计）。workers 89 文件 / 808 例全绿。
- **生产**：Turnstile 双钥已配（管理端 API），七面全开；实测无 token 登录/注册 403 `CAPTCHA_REQUIRED`；公开设置正确下发 siteKey 与各面。**注意**：login 面开启后，脚本化登录（curl 等）需先过 Turnstile——管理操作请走面板；紧急通道可在卡片临时关闭该面。

## 当前基线

- 后端：89 个测试文件 / 808 个 Vitest 用例通过（累计本轮新增：can_browse_all 回归 3 例、网关密钥零规则与用户空间默认 3 例、模板上传根 1 例、游客可见性继承 3 例、S3 异常映射 1 例、CORS 白名单 6 例、人机验证 8 例）；`tsc --noEmit` 干净。
- 前端：13 个测试文件 / 93 个 Vitest 用例通过；`tsc -b && vite build` 通过，`tsc --noEmit` 干净。
- 语言：中文 + 英文。

## 即将规划

近期待办总览：Oracle Cloud provider 实现、路径变量 DSL（`{year}/{month}`）、热文件检测与强制签名 URL、拖拽交互与属性面板编辑的持续验证记录，以及下面一项详细规划与十项新方向（液态玻璃动效、组件色彩体系、Workers 稳定性调查、存储驱动与上传修复、出口机制与协议挂载、SMTP 完整测试、第一版上线、自建 S3 兼容存储的内网接入受限、两步验证（2FA / TOTP）、注册限流强化）。

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

### 两步验证（2FA / TOTP，登录第二因子，已完成本地实现与测试）

规划依据经 Context7 核实（`/hectorm/otpauth`，RFC 4226 HOTP / RFC 6238 TOTP）：otpauth 支持 Node/Deno/Bun/浏览器四运行时，默认构建自带纯 JS HMAC（无 Node 内建依赖，Workers 可用）；`otpauth/bare` 需自备**同步** HMAC 函数（Web Crypto subtle 是异步的），真走 bare 构建时需内置同步实现或换库，落地时以实测为准。

- **库选型（后端）**：`otpauth` —— `new OTPAuth.Secret({ size: 20 })`（CSPRNG，官方建议 ≥128 位）、`totp.generate()`、`totp.validate({ token, window: 1 })`（返回 delta/null；窗口保持最小防爆破，官方明确要求服务端节流）、`totp.counter()`（重放防护）、`totp.toString()` 产出 `otpauth://totp/…` URI。默认 SHA1 / 6 位 / 30s（与主流验证器兼容，官方建议非必要不改）。
- **数据模型（迁移 0014，编号以落地时为准）**：`users` 加 `totp_secret_enc`（`enc:` AES-GCM 密文，与存储凭据/SSO token 同一约定）、`totp_enabled`、`totp_last_used_counter`；新表 `totp_backup_codes`（user_id、HMAC-SHA256(ENCRYPTION_KEY) 哈希、used_at）——备用码是高熵随机值非口令，不需要 bcrypt。
- **启用流程**：`POST /api/users/2fa/setup` 生成 secret（未启用态）→ 返回 otpauth:// URI，前端 `qrcode` 渲染 QR（otpauth 官方把 QR 编码留给外部库）；`POST /api/users/2fa/enable` 带 `code` 验证通过才置 `totp_enabled` 并发放 10 个一次性备用码（仅此一次明文展示）；禁用需密码 + 当前 TOTP 码。
- **登录流程**：`POST /api/auth/login` 密码通过且 `totp_enabled` 而缺 `totpCode` → `403 TOTP_REQUIRED`（前端进入第二步，复用既有 `InputOTP` 6 位组件）；带码 → TOTP validate（window 1）或备用码（单次消费），通过才 `setAuthCookie`。注意：`TOTP_REQUIRED` 在密码正确后才返回，本身确认了密码正确（业界同型，可接受）。
- **重放与节流**：成功验证记录 `totp_last_used_counter`，同/更早 counter 拒绝（30s 有效期内防同码复用）；TOTP 校验走认证限流同款（5 次/分钟/IP，fail-closed）。
- **不加验的面**：API 密钥协议面（WebDAV / S3 网关 / AList / PicList）不叠 2FA——密钥认证不是密码认证，能持密钥即视为已过登录；找回密码改密递增 `session_version` 已使旧会话失效。**待决**：SSO/OIDC 完成是否叠加第二因子（该路径不经本站密码）。
- **会话语义**：2FA 是登录门，不递增 `session_version`；已登录会话开启 2FA 不踢下线。
- **前端**：个性化设置「修改密码」同区新增「两步验证」卡（状态 / 启用向导：QR + 确认码 + 备用码一次性展示 / 禁用）；登录页第二步输入。i18n zh/en 两份。
- **测试**：workers `tests/totp-2fa.test.ts`（2 例全量场景全绿）——enroll 矩阵（错码 400、对码 200 并发放 10 个备用码）、登录第二因子门控（缺码 403 `TOTP_REQUIRED` / 错码 401 / 对码 200）、时间步计数器防重放（同 30s 窗口二次提交 401）、备用码登录消费与防重用、剩余备用码计数递减、备用码重新生成并作废旧码、禁用需主密码+动态码/备用码校验、禁用后恢复单因子登录。前端 `Personalization.tsx`（管理卡+向导弹窗+QR+备份码网格+禁用弹窗）与 `Login.tsx`（第二步 OTP 输入/备用码切换）类型检查与全量单测通过。

### 注册限流强化与封禁管理（已完成本地实现与测试）

动机：2026-10-11 生产部署后，**恶意批量注册**成为吃满存储配额 / R2 用量的主要攻击面（每账号默认 1 GiB，N 个账号 = N GiB）。现状防线与缺口：

- **现状（已实现）**：`/api/auth/*` 挂 `rateLimitMiddleware`（全局限速，`system_settings` 可调）；认证写端点另挂 `authRateLimitMiddleware`——**固定 5 次/分钟/IP**（硬编码，仅生产或 `RATE_LIMIT_FORCE=true` 生效，KV 计数，认证类存储异常 fail-closed 503）；注册门控另有开放注册开关、邀请码四项、邮箱验证（`require_email_verification`）、新用户默认 1 GiB 配额、账号 `banned` 封禁。
- **缺口**：① 阈值硬编码不可调；② 每分钟滑动窗口防得住爆破，防不住「慢速批量注册」（每分钟 ≤5 个请求但持续注册成功）；③ 注册成功无独立速率约束；④ 无法按攻击态势在线收紧。

规划项：

| 项 | 设计 | 关键落点 |
| :--- | :--- | :--- |
| 认证限流可配置 | `system_settings.auth_rate_limit_per_minute`（默认 5 = 现状，0 = 关闭该档），管理端「安全设置」卡可调；`authRateLimitMiddleware` 从硬编码收敛到设置读取（60s 进程内缓存 + 保存失效，与审计策略同模式）；生产默认行为不变 | `middleware/rate-limit.ts`、`admin/schemas.ts`、`admin/handlers.ts`、`admin/Settings.tsx` |
| 注册成功速率 | 新增 `register_success_per_hour_per_ip`（默认 3）：按 **注册成功**（非请求）计数，超限 429 `REGISTER_RATE_LIMITED`——防慢速批量注册；KV 计数与既有窗口同模式；邀请码必填开启时此项自动收益（码本身是稀缺凭证） | `auth/handlers.ts`（注册成功事务后计数）、`middleware/rate-limit.ts` |
| **IP 封禁（落库，新增）** | 新表 `ip_bans`（id / ip / reason / created_by / created_at / expires_at NULL=永久）：① `ipBanMiddleware` 挂全局最早位（KV 缓存名单，写时失效），命中一律 `403` 通用文案（不透露命中原因，防枚举）；② 管理端「安全设置」新增 IP 封禁卡：增删查 + 原因 + 可选过期时间，操作写审计；③ 可选自动封禁（默认关）：同 IP 注册失败 / 注册成功超阈值自动入表 | 迁移 0014（编号以落地时为准）、`middleware/ip-ban.ts`、`admin/{schemas,handlers}.ts`、`admin/Settings.tsx` |
| **封禁用户（增强既有，参考 SDNUChronoSync）** | 现有 `users.status='banned'` 保留为「账号封禁」；增强：① 封禁/解封操作写审计（原因、操作者）；② `users.ban_reason` 字段落库（管理端可见）；③ 登录文案语义决策——SDNUChronoSync 对所有封禁类型统一返回模糊文案「服务不可用」防枚举，Picumet 现返回具体 `ACCOUNT_BANNED`，**待决策**是否对齐模糊语义（可用性 vs 防枚举） | `users.ts`（迁移加列）、`auth/handlers.ts`、`admin/handlers.ts`（封禁审计）、`admin/Users.tsx` |
| 观测补齐 | 注册成功/被限流写审计（`auth` 组）；管理端日志页可直接看到每 IP 注册态势 | `auth/handlers.ts`、`LogRepo` |
| 关联项（待决策） | 全站存储硬顶 `site_max_storage`：上传预留时校验全站已用 + size ≤ 上限，超限 413——「被攻击时超 9G 停止使用」的直接答案，与本规划配套但独立成项 | `uploads/handlers.ts`、`files/write.ts`、配额预留链路 |
| 联动 | Turnstile 重实现规划（见上文）若落地，注册面为第一优先接入面（`action='register'`）；本规划不依赖它 | — |

- **参考实现（`~/SDNUChronoSync/`，2026-10-11 核对源码）**：其封禁体系为 `users.status` 单列枚举 `normal / ban / ipban / emailban`——`ban` 账号封禁、`ipban` 封禁该用户并按状态拦其 IP（管理员豁免可登录）、`emailban` 封既有用户行对应邮箱（注册/发验证码侧 `403 服务不可用`，防同邮箱再注册）；管理端 `POST /admin/users/{id}/ban {ban_type}` + `/restore`，禁止自封；所有封禁类型登录侧统一模糊文案「服务不可用」（防枚举）。**Picumet 采纳与差异**：① 独立 `ip_bans` 表取代「按用户行标 ipban」——Picumet 的 IP 封禁要覆盖未注册访客的攻击流量（SDNUChronoSync 的 ipban 只能封已注册用户）；② 保留现有 `banned` 单值 + 新增 `ban_reason` 审计列；③ 登录文案是否模糊化列为待决策；④ 无 emailban 对应物——Picumet 的邀请码 + 邮箱验证已覆盖同邮箱再注册面。

- **明确不做**：账户锁定（已拒绝）；找回密码按邮箱独立限流（已拒绝，复用通用限流）；引入图形验证码（Turnstile 另有完整规划）。
- **测试**：workers `tests/rate-limit-hardening.test.ts`（9 例全量场景全绿）——认证限流阈值可配置（默认 5、自定义值超限 429、0=关闭该档）、管理端设置 PATCH/GET 往返与缓存失效联动、注册成功速率计数（超过 `register_success_per_hour_per_ip` 报 429 `REGISTER_RATE_LIMITED`，0=关闭）、IP 封禁全局门禁（命中 403 通用文案「请求被拒绝」防枚举、过期放行、管理端解封后 KV 缓存写时失效）、管理员豁免防自锁（optionalAuth 已解析会话跳过）、非管理员禁止操作、用户封禁原因 `ban_reason` 落库与清除、`admin_user_status`/`admin_ip_ban`/`admin_ip_unban` 审计日志落库。前端 `Settings.tsx` 安全设置卡（2x2 网关/认证限流网格 + IP 封禁管理与 ConfirmDialog）类型检查与构建通过。

### 2026-10-11 生产实测后续修改清单（S3 网关 / UI / 设置默认值）

Pages 反代架构上线后的实测反馈，全部为**后续修改**待办。安全注：清单中 `sk_` 密钥已掩码（完整密钥只存于用户本地的 PicGo 配置，不入仓库文档）。

| # | 项 | 状态 | 落地内容 |
| :--- | :--- | :--- | :--- |
| 1 | **S3 网关经 Pages 域名不可达（生产缺陷）** | **已修复（本地）** | `frontend/functions/` 新增 `s3/[[path]].ts`、`s3.ts`、`webdav/[[path]].ts`、`webdav.ts`、`openlist/[[path]].ts`、`openlist.ts`，将所有非 `/api` 协议面统一经 Service Binding 内网透传到 Worker，彻底解决静态层 SPA 截胡 / 405 问题。 |
| 2 | **Tooltip 未适配三级模糊** | **已修复（本地）** | `frontend/src/components/ui/tooltip.tsx` 气泡与箭头从硬编码实底 `bg-foreground` 改为 `glass-surface-popover glass-blur border border-border/60 text-popover-foreground shadow-md`，完整接入全站四档模糊/透明度门控体系。 |
| 3 | **系统设置增加「返回 URL」（自定义域/CF 代理）** | **已实现（本地）** | 新增 `return_url`（`returnUrl`）设置项。`loadRoutePrefixes` 读取并清洗、`buildFileAccessUrl` 与 `/copy-links` 优先将其作为 baseOrigin 生成直链与上传响应 URL；管理端「站点设置」卡增加输入框与帮助文案。 |
| 4 | **API 密钥弹窗 S3 配置块逐行复制 + 复制全部** | **已实现（本地）** | `frontend/src/pages/settings/ApiKeys.tsx` S3 配置块每行增加独立悬浮复制按钮，底部增加「复制全部」按钮，复制输出严格按照 `key: value` 格式带末尾换行。 |
| 5 | **API 密钥弹窗加宽** | **已实现（本地）** | 弹窗容器宽度调整为 `max-w-3xl`，长键名与长秘钥单行展示不折行拥挤。 |
| 6 | **个性化「右键单击行为」重排 + 默认值 + 第三选项** | **已实现（本地）** | `rightClickAction` 默认值改为 `'menu'`（打开上下文菜单）；选项顺序调为：上下文菜单 → 属性面板 → 右键多选文件；`Files.tsx` 接入第三选项直接进入多选模式并选中项。 |
| 7 | **过滚动效果默认改为橡皮筋** | **已实现（本地）** | `frontend/src/stores/theme.ts` 中 `DEFAULT.overscrollEffect` 默认值由 `'off'` 改为 `'rubberBand'`（用户已有显式设置不受影响）。 |
| 8 | **创建邀请码生产 500（生产缺陷）** | **已修复（本地）** | `InviteRepo.createBatch` 改为单条条件 `INSERT … SELECT … UNION ALL … WHERE (SELECT COUNT(*) …) + ? <= ?`，消除 D1 事务禁读异常与伪重试逻辑，`tests/invite-codes.test.ts` 28/28 全绿。 |
| 9 | **传输并发槽位泄漏（生产缺陷）** | **已修复** | 槽位心跳 15s 刷新，停跳 60s 视为泄漏不再计数，测试全绿。 |
| 10 | **非平台上传的文件无法索引（新增「索引扫描/导入」功能）** | **待办** | 其他协作者进行中，当前会话不触碰。 |

- **#10 设计要点（索引扫描 / 添加索引，参考 OpenList）**：
  - **触发**：管理端存储管理按挂载点手动触发（默认）；可选挂到定时任务作为「审计不清理」模式。
  - **扫描**：按挂载点 `ListObjects`（Delimiter 分页遍历，复用既有 listObjects 能力），取物理对象全集（key、size、mtime、content-type）。
  - **git 式增删对比**（核心输出，逐挂载点一份 diff）：
    - **新增**（桶有、索引无）→ 收编登记为文件行：保持原物理 key（legacy path 对象语义，应用已支持传统路径键）不动、登记路径/大小/mime/mtime；不读对象内容（不重算 sha256，直接按 legacy 键登记，避免全量读桶流量）。
    - **删除**（索引有、桶无）→ 报告差异；动作可选「移除索引行 / 标记孤儿」，联动配额回退与既有对账语义。
    - 两段式：先 **dry-run 出 diff 清单**（UI 呈现），用户确认后 **apply**。
  - **与既有对账的关系**：定时对账负责「清孤儿」；本功能负责「收编合法外部对象」——收编登记后即脱离孤儿清理范围，两者共用 blob_objects / file_metadata 判定口径，避免互相打架。
  - **设计决策点（实现前定）**：导入文件的属主与配额记账（挂到管理员 / 按挂载点归属）；目录行补建策略；mtime 缺失时的行为；与内容寻址去重的边界（legacy 键不参与 hash 去重）。
- **#8 诊断（2026-10-11）**：`POST /api/invites`（`services/invites/handlers.ts:38`）在 `db.transaction` 内调用 `InviteRepo.countByUser(tx, …)`（读）——2026-09-30「邀请码越权加固 ②」为封 TOCTOU 把「先查后写」收敛进事务，但 **D1 事务（batch 收集器）不支持事务内读**（`db.ts D1Backend.transaction`：`tx.query` 只是收集写语句、返回假 `changes`，读 API 直接抛错）；实验室 vitest 跑 `node:sqlite` 后端（事务内可读），19 例全绿掩盖了生产必炸。同因埋雷：事务内「UNIQUE 码值碰撞 try/catch 重试」在 D1 上也是死代码（收集期拿不到真实错误，batch 失败即整体回滚）。
- **#8 全仓排查**：扫尽 9 处 `db.transaction` 闭包（users/system/blob/role-defaults/storage/mount-role/write/remove/archive）——**仅邀请码一处事务内读**，其余全部纯写，无同类地雷。
- **#8 修复设计（D1 兼容的原子上限）**：放弃事务内读，改**单条条件 INSERT**——`INSERT … SELECT <每码一行 UNION ALL> WHERE (SELECT COUNT(*) FROM invite_codes WHERE created_by = ?) + <count> <= <maxPerUser>`：① 上限校验随插入语句原子生效（D1 单写者串行，并发天然 TOCTOU 安全）；② 语句级 all-or-nothing（任一码 UNIQUE 冲突整句失败，外层重试整批换新码，碰撞概率 ~36⁻⁶ ≈ 0）；③ 不需要事务包装（单语句自带原子性），node:sqlite / D1 双后端行为一致；④ 语义保持「不足全部拒绝（403 INVITE_LIMIT），不做部分创建」。配套：invite-codes 测试补一条「node:sqlite 与 D1 行为一致性」断言说明，避免同类盲区再次静默。

- **S3 配置实测背景（#1/#4）**：用户在 PicGo 配置 `endpoint: https://picumet.pages.dev/s3`、`region: auto`、`bucket: drie`、路径式寻址 `true`，签名请求被 SPA 截胡（见 #1）。#4 的展示块对应 PicGo 所需的全部连接参数。
- **#1 实测（2026-10-11，curl）**：

  | 测试 | 结果 |
  | :--- | :--- |
  | `picumet.pages.dev/s3/` GET（带不带签名头一致） | `200 text/html`，响应体是 SPA `index.html`——静态层截胡，非 S3 XML |
  | `picumet.pages.dev/s3/{bucket}/{key}` PUT / DELETE | `405`（Pages 静态层拒绝非 GET，与签名无关） |
  | `picumet.hxcn.dev/s3/` | 同 pages.dev（`200 text/html` SPA） |
  | `picumet.hxcn.dev` 首页 / `/api` health | `200` / `ok`——**自定义域名已挂到 Pages 项目并正常服务**（zone 已在本账号） |
  | 后端 `picumet.excnies.workers.dev` | `workers_dev = false` 已关闭（404），无公网入口 |

  - **根因**：Worker 协议面路由为 `/api/*`、`/s3(/*)`、`/webdav`、`/openlist(/*)`（`workers/src/index.ts:80-89`），Pages Functions 仅覆盖 `/api/*`；其余前缀落在静态层 → GET 被 SPA 回退截胡、写方法 405。
  - **修复范围（两层）**：① Pages Functions 补 `functions/s3/[[path]].ts`、`functions/webdav/[[path]].ts`、`functions/openlist/[[path]].ts`（与既有 `functions/api/[[path]].ts` 同款透传），部署后 **PicGo（endpoint 允许带 `/s3` 路径前缀）立即可用**；② **minio 类 host-only 客户端**（endpoint 只接受 `host[:port]`，不带路径前缀）需要**专用主机名**：zone `hxcn.dev` 已在本账号，可给 Worker 挂 `s3.hxcn.dev` Custom Domain（`routes` 配置）+ Worker 按 host 把 S3 网关挂到根路径（`/{bucket}/{key}` 直达网关，需 s3gw 解析逻辑兼容无 `/s3` 前缀）——待实现。
  - **文件公网 URL 形态**：上传返回 `data.url`（`APP_BASE_URL` + 直链前缀 + 签名/公开路径）；#3 返回 URL 功能落地前，公网 URL 与上传同域。
- **#3 语义对齐参考**：AList 存储设置的「设定 URL / 自定义域名」；PicList 源码（Context7 查阅）——上传 URL 与返回 URL 的消费差异是本项设计的输入，不是照抄。

### 液态玻璃引入与动效 / 组件优化

引入液态玻璃（liquid glass）质感与更流畅的动画效果，按下列参考组件库逐个评估可借鉴的交互与动效模式（loading button、floating label、OTP 输入、expanding search、skeleton swap、popover/dropdown、hide-on-scroll、new items pill、sortable table、filter grid、poll results、reorder list、particles、sonner toasts、footer、breadcrumb、carousel、combobox、无限嵌套菜单、分段 OTP、motion select、wheel picker 等）：

- <https://www.interior.dev/> 及其组件文档（`/docs/loading-button`、`/docs/floating-label`、`/docs/otp-input`、`/docs/expanding-search`、`/docs/skeleton-swap`、`/docs/popover`、`/docs/dropdown`、`/docs/hide-on-scroll`、`/docs/new-items-pill`、`/docs/sortable-table`、`/docs/filter-grid`、`/docs/poll-results`、`/docs/reorder-list`）
- <https://liquid-glass-oss.vercel.app/>、<https://liquefy-ui.com/>（液态玻璃实现参考）
- <https://coss.com/ui/particles?tags=switch>、<https://shoogle.dev/search?q=dropdown&tab=search&preview=https%3A%2F%2Fcoss.com%2Fui%2Fparticles%3Ftags%3Dmenu>
- <https://reui.io/components/sonner>、<https://ui.watermelon.sh/blocks/footer>
- <https://shadcnstudio.com/docs/components/{breadcrumb,carousel,combobox,sonner}?base=base>
- <https://kokonutui.com/docs/cards/apple-activity-card>、<https://lab.moumen.dev/components/{unlimited-nested-menu,otp-segmented-input}>、<https://beui.dev/components/motion/{select,wheel-picker}>

落地约束沿用既有规范：动画三档门控（`data-motion`）、玻璃三档（`--glass-alpha/--glass-blur`）、Portal 化与卡中卡原则。

### 组件色彩体系：强调色一致性 + shadcn 原色

- 部分组件的 hover / 激活态目前不是当前强调色（primary），逐组件排查并统一到强调色体系。
- 优化 shadcn 组件色彩体系，引入 shadcn 原色（primary/secondary/muted/accent/destructive 的标准语义用法），让自定义强调色与 shadcn 默认 token 语义对齐。

### Workers 运行稳定性调查

- dev 环境下 Workers 经常中断（退出/重启），调查 `/home/excnies/.config/.wrangler/logs/` 中的 wrangler 日志，定位中断原因（崩溃 / OOM / 热重载误触发 / 端口占用等），给出修复或规避方案。

### 存储驱动完善与上传链路修复

- 完善 S3 / R2 / Oracle 等存储驱动，修复文件上传链路遗留问题（已知问题清单见会话记录：`/home/excnies/.omp/agent/sessions/-Picumet/2026-09-28T06-54-28-456Z_01a0e6cb-2668-7450-90d7-699c1d12e680.jsonl`，同批测试暴露的分片/预签名/配额边界问题以此为准）。
- **agent 安全上传与鉴权链路**：agent 调用指定接口不依赖密码鉴权——调用前生成鉴权码，经邮箱发送或浏览器访问交付；鉴权码鉴权 + 用户确认 agent 请求的操作后才放行，agent 执行请求范围外的操作将被拦截。

### 自建 S3 兼容存储的内网接入受限（2026-10-11 确认）

已知缺陷：自建 S3 兼容对象存储（RustFS / MinIO / VersityGW / SeaweedFS 等）**无法以内网地址或非标端口配置为存储后端**，必须以公网 http(s) + 80/443 暴露。协议面本身完全兼容——`S3Provider`（`workers/src/services/storage/s3.ts`）就是通用 S3 endpoint：path-style、SigV4、分片、预签名、Range、DeleteObjects 均经 VersityGW 实验室全链路实测，RustFS 属同类。

- **表现**：管理端创建/更新 Provider（`workers/src/services/admin/storage.ts:80,137`）与自由模式自接存储（`free-mode/handlers.ts:96-100`）统一过 `validateEndpoint`（`workers/src/utils/ssrf.ts`）：仅 http(s)、端口仅 80/443、拒绝私网/回环/保留地址与内嵌凭据，违规 400「存储端点无效：必须为公网 http(s) 地址，且不允许私网/保留地址」。内网 RustFS（如 `http://192.168.1.10:9000`）创建即被拒；`publicDomain` 直链域名（`httpsUrl`）同样拒私网。
- **性质**：有意防护而非疏漏——Worker 会主动请求该地址，属真实 SSRF 面（审计项 SEC-02/SEC-12，回归 `admin-provider-update.test.ts` 与 lab `assert_endpoint_guard`）；且 Workers 运行时出口本就回源不了用户私网，放开校验也连不上。本地实验室靠直写 SQLite 绕过（`scripts/lab/fixtures.py` 的 `seed_provider_direct`），仅限本地开发。
- **实际约束**：自建 S3 需 Nginx/Caddy 等 TLS 反代到 443/80 并暴露公网域名才可接入；纯内网部署（NAS、VPC 内）在 Workers 版不可用。
- **候选方向（待决策）**：① 维持现状——内网自建存储不是 Workers 版的目标部署形态；② 环境变量级私网白名单（如 `S3_ENDPOINT_ALLOWLIST`，管理员显式声明、仅解封指定 endpoint，其余私网段照拒）；③ 并入「将来规划 — Go 高性能版」：自托管部署形态下私网 endpoint 既可达又合理，允许列表 + 校验开关自然落在那一版。

### D1 免费档行读配额耗尽（2026-10-13 事故与修复）

**现象**：生产全站 API 500（`/api/public/settings`、`/api/auth/me`、登录、文件列表全部 `INTERNAL_ERROR`），静态页与 `/api/public/health` 正常；回滚 Worker 版本无效。tail 抓到真实异常：`D1_ERROR: Your account has exceeded D1's free tier daily row read limit`（免费档 5,000,000 行读/日，UTC 午夜重置）。

**消耗画像**（`wrangler d1 insights` 近 24h，top 查询）：

| 查询 | 行读 | 次数 | 单次 | 归因 |
| :--- | ---: | ---: | ---: | :--- |
| 文件列表 `SELECT *, COUNT(*) OVER () … FROM file_metadata WHERE mount_id = ? AND ((type='file' AND path=?) OR (type='folder' AND <childFolderMatch>))` | 3.6M | 1,234 | ~2,900 行 | `childFolderMatch` 的 `path > ?` 范围**无上界**：`(mount_id, path)` 索引区间扫描会读过同挂载点内字母序靠后的全部路径（如列 `/public` 时扫过 `/uploads` 全部行）再靠 `substr` 过滤 |
| 目录树（`listDescendants`/扁平树 join） | 2.7M | 106 | **~25,000 行** | 根路径 `/` 与整棵子树查询语义上就是全库扫描（全库 2,835 行 + join 放大），每次展开文件页树/管理端树/移动对话框都是一次全表 |
| `SELECT COUNT(*)`/`SUM(size)` 聚合（对账 cron + 仪表盘） | ~0.9M | ~200 | 全表 | cron `*/10` 每 10 分钟一轮全表对账；仪表盘每次打开全表计数 |

密集浏览/测试期（另一 agent 的文件管理测试 + 部署验证反复列目录）单日即打穿额度；免费档下 2,835 文件的库大约只能支撑 ~1,700 次列表/日。

**已落地修复（部署版本 `0886785c`，2026-10-13）**：

| 修复 | 落点 | 预期效果 |
| :--- | :--- | :--- |
| 前缀谓词上界 `path < p0`（非根目录；`'/'(0x2F) < '0'(0x30)` ⇒ `p/…` < `p0`，兄弟路径被范围直接排除） | `workers/src/utils/path.ts` `prefixBound` + `prefixMatch`/`subtreeMatch`/`childFolderMatch`（全部调用方语义不变，`substr` 仍兜底） | 列表/子树类查询行读从「挂载点内字母序靠后全部」收窄到真实子树，降约一个数量级 |
| `SettingsRepo` isolate 级 60s 缓存（`getAll` 全表 + 单键 `get` 走同一缓存；`set()` 即失效；测试 `createTestContext` 与直写设置的用例显式 `invalidateSettingsCache()`） | `workers/src/db/repos/system.ts`、`tests/helpers.ts` + 11 个测试文件 | settings 全表读 839 次/日与 captcha 15 键逐键点查归零（缓存内取值）；captcha 自身冗余缓存层删除（失效顺序不再是隐藏契约） |
| cron 全表聚合对账每小时节流（`getUTCMinutes() < 10` 的整点轮才跑：`repairMovedFolderOrphans`/`reconcileQuotas`/`reconcileBlobs`/`cleanupBlobObjects`；会话/分享过期等索引点查保持 `*/10`） | `workers/src/services/cleanup.ts` | 对账类 ~60 万行/日 → ~6 万行/日（对账本就是兜底自愈，小时级延迟不影响正确性） |

**残余风险（未解决）**：

- **树查询仍是全库扫描**——根路径无上界是语义正确（整棵树本来就要全量），单次 ~2.5 万行；反复展开文件页树/管理端树/移动对话框仍是单日额度黑洞。候选优化：树懒加载逐层取子（前端契约变更）、树结果按挂载点缓存（失效挂钩写路径）、或物化 path 层级表。
- 免费档与当前使用强度（持续测试 + 多端浏览）不匹配，列表优化后仍可能被高频树操作打穿。**治本选项**：升级 Workers Paid（$5/月，D1 行读上限提升数个量级）。

**运维注意**：`wrangler d1 execute --remote` / `wrangler deploy` 走 Cloudflare 控制面 API，与配额无关的 `api.cloudflare.com` 链路故障（2026-10-13 曾整体不可达数小时）会同时阻塞部署、回滚与直连改库，与 D1 配额耗尽症状（站点 500 但边缘正常）相互独立，排障时先区分。

### 出口机制与协议兼容完善

- 完善出口（对外提供文件）机制；完善 WebDAV / S3 / MinIO / OpenList（AList）协议兼容面。
- 探索实现类似 SSH 文件浏览（远端目录树逐级浏览 + 就地操作）的交互机制，以及 **WebDAV 挂载**——把外部 WebDAV 端点作为存储后端挂载进来（与 S3 provider 同级的新驱动形态）。
- **agent 安全上传与鉴权链路**：agent 鉴权不走密码——调用指定接口前生成鉴权码（邮箱发送 / 浏览器访问交付），鉴权码鉴权并确认 agent 请求的操作后才放行，越界操作拦截。
- **访问密钥账号密码鉴权**：访问密钥创建时可选鉴权方式——默认 APP ID（pk_*）+ key（sk_*），或开启「账号密码」模式（以 Picumet 用户名 + 密码代替 APP ID/key 鉴权，适合 agent 直接使用）；**创建时选择、只能选择一次**（创建后不可变更）。账号密码模式不适用于 S3 网关（SigV4 必须密钥对），仅 WebDAV Basic / Bearer / OpenList(AList) 等账号密码可承载的协议面。规划待落地：`api_keys.auth_mode` 列（app_secret / password）、每用户仅一条 password 模式密钥（保证账号密码唯一映射到密钥范围）、鉴权中间件账号密码分支 + 认证限流、前端创建表单单选。

### SMTP 完整测试

- SMTP 链路完整测试：管理端测试邮件、注册验证码、找回密码、邮箱变更 OTP 全部走通（实验室 SMTP sink 已可断言真实投递），覆盖 TLS/STARTTLS 与鉴权配置组合。

### 第一版上线准备

- 完成手动测试清单（对照 `run_all.py` 各模块 + 浏览器手测），准备上线第一版。

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
