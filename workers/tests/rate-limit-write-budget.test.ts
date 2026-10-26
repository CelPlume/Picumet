// KV 写预算回归：通用 API 限额只在越过阈值时持久化，安全敏感计数立即持久化。
// 背景：KV 免费档仅 1,000 写/日，若每个 (key, window) 首请求都写，正常浏览即会打穿配额。
import { describe, it, expect, beforeEach } from 'vitest';
import { checkLimit, resetMemoryLimits } from '../src/middleware/rate-limit';
import { resetKvCircuit, type KvLike } from '../src/utils/kv-store';
import { createTestContext, initSeeded, type TestContext } from './helpers';

/** 计数 KV：记录 put/get 次数，读写均成功 */
function countingKv() {
  const store = new Map<string, string>();
  const calls = { put: 0, get: 0 };
  const kv: KvLike = {
    async put(k, v) {
      calls.put++;
      store.set(k, v);
    },
    async get(k) {
      calls.get++;
      return store.get(k) ?? null;
    },
    async delete(k) {
      store.delete(k);
    },
  };
  return { kv, calls, store };
}

let ctx: TestContext;

beforeEach(async () => {
  resetMemoryLimits();
  resetKvCircuit();
  if (!ctx) {
    ctx = createTestContext();
    await initSeeded(ctx);
  }
});

describe('限流持久化的 KV 写预算', () => {
  it('通用 ip:/user: 限额未越过阈值时不写 KV', async () => {
    const { kv, calls } = countingKv();
    const env = { ...ctx.env, KV: kv } as never;

    // limit 50 -> 阈值 25；前十次请求都应零写入
    for (let i = 0; i < 10; i++) {
      await checkLimit(env, 'ip:203.0.113.9', 50, 60_000);
    }
    expect(calls.put).toBe(0);
  });

  it('通用限额越过阈值后持久化一次（同窗口内不重复写）', async () => {
    const { kv, calls } = countingKv();
    const env = { ...ctx.env, KV: kv } as never;

    for (let i = 0; i < 40; i++) {
      await checkLimit(env, 'ip:203.0.113.10', 50, 60_000);
    }
    // 阈值 25：跨过时写一次；同窗口后续不再写
    expect(calls.put).toBe(1);
  });

  it('安全敏感计数（auth:/sv:/svfail:/rreg:）首请求即持久化', async () => {
    for (const key of ['auth:ip:203.0.113.11', 'auth:id:alice', 'sv:share1:1.2.3.4', 'svfail:share1:1.2.3.4', 'rreg:1.2.3.4']) {
      resetMemoryLimits();
      const { kv, calls } = countingKv();
      const env = { ...ctx.env, KV: kv } as never;
      await checkLimit(env, key, 10, 60_000);
      expect(calls.put, `${key} 必须立即持久化`).toBe(1);
    }
  });

  it('同一窗口内热请求不重复回源（读一次）', async () => {
    const { kv, calls } = countingKv();
    const env = { ...ctx.env, KV: kv } as never;

    for (let i = 0; i < 5; i++) {
      await checkLimit(env, 'ip:203.0.113.12', 50, 60_000);
    }
    expect(calls.get).toBe(1);
  });
});
