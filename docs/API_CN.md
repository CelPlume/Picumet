<div align="center">

<img src="../assets/logo.svg" alt="Picumet Logo" width="128" />

# Picumet API 参考

**多云对象存储管理平台**

[English](API.md) | 中文

</div>

本文介绍 Picumet 的 REST API。平台把文件分布到多个对象存储提供商，通过令牌网关统一放行下载，同时兼容 WebDAV 和 PicGo 客户端。端点按资源分组，所有响应共用同一套信封结构。

## 开始之前

- **基础地址**：Workers 应用部署后的域名，例如 `https://{domain}`。本文所有路径都相对于该域名。
- **认证**：根据客户端类型，请求使用三种认证方式之一。
- **CSRF**：使用 Cookie 认证的写请求必须携带 `X-CSRF-Token` 头，令牌通过 `GET /api/auth/csrf-token` 获取。API 密钥和 WebDAV 请求不检查 CSRF。
- **请求格式**：JSON 请求体使用 `Content-Type: application/json`；文件上传使用 `multipart/form-data` 或原始字节流。
- **限流**：认证类端点按 IP 每分钟最多 5 次；其余端点按用户和 IP 应用可配置的限额。

### 认证方式

| 方式 | Header | 适用场景 |
| :--- | :--- | :--- |
| HttpOnly Cookie JWT | `Cookie: auth_token=...` | Web 前端、浏览器客户端 |
| API 密钥（Bearer） | `Authorization: Bearer {key_id}.{secret}` | PicGo、PicList、脚本、自定义客户端 |
| WebDAV Basic | `Authorization: Basic base64({key_id}:{secret})` | WebDAV 客户端 |

API 密钥是不透明令牌，格式为 `pk_{24 位}.sk_{48 位}`。服务端只保存完整令牌的 SHA-256 哈希，创建后无法再次查看原文。

## 响应格式

所有成功响应使用同一信封。

```json
{
  "success": true,
  "data": { },
  "message": "可选提示",
  "timestamp": 1710000000000
}
```

### 成功响应字段

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `success` | `boolean` | 成功响应恒为 `true`。 |
| `data` | `object` | 资源数据，形状随端点而定。 |
| `message` | `string` | 可选的人类可读提示。 |
| `timestamp` | `integer` | 服务器时间，Unix 毫秒。 |

失败的请求返回错误信封，同时携带 HTTP 状态码和稳定的错误码。

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "文件不存在",
    "details": {}
  },
  "timestamp": 1710000000000
}
```

### 错误响应字段

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `success` | `boolean` | 错误响应恒为 `false`。 |
| `error.code` | `string` | 稳定的机器可读错误码，如 `NOT_FOUND`。 |
| `error.message` | `string` | 人类可读的错误说明。 |
| `error.details` | `object` | 附加信息，仅在开发环境返回。 |
| `timestamp` | `integer` | 服务器时间，Unix 毫秒。 |

## 错误码

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 请求字段或查询参数不符合格式。 | 修正字段后重试。 |
| `INVALID_CREDENTIALS` | `401` | 用户名或密码错误。 | 重新输入凭据。 |
| `UNAUTHORIZED` | `401` | 请求没有有效的会话或 API 密钥。 | 先登录或提供有效密钥。 |
| `INVALID_TOKEN` | `401` | 会话令牌、API 密钥或下载令牌无效或已过期。 | 刷新凭据后重试。 |
| `INVALID_PASSWORD` | `401` | 文件、文件夹或分享密码错误。 | 重新输入密码。 |
| `USER_DISABLED` | `401` | 账号已被禁用。 | 联系管理员。 |
| `ROLE_CHANGED` | `401` | 会话开始后账号角色发生变化。 | 重新登录。 |
| `SESSION_REVOKED` | `401` | 会话因改密或登出而失效。 | 重新登录。 |
| `EMAIL_NOT_VERIFIED` | `403` | 登录前需要先完成邮箱验证。 | 先验证邮箱。 |
| `FORBIDDEN` | `403` | 调用者没有执行该操作的权限。 | 检查权限规则和密钥范围。 |
| `PASSWORD_REQUIRED` | `403` | 文件受密码保护，且密码未通过验证。 | 先调用密码验证端点。 |
| `NOT_FOUND` | `404` | 资源、文件、挂载点或路径不存在。 | 核对标识或路径后重试。 |
| `ALREADY_EXISTS` | `409` | 同名文件或文件夹已存在。 | 换一个名称。 |
| `OPERATION_FAILED` | `409` / `422` | 当前状态不允许执行该操作。 | 查看错误说明后重试。 |
| `SHARE_EXPIRED` | `410` | 分享链接已过期。 | 请创建者重新生成。 |
| `SHARE_REVOKED` | `410` | 分享链接已被撤销。 | 请创建者重新生成。 |
| `SHARE_LIMIT_REACHED` | `410` | 分享达到浏览或下载次数上限。 | 请创建者提高上限。 |
| `UPLOAD_SESSION_EXPIRED` | `410` | 上传会话超过 1 小时有效期。 | 重新创建上传会话。 |
| `QUOTA_EXCEEDED` | `413` | 存储空间或文件数量配额已用完。 | 释放空间或提高配额。 |
| `PAYLOAD_TOO_LARGE` | `413` | 上传超过自由模式的 1 GB 上限。 | 拆分文件或改用小文件。 |
| `RATE_LIMIT_EXCEEDED` | `429` | 请求超过限流阈值（限流、传输并发、下载限速）。 | 等待后重试，或提高限额。 |
| `FILE_BANNED` | `429` | 目标文件已被管理员封禁（内容出口统一拦截，删除不受影响）。 | 联系管理员处理。 |
| `INTERNAL_ERROR` | `500` | 服务器内部错误。 | 稍后重试或反馈问题。 |

## 认证

认证端点负责注册、登录、会话、邮箱验证和密码重置。注册、登录、登出、密码找回与重置对外开放；`GET /api/auth/me` 和 `GET /api/auth/csrf-token` 需要已登录的会话。

### 注册用户

创建用户账号。站点开启邮箱验证时，会向邮箱发送验证链接。

`POST /api/auth/register`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `username` | `string` | 是 | 3 到 20 个字符，只能包含字母、数字、下划线。 |
| `password` | `string` | 是 | 至少 8 位，最多 128 位。 |
| `email` | `string` | 是 | 合法邮箱地址。 |
| `inviteCode` | `string` | 否 | 邀请码，站点开启邀请注册时需要。 |
| `turnstileToken` | `string` | 否 | Turnstile 令牌，站点启用 Turnstile 时需要。 |

#### 响应

返回新用户和提示信息，状态码 `201`。

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "username": "alice",
      "email": "alice@example.com",
      "emailVerified": false,
      "role": "user"
    },
    "message": "注册成功"
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 字段不符合格式要求。 | 修正字段后重试。 |
| `FORBIDDEN` | `403` | 站点已关闭注册。 | 联系管理员。 |
| `ALREADY_EXISTS` | `409` | 用户名或邮箱已被注册。 | 换一个用户名或邮箱。 |

#### 示例

```sh
curl -X POST https://{domain}/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret-pass","email":"alice@example.com"}'
```

### 登录

验证用户身份，并设置有效期 7 天的 HttpOnly `auth_token` Cookie。

`POST /api/auth/login`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `username` | `string` | 是 | 用户名。 |
| `password` | `string` | 是 | 密码。 |
| `turnstileToken` | `string` | 否 | Turnstile 令牌，站点启用 Turnstile 时需要。 |

#### 响应

返回用户信息和当前配额。

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "username": "alice",
      "email": "alice@example.com",
      "emailVerified": true,
      "role": "user",
      "displayName": "Alice",
      "avatarUrl": null,
      "defaultPath": "/",
      "locale": "zh-CN",
      "theme": "system"
    },
    "quota": {
      "maxStorage": 10737418240,
      "usedStorage": 0,
      "maxFiles": 1000,
      "usedFiles": 0
    }
  },
  "timestamp": 1710000000000
}
```

`Set-Cookie` 响应头写入 `auth_token` JWT，带 `HttpOnly`、`SameSite=Strict`，有效期 7 天。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `INVALID_CREDENTIALS` | `401` | 用户名或密码错误。 | 重新输入凭据。 |
| `USER_DISABLED` | `401` | 账号已被禁用。 | 联系管理员。 |
| `EMAIL_NOT_VERIFIED` | `403` | 需要先完成邮箱验证。 | 先验证邮箱。 |

#### 示例

```sh
curl -X POST https://{domain}/api/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"username":"alice","password":"secret-pass"}'
```

### 登出

使当前会话失效并清除 `auth_token` Cookie。登出会递增会话版本，该账号已签发的所有 JWT 立即失效。

`POST /api/auth/logout`

#### 响应

成功时 `data` 为 `null`。

#### 示例

```sh
curl -X POST https://{domain}/api/auth/logout \
  -b cookies.txt
```

### 获取当前用户

返回已登录用户、配额和能力位。`capabilities` 是当前账号具备的能力位列表：`can_publish`（可发布公开文件）、`can_share`（可创建分享）、`can_grant`（可为单个文件创建用户访问规则）。

`GET /api/auth/me`

#### 响应

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "username": "alice",
      "email": "alice@example.com",
      "emailVerified": true,
      "role": "user",
      "displayName": "Alice",
      "defaultPath": "/",
      "locale": "zh-CN",
      "theme": "system",
      "capabilities": ["can_share"]
    },
    "quota": {
      "maxStorage": 10737418240,
      "usedStorage": 1048576,
      "maxFiles": 1000,
      "usedFiles": 3
    }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 没有有效的会话 Cookie。 | 先登录。 |

#### 示例

```sh
curl https://{domain}/api/auth/me -b cookies.txt
```

### 获取 CSRF 令牌

返回当前会话的 CSRF 令牌。Cookie 认证的写请求把它放在 `X-CSRF-Token` 头里。令牌在 KV 中缓存 2 小时。

`GET /api/auth/csrf-token`

#### 响应

```json
{
  "success": true,
  "data": { "token": "32 位随机字符串" },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl https://{domain}/api/auth/csrf-token -b cookies.txt
```

### 验证邮箱

用验证邮件里的令牌完成邮箱验证。`/verify-email` 和 `/verify` 是同一端点的别名。该端点返回 HTML 页面而不是 JSON。

`GET /api/auth/verify-email?token={token}`

`GET /api/auth/verify?token={token}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `token` | `string` | 是 | 邮件中的验证令牌，24 小时内有效。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 令牌缺失、无效或已过期。 | 重新发送验证邮件。 |

### 请求重置密码

向邮箱发送密码重置链接。响应不会暴露邮箱是否已注册。

`POST /api/auth/forgot-password`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `email` | `string` | 是 | 注册的邮箱地址。 |

#### 响应

```json
{
  "success": true,
  "data": { "message": "如果该邮箱已注册，重置链接已发送" },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl -X POST https://{domain}/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com"}'
```

### 重置密码

用重置链接中的令牌设置新密码。重置成功后，账号已有的会话全部失效。

`POST /api/auth/reset-password`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `token` | `string` | 是 | 邮件中的重置令牌，15 分钟内有效。 |
| `password` | `string` | 是 | 新密码，至少 8 位。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 令牌无效、已过期，或密码过短。 | 重新申请重置链接。 |

## 文件管理

文件端点负责文件与文件夹的列出、创建、更新、移动和删除。全部需要登录，且每次操作都会执行路径级权限校验。

### 列出文件

列出目录下的条目，支持分页、排序、过滤和搜索。

`GET /api/files?path={path}&page={page}&limit={limit}&sort={sort}&order={order}&type={type}&search={search}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `path` | `string` | 否 | 要列出的目录，默认 `/`。 |
| `page` | `integer` | 否 | 页码，默认 `1`。 |
| `limit` | `integer` | 否 | 每页条数，默认 `100`，最大 `1000`。 |
| `sort` | `string` | 否 | `name`、`time`、`size` 或 `manual`，默认取挂载点设置。 |
| `order` | `string` | 否 | `asc` 或 `desc`，默认 `asc`。 |
| `type` | `string` | 否 | 按类型过滤，`file` 或 `folder`。 |
| `search` | `string` | 否 | 匹配文件名的关键字。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "name": "photo.jpg",
        "path": "/drive/photos",
        "type": "file",
        "size": 1048576,
        "mimeType": "image/jpeg",
        "hasPassword": false,
        "ownerId": "uuid",
        "createdAt": 1710000000000,
        "updatedAt": 1710000000000
      }
    ],
    "pagination": { "total": 12, "page": 1, "limit": 100, "pages": 1 },
    "mount": { "id": "mount-id", "name": "Drive", "sortBy": "name", "sortOrder": "asc" }
  },
  "timestamp": 1710000000000
}
```

#### 响应字段

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `items` | `array` | 目录下的文件与文件夹条目。 |
| `items[].id` | `string` | 文件标识。 |
| `items[].name` | `string` | 文件或文件夹名称。 |
| `items[].path` | `string` | 父目录路径。 |
| `items[].type` | `string` | `file` 或 `folder`。 |
| `items[].size` | `integer` | 大小，单位字节。 |
| `items[].mimeType` | `string` | 文件的 MIME 类型。 |
| `items[].hasPassword` | `boolean` | 文件是否受密码保护。 |
| `pagination` | `object` | `total`、`page`、`limit`、`pages`。 |
| `mount` | `object` | 包含该目录的挂载点。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 查询参数不合法。 | 修正参数后重试。 |
| `NOT_FOUND` | `404` | 路径未挂载。 | 核对路径。 |
| `FORBIDDEN` | `403` | 没有读权限。 | 检查权限规则。 |

#### 示例

```sh
curl "https://{domain}/api/files?path=/drive&limit=50" -b cookies.txt
```
### 获取文件树

返回文件页树视图使用的扁平行：`path` 所属挂载点内每个文件与文件夹各一行。文件夹行的 `path` 是自身全路径，文件行的 `path` 是父目录路径。

权限在建树之前生效：入口 `path` 需要读取权限，服务端逐个复核嵌套挂载点的挂载根并丢弃调用方读不了的子树；非管理员视角下，本人非属主的私密文件夹连同其后代一并不返回。响应最多 5000 行并给出 `truncated`。

`GET /api/files/tree?path={path}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `path` | `string` | 否 | 挂载点内的任意路径；服务端按它校验读取权限。默认 `/`。树始终覆盖该路径所属的整个挂载点。 |

#### 响应

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `items` | `array` | 父先于子的扁平行：`id`、`name`、`path`、`type`、`size`、`visibility`、`guestVisibility`、`banned`、`hash`。 |
| `truncated` | `boolean` | 树触及 5000 行上限。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理方式 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 该路径不属于任何挂载点。 | 核对路径。 |
| `FORBIDDEN` | `403` | 调用方对该路径没有读取权限。 | 检查权限规则。 |

#### 示例

```sh
curl "https://{domain}/api/files/tree?path=/" -b cookies.txt
```

### 创建文件夹

在目标路径下创建文件夹，需要目标目录的写权限。

`POST /api/files/folder`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `path` | `string` | 是 | 父目录路径。 |
| `name` | `string` | 是 | 文件夹名称，最多 255 个字符。 |

#### 响应

返回创建的文件夹，状态码 `201`。

```json
{
  "success": true,
  "data": {
    "file": {
      "id": "uuid",
      "name": "photos",
      "path": "/drive",
      "type": "folder",
      "size": 0,
      "hasPassword": false,
      "createdAt": 1710000000000
    }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 名称或路径不合法。 | 修正输入后重试。 |
| `FORBIDDEN` | `403` | 没有写权限。 | 检查权限规则。 |
| `NOT_FOUND` | `404` | 父路径未挂载。 | 核对路径。 |
| `ALREADY_EXISTS` | `409` | 同名文件或文件夹已存在。 | 换个名称。 |

#### 示例

```sh
curl -X POST https://{domain}/api/files/folder \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"path":"/drive","name":"photos"}'
```

### 获取文件详情

返回单个文件或文件夹，附带权限、访问模式、密码状态、可见性和审核状态。

`GET /api/files/{id}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 文件标识。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "file": {
      "id": "uuid",
      "name": "photo.jpg",
      "path": "/drive/photos",
      "type": "file",
      "size": 1048576,
      "mimeType": "image/jpeg",
      "hasPassword": false,
      "visibility": "private",
      "reviewStatus": null,
      "createdAt": 1710000000000
    },
    "mount": { "id": "mount-id", "name": "Drive", "sortBy": "name", "sortOrder": "asc" },
    "permissions": ["read", "write", "update", "delete", "share", "download"],
    "accessMode": "public_cdn",
    "hasPassword": false
  },
  "timestamp": 1710000000000
}
```

`accessMode` 的取值：配置了公网 CDN 域名时为 `public_cdn`，支持预签名的提供商为 `signed_redirect`，其余情况走 Worker 下载网关，为 `private_gateway`。

文件对象同时带 `visibility`（`private` / `users` / `public`）和 `reviewStatus`（`pending` / `approved` / `rejected`；仅 `public` 语义上有意义，其余取值为 `null`）。`private` 只有属主和管理员可见；`users` 对全站登录用户开放读和下载；`public` 且审核通过后进入匿名公开空间。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 文件或挂载点不存在。 | 核对标识。 |
| `FORBIDDEN` | `403` | 没有读权限。 | 检查权限规则。 |

#### 示例

```sh
curl https://{domain}/api/files/{id} -b cookies.txt
```

### 更新文件元数据

重命名文件或文件夹，并更新元数据，包括访问密码、展示选项和可见性。

`PUT /api/files/{id}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 文件标识。 |

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `name` | `string` | 否 | 新名称，重命名需要 update 权限。 |
| `customTitle` | `string` | 否 | 自定义标题，最多 200 个字符。 |
| `customColor` | `string` | 否 | 自定义强调色，`#RRGGBB` 格式。 |
| `coverUrl` | `string` | 否 | 封面图片地址。 |
| `iconEmoji` | `string` | 否 | 图标表情，最多 16 个字符。 |
| `accessPassword` | `string` | 否 | 新的访问密码，传 `null` 可移除。服务端只保存哈希。 |
| `visibility` | `string` | 否 | 可见性：`private`、`users` 或 `public`，需要 `update` 权限。 |
| `manualPosition` | `integer` | 否 | 手动排序位置。 |
| `guestVisibility` | `string` | 否 | 游客（匿名访客）可见性：`inherit`（清除文件级设置，跟随角色默认）、`none`（游客不可见）、`download`（仅可下载）、`view`（可查看并下载）。需要 `update` 权限；文件与文件夹均支持，是「用户权限默认设置」的存储字段。 |

#### 响应

返回更新后的文件。设置 `visibility` 时：`users` 立即生效；`public` 需要当前账号具备 `can_publish` 能力位，否则文件进入 `pending` 审核队列等待管理员批准；对文件夹设置会级联到其下所有条目。可见性变更记录为 `visibility_change` 审计日志。

```json
{
  "success": true,
  "data": {
    "file": {
      "id": "uuid",
      "name": "renamed.jpg",
      "path": "/drive/photos",
      "type": "file",
      "size": 1048576,
      "hasPassword": true,
      "visibility": "users",
      "updatedAt": 1710000000000
    }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 字段不合法。 | 修正字段后重试。 |
| `FORBIDDEN` | `403` | 没有 update 权限。 | 检查权限规则。 |
| `ALREADY_EXISTS` | `409` | 新名称与已有条目冲突。 | 换个名称。 |
| `NOT_FOUND` | `404` | 文件不存在。 | 核对标识。 |

#### 示例

```sh
curl -X PUT https://{domain}/api/files/{id} \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"name":"renamed.jpg","accessPassword":"my-pass"}'
```

### 验证文件密码

验证受保护文件的访问密码，返回短期有效的网关下载链接。

`POST /api/files/{id}/verify-password`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 文件标识。 |

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `password` | `string` | 是 | 文件访问密码。 |

#### 响应

```json
{
  "success": true,
  "data": { "url": "https://{domain}/api/gateway/download/{token}", "expiresIn": 900 },
  "timestamp": 1710000000000
}
```

返回的链接 900 秒内有效，且只能使用一次。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 文件未设置密码，或未提供密码。 | 提供密码，或跳过验证。 |
| `INVALID_PASSWORD` | `401` | 密码错误。 | 重新输入密码。 |

#### 示例

```sh
curl -X POST https://{domain}/api/files/{id}/verify-password \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"password":"my-pass"}'
```

### 获取下载链接

返回文件的一次性网关下载链接。文件不能受密码保护。

`GET /api/files/{id}/download`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 文件标识。 |

#### 响应

```json
{
  "success": true,
  "data": { "url": "https://{domain}/api/gateway/download/{token}", "expiresAt": 1710000900000 },
  "timestamp": 1710000000000
}
```

令牌签发后 15 分钟过期，网关在首次下载时消费令牌。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `PASSWORD_REQUIRED` | `403` | 文件受密码保护。 | 先调用密码验证端点。 |
| `FORBIDDEN` | `403` | 没有下载权限。 | 检查权限规则。 |
| `NOT_FOUND` | `404` | 文件不存在。 | 核对标识。 |

#### 示例

```sh
curl https://{domain}/api/files/{id}/download -b cookies.txt
```

### 获取复制链接

以四种格式返回文件链接：直链、HTML、Markdown、BBCode。默认的直链指向文件的公开路径，例如 `{origin}/drive/photos/photo.jpg`。传 `signed=true` 请求提供商预签名链接，不支持时回退到网关链接。

`GET /api/files/{id}/copy-links?signed={signed}&expiresIn={expiresIn}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 文件标识。 |

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `signed` | `boolean` | 否 | 为 `true` 时请求签名链接，默认 `false`。 |
| `expiresIn` | `integer` | 否 | 签名链接有效期，单位秒，范围 60 到 604800，默认 `3600`。仅在 `signed=true` 时生效。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "formats": {
      "direct": "https://{domain}/drive/photos/photo.jpg",
      "html": "<img src=\"https://{domain}/drive/photos/photo.jpg\" alt=\"photo.jpg\">",
      "markdown": "![photo.jpg](https://{domain}/drive/photos/photo.jpg)",
      "bbcode": "[img]https://{domain}/drive/photos/photo.jpg[/img]"
    },
    "accessMode": "public_path",
    "needsPassword": false,
    "expiresIn": null
  },
  "timestamp": 1710000000000
}
```

设置 `signed=true` 后，`accessMode` 变为 `signed`，`expiresIn` 返回签名链接的有效期。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `FORBIDDEN` | `403` | 没有下载权限。 | 检查权限规则。 |
| `NOT_FOUND` | `404` | 文件不存在。 | 核对标识。 |

#### 示例

```sh
curl "https://{domain}/api/files/{id}/copy-links?signed=true&expiresIn=3600" -b cookies.txt
```

### 删除文件

硬删除文件或文件夹。元数据和配额在同一个事务里更新，对象随后异步清理。

`DELETE /api/files/{id}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 文件或文件夹标识。 |

#### 响应

```json
{
  "success": true,
  "data": { "deleted": 1, "size": 1048576 },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `FORBIDDEN` | `403` | 没有删除权限。 | 检查权限规则。 |
| `NOT_FOUND` | `404` | 文件不存在。 | 核对标识。 |

#### 示例

```sh
curl -X DELETE https://{domain}/api/files/{id} \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

### 移动文件

异步移动或重命名文件、文件夹。移动走 Saga 流程：复制对象、校验副本、原子切换元数据、异步清理源。需要源路径的删除权限和目标路径的写权限。

`POST /api/files/{id}/move`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 文件或文件夹标识。 |

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `targetPath` | `string` | 是 | 目标目录路径。 |
| `newName` | `string` | 否 | 可选的新名称。 |

#### 响应

返回任务标识和初始状态。

```json
{
  "success": true,
  "data": { "jobId": "job-uuid", "status": "pending" },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 目标路径缺失或不合法。 | 提供目标路径。 |
| `FORBIDDEN` | `403` | 缺少所需权限。 | 检查权限规则。 |
| `NOT_FOUND` | `404` | 文件不存在。 | 核对标识。 |
| `OPERATION_FAILED` | `409` | 会产生冲突或循环。 | 换一个目标路径。 |

#### 示例

```sh
curl -X POST https://{domain}/api/files/{id}/move \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"targetPath":"/drive/archive"}'
```

### 查询任务状态

返回异步操作（如移动）的状态。只有任务所有者能查询。

`GET /api/files/jobs/{jobId}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `jobId` | `string` | 是 | 移动请求返回的任务标识。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "job": {
      "id": "job-uuid",
      "type": "move",
      "status": "running",
      "progress": 40,
      "errorMessage": null,
      "createdAt": 1710000000000,
      "completedAt": null
    }
  },
  "timestamp": 1710000000000
}
```

`status` 取值为 `pending`、`running`、`completed` 或 `failed`。`progress` 为 0 到 100 的百分比。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 任务不存在，或不属于当前用户。 | 核对任务标识。 |

#### 示例

```sh
curl https://{domain}/api/files/jobs/{jobId} -b cookies.txt
```

### 批量操作

对最多 100 个文件或文件夹批量执行删除或移动。每个条目独立处理，响应列出成功与失败的条目。

`POST /api/files/batch`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `action` | `string` | 是 | `delete` 或 `move`。 |
| `fileIds` | `array` | 是 | 文件或文件夹标识，1 到 100 个。 |
| `targetPath` | `string` | 否 | 目标目录，`move` 操作必须提供。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "succeeded": ["uuid-1", "uuid-2"],
    "failed": [{ "id": "uuid-3", "error": "文件不存在" }]
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 批量参数不合法。 | 修正参数后重试。 |

#### 示例

```sh
curl -X POST https://{domain}/api/files/batch \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"action":"delete","fileIds":["uuid-1","uuid-2"]}'
```

## 上传

上传端点先创建上传会话并原子预留配额，再通过 Worker 代理或预签名地址写入对象，最后一次性提交文件。会话有效期 1 小时。超过 100 MB 的文件自动改用分片上传。

### 创建上传会话

创建上传会话并原子预留配额。文件超过 100 MB，或 `partCount` 大于 1 时，自动切换到分片上传。

`POST /api/files/upload-session`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `path` | `string` | 是 | 目标目录路径。 |
| `fileName` | `string` | 是 | 文件名，最多 255 个字符。 |
| `fileSize` | `integer` | 是 | 文件大小，单位字节，最大 20 GB。 |
| `mimeType` | `string` | 否 | 文件 MIME 类型。 |
| `partCount` | `integer` | 否 | 分片数，大于 1 时启用分片上传。 |
| `idempotencyKey` | `string` | 否 | 客户端幂等键，可用于接续已完成的会话。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "sessionId": "session-uuid",
    "uploadUrl": "https://provider.example.com/presigned-upload",
    "uploadId": null,
    "uploadMode": "presigned",
    "totalParts": null,
    "parts": [],
    "expiresAt": 1710003600000,
    "expiresIn": 3600
  },
  "timestamp": 1710000000000
}
```

提供商支持分片预签名时，响应还会返回 `parts`（`{ partNumber, url }` 数组），供客户端并发直传。否则 `uploadMode` 为 `worker`，需要走 Worker 代理上传分片。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 请求字段不合法。 | 修正字段后重试。 |
| `FORBIDDEN` | `403` | 没有写权限。 | 检查权限规则。 |
| `QUOTA_EXCEEDED` | `413` | 存储空间或文件数量配额已用完。 | 释放空间或提高配额。 |
| `NOT_FOUND` | `404` | 目标挂载点不存在。 | 核对路径。 |

#### 示例

```sh
curl -X POST https://{domain}/api/files/upload-session \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"path":"/drive/photos","fileName":"photo.jpg","fileSize":1048576,"mimeType":"image/jpeg"}'
```

### 上传原始文件

对单文件会话通过 Worker 直接上传文件字节。请求体即为文件内容。

`PUT /api/files/upload/raw/{sessionId}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | 是 | 上传会话标识。 |

#### 请求头

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `Content-Type` | `string` | 否 | 文件 MIME 类型，默认取会话设置。 |

#### 响应

校验通过后返回对象 ETag 和大小。

```json
{
  "success": true,
  "data": { "etag": "\"abc123\"", "size": 1048576 },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 会话不存在或属于其他用户。 | 重新创建会话。 |
| `OPERATION_FAILED` | `409` | 会话不在 pending 状态。 | 重新创建会话。 |
| `UPLOAD_SESSION_EXPIRED` | `410` | 会话超过 1 小时有效期。 | 重新创建会话。 |
| `OPERATION_FAILED` | `422` | 对象大小与会话不一致。 | 重新上传。 |

#### 示例

```sh
curl -X PUT https://{domain}/api/files/upload/raw/{sessionId} \
  -H "Content-Type: image/jpeg" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  --data-binary @photo.jpg
```

### 上传分片

对分片会话通过 Worker 上传单个分片，每个分片 8 MB。服务端记录返回的 ETag，用于断点续传和完成校验。

`PUT /api/files/upload/multipart/{sessionId}/part/{partNumber}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | 是 | 会话标识。 |
| `partNumber` | `integer` | 是 | 分片编号，从 1 开始。 |

#### 响应

```json
{
  "success": true,
  "data": { "partNumber": 1, "etag": "\"abc123\"" },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 分片编号越界。 | 使用合法的分片编号。 |
| `NOT_FOUND` | `404` | 会话不存在。 | 重新创建会话。 |
| `OPERATION_FAILED` | `409` | 会话不是分片会话。 | 使用分片会话。 |
| `UPLOAD_SESSION_EXPIRED` | `410` | 会话已过期。 | 重新创建会话。 |

#### 示例

```sh
curl -X PUT https://{domain}/api/files/upload/multipart/{sessionId}/part/1 \
  -H "Content-Type: application/octet-stream" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  --data-binary @part1.bin
```

### 查询分片状态

返回分片会话已上传与缺失的分片。该端点是断点续传的唯一事实来源；对支持预签名的提供商，还会为缺失分片重新下发预签名地址。

`GET /api/files/upload/multipart/{sessionId}/parts`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | 是 | 会话标识。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "sessionId": "session-uuid",
    "totalParts": 4,
    "completedCount": 2,
    "parts": [{ "partNumber": 1, "etag": "\"abc123\"" }],
    "missingParts": [2, 3, 4],
    "presignedParts": [{ "partNumber": 2, "url": "https://provider.example.com/part-2" }],
    "uploadMode": "presigned"
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 会话不存在。 | 重新创建会话。 |
| `OPERATION_FAILED` | `409` | 会话不是分片会话。 | 使用分片会话。 |

#### 示例

```sh
curl https://{domain}/api/files/upload/multipart/{sessionId}/parts -b cookies.txt
```

### 中止分片上传

中止分片上传，释放预留配额，并把会话标记为已中止。

`DELETE /api/files/upload/multipart/{sessionId}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | 是 | 会话标识。 |

#### 响应

成功时 `data` 为 `null`。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 会话不存在。 | 重新创建会话。 |

#### 示例

```sh
curl -X DELETE https://{domain}/api/files/upload/multipart/{sessionId} \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

### 完成上传

提交已上传的对象。服务端先通过 HEAD 请求校验对象存在、大小和 ETag，再合并分片，最后在单个事务里提交元数据和配额。

`POST /api/files/upload-complete`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | 是 | 会话标识。 |
| `etag` | `string` | 否 | 原始上传返回的对象 ETag，单文件会话必须提供。 |
| `parts` | `array` | 否 | 预签名直传场景的分片列表 `{ partNumber, etag }`。服务端已有记录时忽略。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "file": {
      "id": "file-uuid",
      "name": "photo.jpg",
      "path": "/drive/photos",
      "size": 1048576,
      "createdAt": 1710000000000
    }
  },
  "timestamp": 1710000000000
}
```

成功后再次调用该端点会返回 `alreadyCompleted: true` 和相同结果，因此完成操作具有幂等性。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 请求体不合法，或缺少 ETag。 | 提供会话和 ETag。 |
| `NOT_FOUND` | `404` | 会话不存在。 | 重新创建会话。 |
| `OPERATION_FAILED` | `409` | 会话状态不允许完成。 | 重新创建会话。 |
| `UPLOAD_SESSION_EXPIRED` | `410` | 会话已过期。 | 重新创建会话。 |
| `OPERATION_FAILED` | `422` | 对象或分片校验失败。 | 重新上传。 |

#### 示例

```sh
curl -X POST https://{domain}/api/files/upload-complete \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"sessionId":"session-uuid","etag":"\"abc123\""}'
```

## 兼容上传

PicGo 和 PicList 用 Bearer API 密钥调用兼容端点，密钥必须包含 `write` 权限。两个端点都接受 `multipart/form-data` 或原始字节流。

### 兼容客户端上传

`POST /api/upload`

`POST /api/upload/upload`

`POST /api/compat/upload`

#### 请求头

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `Authorization` | `string` | 是 | `Bearer {key_id}.{secret}`。 |
| `Content-Type` | `string` | 视情况 | `multipart/form-data`，或原始字节流时填文件 MIME 类型。 |

使用 `multipart/form-data` 时，把文件放在 `file` 字段，可选的 `path` 字段指定目录。使用原始字节流时，用 `X-File-Name` 头（或旧版 `filename` 头）指定文件名，可选的 `X-Path` 头指定目标路径。

#### 响应

```json
{
  "success": true,
  "data": {
    "url": "https://{domain}/api/files/{fileId}/download",
    "fileId": "file-uuid",
    "path": "/uploads/2026/photo.jpg",
    "size": 1048576,
    "filename": "photo.jpg"
  },
  "timestamp": 1710000000000
}
```

`path` 遵循密钥的上传路径模板，例如 `/uploads/{year}/{month}/`。最终目标必须落在密钥配置的上传根目录内。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 没有有效的 API 密钥。 | 提供 Bearer 密钥。 |
| `INVALID_TOKEN` | `401` | 密钥无效、已撤销或已过期。 | 重新创建密钥。 |
| `FORBIDDEN` | `403` | 密钥没有写权限，或目标超出上传根目录。 | 授权 write 或调整路径。 |
| `QUOTA_EXCEEDED` | `413` | 配额已用完。 | 释放空间或提高配额。 |
| `OPERATION_FAILED` | `422` | 上传对象校验失败。 | 重新上传。 |

#### 示例

```sh
curl -X POST https://{domain}/api/upload \
  -H "Authorization: Bearer pk_xxx.sk_yyy" \
  -F "file=@photo.jpg" \
  -F "path=/uploads/"
```

## 分享

分享端点负责分享链接的创建、列表、密码验证、目录浏览、下载、预览和撤销。一次分享可包含 1 到 50 个项目（文件与文件夹混合）。创建、列表、撤销需要登录；读取分享信息、目录浏览、验证密码、下载和预览对外开放。

### 创建分享

为一个或多个文件/文件夹创建分享链接，需要对每个项目所属路径具备 `share` 权限。

`POST /api/shares/`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `fileIds` | `array` | 是 | 项目标识（文件或文件夹），1 到 50 个。服务端去重并保持请求顺序，首项写入 `shares.file_id`。 |
| `title` | `string` | 否 | 展示标题，默认单项目取该项文件名、多项目取 `{n} 个项目`。 |
| `password` | `string` | 否 | 分享密码，服务端只保存哈希。 |
| `expiresIn` | `integer` | 否 | 有效期，单位秒，范围 60 到 1 年。与 `expiresAt` 二选一。 |
| `expiresAt` | `integer` | 否 | 绝对截止时间（毫秒时间戳）。与 `expiresIn` 二选一。 |
| `maxViews` | `integer` | 否 | 最大浏览次数。 |
| `maxDownloads` | `integer` | 否 | 最大下载次数。 |
| `allowPreview` | `boolean` | 否 | 是否允许预览，默认 `true`。 |
| `allowDownload` | `boolean` | 否 | 是否允许下载，默认 `true`。 |
| `requireLogin` | `boolean` | 否 | 是否仅登录用户可见，默认 `false`。 |
| `allowedUsers` | `array` | 否 | 指定可见的用户名列表，最多 50 个；未知用户名直接拒绝。 |

#### 响应

返回分享的短 ID、公开链接与项目列表，状态码 `201`。

```json
{
  "success": true,
  "data": {
    "share": {
      "id": "abc123",
      "url": "https://{domain}/share/abc123",
      "title": "2 个项目",
      "expiresAt": null,
      "createdAt": 1710000000000,
      "passwordProtected": true,
      "allowPreview": true,
      "allowDownload": true,
      "requireLogin": false,
      "allowedUserCount": 0,
      "items": [
        { "id": "file-uuid", "rootId": "file-uuid", "name": "photo.jpg", "path": "/drive/photos", "type": "file", "size": 1048576 },
        { "id": "folder-uuid", "rootId": "folder-uuid", "name": "albums", "path": "/drive/albums", "type": "folder", "size": 0 }
      ]
    }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 没有登录。 | 先登录。 |
| `VALIDATION_ERROR` | `400` | 分享参数不合法（含项目数量不在 1..50 内）。 | 修正参数后重试。 |
| `FORBIDDEN` | `403` | 没有 share 权限。 | 检查权限规则。 |
| `NOT_FOUND` | `404` | 项目或挂载点不存在。 | 核对项目标识。 |

#### 示例

```sh
curl -X POST https://{domain}/api/shares/ \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"fileIds":["file-uuid","folder-uuid"],"password":"share-pass","expiresIn":604800}'
```

### 查看我的分享

分页返回当前用户创建的分享。

`GET /api/shares/?page={page}&limit={limit}&status={status}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | 否 | 页码，默认 `1`。 |
| `limit` | `integer` | 否 | 每页条数，默认 `20`，最大 `100`。 |
| `status` | `string` | 否 | `active`、`expired` 或 `revoked`。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "abc123",
        "title": "2 个项目",
        "expiresAt": null,
        "viewCount": 3,
        "maxViews": null,
        "downloadCount": 1,
        "maxDownloads": null,
        "allowPreview": true,
        "allowDownload": true,
        "passwordProtected": false,
        "requireLogin": false,
        "allowedUserCount": 0,
        "status": "active",
        "createdAt": 1710000000000,
        "itemCount": 2,
        "totalSize": 1048576,
        "firstItem": { "id": "file-uuid", "name": "photo.jpg", "path": "/drive/photos", "type": "file", "size": 1048576 },
        "password": "share-pass"
      }
    ],
    "pagination": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
  },
  "timestamp": 1710000000000
}
```

该列表是**创建者视角**：只有这里会返回 `password`（访问密码明文，用于「查看密码」与「复制含密码链接」）；公开接口永不返回密码明文或密文。未设密码、密文缺失或解密失败的条目不会出现该字段。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 没有登录。 | 先登录。 |

#### 示例

```sh
curl "https://{domain}/api/shares/?status=active" -b cookies.txt
```

### 获取分享信息

无需登录即可查看公开分享信息。分享设置了密码时，响应会返回 `requiresPassword: true`，在密码验证通过前返回空的 `items`，并将 `allowPreview` / `allowDownload` 置为 `false`。

`GET /api/shares/{id}`

查询参数 `?password={明文}` 可用于「带密码的分享链接」：密码正确时直接返回内容（等价于已通过验证），错误返回 `401 INVALID_PASSWORD`。公开响应永不包含密码明文或密文。

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 分享 ID。 |

#### 响应

未设置密码或密码已验证时：

```json
{
  "success": true,
  "data": {
    "share": {
      "id": "abc123",
      "title": "2 个项目",
      "creatorName": "alice",
      "items": [
        { "id": "file-uuid", "rootId": "file-uuid", "name": "photo.jpg", "path": "/drive/photos", "type": "file", "size": 1048576, "mimeType": "image/jpeg" },
        { "id": "folder-uuid", "rootId": "folder-uuid", "name": "albums", "path": "/drive/albums", "type": "folder", "size": 0 }
      ],
      "allowPreview": true,
      "allowDownload": true,
      "expiresAt": null,
      "requiresPassword": false,
      "viewCount": 4,
      "maxViews": null,
      "downloadCount": 1,
      "maxDownloads": null
    }
  },
  "timestamp": 1710000000000
}
```

每个项目形如 `FileListItem` 并附带 `rootId`（该项目在分享中的项目标识）。分享设置了密码且尚未验证时，`items` 为空数组，`allowPreview` 与 `allowDownload` 均为 `false`，`requiresPassword` 为 `true`。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 分享不存在。 | 核对分享 ID。 |
| `LOGIN_REQUIRED` | `401` | 分享仅登录用户/指定用户可见。 | 先登录。 |
| `FORBIDDEN` | `403` | 当前用户不在指定用户范围内。 | 联系创建者。 |
| `SHARE_REVOKED` | `410` | 分享已被撤销。 | 请创建者重新生成。 |
| `SHARE_EXPIRED` | `410` | 分享已过期。 | 请创建者重新生成。 |
| `SHARE_LIMIT_REACHED` | `410` | 分享达到浏览次数上限。 | 请创建者提高上限。 |

#### 示例

```sh
curl https://{domain}/api/shares/abc123
```

### 浏览分享内目录

在分享的某个文件夹项目内按相对路径列目录。`root` 必须是该分享的文件夹项目；`sub` 为根文件夹内的相对路径，越出根子树返回 `403`。

`GET /api/shares/{id}/list?root={itemId}&sub={path}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `root` | `string` | 是 | 分享内文件夹项目的 `file_id`。 |
| `sub` | `string` | 否 | 相对根文件夹的路径，默认 `/`。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "shareId": "abc123",
    "rootId": "folder-uuid",
    "path": "/albums",
    "items": [
      { "id": "child-uuid", "rootId": "folder-uuid", "name": "trip.jpg", "path": "/drive/albums", "type": "file", "size": 204800 }
    ]
  },
  "timestamp": 1710000000000
}
```

`path` 为规范化的相对路径；`items` 中每项的 `rootId` 均指向请求的根文件夹项目。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 缺少 `root` 或 `root` 指向的不是文件夹项目。 | 传入文件夹项目的 `file_id`。 |
| `FORBIDDEN` | `403` | `root` 不在该分享范围内，或 `sub` 越出根子树。 | 核对项目标识与相对路径。 |
| `NOT_FOUND` | `404` | 分享或目标目录不存在。 | 核对分享 ID 与路径。 |
| `INVALID_PASSWORD` | `401` | 密码未验证。 | 先调用验证端点。 |
| `SHARE_REVOKED` / `SHARE_EXPIRED` / `SHARE_LIMIT_REACHED` | `410` | 分享不可用或已达上限。 | 请创建者重新生成。 |

#### 示例

```sh
curl "https://{domain}/api/shares/abc123/list?root=folder-uuid&sub=/albums" -b cookies.txt
```

### 验证分享密码

验证分享密码。密码通过请求体提交，不进入 URL。验证成功后，服务端种下短期有效的 HttpOnly Cookie，后续请求分享无需再携带密码。

`POST /api/shares/{id}/verify`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 分享 ID。 |

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `password` | `string` | 是 | 分享密码。 |

#### 响应

```json
{
  "success": true,
  "data": { "authorized": true },
  "timestamp": 1710000000000
}
```

响应还会设置 `share_auth_{id}` Cookie，有效期 15 分钟。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 分享不存在。 | 核对分享 ID。 |
| `SHARE_EXPIRED` | `410` | 分享已过期。 | 请创建者重新生成。 |
| `INVALID_PASSWORD` | `401` | 密码错误。 | 重新输入密码。 |

#### 示例

```sh
curl -X POST https://{domain}/api/shares/abc123/verify \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"password":"share-pass"}'
```

### 获取分享下载链接

返回分享内某个文件的一次性网关下载链接。下载计数只在网关实际消费令牌时增加一次。`itemId` 可以是分享项目，也可以是某个文件夹项目的后代文件。

`GET /api/shares/{id}/download?itemId={itemId}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 分享 ID。 |

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `itemId` | `string` | 否 | 目标文件的项目标识或文件夹后代文件标识，默认取分享的第一个项目。 |

#### 响应

```json
{
  "success": true,
  "data": { "url": "https://{domain}/api/gateway/download/{token}", "expiresIn": 900 },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 分享不存在，或 `itemId` 不在该分享作用域内。 | 核对分享 ID 与项目标识。 |
| `SHARE_REVOKED` | `410` | 分享不可用。 | 请创建者重新生成。 |
| `SHARE_EXPIRED` | `410` | 分享已过期。 | 请创建者重新生成。 |
| `FORBIDDEN` | `403` | 分享不允许下载。 | 请创建者开启下载。 |
| `VALIDATION_ERROR` | `400` | `itemId` 指向文件夹项目。 | 文件夹请改用目录浏览端点。 |
| `INVALID_PASSWORD` | `401` | 密码未验证。 | 先调用验证端点。 |
| `SHARE_LIMIT_REACHED` | `410` | 分享达到下载次数上限。 | 请创建者提高上限。 |

#### 示例

```sh
curl "https://{domain}/api/shares/abc123/download?itemId=file-uuid" -b cookies.txt
```

### 预览分享文件

分享允许预览时，直接以 `Content-Disposition: inline` 输出图片。返回二进制图片数据，不是 JSON。`itemId` 的作用域规则与下载一致。

`GET /api/shares/{id}/preview?itemId={itemId}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 分享 ID。 |

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `itemId` | `string` | 否 | 目标文件的项目标识或文件夹后代文件标识，默认取分享的第一个项目。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 分享不存在，或 `itemId` 不在该分享作用域内。 | 核对分享 ID 与项目标识。 |
| `SHARE_EXPIRED` | `410` | 分享不可用。 | 请创建者重新生成。 |
| `FORBIDDEN` | `403` | 分享不允许预览。 | 请创建者开启预览。 |
| `VALIDATION_ERROR` | `400` | `itemId` 指向文件夹项目。 | 文件夹请改用目录浏览端点。 |
| `INVALID_PASSWORD` | `401` | 密码未验证。 | 先调用验证端点。 |

#### 示例

```sh
curl "https://{domain}/api/shares/abc123/preview?itemId=file-uuid" -o photo.jpg
```

### 撤销分享

撤销分享链接，只有创建者可以撤销。

`DELETE /api/shares/{id}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 分享 ID。 |

#### 响应

成功时 `data` 为 `null`。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 没有登录。 | 先登录。 |
| `NOT_FOUND` | `404` | 分享不存在或不属于当前用户。 | 核对分享 ID。 |

#### 示例

```sh
curl -X DELETE https://{domain}/api/shares/abc123 \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

## 用户设置

用户端点负责当前用户的资料、外观、密码和邮箱设置。

### 获取用户设置

返回当前用户的资料、外观和配额。

`GET /api/users/me/settings`

#### 响应

```json
{
  "success": true,
  "data": {
    "profile": {
      "username": "alice",
      "email": "alice@example.com",
      "emailVerified": true,
      "displayName": "Alice",
      "avatarUrl": null,
      "defaultPath": "/",
      "locale": "zh-CN",
      "role": "user",
      "createdAt": 1710000000000
    },
    "appearance": { "theme": "system", "accentColor": "#3B82F6", "enableBlur": true },
    "quota": { "maxStorage": 10737418240, "usedStorage": 1048576, "maxFiles": 1000, "usedFiles": 3 }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 用户不存在。 | 用有效账号登录。 |

#### 示例

```sh
curl https://{domain}/api/users/me/settings -b cookies.txt
```

### 更新用户设置

更新当前用户的资料和外观。

`PUT /api/users/me/settings`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `displayName` | `string` | 否 | 显示名称，最多 100 个字符，传 `null` 清空。 |
| `avatarUrl` | `string` | 否 | 头像地址，最多 1000 个字符，传 `null` 清空。 |
| `locale` | `string` | 否 | `zh-CN` 或 `en-US`。 |
| `theme` | `string` | 否 | `light`、`dark` 或 `system`。 |
| `defaultPath` | `string` | 否 | 默认目录，必须以 `/` 开头。 |

#### 响应

```json
{
  "success": true,
  "data": { "message": "已保存" },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 设置不合法，或 `defaultPath` 不以 `/` 开头。 | 修正设置后重试。 |

#### 示例

```sh
curl -X PUT https://{domain}/api/users/me/settings \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"displayName":"Alice","theme":"dark","defaultPath":"/drive"}'
```

### 修改密码

修改当前用户的密码。修改后账号已有的会话全部失效，需要重新登录。

`PUT /api/users/me/password`

请求体可选 `emailCode`：当**账号绑定了邮箱且站点启用邮件服务**时，修改密码必须先调用下面的发码端点并带上 6 位验证码（错误/过期/已使用 → `400 INVALID_OTP`，连续 5 次错误该码作废）；未配置邮件服务或账号无邮箱时自动跳过，仅校验当前密码（不会锁死用户）。验证码一次性使用，有效期 5 分钟。

### 发送改密验证码

`POST /api/users/me/password/send-code`（需登录）→ `{ "success": true, "expiresIn": 300 }`；账号无邮箱返回 `400`「账号未绑定邮箱，无法使用验证码改密」；邮件服务未启用返回 `400`「邮件服务未启用，请联系管理员」；发信失败返回 `500 MAIL_ERROR`。

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `oldPassword` | `string` | 是 | 当前密码。 |
| `newPassword` | `string` | 是 | 新密码，至少 8 位。 |

#### 响应

```json
{
  "success": true,
  "data": { "message": "密码已修改，请重新登录" },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 新密码不足 8 位。 | 换一个更长的密码。 |
| `INVALID_PASSWORD` | `401` | 当前密码错误。 | 重新输入旧密码。 |

#### 示例

```sh
curl -X PUT https://{domain}/api/users/me/password \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"oldPassword":"secret-pass","newPassword":"new-pass-123"}'
```

### 发送邮箱验证码

向指定邮箱发送 6 位数字验证码，验证码 5 分钟内有效。站点需要启用邮件服务。

`POST /api/users/me/email/send-otp`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `email` | `string` | 是 | 要验证的邮箱地址。 |

#### 响应

```json
{
  "success": true,
  "data": { "success": true, "expiresIn": 300 },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 邮箱不合法，或已被其他账号使用。 | 换一个邮箱。 |
| `MAIL_ERROR` | `500` | 邮件服务发送失败。 | 稍后重试或联系管理员。 |

#### 示例

```sh
curl -X POST https://{domain}/api/users/me/email/send-otp \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"email":"new@example.com"}'
```

### 验证邮箱验证码

校验 6 位验证码并更新用户邮箱。连续 5 次输入错误后，验证码作废。

`POST /api/users/me/email/verify-otp`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `email` | `string` | 是 | 要验证的邮箱地址。 |
| `code` | `string` | 是 | 邮件中的 6 位验证码。 |

#### 响应

```json
{
  "success": true,
  "data": { "success": true },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 验证码无效、已过期，或错误次数过多。 | 重新发送验证码。 |

#### 示例

```sh
curl -X POST https://{domain}/api/users/me/email/verify-otp \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"email":"new@example.com","code":"123456"}'
```

## 用户访问规则

用户可以把对**单个文件**的读取或下载权限授予或拒绝给其他用户。创建者需要具备 `can_grant` 能力位；规则以 `user` 来源参与权限判定（排序上低于管理员规则、高于系统合成规则），deny 永远压过同路径的 allow。

### 列出我创建的访问规则

返回当前用户以 `user` 来源创建的全部规则。

`GET /api/users/rules`

#### 响应

```json
{
  "success": true,
  "data": {
    "rules": [{
      "id": "rule-uuid",
      "pathPattern": "/drive/photos/photo.jpg",
      "effect": "allow",
      "role": null,
      "userId": "target-user-uuid",
      "apiKeyId": null,
      "permissions": ["read", "download"],
      "origin": "user",
      "createdBy": "creator-user-uuid"
    }]
  },
  "timestamp": 1710000000000
}
```

### 创建访问规则

`POST /api/users/rules`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `itemId` | `string` | 是 | 文件标识，规则按文件全路径生成 `pathPattern`。 |
| `effect` | `string` | 是 | `allow` 或 `deny`。 |
| `targetUserId` | `string` | 否 | 目标用户 ID；与 `allUsers` 二选一。 |
| `allUsers` | `boolean` | 否 | `true` 表示面向全体登录用户。 |
| `permissions` | `string[]` | 是 | `read`、`download` 至少一项，不支持写入类权限。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `FORBIDDEN` | `403` | 当前账号没有 `can_grant` 能力，或目标用户不存在。 | 检查能力位与目标用户。 |
| `VALIDATION_ERROR` | `400` | 主体、权限组合或文件状态不合法。 | 修正字段后重试。 |

### 撤销访问规则

只能撤销自己创建的 `user` 来源规则；管理员创建的规则在管理端管理。

`DELETE /api/users/rules/{id}`

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `FORBIDDEN` | `403` | 规则不是自己创建的，或是管理员规则。 | 到管理端操作。 |
| `NOT_FOUND` | `404` | 规则不存在。 | 核对规则 ID。 |

## API 密钥

密钥端点负责 API 密钥的创建、列表和撤销。密钥用于 PicGo、PicList、脚本和 WebDAV 客户端认证。每个用户最多可持有 20 个有效密钥。

### 创建 API 密钥

创建 API 密钥。完整令牌只在本次响应中显示一次，请立即保存。服务端只保存令牌的 SHA-256 哈希。

`POST /api/keys/`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `name` | `string` | 是 | 密钥备注，最多 100 个字符。 |
| `permissions` | `array` | 是 | `read`、`write`、`delete`，至少一项。 |
| `protocols` | `array` | 是 | `webdav` 或 `api`，至少一项。 |
| `uploadPath` | `string` | 否 | 写操作的上传根目录，默认 `/uploads`。会做规范化，包含 `..` 或 `~` 的路径被拒绝。 |
| `allowedIps` | `array` | 否 | IP 白名单，其他 IP 发来的请求会被拒绝。 |
| `expiresIn` | `integer` | 否 | 有效期，单位秒，至少 60。 |

#### 响应

返回密钥和开箱即用的客户端配置，状态码 `201`。

```json
{
  "success": true,
  "data": {
    "key": {
      "id": "pk_abcdef123456",
      "keyId": "pk_abcdef123456",
      "secret": "sk_xyz789",
      "fullToken": "pk_abcdef123456.sk_xyz789",
      "name": "picgo",
      "permissions": ["write"],
      "protocols": ["api", "webdav"],
      "uploadPath": "/uploads",
      "createdAt": 1710000000000,
      "expiresAt": null
    },
    "configs": {
      "bearer": {
        "url": "https://{domain}",
        "header": "Authorization: Bearer pk_abcdef123456.sk_xyz789"
      },
      "webdav": {
        "url": "https://{domain}/webdav",
        "username": "pk_abcdef123456",
        "password": "sk_xyz789"
      }
    }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 请求字段不合法。 | 修正字段后重试。 |
| `FORBIDDEN` | `403` | 已有 20 个有效密钥，或上传路径不合法。 | 撤销旧密钥，或修正路径。 |

#### 示例

```sh
curl -X POST https://{domain}/api/keys/ \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"name":"picgo","permissions":["write"],"protocols":["api"],"uploadPath":"/uploads"}'
```

### 列出 API 密钥

返回当前用户的密钥列表，不含密钥原文。

`GET /api/keys/`

#### 响应

```json
{
  "success": true,
  "data": {
    "keys": [
      {
        "id": "key-uuid",
        "name": "picgo",
        "keyId": "pk_abcdef123456",
        "permissions": ["write"],
        "protocols": ["api"],
        "uploadPath": "/uploads",
        "lastUsedAt": null,
        "expiresAt": null,
        "createdAt": 1710000000000,
        "status": "active"
      }
    ]
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl https://{domain}/api/keys/ -b cookies.txt
```

### 查询密钥权限规则

返回对当前用户密钥生效的路径规则，用于展示和调试。

`GET /api/keys/rules`

#### 响应

```json
{
  "success": true,
  "data": { "rules": [] },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl https://{domain}/api/keys/rules -b cookies.txt
```

### 撤销 API 密钥

撤销密钥，撤销后该密钥无法再用于认证。

`DELETE /api/keys/{id}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 密钥标识。 |

#### 响应

成功时 `data` 为 `null`。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 密钥不存在或不属于当前用户。 | 核对密钥标识。 |

#### 示例

```sh
curl -X DELETE https://{domain}/api/keys/{id} \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

## 管理员

管理员端点负责用户、分享、文件、日志、系统设置、公告、存储提供商、挂载点和权限规则的管理。全部需要管理员会话。

### 获取仪表板

返回顶层统计、每挂载点用量总览、近期活动和最近 24 小时的请求量。

`GET /api/admin/dashboard`

#### 响应

```json
{
  "success": true,
  "data": {
    "stats": {
      "userRoles": { "admin": 2, "user": 9, "guest": 1 },
      "files": 345,
      "usedSpace": 10485760,
      "providers": 3,
      "activeMounts": 4,
      "totalCapacity": 10737418240
    },
    "mounts": [
      {
        "id": "mount-uuid",
        "name": "Drive",
        "mountPath": "/drive",
        "status": "active",
        "capacityBytes": 10737418240,
        "usedSpace": 5242880,
        "fileCount": 180,
        "provider": { "id": "provider-uuid", "name": "R2 主桶", "bucket": "picumet-primary" },
        "standbys": [{ "id": "provider-uuid-2", "name": "R2 备桶", "bucket": "picumet-standby", "weight": 1 }]
      }
    ],
    "buckets": [
      {
        "id": "provider-uuid", "name": "R2 主桶", "bucket": "picumet-primary", "type": "s3",
        "fileCount": 300, "usedSpace": 9437184,
        "mounts": [
          { "id": "mount-uuid", "name": "Drive", "mountPath": "/drive", "status": "active", "capacityBytes": 10737418240, "fileCount": 180, "usedSpace": 5242880, "role": "primary" }
        ],
        "standbys": [
          { "mountId": "mount-uuid-2", "mountName": "相册", "mountPath": "/gallery", "primaryProviderId": "provider-uuid-2", "primaryProviderName": "R2 备桶" }
        ]
      }
    ],
    "requests24h": 1200,
    "recentActivity": [{ "action": "upload", "path": "/drive/a.txt", "userId": "user-uuid", "createdAt": 1710000000000 }]
  },
  "timestamp": 1710000000000
}
```

> `stats.totalCapacity` 是全部挂载点 `capacityBytes` 之和，全部未设置时为 `null`；`mounts[].standbys` 是该挂载点的备用桶池成员（`mount_providers` 中除主 provider 外的部分）。`GET /api/admin/stats` 返回相同的 `stats` 结构。

#### 示例

```sh
curl https://{domain}/api/admin/dashboard -b cookies.txt
```

> `buckets` 驱动仪表盘的桶泳道图与管理端挂载点视图：每个桶一条，列出存有其文件的挂载点（`role` 为 `primary` 或 `member`），桶级合计按 `file_metadata.provider_id` 统计，`standbys` 是该桶零文件备用的挂载点。

### 获取统计数据

返回与 **获取仪表板** 完全相同的载荷（`stats`、`mounts`、`buckets`），不含 `requests24h`。

`GET /api/admin/stats`

#### 响应

```json
{
  "success": true,
  "data": {
    "stats": {
      "userRoles": { "admin": 2, "user": 9, "guest": 1 },
      "files": 345,
      "usedSpace": 10485760,
      "providers": 3,
      "activeMounts": 4,
      "totalCapacity": 10737418240
    },
    "mounts": [],
    "buckets": [],
    "recentActivity": []
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl https://{domain}/api/admin/stats -b cookies.txt
```

### 获取仪表板趋势

返回仪表盘「趋势」面板的三条时间序列（文件下载量 / 分享创建数 / 登录成功数），按时间桶聚合。区间超限时自动返回 400，提示缩小范围或加粗粒度。

`GET /api/admin/dashboard/trends?metric={metric}&granularity={granularity}&from={from}&to={to}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `metric` | `string` | 是 | `downloads` / `shares` / `logins` 三选一。 |
| `granularity` | `string` | 是 | 聚合粒度：`hour` / `day` / `week` / `month`。 |
| `from` | `integer` | 否 | 区间起点（毫秒时间戳）；缺省 = 最近 30 天。 |
| `to` | `integer` | 否 | 区间终点（毫秒时间戳）；最大跨度 2 年。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "metric": "downloads",
    "granularity": "day",
    "buckets": [{ "t": 1710000000000, "count": 42 }]
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl "https://{domain}/api/admin/dashboard/trends?metric=downloads&granularity=day" -b cookies.txt
```

### 获取桶挂载点树

返回存储桶以及它们承载的挂载点。这份数据驱动仪表盘的桶泳道图与管理端挂载点视图：每个桶列出存有其文件的挂载点，以及该桶作为零文件备用的挂载点。

`GET /api/admin/mount-tree`

#### 响应

```json
{
  "success": true,
  "data": {
    "buckets": [
      {
        "id": "provider-uuid", "name": "R2 主桶", "bucket": "picumet-primary", "type": "s3",
        "fileCount": 300, "usedSpace": 9437184,
        "mounts": [
          { "id": "mount-uuid", "name": "Drive", "mountPath": "/drive", "status": "active", "capacityBytes": 10737418240, "fileCount": 180, "usedSpace": 5242880, "role": "primary" }
        ],
        "standbys": [
          { "mountId": "mount-uuid-2", "mountName": "相册", "mountPath": "/gallery", "primaryProviderId": "provider-uuid-2", "primaryProviderName": "R2 备桶" }
        ]
      }
    ]
  },
  "timestamp": 1710000000000
}
```

#### 响应字段

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `buckets` | `array` | 每个存储提供商（桶）一条。 |
| `buckets[].fileCount` | `integer` | 该桶在全部挂载点上存储的对象数；计数来自 `file_metadata.provider_id`。 |
| `buckets[].mounts[].role` | `string` | 桶是挂载点主 provider 时为 `primary`；桶存储拼好桶的一部分时为 `member`。 |
| `buckets[].standbys` | `array` | 该桶在此挂载点上是零文件备用：含挂载点 id/名称/路径与主桶 id/名称。 |

#### 示例

```sh
curl https://{domain}/api/admin/mount-tree -b cookies.txt
```

### 获取挂载点的文件夹计数

返回某个挂载点的顶层文件夹与递归文件计数。传 `providerId` 只统计该桶存储的文件——拼好桶由此按桶展示自己的份额——匹配文件数为零的文件夹不再返回。

`GET /api/admin/dashboard/mount-folders?mountId={mountId}&providerId={providerId}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `mountId` | `string` | 是 | 要统计的挂载点 id。 |
| `providerId` | `string` | 否 | 只统计 `provider_id` 等于该桶的文件。 |

#### 响应

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `rootFiles` | `object` | 挂载点根目录直置文件：`count` 与字节数 `size`。 |
| `folders` | `array` | 顶层文件夹：`id`、`name`、`path`、`fileCount`、`usedSpace`。 |
| `truncated` | `boolean` | 扫描触及 20000 文件上限。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理方式 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 该 id 不属于任何挂载点。 | 核对挂载点 id。 |

#### 示例

```sh
curl "https://{domain}/api/admin/dashboard/mount-folders?mountId={mount_id}&providerId={provider_id}" -b cookies.txt
```


### 管理用户

列出、更新和删除用户。

`GET /api/admin/users?page={page}&limit={limit}&role={role}&status={status}&search={search}`

`PUT /api/admin/users/{id}`

`DELETE /api/admin/users/{id}`

#### 列表查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | 否 | 页码，默认 `1`。 |
| `limit` | `integer` | 否 | 每页条数，默认 `20`，最大 `100`。 |
| `role` | `string` | 否 | 按角色过滤。 |
| `status` | `string` | 否 | 按状态过滤。 |
| `search` | `string` | 否 | 匹配用户的关键字。 |

#### 更新请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `role` | `string` | 否 | `admin`、`user` 或 `guest`。 |
| `status` | `string` | 否 | `active`、`disabled` 或 `banned`。禁用或封禁会使该用户会话失效。 |
| `defaultPath` | `string` | 否 | 默认目录，必须以 `/` 开头。 |
| `maxStorage` | `integer` | 否 | 存储配额，单位字节。 |
| `maxFiles` | `integer` | 否 | 文件数量配额。 |
| `capabilities` | `string[]` | 否 | 能力位，全量覆盖：`can_publish`、`can_share`、`can_grant`。 |

#### 列表响应

```json
{
  "success": true,
  "data": {
    "users": [{ "id": "user-uuid", "username": "alice", "role": "user", "status": "active", "quota": {} }],
    "pagination": { "total": 12, "page": 1, "limit": 20, "pages": 1 }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 用户参数不合法，或请求删除自己的账号。 | 修正参数。 |
| `NOT_FOUND` | `404` | 用户不存在。 | 核对用户 ID。 |

#### 示例

```sh
curl "https://{domain}/api/admin/users?role=user&limit=20" -b cookies.txt

curl -X PUT https://{domain}/api/admin/users/{id} \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"role":"admin","status":"active"}'
```

### 管理分享

列出所有分享，并可以撤销任意分享。

`GET /api/admin/shares?page={page}&limit={limit}&status={status}`

`GET /api/admin/shares/{id}`（管理员查看分享详情：创建者用户名、状态、上限、开关、密码保护、项目列表 `items`）与 `PATCH /api/admin/shares/{id}`（管理员修改：`status`、`expiresAt`、`maxViews`、`maxDownloads`、`allowPreview`、`allowDownload`、`requireLogin`、`allowedUsers`、`password`——密码传非空值重置（哈希与密文同写）、传 `null`/空串清除）。

`DELETE /api/admin/shares/{id}`

#### 列表查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | 否 | 页码，默认 `1`。 |
| `limit` | `integer` | 否 | 每页条数，默认 `20`，最大 `100`。 |
| `status` | `string` | 否 | 按分享状态过滤。 |

#### 列表响应

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "abc123",
        "title": "2 个项目",
        "creatorId": "user-uuid",
        "file": { "id": "file-uuid", "name": "photo.jpg", "path": "/drive/photos", "type": "file", "size": 1048576 },
        "status": "active",
        "itemCount": 2,
        "passwordProtected": false,
        "requireLogin": false,
        "allowedUserCount": 0
      }
    ],
    "pagination": { "total": 5, "page": 1, "limit": 20, "pages": 1 }
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl "https://{domain}/api/admin/shares?status=active" -b cookies.txt

curl -X DELETE https://{domain}/api/admin/shares/abc123 \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

### 列出全部文件

跨所有挂载点搜索文件，结果带可见性、审核状态与落桶位置列。

`GET /api/admin/files?page={page}&limit={limit}&search={search}&mount={mount}&bucket={bucket}&hash={hash}&user={user}&visibility={visibility}&banned={banned}`

#### 列表查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | 否 | 页码，默认 `1`。 |
| `limit` | `integer` | 否 | 每页条数，默认 `20`，最大 `100`。 |
| `search` | `string` | 否 | 匹配文件名的关键字。 |
| `mount` | `string` | 否 | 按挂载点 ID 精确过滤。 |
| `bucket` | `string` | 否 | 按存储提供商（桶）ID 精确过滤。 |
| `hash` | `string` | 否 | 按内容哈希（`blob_hash`）子串过滤。 |
| `user` | `string` | 否 | 按上传用户（属主）ID 精确过滤。 |
| `visibility` | `string` | 否 | `private`、`users` 或 `public`。 |
| `banned` | `string` | 否 | `true` 或 `false`，按封禁状态过滤。 |

> 非法的枚举取值会被忽略，与 `search`、分页共存。每行的挂载点名、存储桶名与内容寻址副本落桶在服务端按页批量 `IN` 查询补齐（各一条，无 N+1）。

#### 响应

```json
{
  "success": true,
  "data": {
    "items": [{
      "id": "file-uuid", "name": "photo.jpg", "path": "/drive/photos", "type": "file", "size": 1048576,
      "banned": false, "hash": "9f2c…",
      "buckets": ["R2 主桶"], "mounts": ["Drive"], "ownerName": "alice"
    }],
    "pagination": { "total": 345, "page": 1, "limit": 20, "pages": 18 }
  },
  "timestamp": 1710000000000
}
```

> `buckets` 是「文件主桶 + 内容寻址副本（`blob_objects`）落桶」的提供商名去重集合；`mounts` 是文件所在挂载点名；`hash` 仅内容寻址文件有值。

#### 示例

```sh
curl "https://{domain}/api/admin/files?search=photo&banned=false" -b cookies.txt
```

### 列出全部文件的扁平树

返回横跨全部挂载点的扁平行，供管理端树视图渲染，并带上上传用户昵称。文件夹行的 `path` 是自身全路径，文件行的 `path` 是父目录路径。「列出全部文件」的五个筛选全部可用；`bucket` 与 `hash` 只筛文件行，文件夹骨架原样保留。响应最多 5000 行并给出 `truncated`。

`GET /api/admin/files/tree?mount={mount}&bucket={bucket}&user={user}&visibility={visibility}&hash={hash}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `mount` | `string` | 否 | 挂载点 id 精确匹配。 |
| `bucket` | `string` | 否 | 存储提供商（桶）id 精确匹配；文件夹行直接通过该筛选。 |
| `user` | `string` | 否 | 上传用户（属主）id 精确匹配。 |
| `visibility` | `string` | 否 | `private`、`users` 或 `public`。 |
| `hash` | `string` | 否 | 内容哈希（`blob_hash`）子串匹配；文件夹行直接通过该筛选。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "items": [{ "id": "file-uuid", "name": "photo.jpg", "path": "/drive/photos", "type": "file", "size": 1048576, "ownerName": "alice", "banned": false, "hash": "9f2c…" }],
    "truncated": false
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl "https://{domain}/api/admin/files/tree?bucket={provider_id}" -b cookies.txt
```


### 封禁/解封文件

设置或解除文件封禁。封禁只拦截内容出口（文件下载、公开路径直服、分享下载/预览、下载网关），**不拦截删除**——被封禁的文件仍可由用户或管理员删除。被封禁的文件对属主呈幽灵态：文件页半透明显示、菜单收敛为仅可删除，任何内容出口返回 `429 FILE_BANNED`。

`PUT /api/admin/files/{id}/ban`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `banned` | `boolean` | 是 | `true` 封禁，`false` 解封。 |

#### 响应

```json
{ "success": true, "data": { "id": "file-uuid", "banned": true }, "timestamp": 1710000000000 }
```

#### 示例

```sh
curl -X PUT https://{domain}/api/admin/files/{id}/ban \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"banned":true}'
```

### 审核公开文件

批准或驳回进入审核队列的公开文件，也可以直接调整任意文件的可见性；对文件夹的可见性变更会级联到其下所有条目。

`PATCH /api/admin/files/{id}/review`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `status` | `string` | 否 | 审核结论：`approved`、`rejected` 或 `pending`。 |
| `visibility` | `string` | 否 | 目标可见性：`private`、`users` 或 `public`。 |

两个字段至少传一个。变更写入 `review` 与 `visibility_change` 审计日志。

#### 示例

```sh
curl -X PATCH https://{domain}/api/admin/files/{id}/review \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"status":"approved"}'
```

### 查看访问日志

分页返回访问日志，支持过滤。

`GET /api/admin/logs?page={page}&limit={limit}&userId={userId}&action={action}&search={search}&from={from}&to={to}`

#### 列表查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | 否 | 页码，默认 `1`。 |
| `limit` | `integer` | 否 | 每页条数，默认 `50`，最大 `200`。 |
| `userId` | `string` | 否 | 按用户过滤。 |
| `action` | `string` | 否 | 按动作过滤，如 `upload`、`download`。 |
| `search` | `string` | 否 | 匹配日志内容的关键字。 |
| `from` | `integer` | 否 | 起始时间，毫秒。 |
| `to` | `integer` | 否 | 结束时间，毫秒。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "logs": [{ "id": "log-uuid", "userId": "user-uuid", "action": "upload", "path": "/drive/a.txt", "bytesTransferred": 1024, "statusCode": 200, "createdAt": 1710000000000 }],
    "pagination": { "total": 5000, "page": 1, "limit": 50, "pages": 100 }
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl "https://{domain}/api/admin/logs?action=upload&limit=50" -b cookies.txt
```

### 管理系统设置

读取和更新全局站点设置，包括注册、邮件、限流和 Turnstile。

`GET /api/admin/settings`

`PATCH /api/admin/settings`

#### 更新请求体

所有字段均可选。

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `siteTitle` | `string` | 否 | 标签页标题（浏览器标签页，即 `document.title`）。 |
| `siteHeaderTitle` | `string` | 否 | 左上角标题（顶栏 Logo 旁文字）。留空 `''` = 只显示 Logo；不传（未设置）= 跟随 `siteTitle`。 |
| `siteLogo` | `string` | 否 | 左上角 Logo 地址，高度固定、宽度随图片比例自适应。 |
| `siteFavicon` | `string` | 否 | 站点图标地址。 |
| `allowRegistration` | `boolean` | 否 | 是否允许注册。 |
| `allowGuestAccess` | `boolean` | 否 | 是否允许游客访问。 |
| `requireEmailVerification` | `boolean` | 否 | 注册是否需要邮箱验证。 |
| `enableTurnstile` | `boolean` | 否 | 是否启用 Cloudflare Turnstile。 |
| `turnstileSiteKey` | `string` | 否 | Turnstile Site Key。 |
| `rateLimitEnabled` | `boolean` | 否 | 是否启用限流。 |
| `rateLimitRequestsPerMinute` | `integer` | 否 | 每分钟请求数，范围 1 到 10000。仅生产环境生效：按 IP 限制该值、登录用户按 2 倍；登录/注册等认证接口固定 5 次/分钟；自由模式按会话 60、按用户 120 次/分钟。 |
| `maxConcurrentTransfers` | `integer` | 否 | 同时传输上限，范围 0 到 1000，默认 4，`0` 表示不限。按用户（未登录按 IP）限制上传各通道与下载网关的在途请求数，超限返回 `429 CONCURRENCY_LIMIT_EXCEEDED`。 |
| `rateLimitDownloadsPerMinute` | `integer` | 否 | 下载限速，范围 0 到 100000，默认 120，`0` 表示不限。按用户（未登录按 IP）限制每分钟下载类请求（下载网关、分享下载/预览、文件下载链接、公开目录直链），超限返回 `429 RATE_LIMIT_EXCEEDED`。 |
| `directPrefix` | `string` | 否 | 公开直链前缀：`''`（站点根）、`/d`、`/download` 或 `/raw`。服务端先归一化（补前导斜杠、去尾斜杠）再校验枚举，其余取值拒绝；`rootTarget` 为 `direct` 时前缀必须是 `''`。 |
| `rootTarget` | `string` | 否 | 根路径 `/` 的语义：`landing`、`files` 或 `direct`。取 `direct` 时须与 `directPrefix` 的 `''` 搭配。 |
| `smtpHost` | `string` | 否 | SMTP 服务器地址。 |
| `smtpPort` | `integer` | 否 | SMTP 端口。 |
| `smtpSecure` | `boolean` | 否 | 是否使用安全连接。 |
| `smtpUser` | `string` | 否 | SMTP 用户名。 |
| `smtpPassword` | `string` | 否 | SMTP 密码。传 `"******"` 或空字符串可保留当前密码。 |
| `smtpFromName` | `string` | 否 | 发件人名称。 |
| `smtpFromEmail` | `string` | 否 | 发件邮箱；空字符串 `''` = 清空发件地址（未配置时读取值即为 `''`，整表单回传不会被判为无效邮箱）。 |
| `emailEnabled` | `boolean` | 否 | 是否启用邮件服务。 |

#### 示例

```sh
curl -X PATCH https://{domain}/api/admin/settings \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"siteTitle":"My Picumet","rateLimitRequestsPerMinute":60}'
```

### 发送测试邮件

通过已配置的 SMTP 服务发送测试邮件。

`POST /api/admin/settings/test-email`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `to` | `string` | 是 | 收件邮箱。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 邮箱不合法，或 SMTP 未配置。 | 先配置 SMTP。 |
| `MAIL_ERROR` | `500` | 邮件发送失败。 | 检查 SMTP 配置。 |

#### 示例

```sh
curl -X POST https://{domain}/api/admin/settings/test-email \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"to":"admin@example.com"}'
```

### 管理公告

列出、创建、更新和删除公告。

`GET /api/admin/announcements`

`POST /api/admin/announcements`

`PUT /api/admin/announcements/{id}`

`DELETE /api/admin/announcements/{id}`

#### 创建请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `title` | `string` | 是 | 公告标题，最多 200 个字符。 |
| `content` | `string` | 是 | 公告内容，最多 5000 个字符。 |
| `displayMode` | `string` | 否 | 显示策略：`always`（默认）、`daily`、`interval`、`until`、`duration`；弹窗另可 `once`。 |
| `intervalSeconds` | `integer` | 否 | 间隔或时长秒数，范围 60 到 31536000。配 `interval` 或 `duration` 时必填。 |
| `endsAt` | `integer` | 否 | 绝对截止时间（毫秒时间戳）。配 `until` 时必填。 |
| `kind` | `string` | 否 | `banner`（默认）显示在顶部横幅；`toast` 显示为会自动关闭的临时弹窗。 |

显示策略（`displayMode`）语义：

- `always`：显示到用户关闭为止。
- `daily`：用户关闭后，次日再次显示。
- `interval`：用户关闭后，间隔 `intervalSeconds` 秒再次显示。
- `until`：超过 `endsAt` 后不再显示。
- `duration`：`createdAt + intervalSeconds` 之后不再显示。
- `once`（仅弹窗）：每用户只显示一次。

临时弹窗（`toast`）在用户本地记录的是展示时间而非关闭时间；横幅（`kind: banner`）去掉左侧色条渲染。

`PUT /api/admin/announcements/{id}` 只接受 `title`、`content`、`level`、`active`——显示策略在创建时设置。

#### 示例

```sh
curl -X POST https://{domain}/api/admin/announcements \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"title":"维护通知","content":"周六停机维护","level":"warning","displayMode":"daily","kind":"banner"}'
```

### 管理存储提供商

列出、创建、更新、测试和删除存储提供商。凭据加密保存。

`GET /api/admin/storage/providers`

`POST /api/admin/storage/providers`

`PUT /api/admin/storage/providers/{id}`

`POST /api/admin/storage/providers/{id}/test`

`DELETE /api/admin/storage/providers/{id}`

#### 创建请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `name` | `string` | 是 | 提供商备注。 |
| `type` | `string` | 否 | `r2` 或 `s3`（`oracle` 已折叠为 `s3`）。省略时由 `endpoint` 推导：为空即 R2 绑定，非空即 S3 协议。 |
| `endpoint` | `string` | 否 | S3 端点。R2 绑定模式留空；只允许公网 http(s) 地址。`endpoint`、`accessKeyId`、`secretAccessKey` 必须同填或同空。 |
| `region` | `string` | 否 | 区域，R2 默认 `auto`。 |
| `bucket` | `string` | 是 | 存储桶名称。 |
| `accessKeyId` | `string` | 否 | Access Key，R2 绑定模式留空。 |
| `secretAccessKey` | `string` | 否 | Secret Key，R2 绑定模式留空。 |
| `publicDomain` | `string` | 否 | 公网 CDN 域名，用于直链。 |
| `pathPrefix` | `string` | 否 | 对象键前缀。 |

#### 测试响应

```json
{
  "success": true,
  "data": { "connected": true, "message": "ok" },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 端点未通过 SSRF 校验，或字段不合法。 | 使用公网端点或修正字段。 |
| `NOT_FOUND` | `404` | 提供商不存在。 | 核对提供商 ID。 |
| `OPERATION_FAILED` | `409` | 提供商仍挂有挂载点。 | 先删除挂载点。 |

#### 示例

```sh
curl -X POST https://{domain}/api/admin/storage/providers \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"name":"R2","type":"r2","bucket":"my-bucket"}'
```

### 管理挂载点

列出、创建、更新和删除挂载点，把提供商绑定到虚拟路径。

`GET /api/admin/mounts`

`POST /api/admin/mounts`

`PUT /api/admin/mounts/{id}`

`DELETE /api/admin/mounts/{id}`

#### 创建请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `providerId` | `string` | 是 | 存储提供商 ID。 |
| `mountPath` | `string` | 是 | 虚拟路径，如 `/drive`。 |
| `name` | `string` | 是 | 显示名称。 |
| `sortBy` | `string` | 否 | 默认排序字段。 |
| `sortOrder` | `string` | 否 | `asc` 或 `desc`。 |
| `priority` | `integer` | 否 | 挂载点优先级，路径重叠时高优先级优先。 |
| `maxStorage` | `integer` | 否 | 挂载点写入配额，单位字节。 |
| `poolStrategy` | `string` | 否 | 存储池写路径策略（§E/§29），默认 `least_used`：`least_used` 已用最小（`(已用+1)/权重`）/ `round_robin` 轮询 / `hash` 目录粘性哈希（同目录落同一桶，便于按前缀列举）/ `free_weighted` 空间余量加权（`(容量−已用)×权重` 最大者，未配容量的成员视为不限并优先；全部满 → 413）/ `ordered` 指定顺序填满切换（按 `sortOrder` 升序取第一个未满成员）。 |
| `poolMembers` | `array` | 否 | 池成员（**全量替换**，§E/§29/§31）：`[{ providerId, weight?, capacityBytes?, sortOrder?, standby?, rolePermissions? }]`；`weight` 缺省 1，`capacityBytes` 留空/null = 不限（配了就是**硬上限**：放置判定用 `已用 + 在途预留 + 本次大小 <= 容量`，放不下按策略次序回退，全部放不下返回 413），`sortOrder` 缺省 0（仅 `ordered` 使用），`standby` = 显式「作为备用桶」标记（不再由「0 文件」推断），`rolePermissions` = **桶级**默认角色矩阵（`[{role, permissions[]}]`）。权限判定优先级：**桶级 → 挂载点级 → 角色默认**。兼容简写：仅传 provider id 数组时等价 `poolMembers` 只给 `providerId`。 |
| `uploadMode` | `string` | 否 | 写入口模式（§28）：`free`（默认，不额外约束）/ `user_space`（写路径强制 `<mountPath>/<用户名>`，目录首用自动创建）/ `flat`（禁止新建文件夹，平铺上传）。 |
| `rolePermissions` | `array` | 否 | 默认角色权限矩阵（§28，**全量替换**）：`[{ role: admin\|user\|guest, permissions: [...] }]`；不传=不改，传 `[]` = 清空矩阵。词表 `read/write/update/delete/download`（`share` 不参与矩阵，分享由能力位控制）。条目存在即**封闭集合**：该挂载点内未被列出的动作被拒绝；无条目回落到角色默认权限。 |
| `capacityBytes` | `integer` | 否 | 挂载点展示容量，单位字节；留空表示未设置（仪表盘容量汇总忽略未设置的挂载点）。更新时传 `null` 清除。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 提供商不存在，或字段不合法。 | 修正输入。 |
| `OPERATION_FAILED` | `409` | 挂载点下仍有文件。 | 先删除文件。 |

#### 示例

```sh
curl -X POST https://{domain}/api/admin/mounts \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"providerId":"provider-uuid","mountPath":"/drive","name":"Drive"}'
```

### 管理权限规则

列出、创建、更新和删除基于路径的权限规则。每条规则必须且只能指定一个主体：角色、用户或 API 密钥。

`GET /api/admin/rules?page={page}&limit={limit}`

`POST /api/admin/rules`

`PUT /api/admin/rules/{id}`

`DELETE /api/admin/rules/{id}`

#### 创建请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `pathPattern` | `string` | 是 | 路径模式，如 `/public/**`。 |
| `effect` | `string` | 是 | `allow` 或 `deny`。 |
| `mountId` | `string` | 否 | 规则作用的挂载点，为空表示所有挂载点。 |
| `role` | `string` | 否 | 角色主体，与 `userId`、`apiKeyId` 互斥。 |
| `userId` | `string` | 否 | 用户主体，与 `role`、`apiKeyId` 互斥。 |
| `apiKeyId` | `string` | 否 | 密钥主体，与 `role`、`userId` 互斥。 |
| `permissions` | `array` | 否 | 规则授予的权限，如 `["read","write"]`。 |
| `requirePassword` | `boolean` | 否 | 是否要求匹配路径输入密码。 |
| `password` | `string` | 否 | 明文密码，服务端只保存哈希。 |
| `allowedIps` | `array` | 否 | 规则的 IP 白名单。 |
| `priority` | `integer` | 否 | 规则优先级。 |

列表响应会把 `passwordHash` 脱敏为 `***`。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 规则未指定或指定多个主体。 | 恰好指定一个主体。 |

#### 示例

```sh
curl -X POST https://{domain}/api/admin/rules \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"pathPattern":"/public/**","effect":"allow","role":"guest","permissions":["read"]}'
```

## 自由模式

自由模式端点让匿名访客用自己的对象存储凭据建立临时会话。凭据加密后写入 KV，短期自动清理。会话端点需要 `fm_token` Cookie，写操作还需要会话级 CSRF 令牌。

### 初始化自由模式会话

校验存储端点、测试连通性并启动临时会话，设置 `fm_token` Cookie。

`POST /api/free-mode/init`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `endpoint` | `string` | 是 | S3 端点，只允许公网 http(s) 地址，私网或本地地址会被拒绝。 |
| `region` | `string` | 否 | 区域。 |
| `bucket` | `string` | 是 | 存储桶名称。 |
| `accessKeyId` | `string` | 是 | Access Key。 |
| `secretAccessKey` | `string` | 是 | Secret Key。 |
| `sessionHours` | `integer` | 否 | 会话时长，单位小时，范围 1 到 8，默认 `1`。 |

#### 响应

返回会话用户、过期时间和会话级 CSRF 令牌，状态码 `201`。

```json
{
  "success": true,
  "data": {
    "user": { "id": "user-uuid", "username": "fm_ab12cd34", "role": "user", "defaultPath": "/" },
    "expiresAt": 1710003600000,
    "sessionHours": 1,
    "provider": { "type": "s3", "bucket": "my-bucket" },
    "csrfToken": "32 位随机字符串"
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | 端点是私网或非法地址，或字段格式错误。 | 使用公网端点和有效凭据。 |
| `OPERATION_FAILED` | `400` | 存储连通性测试失败。 | 检查凭据和端点。 |

#### 示例

```sh
curl -X POST https://{domain}/api/free-mode/init \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"endpoint":"https://s3.example.com","bucket":"my-bucket","accessKeyId":"AK","secretAccessKey":"SK","sessionHours":1}'
```

### 列出自由模式文件

列出自由模式会话根目录下的对象。

`GET /api/free-mode/files?path={path}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `path` | `string` | 否 | 要列出的目录前缀，必须落在会话根目录内。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "items": [
      { "key": "photo.jpg", "name": "photo.jpg", "path": "/photo.jpg", "type": "file", "size": 1048576, "etag": "\"abc123\"" }
    ],
    "mount": { "id": "free", "name": "自由模式", "mountPath": "/", "sortBy": "name", "sortOrder": "asc" }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 会话缺失或已过期。 | 重新初始化会话。 |
| `FORBIDDEN` | `403` | 路径超出会话根目录。 | 使用根目录内的路径。 |

#### 示例

```sh
curl "https://{domain}/api/free-mode/files" -b cookies.txt
```

### 自由模式上传

向自由模式会话上传文件，单次大小不超过 1 GB。

`POST /api/free-mode/upload?path={path}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `path` | `string` | 否 | 目标目录前缀。 |

#### 请求头

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `X-CSRF-Token` | `string` | 是 | init 响应中的会话 CSRF 令牌。 |
| `X-File-Name` | `string` | 原始字节流时必填 | 请求体不是 `multipart/form-data` 时的文件名。 |

使用 `multipart/form-data` 并把文件放在 `file` 字段，或发送原始字节流并带 `X-File-Name` 头。

#### 响应

返回对象键和大小，状态码 `201`。

```json
{
  "success": true,
  "data": { "key": "photo.jpg", "size": 1048576 },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 会话缺失或已过期。 | 重新初始化会话。 |
| `INVALID_CSRF` | `403` | 会话 CSRF 令牌错误。 | 使用 init 返回的令牌。 |
| `VALIDATION_ERROR` | `400` | 文件名或路径不合法。 | 修正输入。 |
| `PAYLOAD_TOO_LARGE` | `413` | 文件超过 1 GB。 | 使用更小的文件。 |
| `FORBIDDEN` | `403` | 目标键超出会话根目录。 | 使用根目录内的路径。 |

#### 示例

```sh
curl -X POST "https://{domain}/api/free-mode/upload" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -F "file=@photo.jpg"
```

### 删除自由模式对象

删除自由模式会话中的对象。

`DELETE /api/free-mode/object?key={key}`

#### 查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `key` | `string` | 是 | 对象键，必须落在会话根目录内，且不含 `..`、`~`、控制字符或反斜杠。 |

#### 响应

成功时 `data` 为 `null`。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 会话缺失或已过期。 | 重新初始化会话。 |
| `VALIDATION_ERROR` | `400` | 键缺失、过长或包含非法字符。 | 修正对象键。 |
| `FORBIDDEN` | `403` | 键超出会话根目录。 | 使用根目录内的键。 |

#### 示例

```sh
curl -X DELETE "https://{domain}/api/free-mode/object?key=photo.jpg" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

### 结束自由模式会话

结束自由模式会话并清除 `fm_token` Cookie。

`POST /api/free-mode/logout`

#### 响应

成功时 `data` 为 `null`。

#### 示例

```sh
curl -X POST https://{domain}/api/free-mode/logout \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

## WebDAV

WebDAV 服务把文件库暴露给标准 WebDAV 客户端。所有请求使用 Basic 认证，用户名填 `{key_id}`，密码填 `{secret}`。基础地址为 `https://{domain}/webdav`。每个方法都执行路径级权限校验，写目标必须落在密钥的上传根目录内。

### WebDAV 方法

| 方法 | 说明 | 权限 |
| :--- | :--- | :--- |
| `OPTIONS` | 声明 DAV 能力（`DAV: 1,2`）。 | 无 |
| `PROPFIND` | 以 XML multistatus 响应列出目录。 | `read` |
| `MKCOL` | 创建文件夹。 | `write`，且在上传根目录内 |
| `PUT` | 流式上传文件。 | `write`，且在上传根目录内 |
| `GET` / `HEAD` | 下载文件或读取文件信息。 | `read` |
| `DELETE` | 删除文件或文件夹。 | `delete` |
| `MOVE` | 移动或重命名，复用移动 Saga。 | 源 `delete` + 目标 `write` |

#### 示例：列出目录

```sh
curl -X PROPFIND https://{domain}/webdav/ \
  -u "pk_xxx:sk_yyy" \
  -H "Depth: 1"
```

#### 示例：上传文件

```sh
curl -X PUT https://{domain}/webdav/uploads/photo.jpg \
  -u "pk_xxx:sk_yyy" \
  -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg
```

#### 示例：移动文件

```sh
curl -X MOVE https://{domain}/webdav/uploads/photo.jpg \
  -u "pk_xxx:sk_yyy" \
  -H "Destination: https://{domain}/webdav/uploads/renamed.jpg"
```

## 下载网关

网关消费一次性下载令牌后流式返回对象。令牌有效期为 15 分钟，且按原子方式消费，并发请求无法重复使用同一个令牌。

### 通过网关下载

`GET /api/gateway/download/{token}`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `token` | `string` | 是 | 下载或分享端点返回的一次性令牌。 |

网关按存储的 MIME 类型流式返回对象，并设置合适的 `Content-Disposition`。受密码保护的文件，令牌必须带有密码验证标记。分享下载时，网关在消费令牌后增加一次下载计数。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `INVALID_TOKEN` | `401` | 令牌无效或已过期。 | 重新生成下载链接。 |
| `PASSWORD_REQUIRED` | `403` | 文件受密码保护，令牌未验证。 | 先验证文件密码。 |
| `NOT_FOUND` | `404` | 文件或对象已被删除。 | 确认文件仍存在。 |
| `SHARE_LIMIT_REACHED` | `410` | 分享达到下载次数上限。 | 请创建者提高上限。 |

#### 示例

```sh
curl -L "https://{domain}/api/gateway/download/{token}" -o photo.jpg
```

## 公开端点

公开端点无需认证。

### 获取公开设置

返回落地页和登录页需要的站点设置。

`GET /api/public/settings`

#### 响应

```json
{
  "success": true,
  "data": {
    "siteTitle": "Picumet",
    "siteHeaderTitle": null,
    "siteLogo": null,
    "siteFavicon": null,
    "allowGuestAccess": false,
    "allowRegistration": true,
    "requireEmailVerification": false
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl https://{domain}/api/public/settings
```

### 列出生效公告

返回当前生效的公告。

`GET /api/public/announcements`

#### 响应

```json
{
  "success": true,
  "data": {
    "items": [{
      "id": "announcement-uuid", "title": "维护通知", "content": "周六停机维护",
      "level": "warning", "active": true, "createdAt": 1710000000000, "expiresAt": null,
      "displayMode": "always", "intervalSeconds": null, "kind": "banner"
    }]
  },
  "timestamp": 1710000000000
}
```

#### 响应字段

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `displayMode` | `string` | 显示策略：`always`、`daily`、`interval`、`until`、`duration` 或 `once`。 |
| `intervalSeconds` | `integer` | 间隔或时长秒数；策略不用时为 `null`。 |
| `expiresAt` | `integer` | `until` 的绝对截止时间戳；未设置时为 `null`。 |
| `kind` | `string` | `banner` 为横幅条；`toast` 为临时弹窗。 |
| `active` | `boolean` | 管理员的启用开关。 |

列表只含生效且未过期的公告；客户端按用户应用显示策略，关闭或展示时间戳保存在本地存储。

#### 示例

```sh
curl https://{domain}/api/public/announcements
```

### 健康检查

返回服务健康状态。存活探针恒为 `ok`；就绪探针在数据库种子初始化完成前返回 `503` 和 `ready: false`。

`GET /api/public/health`

`GET /api/public/health/live`

`GET /api/public/health/ready`

#### 响应

```json
{ "service": "picumet-api", "status": "ok", "ready": true, "detail": "seeded" }
```

#### 示例

```sh
curl https://{domain}/api/public/health/ready
```

## 公开路径直服

API 会直接从文件的公开虚拟路径返回文件，例如 `GET https://{domain}/drive/photos/photo.jpg`。该路由在所有 API 和 WebDAV 路由之后注册，因此不会遮蔽它们。

公开挂载上的文件无需认证即可访问。私有挂载上的文件需要登录且具备下载权限，或持有该路径的有效签名（`?sign=`，见「网关接入」一节的直链签名）。受密码保护的文件返回 `403 PASSWORD_REQUIRED`。未挂载的路径或包含 `..` 的路径返回 `404`。

#### 示例

```sh
curl "https://{domain}/drive/photos/photo.jpg" -o photo.jpg
```

## 公开空间（Gallery）

`visibility=public` 且审核通过（`approved`）的文件进入公开空间，匿名可访问。列表、下载和密码验证均无需登录；已登录的属主和管理员下载免密。公开面直接按可见性与审核状态过滤，不经过路径权限规则。

### 浏览公开空间

分页返回审核通过的公开文件，仅返回文件（不含文件夹）。

`GET /api/gallery?page={page}&limit={limit}`

#### 响应

```json
{
  "success": true,
  "data": {
    "items": [{
      "id": "file-uuid",
      "name": "photo.jpg",
      "path": "/drive/photos/photo.jpg",
      "type": "file",
      "size": 1048576,
      "mimeType": "image/jpeg",
      "coverUrl": null,
      "hasPassword": false,
      "ownerName": "alice",
      "visibility": "public",
      "createdAt": 1710000000000,
      "updatedAt": 1710000000000
    }],
    "pagination": { "total": 3, "page": 1, "limit": 50, "pages": 1 }
  },
  "timestamp": 1710000000000
}
```

### 获取公开文件下载链接

返回一次性网关下载链接（15 分钟有效）。带密码的文件返回 `403 PASSWORD_REQUIRED`，需要先验证密码。

`GET /api/gallery/{id}/download`

#### 响应

```json
{
  "success": true,
  "data": { "url": "https://{domain}/api/gateway/download/{token}", "expiresIn": 900 },
  "timestamp": 1710000000000
}
```

### 验证公开文件密码

匿名验证访问密码，通过后同样返回一次性网关下载链接。

`POST /api/gallery/{id}/verify-password`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `password` | `string` | 是 | 文件访问密码。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 文件不存在、未公开或未过审。 | 核对文件状态。 |
| `INVALID_PASSWORD` | `401` | 密码错误。 | 重试。 |
| `VALIDATION_ERROR` | `400` | 文件未设置密码。 | 直接下载。 |

## 网关接入（S3 / Lsky / OpenList 兼容）

> 网关密钥（原 API 密钥）把 Picumet 作为 S3/R2/Oracle/MinIO 存储的**中转面**接入外部工具（PicGo/PicList、rclone、S3 SDK 等），图床上传只是用途之一。
> 密钥创建时按 `protocols` 声明协议面：`webdav` / `api` / `s3`；`protocols` 非空的密钥只能使用声明过的协议面（空数组视为全量，兼容存量数据）。
> **数据层所有者隔离**：网关密钥的一切文件读写删均限定在密钥属主名下（`owner_id`），路径规则被误配也无法触达其他用户的数据；目录（前缀）为挂载内共享命名空间，同一路径的文件被他人占用时写入返回 `409 CONFLICT`。
> S3 网关验签需要可逆 secret：创建密钥时以 AES-GCM 加密落库（迁移 `0006_s3_gateway.sql`），存量密钥（无该列数据）使用 S3 网关会得到 `InvalidAccessKeyId`，请重建密钥。创建密钥响应的 `configs` 新增 `s3` 与 `openlist` 速配信息。

### Lsky Pro V2 兼容上传

`POST /api/v1/upload`，认证 `Authorization: Bearer pk_*.sk_*`（也接受裸 token）。multipart 字段 `file`，可选 `path` 字段（相对路径基于密钥上传路径模板解析，绝对路径须落在密钥上传根内）。路径模板渲染、上传根边界、配额、覆盖语义、目录行补齐与 `/api/upload` 完全一致。

成功响应（Lsky V2 契约，PicList 选「Lsky Pro V2」即用）：

```json
{
  "status": true,
  "message": "success",
  "data": {
    "key": "{fileId}",
    "name": "pic.png",
    "path": "/uploads/2024/pic.png",
    "size": 10240,
    "links": { "url": "https://{domain}/uploads/2024/pic.png?sign=…" }
  }
}
```

失败响应：`{ "status": false, "message": "原因", "data": null }`（HTTP 仍为 200）。

### OpenList / AList 兼容接口（`/openlist` 前缀）

实现 AList v3 REST 协议子集，PicList 选「AList」、url 填 `https://{domain}/openlist` 即获得内置类型体验（含粘贴即删）。使用独立前缀的原因：`/api/auth/login` 已被 Picumet 自有登录占用。响应统一为 `{code, message, data}` 壳，`message` 恒为 `success`（客户端以 code===200 判定）。

| 端点 | 说明 |
| :--- | :--- |
| `POST /openlist/api/auth/login` | `{username: keyId, password: secret}` → `data.token = pk_*.sk_*`（无服务端会话，token 即密钥） |
| `PUT /openlist/api/fs/form` | multipart `file`；头 `Authorization: <裸 token>`、`File-Path: encodeURIComponent(完整虚拟路径)` |
| `POST /openlist/api/fs/list` | `{path, page?, per_page?}` → `data.content[{name,size,is_dir,modified}]` |
| `POST /openlist/api/fs/get` | `{path}` → `data.sign`（/d 直链签名）、`data.is_dir` 等 |
| `POST /openlist/api/fs/remove` | `{dir, names: [...]}` → 删除（复用 WebDAV 删除语义） |
| `GET /openlist/d{encodedPath}?sign=` | 直链下载；公开挂载匿名，私有挂载凭 `fs/get` 下发的 sign |

### S3 兼容网关（`/s3` 前缀）

SigV4 验签的 S3 REST 子集。客户端配置：endpoint = `https://{domain}/s3`、**路径式寻址（`forcePathStyle=true` / `pathStyleAccess`）**、region 任意（PicList 用字面量 `auto`）、`accessKeyId = pk_*`、`secretAccessKey = sk_*`。

**bucket 语义**：bucket = 虚拟路径首段（挂载路径或密钥上传根的首段，如 uploadPath=`/uploads` → bucket=`uploads`），key = 其余路径。`GET /s3` 返回密钥可达的 bucket 列表（挂载根下的一级目录名）。

| 操作 | 请求 |
| :--- | :--- |
| PutObject | `PUT /s3/{bucket}/{key}`（整包 `x-amz-content-sha256` 校验；`x-amz-meta-*` 透传为对象元数据） |
| GetObject | `GET /s3/{bucket}/{key}`（支持 `Range` → 206） |
| HeadObject | `HEAD /s3/{bucket}/{key}` |
| DeleteObject | `DELETE /s3/{bucket}/{key}`（删除不存在的 key 仍 204） |
| ListObjectsV2 | `GET /s3/{bucket}?list-type=2&prefix=&delimiter=/&max-keys=` |
| DeleteObjects | `POST /s3/{bucket}?delete`（XML body，≤1000 keys） |
| ListBuckets | `GET /s3` |

未实现（返回 `501 NotImplemented`）：CopyObject、Multipart Upload、DeleteBucket。请求时间偏差超过 15 分钟拒绝（`AccessDenied`）。预签名 GET 由客户端本地生成，服务端按 query 验签后放行（`X-Amz-Expires` 1~604800 秒）。

### 直链签名（`?sign=`）

兼容上传 / Lsky V2 / S3 场景返回的文件 URL：

- 存储提供商配置了公网域名（`public_domain`）→ 返回 CDN 直链；
- 否则返回 `{APP_BASE_URL}{虚拟路径}?sign={expiresAt}.{hmac}` —— path-serve 校验通过即允许**匿名 GET 该精确路径**（能力范围 = 该路径），`expiresAt=0` 表示长期有效。

签名与密钥生命周期解耦：撤销/重建网关密钥不会使已发出的直链失效。

## 相关文档

- [系统架构](ARCHITECTURE_CN.md)：这些端点背后的服务设计。
- [开发指南](DEVELOPMENT_CN.md)：运行和测试 Workers 代码库。
- [部署指南](DEPLOYMENT_CN.md)：配置绑定、密钥和域名。
- [前端指南](UI_CN.md)：消费这些 API 的页面。
- [项目概览](../README_CN.md) 与 [进度追踪](PROGRESS.md)。






