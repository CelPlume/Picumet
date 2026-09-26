// Provider 漂移守卫：
//   · Provider 物理定位字段（bucket/endpoint/region/pathPrefix）在有物理引用时不可改（409），
//     非物理字段（名称/公开域名）不受限；
//   · 池成员移除前检查覆盖 blob_objects / blob_gc（与 Provider 删除路径对齐）；
//   · 挂载删除的条件 DELETE 排除在途上传会话，避免「检查无会话 → 会话落地 → 删除」之间收敛丢失。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';
let adminId = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  const admin = await registerAndLogin(ctx, 'pd_admin');
  adminId = admin.userId;
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'pd_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'pd_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  adminCookie = `auth_token=${setCookie.match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function createProvider(name: string, bucket = 'pd-bucket'): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name, bucket },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { provider: { id: string } }).provider.id;
}

async function createMount(mountPath: string, providerId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { providerId, mountPath, name: mountPath, priority: 300, ...extra },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { mount: { id: string } }).mount.id;
}

function putProvider(providerId: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/admin/storage/providers/${providerId}`, {
    method: 'PUT',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

function patchMount(mountId: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/admin/mounts/${mountId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

function insertFileRow(id: string, mountId: string, providerId: string, ownerId: string): void {
  const now = Date.now();
  ctx.db
    .prepare(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, provider_id, created_at, updated_at)
       VALUES (?, ?, ?, '/', ?, 'file', 1, ?, ?, ?, ?)`
    )
    .run(id, mountId, `${id}-obj`, id, ownerId, providerId, now, now);
}

describe('Provider 物理定位变更守卫', () => {
  it('存在物理引用 → bucket 变更 409；改名/公开域名放行；清理引用后可改', async () => {
    const providerId = await createProvider('pd-phys');
    const mountId = await createMount('/pd-phys', providerId);
    insertFileRow('pd-phys-file', mountId, providerId, adminId);

    const blocked = await putProvider(providerId, { bucket: 'pd-bucket-2' });
    expect(blocked.status).toBe(409);
    const details = (await json<{ error: { details: Record<string, number> } }>(blocked)).error.details;
    expect(details.files).toBe(1);

    const harmless = await putProvider(providerId, { name: 'pd-phys-renamed', publicDomain: 'https://cdn.example.com' });
    expect(harmless.status).toBe(200);

    ctx.db.prepare('DELETE FROM file_metadata WHERE id = ?').run('pd-phys-file');
    expect((await putProvider(providerId, { bucket: 'pd-bucket-2' })).status).toBe(200);
  });
});

describe('池成员移除检查 blob 索引/回收队列', () => {
  it('成员仍有 blob_objects / blob_gc 引用 → 409，清理后可移除', async () => {
    const keepProvider = await createProvider('pd-pool-keep');
    const dropProvider = await createProvider('pd-pool-drop');
    const mountId = await createMount('/pd-pool', keepProvider, { poolProviderIds: [keepProvider, dropProvider] });

    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO blob_objects (hash, mount_id, provider_id, object_key, size, etag, created_at, updated_at)
         VALUES ('h-pd', ?, ?, 'picumet:blob/h-pd', 1, NULL, ?, ?)`
      )
      .run(mountId, dropProvider, now, now);

    const blocked = await patchMount(mountId, { poolMembers: [{ providerId: keepProvider }] });
    expect(blocked.status).toBe(409);
    const details = (await json<{ error: { details: { members: Array<{ blobs: number }> } } }>(blocked)).error.details;
    expect(details.members[0]?.blobs).toBe(1);

    ctx.db.prepare(`DELETE FROM blob_objects WHERE hash = 'h-pd'`).run();
    ctx.db
      .prepare(`INSERT INTO blob_gc (hash, mount_id, provider_id, object_key, attempts, created_at) VALUES ('h-pd2', ?, ?, 'picumet:blob/h-pd2', 0, ?)`)
      .run(mountId, dropProvider, now);

    const blockedByGc = await patchMount(mountId, { poolMembers: [{ providerId: keepProvider }] });
    expect(blockedByGc.status).toBe(409);

    ctx.db.prepare(`DELETE FROM blob_gc WHERE hash = 'h-pd2'`).run();
    expect((await patchMount(mountId, { poolMembers: [{ providerId: keepProvider }] })).status).toBe(200);
  });
});

describe('挂载删除与在途会话的竞态收敛', () => {
  it('存在在途上传会话 → 409；会话清理后可删', async () => {
    const providerId = await createProvider('pd-del');
    const mountId = await createMount('/pd-del', providerId);
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO upload_sessions (id, user_id, mount_id, object_key, path, file_name, file_size, quota_reserved,
           provider_id, status, expires_at, created_at)
         VALUES ('pd-del-sess', ?, ?, 'k', '/pd-del', 'f', 1, 0, ?, 'pending', ?, ?)`
      )
      .run(adminId, mountId, providerId, now + 3_600_000, now);

    const blocked = await request(ctx, `/api/admin/mounts/${mountId}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
    });
    expect(blocked.status).toBe(409);

    ctx.db.prepare(`DELETE FROM upload_sessions WHERE id = 'pd-del-sess'`).run();
    const removed = await request(ctx, `/api/admin/mounts/${mountId}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
    });
    expect(removed.status).toBe(200);
    const still = ctx.db.prepare('SELECT id FROM mounts WHERE id = ?').get(mountId);
    expect(still).toBeUndefined();
  });
});
