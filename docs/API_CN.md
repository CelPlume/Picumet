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
| `RATE_LIMIT_EXCEEDED` | `429` | 请求超过限流阈值。 | 等待后重试，或提高限额。 |
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

返回已登录用户及其配额。

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
      "theme": "system"
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

返回单个文件或文件夹，附带权限、访问模式和密码状态。

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

重命名文件或文件夹，并更新元数据，包括访问密码和展示选项。

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
| `manualPosition` | `integer` | 否 | 手动排序位置。 |

#### 响应

返回更新后的文件。

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

分享端点负责分享链接的创建、列表、密码验证、下载、预览和撤销。创建、列表、撤销需要登录；读取分享信息、验证密码、下载和预览对外开放。

### 创建分享

为文件创建分享链接，需要文件的 `share` 权限。

`POST /api/shares/`

#### 请求体

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `fileId` | `string` | 是 | 文件标识。 |
| `title` | `string` | 否 | 展示标题，默认取文件名。 |
| `password` | `string` | 否 | 分享密码，服务端只保存哈希。 |
| `expiresIn` | `integer` | 否 | 有效期，单位秒，范围 60 到 1 年。 |
| `maxViews` | `integer` | 否 | 最大浏览次数。 |
| `maxDownloads` | `integer` | 否 | 最大下载次数。 |
| `allowPreview` | `boolean` | 否 | 是否允许预览，默认 `true`。 |
| `allowDownload` | `boolean` | 否 | 是否允许下载，默认 `true`。 |

#### 响应

返回分享的短 ID 和公开链接，状态码 `201`。

```json
{
  "success": true,
  "data": {
    "share": {
      "id": "abc123",
      "url": "https://{domain}/share/abc123",
      "expiresAt": null,
      "createdAt": 1710000000000,
      "passwordProtected": true,
      "allowPreview": true,
      "allowDownload": true
    }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 没有登录。 | 先登录。 |
| `VALIDATION_ERROR` | `400` | 分享参数不合法。 | 修正参数后重试。 |
| `FORBIDDEN` | `403` | 没有 share 权限。 | 检查权限规则。 |
| `NOT_FOUND` | `404` | 文件不存在。 | 核对文件标识。 |

#### 示例

```sh
curl -X POST https://{domain}/api/shares/ \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"fileId":"file-uuid","password":"share-pass","expiresIn":604800}'
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
        "title": "photo.jpg",
        "file": { "id": "file-uuid", "name": "photo.jpg", "path": "/drive/photos", "type": "file", "size": 1048576 },
        "expiresAt": null,
        "viewCount": 3,
        "maxViews": null,
        "downloadCount": 1,
        "maxDownloads": null,
        "allowPreview": true,
        "allowDownload": true,
        "status": "active",
        "createdAt": 1710000000000
      }
    ],
    "pagination": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
  },
  "timestamp": 1710000000000
}
```

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | 没有登录。 | 先登录。 |

#### 示例

```sh
curl "https://{domain}/api/shares/?status=active" -b cookies.txt
```

### 获取分享信息

无需登录即可查看公开分享信息。分享设置了密码时，响应会返回 `requiresPassword: true`，在密码验证通过前不返回文件数据。

`GET /api/shares/{id}`

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
      "title": "photo.jpg",
      "creatorName": "alice",
      "file": { "id": "file-uuid", "name": "photo.jpg", "path": "/drive/photos", "type": "file", "size": 1048576, "mimeType": "image/jpeg" },
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

分享设置了密码且尚未验证时，`file`、`allowPreview`、`allowDownload` 为 `null` 或 `false`，`requiresPassword` 为 `true`。

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 分享不存在。 | 核对分享 ID。 |
| `SHARE_REVOKED` | `410` | 分享已被撤销。 | 请创建者重新生成。 |
| `SHARE_EXPIRED` | `410` | 分享已过期。 | 请创建者重新生成。 |
| `SHARE_LIMIT_REACHED` | `410` | 分享达到浏览次数上限。 | 请创建者提高上限。 |

#### 示例

```sh
curl https://{domain}/api/shares/abc123
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

返回分享的一次性网关下载链接。下载计数只在网关实际消费令牌时增加一次。

`GET /api/shares/{id}/download`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 分享 ID。 |

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
| `NOT_FOUND` | `404` | 分享不存在。 | 核对分享 ID。 |
| `SHARE_REVOKED` | `410` | 分享不可用。 | 请创建者重新生成。 |
| `SHARE_EXPIRED` | `410` | 分享已过期。 | 请创建者重新生成。 |
| `FORBIDDEN` | `403` | 分享不允许下载。 | 请创建者开启下载。 |
| `INVALID_PASSWORD` | `401` | 密码未验证。 | 先调用验证端点。 |
| `SHARE_LIMIT_REACHED` | `410` | 分享达到下载次数上限。 | 请创建者提高上限。 |

#### 示例

```sh
curl https://{domain}/api/shares/abc123/download -b cookies.txt
```

### 预览分享文件

分享允许预览时，直接以 `Content-Disposition: inline` 输出图片。返回二进制图片数据，不是 JSON。

`GET /api/shares/{id}/preview`

#### 路径参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 分享 ID。 |

#### 错误

| 错误码 | HTTP 状态 | 原因 | 处理建议 |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | 分享或文件对象不存在。 | 核对分享 ID。 |
| `SHARE_EXPIRED` | `410` | 分享不可用。 | 请创建者重新生成。 |
| `FORBIDDEN` | `403` | 分享不允许预览。 | 请创建者开启预览。 |
| `INVALID_PASSWORD` | `401` | 密码未验证。 | 先调用验证端点。 |

#### 示例

```sh
curl https://{domain}/api/shares/abc123/preview -o photo.jpg
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

返回聚合统计、近期活动和最近 24 小时的请求量。

`GET /api/admin/dashboard`

#### 响应

```json
{
  "success": true,
  "data": {
    "stats": {
      "users": 12,
      "files": 345,
      "storage": [{ "providerId": "provider-uuid", "name": "R2", "usedSpace": 10485760, "fileCount": 300 }]
    },
    "requests24h": 1200,
    "recentActivity": [{ "action": "upload", "path": "/drive/a.txt", "userId": "user-uuid", "createdAt": 1710000000000 }]
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl https://{domain}/api/admin/dashboard -b cookies.txt
```

### 获取统计数据

返回用户、文件和存储统计。

`GET /api/admin/stats`

#### 响应

```json
{
  "success": true,
  "data": {
    "users": 12,
    "files": 345,
    "storage": [{ "providerId": "provider-uuid", "name": "R2", "usedSpace": 10485760, "fileCount": 300 }],
    "recentActivity": []
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl https://{domain}/api/admin/stats -b cookies.txt
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
    "items": [{ "id": "abc123", "title": "photo.jpg", "creatorId": "user-uuid", "status": "active" }],
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

跨所有挂载点搜索文件。

`GET /api/admin/files?page={page}&limit={limit}&search={search}`

#### 列表查询参数

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | 否 | 页码，默认 `1`。 |
| `limit` | `integer` | 否 | 每页条数，默认 `20`，最大 `100`。 |
| `search` | `string` | 否 | 匹配文件名的关键字。 |

#### 响应

```json
{
  "success": true,
  "data": {
    "items": [{ "id": "file-uuid", "name": "photo.jpg", "path": "/drive/photos", "type": "file", "size": 1048576 }],
    "pagination": { "total": 345, "page": 1, "limit": 20, "pages": 18 }
  },
  "timestamp": 1710000000000
}
```

#### 示例

```sh
curl "https://{domain}/api/admin/files?search=photo" -b cookies.txt
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
| `siteTitle` | `string` | 否 | 站点标题。 |
| `siteLogo` | `string` | 否 | 站点 Logo 地址。 |
| `siteFavicon` | `string` | 否 | 站点图标地址。 |
| `allowRegistration` | `boolean` | 否 | 是否允许注册。 |
| `allowGuestAccess` | `boolean` | 否 | 是否允许游客访问。 |
| `requireEmailVerification` | `boolean` | 否 | 注册是否需要邮箱验证。 |
| `enableTurnstile` | `boolean` | 否 | 是否启用 Cloudflare Turnstile。 |
| `turnstileSiteKey` | `string` | 否 | Turnstile Site Key。 |
| `rateLimitEnabled` | `boolean` | 否 | 是否启用限流。 |
| `rateLimitRequestsPerMinute` | `integer` | 否 | 每分钟请求数，范围 1 到 10000。 |
| `smtpHost` | `string` | 否 | SMTP 服务器地址。 |
| `smtpPort` | `integer` | 否 | SMTP 端口。 |
| `smtpSecure` | `boolean` | 否 | 是否使用安全连接。 |
| `smtpUser` | `string` | 否 | SMTP 用户名。 |
| `smtpPassword` | `string` | 否 | SMTP 密码。传 `"******"` 或空字符串可保留当前密码。 |
| `smtpFromName` | `string` | 否 | 发件人名称。 |
| `smtpFromEmail` | `string` | 否 | 发件邮箱。 |
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
| `level` | `string` | 否 | `info`、`warning` 或 `danger`。 |
| `expiresIn` | `integer` | 否 | 有效期，单位秒，至少 60。 |

#### 示例

```sh
curl -X POST https://{domain}/api/admin/announcements \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"title":"维护通知","content":"周六停机维护","level":"warning"}'
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
| `type` | `string` | 是 | `r2`、`s3` 或 `oracle`。 |
| `endpoint` | `string` | 否 | S3 端点。R2 绑定模式留空；只允许公网 http(s) 地址。 |
| `region` | `string` | 否 | 区域，R2 默认 `auto`。 |
| `bucket` | `string` | 是 | 存储桶名称。 |
| `accessKeyId` | `string` | 否 | Access Key，R2 绑定模式留空。 |
| `secretAccessKey` | `string` | 否 | Secret Key，R2 绑定模式留空。 |
| `publicDomain` | `string` | 否 | 公网 CDN 域名，用于直链。 |
| `uploadDomain` | `string` | 否 | 自定义上传域名。 |
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
| `type` | `string` | 是 | `r2`、`s3` 或 `oracle`。 |
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
  -d '{"type":"s3","endpoint":"https://s3.example.com","bucket":"my-bucket","accessKeyId":"AK","secretAccessKey":"SK","sessionHours":1}'
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
  "data": { "items": [{ "id": "announcement-uuid", "title": "维护通知", "content": "周六停机维护", "level": "warning" }] },
  "timestamp": 1710000000000
}
```

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

公开挂载上的文件无需认证即可访问。私有挂载上的文件需要登录且具备下载权限。受密码保护的文件返回 `403 PASSWORD_REQUIRED`。未挂载的路径或包含 `..` 的路径返回 `404`。

#### 示例

```sh
curl "https://{domain}/drive/photos/photo.jpg" -o photo.jpg
```

## 相关文档

- [系统架构](ARCHITECTURE_CN.md)：这些端点背后的服务设计。
- [开发指南](DEVELOPMENT_CN.md)：运行和测试 Workers 代码库。
- [部署指南](DEPLOYMENT_CN.md)：配置绑定、密钥和域名。
- [前端指南](UI_CN.md)：消费这些 API 的页面。
- [项目概览](../README_CN.md) 与 [进度追踪](PROGRESS.md)。






