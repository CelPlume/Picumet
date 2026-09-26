// 共享删除实现（remove.ts，供 WebDAV/S3/AList 复用）与子树 LIKE 前缀转义：
// - 文件夹删除按**文件行属主**分组扣减 user_quotas；mounts.used_storage 按被删文件总量。
// - 目录名含 `%`/`_` 时，子树前缀匹配先转义再拼通配，避免误伤兄弟目录。
import { describe, it, expect, beforeAll } from 'vitest';
import type { Context } from 'hono';
import type { Mount } from '@shared/types';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { Db, FileRepo, MountRepo } from '../src/db';
import { deleteFileInternal } from '../src/services/files/remove';

let ctx: TestContext;
let db: Db;
let mount: Mount;
let mountId: string;
let hashSeq = 0;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
  const mountRow = ctx.db.prepare(`SELECT id FROM mounts WHERE mount_path = '/'`).get() as { id: string };
  mountId = mountRow.id;
  mount = (await MountRepo.getMountById(db, mountId))!;
});

/** deleteFileInternal 只经 c.get('db') 取库；内容寻址行让对象清理被跳过，无需真实 env/KV */
function fakeCtx(): Context {
  return { get: (k: string) => (k === 'db' ? db : undefined) } as unknown as Context;
}

/** 直接落库构造文件行（绕过上传流程）：文件行 path=父目录、folder 行 path=自身全路径 */
async function mkRow(ownerId: string, path: string, name: string, type: 'file' | 'folder', size: number) {
  const blobHash = type === 'file' ? `b${hashSeq++}`.padEnd(64, '0') : null;
  return FileRepo.createFile(db, {
    mountId,
    objectKey: type === 'file' ? `obj:${path}/${name}` : `folder:${path}/${name}`,
    path,
    name,
    type,
    size,
    ownerId,
    blobHash,
  });
}

function quotaOf(userId: string): { storage: number; files: number } {
  const row = ctx.db
    .prepare('SELECT used_storage, used_files FROM user_quotas WHERE user_id = ?')
    .get(userId) as { used_storage: number; used_files: number };
  return { storage: Number(row.used_storage), files: Number(row.used_files) };
}

function setQuota(userId: string, storage: number, files: number): void {
  ctx.db.prepare('UPDATE user_quotas SET used_storage = ?, used_files = ? WHERE user_id = ?').run(storage, files, userId);
}

function mountUsed(): number {
  const row = ctx.db.prepare('SELECT used_storage FROM mounts WHERE id = ?').get(mountId) as { used_storage: number };
  return Number(row.used_storage);
}

function setMountUsed(v: number): void {
  ctx.db.prepare('UPDATE mounts SET used_storage = ? WHERE id = ?').run(v, mountId);
}

function rowExists(path: string, name: string, type: 'file' | 'folder'): boolean {
  return !!ctx.db
    .prepare(`SELECT 1 FROM file_metadata WHERE mount_id = ? AND path = ? AND name = ? AND type = ?`)
    .get(mountId, path, name, type);
}

describe('remove.ts 目录删除按文件行属主分组扣减配额', () => {
  it('共享目录内多属主文件各自扣自己；挂载总量按被删文件总量', async () => {
    const a = await registerAndLogin(ctx, 'dph_a');
    const b = await registerAndLogin(ctx, 'dph_b');

    // 目录属主 A，目录内混有 B 的文件（含一层子目录）
    const folder = await mkRow(a.userId, '/mq', 'mq', 'folder', 0);
    await mkRow(a.userId, '/mq', 'a1.txt', 'file', 3);
    await mkRow(a.userId, '/mq', 'a2.txt', 'file', 2);
    await mkRow(b.userId, '/mq', 'b1.txt', 'file', 7);
    await mkRow(a.userId, '/mq/sub', 'sub', 'folder', 0);
    await mkRow(b.userId, '/mq/sub', 'b2.txt', 'file', 11);

    setQuota(a.userId, 100, 10);
    setQuota(b.userId, 200, 20);
    setMountUsed(1000);

    await deleteFileInternal(fakeCtx(), mount, folder);

    // A 只扣自己的 2 个文件（3+2）；B 只扣自己的 2 个（7+11）——旧实现只扣目录属主 A 全部 23/4
    expect(quotaOf(a.userId)).toEqual({ storage: 95, files: 8 });
    expect(quotaOf(b.userId)).toEqual({ storage: 182, files: 18 });
    // 挂载点按全部被删文件总量 3+2+7+11=23
    expect(mountUsed()).toBe(977);

    const left = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`)
      .get(mountId, '/mq', '/mq/%') as { c: number };
    expect(Number(left.c)).toBe(0);
  });
});

describe('含 % 的目录删除不误伤兄弟子树', () => {
  it("删除 '/pct/100%' 保留 '/pct/100x/deep'", async () => {
    const a = await registerAndLogin(ctx, 'dph_pct');

    const folder = await mkRow(a.userId, '/pct/100%', '100%', 'folder', 0);
    await mkRow(a.userId, '/pct/100%', 'keep.txt', 'file', 4);
    // 兄弟子树：未转义的 LIKE '/pct/100%/%' 会命中其深层行（'/pct/100' + 'x' + '/' + 'deep'）
    await mkRow(a.userId, '/pct/100x', '100x', 'folder', 0);
    await mkRow(a.userId, '/pct/100x/deep', 'deep', 'folder', 0);
    await mkRow(a.userId, '/pct/100x/deep', 'trap.txt', 'file', 9);

    setQuota(a.userId, 50, 5);
    setMountUsed(500);

    await deleteFileInternal(fakeCtx(), mount, folder);

    expect(rowExists('/pct/100%', '100%', 'folder')).toBe(false);
    expect(rowExists('/pct/100%', 'keep.txt', 'file')).toBe(false);
    expect(rowExists('/pct/100x', '100x', 'folder')).toBe(true);
    expect(rowExists('/pct/100x/deep', 'trap.txt', 'file')).toBe(true);
    // 只扣目标子树自己的 4 字节 / 1 个文件
    expect(quotaOf(a.userId)).toEqual({ storage: 46, files: 4 });
    expect(mountUsed()).toBe(496);
  });
});

describe('listDescendants 对含 %/_ 目录取值正确', () => {
  it('只返回目标前缀子树的行', async () => {
    const a = await registerAndLogin(ctx, 'dph_desc');

    await mkRow(a.userId, '/und/a_b', 'a_b', 'folder', 0);
    const keepUnd = await mkRow(a.userId, '/und/a_b', 'x.txt', 'file', 1);
    await mkRow(a.userId, '/und/axb', 'axb', 'folder', 0);
    await mkRow(a.userId, '/und/axb/deep', 'deep', 'folder', 0);
    const trapUnd = await mkRow(a.userId, '/und/axb/deep', 'trap.txt', 'file', 2);

    await mkRow(a.userId, '/pct2/50%', '50%', 'folder', 0);
    const keepPct = await mkRow(a.userId, '/pct2/50%', 'f.txt', 'file', 3);
    await mkRow(a.userId, '/pct2/50X', '50X', 'folder', 0);
    await mkRow(a.userId, '/pct2/50X/deep', 'deep', 'folder', 0);
    const trapPct = await mkRow(a.userId, '/pct2/50X/deep', 'trap.txt', 'file', 4);

    const idsUnder = async (p: string) => new Set((await FileRepo.listDescendants(db, mountId, p)).map((r) => r.id));

    const und = await idsUnder('/und/a_b');
    expect(und.has(keepUnd.id)).toBe(true);
    expect(und.has(trapUnd.id)).toBe(false);

    const pct = await idsUnder('/pct2/50%');
    expect(pct.has(keepPct.id)).toBe(true);
    expect(pct.has(trapPct.id)).toBe(false);
  });
});

describe('管理端文件列表按 (hash, mount) 展示 blob 落桶', () => {
  it('同一 hash 跨挂载两份副本时各文件展示自己挂载的 provider', async () => {
    const admin = await registerAndLogin(ctx, 'dph_admin');
    ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'dph_admin'`);
    // 角色变更需重新登录，JWT 才携带 admin
    const relogin = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'dph_admin', password: 'password123' },
    });
    const setCookie = relogin.headers.get('set-cookie') ?? '';
    const tokenMatch = setCookie.match(/auth_token=([^;]+)/);
    const adminCookie = `auth_token=${tokenMatch?.[1] ?? ''}`;

    const now = Date.now();
    for (const [id, name] of [['dph-prov-1', 'dph-bucket-one'], ['dph-prov-2', 'dph-bucket-two']] as const) {
      ctx.db
        .prepare(
          `INSERT INTO storage_providers (id, name, type, endpoint, region, bucket, access_key_id, secret_access_key, created_at, updated_at)
           VALUES (?, ?, 'r2', '', 'auto', ?, '', '', ?, ?)`
        )
        .run(id, name, name, now, now);
    }
    for (const [id, providerId, mountPath] of [
      ['dph-mt-1', 'dph-prov-1', '/alpha-dph'],
      ['dph-mt-2', 'dph-prov-2', '/beta-dph'],
    ] as const) {
      ctx.db
        .prepare(`INSERT INTO mounts (id, provider_id, mount_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, providerId, mountPath, mountPath.slice(1), now, now);
    }

    const hash = 'd'.repeat(64);
    const mkBlobFile = (mountId: string, providerId: string, dir: string, name: string) =>
      FileRepo.createFile(db, {
        mountId, objectKey: `obj:${dir}/${name}`, path: dir, name, type: 'file', size: 5,
        ownerId: admin.userId, providerId, blobHash: hash,
      });
    await mkBlobFile('dph-mt-1', 'dph-prov-1', '/alpha-dph', 'dphblob-a.txt');
    await mkBlobFile('dph-mt-2', 'dph-prov-2', '/beta-dph', 'dphblob-b.txt');
    for (const [mountId, providerId, objectKey] of [
      ['dph-mt-1', 'dph-prov-1', 'obj:alpha'],
      ['dph-mt-2', 'dph-prov-2', 'obj:beta'],
    ] as const) {
      ctx.db
        .prepare(
          `INSERT INTO blob_objects (hash, mount_id, provider_id, object_key, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(hash, mountId, providerId, objectKey, 5, now, now);
    }

    const res = await request(ctx, '/api/admin/files?search=dphblob', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const body = await json<{ data: { items: Array<{ name: string; buckets: string[] }> } }>(res);
    const alpha = body.data.items.find((i) => i.name === 'dphblob-a.txt');
    const beta = body.data.items.find((i) => i.name === 'dphblob-b.txt');
    expect(alpha?.buckets).toEqual(['dph-bucket-one']);
    expect(beta?.buckets).toEqual(['dph-bucket-two']);
  });
});
