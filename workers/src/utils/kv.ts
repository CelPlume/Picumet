// KV 写入容错：转发到 KV↔D1 混合存储（迁移 0017）
//
// 见 utils/kv-store.ts 的完整说明：**KV 优先、D1 自动回退**，不是二选一。
// 本文件保留 kvPut/kvDelete/kvGet 三个薄封装，供既有调用点零改动迁移；
// 无 D1 上下文时退化为「失败即跳过」，行为与之前一致。
import { HybridStore, type KvLike } from './kv-store';

export { HybridStore, type KvLike } from './kv-store';

/** 单例缓存：同一 Worker isolate 内复用同一个 store（Db 实例可共享） */
const storeCache = new WeakMap<object, HybridStore>();

function storeFor(db?: unknown): HybridStore | null {
  if (!db || typeof db !== 'object') return null;
  const key = db as object;
  let s = storeCache.get(key);
  if (!s) {
    s = new HybridStore(db as never, 'shared');
    storeCache.set(key, s);
  }
  return s;
}

/** 写入 KV（配额耗尽自动落 D1）；无 store 时静默跳过 */
export async function kvPut(
  kv: KvLike | undefined | null,
  key: string,
  value: string,
  options?: { expirationTtl?: number },
  db?: unknown
): Promise<boolean> {
  const s = storeFor(db);
  if (!s) {
    try {
      if (!kv) return false;
      await kv.put(key, value, options);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await s.put(kv, key, value, options);
    return true;
  } catch (err) {
    console.error('[kv] put failed:', key, err);
    return false;
  }
}

/** 读取 KV（未命中自动查 D1 回退行） */
export async function kvGet(kv: KvLike | undefined | null, key: string, db?: unknown): Promise<string | null> {
  const s = storeFor(db);
  if (!s) {
    try {
      return kv ? await kv.get(key) : null;
    } catch {
      return null;
    }
  }
  try {
    return await s.get(kv, key);
  } catch (err) {
    console.error('[kv] get failed:', key, err);
    return null;
  }
}

/** 删除 KV（两侧都删） */
export async function kvDelete(kv: KvLike | undefined | null, key: string, db?: unknown): Promise<boolean> {
  const s = storeFor(db);
  if (!s) {
    try {
      if (kv) await kv.delete(key);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await s.delete(kv, key);
    return true;
  } catch (err) {
    console.error('[kv] delete failed:', key, err);
    return false;
  }
}