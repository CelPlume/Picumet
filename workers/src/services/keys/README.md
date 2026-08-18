# Keys Service（API 密钥服务）

**职责范围**：API 密钥创建（仅显示一次）、列表、撤销、权限规则查询。

## 目录结构

```
services/keys/
├── handlers.ts    // POST/GET/DELETE /api/keys、GET /api/keys/rules
├── schemas.ts     // CreateKeySchema
└── types.ts
```

## 安全要点（审计 M-3）

- `uploadPath` 规范化（拒绝 `..`/`~` 逃逸），作为密钥上传根边界
- 密钥 token 仅创建时显示一次；落库存 `sha256Hex` 哈希

## 依赖

- `db`（ApiKeyRepo/RuleRepo）、`utils/crypto.ts`、`utils/path.ts`
