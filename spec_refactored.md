# Picumet - 多云对象存储管理平台 规格说明书（服务化重构版）

**版本**: 3.0
**日期**: 2026-08-18
**状态**: Refactored
**维护者**: Picumet Team

**架构**: Service-Oriented Architecture (Plan A)

---

## 📋 目录

### 核心架构
1. [服务架构总览](#服务架构总览)
2. [共享基础设施](#共享基础设施)

### 业务服务
3. [认证服务 (Auth Service)](#认证服务-auth-service)
4. [权限服务 (Permissions Service)](#权限服务-permissions-service)
5. [文件管理服务 (Files Service)](#文件管理服务-files-service)
6. [上传服务 (Uploads Service)](#上传服务-uploads-service)
7. [分享服务 (Shares Service)](#分享服务-shares-service)
8. [存储服务 (Storage Service)](#存储服务-storage-service)
9. [WebDAV服务 (WebDAV Service)](#webdav服务-webdav-service)

### 支撑系统
10. [数据模型](#数据模型)
11. [安全威胁模型](#安全威胁模型)
12. [部署方案](#部署方案)
13. [术语表](#术语表)

---

## 服务架构总览

### 架构原则

**按业务领域拆分，而非技术层次**

```
workers/src/
├── services/                    # 核心业务服务（每个服务自包含）
│   ├── auth/                   # 认证服务
│   ├── permissions/            # 权限判定服务
│   ├── files/                  # 文件管理服务
│   ├── uploads/                # 上传服务
│   ├── shares/                 # 分享服务
│   ├── storage/                # 存储抽象层
│   └── webdav/                 # WebDAV服务
│
├── shared/                      # 共享代码
│   ├── schemas.ts              # 公共 Zod schemas
│   ├── types.ts                # 公共类型定义
│   ├── errors.ts               # 统一错误处理
│   └── response.ts             # 统一响应格式
│
├── middleware/                  # 中间件（保持不变）
│   ├── auth.ts
│   ├── csrf.ts
│   └── rate-limit.ts
│
├── db/                          # 数据访问层
│   ├── repos/
│   └── index.ts
│
└── index.ts                     # 路由组装（精简）
```

### 服务标准结构

每个服务目录包含：

```typescript
services/<service-name>/
├── handlers.ts         // API handlers（业务逻辑）
├── schemas.ts          // Zod 验证 schemas
├── types.ts            // TypeScript 类型定义
├── <domain>.ts         // 领域特定逻辑
└── README.md           // 服务文档
```

### 类型安全验证

**所有 API 输入必须通过 Zod 验证**

```typescript
// services/<service>/handlers.ts
import { zValidator } from '@hono/zod-validator';
import { RequestSchema } from './schemas';

export const handler = [
  zValidator('json', RequestSchema),
  async (c: Context) => {
    const body = c.req.valid('json'); // ✅ 类型已验证
    // 业务逻辑...
  }
];
```

### 服务间依赖关系

```
┌─────────────┐
│ Auth Service│────┐
└─────────────┘    │
                   ▼
┌─────────────┐  ┌──────────────────┐
│Files Service│─▶│Permissions Service│
└─────────────┘  └──────────────────┘
       │                 ▲
       ▼                 │
┌──────────────┐  ┌─────────────┐
│Upload Service│  │Share Service│
└──────────────┘  └─────────────┘
       │                 │
       └────────┬────────┘
                ▼
        ┌──────────────┐
        │Storage Service│
        └──────────────┘
```

**依赖规则**:
- 所有服务依赖 **Permissions Service**（权限检查）
- 所有文件操作依赖 **Storage Service**（存储抽象）
- **Auth Service** 独立，仅被其他服务调用
- 避免循环依赖

---

## 共享基础设施

### shared/types.ts

```typescript
// 主体类型
export type PrincipalType = 'user' | 'apiKey' | 'role';

export interface Principal {
  type: PrincipalType;
  id: string;
  role?: 'admin' | 'user' | 'guest';
  defaultPath?: string;
  allowedPermissions?: Permission[]; // API密钥专用
  apiKeyId?: string;
}

// 权限类型
export type Permission =
  | 'read'      // 查看文件列表和详情
  | 'write'     // 创建新文件/文件夹
  | 'update'    // 修改元数据、重命名
  | 'delete'    // 删除文件/文件夹
  | 'share'     // 创建分享链接
  | 'download'; // 下载文件内容

// 挂载点
export interface Mount {
  id: string;
  name: string;
  mountPath: string;
  providerId: string;
  sortBy: 'name' | 'time' | 'size' | 'manual';
  sortOrder: 'asc' | 'desc';
  status: 'active' | 'disabled';
}

// 文件元数据
export interface FileMetadata {
  id: string;
  mountId: string;
  objectKey: string;
  path: string;
  name: string;
  type: 'file' | 'folder';
  mimeType: string | null;
  size: number;
  etag: string | null;
  ownerId: string;
  accessPassword: string | null;
  customTitle: string | null;
  customColor: string | null;
  coverUrl: string | null;
  iconEmoji: string | null;
  manualPosition: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

// 条件
export interface Conditions {
  ip?: string;
  userAgent?: string;
  passwordVerified?: boolean;
  timestamp?: number;
}
```

### shared/errors.ts

```typescript
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    public message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message: string = '未授权'): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message: string = '无权限访问'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static notFound(message: string = '资源不存在'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, 'CONFLICT', message);
  }

  static internal(message: string = '服务器内部错误'): ApiError {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }
}
```

### shared/response.ts

```typescript
import type { Context } from 'hono';

export function ok<T>(
  c: Context,
  data: T,
  message?: string,
  status: number = 200
) {
  return c.json({
    success: true,
    data,
    message,
    timestamp: Date.now(),
  }, status);
}

export function error(
  c: Context,
  err: ApiError | Error,
  traceId?: string
) {
  if (err instanceof ApiError) {
    return c.json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        traceId,
      },
      timestamp: Date.now(),
    }, err.statusCode);
  }

  return c.json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误',
      traceId,
    },
    timestamp: Date.now(),
  }, 500);
}
```

### shared/schemas.ts

```typescript
import { z } from 'zod';

// 路径验证
export const PathSchema = z.string()
  .regex(/^\//, '路径必须以 / 开头')
  .max(2048, '路径长度不能超过2048');

// 文件名验证
export const FileNameSchema = z.string()
  .min(1, '文件名不能为空')
  .max(255, '文件名长度不能超过255')
  .regex(/^[^<>:"|?*\x00-\x1F]+$/, '文件名包含非法字符');

// 分页参数
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

// UUID验证
export const UUIDSchema = z.string().uuid('无效的UUID格式');

// 密码验证
export const PasswordSchema = z.string()
  .min(1, '密码不能为空')
  .max(128, '密码长度不能超过128');
```

---

## 认证服务 (Auth Service)

### 职责范围

- 用户注册、登录、登出
- JWT令牌生成与验证
- 会话管理
- 邮箱验证
- 密码重置

### 目录结构

```
services/auth/
├── handlers.ts         // 登录、注册、登出handlers
├── schemas.ts          // 验证schemas
├── jwt.ts              // JWT生成/验证逻辑
├── types.ts            // 类型定义
└── session.ts          // 会话管理
```

### schemas.ts

```typescript
import { z } from 'zod';

export const RegisterSchema = z.object({
  email: z.string().email('无效的邮箱地址').max(255),
  password: z.string().min(8, '密码至少8位').max(128),
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/),
});

export const LoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RegisterRequest = z.infer<typeof RegisterSchema>;
export type LoginRequest = z.infer<typeof LoginSchema>;
export type RefreshTokenRequest = z.infer<typeof RefreshTokenSchema>;
```

### jwt.ts

```typescript
import { SignJWT, jwtVerify } from 'jose';
import type { Principal } from '../../shared/types';

export interface JWTPayload {
  sub: string;              // user id
  email: string;
  role: 'admin' | 'user';
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
}

export async function generateAccessToken(
  user: { id: string; email: string; role: string },
  secret: string
): Promise<string> {
  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    role: user.role as 'admin' | 'user',
    type: 'access',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(secret));
}

export async function generateRefreshToken(
  userId: string,
  secret: string
): Promise<string> {
  const payload = {
    sub: userId,
    type: 'refresh',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 2592000, // 30 days
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(secret));
}

export async function verifyToken(
  token: string,
  secret: string
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(secret)
  );
  return payload as JWTPayload;
}

export function jwtToPrincipal(payload: JWTPayload): Principal {
  return {
    type: 'user',
    id: payload.sub,
    role: payload.role,
  };
}
```

### handlers.ts

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../../types';
import { RegisterSchema, LoginSchema, RefreshTokenSchema } from './schemas';
import { generateAccessToken, generateRefreshToken, verifyToken } from './jwt';
import { hashPassword, verifyPassword } from '../../utils/crypto';
import { UserRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { ok, error } from '../../shared/response';
import { ApiError } from '../../shared/errors';

export const authRoutes = new Hono<AppBindings>();

// 注册
authRoutes.post(
  '/register',
  zValidator('json', RegisterSchema),
  async (c) => {
    const db = getDb(c);
    const body = c.req.valid('json');

    // 检查邮箱是否已存在
    const existing = await UserRepo.findByEmail(db, body.email);
    if (existing) {
      throw ApiError.conflict('邮箱已被注册');
    }

    // 创建用户
    const hashedPassword = hashPassword(body.password);
    const user = await UserRepo.create(db, {
      email: body.email,
      username: body.username,
      passwordHash: hashedPassword,
      role: 'user',
      emailVerified: false,
    });

    // 生成令牌
    const accessToken = await generateAccessToken(user, c.env.JWT_SECRET);
    const refreshToken = await generateRefreshToken(user.id, c.env.JWT_SECRET);

    return ok(c, {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
      accessToken,
      refreshToken,
    }, '注册成功', 201);
  }
);

// 登录
authRoutes.post(
  '/login',
  zValidator('json', LoginSchema),
  async (c) => {
    const db = getDb(c);
    const body = c.req.valid('json');

    // 查找用户
    const user = await UserRepo.findByEmail(db, body.email);
    if (!user) {
      throw ApiError.unauthorized('邮箱或密码错误');
    }

    // 验证密码
    if (!verifyPassword(body.password, user.passwordHash)) {
      throw ApiError.unauthorized('邮箱或密码错误');
    }

    // 生成令牌
    const accessToken = await generateAccessToken(user, c.env.JWT_SECRET);
    const refreshToken = await generateRefreshToken(user.id, c.env.JWT_SECRET);

    return ok(c, {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
      accessToken,
      refreshToken,
    }, '登录成功');
  }
);

// 刷新令牌
authRoutes.post(
  '/refresh',
  zValidator('json', RefreshTokenSchema),
  async (c) => {
    const db = getDb(c);
    const body = c.req.valid('json');

    // 验证refresh token
    const payload = await verifyToken(body.refreshToken, c.env.JWT_SECRET);
    if (payload.type !== 'refresh') {
      throw ApiError.unauthorized('无效的刷新令牌');
    }

    // 查找用户
    const user = await UserRepo.findById(db, payload.sub);
    if (!user) {
      throw ApiError.unauthorized('用户不存在');
    }

    // 生成新的access token
    const accessToken = await generateAccessToken(user, c.env.JWT_SECRET);

    return ok(c, { accessToken }, '令牌刷新成功');
  }
);

// 登出（可选：加入黑名单）
authRoutes.post('/logout', async (c) => {
  // 简单实现：客户端删除token
  // 完整实现：将token加入Redis黑名单
  return ok(c, null, '登出成功');
});
```

---

## 权限服务 (Permissions Service)

### 职责范围

- **核心权限判定算法**（`checkPermission`）
- 路径规则查询与匹配
- 权限规则CRUD（管理员功能）
- 文件所有者权限判定

### 目录结构

```
services/permissions/
├── handlers.ts         // 权限规则CRUD API
├── schemas.ts          // 规则验证schemas
├── check.ts            // ⭐ 核心权限判定算法
├── rules.ts            // 规则查询与匹配
└── types.ts            // 权限相关类型
```

### types.ts

```typescript
import type { Permission, Principal, Mount, Conditions } from '../../shared/types';

export interface PathRule {
  id: string;
  mountId: string;
  pathPattern: string;       // '/images/**'
  userId: string | null;     // 用户特定规则
  role: string | null;       // 角色规则
  apiKeyId: string | null;   // API密钥规则
  permissions: Permission[]; // 允许的操作
  effect: 'allow' | 'deny';
  priority: number;          // 显式优先级
  requirePassword: boolean;
  allowedIps: string[] | null;
  status: 'active' | 'disabled';
  createdAt: number;
}

export type PermissionCheckResult = 'allow' | 'deny';
```

### check.ts - 核心权限判定算法

```typescript
import type { Principal, Mount, Permission, Conditions } from '../../shared/types';
import type { PathRule, PermissionCheckResult } from './types';
import { findMatchingRules } from './rules';
import { normalizePath, isPathWithinBoundary } from '../../utils/path';

/**
 * 核心权限判定函数
 *
 * 优先级从高到低：
 * 1. 管理员特权
 * 2. 挂载边界检查
 * 3. 用户根路径限制
 * 4. 路径规则（主体特异度 > 路径特异度 > 优先级 > effect）
 * 5. 文件所有者权限
 * 6. 默认拒绝
 */
export async function checkPermission(
  db: D1Database,
  principal: Principal,
  mount: Mount,
  canonicalPath: string,
  action: Permission,
  fileOwnerId?: string,
  conditions?: Conditions
): Promise<PermissionCheckResult> {
  // 1. 管理员特权（最高优先级，绕过所有检查）
  if (principal.role === 'admin') {
    return 'allow';
  }

  // 2. 挂载边界检查（安全边界，不可绕过）
  if (!isPathWithinBoundary(canonicalPath, mount.mountPath)) {
    return 'deny';
  }

  // 3. 用户根路径限制（安全边界，不可绕过）
  if (principal.type === 'user' && principal.defaultPath && principal.defaultPath !== '/') {
    const userRoot = normalizePath(principal.defaultPath);
    if (!isPathWithinBoundary(canonicalPath, userRoot)) {
      return 'deny';
    }
  }

  // 4. API密钥额外检查：必须在密钥配置的权限范围内
  if (principal.type === 'apiKey') {
    if (!principal.allowedPermissions?.includes(action)) {
      return 'deny';
    }
  }

  // 5. 收集所有匹配的规则
  const allRules = await findMatchingRules(db, canonicalPath, principal, mount.id);

  // 6. 规则排序：主体特异度 > 路径特异度 > 显式优先级 > effect
  const sortedRules = sortRulesByPriority(allRules, canonicalPath);

  // 7. 应用第一个匹配的规则
  for (const rule of sortedRules) {
    // 检查操作是否在权限列表中
    if (!rule.permissions.includes(action)) {
      continue;
    }

    // 检查条件
    if (rule.requirePassword && !conditions?.passwordVerified) {
      return 'deny';
    }
    if (rule.allowedIps && !conditions?.ip) {
      return 'deny';
    }
    if (rule.allowedIps && !rule.allowedIps.includes(conditions.ip)) {
      return 'deny';
    }

    // 返回规则效果
    return rule.effect;
  }

  // 8. 文件所有者权限（无规则匹配时的回退）
  if (principal.type === 'user' && fileOwnerId && fileOwnerId === principal.id) {
    const ownerPerms: Permission[] = ['read', 'update', 'delete', 'share', 'download'];
    if (ownerPerms.includes(action)) {
      return 'allow';
    }
  }

  // 9. 默认拒绝（无匹配规则且非所有者）
  return 'deny';
}

/**
 * 规则排序算法
 * 主体特异度 > 路径特异度 > 显式优先级 > effect (deny > allow)
 */
function sortRulesByPriority(rules: PathRule[], canonicalPath: string): PathRule[] {
  return rules.sort((a, b) => {
    // 1. 主体特异度（user > apiKey > role）
    const subjectScore = (rule: PathRule) => {
      if (rule.userId) return 3;
      if (rule.apiKeyId) return 2;
      return 1;
    };
    const subjectDiff = subjectScore(b) - subjectScore(a);
    if (subjectDiff !== 0) return subjectDiff;

    // 2. 路径特异度（精确匹配 > 深层路径 > 浅层路径）
    const pathScore = (rule: PathRule) => {
      if (rule.pathPattern === canonicalPath) return 1000; // 精确匹配
      return rule.pathPattern.split('/').length;           // 路径深度
    };
    const pathDiff = pathScore(b) - pathScore(a);
    if (pathDiff !== 0) return pathDiff;

    // 3. 显式优先级
    const priorityDiff = b.priority - a.priority;
    if (priorityDiff !== 0) return priorityDiff;

    // 4. effect（deny > allow）
    if (a.effect === 'deny' && b.effect === 'allow') return -1;
    if (a.effect === 'allow' && b.effect === 'deny') return 1;

    return 0;
  });
}

/**
 * 便捷函数：检查是否可以执行操作
 */
export async function can(
  db: D1Database,
  principal: Principal,
  mount: Mount,
  path: string,
  action: Permission,
  fileOwnerId?: string,
  conditions?: Conditions
): Promise<boolean> {
  const result = await checkPermission(
    db,
    principal,
    mount,
    normalizePath(path),
    action,
    fileOwnerId,
    conditions
  );
  return result === 'allow';
}

/**
 * 便捷函数：要求权限，否则抛出异常
 */
export async function requirePermission(
  db: D1Database,
  principal: Principal,
  mount: Mount,
  path: string,
  action: Permission,
  fileOwnerId?: string,
  conditions?: Conditions
): Promise<void> {
  const allowed = await can(db, principal, mount, path, action, fileOwnerId, conditions);
  if (!allowed) {
    throw new ApiError(403, 'FORBIDDEN', `无权限执行 ${action} 操作`);
  }
}
```

### rules.ts - 规则查询与匹配

```typescript
import type { Principal, PathRule } from './types';
import { isPathWithinBoundary } from '../../utils/path';

/**
 * 查找匹配的路径规则
 */
export async function findMatchingRules(
  db: D1Database,
  path: string,
  principal: Principal,
  mountId: string
): Promise<PathRule[]> {
  // 从数据库查询所有可能匹配的规则
  const query = `
    SELECT * FROM path_rules
    WHERE mount_id = ?
      AND status = 'active'
      AND (
        -- 用户特定规则
        (user_id = ? AND role IS NULL AND api_key_id IS NULL)
        -- 角色规则
        OR (role = ? AND user_id IS NULL AND api_key_id IS NULL)
        -- API密钥规则
        OR (api_key_id = ? AND user_id IS NULL AND role IS NULL)
      )
  `;

  const result = await db.prepare(query).bind(
    mountId,
    principal.type === 'user' ? principal.id : null,
    principal.role ?? null,
    principal.type === 'apiKey' ? principal.apiKeyId : null
  ).all();

  const candidateRules = result.results as PathRule[];

  // 过滤路径匹配的规则
  const matchedRules: PathRule[] = [];
  for (const rule of candidateRules) {
    if (pathMatches(path, rule.pathPattern)) {
      matchedRules.push(rule);
    }
  }

  return matchedRules;
}

/**
 * 路径模式匹配（支持通配符）
 */
export function pathMatches(path: string, pattern: string): boolean {
  // 精确匹配
  if (pattern === path) return true;

  // 单星号通配符：/images/* 匹配 /images/abc.jpg（不递归）
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    if (path === prefix) return true;
    return (
      isPathWithinBoundary(path, prefix) &&
      !path.slice(prefix.length + 1).includes('/')
    );
  }

  // 双星号通配符：/images/** 匹配 /images/a/b/c.jpg（递归）
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || isPathWithinBoundary(path, prefix);
  }

  return false;
}
```

### schemas.ts - 权限规则验证

```typescript
import { z } from 'zod';

export const CreateRuleSchema = z.object({
  mountId: z.string().uuid(),
  pathPattern: z.string().regex(/^\//, '路径必须以 / 开头'),
  userId: z.string().uuid().nullable().optional(),
  role: z.enum(['admin', 'user', 'guest']).nullable().optional(),
  apiKeyId: z.string().uuid().nullable().optional(),
  permissions: z.array(z.enum([
    'read', 'write', 'update', 'delete', 'share', 'download'
  ])).min(1),
  effect: z.enum(['allow', 'deny']),
  priority: z.number().int().min(0).max(1000).default(0),
  requirePassword: z.boolean().default(false),
  allowedIps: z.array(z.string().ip()).nullable().optional(),
}).refine(
  (data) => [data.userId, data.role, data.apiKeyId].filter(Boolean).length === 1,
  { message: '必须且只能指定 userId、role 或 apiKeyId 其中之一' }
);

export type CreateRuleRequest = z.infer<typeof CreateRuleSchema>;
```

---

## 文件管理服务 (Files Service)

### 职责范围

- 文件/文件夹列表查询
- 创建文件夹
- 文件详情查询
- 元数据更新（重命名、自定义属性）
- 文件删除
- 移动/复制操作
- 密码验证

### 目录结构

```
services/files/
├── handlers.ts         // 文件CRUD handlers
├── schemas.ts          // 验证schemas
├── metadata.ts         // 元数据操作逻辑
├── operations.ts       // 移动/复制/删除逻辑
└── types.ts            // 类型定义
```

### schemas.ts

```typescript
import { z } from 'zod';
import { PathSchema, FileNameSchema, PaginationSchema } from '../../shared/schemas';

// 列表查询参数
export const ListFilesQuerySchema = z.object({
  path: PathSchema.default('/'),
  sort: z.enum(['name', 'time', 'size', 'manual']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  type: z.enum(['file', 'folder']).optional(),
  search: z.string().max(200).optional(),
}).merge(PaginationSchema);

// 创建文件夹
export const CreateFolderSchema = z.object({
  path: PathSchema,
  name: FileNameSchema,
});

// 更新文件元数据
export const UpdateFileSchema = z.object({
  name: FileNameSchema.optional(),
  customTitle: z.string().max(200).nullable().optional(),
  customColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  coverUrl: z.string().url().max(1000).nullable().optional(),
  iconEmoji: z.string().max(16).nullable().optional(),
  accessPassword: z.string().min(1).max(128).nullable().optional(),
  manualPosition: z.number().int().nullable().optional(),
});

// 移动文件
export const MoveFileSchema = z.object({
  targetPath: PathSchema,
  newName: FileNameSchema.optional(),
});

// 密码验证
export const VerifyPasswordSchema = z.object({
  password: z.string().min(1).max(128),
});

export type ListFilesQuery = z.infer<typeof ListFilesQuerySchema>;
export type CreateFolderRequest = z.infer<typeof CreateFolderSchema>;
export type UpdateFileRequest = z.infer<typeof UpdateFileSchema>;
export type MoveFileRequest = z.infer<typeof MoveFileSchema>;
export type VerifyPasswordRequest = z.infer<typeof VerifyPasswordSchema>;
```

### handlers.ts（部分示例）

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../../types';
import { ListFilesQuerySchema, CreateFolderSchema, UpdateFileSchema } from './schemas';
import { requirePermission, can } from '../permissions/check';
import { FileRepo, MountRepo } from '../../db';
import { getDb, getPrincipal } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { normalizePath, isValidFileName, objectKeyFromPath } from '../../utils/path';

export const filesRoutes = new Hono<AppBindings>();

// ============ 列出文件 ============
filesRoutes.get(
  '/',
  zValidator('query', ListFilesQuerySchema),
  async (c) => {
    const db = getDb(c);
    const principal = getPrincipal(c);
    const query = c.req.valid('query');

    const targetPath = normalizePath(query.path);
    const mount = await MountRepo.findMountForPath(db, targetPath);
    if (!mount) {
      throw ApiError.notFound('路径不存在或未挂载');
    }

    // 权限检查
    await requirePermission(db, principal, mount, targetPath, 'read');

    // 查询文件列表
    const { rows, total } = await FileRepo.listChildren(db, mount.id, targetPath, {
      sortBy: query.sort ?? mount.sortBy,
      sortOrder: query.order ?? mount.sortOrder,
      search: query.search,
      type: query.type,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    });

    return ok(c, {
      items: rows,
      pagination: {
        total,
        page: query.page,
        limit: query.limit,
        pages: Math.ceil(total / query.limit),
      },
      mount: {
        id: mount.id,
        name: mount.name,
        sortBy: mount.sortBy,
        sortOrder: mount.sortOrder,
      },
    });
  }
);

// ============ 创建文件夹 ============
filesRoutes.post(
  '/folder',
  zValidator('json', CreateFolderSchema),
  async (c) => {
    const db = getDb(c);
    const principal = getPrincipal(c);
    const body = c.req.valid('json');

    if (!isValidFileName(body.name)) {
      throw ApiError.badRequest('文件夹名包含非法字符');
    }

    const targetPath = normalizePath(body.path);
    const mount = await MountRepo.findMountForPath(db, targetPath);
    if (!mount) {
      throw ApiError.notFound('目标路径不存在');
    }

    // 权限检查
    await requirePermission(db, principal, mount, targetPath, 'write');

    // 检查同名文件
    const existing = await FileRepo.getFileAtPath(db, mount.id, targetPath, body.name);
    if (existing) {
      throw ApiError.conflict('同名文件或文件夹已存在');
    }

    // 创建文件夹
    const folderPath = targetPath === '/' ? `/${body.name}` : `${targetPath}/${body.name}`;
    const objectKey = objectKeyFromPath(mount.mountPath, '', folderPath);

    const folder = await FileRepo.createFile(db, {
      mountId: mount.id,
      objectKey: `folder:${objectKey}`,
      path: folderPath,
      name: body.name,
      type: 'folder',
      size: 0,
      ownerId: principal.id,
    });

    return ok(c, { file: folder }, '文件夹创建成功', 201);
  }
);

// ============ 更新元数据 / 重命名 ============
filesRoutes.put(
  '/:id',
  zValidator('json', UpdateFileSchema),
  async (c) => {
    const db = getDb(c);
    const principal = getPrincipal(c);
    const fileId = c.req.param('id');
    const body = c.req.valid('json');

    const file = await FileRepo.getFileById(db, fileId);
    if (!file) {
      throw ApiError.notFound('文件不存在');
    }

    const mount = await MountRepo.getMountById(db, file.mountId);
    if (!mount) {
      throw ApiError.notFound('挂载点不存在');
    }

    // 权限检查
    await requirePermission(db, principal, mount, file.path, 'update', file.ownerId);

    // 处理重命名
    if (body.name && body.name !== file.name) {
      if (!isValidFileName(body.name)) {
        throw ApiError.badRequest('文件名包含非法字符');
      }

      const parentPath = file.path.slice(0, -(file.name.length + 1)) || '/';
      const conflict = await FileRepo.getFileAtPath(db, mount.id, parentPath, body.name);
      if (conflict && conflict.id !== file.id) {
        throw ApiError.conflict('同名文件已存在');
      }

      const newPath = parentPath === '/' ? `/${body.name}` : `${parentPath}/${body.name}`;
      await FileRepo.updateFile(db, file.id, { name: body.name, path: newPath });
    }

    // 处理其他元数据更新
    const updateFields: Record<string, unknown> = {};
    if (body.customTitle !== undefined) updateFields.custom_title = body.customTitle;
    if (body.customColor !== undefined) updateFields.custom_color = body.customColor;
    if (body.coverUrl !== undefined) updateFields.cover_url = body.coverUrl;
    if (body.iconEmoji !== undefined) updateFields.icon_emoji = body.iconEmoji;
    if (body.manualPosition !== undefined) updateFields.manual_position = body.manualPosition;

    // 处理密码
    if (body.accessPassword !== undefined) {
      const { hashPassword } = await import('../../utils/crypto');
      updateFields.access_password = body.accessPassword ? hashPassword(body.accessPassword) : null;
    }

    if (Object.keys(updateFields).length > 0) {
      await FileRepo.updateFile(db, file.id, updateFields);
      await FileRepo.updateVersion(db, file.id);
    }

    const updated = await FileRepo.getFileById(db, file.id);
    return ok(c, { file: updated }, '更新成功');
  }
);

// ============ 删除文件 ============
filesRoutes.delete('/:id', async (c) => {
  const db = getDb(c);
  const principal = getPrincipal(c);
  const fileId = c.req.param('id');

  const file = await FileRepo.getFileById(db, fileId);
  if (!file) {
    throw ApiError.notFound('文件不存在');
  }

  const mount = await MountRepo.getMountById(db, file.mountId);
  if (!mount) {
    throw ApiError.notFound('挂载点不存在');
  }

  // 权限检查
  await requirePermission(db, principal, mount, file.path, 'delete', file.ownerId);

  // 删除文件（实际实现需要调用Storage Service）
  await FileRepo.deleteFile(db, file.id);

  return ok(c, null, '删除成功');
});
```

---

## 上传服务 (Uploads Service)

### 职责范围

- 上传会话管理（创建、查询、完成、取消）
- 单文件直传流程
- 分片上传流程
- 配额预留与释放
- 上传验证（ETag、Size校验）
- 幂等性保证

### 目录结构

```
services/uploads/
├── handlers.ts         // 上传API handlers
├── schemas.ts          // 上传参数验证
├── session.ts          // 会话管理逻辑
├── multipart.ts        // 分片上传逻辑
├── quota.ts            // 配额预留/释放
└── types.ts            // 上传相关类型
```

### types.ts

```typescript
export type UploadStatus =
  | 'pending'      // 已创建，等待上传
  | 'uploading'    // 正在上传
  | 'verifying'    // 验证中
  | 'completed'    // 已完成
  | 'failed'       // 失败
  | 'expired'      // 已过期
  | 'aborted';     // 已中止

export interface UploadSession {
  id: string;
  userId: string;
  mountId: string;
  objectKey: string;
  fileName: string;
  fileSize: number;
  mimeType: string | null;
  targetPath: string;
  status: UploadStatus;
  quotaReserved: number;
  uploadId: string | null;        // 分片上传ID
  partsCount: number | null;      // 总分片数
  uploadedParts: PartInfo[];      // 已上传的分片
  clientIdempotencyKey: string;   // 幂等键
  expiresAt: number;
  createdAt: number;
  completedAt: number | null;
  error: string | null;
}

export interface PartInfo {
  partNumber: number;
  etag: string;
  size: number;
}
```

### schemas.ts

```typescript
import { z } from 'zod';
import { PathSchema, FileNameSchema, UUIDSchema } from '../../shared/schemas';

// 初始化单文件上传
export const InitUploadSchema = z.object({
  fileName: FileNameSchema,
  fileSize: z.number().int().positive().max(5 * 1024 * 1024 * 1024), // 最大5GB
  mimeType: z.string().max(255).nullable().optional(),
  targetPath: PathSchema,
  clientIdempotencyKey: UUIDSchema,
});

// 初始化分片上传
export const InitMultipartSchema = z.object({
  fileName: FileNameSchema,
  totalSize: z.number().int().positive(),
  partSize: z.number().int().min(5 * 1024 * 1024).max(100 * 1024 * 1024), // 5MB-100MB
  mimeType: z.string().max(255).nullable().optional(),
  targetPath: PathSchema,
  clientIdempotencyKey: UUIDSchema,
});

// 完成上传
export const CompleteUploadSchema = z.object({
  sessionId: UUIDSchema,
  etag: z.string().min(1),
});

// 分片上传：请求签名URL
export const SignPartSchema = z.object({
  sessionId: UUIDSchema,
  partNumber: z.number().int().min(1).max(10000),
});

// 分片上传：记录分片
export const RecordPartSchema = z.object({
  sessionId: UUIDSchema,
  partNumber: z.number().int().min(1),
  etag: z.string().min(1),
  size: z.number().int().positive(),
});

// 完成分片上传
export const CompleteMultipartSchema = z.object({
  sessionId: UUIDSchema,
});

export type InitUploadRequest = z.infer<typeof InitUploadSchema>;
export type InitMultipartRequest = z.infer<typeof InitMultipartSchema>;
export type CompleteUploadRequest = z.infer<typeof CompleteUploadSchema>;
export type SignPartRequest = z.infer<typeof SignPartSchema>;
export type RecordPartRequest = z.infer<typeof RecordPartSchema>;
export type CompleteMultipartRequest = z.infer<typeof CompleteMultipartSchema>;
```

### session.ts - 会话管理

```typescript
import type { UploadSession, UploadStatus } from './types';
import { ApiError } from '../../shared/errors';
import { UploadSessionRepo } from '../../db';

/**
 * 创建上传会话（带幂等性保证）
 */
export async function createUploadSession(
  db: D1Database,
  params: {
    userId: string;
    mountId: string;
    objectKey: string;
    fileName: string;
    fileSize: number;
    mimeType: string | null;
    targetPath: string;
    clientIdempotencyKey: string;
    quotaReserved: number;
  }
): Promise<UploadSession> {
  // 幂等性检查
  const existing = await UploadSessionRepo.findByIdempotencyKey(
    db,
    params.userId,
    params.clientIdempotencyKey
  );

  if (existing) {
    // 如果已完成，直接返回
    if (existing.status === 'completed') {
      return existing;
    }
    // 如果进行中或pending，返回现有会话
    if (existing.status === 'pending' || existing.status === 'uploading') {
      return existing;
    }
    // 如果失败/过期，允许重新创建
  }

  // 创建新会话
  const session: UploadSession = {
    id: crypto.randomUUID(),
    userId: params.userId,
    mountId: params.mountId,
    objectKey: params.objectKey,
    fileName: params.fileName,
    fileSize: params.fileSize,
    mimeType: params.mimeType,
    targetPath: params.targetPath,
    status: 'pending',
    quotaReserved: params.quotaReserved,
    uploadId: null,
    partsCount: null,
    uploadedParts: [],
    clientIdempotencyKey: params.clientIdempotencyKey,
    expiresAt: Date.now() + 3600 * 1000, // 1小时过期
    createdAt: Date.now(),
    completedAt: null,
    error: null,
  };

  await UploadSessionRepo.create(db, session);
  return session;
}

/**
 * 验证会话状态
 */
export async function validateSession(
  db: D1Database,
  sessionId: string,
  expectedStatus?: UploadStatus
): Promise<UploadSession> {
  const session = await UploadSessionRepo.findById(db, sessionId);
  if (!session) {
    throw ApiError.notFound('上传会话不存在');
  }

  if (Date.now() > session.expiresAt) {
    throw ApiError.badRequest('上传会话已过期');
  }

  if (expectedStatus && session.status !== expectedStatus) {
    throw ApiError.badRequest(`会话状态错误，当前: ${session.status}，期望: ${expectedStatus}`);
  }

  return session;
}

/**
 * 更新会话状态
 */
export async function updateSessionStatus(
  db: D1Database,
  sessionId: string,
  status: UploadStatus,
  error?: string
): Promise<void> {
  const updates: Partial<UploadSession> = { status };
  if (status === 'completed') {
    updates.completedAt = Date.now();
  }
  if (error) {
    updates.error = error;
  }
  await UploadSessionRepo.update(db, sessionId, updates);
}
```

### quota.ts - 配额管理

```typescript
import { UserQuotaRepo } from '../../db';
import { ApiError } from '../../shared/errors';

/**
 * 原子预留配额
 */
export async function reserveQuota(
  db: D1Database,
  userId: string,
  size: number
): Promise<void> {
  const result = await db.prepare(`
    UPDATE user_quotas
    SET quota_reserved = quota_reserved + ?
    WHERE user_id = ?
      AND used_storage + quota_reserved + ? <= max_storage
  `).bind(size, userId, size).run();

  if (result.meta.changes === 0) {
    throw ApiError.forbidden('配额不足');
  }
}

/**
 * 释放预留配额
 */
export async function releaseReservedQuota(
  db: D1Database,
  userId: string,
  size: number
): Promise<void> {
  await db.prepare(`
    UPDATE user_quotas
    SET quota_reserved = quota_reserved - ?
    WHERE user_id = ?
  `).bind(size, userId).run();
}

/**
 * 提交配额（从预留转为实际使用）
 */
export async function commitQuota(
  db: D1Database,
  userId: string,
  reservedSize: number,
  actualSize: number
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.prepare(`
      UPDATE user_quotas
      SET
        used_storage = used_storage + ?,
        quota_reserved = quota_reserved - ?,
        used_files = used_files + 1
      WHERE user_id = ?
    `).bind(actualSize, reservedSize, userId).run();
  });
}

/**
 * 定时任务：释放过期的预留配额
 */
export async function releaseExpiredReservations(db: D1Database): Promise<void> {
  const expiredSessions = await db.prepare(`
    SELECT id, user_id, quota_reserved
    FROM upload_sessions
    WHERE status IN ('pending', 'uploading')
      AND expires_at < ?
  `).bind(Date.now()).all();

  for (const session of expiredSessions.results) {
    await db.transaction(async (tx) => {
      // 释放配额
      await tx.prepare(`
        UPDATE user_quotas
        SET quota_reserved = quota_reserved - ?
        WHERE user_id = ?
      `).bind(session.quota_reserved, session.user_id).run();

      // 标记会话过期
      await tx.prepare(`
        UPDATE upload_sessions
        SET status = 'expired'
        WHERE id = ?
      `).bind(session.id).run();
    });
  }
}
```

### handlers.ts - 上传API（部分）

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../../types';
import { InitUploadSchema, CompleteUploadSchema } from './schemas';
import { createUploadSession, validateSession, updateSessionStatus } from './session';
import { reserveQuota, releaseReservedQuota, commitQuota } from './quota';
import { requirePermission } from '../permissions/check';
import { getStorageProvider } from '../storage/providers';
import { MountRepo, FileRepo } from '../../db';
import { getDb, getPrincipal } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { normalizePath, objectKeyFromPath, isValidFileName } from '../../utils/path';

export const uploadsRoutes = new Hono<AppBindings>();

// ============ 初始化单文件上传 ============
uploadsRoutes.post(
  '/init',
  zValidator('json', InitUploadSchema),
  async (c) => {
    const db = getDb(c);
    const principal = getPrincipal(c);
    const body = c.req.valid('json');

    if (!isValidFileName(body.fileName)) {
      throw ApiError.badRequest('文件名包含非法字符');
    }

    const targetPath = normalizePath(body.targetPath);
    const mount = await MountRepo.findMountForPath(db, targetPath);
    if (!mount) {
      throw ApiError.notFound('目标路径不存在');
    }

    // 权限检查
    await requirePermission(db, principal, mount, targetPath, 'write');

    // 原子预留配额
    await reserveQuota(db, principal.id, body.fileSize);

    try {
      // 生成对象键
      const fullPath = targetPath === '/'
        ? `/${body.fileName}`
        : `${targetPath}/${body.fileName}`;
      const objectKey = objectKeyFromPath(mount.mountPath, '', fullPath);

      // 创建上传会话
      const session = await createUploadSession(db, {
        userId: principal.id,
        mountId: mount.id,
        objectKey,
        fileName: body.fileName,
        fileSize: body.fileSize,
        mimeType: body.mimeType ?? null,
        targetPath: fullPath,
        clientIdempotencyKey: body.clientIdempotencyKey,
        quotaReserved: body.fileSize,
      });

      // 生成预签名URL（15分钟）
      const provider = await getStorageProvider(db, mount.id, c.env);
      const uploadUrl = await provider.generatePresignedPutUrl(
        objectKey,
        body.fileSize,
        body.mimeType ?? undefined,
        900 // 15分钟
      );

      return ok(c, {
        sessionId: session.id,
        uploadUrl,
        expiresIn: 900,
      }, '上传会话创建成功', 201);
    } catch (error) {
      // 创建会话失败，释放配额
      await releaseReservedQuota(db, principal.id, body.fileSize);
      throw error;
    }
  }
);

// ============ 完成上传 ============
uploadsRoutes.post(
  '/complete',
  zValidator('json', CompleteUploadSchema),
  async (c) => {
    const db = getDb(c);
    const principal = getPrincipal(c);
    const body = c.req.valid('json');

    // 验证会话
    const session = await validateSession(db, body.sessionId, 'pending');

    if (session.userId !== principal.id) {
      throw ApiError.forbidden('无权访问此上传会话');
    }

    // 更新状态为uploading
    await updateSessionStatus(db, session.id, 'uploading');

    try {
      // HEAD验证对象是否存在
      const provider = await getStorageProvider(db, session.mountId, c.env);
      const headResult = await provider.headObject(session.objectKey);

      // 验证ETag
      if (headResult.etag !== body.etag) {
        throw new Error('ETag不匹配');
      }

      // 验证文件大小
      if (headResult.size !== session.fileSize) {
        throw new Error('文件大小不匹配');
      }

      // 更新状态为verifying
      await updateSessionStatus(db, session.id, 'verifying');

      // 原子提交：创建文件元数据 + 更新配额 + 标记完成
      await db.transaction(async (tx) => {
        // 创建文件元数据
        await FileRepo.createFile(tx, {
          mountId: session.mountId,
          objectKey: session.objectKey,
          path: session.targetPath,
          name: session.fileName,
          type: 'file',
          mimeType: session.mimeType,
          size: headResult.size,
          etag: headResult.etag,
          ownerId: session.userId,
        });

        // 提交配额
        await commitQuota(
          tx,
          session.userId,
          session.quotaReserved,
          headResult.size
        );

        // 标记会话完成
        await updateSessionStatus(tx, session.id, 'completed');
      });

      return ok(c, { success: true }, '上传完成');
    } catch (error) {
      // 验证失败，标记为failed，释放配额
      await updateSessionStatus(db, session.id, 'failed', (error as Error).message);
      await releaseReservedQuota(db, session.userId, session.quotaReserved);
      throw ApiError.badRequest(`上传验证失败: ${(error as Error).message}`);
    }
  }
);

// ============ 取消上传 ============
uploadsRoutes.delete('/:sessionId', async (c) => {
  const db = getDb(c);
  const principal = getPrincipal(c);
  const sessionId = c.req.param('sessionId');

  const session = await validateSession(db, sessionId);

  if (session.userId !== principal.id) {
    throw ApiError.forbidden('无权访问此上传会话');
  }

  // 释放配额并标记为aborted
  await db.transaction(async (tx) => {
    await releaseReservedQuota(tx, session.userId, session.quotaReserved);
    await updateSessionStatus(tx, session.id, 'aborted');
  });

  return ok(c, null, '上传已取消');
});
```

### 上传流程状态机图

```
单文件上传:
pending → uploading → verifying → completed
   ↓          ↓           ↓
  expired   failed      failed

分片上传:
pending → uploading → parts_uploaded → completing → completed
   ↓          ↓             ↓             ↓
  expired   failed       failed        failed
```

---

## 分享服务 (Shares Service)

### 职责范围

- 分享链接创建（短链、二维码）
- 分享权限控制（密码、过期时间、访问次数）
- 下载令牌生成
- 分享访问日志
- 分享链接管理（列表、删除、更新）

### 目录结构

```
services/shares/
├── handlers.ts         // 分享API handlers
├── schemas.ts          // 分享参数验证
├── tokens.ts           // 下载令牌生成
├── shortlink.ts        // 短链生成
└── types.ts            // 分享相关类型
```

### types.ts

```typescript
export interface ShareLink {
  id: string;
  fileId: string;
  userId: string;
  shortCode: string;          // 短链代码 (6-8位)
  accessPassword: string | null;
  maxAccessCount: number | null;
  accessCount: number;
  expiresAt: number | null;
  allowDownload: boolean;
  allowPreview: boolean;
  qrCodeUrl: string | null;
  status: 'active' | 'expired' | 'disabled';
  createdAt: number;
  updatedAt: number;
}

export interface DownloadToken {
  fileId: string;
  mountId: string;
  objectKey: string;
  name: string;
  mimeType: string | null;
  size: number;
  passwordVerified: boolean;
  expiresAt: number;
}
```

### schemas.ts

```typescript
import { z } from 'zod';
import { UUIDSchema, PasswordSchema } from '../../shared/schemas';

// 创建分享链接
export const CreateShareSchema = z.object({
  fileId: UUIDSchema,
  accessPassword: PasswordSchema.nullable().optional(),
  maxAccessCount: z.number().int().positive().nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  allowDownload: z.boolean().default(true),
  allowPreview: z.boolean().default(true),
});

// 访问分享链接
export const AccessShareSchema = z.object({
  shortCode: z.string().length(6).or(z.string().length(8)),
  password: PasswordSchema.optional(),
});

// 更新分享链接
export const UpdateShareSchema = z.object({
  accessPassword: PasswordSchema.nullable().optional(),
  maxAccessCount: z.number().int().positive().nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export type CreateShareRequest = z.infer<typeof CreateShareSchema>;
export type AccessShareRequest = z.infer<typeof AccessShareSchema>;
export type UpdateShareRequest = z.infer<typeof UpdateShareSchema>;
```

### tokens.ts - 下载令牌

```typescript
import { SignJWT, jwtVerify } from 'jose';
import type { DownloadToken } from './types';

/**
 * 生成下载令牌（JWT，15分钟有效）
 */
export async function createDownloadToken(
  data: Omit<DownloadToken, 'expiresAt'>,
  secret: string
): Promise<string> {
  const expiresAt = Date.now() + 900 * 1000; // 15分钟

  const payload: DownloadToken = {
    ...data,
    expiresAt,
  };

  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(secret));
}

/**
 * 验证下载令牌
 */
export async function verifyDownloadToken(
  token: string,
  secret: string
): Promise<DownloadToken> {
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret)
    );
    return payload as unknown as DownloadToken;
  } catch (error) {
    throw new Error('下载令牌无效或已过期');
  }
}

/**
 * 构建网关下载URL
 */
export function buildGatewayUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/gateway/download?token=${encodeURIComponent(token)}`;
}
```

### shortlink.ts - 短链生成

```typescript
/**
 * 生成短链代码（6位或8位）
 */
export function generateShortCode(length: 6 | 8 = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }

  return result;
}

/**
 * 生成二维码URL（本地生成）
 */
export async function generateQRCode(url: string): Promise<string> {
  // 使用前端生成二维码，返回数据URL或上传到R2后返回CDN URL
  // 这里返回占位符，实际实现在前端
  return `data:image/svg+xml,...`; // SVG格式二维码
}
```

### handlers.ts - 分享API

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../../types';
import { CreateShareSchema, AccessShareSchema } from './schemas';
import { createDownloadToken, buildGatewayUrl } from './tokens';
import { generateShortCode } from './shortlink';
import { requirePermission } from '../permissions/check';
import { ShareRepo, FileRepo, MountRepo } from '../../db';
import { getDb, getPrincipal } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { hashPassword, verifyPassword } from '../../utils/crypto';

export const sharesRoutes = new Hono<AppBindings>();

// ============ 创建分享链接 ============
sharesRoutes.post(
  '/',
  zValidator('json', CreateShareSchema),
  async (c) => {
    const db = getDb(c);
    const principal = getPrincipal(c);
    const body = c.req.valid('json');

    // 查询文件
    const file = await FileRepo.getFileById(db, body.fileId);
    if (!file) {
      throw ApiError.notFound('文件不存在');
    }

    const mount = await MountRepo.getMountById(db, file.mountId);
    if (!mount) {
      throw ApiError.notFound('挂载点不存在');
    }

    // 权限检查
    await requirePermission(db, principal, mount, file.path, 'share', file.ownerId);

    // 生成短链代码（确保唯一）
    let shortCode: string;
    let attempts = 0;
    do {
      shortCode = generateShortCode(6);
      const existing = await ShareRepo.findByShortCode(db, shortCode);
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      throw ApiError.internal('生成短链失败，请重试');
    }

    // 创建分享链接
    const share = await ShareRepo.create(db, {
      fileId: body.fileId,
      userId: principal.id,
      shortCode,
      accessPassword: body.accessPassword ? hashPassword(body.accessPassword) : null,
      maxAccessCount: body.maxAccessCount ?? null,
      accessCount: 0,
      expiresAt: body.expiresAt ?? null,
      allowDownload: body.allowDownload,
      allowPreview: body.allowPreview,
      status: 'active',
    });

    const shareUrl = `${c.req.url.split('/api')[0]}/s/${shortCode}`;

    return ok(c, {
      share: {
        id: share.id,
        shortCode: share.shortCode,
        url: shareUrl,
        expiresAt: share.expiresAt,
      },
    }, '分享链接创建成功', 201);
  }
);

// ============ 访问分享链接 ============
sharesRoutes.post(
  '/access',
  zValidator('json', AccessShareSchema),
  async (c) => {
    const db = getDb(c);
    const body = c.req.valid('json');

    // 查询分享链接
    const share = await ShareRepo.findByShortCode(db, body.shortCode);
    if (!share) {
      throw ApiError.notFound('分享链接不存在');
    }

    // 检查状态
    if (share.status !== 'active') {
      throw ApiError.forbidden('分享链接已禁用');
    }

    // 检查过期
    if (share.expiresAt && Date.now() > share.expiresAt) {
      await ShareRepo.update(db, share.id, { status: 'expired' });
      throw ApiError.forbidden('分享链接已过期');
    }

    // 检查访问次数
    if (share.maxAccessCount && share.accessCount >= share.maxAccessCount) {
      await ShareRepo.update(db, share.id, { status: 'expired' });
      throw ApiError.forbidden('分享链接访问次数已达上限');
    }

    // 验证密码
    if (share.accessPassword) {
      if (!body.password) {
        throw ApiError.unauthorized('请输入访问密码');
      }
      if (!verifyPassword(body.password, share.accessPassword)) {
        throw ApiError.unauthorized('密码错误');
      }
    }

    // 查询文件
    const file = await FileRepo.getFileById(db, share.fileId);
    if (!file) {
      throw ApiError.notFound('文件不存在');
    }

    // 增加访问计数
    await ShareRepo.incrementAccessCount(db, share.id);

    // 生成下载令牌
    const token = await createDownloadToken({
      fileId: file.id,
      mountId: file.mountId,
      objectKey: file.objectKey,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      passwordVerified: true,
    }, c.env.JWT_SECRET);

    const downloadUrl = buildGatewayUrl(c.req.url.split('/api')[0], token);

    return ok(c, {
      file: {
        id: file.id,
        name: file.name,
        type: file.type,
        size: file.size,
        mimeType: file.mimeType,
      },
      downloadUrl: share.allowDownload ? downloadUrl : null,
      allowPreview: share.allowPreview,
      expiresIn: 900, // 15分钟
    });
  }
);

// ============ 列出我的分享 ============
sharesRoutes.get('/', async (c) => {
  const db = getDb(c);
  const principal = getPrincipal(c);

  const shares = await ShareRepo.findByUserId(db, principal.id);

  return ok(c, { shares });
});

// ============ 删除分享链接 ============
sharesRoutes.delete('/:id', async (c) => {
  const db = getDb(c);
  const principal = getPrincipal(c);
  const shareId = c.req.param('id');

  const share = await ShareRepo.findById(db, shareId);
  if (!share) {
    throw ApiError.notFound('分享链接不存在');
  }

  if (share.userId !== principal.id) {
    throw ApiError.forbidden('无权删除此分享链接');
  }

  await ShareRepo.delete(db, shareId);

  return ok(c, null, '分享链接已删除');
});
```

---

## 存储服务 (Storage Service)

### 职责范围

- 存储提供商抽象层（R2、S3、阿里云OSS、腾讯COS等）
- 预签名URL生成（上传/下载）
- 对象操作（HEAD、GET、PUT、DELETE、COPY）
- 多Provider支持与切换
- 公共访问URL生成

### 目录结构

```
services/storage/
├── providers.ts        // Provider工厂与抽象接口
├── r2.ts              // Cloudflare R2实现
├── s3.ts              // AWS S3实现
├── oss.ts             // 阿里云OSS实现
├── presign.ts         // 预签名URL生成
└── types.ts           // 存储相关类型
```

### types.ts

```typescript
export type ProviderType = 'r2' | 's3' | 'oss' | 'cos' | 'minio';

export interface StorageProvider {
  readonly type: ProviderType;
  readonly name: string;

  // 对象操作
  headObject(key: string): Promise<HeadObjectResult>;
  getObject(key: string): Promise<GetObjectResult>;
  putObject(key: string, data: ReadableStream | ArrayBuffer, options?: PutObjectOptions): Promise<PutObjectResult>;
  deleteObject(key: string): Promise<void>;
  copyObject(sourceKey: string, targetKey: string): Promise<CopyObjectResult>;

  // 流式操作
  getObjectStream(key: string): Promise<ReadableStream>;
  putObjectStream(key: string, stream: ReadableStream, options?: PutObjectOptions): Promise<PutObjectResult>;

  // 预签名URL
  generatePresignedPutUrl(key: string, size: number, mimeType?: string, expiresIn?: number): Promise<string>;
  generatePresignedGetUrl(key: string, expiresIn?: number): Promise<string>;

  // 分片上传
  createMultipartUpload(key: string, options?: PutObjectOptions): Promise<{ uploadId: string }>;
  uploadPart(key: string, uploadId: string, partNumber: number, data: ArrayBuffer): Promise<{ etag: string }>;
  completeMultipartUpload(key: string, uploadId: string, parts: PartInfo[]): Promise<CompleteMultipartResult>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  // 公共访问
  getPublicUrl(key: string): string | null;
  supportsPublicAccess(): boolean;
}

export interface HeadObjectResult {
  size: number;
  etag: string;
  mimeType: string | null;
  lastModified: Date;
  metadata?: Record<string, string>;
}

export interface GetObjectResult {
  body: ReadableStream;
  size: number;
  etag: string;
  mimeType: string | null;
}

export interface PutObjectOptions {
  mimeType?: string;
  metadata?: Record<string, string>;
}

export interface PutObjectResult {
  etag: string;
  versionId?: string;
}

export interface CopyObjectResult {
  etag: string;
}

export interface PartInfo {
  partNumber: number;
  etag: string;
}

export interface CompleteMultipartResult {
  etag: string;
  location: string;
}
```

### providers.ts - Provider工厂

```typescript
import type { StorageProvider, ProviderType } from './types';
import { R2Provider } from './r2';
import { S3Provider } from './s3';
import { OSSProvider } from './oss';
import { ApiError } from '../../shared/errors';
import { ProviderRepo } from '../../db';

/**
 * 获取存储Provider实例
 */
export async function getStorageProvider(
  db: D1Database,
  mountId: string,
  env: Env
): Promise<StorageProvider> {
  // 查询挂载点配置
  const mount = await db.prepare(`
    SELECT provider_id FROM mounts WHERE id = ?
  `).bind(mountId).first();

  if (!mount) {
    throw ApiError.notFound('挂载点不存在');
  }

  // 查询Provider配置
  const provider = await ProviderRepo.getProviderById(db, mount.provider_id as string);
  if (!provider) {
    throw ApiError.notFound('存储提供商不存在');
  }

  return createProvider(provider.type as ProviderType, provider.config, env);
}

/**
 * 创建Provider实例
 */
export function createProvider(
  type: ProviderType,
  config: Record<string, unknown>,
  env: Env
): StorageProvider {
  switch (type) {
    case 'r2':
      return new R2Provider(config, env.R2_BUCKET);
    case 's3':
      return new S3Provider(config);
    case 'oss':
      return new OSSProvider(config);
    default:
      throw ApiError.badRequest(`不支持的Provider类型: ${type}`);
  }
}
```

### r2.ts - Cloudflare R2实现（部分）

```typescript
import type { R2Bucket } from '@cloudflare/workers-types';
import type { StorageProvider, HeadObjectResult, GetObjectResult, PutObjectResult } from './types';
import { ApiError } from '../../shared/errors';

export class R2Provider implements StorageProvider {
  readonly type = 'r2' as const;
  readonly name: string;

  constructor(
    private config: Record<string, unknown>,
    private bucket: R2Bucket
  ) {
    this.name = config.name as string;
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const obj = await this.bucket.head(key);
    if (!obj) {
      throw ApiError.notFound(`对象不存在: ${key}`);
    }

    return {
      size: obj.size,
      etag: obj.etag,
      mimeType: obj.httpMetadata?.contentType ?? null,
      lastModified: obj.uploaded,
      metadata: obj.customMetadata,
    };
  }

  async getObject(key: string): Promise<GetObjectResult> {
    const obj = await this.bucket.get(key);
    if (!obj) {
      throw ApiError.notFound(`对象不存在: ${key}`);
    }

    return {
      body: obj.body,
      size: obj.size,
      etag: obj.etag,
      mimeType: obj.httpMetadata?.contentType ?? null,
    };
  }

  async putObject(key: string, data: ReadableStream | ArrayBuffer, options?: { mimeType?: string }): Promise<PutObjectResult> {
    const result = await this.bucket.put(key, data, {
      httpMetadata: options?.mimeType ? {
        contentType: options.mimeType,
      } : undefined,
    });

    return {
      etag: result.etag,
      versionId: result.version,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async copyObject(sourceKey: string, targetKey: string): Promise<{ etag: string }> {
    // R2 不直接支持CopyObject，需要GET后PUT
    const source = await this.getObject(sourceKey);
    const result = await this.putObject(targetKey, source.body, {
      mimeType: source.mimeType ?? undefined,
    });
    return { etag: result.etag };
  }

  async getObjectStream(key: string): Promise<ReadableStream> {
    const obj = await this.bucket.get(key);
    if (!obj) {
      throw ApiError.notFound(`对象不存在: ${key}`);
    }
    return obj.body;
  }

  async putObjectStream(key: string, stream: ReadableStream, options?: { mimeType?: string }): Promise<PutObjectResult> {
    return this.putObject(key, stream, options);
  }

  async generatePresignedPutUrl(key: string, size: number, mimeType?: string, expiresIn: number = 900): Promise<string> {
    // R2通过Workers生成预签名URL
    // 实际实现需要使用R2的HTTP API或Workers URL
    throw new Error('R2 presigned URL generation not implemented');
  }

  async generatePresignedGetUrl(key: string, expiresIn: number = 900): Promise<string> {
    throw new Error('R2 presigned URL generation not implemented');
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    const upload = await this.bucket.createMultipartUpload(key);
    return { uploadId: upload.uploadId };
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, data: ArrayBuffer): Promise<{ etag: string }> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, data);
    return { etag: part.etag };
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<{ etag: string; location: string }> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    const result = await upload.complete(parts);
    return { etag: result.etag, location: key };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    await upload.abort();
  }

  getPublicUrl(key: string): string | null {
    const publicDomain = this.config.publicDomain as string | undefined;
    if (!publicDomain) return null;
    return `https://${publicDomain}/${key}`;
  }

  supportsPublicAccess(): boolean {
    return !!this.config.publicDomain;
  }
}
```

### s3.ts - AWS S3实现（框架）

```typescript
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider, HeadObjectResult, GetObjectResult, PutObjectResult } from './types';

export class S3Provider implements StorageProvider {
  readonly type = 's3' as const;
  readonly name: string;
  private client: S3Client;
  private bucket: string;

  constructor(config: Record<string, unknown>) {
    this.name = config.name as string;
    this.bucket = config.bucket as string;

    this.client = new S3Client({
      region: config.region as string,
      credentials: {
        accessKeyId: config.accessKeyId as string,
        secretAccessKey: config.secretAccessKey as string,
      },
      endpoint: config.endpoint as string | undefined,
    });
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const result = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));

    return {
      size: result.ContentLength ?? 0,
      etag: result.ETag ?? '',
      mimeType: result.ContentType ?? null,
      lastModified: result.LastModified ?? new Date(),
      metadata: result.Metadata,
    };
  }

  async generatePresignedPutUrl(key: string, size: number, mimeType?: string, expiresIn: number = 900): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mimeType,
      ContentLength: size,
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  async generatePresignedGetUrl(key: string, expiresIn: number = 900): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  getPublicUrl(key: string): string | null {
    const publicDomain = this.config.publicDomain as string | undefined;
    if (publicDomain) {
      return `https://${publicDomain}/${key}`;
    }
    return `https://${this.bucket}.s3.amazonaws.com/${key}`;
  }

  supportsPublicAccess(): boolean {
    return true;
  }

  // ... 其他方法实现类似R2Provider
}
```

---

## WebDAV服务 (WebDAV Service)

### 职责范围

- WebDAV协议实现（兼容PicGo、PicList等工具）
- PROPFIND（列举目录）
- GET/HEAD（下载/获取文件信息）
- PUT（上传文件）
- DELETE（删除文件）
- MKCOL（创建目录）
- MOVE/COPY（移动/复制文件）
- Basic认证（API密钥）

### 目录结构

```
services/webdav/
├── handlers.ts         // WebDAV方法handlers
├── propfind.ts         // PROPFIND实现
├── xml.ts              // XML响应生成
├── auth.ts             // Basic认证
└── types.ts            // WebDAV类型
```

### types.ts

```typescript
export interface WebDAVResource {
  href: string;
  displayName: string;
  contentLength?: number;
  contentType?: string;
  lastModified: Date;
  resourceType: 'collection' | 'file';
  etag?: string;
}

export interface PropfindRequest {
  depth: 0 | 1 | 'infinity';
  properties: string[];
}
```

### auth.ts - Basic认证

```typescript
import { ApiError } from '../../shared/errors';
import { ApiKeyRepo } from '../../db';
import type { Principal } from '../../shared/types';

/**
 * 解析Basic认证头
 * Format: Authorization: Basic base64(keyId:secret)
 */
export function parseBasicAuth(authHeader: string | null): { keyId: string; secret: string } | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }

  try {
    const base64 = authHeader.slice(6);
    const decoded = atob(base64);
    const [keyId, secret] = decoded.split(':', 2);

    if (!keyId || !secret) {
      return null;
    }

    return { keyId, secret };
  } catch {
    return null;
  }
}

/**
 * 验证API密钥并返回Principal
 */
export async function authenticateWebDAV(
  db: D1Database,
  authHeader: string | null
): Promise<Principal> {
  const credentials = parseBasicAuth(authHeader);
  if (!credentials) {
    throw new ApiError(401, 'UNAUTHORIZED', '需要Basic认证');
  }

  const apiKey = await ApiKeyRepo.findById(db, credentials.keyId);
  if (!apiKey || apiKey.status !== 'active') {
    throw new ApiError(401, 'UNAUTHORIZED', 'API密钥无效');
  }

  // 验证secret（简单比对或hash验证）
  if (apiKey.secret !== credentials.secret) {
    throw new ApiError(401, 'UNAUTHORIZED', 'API密钥错误');
  }

  return {
    type: 'apiKey',
    id: apiKey.userId,
    apiKeyId: apiKey.id,
    role: 'user',
    defaultPath: apiKey.rootPath ?? '/',
    allowedPermissions: apiKey.permissions,
  };
}
```

### xml.ts - XML响应生成

```typescript
import type { WebDAVResource } from './types';

/**
 * 生成PROPFIND响应（XML）
 */
export function generatePropfindXML(resources: WebDAVResource[]): string {
  const responses = resources.map(resource => {
    const isCollection = resource.resourceType === 'collection';

    return `
    <D:response>
      <D:href>${escapeXml(resource.href)}</D:href>
      <D:propstat>
        <D:prop>
          <D:displayname>${escapeXml(resource.displayName)}</D:displayname>
          ${resource.contentLength !== undefined ? `<D:getcontentlength>${resource.contentLength}</D:getcontentlength>` : ''}
          ${resource.contentType ? `<D:getcontenttype>${escapeXml(resource.contentType)}</D:getcontenttype>` : ''}
          <D:getlastmodified>${resource.lastModified.toUTCString()}</D:getlastmodified>
          <D:resourcetype>${isCollection ? '<D:collection/>' : ''}</D:resourcetype>
          ${resource.etag ? `<D:getetag>"${escapeXml(resource.etag)}"</D:getetag>` : ''}
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses}
</D:multistatus>`;
}

/**
 * 转义XML特殊字符
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
```

### propfind.ts - PROPFIND实现

```typescript
import type { WebDAVResource, PropfindRequest } from './types';
import { FileRepo, MountRepo } from '../../db';
import { normalizePath } from '../../utils/path';
import { ApiError } from '../../shared/errors';

/**
 * 解析PROPFIND请求
 */
export function parsePropfindRequest(body: string | null, depth: string | null): PropfindRequest {
  return {
    depth: depth === '0' ? 0 : depth === 'infinity' ? 'infinity' : 1,
    properties: [], // 默认返回所有属性
  };
}

/**
 * 执行PROPFIND查询
 */
export async function executePropfind(
  db: D1Database,
  path: string,
  depth: 0 | 1 | 'infinity',
  baseUrl: string
): Promise<WebDAVResource[]> {
  const normalizedPath = normalizePath(path);
  const mount = await MountRepo.findMountForPath(db, normalizedPath);

  if (!mount) {
    throw ApiError.notFound('路径不存在');
  }

  const resources: WebDAVResource[] = [];

  if (depth === 0) {
    // 仅返回当前路径信息
    const file = await FileRepo.getFileAtPath(db, mount.id, normalizedPath, '');
    if (file) {
      resources.push(fileToResource(file, baseUrl));
    }
  } else {
    // 返回当前路径及子项
    const { rows } = await FileRepo.listChildren(db, mount.id, normalizedPath, {
      sortBy: 'name',
      sortOrder: 'asc',
      limit: 1000,
      offset: 0,
    });

    // 添加当前目录
    resources.push({
      href: `${baseUrl}${normalizedPath}`,
      displayName: normalizedPath === '/' ? '/' : normalizedPath.split('/').pop() ?? '',
      resourceType: 'collection',
      lastModified: new Date(),
    });

    // 添加子项
    for (const file of rows) {
      resources.push(fileToResource(file, baseUrl));
    }
  }

  return resources;
}

/**
 * 将文件元数据转换为WebDAV资源
 */
function fileToResource(file: any, baseUrl: string): WebDAVResource {
  return {
    href: `${baseUrl}${file.path}`,
    displayName: file.name,
    contentLength: file.type === 'file' ? file.size : undefined,
    contentType: file.mimeType ?? undefined,
    lastModified: new Date(file.updatedAt),
    resourceType: file.type === 'folder' ? 'collection' : 'file',
    etag: file.etag ?? undefined,
  };
}
```

### handlers.ts - WebDAV Handlers

```typescript
import { Hono } from 'hono';
import type { AppBindings } from '../../types';
import { authenticateWebDAV } from './auth';
import { parsePropfindRequest, executePropfind } from './propfind';
import { generatePropfindXML } from './xml';
import { requirePermission } from '../permissions/check';
import { getStorageProvider } from '../storage/providers';
import { FileRepo, MountRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { ApiError } from '../../shared/errors';
import { normalizePath, objectKeyFromPath } from '../../utils/path';

export const webdavRoutes = new Hono<AppBindings>();

// WebDAV认证中间件
webdavRoutes.use('*', async (c, next) => {
  const db = getDb(c);
  const authHeader = c.req.header('Authorization');

  const principal = await authenticateWebDAV(db, authHeader);
  c.set('principal', principal);
  c.set('userId', principal.id);

  await next();
});

// ============ PROPFIND（列举目录）============
webdavRoutes.on('PROPFIND', '/*', async (c) => {
  const db = getDb(c);
  const principal = c.get('principal');
  const path = normalizePath(c.req.path.replace('/webdav', ''));
  const depth = c.req.header('Depth');
  const body = await c.req.text().catch(() => null);

  const mount = await MountRepo.findMountForPath(db, path);
  if (!mount) {
    throw ApiError.notFound('路径不存在');
  }

  // 权限检查
  await requirePermission(db, principal, mount, path, 'read');

  // 解析并执行PROPFIND
  const request = parsePropfindRequest(body, depth);
  const baseUrl = new URL(c.req.url).origin + '/webdav';
  const resources = await executePropfind(db, path, request.depth, baseUrl);

  // 生成XML响应
  const xml = generatePropfindXML(resources);

  return c.body(xml, 207, {
    'Content-Type': 'application/xml; charset=utf-8',
  });
});

// ============ GET（下载文件）============
webdavRoutes.get('/*', async (c) => {
  const db = getDb(c);
  const principal = c.get('principal');
  const path = normalizePath(c.req.path.replace('/webdav', ''));

  const mount = await MountRepo.findMountForPath(db, path);
  if (!mount) {
    throw ApiError.notFound('路径不存在');
  }

  const fileName = path.split('/').pop() ?? '';
  const parentPath = path.slice(0, -(fileName.length + 1)) || '/';
  const file = await FileRepo.getFileAtPath(db, mount.id, parentPath, fileName);

  if (!file) {
    throw ApiError.notFound('文件不存在');
  }

  // 权限检查
  await requirePermission(db, principal, mount, path, 'download', file.ownerId);

  // 获取对象存储
  const provider = await getStorageProvider(db, mount.id, c.env);
  const result = await provider.getObject(file.objectKey);

  return c.body(result.body, 200, {
    'Content-Type': result.mimeType ?? 'application/octet-stream',
    'Content-Length': result.size.toString(),
    'ETag': result.etag,
  });
});

// ============ HEAD（获取文件信息）============
webdavRoutes.on('HEAD', '/*', async (c) => {
  const db = getDb(c);
  const principal = c.get('principal');
  const path = normalizePath(c.req.path.replace('/webdav', ''));

  const mount = await MountRepo.findMountForPath(db, path);
  if (!mount) {
    throw ApiError.notFound('路径不存在');
  }

  const fileName = path.split('/').pop() ?? '';
  const parentPath = path.slice(0, -(fileName.length + 1)) || '/';
  const file = await FileRepo.getFileAtPath(db, mount.id, parentPath, fileName);

  if (!file) {
    throw ApiError.notFound('文件不存在');
  }

  // 权限检查
  await requirePermission(db, principal, mount, path, 'read', file.ownerId);

  return c.body(null, 200, {
    'Content-Type': file.mimeType ?? 'application/octet-stream',
    'Content-Length': file.size.toString(),
    'ETag': file.etag ?? '',
    'Last-Modified': new Date(file.updatedAt).toUTCString(),
  });
});

// ============ PUT（上传文件）============
webdavRoutes.put('/*', async (c) => {
  const db = getDb(c);
  const principal = c.get('principal');
  const path = normalizePath(c.req.path.replace('/webdav', ''));

  const mount = await MountRepo.findMountForPath(db, path);
  if (!mount) {
    throw ApiError.notFound('路径不存在');
  }

  const fileName = path.split('/').pop() ?? '';
  const parentPath = path.slice(0, -(fileName.length + 1)) || '/';

  // 权限检查
  await requirePermission(db, principal, mount, parentPath, 'write');

  // 获取上传数据
  const contentLength = parseInt(c.req.header('Content-Length') ?? '0');
  const mimeType = c.req.header('Content-Type') ?? 'application/octet-stream';
  const body = c.req.raw.body;

  if (!body) {
    throw ApiError.badRequest('请求体为空');
  }

  // 上传到对象存储
  const objectKey = objectKeyFromPath(mount.mountPath, '', path);
  const provider = await getStorageProvider(db, mount.id, c.env);
  const result = await provider.putObject(objectKey, body, { mimeType });

  // 创建文件元数据
  await FileRepo.createFile(db, {
    mountId: mount.id,
    objectKey,
    path,
    name: fileName,
    type: 'file',
    mimeType,
    size: contentLength,
    etag: result.etag,
    ownerId: principal.id,
  });

  return c.body(null, 201);
});

// ============ DELETE（删除文件）============
webdavRoutes.delete('/*', async (c) => {
  const db = getDb(c);
  const principal = c.get('principal');
  const path = normalizePath(c.req.path.replace('/webdav', ''));

  const mount = await MountRepo.findMountForPath(db, path);
  if (!mount) {
    throw ApiError.notFound('路径不存在');
  }

  const fileName = path.split('/').pop() ?? '';
  const parentPath = path.slice(0, -(fileName.length + 1)) || '/';
  const file = await FileRepo.getFileAtPath(db, mount.id, parentPath, fileName);

  if (!file) {
    throw ApiError.notFound('文件不存在');
  }

  // 权限检查
  await requirePermission(db, principal, mount, path, 'delete', file.ownerId);

  // 删除对象存储
  const provider = await getStorageProvider(db, mount.id, c.env);
  await provider.deleteObject(file.objectKey);

  // 删除元数据
  await FileRepo.deleteFile(db, file.id);

  return c.body(null, 204);
});

// ============ MKCOL（创建目录）============
webdavRoutes.on('MKCOL', '/*', async (c) => {
  const db = getDb(c);
  const principal = c.get('principal');
  const path = normalizePath(c.req.path.replace('/webdav', ''));

  const mount = await MountRepo.findMountForPath(db, path);
  if (!mount) {
    throw ApiError.notFound('路径不存在');
  }

  const folderName = path.split('/').pop() ?? '';
  const parentPath = path.slice(0, -(folderName.length + 1)) || '/';

  // 权限检查
  await requirePermission(db, principal, mount, parentPath, 'write');

  // 检查是否已存在
  const existing = await FileRepo.getFileAtPath(db, mount.id, parentPath, folderName);
  if (existing) {
    throw ApiError.conflict('文件夹已存在');
  }

  // 创建文件夹
  const objectKey = objectKeyFromPath(mount.mountPath, '', path);
  await FileRepo.createFile(db, {
    mountId: mount.id,
    objectKey: `folder:${objectKey}`,
    path,
    name: folderName,
    type: 'folder',
    size: 0,
    ownerId: principal.id,
  });

  return c.body(null, 201);
});

// ============ MOVE（移动文件）============
webdavRoutes.on('MOVE', '/*', async (c) => {
  const db = getDb(c);
  const principal = c.get('principal');
  const sourcePath = normalizePath(c.req.path.replace('/webdav', ''));
  const destination = c.req.header('Destination');

  if (!destination) {
    throw ApiError.badRequest('缺少Destination头');
  }

  const targetPath = normalizePath(new URL(destination).pathname.replace('/webdav', ''));

  const mount = await MountRepo.findMountForPath(db, sourcePath);
  if (!mount) {
    throw ApiError.notFound('路径不存在');
  }

  // 权限检查：源路径delete + 目标路径write
  await requirePermission(db, principal, mount, sourcePath, 'delete');
  await requirePermission(db, principal, mount, targetPath, 'write');

  // TODO: 实际移动逻辑（调用files service的move操作）

  return c.body(null, 204);
});
```

---

## 数据模型

### 核心表结构

#### users

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'user' | 'guest'
  email_verified INTEGER NOT NULL DEFAULT 0,
  default_path TEXT DEFAULT '/',
  max_storage INTEGER NOT NULL DEFAULT 10737418240, -- 10GB
  max_files INTEGER NOT NULL DEFAULT 10000,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

#### mounts

```sql
CREATE TABLE mounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mount_path TEXT NOT NULL, -- 挂载到的虚拟路径，如 '/' 或 '/backup'
  provider_id TEXT NOT NULL,
  sort_by TEXT NOT NULL DEFAULT 'name', -- 'name' | 'time' | 'size' | 'manual'
  sort_order TEXT NOT NULL DEFAULT 'asc',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id)
);

CREATE INDEX idx_mounts_path ON mounts(mount_path);
```

#### providers

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- 'r2' | 's3' | 'oss' | 'cos' | 'minio'
  config TEXT NOT NULL, -- JSON配置: bucket, region, credentials等
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

#### file_metadata

```sql
CREATE TABLE file_metadata (
  id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- 'file' | 'folder'
  mime_type TEXT,
  size INTEGER NOT NULL,
  etag TEXT,
  checksum_md5 TEXT,
  owner_id TEXT NOT NULL,
  access_password TEXT, -- bcrypt hash
  custom_title TEXT,
  custom_color TEXT,
  cover_url TEXT,
  icon_emoji TEXT,
  manual_position INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  source_cleanup_pending INTEGER NOT NULL DEFAULT 0,
  old_object_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mount_id) REFERENCES mounts(id),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE INDEX idx_files_mount_path ON file_metadata(mount_id, path);
CREATE INDEX idx_files_owner ON file_metadata(owner_id);
CREATE INDEX idx_files_cleanup ON file_metadata(source_cleanup_pending) WHERE source_cleanup_pending = 1;
```

#### path_rules

```sql
CREATE TABLE path_rules (
  id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL,
  path_pattern TEXT NOT NULL, -- '/images/**'
  user_id TEXT, -- 用户特定规则
  role TEXT, -- 角色规则: 'admin' | 'user' | 'guest'
  api_key_id TEXT, -- API密钥规则
  permissions TEXT NOT NULL, -- JSON数组: ['read','write']
  effect TEXT NOT NULL, -- 'allow' | 'deny'
  priority INTEGER NOT NULL DEFAULT 0,
  require_password INTEGER NOT NULL DEFAULT 0,
  allowed_ips TEXT, -- JSON数组
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mount_id) REFERENCES mounts(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
  CHECK ((user_id IS NOT NULL AND role IS NULL AND api_key_id IS NULL)
      OR (role IS NOT NULL AND user_id IS NULL AND api_key_id IS NULL)
      OR (api_key_id IS NOT NULL AND user_id IS NULL AND role IS NULL))
);

CREATE INDEX idx_rules_mount ON path_rules(mount_id, status);
CREATE INDEX idx_rules_user ON path_rules(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_rules_role ON path_rules(role) WHERE role IS NOT NULL;
CREATE INDEX idx_rules_apikey ON path_rules(api_key_id) WHERE api_key_id IS NOT NULL;
```

#### upload_sessions

```sql
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mount_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT,
  target_path TEXT NOT NULL,
  status TEXT NOT NULL, -- 'pending' | 'uploading' | 'verifying' | 'completed' | 'failed' | 'expired' | 'aborted'
  quota_reserved INTEGER NOT NULL,
  upload_id TEXT, -- 分片上传ID
  parts_count INTEGER,
  uploaded_parts TEXT, -- JSON数组
  client_idempotency_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (mount_id) REFERENCES mounts(id)
);

CREATE INDEX idx_sessions_user_key ON upload_sessions(user_id, client_idempotency_key);
CREATE INDEX idx_sessions_expires ON upload_sessions(status, expires_at);
```

#### share_links

```sql
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  short_code TEXT NOT NULL UNIQUE, -- 6-8位短链
  access_password TEXT, -- bcrypt hash
  max_access_count INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  allow_download INTEGER NOT NULL DEFAULT 1,
  allow_preview INTEGER NOT NULL DEFAULT 1,
  qr_code_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (file_id) REFERENCES file_metadata(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_shares_short_code ON share_links(short_code);
CREATE INDEX idx_shares_user ON share_links(user_id);
CREATE INDEX idx_shares_file ON share_links(file_id);
```

#### api_keys

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, -- pk_xxx
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret TEXT NOT NULL, -- sk_xxx (hashed)
  permissions TEXT NOT NULL, -- JSON数组: ['read','write','delete']
  root_path TEXT DEFAULT '/',
  rate_limit INTEGER DEFAULT 1000,
  expires_at INTEGER,
  last_used_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_apikeys_user ON api_keys(user_id);
```

#### user_quotas

```sql
CREATE TABLE user_quotas (
  user_id TEXT PRIMARY KEY,
  used_storage INTEGER NOT NULL DEFAULT 0,
  quota_reserved INTEGER NOT NULL DEFAULT 0, -- 预留配额
  used_files INTEGER NOT NULL DEFAULT 0,
  max_storage INTEGER NOT NULL,
  max_files INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

#### access_logs

```sql
CREATE TABLE access_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL, -- 'upload' | 'download' | 'delete' | 'share' | 'password_verify'
  path TEXT,
  metadata TEXT, -- JSON
  ip_address TEXT,
  user_agent TEXT,
  bytes_transferred INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_logs_user_time ON access_logs(user_id, created_at);
CREATE INDEX idx_logs_action_time ON access_logs(action, created_at);
```

---

## 安全威胁模型

### 威胁分类与防护

#### 1. 认证与授权

**威胁**:
- 暴力破解登录
- JWT令牌泄露
- API密钥泄露
- 会话劫持

**防护**:
```typescript
// 速率限制（登录）
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 15分钟内最多5次
}));

// JWT短期有效（1小时）+ Refresh Token（30天）
const accessToken = await generateAccessToken(user, 3600);
const refreshToken = await generateRefreshToken(user, 2592000);

// API密钥IP白名单
if (apiKey.allowedIps && !apiKey.allowedIps.includes(clientIp)) {
  throw ApiError.forbidden('IP未授权');
}

// CSRF保护
app.use(csrf({
  origin: ['https://picumet.com'],
}));
```

#### 2. 路径遍历攻击

**威胁**:
- `../../etc/passwd`
- `/users/alice2`（prefix攻击）

**防护**:
```typescript
// 路径标准化
export function normalizePath(path: string): string {
  // 移除多余斜杠、解析..、确保以/开头
  const normalized = '/' + path.split('/')
    .filter(segment => segment && segment !== '.')
    .reduce((acc: string[], segment) => {
      if (segment === '..') {
        acc.pop();
      } else {
        acc.push(segment);
      }
      return acc;
    }, [])
    .join('/');
  return normalized || '/';
}

// 路径边界检查（使用路径段匹配）
export function isPathWithinBoundary(path: string, boundary: string): boolean {
  if (boundary === '/') return true;
  if (path === boundary) return true;
  return path.startsWith(boundary + '/'); // 确保 /users/alice 不匹配 /users/alice2
}
```

#### 3. SSRF（服务端请求伪造）

**威胁**:
- 通过自定义Provider URL访问内网
- 通过预签名URL访问元数据服务

**防护**:
```typescript
// Provider URL白名单验证
const ALLOWED_DOMAINS = [
  's3.amazonaws.com',
  'oss-cn-hangzhou.aliyuncs.com',
  'cos.ap-guangzhou.myqcloud.com',
];

function validateProviderUrl(url: string): void {
  const parsed = new URL(url);

  // 拒绝内网IP
  if (isPrivateIP(parsed.hostname)) {
    throw ApiError.badRequest('禁止访问内网地址');
  }

  // 域名白名单
  if (!ALLOWED_DOMAINS.some(domain => parsed.hostname.endsWith(domain))) {
    throw ApiError.badRequest('不支持的存储域名');
  }
}

function isPrivateIP(hostname: string): boolean {
  const privateRanges = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^localhost$/i,
  ];
  return privateRanges.some(range => range.test(hostname));
}
```

#### 4. 对象存储投毒

**威胁**:
- 伪造上传回调（不验证对象是否真实存在）
- 修改文件大小绕过配额

**防护**:
```typescript
// 完成上传时强制HEAD验证
async function completeUpload(sessionId: string, clientEtag: string) {
  const session = await getUploadSession(sessionId);

  // HEAD验证对象真实存在
  const headResult = await provider.headObject(session.objectKey);

  // 验证ETag
  if (headResult.etag !== clientEtag) {
    throw new Error('ETag不匹配');
  }

  // 验证文件大小
  if (headResult.size !== session.fileSize) {
    throw new Error('文件大小不匹配');
  }

  // 原子提交元数据+配额
  await db.transaction(async tx => {
    await tx.insertFileMetadata({ size: headResult.size, etag: headResult.etag });
    await tx.commitQuota(session.userId, headResult.size);
  });
}
```

#### 5. XSS（跨站脚本）

**威胁**:
- 文件名注入`<script>`
- 自定义标题注入恶意代码

**防护**:
```typescript
// 文件名严格验证
export function isValidFileName(name: string): boolean {
  // 禁止: < > : " | ? * 及控制字符
  return /^[^<>:"|?*\x00-\x1F]+$/.test(name);
}

// 前端输出转义（React自动转义）
<div>{escapeHtml(file.customTitle)}</div>

// Content-Type限制
if (file.mimeType === 'text/html') {
  response.headers.set('Content-Type', 'text/plain'); // 强制纯文本
  response.headers.set('X-Content-Type-Options', 'nosniff');
}
```

#### 6. SQL注入

**防护**:
```typescript
// 始终使用参数化查询
const user = await db.prepare(`
  SELECT * FROM users WHERE email = ?
`).bind(email).first();

// ❌ 禁止字符串拼接
// const user = await db.prepare(`SELECT * FROM users WHERE email = '${email}'`).first();
```

#### 7. 速率限制

```typescript
// 全局速率限制
app.use('*', rateLimit({
  windowMs: 60 * 1000,
  max: 100, // 每分钟100次
  keyGenerator: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
}));

// API密钥速率限制
if (apiKey.rateLimitPerMinute) {
  const count = await redis.incr(`ratelimit:${apiKey.id}:${Math.floor(Date.now() / 60000)}`);
  if (count > apiKey.rateLimitPerMinute) {
    throw ApiError.tooManyRequests('API调用频率超限');
  }
}
```

---

## 部署方案

### Cloudflare Workers + Pages

**架构**:
```
用户
 │
 ├─→ Cloudflare Pages (前端)
 │   └─→ https://picumet.com
 │
 └─→ Cloudflare Workers (API)
     └─→ https://api.picumet.com
         ├─→ D1 (数据库)
         ├─→ R2 (对象存储)
         ├─→ KV (会话/缓存)
         └─→ S3/OSS (多云存储)
```

**wrangler.toml**:
```toml
name = "picumet-api"
main = "src/index.ts"
compatibility_date = "2026-08-18"

[env.production]
vars = { ENVIRONMENT = "production" }

[[env.production.d1_databases]]
binding = "DB"
database_name = "picumet-db"
database_id = "xxx"

[[env.production.r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "picumet-storage"

[[env.production.kv_namespaces]]
binding = "KV"
id = "xxx"

[env.production.vars]
JWT_SECRET = "xxx"
FRONTEND_URL = "https://picumet.com"
```

**部署命令**:
```bash
# 后端部署
cd workers
bun run deploy

# 前端部署
cd frontend
bun run build
wrangler pages deploy dist
```

---

## 术语表

| 术语 | 定义 |
|------|------|
| **Principal** | 主体，执行操作的实体（用户、角色、API密钥） |
| **Mount** | 挂载点，将存储Provider映射到虚拟路径 |
| **Provider** | 存储提供商，如R2、S3、OSS |
| **Path Rule** | 路径规则，定义特定路径的权限策略 |
| **Object Key** | 对象键，对象存储中的实际存储路径 |
| **Canonical Path** | 规范化路径，标准化后的虚拟路径 |
| **Upload Session** | 上传会话，跟踪上传状态和配额预留 |
| **Quota Reserved** | 预留配额，上传前锁定的存储空间 |
| **Idempotency Key** | 幂等键，防止重复操作的客户端生成标识 |
| **Download Token** | 下载令牌，短期有效的JWT，用于授权下载 |
| **Share Link** | 分享链接，公开访问文件的短链接 |

---

## 实施路线图

### Phase 1: 核心服务重构（3-4天）

**目标**: 按服务拆分现有代码，建立新架构

- [ ] 创建 `services/` 目录结构
- [ ] 创建 `shared/` 共享代码
- [ ] 重构 **Auth Service**（从 `routes/auth.ts` 迁移）
- [ ] 重构 **Permissions Service**（从 `services/principal.ts` 迁移）
  - [ ] 迁移权限判定算法
  - [ ] 统一权限检查接口
- [ ] 重构 **Files Service**（从 `routes/files.ts` 迁移）
  - [ ] 添加 Zod 验证
  - [ ] 整合元数据操作
- [ ] 更新 `index.ts` 路由组装

**验收标准**:
- 所有现有API正常工作
- 类型安全验证通过
- 单元测试覆盖率 > 80%

### Phase 2: 类型安全与验证（1-2天）

**目标**: 所有API输入/输出类型化

- [ ] 所有handler使用 `@hono/zod-validator`
- [ ] 导出统一的类型定义（`services/*/types.ts`）
- [ ] 配置 Hono RPC 或 openapi-typescript
- [ ] 生成前端类型文件

**验收标准**:
- 前端调用API有完整类型提示
- 无任何 `any` 类型（严格模式）

### Phase 3: 剩余服务实现（2-3天）

- [ ] **Uploads Service** 完整实现
  - [ ] 单文件上传
  - [ ] 分片上传
  - [ ] 配额管理
- [ ] **Shares Service** 完整实现
- [ ] **Storage Service** 多Provider支持
- [ ] **WebDAV Service** 实现

### Phase 4: 测试与优化（2天）

- [ ] 集成测试
- [ ] 性能测试
- [ ] 安全审计
- [ ] 文档完善

---

## 总结

本重构方案将 Picumet 从**技术分层架构**转变为**服务化架构**，核心改进：

1. **按业务领域组织代码**（而非按技术层次）
2. **类型安全贯穿始终**（Zod验证 + TypeScript类型导出）
3. **服务自包含**（handler + schema + logic + types）
4. **清晰的服务依赖关系**（避免循环依赖）
5. **保持 Cloudflare Workers 部署**（无需迁移到其他平台）

**核心原则**:
- ✅ 借鉴 Encore.ts 的组织哲学
- ✅ 保持 Hono + Workers 的技术栈
- ✅ 渐进式重构，风险可控
- ✅ 3-4 天完成核心重构

现有的权限判定算法、上传流程、移动操作Saga等核心逻辑**完全保留**，仅改变代码组织方式。