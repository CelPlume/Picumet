// 全局中间件：请求上下文初始化、统一错误处理、安全头
import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Db } from '../db';
import { fail } from '../shared/response';
import { ApiError, isApiError } from '../shared/errors';
import { uuid } from '../utils/crypto';
import { loadCorsOrigins, originMatches, parseOriginList } from '../utils/cors';

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
      // L-1：移除 script-src 的 unsafe-inline（仅保留 self + Turnstile 挑战域）
      "script-src 'self' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "media-src 'self' blob: https:",
      // Turnstile 挑战运行在 challenges.cloudflare.com 创建的 blob: iframe 中——
      // 缺 frame-src 时回落 default-src 'self'，挑战 iframe 被 CSP 静默拦截（小部件空白）
      "frame-src https://challenges.cloudflare.com blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  await next();
};

/**
 * 计算请求应携带的 CORS 头（白名单不命中返回 null）。
 * 独立于中间件导出：S3 根路径网关等「自行返回 Response」的入口也需要把同一组
 * CORS 头合并到实际响应上（浏览器要求预检与实际响应都带 ACAO）。
 */
export async function corsHeadersFor(c: Context): Promise<Record<string, string> | null> {
  const origin = c.req.header('origin');
  if (!origin) return null;
  const host = c.req.header('host');
  const sameHost = !!(host && (origin === `https://${host}` || origin === `http://${host}`));
  let isAllowed = sameHost;
  if (!isAllowed) {
    // 精确命中环境变量（快速路径，零额外查询）→ 否则查设置表白名单（含通配，60s 进程缓存）
    const envList = parseOriginList((c.env.ALLOWED_ORIGINS as string) ?? 'http://localhost:5173');
    isAllowed = envList.includes(origin);
    if (!isAllowed) {
      const whitelist = await loadCorsOrigins(c.get('db') as Db, c.env as { ALLOWED_ORIGINS?: string });
      isAllowed = whitelist.some((entry) => originMatches(origin, entry));
    }
  }
  if (!isAllowed) return null;
  // 反射命中的来源（通配命中时不能回写通配符字面量，浏览器只接受精确值）；
  // 预检请求的 Access-Control-Request-Headers 原样回显：Outline/PicList 等 S3 直传
  // 客户端会带 cache-control / content-disposition 等签名头，固定清单会把它们挡死
  const reqHeaders = c.req.header('access-control-request-headers');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': reqHeaders?.trim() || 'Content-Type, Authorization, X-CSRF-Token',
    Vary: 'Origin',
  };
}

/** CORS：环境变量 + 设置表白名单（支持 https://*.example.com 通配，命中裸域与子域）+ 同源回退 */
export const corsHeaders = async (c: Context, next: Next) => {
  const headers = await corsHeadersFor(c);
  if (headers) {
    for (const [k, v] of Object.entries(headers)) c.header(k, v);
  }
  // 仅拦截浏览器预检（带 Origin）；无 Origin 的 OPTIONS（WebDAV/S3 能力探测）放行到具体路由
  if (c.req.method === 'OPTIONS' && c.req.header('origin')) {
    return c.body(null, 204);
  }
  await next();
};
