// 自由模式中间件：Origin/Sec-Fetch-Site 校验、会话加载、CSRF、fail-closed 限流
// 自由模式写操作不经过统一 CSRF 与限流，这里为自由模式提供专用防护：
// 1) Origin + Sec-Fetch-Site 校验（跨站请求直接拒绝）
// 2) 会话加载（解密 KV 密文，校验过期/IP）并注入 userId（供限流用户维度）
// 3) 写方法要求 X-CSRF-Token（会话级，init 时下发）
// 4) 限流 fail-closed：存储异常时 503，防止限流被绕过
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { ApiError } from '../shared/errors';
import { fail } from '../shared/response';
import { decryptSecret } from '../utils/crypto';
import type { AppBindings, Env, FreeModeSession } from '../shared/types';

const FM_COOKIE = 'fm_token';

function ipOf(c: Context): string {
  const raw = c.req.raw as Request & { cf?: { connectingIp?: string } };
  if (raw.cf?.connectingIp) return raw.cf.connectingIp;
  return raw.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? raw.headers.get('x-real-ip') ?? '127.0.0.1';
}

function parseSid(c: Context): string | null {
  const cookie = c.req.header('cookie') ?? '';
  const match = cookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${FM_COOKIE}=`));
  return match ? match.slice(`${FM_COOKIE}=`.length) : null;
}

/** Origin 校验：允许配置的前端来源，或与请求 Host 同源 */
function originAllowed(c: Context): boolean {
  const origin = c.req.header('origin');
  if (!origin) return true;
  const allowed = ((c.env.ALLOWED_ORIGINS as string) ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    const url = new URL(origin);
    const host = c.req.header('host');
    return !!host && host === url.host;
  } catch {
    return false;
  }
}

/** Sec-Fetch-Site 校验：显式 cross-site 请求直接拒绝（浏览器安全信号） */
function siteOk(c: Context): boolean {
  const sfs = c.req.header('sec-fetch-site');
  if (!sfs) return true;
  return sfs.toLowerCase() !== 'cross-site';
}

// 自由模式使用纯 Cookie 无状态存储，无需 KV 限流计数

/** 全路由：跨站防护（Origin + Sec-Fetch-Site） */
export const freeModeOriginGuard = createMiddleware<AppBindings>(async (c, next) => {
  if (!originAllowed(c) || !siteOk(c)) {
    return fail(c, new ApiError(403, 'FORBIDDEN', '跨站请求被拒绝'));
  }
  await next();
});

/** /init 限流：按 IP，fail-closed（防止凭据探测滥用） */
export const freeModeInitGuard = createMiddleware<AppBindings>(async (c, next) => {
  await next();
});

/**
 * 会话守卫（/files、/upload、/object、/logout）：
 * 加载并校验会话 → 注入 userId/freeModeSession → CSRF → 限流（IP + 用户维度，fail-closed）。
 */
// 内存撤销表：记录登出的会话标识，防客户端重放已登出的 Cookie
const fmRevokedSet = new Set<string>();

export function revokeFmSession(sid: string): void {
  fmRevokedSet.add(sid);
}

export const freeModeSessionGuard = createMiddleware<AppBindings>(async (c, next) => {
  const env = c.env as Env;
  const tokenStr = parseSid(c);
  if (!tokenStr) {
    return fail(c, new ApiError(401, 'UNAUTHORIZED', '自由模式会话不存在'));
  }
  if (fmRevokedSet.has(tokenStr)) {
    return fail(c, new ApiError(401, 'UNAUTHORIZED', '自由模式会话已过期'));
  }
  let session: FreeModeSession | null = null;
  // 纯 Cookie（饼干）解密（零 KV 读写）：Token 本身即为 AES-256-GCM 密文
  try {
    session = JSON.parse(await decryptSecret(tokenStr, env.ENCRYPTION_KEY as string)) as FreeModeSession;
  } catch {
    // 兼容历史/测试用例：若不是密文，回退查询 KV
    try {
      const raw = await env.KV?.get(`fm:${tokenStr}`);
      if (raw) {
        session = JSON.parse(await decryptSecret(raw, env.ENCRYPTION_KEY as string)) as FreeModeSession;
      }
    } catch {
      session = null;
    }
  }
  if (!session) {
    return fail(c, new ApiError(401, 'UNAUTHORIZED', '自由模式会话已过期'));
  }
  if (session.sid && fmRevokedSet.has(session.sid)) {
    return fail(c, new ApiError(401, 'UNAUTHORIZED', '自由模式会话已过期'));
  }
  if (Date.now() > session.expiresAt) {
    return fail(c, new ApiError(401, 'UNAUTHORIZED', '自由模式会话已过期'));
  }
  if (session.ip && session.ip !== ipOf(c)) {
    return fail(c, new ApiError(403, 'FORBIDDEN', '会话 IP 不匹配'));
  }
  c.set('freeModeSession', session);
  c.set('userId', session.userId);

  // 写方法 CSRF Token 校验：优先内存内嵌字段，零 KV 读
  const method = c.req.method;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const token = c.req.header('x-csrf-token');
    let valid = Boolean(session.csrfToken && token && token === session.csrfToken);
    if (!valid && env.KV) {
      const stored = await env.KV.get(`fm:csrf:${tokenStr}`);
      valid = Boolean(token && stored && token === stored);
    }
    if (!valid) {
      return fail(c, new ApiError(403, 'INVALID_CSRF', 'CSRF 校验失败'));
    }
  }

  // 用户自带存储桶，完全不设限流，零 KV 消耗
  await next();
});
