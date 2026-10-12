// 2FA 登录链路回归：
// - 登录是未认证端点，不挂 CSRF 门禁（前端显式 skipCsrf）——未带 X-CSRF-Token 必须能登录成功；
// - 开启 2FA 后：无码 → 403 TOTP_REQUIRED；对码/对备用码 → 200；
// - 第二步请求同样不带 CSRF 头（浏览器此时无会话），验证不会因 CSRF 被拦。
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/shared/types';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;

/** 生产环境登录请求（2FA 限流与断言与线上一致），不带任何 CSRF 头 */
async function prodLogin(body: Record<string, unknown>): Promise<Response> {
  const req = new Request('http://localhost:8787/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return ctx.app.fetch(req, { ...ctx.env, ENVIRONMENT: 'production' } as unknown as Env, {} as ExecutionContext);
}

describe('2FA 登录（未认证端点不依赖 CSRF）', () => {
  it('无 CSRF 头也能完成密码登录 → TOTP_REQUIRED → 对码登录成功', async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    const { authCookie } = await registerAndLogin(ctx, 'login_totp', 'password123');
    const csrf = await getCsrf(ctx, authCookie);

    // 启用 2FA
    const setupRes = await request(ctx, '/api/users/2fa/setup', { method: 'POST', cookie: authCookie, headers: { 'X-CSRF-Token': csrf } });
    const { secret } = (await json<{ data: { secret: string } }>(setupRes)).data;
    // otpauth 生成对码（与服务端同款参数）
    const OTPAuth = await import('otpauth');
    const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
    await request(ctx, '/api/users/2fa/enable', { method: 'POST', cookie: authCookie, headers: { 'X-CSRF-Token': csrf }, body: { code: totp.generate() } });

    // 第一步：密码正确、无码、无 CSRF → 403 TOTP_REQUIRED（而非 403 CSRF）
    const step1 = await prodLogin({ username: 'login_totp', password: 'password123' });
    expect(step1.status).toBe(403);
    expect((await json<{ error: { code: string } }>(step1)).error.code).toBe('TOTP_REQUIRED');

    // 第二步：带对码、同样无 CSRF → 200 登录成功
    const step2 = await prodLogin({ username: 'login_totp', password: 'password123', totpCode: totp.generate() });
    expect(step2.status).toBe(200);
    expect(step2.headers.get('set-cookie')).toContain('auth_token=');
  });
});