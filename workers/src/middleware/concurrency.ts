// 传输并发限制：同一主体（用户/IP）同时在途的传输请求数上限。
//
// 为什么用 D1 而不是 KV：KV 无原子自增且读缓存最长 60 秒，在途计数会长时间读到旧值，
// 起不到并发限制作用；D1 写会串行化，COUNT 结果可信。计数只加在**传输类**接口
// （上传与下载网关），这些请求持续时间长、真正占用带宽与连接，是并发的实际来源。
//
// 语义：请求进入时占一个名额（INSERT），响应结束（含异常/中断）时释放（DELETE）。
// 超过 TRANSFER_STALE_MS 的槽位视为泄漏（进程被杀/异常退出），在计数时忽略并顺带清理。
import { createMiddleware } from 'hono/factory';
import { SettingsRepo } from '../db';
import { Db } from '../db';
import { ApiError } from '../shared/errors';
import { fail } from '../shared/response';
import { getDb } from './auth';
import { clientIp } from '../utils/ip';
import { uuid } from '../utils/crypto';

/** 默认允许的同时传输数（0 = 不限） */
const DEFAULT_MAX_CONCURRENT = 4;
/** 槽位视为泄漏的时限：超过则不计入并发（也意味着长时间流式下载不会永久占位） */
const TRANSFER_STALE_MS = 30 * 60_000;
/** 清理泄漏槽位的触发间隔（每 N 次请求清一次，尽力而为） */
const CLEANUP_EVERY = 200;

let requestCounter = 0;

async function activeCount(db: Db, scope: string, scopeId: string): Promise<number> {
  const row = await db.first(
    `SELECT COUNT(*) AS c FROM transfer_slots WHERE scope = ? AND scope_id = ? AND created_at > ?`,
    [scope, scopeId, Date.now() - TRANSFER_STALE_MS]
  );
  return Number(row?.c ?? 0);
}

/**
 * 传输并发限制中间件：读 system_settings 的 max_concurrent_transfers（默认 4）。
 * 非生产环境跳过（本地调试/测试不受限），与限流中间件保持一致。
 */
export const transferConcurrencyMiddleware = createMiddleware(async (c, next) => {
  if ((c.env.ENVIRONMENT as string) !== 'production') {
    await next();
    return;
  }
  const db = getDb(c);
  let token: string | null = null;
  try {
    const raw = await SettingsRepo.get(db, 'max_concurrent_transfers');
    const limit = raw === null || raw === undefined ? DEFAULT_MAX_CONCURRENT : Number(raw);
    if (!Number.isFinite(limit) || limit <= 0) {
      await next();
      return;
    }
    const userId = (c.get('userId') as string | undefined) ?? null;
    const scope = userId ? 'user' : 'ip';
    const scopeId = userId ?? clientIp(c.req.raw);

    requestCounter += 1;
    if (requestCounter % CLEANUP_EVERY === 0) {
      await db.run(`DELETE FROM transfer_slots WHERE created_at < ?`, [Date.now() - TRANSFER_STALE_MS]);
    }

    if ((await activeCount(db, scope, scopeId)) >= limit) {
      return fail(c, new ApiError(429, 'CONCURRENCY_LIMIT_EXCEEDED', `同时进行的传输已达上限（${limit}），请等待当前任务完成`));
    }
    token = uuid();
    await db.run(`INSERT INTO transfer_slots (token, scope, scope_id, created_at) VALUES (?, ?, ?, ?)`, [
      token,
      scope,
      scopeId,
      Date.now(),
    ]);
  } catch {
    // 计数存储异常时不阻断传输（并发限制是资源保护，不是权限闸门）
    token = null;
  }

  try {
    await next();
  } finally {
    if (token) {
      try {
        await db.run(`DELETE FROM transfer_slots WHERE token = ?`, [token]);
      } catch {
        // 释放失败交给泄漏清理
      }
    }
  }
});
