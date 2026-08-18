// 故障注入回归（审计 H-5）：对象已写入但 DB 提交失败 → 释放预留 + 清理对象 / 记孤儿
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule, type TestContext } from './helpers';
import { FileRepo } from '../src/db';
import { R2BindingProvider } from '../src/services/storage/r2';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function basicAuth(keyId: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
}

async function createWebdavKey(permissions: string[]): Promise<{ keyId: string; secret: string; userId: string }> {
  const { authCookie, userId } = await registerAndLogin(ctx, 'fault' + Math.random().toString(36).slice(2, 7));
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'fd', permissions, protocols: ['webdav'], uploadPath: '/' },
  });
  expect(res.status).toBe(201);
  const data = await json(res);
  await grantApiKeyRule(ctx, data.data.key.keyId as string, permissions, '/');
  return { keyId: data.data.key.keyId as string, secret: data.data.key.secret as string, userId };
}

function quotaReserved(userId: string): number {
  const row = ctx.db.prepare('SELECT quota_reserved FROM user_quotas WHERE user_id = ?').get(userId) as { quota_reserved: number } | undefined;
  return Number(row?.quota_reserved ?? 0);
}

describe('H-5 一致性边界（故障注入）', () => {
  it('兼容上传：DB 提交失败 → 释放预留 + 清理已写对象 + 无元数据残留', async () => {
    const { authCookie, userId } = await registerAndLogin(ctx, 'cfault' + Math.random().toString(36).slice(2, 7));
    const csrf = await getCsrf(ctx, authCookie);
    const keyRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'cf', permissions: ['write', 'read'], protocols: ['api'], uploadPath: '/uploads' },
    });
    const keyData = await json(keyRes);
    const fullToken = keyData.data.key.fullToken as string;
    await grantApiKeyRule(ctx, keyData.data.key.keyId as string, ['write', 'read'], '/uploads/**');

    // 模拟 DB 事务内写入失败（日志写入抛错 → 事务回滚）
    vi.spyOn(FileRepo, 'createFileTx').mockRejectedValue(new Error('db down'));

    const form = new FormData();
    form.append('file', new File([new Blob(['fault-content'])], 'fail.txt', { type: 'text/plain' }));
    const res = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}` },
      body: form,
    });
    expect(res.status).toBe(500);

    // 已写对象被补偿清理
    expect(await ctx.r2.head('uploads/fail.txt')).toBeNull();
    // 预留释放
    expect(quotaReserved(userId)).toBe(0);
    // 无元数据残留
    const meta = ctx.db.prepare("SELECT * FROM file_metadata WHERE object_key = 'uploads/fail.txt'").get();
    expect(meta).toBeUndefined();
  });

  it('WebDAV PUT：DB 提交失败 → 释放预留 + 清理对象 + 无元数据残留', async () => {
    const { keyId, secret, userId } = await createWebdavKey(['write', 'read']);
    vi.spyOn(FileRepo, 'createFileTx').mockRejectedValue(new Error('db down'));
    const res = await request(ctx, '/webdav/wd-fail.txt', {
      method: 'PUT',
      headers: { Authorization: basicAuth(keyId, secret), 'Content-Type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(500);
    expect(await ctx.r2.head('wd-fail.txt')).toBeNull();
    expect(quotaReserved(userId)).toBe(0);
    const meta = ctx.db.prepare("SELECT * FROM file_metadata WHERE object_key = 'wd-fail.txt'").get();
    expect(meta).toBeUndefined();
  });

  it('WebDAV DELETE：对象清理失败 → 记录孤儿对象供对账', async () => {
    const { keyId, secret } = await createWebdavKey(['write', 'read', 'delete']);
    const auth = { Authorization: basicAuth(keyId, secret) };
    const put = await request(ctx, '/webdav/orphan.txt', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: 'orphan-me',
    });
    expect(put.status).toBe(201);

    // 元数据删除成功、对象清理失败 → 记孤儿
    vi.spyOn(R2BindingProvider.prototype, 'deleteObject').mockRejectedValue(new Error('storage unavailable'));
    const del = await request(ctx, '/webdav/orphan.txt', { method: 'DELETE', headers: auth });
    expect(del.status).toBe(204);

    const orphan = ctx.db.prepare("SELECT * FROM orphan_objects WHERE object_key = 'orphan.txt'").get();
    expect(orphan).toBeTruthy();
  });
});
