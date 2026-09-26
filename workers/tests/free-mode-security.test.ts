// 自由模式安全边界：
// CSRF 必带、Origin 跨站拒绝、路径/文件名边界、不再签发长寿命 JWT、logout 撤销会话
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createTestContext, initSeeded, request, json, type TestContext } from './helpers';
import { S3Provider } from '../src/services/storage/providers';
import { encryptSecret } from '../src/utils/crypto';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 直接向 KV 写入加密会话（绕过 init 的网络连通性探测），返回 cookie 与 CSRF token */
async function seedSession(overrides: { path?: string; ip?: string } = {}): Promise<{ cookie: string; csrf: string }> {
  const sid = 'test-session-' + Math.random().toString(36).slice(2, 10);
  const session = {
    userId: 'fm-test-user',
    provider: {
      type: 's3' as const,
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'test-bucket',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
    },
    mountPath: '/',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600 * 1000,
    ip: overrides.ip ?? '127.0.0.1',
  };
  const sealed = await encryptSecret(JSON.stringify(session), ctx.env.ENCRYPTION_KEY as string);
  await ctx.kv.put(`fm:${sid}`, sealed, { expirationTtl: 3600 });
  const csrf = 'fm-csrf-' + Math.random().toString(36).slice(2, 10);
  await ctx.kv.put(`fm:csrf:${sid}`, csrf, { expirationTtl: 3600 });
  return { cookie: `fm_token=${sid}`, csrf };
}

describe('自由模式安全防护', () => {
  it('写方法缺少 CSRF Token → 403 INVALID_CSRF', async () => {
    const { cookie } = await seedSession();
    const res = await request(ctx, '/api/free-mode/upload', {
      method: 'POST',
      cookie,
      headers: { 'X-File-Name': 'a.txt', 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(res.status).toBe(403);
    const data = await json(res);
    expect(data.error.code).toBe('INVALID_CSRF');
  });

  it('写方法携带错误 CSRF Token → 403', async () => {
    const { cookie } = await seedSession();
    const res = await request(ctx, '/api/free-mode/upload', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': 'wrong', 'X-File-Name': 'a.txt', 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(res.status).toBe(403);
  });

  it('非白名单 Origin → 403（跨站拒绝）', async () => {
    const { cookie } = await seedSession();
    const res = await request(ctx, '/api/free-mode/files', {
      cookie,
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('文件名含 .. 片段 → 400', async () => {
    const { cookie, csrf } = await seedSession();
    const res = await request(ctx, '/api/free-mode/upload', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf, 'X-File-Name': '../evil.txt', 'Content-Type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('query path 越界（..）→ 400', async () => {
    const { cookie, csrf } = await seedSession();
    const res = await request(ctx, '/api/free-mode/upload?path=..%2F..%2F', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf, 'X-File-Name': 'a.txt', 'Content-Type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('删除 key 含 .. 或控制字符 → 400', async () => {
    const { cookie, csrf } = await seedSession();
    const res = await request(ctx, '/api/free-mode/object?key=..%2F..%2Fetc', {
      method: 'DELETE',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(400);
  });

  it('init 只签发 fm_token（不再签发 7 天 JWT），并返回会话级 CSRF Token', async () => {
    vi.spyOn(S3Provider.prototype, 'testConnection').mockResolvedValue({ connected: true, message: 'ok' });
    const res = await request(ctx, '/api/free-mode/init', {
      method: 'POST',
      body: {
        type: 's3',
        endpoint: 'https://s3.example.com',
        region: 'auto',
        bucket: 'test-bucket',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        sessionHours: 1,
      },
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(typeof data.data.csrfToken).toBe('string');
    expect(data.data.csrfToken.length).toBeGreaterThanOrEqual(16);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('fm_token=');
    expect(setCookie).not.toContain('auth_token='); // 不再签发长寿命 auth_token
  });

  it('logout 撤销会话（携带 CSRF）→ 之后会话失效', async () => {
    const { cookie, csrf } = await seedSession();
    const logout = await request(ctx, '/api/free-mode/logout', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(logout.status).toBe(200);
    const files = await request(ctx, '/api/free-mode/files', { cookie });
    expect(files.status).toBe(401);
  });
});
