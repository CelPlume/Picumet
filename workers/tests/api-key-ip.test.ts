// API Key IP 白名单回归（审计 Fix 2）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

describe('API Key IP 白名单', () => {
  it('白名单外 IP 被 403 拒绝，白名单内 IP 放行', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'ipowner');
    const csrf = await getCsrf(ctx, authCookie);
    const createRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'ip-locked', permissions: ['write', 'read'], protocols: ['api'], uploadPath: '/uploads', allowedIps: ['203.0.113.9'] },
    });
    expect(createRes.status).toBe(201);
    const createData = await json(createRes);
    const fullToken = createData.data.key.fullToken as string;
    await grantApiKeyRule(ctx, createData.data.key.keyId as string, ['write', 'read'], '/uploads/**');

    const form = new FormData();
    form.append('file', new File([new Blob(['ip-content'])], 'ip.txt', { type: 'text/plain' }));

    // 白名单外 IP → 403
    const denied = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'X-Forwarded-For': '198.51.100.7' },
      body: form,
    });
    expect(denied.status).toBe(403);
    const deniedData = await json(denied);
    expect(deniedData.error?.code ?? deniedData.error).toBe('FORBIDDEN');

    // 白名单内 IP → 放行
    const allowed = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'X-Forwarded-For': '203.0.113.9' },
      body: form,
    });
    expect(allowed.status).toBe(200);
  });

  it('未配置白名单的密钥不限制来源 IP', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'ipopen');
    const csrf = await getCsrf(ctx, authCookie);
    const createRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'ip-open', permissions: ['write', 'read'], protocols: ['api'], uploadPath: '/' },
    });
    const createData = await json(createRes);
    const fullToken = createData.data.key.fullToken as string;
    await grantApiKeyRule(ctx, createData.data.key.keyId as string, ['write', 'read'], '/');
    const form = new FormData();
    form.append('file', new File([new Blob(['open-ip-content'])], 'open.txt', { type: 'text/plain' }));
    const res = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}`, 'X-Forwarded-For': '198.51.100.7' },
      body: form,
    });
    expect(res.status).toBe(200);
  });
});
