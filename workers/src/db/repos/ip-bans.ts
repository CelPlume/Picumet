// IP 封禁仓库：名单增删查 + 命中判定（KV 缓存名单，写时失效）
import type { Db } from '../db';
import { num, str } from '../row';
import { uuid } from '../../utils/crypto';

/** ip_bans 行（管理端列表与审计消费） */
export interface IpBan {
  id: string;
  ip: string;
  reason?: string;
  /** 创建人用户 id */
  createdBy: string;
  createdAt: number;
  /** NULL = 永久封禁 */
  expiresAt: number | null;
}

// 进程内内存名单缓存（60s TTL，写时主动失效，零 KV 读写消耗）
let memoryBanCache: { ips: string[]; expiresAt: number } | null = null;
const IP_BAN_CACHE_TTL_MS = 60_000;

/** 失效内存名单缓存（可选接收 kv 兼容既有调用点） */
export async function invalidateIpBanCache(_kv?: unknown): Promise<void> {
  memoryBanCache = null;
}

export const IpBanRepo = {
  /** 新增封禁（expiresAt 缺省 = 永久）；写入后失效 KV 名单缓存 */
  async add(db: Db, _kv: unknown, input: { ip: string; reason?: string; createdBy: string; expiresAt?: number | null }): Promise<IpBan> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO ip_bans (id, ip, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.ip, input.reason ?? null, input.createdBy, now, input.expiresAt ?? null]
    );
    await invalidateIpBanCache();
    return { id, ip: input.ip, reason: input.reason, createdBy: input.createdBy, createdAt: now, expiresAt: input.expiresAt ?? null };
  },

  /** 删除封禁行；写入后失效 KV 名单缓存（行不存在静默幂等） */
  async remove(db: Db, _kv: unknown, id: string): Promise<void> {
    await db.run('DELETE FROM ip_bans WHERE id = ?', [id]);
    await invalidateIpBanCache();
  },

  /** 管理端全量列表（量小：按攻击态势手工维护，不分页），新封在前 */
  async list(db: Db): Promise<IpBan[]> {
    const rows = await db.all('SELECT * FROM ip_bans ORDER BY created_at DESC');
    return rows.map((row) => ({
      id: str(row.id)!,
      ip: str(row.ip)!,
      reason: str(row.reason),
      createdBy: str(row.created_by)!,
      createdAt: num(row.created_at),
      expiresAt: row.expires_at === null || row.expires_at === undefined ? null : num(row.expires_at),
    }));
  },

  /**
   * 命中判定：优先 KV 缓存名单（缓存值只含「此刻未过期」的 IP），
   * 未命中回源 D1 并回填缓存；D1 异常由调用方（ipBanMiddleware）决定放行策略。
   */
  async isBanned(db: Db, _kv: unknown, ip: string, now = Date.now()): Promise<boolean> {
    if (memoryBanCache && now < memoryBanCache.expiresAt) {
      return memoryBanCache.ips.includes(ip);
    }
    const rows = await db.all(
      'SELECT ip FROM ip_bans WHERE expires_at IS NULL OR expires_at > ?',
      [now]
    );
    const active = rows.map((r) => str(r.ip)!);
    memoryBanCache = { ips: active, expiresAt: now + IP_BAN_CACHE_TTL_MS };
    return active.includes(ip);
  },
};
