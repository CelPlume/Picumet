// SEC-08 回归（审计 §SEC-08）：非 ApiError 的普通 Error 在生产环境不得回传底层异常消息
// 构造方式：测试 app 挂 /throw 路由 + 复用真实 errorHandler（与 src/index.ts 同一装配路径）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../src/middleware/global';
import type { Env } from '../src/shared/types';

// 模拟底层异常中可能出现的内部细节（数据库约束/内网地址）
const LEAKY_MESSAGE = '内部异常细节：SQLITE_CONSTRAINT on 10.0.0.5:5432';

/** 构建 /throw 路由的测试 app 并以指定 ENVIRONMENT 发起请求 */
async function fetchThrow(environment: string): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler);
  app.get('/throw', () => {
    throw new Error(LEAKY_MESSAGE);
  });
  const env = { ENVIRONMENT: environment } as unknown as Env;
  return app.fetch(new Request('http://localhost/throw'), env, {} as ExecutionContext);
}

interface FailBody {
  success: boolean;
  error: { code: string; message: string; details?: unknown };
}

describe('SEC-08：生产错误响应不泄露内部异常', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('development：返回原始 message 与 stack details（现状不变）', async () => {
    const res = await fetchThrow('development');
    expect(res.status).toBe(500);
    const body = await res.json() as FailBody;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe(LEAKY_MESSAGE);
    // stack 以 "Error: <message>" 开头，包含原始消息
    expect(String(body.error.details)).toContain(LEAKY_MESSAGE);
  });

  it('production：message 固定为「服务器内部错误」且无 details，异常写入 console.error 留痕', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetchThrow('production');
    expect(res.status).toBe(500);
    const body = await res.json() as FailBody;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('服务器内部错误');
    expect(body.error.message).not.toContain(LEAKY_MESSAGE);
    expect(body.error.details).toBeUndefined();
    // 生产日志留痕：[api-error] 前缀 + 原始 Error 对象
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('[api-error]');
    expect(errorSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect((errorSpy.mock.calls[0]?.[1] as Error).message).toBe(LEAKY_MESSAGE);
  });
});
