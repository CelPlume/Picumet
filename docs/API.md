# Picumet API 设计

> 由 spec.md「API 设计」章节与源码（`workers/src/services/*/handlers.ts`）整合而成。
> 路由为源码事实；请求/响应字段说明以 spec 为设计基准。

## 认证方式

| 方式 | Header | 适用场景 |
|------|--------|----------|
| **JWT Cookie** | `Cookie: auth_token=...` | Web 前端 |
| **API Key Bearer** | `Authorization: Bearer pk_x.sk_y` | PicGo/脚本上传 |
| **WebDAV Basic** | `Authorization: Basic base64(keyId:secret)` | WebDAV 客户端 |

## 统一响应格式

```typescript
// 成功
interface SuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
  timestamp: number;
}

// 错误
interface ErrorResponse {
  success: false;
  error: {
    code: string;           // ERROR_CODE
    message: string;        // 用户友好消息
    details?: unknown;      // 详细信息（dev 环境）
  };
  timestamp: number;
}
```

## 错误码

```typescript
enum ErrorCode {
  // 认证
  UNAUTHORIZED, INVALID_TOKEN, EMAIL_NOT_VERIFIED,
  // 权限
  FORBIDDEN, PASSWORD_REQUIRED, INVALID_PASSWORD,
  // 资源
  NOT_FOUND, ALREADY_EXISTS,
  // 配额
  QUOTA_EXCEEDED, FILE_TOO_LARGE,
  // 限流
  RATE_LIMIT_EXCEEDED,
  // 验证
  VALIDATION_ERROR, INVALID_PATH,
  // 操作
  OPERATION_FAILED, UPLOAD_SESSION_EXPIRED,
  // 用户状态
  USER_DISABLED, ROLE_CHANGED, INVALID_CREDENTIALS,
  // 分享
  SHARE_REVOKED, SHARE_EXPIRED, SHARE_LIMIT_REACHED,
  // 安全
  DANGEROUS_FILE_TYPE, DANGEROUS_MIME_TYPE, INVALID_CSRF,
}
```

## 端点一览

| 分组 | 方法 | 路径 | 认证 |
|---|---|---|---|
| 公开 | GET | `/api/public/settings` | 公开 |
| 公开 | GET | `/api/public/announcements` | 公开 |
| 公开 | GET | `/api/public/health` | 公开 |
| 公开 | GET | `/api/public/health/live` | 公开（存活探针） |
| 公开 | GET | `/api/public/health/ready` | 公开（就绪探针，未初始化 503） |
| 网关 | GET | `/api/gateway/download/:token` | 令牌 |
| 认证 | POST | `/api/auth/register` | 公开 |
| 认证 | POST | `/api/auth/login` | 公开 |
| 认证 | POST | `/api/auth/logout` | 公开 |
| 认证 | GET | `/api/auth/me` | 登录 |
| 认证 | GET | `/api/auth/csrf-token` | 登录 |
| 认证 | GET | `/api/auth/verify-email?token=` | 公开 |
| 认证 | GET | `/api/auth/verify?token=` | 公开（别名） |
| 认证 | POST | `/api/auth/forgot-password` | 公开 |
| 认证 | POST | `/api/auth/reset-password` | 公开 |
| 文件 | GET | `/api/files?path=&page=&limit=` | 登录 |
| 文件 | POST | `/api/files/folder` | 登录 |
| 文件 | GET | `/api/files/:id` | 登录 |
| 文件 | PUT | `/api/files/:id` | 登录 |
| 文件 | POST | `/api/files/:id/verify-password` | 登录 |
| 文件 | GET | `/api/files/:id/download` | 登录 |
| 文件 | GET | `/api/files/:id/copy-links` | 登录 |
| 文件 | DELETE | `/api/files/:id` | 登录 |
| 文件 | POST | `/api/files/:id/move` | 登录 |
| 文件 | GET | `/api/files/jobs/:jobId` | 登录 |
| 文件 | POST | `/api/files/batch` | 登录 |
| 上传 | POST | `/api/files/upload-session` | 登录 |
| 上传 | PUT | `/api/files/upload/raw/:sessionId` | 登录 |
| 上传 | PUT | `/api/files/upload/multipart/:sessionId/part/:partNumber` | 登录 |
| 上传 | GET | `/api/files/upload/multipart/:sessionId/parts` | 登录 |
| 上传 | DELETE | `/api/files/upload/multipart/:sessionId` | 登录 |
| 上传 | POST | `/api/files/upload-complete` | 登录 |
| 兼容 | POST | `/api/upload` `/api/upload/upload` `/api/compat/upload` | API Key |
| 分享 | POST | `/api/shares/` | 登录 |
| 分享 | GET | `/api/shares/` | 登录 |
| 分享 | GET | `/api/shares/:id` | 公开 |
| 分享 | POST | `/api/shares/:id/verify` | 公开（密码验证，种短期授权 cookie） |
| 分享 | GET | `/api/shares/:id/download` | 公开 |
| 分享 | GET | `/api/shares/:id/preview` | 公开 |
| 分享 | DELETE | `/api/shares/:id` | 登录 |
| 用户 | GET | `/api/users/me/settings` | 登录 |
| 用户 | PUT | `/api/users/me/settings` | 登录 |
| 用户 | PUT | `/api/users/me/password` | 登录 |
| 密钥 | POST | `/api/keys/` | 登录 |
| 密钥 | GET | `/api/keys/` | 登录 |
| 密钥 | GET | `/api/keys/rules` | 登录 |
| 密钥 | DELETE | `/api/keys/:id` | 登录 |
| 管理 | GET | `/api/admin/dashboard` `/api/admin/stats` | 管理员 |
| 管理 | GET/PUT/DELETE | `/api/admin/users[/:id]` | 管理员 |
| 管理 | GET/DELETE | `/api/admin/shares[/:id]` | 管理员 |
| 管理 | GET | `/api/admin/files` | 管理员 |
| 管理 | GET | `/api/admin/logs` | 管理员 |
| 管理 | GET/PATCH | `/api/admin/settings` | 管理员 |
| 管理 | GET/POST/PUT/DELETE | `/api/admin/announcements[/:id]` | 管理员 |
| 管理 | GET/POST/PUT/DELETE | `/api/admin/storage/providers[/:id]` | 管理员 |
| 管理 | POST | `/api/admin/storage/providers/:id/test` | 管理员 |
| 管理 | GET/POST/PUT/DELETE | `/api/admin/mounts[/:id]` | 管理员 |
| 管理 | GET/POST/PUT/DELETE | `/api/admin/rules[/:id]` | 管理员 |
| 自由模式 | POST | `/api/free-mode/init` | 公开（限流） |
| 自由模式 | GET | `/api/free-mode/files` | 会话 |
| 自由模式 | POST | `/api/free-mode/upload` | 会话 |
| 自由模式 | DELETE | `/api/free-mode/object` | 会话 |
| 自由模式 | POST | `/api/free-mode/logout` | 会话 |
| WebDAV | OPTIONS | `/webdav/*` | - |
| WebDAV | PROPFIND | `/webdav/*` | API Key |
| WebDAV | MKCOL | `/webdav/*` | API Key |
| WebDAV | PUT | `/webdav/*` | API Key |
| WebDAV | GET | `/webdav/*` | API Key |
| WebDAV | DELETE | `/webdav/*` | API Key |
| WebDAV | MOVE | `/webdav/*` | API Key |

---

## 详细端点

### 1. 认证 (Auth)

#### POST /api/auth/register

**请求**:
```typescript
{
  username: string;        // 3-20字符，字母数字下划线
  password: string;        // 最少8字符，最多128
  email: string;           // 必需
  inviteCode?: string;     // 邀请码（如果启用）
  turnstileToken?: string; // 如果启用 Turnstile
}
```

**响应**:
```typescript
{
  success: true;
  data: {
    user: { id, username, email, emailVerified, role, ... };
    message: '验证邮件已发送到 xxx@example.com' | '注册成功';
  }
}
```

**副作用**: 发送验证邮件；开发环境无 SMTP 时自动验证邮箱。限流 5 次/分钟/IP。

#### POST /api/auth/login

**请求**:
```typescript
{ username: string; password: string; turnstileToken?: string }
```

**响应**: `data: { user: {...}, quota: {...} }`

**副作用**: 设置 HttpOnly Cookie `auth_token`（`SameSite=Strict`，7 天）。限流 5 次/分钟/IP。

#### POST /api/auth/logout — 清除 Cookie。
#### GET /api/auth/me — 当前用户 + 配额。
#### GET /api/auth/csrf-token — 返回 `{ token }`（KV 中缓存 2 小时，写操作需携带）。
#### GET /api/auth/verify-email?token= / GET /api/auth/verify?token= — 邮箱验证（兼容别名）。
#### POST /api/auth/forgot-password — `{ email }`；不暴露用户是否存在。
#### POST /api/auth/reset-password — `{ token, password }`（密码 ≥8 位）。

### 2. 文件管理 (Files)

#### GET /api/files

查询参数：`path`（默认 `/`）、`page`、`limit`（≤1000）、`sort`（name/time/size/manual）、`order`（asc/desc）、`type`（file/folder）、`search`。

**响应**: `data: { items: FileListItem[], pagination: { total, page, limit, pages }, mount }`

#### POST /api/files/folder — `{ path, name }` 创建文件夹（需 write 权限，同名冲突 409）。

#### GET /api/files/:id — 文件详情。`data: { file, mount, permissions: string[], accessMode, hasPassword }`

#### PUT /api/files/:id — 更新元数据/重命名/设密码。

```typescript
{ name?, customTitle?, customColor?, coverUrl?, iconEmoji?, accessPassword?, manualPosition? }
```

#### POST /api/files/:id/verify-password — `{ password }`；成功返回 `{ url, expiresIn: 900 }`（下载令牌）。

#### GET /api/files/:id/download — 受密码保护返回 403 `PASSWORD_REQUIRED`；否则返回 `{ url, expiresAt }`（网关下载链接）。

#### GET /api/files/:id/copy-links — 返回 `{ formats: { direct, html, markdown, bbcode }, accessMode, needsPassword }`。

#### DELETE /api/files/:id — 硬删除（先删元数据 + 配额原子事务，对象异步清理；需 delete 权限）。

#### POST /api/files/:id/move — `{ targetPath, newName? }` 移动（Saga：源 delete + 目标 write 双重权限）。

#### GET /api/files/jobs/:jobId — 移动任务状态（仅本人可查）。

#### POST /api/files/batch — `{ action: 'delete'|'move', fileIds: string[], targetPath?, permanent? }` 批量操作。

### 3. 上传 (Uploads)

#### POST /api/files/upload-session

**请求**:
```typescript
{
  path: string;             // 目标目录
  fileName: string;         // ≤255 字符
  fileSize: number;         // ≤20GB
  mimeType?: string;
  partCount?: number;       // 分片数（可选）
  idempotencyKey?: string;  // 幂等键
}
```

**响应**: `data: { sessionId, uploadUrl?, expiresAt, alreadyCompleted? }`。配额原子预留，超限 403。

#### PUT /api/files/upload/raw/:sessionId — Worker 代理直传（body 为文件字节）。

#### PUT /api/files/upload/multipart/:sessionId/part/:partNumber — 分片上传（Worker 代理，8MB/片）。

#### GET /api/files/upload/multipart/:sessionId/parts — 已上传分片列表（断点续传契约）。

#### DELETE /api/files/upload/multipart/:sessionId — 中止分片上传（释放预留配额）。

#### POST /api/files/upload-complete

**请求**: `{ sessionId, etag }`

**流程**: HEAD 校验对象存在 + ETag/Size 匹配（防伪造）→ 原子提交（元数据 + 配额 + 会话完成）。校验失败返回 400 并释放配额。

**状态机**: 单文件 `pending → uploading → verifying → completed`；分片 `pending → uploading → parts_uploaded → completing → completed`（含 failed/expired/aborted）。

### 4. 兼容上传（PicGo/PicList）

#### POST /api/upload（及 `/api/upload/upload`、`/api/compat/upload`）

Bearer API Key 认证。支持：
- `multipart/form-data`：`file` 字段 + 可选 `path`
- 原始 body：`X-File-Name` / `filename` 头 + `X-Path` 头

> **流式上传**（审计 H-03）：multipart 用 `file.stream()`、原始 body 用请求流直接转发对象存储（`Content-Length` 已知则流式；缺失回退读取），避免整包读入 Worker 内存。

**响应**: `{ success: true, data: { url, fileId, ... } }`

### 5. 分享 (Shares)

#### POST /api/shares/ — 创建分享。

```typescript
{
  fileId: string;
  title?: string;
  password?: string;
  expiresIn?: number;    // 秒，60 ~ 365天
  maxViews?: number;
  maxDownloads?: number;
  allowPreview?: boolean;
  allowDownload?: boolean;
}
```

需 share 权限。**响应**: `data: { share: { id, title, ... } }`（分享 id 为短码）。

#### GET /api/shares/ — 我的分享列表。

#### GET /api/shares/:id — 公开分享信息（无需登录）。密码保护时 `requiresPassword: true`（授权 cookie 或 `?password=` 兼容）。

#### POST /api/shares/:id/verify — `{ password }`（审计 M-02：密码经请求体提交，不入 URL）；成功后种短期 HttpOnly 授权 cookie `share_auth_<id>`（15 分钟，KV 校验），后续 GET/download/preview 不再携带密码。

#### GET /api/shares/:id/download — 返回 `{ url, expiresIn: 900 }` 网关下载链接（需密码时先经 verify 或 cookie）。签发令牌阶段不计数，下载计数仅在网关消费令牌时增加一次（审计 H-04）。

#### GET /api/shares/:id/preview — 图片直出（带预览权限时）。

#### DELETE /api/shares/:id — 撤销分享（仅创建者）。

### 6. 用户设置 (Users)

- **GET /api/users/me/settings** — `data: { profile, appearance, quota }`
- **PUT /api/users/me/settings** — `{ displayName?, avatarUrl?, locale?, theme?, defaultPath? }`
- **PUT /api/users/me/password** — `{ oldPassword, newPassword }`（旧密码错误 401）

### 7. API 密钥 (Keys)

#### POST /api/keys/ — 创建密钥。

```typescript
{
  name: string;
  permissions: ('read'|'write'|'delete')[];
  protocols: ('webdav'|'api')[];
  uploadPath?: string;   // 默认 '/uploads'，规范化（拒绝 .. 逃逸）
  allowedIps?: string[];
  expiresIn?: number;
}
```

**响应**: `data: { key: { id, keyId, secret, token, configs: { webdav, bearer } } }` — 令牌仅此一次显示，落库存 `sha256Hex` 哈希。上限 20 个活跃密钥。

#### GET /api/keys/ — 密钥列表（不含 secret）。
#### GET /api/keys/rules — 密钥可用权限规则（展示/调试）。
#### DELETE /api/keys/:id — 撤销密钥。

### 8. 管理员 (Admin)

- **GET /api/admin/dashboard** — `data: { stats, storage, recentActivity, requests24h }`
- **GET /api/admin/stats** — 用户/文件/存储统计
- **GET /api/admin/users** — 分页用户列表；**PUT /api/admin/users/:id** — 改角色/状态/配额；**DELETE** — 删除（不能删自己）
- **GET /api/admin/shares** — 全局分享列表；**DELETE /api/admin/shares/:id** — 撤销
- **GET /api/admin/files** — 全部文件列表
- **GET /api/admin/logs** — 访问日志（分页）
- **GET/PATCH /api/admin/settings** — 系统设置
- **GET/POST/PUT/DELETE /api/admin/announcements[/:id]** — 公告管理

#### 存储提供商 (Storage Providers)

- **GET /api/admin/storage/providers** — 列表（含 `hasCredentials` 标记）
- **POST /api/admin/storage/providers** — `{ name, type: 'r2'|'s3'|'oracle', endpoint?, region?, bucket, accessKeyId?, secretAccessKey?, publicDomain?, uploadDomain?, pathPrefix? }`；R2 绑定模式 endpoint 为空；非绑定 endpoint 过 SSRF 校验
- **PUT /api/admin/storage/providers/:id** — 更新（凭据加密存储）
- **POST /api/admin/storage/providers/:id/test** — 连通性测试
- **DELETE /api/admin/storage/providers/:id** — 删除（有挂载 409）

#### 挂载点 (Mounts)

- **GET /api/admin/mounts** — 列表（含 provider 信息）
- **POST /api/admin/mounts** — `{ providerId, mountPath, name, sortBy?, sortOrder?, priority? }`
- **PUT /api/admin/mounts/:id** — 更新
- **DELETE /api/admin/mounts/:id** — 删除（下有文件 409）

#### 权限规则 (Rules)

- **GET /api/admin/rules** — 规则列表（passwordHash 脱敏）
- **POST /api/admin/rules** — `{ pathPattern, effect, mountId?, role?|userId?|apiKeyId?（三选一）, permissions[], requirePassword?, password?, allowedIps?, priority? }`（`mountId` 为空 = 全局规则，所有挂载生效；审计 H-01 挂载隔离）
- **PUT /api/admin/rules/:id** — 更新
- **DELETE /api/admin/rules/:id** — 删除

### 9. 自由模式 (Free-Mode)

用户自带对象存储凭据的临时会话。中间件：Origin + Sec-Fetch-Site 跨站防护、会话级 CSRF、fail-closed 限流。

- **POST /api/free-mode/init** — `{ type: 'r2'|'s3'|'oracle', endpoint, region?, bucket, accessKeyId, secretAccessKey, sessionHours? }`；endpoint 过 SSRF 校验（私网/非法 scheme 400）；凭据 AES-GCM 加密写入 KV；设置 `fm_token` Cookie
- **GET /api/free-mode/files** — 文件列表（需会话）
- **POST /api/free-mode/upload** — 上传（≤1GB，需会话 + CSRF；流式转发，审计 H-03）
- **DELETE /api/free-mode/object?key=** — 删除对象（路径边界校验）
- **POST /api/free-mode/logout** — 退出（清 KV 会话）

### 10. WebDAV

Basic 认证 `base64(keyId:secret)`；全部方法接入统一路径级权限服务。

| 方法 | 说明 | 权限 |
|---|---|---|
| OPTIONS | 声明 DAV 能力（DAV: 1,2） | - |
| PROPFIND | 列目录（XML multistatus，href 转义） | read |
| MKCOL | 创建文件夹 | write（上传根内） |
| PUT | 上传（流式转发，审计 H-03） | write（上传根内） |
| GET/HEAD | 下载/信息 | download/read |
| DELETE | 删除 | delete |
| MOVE | 移动/重命名（复用移动 Saga） | 源 delete + 目标 write |

### 11. 下载网关

#### GET /api/gateway/download/:token

消费一次性下载令牌（D1 原子消费）→ 流式代理对象。文件受密码保护且令牌未验证时 403 `PASSWORD_REQUIRED`。记录下载日志、分享下载计数。

---

## 相关文档

- [系统架构](ARCHITECTURE.md)
- [页面设计](UI.md)
- [开发指南](DEVELOPMENT.md)
- [部署指南](DEPLOYMENT.md)
- [技术规格（完整版）](../spec.md)
