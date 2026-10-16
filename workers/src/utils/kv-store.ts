// KV ↔ D1 混合存储（迁移 0017）
//
// **KV 优先，D1 自动回退**——不是二选一：
//
//   put:    先写 KV；KV 因配额耗尽抛异常 → 落 D1 kv_fallback 表，业务照常返回成功。
//   get:    先读 KV；未命中或 KV 不可用 → 读 kv_fallback（按 expires_at 判过期）。
//   delete: 两侧都删。
//
// 效果：
//   · 配额未耗尽时走 KV 快路径，零 D1 开销；
//   · 配额耗尽时功能**完整可用**（降级为 D1 存储），接口不再 500；
//   · 配额恢复后自动回到 KV，无需人工干预。
//
// 为什么安全：KV 在本项目中只承载**会话/加速**数据（SSO state、分享鉴权、熔断标记、
// 位置提示、round-robin 计数器），真值都在 D1 或 HMAC 签名里，丢 KV 只会降级不会破坏正确性。
// 本层保证「KV 故障」永远不冒泡成业务异常。
import type { Db } from '../db';
import { Db as DbClass } from '../db';
import type { Env } from '../shared/types';

/**
 * 按 DB binding 与 scope 隔离缓存 HybridStore 实例。
 * 避免同一 isolate 内多租户或测试切换不同 DB 时错误复用首个 DB 实例。
 */
const storesByBinding = new WeakMap<object, Map<string, HybridStore>>();

export function kvStoreFor(env: Env, scope = 'default'): HybridStore {
  const binding = (env.DB as unknown as object) ?? storesByBinding;
  let map = storesByBinding.get(binding);
  if (!map) {
    map = new Map<string, HybridStore>();
    storesByBinding.set(binding, map);
  }
  let s = map.get(scope);
  if (!s) {
    s = HybridStore.fromEnv(env, scope);
    map.set(scope, s);
  }
  return s;
}

/** 最小 KV 契约：只依赖 put/get/delete，Node 端与 workerd 端都能注入 */
export interface KvLike {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

const MINUTE = 60_000;

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /limit exceeded|exceeded the limit|quota|KV .* limit|Too Many/i.test(msg);
}

function redactKey(key: string): string {
  const parts = key.split(':');
  if (parts.length <= 1) return key.slice(0, 8);
  return `${parts[0]}:${parts.length > 2 ? parts[1] + ':***' : '***'}`;
}

/** 配额耗尽后熔断到下一个 UTC 日，避免每分钟重新撞 KV 再回退 D1。 */
const kvDownUntil = new Map<string, number>();
const KV_DOWN_WINDOW = 60_000;
function markKvDown(scope: string, err?: unknown): void {
  const now = Date.now();
  const message = err instanceof Error ? err.message : String(err ?? '');
  const dailyQuota = /limit exceeded|exceeded the limit|for the day|daily.*quota|quota.*exceed/i.test(message);
  const nextUtcDay = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
  kvDownUntil.set(scope, dailyQuota ? nextUtcDay : now + KV_DOWN_WINDOW);
}

function kvConsiderDown(scope: string): boolean {
  const until = kvDownUntil.get(scope);
  if (until && until > Date.now()) return true;
  if (until) kvDownUntil.delete(scope);
  return false;
}

/** 暴露给测试/运维：手动解除熔断 */
export function resetKvCircuit(): void {
  kvDownUntil.clear();
}

export class HybridStore {
  private db: Db;
  private scope: string;

  constructor(db: Db, scope = 'default') {
    this.db = db;
    this.scope = scope;
  }

  /** 从 Env 构造（DB 绑定解析 + 可选 KV 绑定） */
  static fromEnv(env: Env, scope = 'default'): HybridStore {
    return new HybridStore(DbClass.fromAny(env.DB as D1Database), scope);
  }

  /**
   * 写入。KV 成功 → 不碰 D1；KV 抛配额异常 → 落 D1 并返回成功。
   * `kv` 缺省（未绑定）时也直接落 D1。
   */
  async put(kv: KvLike | undefined | null, key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const ttlMs = options?.expirationTtl ? options.expirationTtl * 1000 : undefined;
    if (kv && !kvConsiderDown(this.scope)) {
      try {
        await kv.put(key, value, options);
        return;
      } catch (err) {
        if (!isQuotaError(err)) {
          console.error('[kvstore] put failed, falling back to D1:', redactKey(key), err);
        }
        markKvDown(this.scope, err);
      }
    }
    const now = Date.now();
    await this.db.run(
      `INSERT INTO kv_fallback (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, created_at = excluded.created_at`,
      [key, value, ttlMs ? now + ttlMs : null, now]
    );
  }

  /**
   * 读取。KV 命中即返回；KV 未命中/不可用时读 D1。过期行由定时清理，
   * 不在请求热路径额外发起 DELETE。
   */
  async get(kv: KvLike | undefined | null, key: string): Promise<string | null> {
    if (kv && !kvConsiderDown(this.scope)) {
      try {
        const hit = await kv.get(key);
        // KV 正常运作：命中返回值，未命中直接返回 null（绝不向 D1 fallback 放大行读）
        return hit !== null && hit !== undefined ? hit : null;
      } catch (err) {
        if (!isQuotaError(err)) {
          console.error('[kvstore] get failed, falling back to D1:', redactKey(key), err);
        }
        markKvDown(this.scope, err);
      }
    }
    // 仅当 KV 未绑定或处于配额耗尽熔断期时，才回退查询 D1 降级表
    const row = await this.db.first('SELECT value, expires_at FROM kv_fallback WHERE key = ? LIMIT 1', [key]);
    if (!row) return null;
    const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
    if (expiresAt !== null && expiresAt <= Date.now()) return null;
    return typeof row.value === 'string' ? row.value : null;
  }

  /** 删除：两侧都删，任一侧失败不影响另一侧 */
  async delete(kv: KvLike | undefined | null, key: string): Promise<void> {
    if (kv) {
      try {
        await kv.delete(key);
      } catch {
        // 配额异常时 KV 上本就写不进/删不掉，忽略
      }
    }
    await this.db.run('DELETE FROM kv_fallback WHERE key = ?', [key]);
  }

  /** 清理过期回退行（定时任务调用） */
  async purgeExpired(limit = 200): Promise<number> {
    const res = await this.db.run(
      `DELETE FROM kv_fallback
       WHERE rowid IN (
         SELECT rowid FROM kv_fallback
         WHERE expires_at IS NOT NULL AND expires_at <= ?
         LIMIT ?
       )`,
      [Date.now(), limit]
    );
    return res.changes ?? 0;
  }

  /** 统计：当前回退表行数与写入窗口（运维观测 KV 配额压力） */
  async stats(): Promise<{ rows: number; writtenLastHour: number }> {
    const rows = await this.db.first('SELECT COUNT(*) AS c FROM kv_fallback');
    const recent = await this.db.first('SELECT COUNT(*) AS c FROM kv_fallback WHERE created_at > ?', [Date.now() - MINUTE * 60]);
    return { rows: Number(rows?.c ?? 0), writtenLastHour: Number(recent?.c ?? 0) };
  }
}