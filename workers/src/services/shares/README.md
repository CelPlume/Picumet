# Shares Service（分享服务）

**职责范围**：多项目分享链接创建/列表/撤销、公开访问、分享内目录浏览、密码验证、下载令牌（D1 原子消费）、分享访问日志、下载网关。

一次分享可包含 1..50 个项目（文件与文件夹混合，`share_items.sort_order` = 请求顺序）；`shares.file_id` 保留首个项目以维持单文件兼容语义。

## 目录结构

```
services/shares/
├── handlers.ts    // 创建、列表、公开信息、目录浏览、下载、预览、撤销
├── gateway.ts     // /api/gateway/download/:token 流式代理
├── tokens.ts      // 下载令牌（D1 原子消费）
├── schemas.ts     // CreateShareSchema
└── types.ts
```

## 项目作用域（下载/预览）

`ShareRepo.resolveShareFile` 判定目标文件是否在分享作用域内：分享项目自身命中；否则要求文件与某个文件夹项目「同挂载点 + 同属主 + 绝对路径在根子树内」（`isPathWithinBoundary` 路径段边界）。作用域外的 `itemId` 一律 `404`。

公开响应只下发 `FileListItem` 形态的项目视图（附 `rootId`），不下发 `physical_key` / `object_key`。

## 下载令牌（审计：D1 原子消费）

`consumeDownloadToken` 用 `DELETE ... RETURNING` 单条原子消费，一次性令牌不可被并发重复使用。

## 依赖

- `permissions/principal.ts`、`storage/providers.ts`
- `db`（ShareRepo/FileRepo/MountRepo/LogRepo）
- `utils/crypto.ts`（bcrypt/random）
