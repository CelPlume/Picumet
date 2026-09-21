<div align="center">

<img src="../assets/logo.svg" alt="Picumet Logo" width="128" />

# Picumet API reference

**Multi-cloud object storage with fine-grained access control**

English | [中文](API_CN.md)

</div>

This reference describes the Picumet REST API. The API manages files across multiple object-storage providers, exposes downloads through a token gateway, and supports WebDAV and PicGo-compatible clients. The reference groups endpoints by resource, and every response follows a shared envelope.

## Before you begin

- **Base URL**: the deployed origin of the Workers application, for example `https://{domain}`. All paths in this reference are relative to that origin.
- **Authentication**: each request uses one of three methods, depending on the client.
- **CSRF tokens**: cookie-authenticated write requests must include the `X-CSRF-Token` header. Obtain a token from `GET /api/auth/csrf-token`. API-key and WebDAV requests skip CSRF checks.
- **Content type**: send JSON request bodies with `Content-Type: application/json`. File uploads use `multipart/form-data` or a raw body.
- **Rate limits**: auth endpoints allow 5 requests per minute per IP. Other endpoints apply a configurable per-user and per-IP limit.

### Authentication methods

| Method | Header | Use for |
| :--- | :--- | :--- |
| HttpOnly cookie JWT | `Cookie: auth_token=...` | Web frontend and browser clients |
| API key (Bearer) | `Authorization: Bearer {key_id}.{secret}` | PicGo, PicList, scripts, and custom clients |
| WebDAV Basic | `Authorization: Basic base64({key_id}:{secret})` | WebDAV clients |

The API key is an opaque token in the format `pk_{24 chars}.sk_{48 chars}`. The server stores only a SHA-256 hash of the full token, so you cannot retrieve it again after creation.

## Response format

Every successful response uses the same envelope.

```json
{
  "success": true,
  "data": { },
  "message": "optional message",
  "timestamp": 1710000000000
}
```

### Success response fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `success` | `boolean` | Always `true` for successful responses. |
| `data` | `object` | The resource payload. The shape depends on the endpoint. |
| `message` | `string` | An optional human-readable message. |
| `timestamp` | `integer` | The server time in milliseconds since the Unix epoch. |

Failed requests return an error envelope with an HTTP status code and a machine-readable error code.

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

### Error response fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `success` | `boolean` | Always `false` for error responses. |
| `error.code` | `string` | A stable machine-readable code such as `NOT_FOUND`. |
| `error.message` | `string` | A human-readable message. |
| `error.details` | `object` | Additional details. Present only in development environments. |
| `timestamp` | `integer` | The server time in milliseconds since the Unix epoch. |

## Error codes

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | A request field or query parameter has an invalid value. | Correct the field and retry. |
| `INVALID_CREDENTIALS` | `401` | The username or password is wrong. | Re-enter the credentials. |
| `UNAUTHORIZED` | `401` | The request has no valid session or API key. | Log in or provide a valid key. |
| `INVALID_TOKEN` | `401` | The session token, API key, or download token is invalid or expired. | Refresh the credential and retry. |
| `INVALID_PASSWORD` | `401` | A file, folder, or share password is incorrect. | Re-enter the password. |
| `USER_DISABLED` | `401` | The account is not active. | Contact the administrator. |
| `ROLE_CHANGED` | `401` | The account role changed since the session started. | Log in again. |
| `SESSION_REVOKED` | `401` | The session ended after a password change or logout. | Log in again. |
| `EMAIL_NOT_VERIFIED` | `403` | Login requires email verification. | Verify the email first. |
| `FORBIDDEN` | `403` | The caller lacks permission for the operation. | Check the permission rules and the API key scope. |
| `PASSWORD_REQUIRED` | `403` | The file is password-protected and the password is not verified. | Call the password-verify endpoint first. |
| `NOT_FOUND` | `404` | The resource, file, mount, or path does not exist. | Confirm the identifier or path and retry. |
| `ALREADY_EXISTS` | `409` | A file or folder with the same name already exists. | Use a different name. |
| `OPERATION_FAILED` | `409` / `422` | The operation cannot proceed because of the current state. | Check the error message and retry. |
| `SHARE_EXPIRED` | `410` | The share link has expired. | Ask the creator for a new link. |
| `SHARE_REVOKED` | `410` | The share link no longer works. | Ask the creator for a new link. |
| `SHARE_LIMIT_REACHED` | `410` | The share hit its view or download limit. | Ask the creator to raise the limit. |
| `UPLOAD_SESSION_EXPIRED` | `410` | The upload session exceeded its one-hour lifetime. | Start a new upload session. |
| `QUOTA_EXCEEDED` | `413` | The storage or file-count quota has run out. | Free up space or raise the quota. |
| `PAYLOAD_TOO_LARGE` | `413` | The upload exceeds the 1 GB free-mode limit. | Split the file or use a smaller file. |
| `RATE_LIMIT_EXCEEDED` | `429` | The caller exceeded a rate limit. | Wait and retry, or raise the limit. |
| `INTERNAL_ERROR` | `500` | An unexpected server error occurred. | Retry later or report the issue. |

## Authentication

Authentication endpoints manage registration, login, sessions, email verification, and password reset. Registration, login, logout, and password endpoints are public; `GET /api/auth/me` and `GET /api/auth/csrf-token` require a logged-in session.

### Register a user

Creates a user account and, when the site requires email verification, sends a verification link.

`POST /api/auth/register`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `username` | `string` | Yes | 3 to 20 characters. Letters, digits, and underscores only. |
| `password` | `string` | Yes | At least 8 characters, at most 128. |
| `email` | `string` | Yes | A valid email address. |
| `inviteCode` | `string` | No | The invite code, required when invite codes are active. |
| `turnstileToken` | `string` | No | The Turnstile token, required when Turnstile is active. |

#### Response

Returns the new user and a confirmation message with status `201`.

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | A field violates the format rules. | Correct the field and retry. |
| `FORBIDDEN` | `403` | This site does not allow registration. | Contact the administrator. |
| `ALREADY_EXISTS` | `409` | The username or email is already registered. | Choose another username or email. |

#### Example

```sh
curl -X POST https://{domain}/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret-pass","email":"alice@example.com"}'
```

### Log in

Authenticates a user and sets an HttpOnly `auth_token` cookie for 7 days.

`POST /api/auth/login`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `username` | `string` | Yes | The username. |
| `password` | `string` | Yes | The password. |
| `turnstileToken` | `string` | No | The Turnstile token, required when Turnstile is active. |

#### Response

Returns the user and the current quota.

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

The `Set-Cookie` header carries the `auth_token` JWT with `HttpOnly`, `SameSite=Strict`, and a 7-day lifetime.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `INVALID_CREDENTIALS` | `401` | The username or password is wrong. | Re-enter the credentials. |
| `USER_DISABLED` | `401` | The account is not active. | Contact the administrator. |
| `EMAIL_NOT_VERIFIED` | `403` | Login requires email verification. | Verify the email first. |

#### Example

```sh
curl -X POST https://{domain}/api/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"username":"alice","password":"secret-pass"}'
```

### Log out

Revokes the current session and clears the `auth_token` cookie. Logout bumps the session version, which invalidates every JWT issued for the account.

`POST /api/auth/logout`

#### Response

Returns `data: null` on success.

#### Example

```sh
curl -X POST https://{domain}/api/auth/logout \
  -b cookies.txt
```

### Get the current user

Returns the logged-in user, their quota, and capability bits. `capabilities` lists what the account may do: `can_publish` (publish public files), `can_share` (create shares), and `can_grant` (create per-file access rules for other users).

`GET /api/auth/me`

#### Response

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | No valid session cookie. | Log in first. |

#### Example

```sh
curl https://{domain}/api/auth/me -b cookies.txt
```

### Get a CSRF token

Returns a CSRF token for the logged-in session. Send this token in the `X-CSRF-Token` header of cookie-authenticated write requests. The server caches the token in KV for 2 hours.

`GET /api/auth/csrf-token`

#### Response

```json
{
  "success": true,
  "data": { "token": "32-char-random-string" },
  "timestamp": 1710000000000
}
```

#### Example

```sh
curl https://{domain}/api/auth/csrf-token -b cookies.txt
```

### Verify an email

Completes email verification with the token from the verification email. Both `/verify-email` and `/verify` are aliases. The endpoint returns an HTML confirmation page, not JSON.

`GET /api/auth/verify-email?token={token}`

`GET /api/auth/verify?token={token}`

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `token` | `string` | Yes | The verification token from the email. Valid for 24 hours. |

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The token is missing, invalid, or expired. | Request a new verification email. |

### Request a password reset

Sends a password-reset link to the email address. The response does not reveal whether the email belongs to an account.

`POST /api/auth/forgot-password`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `email` | `string` | Yes | The registered email address. |

#### Response

```json
{
  "success": true,
  "data": { "message": "如果该邮箱已注册，重置链接已发送" },
  "timestamp": 1710000000000
}
```

#### Example

```sh
curl -X POST https://{domain}/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com"}'
```

### Reset the password

Sets a new password with the token from the reset link. A successful reset revokes all existing sessions.

`POST /api/auth/reset-password`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `token` | `string` | Yes | The reset token from the email. Valid for 15 minutes. |
| `password` | `string` | Yes | The new password, at least 8 characters. |

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The token is invalid, expired, or the password is too short. | Request a new reset link. |

## Files

File endpoints list, create, update, move, and delete files and folders. All of them require a logged-in session, and each operation enforces path-level permission rules.

### List files

Lists the children of a directory with pagination, sorting, filtering, and search.

`GET /api/files?path={path}&page={page}&limit={limit}&sort={sort}&order={order}&type={type}&search={search}`

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `path` | `string` | No | The directory to list. Defaults to `/`. |
| `page` | `integer` | No | The page number. Defaults to `1`. |
| `limit` | `integer` | No | Items per page. Defaults to `100`, maximum `1000`. |
| `sort` | `string` | No | `name`, `time`, `size`, or `manual`. Defaults to the mount setting. |
| `order` | `string` | No | `asc` or `desc`. Defaults to `asc`. |
| `type` | `string` | No | `file` or `folder` to filter by type. |
| `search` | `string` | No | A keyword to match against file names. |

#### Response

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

#### Response fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `items` | `array` | The file and folder entries in the directory. |
| `items[].id` | `string` | The file identifier. |
| `items[].name` | `string` | The file or folder name. |
| `items[].path` | `string` | The parent directory path. |
| `items[].type` | `string` | `file` or `folder`. |
| `items[].size` | `integer` | The size in bytes. |
| `items[].mimeType` | `string` | The MIME type, for files. |
| `items[].hasPassword` | `boolean` | Whether the file is password-protected. |
| `pagination` | `object` | `total`, `page`, `limit`, and `pages`. |
| `mount` | `object` | The mount that contains the directory. |

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | A query parameter is invalid. | Correct the parameter and retry. |
| `NOT_FOUND` | `404` | The path is not mounted. | Confirm the path. |
| `FORBIDDEN` | `403` | The caller lacks read permission. | Check the permission rules. |

#### Example

```sh
curl "https://{domain}/api/files?path=/drive&limit=50" -b cookies.txt
```

### Create a folder

Creates a folder under the target path. Requires write permission on the target directory.

`POST /api/files/folder`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `path` | `string` | Yes | The parent directory path. |
| `name` | `string` | Yes | The folder name, at most 255 characters. |

#### Response

Returns the created folder with status `201`.

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The name or path is invalid. | Correct the input and retry. |
| `FORBIDDEN` | `403` | The caller lacks write permission. | Check the permission rules. |
| `NOT_FOUND` | `404` | The parent path is not mounted. | Confirm the path. |
| `ALREADY_EXISTS` | `409` | A file or folder with the same name already exists. | Choose a different name. |

#### Example

```sh
curl -X POST https://{domain}/api/files/folder \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"path":"/drive","name":"photos"}'
```

### Get file details

Returns a single file or folder with its permissions, access mode, password status, visibility, and review status.

`GET /api/files/{id}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The file identifier. |

#### Response

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

The `accessMode` value is `public_cdn` for files served by a public CDN domain, `signed_redirect` for pre-signed URL providers, or `private_gateway` for the Worker download gateway.

File objects also carry `visibility` (`private` / `users` / `public`) and `reviewStatus` (`pending` / `approved` / `rejected`; only meaningful for `public`, otherwise `null`). `private` files are visible only to the owner and admins; `users` files are readable and downloadable by any signed-in user; `public` files that pass review enter the anonymous public gallery.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The file or mount does not exist. | Confirm the identifier. |
| `FORBIDDEN` | `403` | The caller lacks read permission. | Check the permission rules. |

#### Example

```sh
curl https://{domain}/api/files/{id} -b cookies.txt
```

### Update file metadata

Renames a file or folder and updates its metadata, including the access password, display options, and visibility.

`PUT /api/files/{id}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The file identifier. |

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | No | The new name. Renaming requires the update permission. |
| `customTitle` | `string` | No | A custom display title, at most 200 characters. |
| `customColor` | `string` | No | A custom accent color in `#RRGGBB` format. |
| `coverUrl` | `string` | No | A cover image URL. |
| `iconEmoji` | `string` | No | An icon emoji, at most 16 characters. |
| `accessPassword` | `string` | No | A new access password, or `null` to remove it. The server stores only a hash. |
| `visibility` | `string` | No | The visibility: `private`, `users`, or `public`. Requires the update permission. |
| `manualPosition` | `integer` | No | The manual sort position. |
| `guestVisibility` | `string` | No | Guest (anonymous visitor) visibility: `inherit` (clears the file-level setting and follows the role default), `none` (guests cannot see it), `download` (download only), `view` (view and download). Requires the update permission; supported on files and folders, and it is the storage field behind "Default user permissions". |

#### Response

Returns the updated file. When setting `visibility`: `users` takes effect immediately; `public` requires the account to hold the `can_publish` capability, otherwise the file enters the `pending` review queue for admin approval; setting it on a folder cascades to everything inside. Visibility changes are recorded as a `visibility_change` audit log.

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | A field is invalid. | Correct the field and retry. |
| `FORBIDDEN` | `403` | The caller lacks the update permission. | Check the permission rules. |
| `ALREADY_EXISTS` | `409` | The new name collides with an existing entry. | Choose a different name. |
| `NOT_FOUND` | `404` | The file does not exist. | Confirm the identifier. |

#### Example

```sh
curl -X PUT https://{domain}/api/files/{id} \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"name":"renamed.jpg","accessPassword":"my-pass"}'
```

### Verify a file password

Verifies the access password of a protected file and returns a short-lived gateway download URL.

`POST /api/files/{id}/verify-password`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The file identifier. |

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `password` | `string` | Yes | The file access password. |

#### Response

```json
{
  "success": true,
  "data": { "url": "https://{domain}/api/gateway/download/{token}", "expiresIn": 900 },
  "timestamp": 1710000000000
}
```

The returned URL stays valid for 900 seconds and works once.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The file has no password, or the password is missing. | Provide a password or skip verification. |
| `INVALID_PASSWORD` | `401` | The password is wrong. | Re-enter the password. |

#### Example

```sh
curl -X POST https://{domain}/api/files/{id}/verify-password \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"password":"my-pass"}'
```

### Get a download link

Returns a single-use gateway download URL for the file. The file must not be password-protected.

`GET /api/files/{id}/download`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The file identifier. |

#### Response

```json
{
  "success": true,
  "data": { "url": "https://{domain}/api/gateway/download/{token}", "expiresAt": 1710000900000 },
  "timestamp": 1710000000000
}
```

The token expires 15 minutes after issue, and the gateway consumes it on the first download.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `PASSWORD_REQUIRED` | `403` | The file is password-protected. | Call the password-verify endpoint first. |
| `FORBIDDEN` | `403` | The caller lacks the download permission. | Check the permission rules. |
| `NOT_FOUND` | `404` | The file does not exist. | Confirm the identifier. |

#### Example

```sh
curl https://{domain}/api/files/{id}/download -b cookies.txt
```

### Get copy links

Returns the file URL in four formats: direct, HTML, Markdown, and BBCode. By default the direct URL points to the public path of the file, such as `{origin}/drive/photos/photo.jpg`. Pass `signed=true` to request a pre-signed URL from the provider, with the gateway URL as the fallback.

`GET /api/files/{id}/copy-links?signed={signed}&expiresIn={expiresIn}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The file identifier. |

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `signed` | `boolean` | No | When `true`, request a signed URL. Defaults to `false`. |
| `expiresIn` | `integer` | No | The signed URL lifetime in seconds, from 60 to 604800. Defaults to `3600`. Used only with `signed=true`. |

#### Response

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

When you set `signed=true`, `accessMode` becomes `signed` and `expiresIn` returns the signed URL lifetime.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `FORBIDDEN` | `403` | The caller lacks the download permission. | Check the permission rules. |
| `NOT_FOUND` | `404` | The file does not exist. | Confirm the identifier. |

#### Example

```sh
curl "https://{domain}/api/files/{id}/copy-links?signed=true&expiresIn=3600" -b cookies.txt
```

### Delete a file

Hard-deletes a file or folder. The metadata and quota update in a single transaction, and cleanup of the object runs asynchronously.

`DELETE /api/files/{id}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The file or folder identifier. |

#### Response

```json
{
  "success": true,
  "data": { "deleted": 1, "size": 1048576 },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `FORBIDDEN` | `403` | The caller lacks the delete permission. | Check the permission rules. |
| `NOT_FOUND` | `404` | The file does not exist. | Confirm the identifier. |

#### Example

```sh
curl -X DELETE https://{domain}/api/files/{id} \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

### Move a file

Moves or renames a file or folder asynchronously. The move uses a Saga: it copies the object, verifies the copy, switches the metadata atomically, then cleans up the source. Requires the delete permission on the source and the write permission on the target.

`POST /api/files/{id}/move`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The file or folder identifier. |

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `targetPath` | `string` | Yes | The target directory path. |
| `newName` | `string` | No | An optional new name for the entry. |

#### Response

Returns the job identifier and its initial status.

```json
{
  "success": true,
  "data": { "jobId": "job-uuid", "status": "pending" },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The target path is missing or invalid. | Provide a target path. |
| `FORBIDDEN` | `403` | The caller lacks the required permissions. | Check the permission rules. |
| `NOT_FOUND` | `404` | The file does not exist. | Confirm the identifier. |
| `OPERATION_FAILED` | `409` | A conflict or a cycle would result. | Choose another target. |

#### Example

```sh
curl -X POST https://{domain}/api/files/{id}/move \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"targetPath":"/drive/archive"}'
```

### Get a job status

Returns the status of an asynchronous operation, such as a move. Only the job owner can read it.

`GET /api/files/jobs/{jobId}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `jobId` | `string` | Yes | The job identifier from a move request. |

#### Response

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

The `status` value is `pending`, `running`, `completed`, or `failed`. `progress` is a percentage from 0 to 100.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The job does not exist or belongs to another user. | Confirm the job identifier. |

#### Example

```sh
curl https://{domain}/api/files/jobs/{jobId} -b cookies.txt
```

### Run batch operations

Runs a delete or move operation over up to 100 files and folders. Each item runs independently, and the response lists the successful and failed items.

`POST /api/files/batch`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `string` | Yes | `delete` or `move`. |
| `fileIds` | `array` | Yes | The file or folder identifiers, 1 to 100 items. |
| `targetPath` | `string` | No | The target directory. Required for the `move` action. |

#### Response

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The batch parameters are invalid. | Correct the parameters and retry. |

#### Example

```sh
curl -X POST https://{domain}/api/files/batch \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"action":"delete","fileIds":["uuid-1","uuid-2"]}'
```

## Uploads

Upload endpoints create an upload session, stream the object through the Worker or a pre-signed URL, and commit the file atomically. Sessions expire after one hour. Files larger than 100 MB use multipart upload automatically.

### Create an upload session

Creates an upload session and atomically reserves quota. Files larger than 100 MB, or sessions with a `partCount` greater than 1, switch to multipart upload.

`POST /api/files/upload-session`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `path` | `string` | Yes | The target directory path. |
| `fileName` | `string` | Yes | The file name, at most 255 characters. |
| `fileSize` | `integer` | Yes | The file size in bytes, up to 20 GB. |
| `mimeType` | `string` | No | The MIME type of the file. |
| `partCount` | `integer` | No | The number of parts. Values greater than 1 enable multipart upload. |
| `idempotencyKey` | `string` | No | A client-supplied key to resume a completed session. |

#### Response

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

When the provider supports multipart pre-signed URLs, the response also returns `parts`, an array of `{ partNumber, url }` entries for direct concurrent upload. Otherwise `uploadMode` is `worker` and you stream parts through the Worker.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | A request field is invalid. | Correct the field and retry. |
| `FORBIDDEN` | `403` | The caller lacks the write permission. | Check the permission rules. |
| `QUOTA_EXCEEDED` | `413` | The storage or file-count quota has run out. | Free up space or raise the quota. |
| `NOT_FOUND` | `404` | The target mount does not exist. | Confirm the path. |

#### Example

```sh
curl -X POST https://{domain}/api/files/upload-session \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"path":"/drive/photos","fileName":"photo.jpg","fileSize":1048576,"mimeType":"image/jpeg"}'
```

### Upload a raw file

Uploads the file bytes directly through the Worker for a single-file session. Send the file bytes as the request body.

`PUT /api/files/upload/raw/{sessionId}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | Yes | The session identifier from the upload session. |

#### Request headers

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `Content-Type` | `string` | No | The MIME type of the file. Defaults to the session MIME type. |

#### Response

Returns the object ETag and size after verification.

```json
{
  "success": true,
  "data": { "etag": "\"abc123\"", "size": 1048576 },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The session does not exist or belongs to another user. | Start a new session. |
| `OPERATION_FAILED` | `409` | The session is not in a pending state. | Start a new session. |
| `UPLOAD_SESSION_EXPIRED` | `410` | The session exceeded its one-hour lifetime. | Start a new session. |
| `OPERATION_FAILED` | `422` | The object size does not match the session. | Re-upload the file. |

#### Example

```sh
curl -X PUT https://{domain}/api/files/upload/raw/{sessionId} \
  -H "Content-Type: image/jpeg" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  --data-binary @photo.jpg
```

### Upload a multipart part

Uploads one part of a multipart session through the Worker. The part size is 8 MB. The server records the returned ETag for resume and completion checks.

`PUT /api/files/upload/multipart/{sessionId}/part/{partNumber}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | Yes | The session identifier. |
| `partNumber` | `integer` | Yes | The part number, starting at 1. |

#### Response

```json
{
  "success": true,
  "data": { "partNumber": 1, "etag": "\"abc123\"" },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The part number is out of range. | Use a valid part number. |
| `NOT_FOUND` | `404` | The session does not exist. | Start a new session. |
| `OPERATION_FAILED` | `409` | The session is not a multipart session. | Use a multipart session. |
| `UPLOAD_SESSION_EXPIRED` | `410` | The session expired. | Start a new session. |

#### Example

```sh
curl -X PUT https://{domain}/api/files/upload/multipart/{sessionId}/part/1 \
  -H "Content-Type: application/octet-stream" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  --data-binary @part1.bin
```

### List multipart parts

Returns the uploaded and missing parts of a multipart session. This endpoint is the source of truth for resuming an interrupted upload; for pre-signed providers it also returns new pre-signed URLs for the missing parts.

`GET /api/files/upload/multipart/{sessionId}/parts`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | Yes | The session identifier. |

#### Response

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The session does not exist. | Start a new session. |
| `OPERATION_FAILED` | `409` | The session is not a multipart session. | Use a multipart session. |

#### Example

```sh
curl https://{domain}/api/files/upload/multipart/{sessionId}/parts -b cookies.txt
```

### Abort a multipart upload

Aborts a multipart upload, releases the reserved quota, and marks the session as aborted.

`DELETE /api/files/upload/multipart/{sessionId}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | Yes | The session identifier. |

#### Response

Returns `data: null` on success.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The session does not exist. | Start a new session. |

#### Example

```sh
curl -X DELETE https://{domain}/api/files/upload/multipart/{sessionId} \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

### Complete an upload

Commits the uploaded object. The server verifies the object with a HEAD request, checks the size and ETag, merges multipart parts, then commits the metadata and quota in a single transaction.

`POST /api/files/upload-complete`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | Yes | The session identifier. |
| `etag` | `string` | No | The object ETag returned by the raw upload. Required for single-file sessions. |
| `parts` | `array` | No | The part list `{ partNumber, etag }` for pre-signed direct uploads. Ignored when the server recorded the parts. |

#### Response

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

Calling this endpoint again after success returns `alreadyCompleted: true` with the same result, which makes the completion idempotent.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The request body is invalid or an ETag is missing. | Provide the session and ETag. |
| `NOT_FOUND` | `404` | The session does not exist. | Start a new session. |
| `OPERATION_FAILED` | `409` | The session state prevents completion. | Start a new session. |
| `UPLOAD_SESSION_EXPIRED` | `410` | The session expired. | Start a new session. |
| `OPERATION_FAILED` | `422` | The object or parts fail verification. | Re-upload the file. |

#### Example

```sh
curl -X POST https://{domain}/api/files/upload-complete \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"sessionId":"session-uuid","etag":"\"abc123\""}'
```

## Compatible uploads

PicGo and PicList upload to the compatible endpoints with a Bearer API key. The key must include the `write` permission. Both endpoints accept `multipart/form-data` or a raw body.

### Upload with a compatible client

`POST /api/upload`

`POST /api/upload/upload`

`POST /api/compat/upload`

#### Request headers

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `Authorization` | `string` | Yes | `Bearer {key_id}.{secret}`. |
| `Content-Type` | `string` | Depends | `multipart/form-data`, or the file MIME type for a raw body. |

For `multipart/form-data`, provide the file in the `file` field and an optional `path` field. For a raw body, set the file name with the `X-File-Name` header (or the legacy `filename` header) and an optional target path with the `X-Path` header.

#### Response

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

The `path` field honors the key's upload path template, such as `/uploads/{year}/{month}/`. The final target must stay inside the key's upload root.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | No valid API key. | Provide a Bearer key. |
| `INVALID_TOKEN` | `401` | The API key is invalid, revoked, or expired. | Create a new key. |
| `FORBIDDEN` | `403` | The key lacks the write permission, or the target is outside the upload root. | Grant write permission or adjust the path. |
| `QUOTA_EXCEEDED` | `413` | The quota has run out. | Free up space or raise the quota. |
| `OPERATION_FAILED` | `422` | The uploaded object fails verification. | Re-upload the file. |

#### Example

```sh
curl -X POST https://{domain}/api/upload \
  -H "Authorization: Bearer pk_xxx.sk_yyy" \
  -F "file=@photo.jpg" \
  -F "path=/uploads/"
```

## Shares

Share endpoints create, list, verify, browse, download, preview, and revoke share links. One share carries 1 to 50 items (files and folders mixed). Creating, listing, and revoking shares require a logged-in session. Reading a share, browsing its folders, verifying its password, downloading, and previewing are public.

### Create a share

Creates a share link for one or more files/folders. Requires the `share` permission on every item.

`POST /api/shares/`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `fileIds` | `array` | Yes | Item identifiers (files or folders), 1 to 50. The server deduplicates them, keeps request order, and writes the first one to `shares.file_id`. |
| `title` | `string` | No | Display title. Defaults to the item name for a single item, `{n} items` otherwise. |
| `password` | `string` | No | A share password. The server stores only a hash. |
| `expiresIn` | `integer` | No | The share lifetime in seconds, from 60 to 1 year. Mutually exclusive with `expiresAt`. |
| `expiresAt` | `integer` | No | Absolute expiry as a millisecond timestamp. Mutually exclusive with `expiresIn`. |
| `maxViews` | `integer` | No | Maximum view count. |
| `maxDownloads` | `integer` | No | Maximum download count. |
| `allowPreview` | `boolean` | No | Allow previews. Defaults to `true`. |
| `allowDownload` | `boolean` | No | Allow downloads. Defaults to `true`. |
| `requireLogin` | `boolean` | No | Restrict the share to logged-in users. Defaults to `false`. |
| `allowedUsers` | `array` | No | Usernames allowed to open the share, up to 50. Unknown usernames are rejected. |

#### Response

Returns the short share ID, the public link, and the item list with status `201`.

```json
{
  "success": true,
  "data": {
    "share": {
      "id": "abc123",
      "url": "https://{domain}/share/abc123",
      "title": "2 items",
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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | Not logged in. | Log in first. |
| `VALIDATION_ERROR` | `400` | Invalid share parameters (including an item count outside 1..50). | Fix the parameters and retry. |
| `FORBIDDEN` | `403` | Missing the `share` permission. | Check the permission rules. |
| `NOT_FOUND` | `404` | An item or its mount does not exist. | Verify the item identifiers. |

#### Example

```sh
curl -X POST https://{domain}/api/shares/ \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"fileIds":["file-uuid","folder-uuid"],"password":"share-pass","expiresIn":604800}'
```

### List my shares

Returns the shares created by the current user with pagination.

`GET /api/shares/?page={page}&limit={limit}&status={status}`

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | No | The page number. Defaults to `1`. |
| `limit` | `integer` | No | Items per page. Defaults to `20`, maximum `100`. |
| `status` | `string` | No | `active`, `expired`, or `revoked`. |

#### Response

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "abc123",
        "title": "2 items",
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

This list is the **creator's view**: it is the only place that returns `password` (the plaintext access password, used by "view password" and "copy link with password"); public endpoints never return the plaintext or the ciphertext. Entries with no password, a missing ciphertext, or a failed decryption simply omit the field.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | No logged-in session. | Log in first. |

#### Example

```sh
curl "https://{domain}/api/shares/?status=active" -b cookies.txt
```

### Get share information

Returns public share information without requiring a login. When the share is password-protected, the response includes `requiresPassword: true`, an empty `items` array, and `allowPreview` / `allowDownload` set to `false` until the visitor verifies the password.

`GET /api/shares/{id}`

The query parameter `?password={plaintext}` serves "share links with the password built in": a correct password returns the content directly (equivalent to a completed verification), and a wrong one returns `401 INVALID_PASSWORD`. Public responses never contain the password plaintext or ciphertext.

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The share id. |

#### Response

For a share without a password, or after password verification:

```json
{
  "success": true,
  "data": {
    "share": {
      "id": "abc123",
      "title": "2 items",
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

Each item is a `FileListItem` plus `rootId` (the item's identifier within the share). For a password-protected share that is not yet verified, `items` is empty, `allowPreview` and `allowDownload` are `false`, and `requiresPassword` is `true`.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The share does not exist. | Confirm the share id. |
| `LOGIN_REQUIRED` | `401` | The share is limited to logged-in or named users. | Log in first. |
| `FORBIDDEN` | `403` | The current user is not in the allowed user list. | Ask the creator. |
| `SHARE_REVOKED` | `410` | The share link no longer works. | Ask the creator for a new link. |
| `SHARE_EXPIRED` | `410` | The share expired. | Ask the creator for a new link. |
| `SHARE_LIMIT_REACHED` | `410` | The share reached its view limit. | Ask the creator to raise the limit. |

#### Example

```sh
curl https://{domain}/api/shares/abc123
```

### Browse a shared folder

Lists a directory inside one of the share's folder items by relative path. `root` must be a folder item of this share; `sub` is a path relative to that root folder, and escaping the root subtree returns `403`.

`GET /api/shares/{id}/list?root={itemId}&sub={path}`

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `root` | `string` | Yes | The `file_id` of a folder item in this share. |
| `sub` | `string` | No | Path relative to the root folder. Defaults to `/`. |

#### Response

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

`path` is the normalized relative path; every listed item carries the requested root folder item as its `rootId`.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | `root` is missing or is not a folder item. | Pass the `file_id` of a folder item. |
| `FORBIDDEN` | `403` | `root` is outside this share, or `sub` escapes the root subtree. | Verify the item identifier and relative path. |
| `NOT_FOUND` | `404` | The share or the target directory does not exist. | Verify the share id and path. |
| `INVALID_PASSWORD` | `401` | The password is not verified yet. | Call the verify endpoint first. |
| `SHARE_REVOKED` / `SHARE_EXPIRED` / `SHARE_LIMIT_REACHED` | `410` | The share is unavailable or over its limit. | Ask the creator for a new link. |

#### Example

```sh
curl "https://{domain}/api/shares/abc123/list?root=folder-uuid&sub=/albums" -b cookies.txt
```

### Verify a share password

Verifies the share password. The password is sent in the request body, never in the URL. On success the endpoint sets a short-lived HttpOnly cookie, so subsequent requests to the share do not need the password again.

`POST /api/shares/{id}/verify`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The share id. |

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `password` | `string` | Yes | The share password. |

#### Response

```json
{
  "success": true,
  "data": { "authorized": true },
  "timestamp": 1710000000000
}
```

The endpoint also sets a `share_auth_{id}` cookie that is valid for 15 minutes.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The share does not exist. | Confirm the share id. |
| `SHARE_EXPIRED` | `410` | The share expired. | Ask the creator for a new link. |
| `INVALID_PASSWORD` | `401` | The password is wrong. | Re-enter the password. |

#### Example

```sh
curl -X POST https://{domain}/api/shares/abc123/verify \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"password":"share-pass"}'
```

### Get a share download link

Returns a single-use gateway download URL for one file in the share. The download count increments only when the gateway consumes the token. `itemId` may be a share item or a descendant file of one of the share's folder items.

`GET /api/shares/{id}/download?itemId={itemId}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The share id. |

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `itemId` | `string` | No | Identifier of the target file or of a descendant of a folder item. Defaults to the share's first item. |

#### Response

```json
{
  "success": true,
  "data": { "url": "https://{domain}/api/gateway/download/{token}", "expiresIn": 900 },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The share does not exist, or `itemId` is outside the share scope. | Confirm the share id and item identifier. |
| `SHARE_REVOKED` | `410` | The share is not active. | Ask the creator for a new link. |
| `SHARE_EXPIRED` | `410` | The share expired. | Ask the creator for a new link. |
| `FORBIDDEN` | `403` | The share does not allow downloads. | Ask the creator to enable downloads. |
| `VALIDATION_ERROR` | `400` | `itemId` points at a folder item. | Use the folder browsing endpoint instead. |
| `INVALID_PASSWORD` | `401` | The password is not verified. | Call the verify endpoint first. |
| `SHARE_LIMIT_REACHED` | `410` | The share reached its download limit. | Ask the creator to raise the limit. |

#### Example

```sh
curl "https://{domain}/api/shares/abc123/download?itemId=file-uuid" -b cookies.txt
```

### Preview a shared file

Streams the shared image directly with `Content-Disposition: inline` when the share allows preview. Returns binary image data, not JSON. `itemId` follows the same scope rules as downloads.

`GET /api/shares/{id}/preview?itemId={itemId}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The share id. |

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `itemId` | `string` | No | Identifier of the target file or of a descendant of a folder item. Defaults to the share's first item. |

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The share does not exist, or `itemId` is outside the share scope. | Confirm the share id and item identifier. |
| `SHARE_EXPIRED` | `410` | The share is not active. | Ask the creator for a new link. |
| `FORBIDDEN` | `403` | The share does not allow preview. | Ask the creator to enable preview. |
| `VALIDATION_ERROR` | `400` | `itemId` points at a folder item. | Use the folder browsing endpoint instead. |
| `INVALID_PASSWORD` | `401` | The password is not verified. | Call the verify endpoint first. |

#### Example

```sh
curl "https://{domain}/api/shares/abc123/preview?itemId=file-uuid" -o photo.jpg
```

### Revoke a share

Revokes a share. Only the share creator can revoke it.

`DELETE /api/shares/{id}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The share id. |

#### Response

Returns `data: null` on success.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | No logged-in session. | Log in first. |
| `NOT_FOUND` | `404` | The share does not exist or belongs to another user. | Confirm the share id. |

#### Example

```sh
curl -X DELETE https://{domain}/api/shares/abc123 \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

## Users

User endpoints read and update the current user's settings, password, and email.

### Get user settings

Returns the profile, appearance, and quota of the current user.

`GET /api/users/me/settings`

#### Response

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The user does not exist. | Log in with a valid account. |

#### Example

```sh
curl https://{domain}/api/users/me/settings -b cookies.txt
```

### Update user settings

Updates the profile and appearance of the current user.

`PUT /api/users/me/settings`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `displayName` | `string` | No | The display name, at most 100 characters. Use `null` to clear. |
| `avatarUrl` | `string` | No | An avatar URL, at most 1000 characters. Use `null` to clear. |
| `locale` | `string` | No | `zh-CN` or `en-US`. |
| `theme` | `string` | No | `light`, `dark`, or `system`. |
| `defaultPath` | `string` | No | The default directory, starting with `/`. |

#### Response

```json
{
  "success": true,
  "data": { "message": "已保存" },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | A setting is invalid, or `defaultPath` does not start with `/`. | Correct the setting and retry. |

#### Example

```sh
curl -X PUT https://{domain}/api/users/me/settings \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"displayName":"Alice","theme":"dark","defaultPath":"/drive"}'
```

### Change the password

Changes the password of the current user. The change revokes all existing sessions, so the user must log in again.

`PUT /api/users/me/password`

The body accepts an optional `emailCode`: when the account has an email **and** the site has mail enabled, changing the password requires a 6-digit code obtained from the endpoint below (wrong/expired/used code → `400 INVALID_OTP`; five wrong attempts invalidate it). When mail is not configured or the account has no email the check is skipped and only the current password is verified (users are never locked out). Codes are single-use and valid for 5 minutes.

### Send a password-change code

`POST /api/users/me/password/send-code` (signed in) → `{ "success": true, "expiresIn": 300 }`; `400` when the account has no email or mail is disabled; `500 MAIL_ERROR` when sending fails.

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `oldPassword` | `string` | Yes | The current password. |
| `newPassword` | `string` | Yes | The new password, at least 8 characters. |

#### Response

```json
{
  "success": true,
  "data": { "message": "密码已修改，请重新登录" },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The new password is shorter than 8 characters. | Choose a longer password. |
| `INVALID_PASSWORD` | `401` | The current password is wrong. | Re-enter the old password. |

#### Example

```sh
curl -X PUT https://{domain}/api/users/me/password \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"oldPassword":"secret-pass","newPassword":"new-pass-123"}'
```

### Send an email verification code

Sends a 6-digit verification code to the given email. The code is valid for 5 minutes. The site must enable email service.

`POST /api/users/me/email/send-otp`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `email` | `string` | Yes | The email address to verify. |

#### Response

```json
{
  "success": true,
  "data": { "success": true, "expiresIn": 300 },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The email is invalid or already used by another account. | Use a different email. |
| `MAIL_ERROR` | `500` | The email service failed to send the code. | Try again later or contact the administrator. |

#### Example

```sh
curl -X POST https://{domain}/api/users/me/email/send-otp \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"email":"new@example.com"}'
```

### Verify an email code

Verifies the 6-digit code and updates the user email. After 5 wrong attempts, the code stops working.

`POST /api/users/me/email/verify-otp`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `email` | `string` | Yes | The email address to verify. |
| `code` | `string` | Yes | The 6-digit code from the email. |

#### Response

```json
{
  "success": true,
  "data": { "success": true },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The code is invalid, expired, or has too many failed attempts. | Send a new code and retry. |

#### Example

```sh
curl -X POST https://{domain}/api/users/me/email/verify-otp \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"email":"new@example.com","code":"123456"}'
```

## User access rules

Users can grant or deny `read`/`download` permission on a **single file** to other users. The creator needs the `can_grant` capability. Rules join permission evaluation with `user` origin (sorted below admin rules, above system-synthesized rules), and `deny` always overrides a same-path `allow`.

### List my access rules

Returns every rule the current user created with `user` origin.

`GET /api/users/rules`

#### Response

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

### Create an access rule

`POST /api/users/rules`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `itemId` | `string` | Yes | The file identifier; the rule derives its `pathPattern` from the file's full path. |
| `effect` | `string` | Yes | `allow` or `deny`. |
| `targetUserId` | `string` | No | The target user ID; pair with `allUsers` (exactly one of the two). |
| `allUsers` | `boolean` | No | `true` targets every signed-in user. |
| `permissions` | `string[]` | Yes | At least one of `read`, `download`; write permissions are not supported. |

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `FORBIDDEN` | `403` | The account lacks `can_grant`, or the target user does not exist. | Check the capability and target. |
| `VALIDATION_ERROR` | `400` | The subject, permission set, or file state is invalid. | Correct the fields and retry. |

### Revoke an access rule

Only `user`-origin rules you created yourself can be revoked here; admin rules are managed in the admin panel.

`DELETE /api/users/rules/{id}`

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `FORBIDDEN` | `403` | The rule was not created by you, or it is an admin rule. | Use the admin panel. |
| `NOT_FOUND` | `404` | The rule does not exist. | Confirm the rule ID. |

## API keys

API key endpoints create, list, and revoke keys. Keys authenticate PicGo, PicList, scripts, and WebDAV clients. A user can have up to 20 active keys.

### Create an API key

Creates an API key. The full token is shown only once, so store it before you close the response. The server stores only a SHA-256 hash of the token.

`POST /api/keys/`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | Yes | A label for the key, at most 100 characters. |
| `permissions` | `array` | Yes | `read`, `write`, or `delete`. At least one permission. |
| `protocols` | `array` | Yes | `webdav` or `api`. At least one protocol. |
| `uploadPath` | `string` | No | The upload root for writes. Defaults to `/uploads`. Normalized; the server rejects paths containing `..` or `~`. |
| `allowedIps` | `array` | No | An IP whitelist. The server rejects requests from other IPs. |
| `expiresIn` | `integer` | No | The key lifetime in seconds, at least 60. |

#### Response

Returns the key and ready-to-use client configuration with status `201`.

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | A request field is invalid. | Correct the field and retry. |
| `FORBIDDEN` | `403` | The user already has 20 active keys, or the upload path is invalid. | Revoke an old key or fix the path. |

#### Example

```sh
curl -X POST https://{domain}/api/keys/ \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"name":"picgo","permissions":["write"],"protocols":["api"],"uploadPath":"/uploads"}'
```

### List API keys

Lists the keys of the current user without the secret.

`GET /api/keys/`

#### Response

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

#### Example

```sh
curl https://{domain}/api/keys/ -b cookies.txt
```

### Get key permission rules

Returns the path rules that apply to the current user's keys. Use this endpoint for display and debugging.

`GET /api/keys/rules`

#### Response

```json
{
  "success": true,
  "data": { "rules": [] },
  "timestamp": 1710000000000
}
```

#### Example

```sh
curl https://{domain}/api/keys/rules -b cookies.txt
```

### Revoke an API key

Revokes a key so it can no longer authenticate.

`DELETE /api/keys/{id}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | The key identifier. |

#### Response

Returns `data: null` on success.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The key does not exist or belongs to another user. | Confirm the key identifier. |

#### Example

```sh
curl -X DELETE https://{domain}/api/keys/{id} \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

## Admin

Admin endpoints manage users, shares, files, logs, settings, announcements, storage providers, mounts, and permission rules. All of them require an administrator session.

### Get the dashboard

Returns aggregate statistics, recent activity, and the request count for the last 24 hours.

`GET /api/admin/dashboard`

#### Response

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

#### Example

```sh
curl https://{domain}/api/admin/dashboard -b cookies.txt
```

### Get statistics

Returns user, file, and storage statistics.

`GET /api/admin/stats`

#### Response

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

#### Example

```sh
curl https://{domain}/api/admin/stats -b cookies.txt
```

### Manage users

Lists, updates, and deletes users.

`GET /api/admin/users?page={page}&limit={limit}&role={role}&status={status}&search={search}`

`PUT /api/admin/users/{id}`

`DELETE /api/admin/users/{id}`

#### List query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | No | The page number. Defaults to `1`. |
| `limit` | `integer` | No | Items per page. Defaults to `20`, maximum `100`. |
| `role` | `string` | No | Filter by role. |
| `status` | `string` | No | Filter by status. |
| `search` | `string` | No | A keyword to match users. |

#### Update request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `role` | `string` | No | `admin`, `user`, or `guest`. |
| `status` | `string` | No | `active`, `disabled`, or `banned`. Disabling or banning revokes the user sessions. |
| `defaultPath` | `string` | No | The default directory, starting with `/`. |
| `maxStorage` | `integer` | No | The storage quota in bytes. |
| `maxFiles` | `integer` | No | The file-count quota. |
| `capabilities` | `string[]` | No | Capability bits, replaced wholesale: `can_publish`, `can_share`, `can_grant`. |

#### List response

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | A user parameter is invalid, or the request tries to delete the own account. | Correct the parameter. |
| `NOT_FOUND` | `404` | The user does not exist. | Confirm the user id. |

#### Example

```sh
curl "https://{domain}/api/admin/users?role=user&limit=20" -b cookies.txt

curl -X PUT https://{domain}/api/admin/users/{id} \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"role":"admin","status":"active"}'
```

### Manage shares

Lists all shares and revokes any share.

`GET /api/admin/shares?page={page}&limit={limit}&status={status}`

`GET /api/admin/shares/{id}` (admin share details: creator username, status, limits, switches, password protection, and the `items` list) and `PATCH /api/admin/shares/{id}` (admin edit: `status`, `expiresAt`, `maxViews`, `maxDownloads`, `allowPreview`, `allowDownload`, `requireLogin`, `allowedUsers`, `password` — a non-empty password resets it, writing both the hash and the ciphertext, while `null` or an empty string clears it).

`DELETE /api/admin/shares/{id}`

#### List query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | No | The page number. Defaults to `1`. |
| `limit` | `integer` | No | Items per page. Defaults to `20`, maximum `100`. |
| `status` | `string` | No | Filter by share status. |

#### List response

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "abc123",
        "title": "2 items",
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

#### Example

```sh
curl "https://{domain}/api/admin/shares?status=active" -b cookies.txt

curl -X DELETE https://{domain}/api/admin/shares/abc123 \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

### List all files

Searches every file across all mounts; results carry visibility and review status columns.

`GET /api/admin/files?page={page}&limit={limit}&search={search}`

#### List query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | No | The page number. Defaults to `1`. |
| `limit` | `integer` | No | Items per page. Defaults to `20`, maximum `100`. |
| `search` | `string` | No | A keyword to match file names. |

#### Response

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

#### Example

```sh
curl "https://{domain}/api/admin/files?search=photo" -b cookies.txt
```

### Review public files

Approves or rejects public files waiting for review, and can directly adjust any file's visibility; visibility changes on folders cascade to everything inside.

`PATCH /api/admin/files/{id}/review`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `status` | `string` | No | The review outcome: `approved`, `rejected`, or `pending`. |
| `visibility` | `string` | No | The target visibility: `private`, `users`, or `public`. |

Pass at least one of the two fields. Changes are written to the `review` and `visibility_change` audit logs.

#### Example

```sh
curl -X PATCH https://{domain}/api/admin/files/{id}/review \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"status":"approved"}'
```

### Read access logs

Returns access logs with pagination and filtering.

`GET /api/admin/logs?page={page}&limit={limit}&userId={userId}&action={action}&search={search}&from={from}&to={to}`

#### List query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `page` | `integer` | No | The page number. Defaults to `1`. |
| `limit` | `integer` | No | Items per page. Defaults to `50`, maximum `200`. |
| `userId` | `string` | No | Filter by user. |
| `action` | `string` | No | Filter by action, such as `upload` or `download`. |
| `search` | `string` | No | A keyword to match log content. |
| `from` | `integer` | No | Start time in milliseconds. |
| `to` | `integer` | No | End time in milliseconds. |

#### Response

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

#### Example

```sh
curl "https://{domain}/api/admin/logs?action=upload&limit=50" -b cookies.txt
```

### Manage system settings

Reads and updates the global site settings, including registration, email, rate limits, and Turnstile.

`GET /api/admin/settings`

`PATCH /api/admin/settings`

#### Update request body

All fields are optional.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `siteTitle` | `string` | No | The site title. |
| `siteLogo` | `string` | No | The site logo URL. |
| `siteFavicon` | `string` | No | The favicon URL. |
| `allowRegistration` | `boolean` | No | Allow new user registration. |
| `allowGuestAccess` | `boolean` | No | Allow guest access. |
| `requireEmailVerification` | `boolean` | No | Require email verification on registration. |
| `enableTurnstile` | `boolean` | No | Enable Cloudflare Turnstile. |
| `turnstileSiteKey` | `string` | No | The Turnstile site key. |
| `rateLimitEnabled` | `boolean` | No | Enable rate limiting. |
| `rateLimitRequestsPerMinute` | `integer` | No | Requests per minute, 1 to 10000. Takes effect in production only: the value applies per IP, signed-in users get ×2, auth endpoints such as sign-in and sign-up are fixed at 5 per minute, and free mode allows 60 per session and 120 per user per minute. |
| `maxConcurrentTransfers` | `integer` | No | Maximum concurrent transfers, 0 to 1000, default 4, where `0` means unlimited. Caps in-flight requests per user (per IP when signed out) across every upload channel and the download gateway, and returns `429 CONCURRENCY_LIMIT_EXCEEDED` beyond it. |
| `rateLimitDownloadsPerMinute` | `integer` | No | Download rate limit, 0 to 100000, default 120, where `0` means unlimited. Caps download-type requests per minute per user (per IP when signed out) — download gateway, share download/preview, file download links, and public directory direct links — and returns `429 RATE_LIMIT_EXCEEDED` beyond it. |
| `smtpHost` | `string` | No | The SMTP host. |
| `smtpPort` | `integer` | No | The SMTP port. |
| `smtpSecure` | `boolean` | No | Use a secure SMTP connection. |
| `smtpUser` | `string` | No | The SMTP user. |
| `smtpPassword` | `string` | No | The SMTP password. Pass `"******"` or an empty string to keep the current password. |
| `smtpFromName` | `string` | No | The sender name. |
| `smtpFromEmail` | `string` | No | The sender email. |
| `emailEnabled` | `boolean` | No | Enable email service. |

#### Example

```sh
curl -X PATCH https://{domain}/api/admin/settings \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"siteTitle":"My Picumet","rateLimitRequestsPerMinute":60}'
```

### Send a test email

Sends a test email through the configured SMTP service.

`POST /api/admin/settings/test-email`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `to` | `string` | Yes | The recipient email address. |

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The email is invalid or SMTP is not configured. | Configure SMTP first. |
| `MAIL_ERROR` | `500` | The email service failed. | Check the SMTP configuration. |

#### Example

```sh
curl -X POST https://{domain}/api/admin/settings/test-email \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"to":"admin@example.com"}'
```

### Manage announcements

Lists, creates, updates, and deletes announcements.

`GET /api/admin/announcements`

`POST /api/admin/announcements`

`PUT /api/admin/announcements/{id}`

`DELETE /api/admin/announcements/{id}`

#### Create request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `title` | `string` | Yes | The announcement title, at most 200 characters. |
| `content` | `string` | Yes | The announcement content, at most 5000 characters. |
| `level` | `string` | No | `info`, `warning`, or `danger`. |
| `expiresIn` | `integer` | No | The announcement lifetime in seconds, at least 60. |

#### Example

```sh
curl -X POST https://{domain}/api/admin/announcements \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"title":"Maintenance","content":"Downtime on Saturday","level":"warning"}'
```

### Manage storage providers

Lists, creates, updates, tests, and deletes storage providers. The server stores credentials encrypted.

`GET /api/admin/storage/providers`

`POST /api/admin/storage/providers`

`PUT /api/admin/storage/providers/{id}`

`POST /api/admin/storage/providers/{id}/test`

`DELETE /api/admin/storage/providers/{id}`

#### Create request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | Yes | A label for the provider. |
| `type` | `string` | No | `r2` or `s3` (`oracle` is folded into `s3`). When omitted it is derived from `endpoint`: empty means the R2 binding, non-empty means the S3 protocol. |
| `endpoint` | `string` | No | The S3 endpoint. Leave empty for a bound R2 provider. Public http(s) addresses only. `endpoint`, `accessKeyId`, and `secretAccessKey` must be provided together or left empty together. |
| `region` | `string` | No | The region. Defaults to `auto` for R2. |
| `bucket` | `string` | Yes | The bucket name. |
| `accessKeyId` | `string` | No | The access key. Leave empty for a bound R2 provider. |
| `secretAccessKey` | `string` | No | The secret key. Leave empty for a bound R2 provider. |
| `publicDomain` | `string` | No | A public CDN domain for direct URLs. |
| `pathPrefix` | `string` | No | A prefix applied to object keys. |

#### Test response

```json
{
  "success": true,
  "data": { "connected": true, "message": "ok" },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The endpoint fails SSRF checks or a field is invalid. | Use a public endpoint or correct the field. |
| `NOT_FOUND` | `404` | The provider does not exist. | Confirm the provider id. |
| `OPERATION_FAILED` | `409` | The provider still has mounts. | Delete the mounts first. |

#### Example

```sh
curl -X POST https://{domain}/api/admin/storage/providers \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"name":"R2","type":"r2","bucket":"my-bucket"}'
```

### Manage mounts

Lists, creates, updates, and deletes mount points that bind a provider to a virtual path.

`GET /api/admin/mounts`

`POST /api/admin/mounts`

`PUT /api/admin/mounts/{id}`

`DELETE /api/admin/mounts/{id}`

#### Create request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `providerId` | `string` | Yes | The storage provider id. |
| `mountPath` | `string` | Yes | The virtual path, such as `/drive`. |
| `name` | `string` | Yes | A display name. |
| `sortBy` | `string` | No | The default sort field. |
| `sortOrder` | `string` | No | `asc` or `desc`. |
| `priority` | `integer` | No | The mount priority. Higher values win for overlapping paths. |

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The provider does not exist or a field is invalid. | Correct the input. |
| `OPERATION_FAILED` | `409` | The mount still contains files. | Delete the files first. |

#### Example

```sh
curl -X POST https://{domain}/api/admin/mounts \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"providerId":"provider-uuid","mountPath":"/drive","name":"Drive"}'
```

### Manage permission rules

Lists, creates, updates, and deletes path-based permission rules. Each rule targets exactly one subject: a role, a user, or an API key.

`GET /api/admin/rules?page={page}&limit={limit}`

`POST /api/admin/rules`

`PUT /api/admin/rules/{id}`

`DELETE /api/admin/rules/{id}`

#### Create request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `pathPattern` | `string` | Yes | The path pattern, such as `/public/**`. |
| `effect` | `string` | Yes | `allow` or `deny`. |
| `mountId` | `string` | No | The mount this rule applies to. Empty means all mounts. |
| `role` | `string` | No | The role subject. Mutually exclusive with `userId` and `apiKeyId`. |
| `userId` | `string` | No | The user subject. Mutually exclusive with `role` and `apiKeyId`. |
| `apiKeyId` | `string` | No | The API key subject. Mutually exclusive with `role` and `userId`. |
| `permissions` | `array` | No | The permissions the rule grants, such as `["read","write"]`. |
| `requirePassword` | `boolean` | No | Require a password on the matched paths. |
| `password` | `string` | No | The plaintext password. The server stores only a hash. |
| `allowedIps` | `array` | No | An IP whitelist for the rule. |
| `priority` | `integer` | No | The rule priority. |

The list response masks `passwordHash` values.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The rule must specify exactly one of `role`, `userId`, or `apiKeyId`. | Set exactly one subject. |

#### Example

```sh
curl -X POST https://{domain}/api/admin/rules \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -d '{"pathPattern":"/public/**","effect":"allow","role":"guest","permissions":["read"]}'
```

## Free mode

Free-mode endpoints let an anonymous visitor use their own object-storage credentials in a temporary session. The server encrypts credentials and stores them in KV for a short TTL. The session endpoints require the `fm_token` cookie, and write operations require a session-level CSRF token.

### Initialize a free-mode session

Validates the storage endpoint, tests the connection, and starts a temporary session. Sets the `fm_token` cookie.

`POST /api/free-mode/init`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `endpoint` | `string` | Yes | The S3 endpoint. Public http(s) addresses only; the server rejects private or local addresses. |
| `region` | `string` | No | The region. |
| `bucket` | `string` | Yes | The bucket name. |
| `accessKeyId` | `string` | Yes | The access key. |
| `secretAccessKey` | `string` | Yes | The secret key. |
| `sessionHours` | `integer` | No | The session lifetime in hours, 1 to 8. Defaults to `1`. |

#### Response

Returns the session user, expiry, and a session-level CSRF token with status `201`.

```json
{
  "success": true,
  "data": {
    "user": { "id": "user-uuid", "username": "fm_ab12cd34", "role": "user", "defaultPath": "/" },
    "expiresAt": 1710003600000,
    "sessionHours": 1,
    "provider": { "type": "s3", "bucket": "my-bucket" },
    "csrfToken": "32-char-random-string"
  },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `VALIDATION_ERROR` | `400` | The endpoint is private or invalid, or a field is malformed. | Use a public endpoint and valid credentials. |
| `OPERATION_FAILED` | `400` | The storage connection test failed. | Check the credentials and endpoint. |

#### Example

```sh
curl -X POST https://{domain}/api/free-mode/init \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"endpoint":"https://s3.example.com","bucket":"my-bucket","accessKeyId":"AK","secretAccessKey":"SK","sessionHours":1}'
```

### List free-mode files

Lists the objects in the free-mode session root.

`GET /api/free-mode/files?path={path}`

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `path` | `string` | No | The directory prefix to list. Must stay inside the session root. |

#### Response

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

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | The session is missing or expired. | Initialize a new session. |
| `FORBIDDEN` | `403` | The path is outside the session root. | Use a path inside the root. |

#### Example

```sh
curl "https://{domain}/api/free-mode/files" -b cookies.txt
```

### Upload to free mode

Uploads a file to the free-mode session. The file must be 1 GB or smaller.

`POST /api/free-mode/upload?path={path}`

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `path` | `string` | No | The target directory prefix. |

#### Request headers

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `X-CSRF-Token` | `string` | Yes | The session CSRF token from the init response. |
| `X-File-Name` | `string` | Only for raw bodies | The file name, used when the body is not `multipart/form-data`. |

Use `multipart/form-data` with a `file` field, or send the raw file bytes with the `X-File-Name` header.

#### Response

Returns the object key and size with status `201`.

```json
{
  "success": true,
  "data": { "key": "photo.jpg", "size": 1048576 },
  "timestamp": 1710000000000
}
```

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | The session is missing or expired. | Initialize a new session. |
| `INVALID_CSRF` | `403` | The session CSRF token is wrong. | Use the token from the init response. |
| `VALIDATION_ERROR` | `400` | The file name or path is invalid. | Correct the input. |
| `PAYLOAD_TOO_LARGE` | `413` | The file exceeds 1 GB. | Use a smaller file. |
| `FORBIDDEN` | `403` | The target key is outside the session root. | Use a path inside the root. |

#### Example

```sh
curl -X POST "https://{domain}/api/free-mode/upload" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt \
  -F "file=@photo.jpg"
```

### Delete a free-mode object

Deletes an object from the free-mode session.

`DELETE /api/free-mode/object?key={key}`

#### Query parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `key` | `string` | Yes | The object key. Must stay inside the session root and contain no `..`, `~`, control characters, or backslashes. |

#### Response

Returns `data: null` on success.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `UNAUTHORIZED` | `401` | The session is missing or expired. | Initialize a new session. |
| `VALIDATION_ERROR` | `400` | The key is missing, too long, or contains illegal characters. | Correct the key. |
| `FORBIDDEN` | `403` | The key is outside the session root. | Use a key inside the root. |

#### Example

```sh
curl -X DELETE "https://{domain}/api/free-mode/object?key=photo.jpg" \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

### End a free-mode session

Ends the free-mode session and clears the `fm_token` cookie.

`POST /api/free-mode/logout`

#### Response

Returns `data: null` on success.

#### Example

```sh
curl -X POST https://{domain}/api/free-mode/logout \
  -H "X-CSRF-Token: {csrf_token}" \
  -b cookies.txt
```

## WebDAV

The WebDAV service exposes the file store to standard WebDAV clients. Every request authenticates with Basic auth using the API key pair: username `{key_id}`, password `{secret}`. The base URL is `https://{domain}/webdav`. All methods enforce path-level permissions, and write targets must stay inside the key's upload root.

### WebDAV methods

| Method | Description | Permission |
| :--- | :--- | :--- |
| `OPTIONS` | Announces DAV capabilities (`DAV: 1,2`). | None |
| `PROPFIND` | Lists a directory as an XML multistatus response. | `read` |
| `MKCOL` | Creates a folder. | `write`, inside the upload root |
| `PUT` | Uploads a file with a streaming body. | `write`, inside the upload root |
| `GET` / `HEAD` | Downloads a file or reads its information. | `read` |
| `DELETE` | Deletes a file or folder. | `delete` |
| `MOVE` | Moves or renames an entry. Uses the move Saga. | `delete` on source, `write` on target |

#### Example: list a directory

```sh
curl -X PROPFIND https://{domain}/webdav/ \
  -u "pk_xxx:sk_yyy" \
  -H "Depth: 1"
```

#### Example: upload a file

```sh
curl -X PUT https://{domain}/webdav/uploads/photo.jpg \
  -u "pk_xxx:sk_yyy" \
  -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg
```

#### Example: move an entry

```sh
curl -X MOVE https://{domain}/webdav/uploads/photo.jpg \
  -u "pk_xxx:sk_yyy" \
  -H "Destination: https://{domain}/webdav/uploads/renamed.jpg"
```

## Download gateway

The gateway streams an object after consuming a single-use download token. Tokens stay valid for 15 minutes, and the gateway consumes each token atomically, so concurrent requests cannot reuse a token.

### Download through the gateway

`GET /api/gateway/download/{token}`

#### Path parameters

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `token` | `string` | Yes | The single-use download token from a download or share endpoint. |

The gateway streams the object with the stored content type and an appropriate `Content-Disposition`. For password-protected files, the token must carry password verification. For shares, the gateway increments the download count once.

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `INVALID_TOKEN` | `401` | The token is invalid or expired. | Generate a new download link. |
| `PASSWORD_REQUIRED` | `403` | The file is password-protected and the token is not verified. | Verify the file password first. |
| `NOT_FOUND` | `404` | The file or object no longer exists. | Confirm the file still exists. |
| `SHARE_LIMIT_REACHED` | `410` | The share reached its download limit. | Ask the creator to raise the limit. |

#### Example

```sh
curl -L "https://{domain}/api/gateway/download/{token}" -o photo.jpg
```

## Public endpoints

Public endpoints require no authentication.

### Get public settings

Returns site-wide settings for the landing page and login screen.

`GET /api/public/settings`

#### Response

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

#### Example

```sh
curl https://{domain}/api/public/settings
```

### List active announcements

Returns the currently active announcements.

`GET /api/public/announcements`

#### Response

```json
{
  "success": true,
  "data": { "items": [{ "id": "announcement-uuid", "title": "Maintenance", "content": "Downtime on Saturday", "level": "warning" }] },
  "timestamp": 1710000000000
}
```

#### Example

```sh
curl https://{domain}/api/public/announcements
```

### Health checks

Returns service health. The liveness probe always reports `ok`. The readiness probe reports `503` with `ready: false` until the database seed completes.

`GET /api/public/health`

`GET /api/public/health/live`

`GET /api/public/health/ready`

#### Response

```json
{ "service": "picumet-api", "status": "ok", "ready": true, "detail": "seeded" }
```

#### Example

```sh
curl https://{domain}/api/public/health/ready
```

## Serve files from public paths

The API serves files directly from their public virtual path, for example `GET https://{domain}/drive/photos/photo.jpg`. This route runs after all API and WebDAV routes, so it never shadows them.

Files on a public mount serve with no authentication. Files on a private mount require a logged-in session with download permission, or a valid path signature (`?sign=`, see "Gateway access" below). Password-protected files return `403 PASSWORD_REQUIRED`. Paths that are not mounted, or that contain `..`, return `404`.

#### Example

```sh
curl "https://{domain}/drive/photos/photo.jpg" -o photo.jpg
```

## Public gallery

Files with `visibility=public` and an `approved` review status enter the public gallery, accessible anonymously. Listing, download links, and password verification require no login; the signed-in owner and admins download without a password. The public surface filters directly by visibility and review status and never consults path permission rules.

### Browse the public gallery

Returns approved public files with pagination. Only files are returned (no folders).

`GET /api/gallery?page={page}&limit={limit}`

#### Response

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

### Get a public file download link

Returns a single-use gateway download link (valid for 15 minutes). Password-protected files return `403 PASSWORD_REQUIRED`; verify the password first.

`GET /api/gallery/{id}/download`

#### Response

```json
{
  "success": true,
  "data": { "url": "https://{domain}/api/gateway/download/{token}", "expiresIn": 900 },
  "timestamp": 1710000000000
}
```

### Verify a public file's password

Verifies the access password anonymously and returns the same single-use gateway download link on success.

`POST /api/gallery/{id}/verify-password`

#### Request body

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `password` | `string` | Yes | The file's access password. |

#### Errors

| Error Code | HTTP Status | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `NOT_FOUND` | `404` | The file does not exist, is not public, or is not approved. | Check the file state. |
| `INVALID_PASSWORD` | `401` | The password is wrong. | Retry. |
| `VALIDATION_ERROR` | `400` | The file has no password. | Download directly. |

## Gateway access (S3 / Lsky / OpenList compatible)

> Gateway keys (formerly API keys) expose Picumet as a **relay surface** for S3/R2/Oracle/MinIO storage to external tools (PicGo/PicList, rclone, S3 SDKs); image-hosting uploads are just one use case.
> Keys declare their protocol surfaces via `protocols` at creation: `webdav` / `api` / `s3`. A key with a non-empty `protocols` list can only use the declared surfaces (an empty array allows all, for backward compatibility).
> **Data-layer owner isolation**: every file read/write/delete through a gateway key is scoped to the key owner (`owner_id`). Even a misconfigured path rule cannot touch another user's data. Directories (prefixes) are a shared namespace within the mount; writing a file whose path is occupied by another user returns `409 CONFLICT`.
> S3 gateway verification needs a reversible secret: it is stored AES-GCM-encrypted at key creation (migration `0006_s3_gateway.sql`). Legacy keys without that column get `InvalidAccessKeyId` on the S3 gateway — recreate the key. The create-key response `configs` now includes `s3` and `openlist` snippets.

### Lsky Pro V2 compatible upload

`POST /api/v1/upload`, authenticated with `Authorization: Bearer pk_*.sk_*` (a bare token is also accepted). multipart field `file`, optional `path` field (relative paths resolve against the key's upload-path template; absolute paths must stay inside the key's upload root). Path templates, upload-root boundaries, quota, overwrite semantics, and ancestor-folder rows behave exactly like `/api/upload`.

Success response (Lsky V2 contract; pick "Lsky Pro V2" in PicList):

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

Failure response: `{ "status": false, "message": "reason", "data": null }` (HTTP stays 200).

### OpenList / AList compatible endpoints (`/openlist` prefix)

Implements a subset of the AList v3 REST protocol. In PicList pick "AList" with url `https://{domain}/openlist` to get the built-in picbed experience (including delete-by-URL). The separate prefix exists because `/api/auth/login` is already used by Picumet's own login. Responses share the `{code, message, data}` envelope with `message` always `success` (clients check `code === 200`).

| Endpoint | Description |
| :--- | :--- |
| `POST /openlist/api/auth/login` | `{username: keyId, password: secret}` → `data.token = pk_*.sk_*` (no server-side session; the token is the key) |
| `PUT /openlist/api/fs/form` | multipart `file`; headers `Authorization: <bare token>` and `File-Path: encodeURIComponent(full virtual path)` |
| `POST /openlist/api/fs/list` | `{path, page?, per_page?}` → `data.content[{name,size,is_dir,modified}]` |
| `POST /openlist/api/fs/get` | `{path}` → `data.sign` (signature for the /d direct link), `data.is_dir`, etc. |
| `POST /openlist/api/fs/remove` | `{dir, names: [...]}` → delete (same semantics as WebDAV delete) |
| `GET /openlist/d{encodedPath}?sign=` | Direct download; anonymous on public mounts, signature-gated on private mounts |

### S3 compatible gateway (`/s3` prefix)

A SigV4-verified subset of the S3 REST protocol. Client configuration: endpoint = `https://{domain}/s3`, **path-style addressing (`forcePathStyle=true` / `pathStyleAccess`)**, any region (PicList sends the literal `auto`), `accessKeyId = pk_*`, `secretAccessKey = sk_*`.

**Bucket semantics**: bucket = first segment of the virtual path (mount path or the key's upload root, e.g. uploadPath=`/uploads` → bucket=`uploads`); key = the rest. `GET /s3` lists the buckets reachable by the key (top-level directory names).

| Operation | Request |
| :--- | :--- |
| PutObject | `PUT /s3/{bucket}/{key}` (full-body `x-amz-content-sha256` verification; `x-amz-meta-*` stored as object metadata) |
| GetObject | `GET /s3/{bucket}/{key}` (supports `Range` → 206) |
| HeadObject | `HEAD /s3/{bucket}/{key}` |
| DeleteObject | `DELETE /s3/{bucket}/{key}` (deleting a missing key still returns 204) |
| ListObjectsV2 | `GET /s3/{bucket}?list-type=2&prefix=&delimiter=/&max-keys=` |
| DeleteObjects | `POST /s3/{bucket}?delete` (XML body, up to 1000 keys) |
| ListBuckets | `GET /s3` |

Not implemented (returns `501 NotImplemented`): CopyObject, Multipart Upload, DeleteBucket. Requests skewed more than 15 minutes are rejected (`AccessDenied`). Presigned GET URLs are generated client-side and verified server-side via query parameters (`X-Amz-Expires` 1–604800 seconds).

### Direct-link signatures (`?sign=`)

File URLs returned by the compat upload / Lsky V2 / S3 flows:

- If the storage provider has a public domain (`public_domain`) configured → a CDN direct link is returned;
- Otherwise `{APP_BASE_URL}{virtualPath}?sign={expiresAt}.{hmac}` — path-serve allows an **anonymous GET of exactly that path** when the signature verifies (capability scope = that path). `expiresAt=0` means long-lived.

Signatures are decoupled from key lifecycle: revoking or recreating a gateway key never breaks already-issued direct links.

## What's next

- [System architecture](ARCHITECTURE.md) for the service design behind these endpoints.
- [Development guide](DEVELOPMENT.md) for running and testing the Workers codebase.
- [Deployment guide](DEPLOYMENT.md) for configuring bindings, secrets, and domains.
- [Frontend guide](UI.md) for the pages that consume this API.
- [Project overview](../README.md) and [progress tracking](PROGRESS.md).






