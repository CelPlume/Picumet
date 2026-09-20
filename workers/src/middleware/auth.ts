// 认证中间件：JWT Cookie（Web 前端）、API Key Bearer/Basic（脚本/PicGo）
import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Db, UserRepo, ApiKeyRepo } from '../db';
import { verifyJwt, sha256Hex } from '../utils/crypto';
import { ApiError } from '../shared/errors';
import { fail } from '../shared/response';
import type { ApiKey } from '@shared/types';
import type { AppBindings, AppVariables, Env } from '../shared/types';

type AppContext = Context<AppBindings>;

function getDb(c: AppContext): Db {
  let db = c.get('db') as Db | undefined;
  if (!db) {
    db = Db.fromAny(c.env.DB as D1Database);
    c.set('db', db);
  }
  return db;
}

function getClientIp(c: AppContext): string {
  const cf = (c.req.raw as Request & { cf?: { connectingIp?: string } }).cf;
  if (cf?.connectingIp) return cf.connectingIp;
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return c.req.header('x-real-ip') ?? '127.0.0.1';
}

function readCookieToken(c: AppContext): string | null {
  const cookie = c.req.header('cookie');
  if (!cookie) return null;
  const match = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('auth_token='));
  return match ? match.slice('auth_token='.length) : null;
}

/**
 * 用户认证中间件：要求 JWT Cookie，且用户状态有效、角色一致。
 */
export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  const db = getDb(c);
  const token = readCookieToken(c);
  if (!token) {
    return fail(c, new ApiError(401, 'UNAUTHORIZED', '未登录'));
  }
  const payload = await verifyJwt(token, [c.env.JWT_SECRET as string, (c.env.JWT_SECRET_OLD as string) ?? '']);
  if (!payload) {
    return fail(c, new ApiError(401, 'INVALID_TOKEN', '登录已过期，请重新登录'));
  }
  const user = await UserRepo.getUserById(db, payload.sub);
  if (!user || user.status !== 'active') {
    return fail(c, new ApiError(401, 'USER_DISABLED', '账号不可用'));
  }
  if (user.role !== payload.role) {
    return fail(c, new ApiError(401, 'ROLE_CHANGED', '账号角色已变更，请重新登录'));
  }
  // 会话撤销（审计 H-05）：JWT 中的会话版本必须与当前一致，否则旧会话已失效
  const tokenSv = payload.sv ?? 0;
  if (tokenSv !== user.sessionVersion) {
    return fail(c, new ApiError(401, 'SESSION_REVOKED', '会话已失效，请重新登录'));
  }
  c.set('userId', user.id);
  c.set('userRole', user.role);
  c.set('user', {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
    defaultPath: user.defaultPath,
    locale: user.locale,
    theme: user.theme,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    capabilities: user.capabilities,
  });
  await next();
});

/** 管理员中间件：要求 admin 角色 */
export const adminMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  const role = c.get('userRole');
  if (role !== 'admin') {
    return fail(c, new ApiError(403, 'FORBIDDEN', '需要管理员权限'));
  }
  await next();
});

export interface ApiKeyAuthResult {
  userId: string;
  username: string;
  apiKeyId: string;
  permissions: string[];
  protocols: string[];
  uploadPath: string;
}

/** 守卫返回值：null 表示通过；Response 表示应直接返回的错误响应 */
type GuardResult = Response | null;

/** 按 token（pk.sk）解析密钥行；格式非法或不存在返回 null */
export async function resolveApiKeyByToken(db: Db, token: string): Promise<ApiKey | null> {
  if (!/^pk_[a-zA-Z0-9]+\.sk_[a-zA-Z0-9]+$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  return ApiKeyRepo.getKeyByTokenHash(db, tokenHash);
}

/** 密钥可用性：状态 / 过期 / IP 白名单（fail-closed，不可绕过） */
export async function ensureApiKeyUsable(c: AppContext, apiKey: ApiKey): Promise<GuardResult> {
  if (apiKey.status !== 'active') {
    return fail(c, new ApiError(401, 'INVALID_TOKEN', 'API 密钥无效或已撤销'));
  }
  if (apiKey.expiresAt && Date.now() > apiKey.expiresAt) {
    return fail(c, new ApiError(401, 'INVALID_TOKEN', 'API 密钥已过期'));
  }
  if (apiKey.allowedIps && apiKey.allowedIps.length > 0) {
    const clientIp = getClientIp(c);
    if (!apiKey.allowedIps.includes(clientIp)) {
      return fail(c, new ApiError(403, 'FORBIDDEN', '该 API 密钥不允许从当前 IP 使用'));
    }
  }
  return null;
}

/** 认证成功：touch、校验所有者、注入 principal 上下文 */
export async function applyApiKeyContext(c: AppContext, db: Db, apiKey: ApiKey): Promise<GuardResult> {
  await ApiKeyRepo.touchKey(db, apiKey.id);
  const owner = await UserRepo.getUserById(db, apiKey.userId);
  if (!owner || owner.status !== 'active') {
    return fail(c, new ApiError(401, 'USER_DISABLED', '密钥所属账号不可用'));
  }
  c.set('userId', owner.id);
  c.set('userRole', owner.role);
  c.set('apiKey', {
    id: apiKey.id,
    keyId: apiKey.keyId,
    userId: apiKey.userId,
    permissions: apiKey.permissions,
    protocols: apiKey.protocols,
    uploadPath: apiKey.uploadPath,
    allowedIps: apiKey.allowedIps,
    expiresAt: apiKey.expiresAt,
  });
  c.set('user', {
    id: owner.id,
    username: owner.username,
    email: owner.email,
    emailVerified: owner.emailVerified,
    role: owner.role,
    defaultPath: owner.defaultPath,
    locale: owner.locale,
    theme: owner.theme,
    status: owner.status,
  });
  return null;
}

/**
 * API 密钥认证（可选）：支持 Bearer pk_x.sk_y 与 WebDAV Basic base64(keyId:secret)。
 * 认证成功设置 principal 变量；未提供时放行（由具体路由决定是否需要）。
 */
export const apiKeyAuthMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  const db = getDb(c);
  const authHeader = c.req.header('authorization');
  let token: string | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (authHeader?.startsWith('Basic ')) {
    try {
      const creds = atob(authHeader.slice(6).trim());
      const [keyId, secret] = creds.split(':');
      if (keyId && secret) token = `${keyId}.${secret}`;
    } catch {
      token = null;
    }
  }

  if (token) {
    if (!/^pk_[a-zA-Z0-9]+\.sk_[a-zA-Z0-9]+$/.test(token)) {
      return fail(c, new ApiError(401, 'INVALID_TOKEN', '无效的 API 密钥格式'));
    }
    const apiKey = await resolveApiKeyByToken(db, token);
    if (!apiKey) {
      return fail(c, new ApiError(401, 'INVALID_TOKEN', 'API 密钥无效或已撤销'));
    }
    const guard = await ensureApiKeyUsable(c, apiKey);
    if (guard) return guard;
    const applied = await applyApiKeyContext(c, db, apiKey);
    if (applied) return applied;
  }

  await next();
});

/**
 * API 密钥认证（必需）：在 Bearer/Basic 之外接受裸 token（AList `Authorization: <token>`、
 * Lsky 用户自填 token 的风格）。用于 /api/v1（Lsky 壳）与 /openlist（AList shim）。
 */
export const apiKeyTokenAuthMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  const db = getDb(c);
  const authHeader = c.req.header('authorization');
  let token: string | null = null;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (authHeader?.startsWith('Basic ')) {
    try {
      const creds = atob(authHeader.slice(6).trim());
      const [keyId, secret] = creds.split(':');
      if (keyId && secret) token = `${keyId}.${secret}`;
    } catch {
      token = null;
    }
  } else if (authHeader) {
    token = authHeader.trim();
  }
  if (!token) {
    return fail(c, new ApiError(401, 'UNAUTHORIZED', '需要 API 密钥认证'));
  }
  const apiKey = await resolveApiKeyByToken(db, token);
  if (!apiKey) {
    return fail(c, new ApiError(401, 'INVALID_TOKEN', 'API 密钥无效或已撤销'));
  }
  const guard = await ensureApiKeyUsable(c, apiKey);
  if (guard) return guard;
  const applied = await applyApiKeyContext(c, db, apiKey);
  if (applied) return applied;
  await next();
});

/**
 * 协议面校验（P1-2）：protocols 非空时必须包含目标协议面，防止 api-only 密钥走 WebDAV 等
 * 越面使用。空 protocols（理论不存在，创建 schema min(1)）视为全量放行以兼容存量数据。
 */
export function assertApiKeyProtocol(apiKey: { protocols: string[] } | undefined, protocol: string): void {
  if (apiKey && apiKey.protocols.length > 0 && !apiKey.protocols.includes(protocol)) {
    throw new ApiError(403, 'FORBIDDEN', `该密钥未授权 ${protocol} 协议`);
  }
}

/** 宽松认证：已登录则填充用户信息，未登录继续（用于公开/半公开路由） */
export const optionalAuthMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  const db = getDb(c);
  const token = readCookieToken(c);
  if (token) {
    const payload = await verifyJwt(token, [c.env.JWT_SECRET as string, (c.env.JWT_SECRET_OLD as string) ?? '']);
    if (payload) {
      const user = await UserRepo.getUserById(db, payload.sub);
      // 会话撤销（审计 H-05）：旧 JWT 不填充用户信息
      const tokenSv = payload.sv ?? 0;
      if (user && user.status === 'active' && user.role === payload.role && tokenSv === user.sessionVersion) {
        c.set('userId', user.id);
        c.set('userRole', user.role);
        c.set('user', {
          id: user.id,
          username: user.username,
          email: user.email,
          emailVerified: user.emailVerified,
          role: user.role,
          defaultPath: user.defaultPath,
          locale: user.locale,
          theme: user.theme,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          status: user.status,
          capabilities: user.capabilities,
        });
      }
    }
  }
  await next();
});

export { getDb, getClientIp, readCookieToken };
