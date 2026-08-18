// 认证中间件：JWT Cookie（Web 前端）、API Key Bearer/Basic（脚本/PicGo）
import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Db, UserRepo, ApiKeyRepo } from '../db';
import { verifyJwt, sha256Hex } from '../utils/crypto';
import { ApiError } from '../utils/errors';
import { fail } from '../utils/response';
import type { AppBindings, AppVariables, Env } from '../types';

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
    const tokenHash = await sha256Hex(token);
    const apiKey = await ApiKeyRepo.getKeyByTokenHash(db, tokenHash);
    if (!apiKey || apiKey.status !== 'active') {
      return fail(c, new ApiError(401, 'INVALID_TOKEN', 'API 密钥无效或已撤销'));
    }
    if (apiKey.expiresAt && Date.now() > apiKey.expiresAt) {
      return fail(c, new ApiError(401, 'INVALID_TOKEN', 'API 密钥已过期'));
    }
    // 强制执行 IP 白名单：不在白名单内的客户端 IP 直接拒绝，不可绕过
    if (apiKey.allowedIps && apiKey.allowedIps.length > 0) {
      const clientIp = getClientIp(c);
      if (!apiKey.allowedIps.includes(clientIp)) {
        return fail(c, new ApiError(403, 'FORBIDDEN', '该 API 密钥不允许从当前 IP 使用'));
      }
    }
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
  }

  await next();
});

/** 宽松认证：已登录则填充用户信息，未登录继续（用于公开/半公开路由） */
export const optionalAuthMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  const db = getDb(c);
  const token = readCookieToken(c);
  if (token) {
    const payload = await verifyJwt(token, [c.env.JWT_SECRET as string, (c.env.JWT_SECRET_OLD as string) ?? '']);
    if (payload) {
      const user = await UserRepo.getUserById(db, payload.sub);
      if (user && user.status === 'active' && user.role === payload.role) {
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
        });
      }
    }
  }
  await next();
});

export { getDb, getClientIp, readCookieToken };
