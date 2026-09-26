// 故障注入：对象已写入但 DB 提交失败 → 释放预留 + 清理对象 / 记孤儿
// §F 内容寻址补充：内容对象删除改为引用释放 + 回收队列（blob_gc），因此对象清理失败的
// 对账路径分两类——内容寻址对象走队列重试，独占物理键的存量/分片对象仍记孤儿。
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule, type TestContext } from './helpers';
import { FileRepo } from '../src/db';
import { R2BindingProvider } from '../src/services/storage/r2';
import { Sha256 } from '../src/utils/sha256';
import { blobObjectKey } from '../src/services/storage/keys';
import { cleanupBlobObjects } from '../src/services/cleanup';

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

/** 内容对应的内容哈希与物理对象键（测试侧独立计算，验证服务端落点） */
function contentRef(content: string): { hash: string; key: string } {
  const hasher = new Sha256();
  hasher.update(new TextEncoder().encode(content));
  const hash = hasher.digestHex();
  return { hash, key: blobObjectKey('', hash) };
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

/** 构造独占物理键的文件行（模拟分片上传/存量数据：blob_hash 为空） */
function insertLegacyFile(opts: { id: string; objectKey: string; ownerId: string; size: number }): void {
  const mount = ctx.db.prepare('SELECT id, provider_id FROM mounts LIMIT 1').get() as { id: string; provider_id: string };
  const now = Date.now();
  ctx.db
    .prepare(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, owner_id, provider_id,
        physical_key, blob_hash, created_at, updated_at)
       VALUES (?, ?, ?, '/', ?, 'file', 'text/plain', ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(opts.id, mount.id, opts.objectKey, opts.objectKey, opts.size, opts.ownerId, mount.provider_id, opts.objectKey, now, now);
  ctx.db
    .prepare(`UPDATE user_quotas SET used_storage = used_storage + ?, used_files = used_files + 1 WHERE user_id = ?`)
    .run(opts.size, opts.ownerId);
}

describe('一致性边界（故障注入）', () => {
  it('兼容上传：DB 提交失败 → 释放预留 + 清理已写内容对象 + 无元数据残留', async () => {
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

    const content = 'fault-content';
    const form = new FormData();
    form.append('file', new File([new Blob([content])], 'fail.txt', { type: 'text/plain' }));
    const res = await request(ctx, '/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fullToken}` },
      body: form,
    });
    expect(res.status).toBe(500);

    // 已写内容对象被补偿清理（§F：物理键由内容哈希决定），暂存对象不残留
    expect(await ctx.r2.head(contentRef(content).key)).toBeNull();
    expect((await ctx.r2.list({ prefix: 'picumet:staging' })).objects).toHaveLength(0);
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
    expect(await ctx.r2.head(contentRef('x').key)).toBeNull();
    expect((await ctx.r2.list({ prefix: 'picumet:staging' })).objects).toHaveLength(0);
    expect(quotaReserved(userId)).toBe(0);
    const meta = ctx.db.prepare("SELECT * FROM file_metadata WHERE object_key = 'wd-fail.txt'").get();
    expect(meta).toBeUndefined();
  });

  it('WebDAV DELETE（独占物理键对象）：对象清理失败 → 记录孤儿对象供对账', async () => {
    const { keyId, secret, userId } = await createWebdavKey(['write', 'read', 'delete']);
    const auth = { Authorization: basicAuth(keyId, secret) };
    insertLegacyFile({ id: 'legacy-orphan', objectKey: 'legacy-orphan.txt', ownerId: userId, size: 9 });
    ctx.r2.putRaw('legacy-orphan.txt', new TextEncoder().encode('orphan-me'), {});

    // 元数据删除成功、对象清理失败 → 记孤儿（批量与单删两条路径都注入故障）
    vi.spyOn(R2BindingProvider.prototype, 'deleteObjects').mockRejectedValue(new Error('storage unavailable'));
    vi.spyOn(R2BindingProvider.prototype, 'deleteObject').mockRejectedValue(new Error('storage unavailable'));
    const del = await request(ctx, '/webdav/legacy-orphan.txt', { method: 'DELETE', headers: auth });
    expect(del.status).toBe(204);

    const orphan = ctx.db.prepare("SELECT * FROM orphan_objects WHERE object_key = 'legacy-orphan.txt'").get();
    expect(orphan).toBeTruthy();
  });

  it('WebDAV DELETE（内容寻址对象）：对象保留至回收保护期，删除失败只累加重试', async () => {
    const { keyId, secret } = await createWebdavKey(['write', 'read', 'delete']);
    const auth = { Authorization: basicAuth(keyId, secret) };
    const content = 'dedupe-me';
    const put = await request(ctx, '/webdav/gc-target.txt', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: content,
    });
    expect(put.status).toBe(201);
    const { hash, key } = contentRef(content);
    expect(await ctx.r2.head(key)).not.toBeNull();

    const del = await request(ctx, '/webdav/gc-target.txt', { method: 'DELETE', headers: auth });
    expect(del.status).toBe(204);
    // 行已删除但对象保留（等待回收），回收队列有记录
    const queued = ctx.db.prepare('SELECT * FROM blob_gc WHERE hash = ?').get(hash) as { attempts: number } | undefined;
    expect(queued).toBeTruthy();
    expect(await ctx.r2.head(key)).not.toBeNull();

    // 回收失败：只累加 attempts，不丢队列
    vi.spyOn(R2BindingProvider.prototype, 'deleteObject').mockRejectedValue(new Error('storage unavailable'));
    await cleanupBlobObjects(ctx.env, Date.now() + 120_000);
    const afterFail = ctx.db.prepare('SELECT * FROM blob_gc WHERE hash = ?').get(hash) as { attempts: number } | undefined;
    expect(afterFail?.attempts).toBe(1);
    expect(await ctx.r2.head(key)).not.toBeNull();

    // 恢复后（保护期已过）：对象删除、队列清空
    vi.restoreAllMocks();
    await cleanupBlobObjects(ctx.env, Date.now() + 120_000);
    expect(await ctx.r2.head(key)).toBeNull();
    expect(ctx.db.prepare('SELECT * FROM blob_gc WHERE hash = ?').get(hash)).toBeUndefined();
  });
});
