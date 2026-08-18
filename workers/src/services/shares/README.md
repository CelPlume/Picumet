# Shares Service（分享服务）

**职责范围**：分享链接创建/列表/撤销、公开访问、密码验证、下载令牌（D1 原子消费）、分享访问日志、下载网关。

## 目录结构

```
services/shares/
├── handlers.ts    // 创建、列表、公开信息、下载、预览、撤销
├── gateway.ts     // /api/gateway/download/:token 流式代理
├── tokens.ts      // 下载令牌（D1 原子消费）
├── schemas.ts     // CreateShareSchema
└── types.ts
```

## 下载令牌（审计：D1 原子消费）

`consumeDownloadToken` 用 `DELETE ... RETURNING` 单条原子消费，一次性令牌不可被并发重复使用。

## 依赖

- `permissions/principal.ts`、`storage/providers.ts`
- `db`（ShareRepo/FileRepo/MountRepo/ProviderRepo/LogRepo）
- `utils/crypto.ts`（bcrypt/random）
