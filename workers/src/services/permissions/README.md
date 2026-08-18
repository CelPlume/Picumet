# Permissions Service（权限服务）

**职责范围**：核心权限判定算法（`checkPermission`）、路径规则查询与匹配、主体（Principal）构造、权限校验。

## 目录结构

```
services/permissions/
├── check.ts       // ⭐ 核心权限判定算法 + 规则排序 + 规则加载
├── principal.ts   // 从 Hono Context 构造 Principal、requirePermission/can
└── types.ts       // 权限相关类型
```

## 核心算法优先级

1. 管理员特权
2. 挂载边界检查
3. 用户根路径限制
4. API 密钥权限范围
5. 路径规则（主体特异度 > 路径特异度 > 显式优先级 > effect）
6. 文件所有者权限回退
7. 默认拒绝

## 依赖

- `utils/path.ts`（isPathWithinBoundary/normalizePath/pathMatches）
- `db`（RuleRepo）
- `shared/errors.ts`
