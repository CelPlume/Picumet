// KV ↔ D1 混合存储（迁移 0017）：**KV 优先、D1 自动回退**
//
// 验证三条契约：
// 1. KV 正常时走快路径（不碰 D1）
// 2. KV 抛配额异常时自动落 D1，且 get 能读回（业务不 500）
// 3. KV 未命中但 D1 有值时能读到（跨侧重启/配额切换场景）
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from '../src/db';
import { HybridStore, resetKvCircuit, type KvLike } from '../src/utils/kv-store';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/** 可控 KV：mode='ok' 正常；'quota' 抛配额异常；'readonly' get 恒 miss（模拟已落 D1 的历史数据） */
function makeKv(mode: 'ok' | 'quota' | 'readonly') {
  const store = new Map<string, string>();
  const calls = { put: 0, get: 0, delete: 0 };
  const quotaError = () => {
    const e = new Error('KV put() limit exceeded for the day.');
    return e;
  };
  const kv: KvLike = {
    async put(k, v) {
      calls.put++;
      if (mode === 'quota') throw quotaError();
      store.set(k, v);
    },
    async get(k) {
      calls.get++;
      if (mode === 'quota') throw quotaError();
      if (mode === 'readonly') return null;
      return store.get(k) ?? null;
    },
    async delete(k) {
      calls.delete++;
      if (mode === 'quota') throw quotaError();
      store.delete(k);
    },
  };
  return { kv, store, calls };
}

/** 用 node:sqlite 建一个带 kv_fallback 表的内存库 */
function makeDb(): Db {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(join(MIGRATIONS_DIR, '0001_initial.sql'), 'utf8'));
  const run = (sql: string, params: unknown[] = []) => {
    const st = raw.prepare(sql);
    const r = st.run(...(params as never[]));
    return { changes: Number(r.changes ?? 0) };
  };
  const first = (sql: string, params: unknown[] = []) =>
    (raw.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined) ?? null;
  return {
    run,
    first,
    all: (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ run, first }),
  } as never;
}

describe('KV ↔ D1 混合存储', () => {
  beforeEach(() => resetKvCircuit());

  it('KV 正常：写读都走 KV，不产生 D1 回退行', async () => {
    const store = new HybridStore(makeDb(), 't1');
    const { kv, calls } = makeKv('ok');
    await store.put(kv, 'a:1', 'v1', { expirationTtl: 60 });
    expect(await store.get(kv, 'a:1')).toBe('v1');
    expect(calls.put).toBe(1);
    expect(calls.get).toBe(1);
    expect((await store.stats()).rows).toBe(0);
  });

  it('KV 配额耗尽：put 自动落 D1，get 仍能读回（不抛异常）', async () => {
    const db = makeDb();
    const store = new HybridStore(db, 't2');
    const { kv } = makeKv('quota');
    await expect(store.put(kv, 'sso:state:x', 'payload', { expirationTtl: 60 })).resolves.toBeUndefined();
    // D1 回退表里确实落了一行
    expect(await store.stats()).toMatchObject({ rows: 1 });
    // 读取：KV 抛异常 → 自动改读 D1
    await expect(store.get(kv, 'sso:state:x')).resolves.toBe('payload');
  });

  it('KV 降级/配额耗尽而 D1 有值（配额切换/无 KV 绑定）：能读到回退数据', async () => {
    const db = makeDb();
    const { kv } = makeKv('quota');
    const seeded = new HybridStore(db, 't3');
    await seeded.put(undefined, 'pool:rr:m1', '2', { expirationTtl: 600 });
    const reader = new HybridStore(db, 't3');
    expect(await reader.get(kv, 'pool:rr:m1')).toBe('2');
  });

  it('KV 正常且未命中时直接返回 null，不向 D1 发起额外查询（杜绝行读放大）', async () => {
    const db = makeDb();
    const { kv, calls } = makeKv('ok');
    const store = new HybridStore(db, 't-clean-miss');
    // 预先向 D1 fallback 塞入一条数据
    await db.run(`INSERT INTO kv_fallback (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)`, ['k:orphan', 'val', Date.now() + 60_000, Date.now()]);
    // KV 正常但未命中该 key：必须直接返回 null，绝不能把 D1 的陈旧孤儿行捞出
    expect(await store.get(kv, 'k:orphan')).toBeNull();
    expect(calls.get).toBe(1);
  });

  it('KV 恢复正常后重新走快路径（熔断窗口按 scope 共享，回退行不影响）', async () => {
    const db = makeDb();
    const store = new HybridStore(db, 't4');
    const bad = makeKv('quota');
    await store.put(bad.kv, 'k1', 'v1', { expirationTtl: 60 });
    const good = makeKv('ok');
    // 熔断窗口内直接写 D1（不撞 KV 异常）
    await store.put(good.kv, 'k2', 'v2', { expirationTtl: 60 });
    expect(await store.get(good.kv, 'k1')).toBe('v1');
    expect(await store.get(good.kv, 'k2')).toBe('v2');
    expect((await store.stats()).rows).toBe(2);
  });

  it('过期回退行视为未命中，清理延迟到 purgeExpired', async () => {
    const db = makeDb();
    const store = new HybridStore(db, 't5');
    const { kv } = makeKv('readonly');
    await db.run(
      `INSERT INTO kv_fallback (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      ['exp:1', 'old', Date.now() - 1000, Date.now() - 2000]
    );
    expect(await store.get(kv, 'exp:1')).toBeNull();
    expect((await store.stats()).rows).toBe(1);
    expect(await store.purgeExpired()).toBe(1);
    expect((await store.stats()).rows).toBe(0);
  });

  it('delete 两侧都删', async () => {
    const db = makeDb();
    const store = new HybridStore(db, 't6');
    const bad = makeKv('quota');
    const good = makeKv('ok');
    await store.put(bad.kv, 'd:1', 'x', { expirationTtl: 60 });
    await store.put(good.kv, 'd:2', 'y', { expirationTtl: 60 });
    await store.delete(bad.kv, 'd:1');
    await store.delete(good.kv, 'd:2');
    expect((await store.stats()).rows).toBe(0);
    expect(await store.get(good.kv, 'd:1')).toBeNull();
  });

  it('purgeExpired 清理过期回退行', async () => {
    const db = makeDb();
    const store = new HybridStore(db, 't7');
    await db.run(
      `INSERT INTO kv_fallback (key, value, expires_at, created_at) VALUES (?,?,?,?)`,
      ['p:1', 'v', Date.now() - 1, Date.now()]
    );
    await db.run(
      `INSERT INTO kv_fallback (key, value, expires_at, created_at) VALUES (?,?,?,?)`,
      ['p:2', 'v', Date.now() + 600_000, Date.now()]
    );
    expect(await store.purgeExpired()).toBe(1);
    expect((await store.stats()).rows).toBe(1);
  });

  it('同键重复写覆盖而非堆积（ON CONFLICT）', async () => {
    const db = makeDb();
    const store = new HybridStore(db, 't8');
    const { kv } = makeKv('quota');
    await store.put(kv, 'same', 'v1', { expirationTtl: 60 });
    await store.put(kv, 'same', 'v2', { expirationTtl: 60 });
    expect((await store.stats()).rows).toBe(1);
    expect(await store.get(kv, 'same')).toBe('v2');
  });
});