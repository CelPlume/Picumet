# Files Service（文件管理服务）

**职责范围**：文件/文件夹列表、创建文件夹、文件详情、元数据更新（重命名）、删除、移动（Saga）、批量操作、密码验证、下载链接。

## 目录结构

```
services/files/
├── handlers.ts    // 列表、文件夹、详情、更新、密码验证、下载链接
├── operations.ts  // 删除、移动、批量操作、任务状态
├── move.ts        // 移动 Saga（复制→校验→原子切换→异步清理源）
├── schemas.ts     // Update/CreateFolder/Move/Batch/VerifyPassword
└── types.ts
```

## 移动 Saga（审计 H-4）

`moveWithSaga`：校验权限/冲突/循环 → 建任务 → 复制+校验 → 原子切换元数据 → 异步清理源对象。主文件 API 与 WebDAV MOVE 统一走此服务。

## 依赖

- `permissions/principal.ts`（requirePermission）
- `storage/providers.ts`（getProvider）
- `shares/tokens.ts`（下载令牌）
- `db`（FileRepo/MountRepo/ProviderRepo/LogRepo/JobRepo）
