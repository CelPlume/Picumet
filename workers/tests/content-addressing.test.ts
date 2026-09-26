// §F 内容哈希寻址：同内容单份物理对象、移动免拷贝、引用释放与回收、覆盖写、已知哈希直写。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule, type TestContext } from './helpers';
import { Db, BlobRepo, ProviderRepo } from '../src/db';
import { Sha256 } from '../src/utils/sha256';
import { blobObjectKey } from '../src/services/storage/keys';
import { cleanupBlobObjects, cleanupOldObjects } from '../src/services/cleanup';
import { writeContentAddressed } from '../src/services/storage/content';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

function sha256(content: string): string {
  const hasher = new Sha256();
  hasher.update(new TextEncoder().encode(content));
  return hasher.digestHex();
}

function contentRef(content: string): { hash: string; key: string } {
  const hash = sha256(content);
  return { hash, key: blobObjectKey('', hash) };
}

/** 桶内内容对象键 */
async function contentKeys(): Promise<string[]> {
  const listed = await ctx.r2.list({ prefix: 'picumet:blob/' });
  return listed.objects.map((o) => o.key).sort();
}

function basicAuth(keyId: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
}

async function createWebdavKey(permissions: string[] = ['write', 'read', 'delete']): Promise<{ auth: Record<string, string>; userId: string }> {
  const { authCookie, userId } = await registerAndLogin(ctx, 'chash' + Math.random().toString(36).slice(2, 7));
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'ch', permissions, protocols: ['webdav'], uploadPath: '/' },
  });
  expect(res.status).toBe(201);
  const data = await json(res);
  await grantApiKeyRule(ctx, data.data.key.keyId as string, permissions, '/');
  return { auth: { Authorization: basicAuth(data.data.key.keyId as string, data.data.key.secret as string) }, userId };
}

async function upload(auth: Record<string, string>, path: string, content: string): Promise<Response> {
  return request(ctx, `/webdav/${path}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'text/plain' },
    body: content,
  });
}

async function download(auth: Record<string, string>, path: string): Promise<Response> {
  return request(ctx, `/webdav/${path}`, { method: 'GET', headers: auth });
}

function fileRow(name: string): { id: string; physical_key: string; blob_hash: string | null; provider_id: string } {
  return ctx.db.prepare('SELECT id, physical_key, blob_hash, provider_id FROM file_metadata WHERE name = ?').get(name) as {
    id: string;
    physical_key: string;
    blob_hash: string | null;
    provider_id: string;
  };
}


/** 构造存量/分片行：blob_hash 为空、物理键 = 虚拟键，并写入独占对象 */
function insertLegacyRow(name: string, content: string, size: number, ownerId: string): void {
  const mount = ctx.db.prepare('SELECT id, provider_id FROM mounts LIMIT 1').get() as { id: string; provider_id: string };
  const now = Date.now();
  ctx.db
    .prepare(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, owner_id, provider_id,
        physical_key, blob_hash, created_at, updated_at)
       VALUES (?, ?, ?, '/', ?, 'file', 'text/plain', ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(`legacy-${name}`, mount.id, name, name, size, ownerId, mount.provider_id, name, now, now);
  ctx.r2.putRaw(name, new TextEncoder().encode(content), {});
}

describe('§F 内容哈希寻址', () => {
  it('同内容两处上传 → 单份物理对象，两行共享物理键，读回内容一致', async () => {
    const { auth } = await createWebdavKey();
    const content = 'same-bytes-across-two-paths';
    const { hash, key } = contentRef(content);

    expect((await upload(auth, 'dedupe/one.txt', content)).status).toBe(201);
    const afterFirst = await contentKeys();
    expect((await upload(auth, 'dedupe/two.txt', content)).status).toBe(201);
    const afterSecond = await contentKeys();

    // 第二次上传没有新增物理对象（去重命中），对象键由内容哈希决定
    expect(afterSecond).toEqual(afterFirst);
    expect(afterFirst).toContain(key);
    // 两行的物理键/内容哈希一致（共享同一对象）
    const first = fileRow('one.txt');
    const second = fileRow('two.txt');
    expect(first.physical_key).toBe(key);
    expect(second.physical_key).toBe(key);
    expect(first.blob_hash).toBe(hash);
    expect(second.blob_hash).toBe(hash);
    expect(first.provider_id).toBe(second.provider_id);

    // 读路径按物理键取对象：两处都能读到同一内容
    expect(await (await download(auth, 'dedupe/one.txt')).text()).toBe(content);
    expect(await (await download(auth, 'dedupe/two.txt')).text()).toBe(content);
  });

  it('不同内容 → 各自一份物理对象', async () => {
    const { auth } = await createWebdavKey();
    await upload(auth, 'distinct/a.txt', 'alpha');
    await upload(auth, 'distinct/b.txt', 'beta');
    const keys = await contentKeys();
    expect(keys).toContain(contentRef('alpha').key);
    expect(keys).toContain(contentRef('beta').key);
  });

  it('重命名/移动不复制对象（物理键不变、对象数不变）', async () => {
    const { auth } = await createWebdavKey(['write', 'read', 'delete']);
    const content = 'move-me-without-copy';
    const { key } = contentRef(content);
    await upload(auth, 'move-src.txt', content);
    const before = await contentKeys();
    fileRow('move-src.txt'); // 触发一次行读取，确认存在

    const moved = await request(ctx, '/webdav/move-src.txt', {
      method: 'MOVE',
      headers: { ...auth, Host: 'localhost:8787', Destination: 'http://localhost:8787/webdav/move-dst.txt' },
    });
    expect(moved.status).toBe(201);
    // §F：对象键与虚拟路径解耦 → 移动是纯元数据操作，不产生新对象
    expect(await contentKeys()).toEqual(before);
    const movedRow = fileRow('move-dst.txt');
    expect(movedRow.physical_key).toBe(key);
    expect(await (await download(auth, 'move-dst.txt')).text()).toBe(content);
  });

  it('删除其一保留对象，删净后入回收队列，保护期满回收', async () => {
    const { auth } = await createWebdavKey(['write', 'read', 'delete']);
    const content = 'shared-then-collected';
    const { hash, key } = contentRef(content);
    await upload(auth, 'gc/keep.txt', content);
    await upload(auth, 'gc/drop.txt', content);

    expect((await request(ctx, '/webdav/gc/drop.txt', { method: 'DELETE', headers: auth })).status).toBe(204);
    // 还有引用：对象保留、队列为空
    expect(await ctx.r2.head(key)).not.toBeNull();
    expect(ctx.db.prepare('SELECT * FROM blob_gc WHERE hash = ?').get(hash)).toBeUndefined();

    expect((await request(ctx, '/webdav/gc/keep.txt', { method: 'DELETE', headers: auth })).status).toBe(204);
    // 引用归零：入队但对象仍在（保护期），索引行已删除
    expect(ctx.db.prepare('SELECT * FROM blob_gc WHERE hash = ?').get(hash)).toBeTruthy();
    expect(await ctx.r2.head(key)).not.toBeNull();
    const db = Db.fromAny(ctx.env.DB);
    const mountRow = ctx.db.prepare('SELECT id FROM mounts LIMIT 1').get() as { id: string };
    expect(await BlobRepo.get(db, hash, mountRow.id)).toBeNull();

    // 保护期满：对象删除、队列清空
    await cleanupBlobObjects(ctx.env, Date.now() + 120_000);
    expect(await ctx.r2.head(key)).toBeNull();
    expect(ctx.db.prepare('SELECT * FROM blob_gc WHERE hash = ?').get(hash)).toBeUndefined();
  });

  it('覆盖写：行指向新内容，旧内容对象在保护期后回收', async () => {
    const { auth } = await createWebdavKey(['write', 'read', 'delete']);
    const oldContent = 'overwrite-old';
    const newContent = 'overwrite-new';
    const oldRef = contentRef(oldContent);
    const newRef = contentRef(newContent);

    await upload(auth, 'overwrite.txt', oldContent);
    await upload(auth, 'overwrite.txt', newContent);

    const row = fileRow('overwrite.txt');
    expect(row.physical_key).toBe(newRef.key);
    expect(row.blob_hash).toBe(newRef.hash);
    expect(await (await download(auth, 'overwrite.txt')).text()).toBe(newContent);
    // 旧内容无引用 → 已入队
    expect(ctx.db.prepare('SELECT * FROM blob_gc WHERE hash = ?').get(oldRef.hash)).toBeTruthy();
    expect(ctx.db.prepare('SELECT * FROM blob_gc WHERE hash = ?').get(newRef.hash)).toBeUndefined();

    await cleanupBlobObjects(ctx.env, Date.now() + 120_000);
    expect(await ctx.r2.head(oldRef.key)).toBeNull();
    expect(await ctx.r2.head(newRef.key)).not.toBeNull();
  });

  it('覆盖存量/分片行：旧对象交清理队列，新内容走内容键', async () => {
    const { auth, userId } = await createWebdavKey(['write', 'read', 'delete']);
    const legacyKey = 'legacy-overwrite.txt';
    insertLegacyRow(legacyKey, 'legacy-bytes', 12, userId);

    const content = 'fresh-content-after-legacy';
    const { key } = contentRef(content);
    expect((await upload(auth, legacyKey, content)).status).toBe(201);

    const row = fileRow(legacyKey);
    expect(row.physical_key).toBe(key);
    expect(row.blob_hash).toBe(contentRef(content).hash);
    // 旧对象仍在桶里，但已入清理队列（sweeper 处理）
    expect(await ctx.r2.head(legacyKey)).not.toBeNull();
    const pending = ctx.db.prepare('SELECT source_cleanup_pending, old_object_key FROM file_metadata WHERE name = ?').get(legacyKey) as {
      source_cleanup_pending: number;
      old_object_key: string | null;
    };
    expect(pending.source_cleanup_pending).toBe(1);
    expect(pending.old_object_key).toBe(legacyKey);

    // 清理任务执行后旧对象删除、标记复位
    await cleanupOldObjects(ctx.env);
    expect(await ctx.r2.head(legacyKey)).toBeNull();
    expect(await (await download(auth, legacyKey)).text()).toBe(content);
  });

  it('范围读取走内容键（206 切片正确）', async () => {
    const { auth } = await createWebdavKey();
    const content = '0123456789';
    await upload(auth, 'range.txt', content);
    const res = await request(ctx, '/webdav/range.txt', { method: 'GET', headers: { ...auth, Range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('2345');
  });

  it('已知哈希且库内已有内容：直连写入路径不再落对象（S3 网关整包校验路径）', async () => {
    const { auth } = await createWebdavKey();
    const content = 'known-hash-skip-write';
    const { hash, key } = contentRef(content);
    await upload(auth, 'known.txt', content);
    const before = await contentKeys();

    const db = Db.fromAny(ctx.env.DB);
    const mountRow = ctx.db.prepare('SELECT id, provider_id FROM mounts LIMIT 1').get() as { id: string; provider_id: string };
    const providerRow = await ProviderRepo.getProviderById(db, mountRow.provider_id);
    expect(providerRow).toBeTruthy();
    const outcome = await writeContentAddressed(db, ctx.env, {
      providerRow: providerRow!,
      mountId: mountRow.id,
      fallbackKey: 'known.txt',
      body: new Blob([content]).stream() as ReadableStream<Uint8Array>,
      mimeType: 'text/plain',
      declaredSize: content.length,
      contentHash: hash,
    });


    expect(outcome.deduped).toBe(true);
    expect(outcome.hash).toBe(hash);
    expect(outcome.objectKey).toBe(key);
    expect(await contentKeys()).toEqual(before);
  });
});
