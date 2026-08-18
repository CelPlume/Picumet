// 速率限制中间件：基于 KV 的固定窗口计数（IP + 用户 双层）
import { createMiddleware } from 'hono/factory';
import { SettingsRepo } from '../db';
import { ApiError } from '../shared/errors';
import { fail } from '../shared/response';
import { getDb, getClientIp } from './auth';

const DEFAULT_LIMIT = 50;

/**
 * KV 固定窗口计数（审计 M-01：best-effort）。
 * Cloudflare KV 无原子自增：get→put 在并发下可能丢失更新，使实际通过量略超阈值。
 * 该限流定位为 best-effort 保护，不保证严格精确；生产如需强一致请启用
 * Cloudflare Rate Limiting / Durable Object 原子计数。认证与敏感写接口仍 fail-closed。
 */
async function checkLimit(kv: KVNamespace, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  const cacheKey = `rl:${key}:${windowStart}`;
  const current = Number((await kv.get(cacheKey)) ?? '0');
  if (current >= limit) return false;
  await kv.put(cacheKey, String(current + 1), { expirationTtl: Math.ceil(windowMs / 1000) });
  return true;
}

/**
 * 全局限流：读 system_settings 的 rate_limit_enabled / rate_limit_requests_per_minute。
 * 非生产环境（开发/测试）跳过，避免误伤本地调试。
 * 存储异常时：认证/敏感写接口 fail-closed（503），其余 fail-open。
 */
export const rateLimitMiddleware = createMiddleware(async (c, next) => {
  if ((c.env.ENVIRONMENT as string) !== 'production') {
    await next();
    return;
  }
  const path = c.req.path;
  const sensitive = /\/api\/auth\/(login|register|forgot-password|reset-password)$/.test(path);
  try {
    const db = getDb(c);
    const enabledRaw = await SettingsRepo.get(db, 'rate_limit_enabled');
    if (enabledRaw === 'false') {
      await next();
      return;
    }
    const limitRaw = await SettingsRepo.get(db, 'rate_limit_requests_per_minute');
    const limit = limitRaw ? Number(limitRaw) || DEFAULT_LIMIT : DEFAULT_LIMIT;

    const ip = getClientIp(c);
    const ipOk = await checkLimit(c.env.KV as KVNamespace, `ip:${ip}`, limit, 60_000);
    if (!ipOk) {
      return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', '请求过于频繁，请稍后再试'));
    }
    const userId = c.get('userId') as string | undefined;
    if (userId) {
      const userOk = await checkLimit(c.env.KV as KVNamespace, `user:${userId}`, limit * 2, 60_000);
      if (!userOk) {
        return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', '请求过于频繁，请稍后再试'));
      }
    }
    await next();
  } catch {
    // 存储异常：认证/敏感写接口 fail-closed，防止限流被绕过；其余接口 fail-open 保证可用性
    if (sensitive) {
      return fail(c, new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂不可用，请稍后再试'));
    }
    await next();
  }
});

/**
 * 登录/注册限流：5 次/分钟/IP（仅生产环境生效）
 */
export const authRateLimitMiddleware = createMiddleware(async (c, next) => {
  if ((c.env.ENVIRONMENT as string) !== 'production') {
    await next();
    return;
  }
  const ip = getClientIp(c);
  const ok = await checkLimit(c.env.KV as KVNamespace, `auth:${ip}`, 5, 60_000);
  if (!ok) {
    return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', '尝试过于频繁，请稍后再试'));
  }
  await next();
});
