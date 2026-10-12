// 限流 fail-closed：限流存储（KV/设置读取）异常时，认证与敏感写接口必须拒绝而非放行。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, json, type TestContext } from './helpers';
import type { Env } from '../src/shared/types';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

describe('限流 fail-closed', () => {
  it('生产环境存储异常时认证接口 503，公开接口放行', async () => {
    const badKV = {
      async get(): Promise<string | null> {
        throw new Error('kv down');
      },
      async put(): Promise<void> {},
      async delete(): Promise<void> {},
      async list(): Promise<{ keys: Array<{ name: string }> }> {
        return { keys: [] };
      },
    } as unknown as KVNamespace;
    const env = { ...ctx.env, ENVIRONMENT: 'production', KV: badKV } as unknown as Env;
    const exec = {} as ExecutionContext;

    // 认证接口：限流存储故障 → 不再 503 硬拒（混合存储把故障降级为「内存计数」，
    // 单 isolate 内限流依然生效），请求进入业务逻辑后因凭证错误返回 401；
    // 连续超限依然会被内存计数器拦成 429（限流不因存储故障而失效）。
    const loginRes = await ctx.app.fetch(
      new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'x', password: 'y' }),
      }),
      env,
      exec
    );
    expect(loginRes.status).toBe(401);
    // 打满标识维度（10 次）后：内存计数接管，仍然 429（限流语义保持）
    for (let i = 0; i < 10; i++) {
      await ctx.app.fetch(
        new Request('http://localhost:8787/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'x', password: 'y' }),
        }),
        env,
        exec
      );
    }
    const limited = await ctx.app.fetch(
      new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'x', password: 'y' }),
      }),
      env,
      exec
    );
    expect(limited.status).toBe(429);

    // 公开只读接口：fail-open 保证可用性
    const pubRes = await ctx.app.fetch(new Request('http://localhost:8787/api/public/settings'), env, exec);
    expect(pubRes.status).toBe(200);
  });
});
