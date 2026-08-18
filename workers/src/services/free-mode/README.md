# Free-Mode Service（自由模式服务）

**职责范围**：用户自带对象存储凭据的临时会话（凭据加密写入 KV，短 TTL 自动清理）、文件列表、上传、删除、退出。

## 目录结构

```
services/free-mode/
├── handlers.ts    // init/files/upload/object/logout
├── schemas.ts     // FreeModeInitSchema
└── types.ts
```

## 安全要点（审计 H-1/H-2/M-1/M-2）

- 中间件 `middleware/free-mode.ts`：Origin + Sec-Fetch-Site 跨站防护、会话级 CSRF、IP+用户双层 fail-closed 限流
- 路径/文件名边界校验（拒绝 `..`/`~`/控制字符/反斜杠，`isPathWithinBoundary`）
- endpoint SSRF 校验（`validateEndpoint`）
- 凭据 AES-GCM 加密后写入 KV，不返回 auth_token（仅 fm_token sid）

## 依赖

- `middleware/free-mode.ts`、`storage/providers.ts`（S3Provider）
- `utils/crypto.ts`、`utils/ssrf.ts`、`utils/path.ts`
