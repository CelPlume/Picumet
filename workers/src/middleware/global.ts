// 全局中间件：请求上下文初始化、统一错误处理、安全头
import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Db } from '../db';
import { fail } from '../utils/response';
import { ApiError, isApiError } from '../utils/errors';
import { uuid } from '../utils/crypto';

/** 初始化请求上下文（Db、requestId） */
export const initContext = createMiddleware(async (c, next) => {
  c.set('requestId', uuid());
  if (!c.get('db')) {
    c.set('db', Db.fromAny(c.env.DB as D1Database));
  }
  c.header('X-Request-Id', c.get('requestId'));
  await next();
});

/** 统一错误处理 */
export const errorHandler = async (err: Error, c: Context) => {
  if (isApiError(err)) {
    return fail(c, err);
  }
  // 路径非法（遍历防护）
  if (err.name === 'PathError') {
    return fail(c, new ApiError(400, 'INVALID_PATH', err.message));
  }
  // 路由未匹配
  if (err.message === 'Not Found') {
    return fail(c, new ApiError(404, 'NOT_FOUND', '接口不存在'));
  }
  // 请求体解析失败
  if (err.message?.includes('JSON') || err.name === 'SyntaxError') {
    return fail(c, new ApiError(400, 'VALIDATION_ERROR', '请求体格式错误'));
  }
  return fail(c, err);
};

/** 安全响应头 */
export const securityHeaders = async (c: Context, next: Next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "media-src 'self' blob: https:",
      "frame-src https://challenges.cloudflare.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  await next();
};

/** CORS：仅允许配置的来源 */
export const corsHeaders = async (c: Context, next: Next) => {
  const allowed = ((c.env.ALLOWED_ORIGINS as string) ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = c.req.header('origin');
  if (origin && allowed.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  await next();
};
