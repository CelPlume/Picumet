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
 * 按 scope 缓存 HybridStore 实例（同一 scope 复用同一个 store）。
 * scope 用于**熔断粒度**：KV 配额耗尽是账号级的，因此所有 scope 共用一个默认 scope，
 * 一旦某个 scope 撞到配额异常，其它 scope 也能立即走 D1，不必逐个再撞一次。
 */
const stores = new Map<string, HybridStore>();

export function kvStoreFor(env: Env, scope = 'default'): HybridStore {
  let s = stores.get(scope);
  if (!s) {
    s = HybridStore.fromEnv(env, scope);
    stores.set(scope, s);
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

/** 进程内短期熔断：配额耗尽后不必每次都先撞一次 KV 异常再回退（省一次往返） */
const kvDownUntil = new Map<string, number>();
const KV_DOWN_WINDOW = 60_000;

function markKvDown(scope: string): void {
  kvDownUntil.set(scope, Date.now() + KV_DOWN_WINDOW);
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
          console.error('[kvstore] put failed, falling back to D1:', key, err);
        }
        markKvDown(this.scope);
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
   * 读取。KV 命中即返回；KV 未命中/不可用时读 D1（过期行顺手删除）。
   */
  async get(kv: KvLike | undefined | null, key: string): Promise<string | null> {
    if (kv && !kvConsiderDown(this.scope)) {
      try {
        const hit = await kv.get(key);
        if (hit !== null && hit !== undefined) return hit;
      } catch (err) {
        if (!isQuotaError(err)) {
          console.error('[kvstore] get failed, falling back to D1:', key, err);
        }
        markKvDown(this.scope);
      }
    }
    const row = await this.db.first('SELECT value, expires_at FROM kv_fallback WHERE key = ? LIMIT 1', [key]);
    if (!row) return null;
    const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
    if (expiresAt !== null && expiresAt <= Date.now()) {
      await this.db.run('DELETE FROM kv_fallback WHERE key = ?', [key]);
      return null;
    }
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
  async purgeExpired(): Promise<number> {
    const res = await this.db.run('DELETE FROM kv_fallback WHERE expires_at IS NOT NULL AND expires_at <= ?', [Date.now()]);
    return res.changes ?? 0;
  }

  /** 统计：当前回退表行数与写入窗口（运维观测 KV 配额压力） */
  async stats(): Promise<{ rows: number; writtenLastHour: number }> {
    const rows = await this.db.first('SELECT COUNT(*) AS c FROM kv_fallback');
    const recent = await this.db.first('SELECT COUNT(*) AS c FROM kv_fallback WHERE created_at > ?', [Date.now() - MINUTE * 60]);
    return { rows: Number(rows?.c ?? 0), writtenLastHour: Number(recent?.c ?? 0) };
  }
}