// API 集成测试：认证 + 配额
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

describe('认证', () => {
  it('注册新用户', async () => {
    const res = await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'newbie', password: 'password123', email: 'newbie@test.local' },
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.success).toBe(true);
    expect(data.data.user.username).toBe('newbie');
  });

  it('重复用户名注册 → 409', async () => {
    const res = await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'newbie', password: 'password123', email: 'other@test.local' },
    });
    expect(res.status).toBe(409);
  });

  it('短密码注册 → 400', async () => {
    const res = await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'shortpw', password: 'abc', email: 'short@test.local' },
    });
    expect(res.status).toBe(400);
  });

  it('登录成功并返回 Cookie', async () => {
    const res = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'newbie', password: 'password123' },
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.data.user.username).toBe('newbie');
    expect(res.headers.get('set-cookie')).toContain('auth_token=');
  });

  it('错误密码 → 401', async () => {
    const res = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'newbie', password: 'wrongpass' },
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me 返回用户与配额', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'meuser');
    const res = await request(ctx, '/api/auth/me', { cookie: authCookie });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.data.user.username).toBe('meuser');
    expect(typeof data.data.quota.maxStorage).toBe('number');
  });

  it('未登录访问受保护接口 → 401', async () => {
    const res = await request(ctx, '/api/files?path=/');
    expect(res.status).toBe(401);
  });

  it('登出清除 Cookie', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'logoutuser');
    const res = await request(ctx, '/api/auth/logout', { method: 'POST', cookie: authCookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('配额', () => {
  it('上传预留配额在完成前计入 quota_reserved', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'quotauser');
    // 上传会话
    const initRes = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': await getCsrf(ctx, authCookie) },
      body: { path: '/', fileName: 'quota.bin', fileSize: 1000, mimeType: 'application/octet-stream' },
    });
    expect(initRes.status).toBe(200);
    const initData = await json(initRes);
    expect(initData.data.sessionId).toBeTruthy();
    expect(initData.data.uploadMode).toBe('worker');
    void initData;
  });

  it('超配额上传被拒绝（QUOTA_EXCEEDED）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'biguploader');
    const csrf = await getCsrf(ctx, authCookie);
    const huge = 15 * 1024 * 1024 * 1024; // 15GB > 默认 1GB 配额（且 < zod 上限 20GB）
    const res = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', fileName: 'huge.bin', fileSize: huge, mimeType: 'application/octet-stream' },
    });
    expect(res.status).toBe(413);
    const data = await json(res);
    expect(data.error.code).toBe('QUOTA_EXCEEDED');
  });
});
