// WebDAV 权限回归（审计 H-3/H-4/M-3）：
// 统一路径级权限（读/写/删）、上传根边界、MOVE 复用移动 Saga
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

function basicAuth(keyId: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
}

async function createKey(permissions: string[], uploadPath = '/'): Promise<{ keyId: string; secret: string }> {
  const { authCookie } = await registerAndLogin(ctx, 'wdowner' + Math.random().toString(36).slice(2, 7));
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'wd', permissions, protocols: ['webdav'], uploadPath },
  });
  expect(res.status).toBe(201);
  const data = await json(res);
  // H-3 交集语义：授予密钥相同权限的路径规则（deny 类断言仍由 allowedPermissions 控制）
  await grantApiKeyRule(ctx, data.data.key.keyId as string, permissions, '/');
  return { keyId: data.data.key.keyId as string, secret: data.data.key.secret as string };
}

describe('WebDAV 统一权限（H-3/H-4/M-3）', () => {
  it('H-3：无 read 权限的密钥 PROPFIND → 403', async () => {
    const { keyId, secret } = await createKey(['write', 'delete']);
    const auth = { Authorization: basicAuth(keyId, secret), Depth: '1' };
    const res = await request(ctx, '/webdav/', { method: 'PROPFIND', headers: auth });
    expect(res.status).toBe(403);
  });

  it('H-3：无 read 权限的密钥 GET → 403', async () => {
    const { keyId, secret } = await createKey(['write', 'delete']);
    const res = await request(ctx, '/webdav/README.md', { headers: { Authorization: basicAuth(keyId, secret) } });
    expect(res.status).toBe(403);
  });

  it('M-3：PUT 超出密钥上传根 → 403', async () => {
    const { keyId, secret } = await createKey(['write', 'read'], '/uploads');
    const res = await request(ctx, '/webdav/other/x.txt', {
      method: 'PUT',
      headers: { Authorization: basicAuth(keyId, secret), 'Content-Type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(403);
  });

  it('M-3：密钥创建时非法 uploadPath（..）→ 400', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'wdpath' + Math.random().toString(36).slice(2, 7));
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'bad', permissions: ['write'], protocols: ['webdav'], uploadPath: '../escape' },
    });
    expect(res.status).toBe(400);
  });

  it('H-4：MOVE 需要源 delete 权限，缺失 → 403', async () => {
    const { keyId, secret } = await createKey(['write', 'read']);
    const auth = { Authorization: basicAuth(keyId, secret) };
    const put = await request(ctx, '/webdav/mv-src.txt', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(put.status).toBe(201);
    const move = await request(ctx, '/webdav/mv-src.txt', {
      method: 'MOVE',
      headers: { ...auth, Destination: 'http://localhost:8787/webdav/mv-dst.txt' },
    });
    expect(move.status).toBe(403);
  });

  it('H-4：MOVE 复用 Saga，成功后元数据切换且源对象清理', async () => {
    const { keyId, secret } = await createKey(['write', 'read', 'delete']);
    const auth = { Authorization: basicAuth(keyId, secret) };
    const put = await request(ctx, '/webdav/mv-a.txt', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: 'saga-move',
    });
    expect(put.status).toBe(201);

    const move = await request(ctx, '/webdav/mv-a.txt', {
      method: 'MOVE',
      headers: { ...auth, Destination: 'http://localhost:8787/webdav/dir/mv-b.txt' },
    });
    expect(move.status).toBe(201);

    // 目标可 GET（源对象已清理，目标已就位）
    const getNew = await request(ctx, '/webdav/dir/mv-b.txt', { headers: auth });
    expect(getNew.status).toBe(200);
    expect(await getNew.text()).toBe('saga-move');
    const getOld = await request(ctx, '/webdav/mv-a.txt', { headers: auth });
    expect(getOld.status).toBe(404);
  });

  it('L-1：PROPFIND 响应中 href 被 XML 转义', async () => {
    const { keyId, secret } = await createKey(['write', 'read', 'delete']);
    const auth = { Authorization: basicAuth(keyId, secret) };
    const res = await request(ctx, '/webdav/', { method: 'PROPFIND', headers: { ...auth, Depth: '1' } });
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain('<d:multistatus');
    // 不包含未转义的裸 &（名称与 href 均已转义）
    expect(body).not.toMatch(/<d:href>[^<]*&[^<]*<\/d:href>/);
  });
});
