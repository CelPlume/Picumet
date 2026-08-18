# Uploads Service（上传服务）

**职责范围**：上传会话管理、单文件直传、分片上传、Worker 代理上传、配额预留/释放、完成校验（HEAD 防伪造）、幂等性保证。兼容 PicGo/PicList 上传。

## 目录结构

```
services/uploads/
├── handlers.ts    // 上传会话、代理上传、分片、完成、中止
├── compat.ts      // PicGo 兼容上传（Bearer API Key / multipart）
├── schemas.ts     // InitUploadSchema
└── types.ts
```

## 状态机

单文件：`pending → uploading → verifying → completed`（含 failed/expired/aborted）
分片：`pending → uploading → parts_uploaded → completing → completed`

## 依赖

- `permissions/principal.ts`、`storage/providers.ts`
- `db`（SessionRepo/QuotaRepo/FileRepo/MountRepo/ReconciliationRepo）
- `utils/path.ts`、`utils/crypto.ts`
