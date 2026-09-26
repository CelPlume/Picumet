// 跨挂载移动的挂载级容量预留、目标冲突双检（文件行 + 目录行）、
// blob 内容寻址文件跨挂载拒绝、目标 user_space 按文件属主判定。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';
let adminId = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  const admin = await registerAndLogin(ctx, 'mg_admin');
  adminId = admin.userId;
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'mg_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'mg_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  adminCookie = `auth_token=${setCookie.match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function createProvider(name: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name, bucket: 'mg-bucket' },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { provider: { id: string } }).provider.id;
}

async function createMount(mountPath: string, name: string, providerId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { providerId, mountPath, name, priority: 300, ...extra },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { mount: { id: string } }).mount.id;
}

function rootMountId(): string {
  return (ctx.db.prepare(`SELECT id FROM mounts WHERE mount_path = '/'`).get() as { id: string }).id;
}

interface FileRow {
  id: string;
  mount_id: string;
  path: string;
  name: string;
  size: number;
}

function insertFile(opts: {
  id: string;
  mountId: string;
  path: string;
  name: string;
  size: number;
  ownerId: string;
  type?: 'file' | 'folder';
  blobHash?: string | null;
  providerId?: string | null;
}): void {
  const now = Date.now();
  ctx.db
    .prepare(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, provider_id, blob_hash, physical_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.mountId,
      `${opts.id}-obj`,
      opts.path,
      opts.name,
      opts.type ?? 'file',
      opts.size,
      opts.ownerId,
      opts.providerId ?? null,
      opts.blobHash ?? null,
      opts.blobHash ? `picumet:blob/${opts.blobHash}` : `${opts.id}-obj`,
      now,
      now
    );
}

function fileRow(id: string): FileRow {
  const row = ctx.db.prepare('SELECT id, mount_id, path, name, size FROM file_metadata WHERE id = ?').get(id) as FileRow | undefined;
  expect(row).toBeTruthy();
  return row as FileRow;
}

function mountQuotas(mountId: string): { used: number; reserved: number } {
  const row = ctx.db.prepare('SELECT used_storage, quota_reserved FROM mounts WHERE id = ?').get(mountId) as
    | { used_storage: number | null; quota_reserved: number | null }
    | undefined;
  return { used: Number(row?.used_storage ?? 0), reserved: Number(row?.quota_reserved ?? 0) };
}

function memberReservedTotal(mountId: string): number {
  const rows = ctx.db.prepare('SELECT quota_reserved FROM mount_providers WHERE mount_id = ?').all(mountId) as Array<{
    quota_reserved: number | null;
  }>;
  return rows.reduce((sum, r) => sum + Number(r.quota_reserved ?? 0), 0);
}

function move(fileId: string, targetPath: string, cookie = adminCookie, csrf = adminCsrf): Promise<Response> {
  return request(ctx, `/api/files/${fileId}/move`, {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { targetPath },
  });
}

describe('跨挂载移动的容量边界', () => {
  it('目标挂载 max_storage 不足 → 413，两层预留释放、文件原位', async () => {
    const providerId = await createProvider('mg-d1');
    const targetMountId = await createMount('/mg-d1', '容量受限卷', providerId, { maxStorage: 100 });
    const srcMountId = rootMountId();
    insertFile({ id: 'mg-d1-file', mountId: srcMountId, path: '/', name: 'big.bin', size: 500, ownerId: adminId });

    const res = await move('mg-d1-file', '/mg-d1');
    expect(res.status).toBe(413);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('MOUNT_QUOTA_EXCEEDED');

    expect(mountQuotas(targetMountId)).toEqual({ used: 0, reserved: 0 });
    expect(memberReservedTotal(targetMountId)).toBe(0);
    expect(fileRow('mg-d1-file').mount_id).toBe(srcMountId);
  });

  it('容量充足 → 移动完成：目标 used=size、预留转已用、台账出队', async () => {
    const providerId = await createProvider('mg-d1b');
    const targetMountId = await createMount('/mg-d1b', '正常卷', providerId, { maxStorage: 10_000 });
    const srcMountId = rootMountId();
    insertFile({ id: 'mg-d1b-file', mountId: srcMountId, path: '/', name: 'ok.bin', size: 500, ownerId: adminId });
    // 源对象存在于绑定桶（复制路径按 size 校验）
    const srcKey = fileRow('mg-d1b-file').id + '-obj';
    ctx.r2.putRaw(srcKey, new Uint8Array(500), {});

    const res = await move('mg-d1b-file', '/mg-d1b');
    expect(res.status).toBe(200);
    const body = await json<{ data: { status: string } }>(res);
    expect(body.data.status).toBe('completed');

    expect(mountQuotas(targetMountId)).toEqual({ used: 500, reserved: 0 });
    expect(memberReservedTotal(targetMountId)).toBe(0);
    const rows = ctx.db.prepare('SELECT COUNT(*) AS c FROM quota_reservations WHERE mount_id = ?').get(targetMountId) as { c: number };
    expect(Number(rows.c)).toBe(0);
    expect(fileRow('mg-d1b-file').mount_id).toBe(targetMountId);
  });
});

describe('目标同名目录行同样冲突', () => {
  it('目标位置已有同名文件夹 → 409，不动任何行', async () => {
    const providerId = await createProvider('mg-d2');
    const targetMountId = await createMount('/mg-d2', '冲突卷', providerId);
    insertFile({
      id: 'mg-d2-folder',
      mountId: targetMountId,
      path: '/mg-d2/x',
      name: 'x',
      size: 0,
      ownerId: adminId,
      type: 'folder',
    });
    insertFile({ id: 'mg-d2-file', mountId: rootMountId(), path: '/', name: 'x', size: 10, ownerId: adminId });

    const res = await move('mg-d2-file', '/mg-d2');
    expect(res.status).toBe(409);
    expect((await json<{ error: { message: string } }>(res)).error.message).toBe('目标位置已存在同名文件夹');
    expect(fileRow('mg-d2-file').mount_id).toBe(rootMountId());
    expect(fileRow('mg-d2-folder').path).toBe('/mg-d2/x');
  });
});

describe('blob 内容寻址文件跨挂载 → 422', () => {
  it('拒绝并释放目标成员预留，文件原位', async () => {
    const providerId = await createProvider('mg-d3');
    const targetMountId = await createMount('/mg-d3', 'blob 卷', providerId);
    insertFile({
      id: 'mg-d3-file',
      mountId: rootMountId(),
      path: '/',
      name: 'blob.bin',
      size: 42,
      ownerId: adminId,
      blobHash: 'a'.repeat(64),
    });

    const res = await move('mg-d3-file', '/mg-d3');
    expect(res.status).toBe(422);
    expect((await json<{ error: { message: string } }>(res)).error.message).toContain('内容寻址文件暂不支持跨挂载点移动');
    expect(memberReservedTotal(targetMountId)).toBe(0);
    expect(fileRow('mg-d3-file').mount_id).toBe(rootMountId());
    expect(fileRow('mg-d3-file').name).toBe('blob.bin');
  });
});

describe('目标 user_space 按文件属主判定', () => {
  it('把他人文件移入发起者空间 → 403（属主不变的语义）', async () => {
    const providerId = await createProvider('mg-d4');
    const mountId = await createMount('/mg-us', '用户空间卷', providerId, { uploadMode: 'user_space' });
    const owner = await registerAndLogin(ctx, 'mg_owner');
    insertFile({
      id: 'mg-d4-file',
      mountId,
      path: '/mg-us/mg_owner',
      name: 'mine.txt',
      size: 5,
      ownerId: owner.userId,
    });

    // 管理员把 owner 的文件移入自己的空间（/mg-us/mg_admin）→ 属主是 owner，目标必须以 owner 的用户空间判定
    const res = await move('mg-d4-file', '/mg-us/mg_admin');
    expect(res.status).toBe(403);
    expect((await json<{ error: { message: string } }>(res)).error.message).toContain('仅允许写入');
    expect(fileRow('mg-d4-file').path).toBe('/mg-us/mg_owner');
  });
});
