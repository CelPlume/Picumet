# WebDAV Service（WebDAV 服务）

**职责范围**：WebDAV 协议实现（兼容 PicGo/PicList）：PROPFIND、GET/HEAD、PUT、DELETE、MKCOL、MOVE、OPTIONS。Basic 认证（API 密钥）。

## 目录结构

```
services/webdav/
├── handlers.ts    // WebDAV 方法 handlers
└── types.ts       // WebDAVResource / PropfindRequest
```

## 安全要点（审计 H-3/H-4）

- 全部方法接入 `permissions/principal.ts` 统一路径级权限服务（PROPFIND read / PUT write / DELETE delete）
- MOVE 复用 `files/move.ts` 移动 Saga，不直接改 file_metadata
- 写目标必须位于密钥上传根目录内（`assertWithinUploadRoot`）
- XML href 统一转义（`escapeXml`，防注入/破坏 XML）
- Basic 认证：`base64(keyId:secret)`

## 依赖

- `middleware/auth.ts`（apiKeyAuthMiddleware）、`permissions/principal.ts`
- `storage/providers.ts`、`files/move.ts`
- `utils/path.ts`、`utils/crypto.ts`
