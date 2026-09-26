# Auth Service（认证服务）

**职责范围**：用户注册、登录、登出、JWT 令牌生成与验证、会话管理、邮箱验证、密码重置。

## 目录结构

```
services/auth/
├── handlers.ts    // 登录、注册、登出 handlers
├── schemas.ts     // RegisterSchema / LoginSchema
├── types.ts       // JwtPayload、请求类型
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录（Set-Cookie HttpOnly JWT） |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 当前用户信息 |
| GET | `/api/auth/csrf-token` | 获取 CSRF Token |
| GET | `/api/auth/verify-email` `/api/auth/verify` | 邮箱验证（别名） |
| POST | `/api/auth/forgot-password` | 找回密码 |
| POST | `/api/auth/reset-password` | 重置密码 |

## 依赖

- `middleware/auth.ts`（getDb）、`middleware/rate-limit.ts`、`middleware/csrf.ts`
- `utils/crypto.ts`（JWT/bcrypt）、`utils/ip.ts`（requestIp）、`utils/smtp.ts`、`db`（UserRepo/QuotaRepo/SettingsRepo/LogRepo）
