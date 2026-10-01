# SSO Service（第三方登录服务）

第三方身份登录：Google、GitHub 与自托管 OIDC 提供商（authentik / logto / casdoor / Keycloak 等）。
管理员在系统设置「注册设置」分组打开总开关，并在「OIDC 设置」弹窗里增删来源。

## 端点

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/auth/sso/:id/start` | 生成 state + PKCE + nonce（KV 10 分钟）并写 `sso_tx` 绑定 Cookie 后 302 到提供方授权端点 |
| GET | `/api/auth/sso/:id/callback` | 校验 `sso_tx` 绑定 Cookie → 换 token → 验签/取档案 → 登录 / 自动关联 / 转补充注册（302） |
| GET | `/api/auth/sso/pending?token=` | 补充注册页读取待填档案（不含令牌）；需携带 `sso_pending` 绑定 Cookie |
| POST | `/api/auth/sso/complete` | 需携带 `sso_pending` 绑定 Cookie；用户自填邮箱/用户名/密码（+ 验证码 + 邀请码）建号、关联身份并登录 |
| GET | `/api/admin/sso/providers` | 管理端来源列表（密钥掩码 + 需注册的回调地址） |
| POST | `/api/admin/sso/providers` | 新建来源 |
| PATCH | `/api/admin/sso/providers/:id` | 更新（`clientSecret` 传 `''`/`******` = 保持原值） |
| DELETE | `/api/admin/sso/providers/:id` | 删除来源（身份关联随外键级联删除） |

## 文件

| 文件 | 职责 |
| :--- | :--- |
| `config.ts` | 总开关、公开配置装配、issuer/端点地址校验、凭据 `enc:` 加解密、回调地址、默认 scope |
| `oidc.ts` | 协议层：discovery（KV 缓存 1 小时）、授权跳转、code 换 token、id_token 验签、档案归一化（GitHub 特例） |
| `handlers.ts` | 路由与归属判定（既有身份 → 直接登录；提供方已验证邮箱命中 → 自动关联；否则补充注册） |
| `schemas.ts` | 管理端配置与补充注册的 Zod 校验（账号字段规则复用 `services/auth/schemas.ts`） |
| `../../services/admin/sso.ts` | 管理端来源 CRUD（挂在 `adminApi`：认证 + admin + CSRF + 限流） |

## 设置键与数据模型

| 键 / 表 | 说明 |
| :--- | :--- |
| `system_settings.sso_enabled` | 站点总开关（迁移 `0012_sso.sql` 种子）；关闭 = 全部 SSO 入口拒绝、公开面不展示按钮 |
| `sso_providers` | 来源配置：kind（google/github/oidc）、名称、issuer、client_id、client_secret（`enc:` 密文）、scopes、enabled、**trust_email_verified**（迁移 `0013_sso_trust.sql`） |
| `sso_identities` | 身份关联：（provider_id, subject）唯一 + user_id，附提供方档案快照与 access/refresh token（均 `enc:` 密文） |
| env `SSO_ALLOW_LOOPBACK` | `'true'` 且非生产环境才允许回环 issuer（本地 IdP 联调）；缺省不放行 |

- `google` / `github` 走内置端点，各至多一条（部分唯一索引 `idx_sso_providers_singleton` 兜底）；`oidc` 数量不限、issuer 由管理员填写。
- 单例与来源顺序即登录页按钮顺序（创建时间升序）。
- `trust_email_verified` 语义：开启后，提供方声明「已验证」的邮箱可用于**自动关联既有账号**。
  内置来源默认开启（邮箱验证由 Google/GitHub 保证），自定义 OIDC 默认关闭——其 issuer 只过地址白名单，
  若该 IdP 允许用户自填任意邮箱并回 `email_verified=true`，开启它就等于允许接管任意既有账号。
  关闭时这些用户走补充注册页；若提交的邮箱已属于既有账号则返回 `409 ALREADY_EXISTS`（提示改用密码登录）。

## 登录语义

1. `(provider_id, subject)` 已关联 → 直接登录（刷新凭据与档案快照）。
2. 提供方**已验证**的邮箱命中既有账号 → 自动关联并登录（等价于邮箱控制权证明，顺带补 `users.email_verified`）。
3. 其余 → 暂存档案（KV 15 分钟一次性令牌）→ 前端 `/sso/complete`：用户自填邮箱 / 用户名 / 密码，
   不复用提供方档案（可一键预填邮箱与用户名），第三方身份与令牌仍在完成时落库。

登录态与密码登录完全一致：同一 JWT Cookie（`services/auth/session.ts` 单一出口）、同一 `session_version` 撤销通道。

## 安全约束

- **授权事务与浏览器绑定（防登录 CSRF / 会话固定）**：`/start` 除写 KV 外，还给发起浏览器写一份
  `sso_tx`（值 = state）HttpOnly + `SameSite=Lax` Cookie（Path 限 `/api/auth/sso`）；回调必须携带同值 Cookie，
  否则 `SSO_STATE_INVALID`。补充注册同理：回调下发 `sso_pending`（值 = 待办令牌），`/pending` 与 `/complete`
  都必须携带同值 Cookie。攻击者无法为受害者浏览器预置 Cookie，因此「把自己的回调/补充注册链接转发给受害者」
  不再能让受害者拿到攻击者账号的会话，也无法把身份关联到攻击者的 subject 上。
  任何回调尝试都会作废该 state（一次性），绑定 Cookie 用后即清。
- **issuer / 端点地址**：生产口径同 `validateEndpoint`（公网 http(s)、端口 80/443、拒私网/回环/内嵌凭据），
  额外要求 issuer 不带 query 与 fragment、discovery 文档必须声明 `issuer` 且与配置一致；
  discovery 文档里的 authorization / token / jwks / userinfo 端点逐个复核地址白名单，**缓存读取同样复核**
  （缓存只是加速手段，不是信任来源），userinfo 在每次使用前再复核一次。
  回环 issuer 需要显式开关 `SSO_ALLOW_LOOPBACK=true` **且**非生产环境（生产无论该变量为何都不放行）。
- **不跟随上游重定向**：所有上游请求 `redirect: 'manual'`，任何 3xx 直接判失败（`SSO_UPSTREAM_REDIRECT`）——
  否则被入侵/恶意提供方可用 302 把带 `client_secret` 的 token 请求或带 Bearer token 的 userinfo 读取
  引向内网 / 云元数据地址。
- **PKCE S256 + nonce**：OIDC 一律携带，`id_token` 用 issuer JWKS 本地验签（`jose`）并校验 `iss`/`aud`/`nonce`
  （算法混淆由 jose 的 key/alg 兼容性检查挡下；失败不区分原因、细节只进服务端日志）。
- **GitHub 特例**：不签发 id_token，走 OAuth2 web application flow，回调后取 `/user` 与 `/user/emails`（primary 且 verified）。
- **凭据落库**：`client_secret` / `access_token` / `refresh_token` 全部 AES-256-GCM（`enc:` 前缀，`ENCRYPTION_KEY`）；
  补充注册的暂存上下文（KV，15 分钟）同样只存密文；管理端列表与详情只回掩码 `******`；审计只记键不记值。
- **邮箱语义**：验证码的判定基准是**本次提交的邮箱**（提供方验证过 A 邮箱不能免掉 B 邮箱的验证码）；
  自动关联既有两个前置——来源 `trust_email_verified` 开启且提供方声明该邮箱已验证——并且邮箱比较大小写无关
  （`users.email` 是 BINARY 排序，精确匹配会漏掉大小写变体并允许同一邮箱建出两个账号）。
  注册 / 改绑邮箱 / 补充注册的查重统一走 `UserRepo.findByEmailInsensitive`。
- **来源停用即失效**：`/pending` 与 `/complete` 都会复检 `provider.enabled`（与 `/start`、`/callback` 同口径），
  停用来源不会因为「已发放在途令牌」而在 15 分钟内继续建号。
- **Auth.js 未采用**：其 provider 列表为构建期静态配置、自带 session/adapter 表结构，与本项目
  「D1 运行时配置 + 自签 JWT Cookie + 自定义补充注册页」三处冲突（评估记录见 docs/ARCHITECTURE_CN.md）。

## 安全审计（2026-09-30）

本轮对 SSO 面做过一次独立安全审计（code-audit + 独立 review agent），落地修复见 `workers/tests/sso.test.ts`
「安全回归」分组（12 例）：绑定 Cookie、验证码以提交邮箱为准、信任开关、大小写无关邮箱、3xx 重定向拒绝、
discovery 缺 issuer / 内网端点拒绝、停用来源拒绝、KV 不落明文令牌。
