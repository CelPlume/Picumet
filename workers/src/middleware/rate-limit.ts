// 速率限制中间件：基于 KV 的固定窗口计数（IP + 用户 双层）
import { createMiddleware } from 'hono/factory';
import { SettingsRepo } from '../db';
import { ApiError } from '../shared/errors';
import { fail } from '../shared/response';
import { getDb } from './auth';
import { clientIp } from '../utils/ip';

const DEFAULT_LIMIT = 50;

/** 固定窗口计数的 KV 键（epoch 对齐；重置也需命中同一键） */
function limitCacheKey(key: string, windowMs: number): string {
  const now = Date.now();
  return `rl:${key}:${now - (now % windowMs)}`;
}

/**
 * KV 固定窗口计数（best-effort）。
 * Cloudflare KV 无原子自增：get→put 在并发下可能丢失更新，使实际通过量略超阈值。
 * 该限流定位为 best-effort 保护，不保证严格精确；生产如需强一致请启用
 * Cloudflare Rate Limiting / Durable Object 原子计数。认证与敏感写接口仍 fail-closed。
 */
export async function checkLimit(kv: KVNamespace, key: string, limit: number, windowMs: number): Promise<boolean> {
  const cacheKey = limitCacheKey(key, windowMs);
  const current = Number((await kv.get(cacheKey)) ?? '0');
  if (current >= limit) return false;
  await kv.put(cacheKey, String(current + 1), { expirationTtl: Math.ceil(windowMs / 1000) });
  return true;
}

/**
 * 清空当前窗口的计数（密码验证成功 → 重置失败冷却）。
 * 固定窗口按 epoch 对齐，失败计数只可能落在当前窗口，删除该键即可重新计数。
 */
export async function resetLimit(kv: KVNamespace, key: string, windowMs: number): Promise<void> {
  await kv.delete(limitCacheKey(key, windowMs));
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

    const ip = clientIp(c.req.raw);
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
  const ip = clientIp(c.req.raw);
  const ok = await checkLimit(c.env.KV as KVNamespace, `auth:${ip}`, 5, 60_000);
  if (!ok) {
    return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', '尝试过于频繁，请稍后再试'));
  }
  await next();
});

/**
 * 分享密码验证限流：5 次/分钟/IP/分享（仅生产环境生效）。
 * 全局限流不足以防在线爆破，故按分享维度单独收紧；
 * 存储异常 fail-closed（503），避免限流被绕过。
 */
export const shareVerifyRateLimitMiddleware = createMiddleware(async (c, next) => {
  if ((c.env.ENVIRONMENT as string) !== 'production') {
    await next();
    return;
  }
  const shareId = c.req.param('id') ?? '-';
  const ip = clientIp(c.req.raw);
  try {
    const ok = await checkLimit(c.env.KV as KVNamespace, `sv:${shareId}:${ip}`, 5, 60_000);
    if (!ok) {
      return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', '尝试过于频繁，请稍后再试'));
    }
  } catch {
    return fail(c, new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂不可用，请稍后再试'));
  }
  await next();
});
