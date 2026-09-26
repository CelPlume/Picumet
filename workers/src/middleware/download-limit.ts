// 下载限速：单独限制"下载类请求"的每分钟次数（system_settings.rate_limit_downloads_per_minute）。
//
// 为什么与全局限流分开：全局限流按分钟窗口计所有请求，无法表达"浏览不限、下载受限"这类策略；
// 下载是真正消耗带宽与外网流量的动作，需要独立配额。计数同样是 KV 固定窗口（best-effort），
// 与全局限流的可靠性等级一致；生产环境之外跳过（与其余限流/并发中间件保持一致）。
import { createMiddleware } from 'hono/factory';
import { SettingsRepo } from '../db';
import { ApiError } from '../shared/errors';
import { fail } from '../shared/response';
import { getDb } from './auth';
import { clientIp } from '../utils/ip';

/** 默认每分钟下载次数（0 = 不限） */
export const DEFAULT_DOWNLOAD_LIMIT_PER_MINUTE = 120;

/**
 * 判断是否属于"下载类请求"：下载网关、分享下载/预览（预览同样是出网流量）、
 * 文件下载链接、公开目录的文件直链与 WebDAV GET 由各自调用方挂载本中间件，
 * 这里只做路径兜底判定，便于在 app 级 use 使用。
 */
export function isDownloadPath(path: string): boolean {
  if (path.startsWith('/api/gateway/download/')) return true;
  if (/^\/api\/shares\/[^/]+\/(download|preview)$/.test(path)) return true;
  if (/^\/api\/files\/[^/]+\/download$/.test(path)) return true;
  if (path.startsWith('/api/public/fs')) return true;
  return false;
}

/**
 * 下载限速中间件：读 rate_limit_downloads_per_minute（默认 120，0 = 不限）。
 * 非生产环境跳过；存储异常时 fail-open（限速是资源保护，不是权限闸门）。
 */
export const downloadRateLimitMiddleware = createMiddleware(async (c, next) => {
  if ((c.env.ENVIRONMENT as string) !== 'production') {
    await next();
    return;
  }
  // 只对下载类请求计数：挂载点可能是整个受保护 API / 分享 API，这里按路径窄化
  if (!isDownloadPath(c.req.path)) {
    await next();
    return;
  }
  try {
    const db = getDb(c);
    const raw = await SettingsRepo.get(db, 'rate_limit_downloads_per_minute');
    const limit = raw === null || raw === undefined ? DEFAULT_DOWNLOAD_LIMIT_PER_MINUTE : Number(raw);
    if (Number.isFinite(limit) && limit > 0) {
      const userId = c.get('userId') as string | undefined;
      const owner = userId ? `user:${userId}` : `ip:${clientIp(c.req.raw)}`;
      const now = Date.now();
      const windowStart = now - (now % 60_000);
      const key = `dl:${owner}:${windowStart}`;
      const kv = c.env.KV as KVNamespace;
      const current = Number((await kv.get(key)) ?? '0');
      if (current >= limit) {
        return fail(c, new ApiError(429, 'RATE_LIMIT_EXCEEDED', `下载次数已达上限（${limit} 次/分钟），请稍后再试`));
      }
      await kv.put(key, String(current + 1), { expirationTtl: 60 });
    }
  } catch {
    // 计数存储异常不阻断下载
  }
  await next();
});
