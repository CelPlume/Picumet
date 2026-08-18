# Users Service（用户设置服务）

**职责范围**：个人资料、外观偏好、默认路径、修改密码。

## 目录结构

```
services/users/
├── handlers.ts    // /me/settings GET/PUT、/me/password PUT
├── schemas.ts     // ProfileSchema / PasswordSchema
└── types.ts
```

## 依赖

- `db`（UserRepo/QuotaRepo）、`utils/crypto.ts`（verify/hashPassword）
