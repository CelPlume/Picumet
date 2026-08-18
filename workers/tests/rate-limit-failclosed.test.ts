// 限流 fail-closed 回归（审计 Fix 6）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, json, type TestContext } from './helpers';
import type { Env } from '../src/types';

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

    // 认证接口：限流存储故障 → 503 fail-closed，防止限流被绕过
    const loginRes = await ctx.app.fetch(
      new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'x', password: 'y' }),
      }),
      env,
      exec
    );
    expect(loginRes.status).toBe(503);
    const loginData = await json(loginRes);
    expect(loginData.error?.code ?? loginData.error).toBe('SERVICE_UNAVAILABLE');

    // 公开只读接口：fail-open 保证可用性
    const pubRes = await ctx.app.fetch(new Request('http://localhost:8787/api/public/settings'), env, exec);
    expect(pubRes.status).toBe(200);
  });
});
