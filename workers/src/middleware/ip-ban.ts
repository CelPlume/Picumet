// IP 封禁全局门禁：命中封禁名单的请求一律 403 通用文案（不透露命中原因，防枚举）
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { IpBanRepo } from '../db';
import { fail } from '../shared/response';
import { ApiError } from '../shared/errors';
import { getDb } from './auth';
import { clientIp } from '../utils/ip';
import type { AppBindings, Env } from '../shared/types';

type AppContext = Context<AppBindings>;

/**
 * IP 封禁门禁：命中封禁名单的请求一律 403 通用文案（不透露命中原因，防枚举）。
 * 管理员豁免（防运维自锁；SDNUChronoSync 同语义）：optionalAuth 已解析会话时跳过。
 * 存储异常 fail-open（可用性优先）：封禁名单是运维态势手段而非数据权限闸门，
 * D1/KV 故障时放行由后续认证/限流/配额链路兜底。
 */
export const ipBanMiddleware = createMiddleware(async (c: AppContext, next) => {
  if (c.get('user')?.role === 'admin') {
    await next();
    return;
  }
  const ip = clientIp(c.req.raw);
  try {
    const db = getDb(c);
    if (await IpBanRepo.isBanned(db, c.env.KV as KVNamespace, ip)) {
      // 通用文案：不透露「IP 被封禁」及原因，防名单枚举
      return fail(c, new ApiError(403, 'FORBIDDEN', '请求被拒绝'));
    }
  } catch {
    await next();
    return;
  }
  await next();
});
