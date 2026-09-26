// Provider 生命周期约束：
//   · Provider 被 mounts / mount_providers / file_metadata / 未完成 upload_sessions / blob_objects /
//     blob_gc / mount_provider_role_permissions 任一类引用 → 409（details 给各类数量），无引用可删；
//   · 迁移 0006 把 mount_providers / mount_provider_role_permissions 的 provider 外键收紧为 RESTRICT；
//   · 移除仍持有文件/在途会话的池成员 → 409；
//   · 同池成员 provider 的 publicDomain 必须「全有或全无」。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, number> };
}
interface MountListBody {
  data: {
    mounts: Array<{
      id: string;
      mountPath: string;
      poolMembers: Array<{ providerId: string }>;
    }>;
  };
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'plc_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'plc_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'plc_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  adminCookie = `auth_token=${setCookie.match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function createProvider(name: string, publicDomain?: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: publicDomain ? { name, bucket: 'plc-bucket', publicDomain } : { name, bucket: 'plc-bucket' },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { provider: { id: string } } }>(res)).data.provider.id;
}

async function createMount(body: Record<string, unknown>): Promise<string> {
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { priority: 200, ...body },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { mount: { id: string } } }>(res)).data.mount.id;
}

function deleteProvider(id: string): Promise<Response> {
  return request(ctx, `/api/admin/storage/providers/${id}`, {
    method: 'DELETE',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
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

async function mounts(): Promise<MountListBody['data']['mounts']> {
  return (await json<MountListBody>(await request(ctx, '/api/admin/mounts', { cookie: adminCookie }))).data.mounts;
}

/** 测试夹具：单列查询的已知列形状 */
function scalarId(sql: string, ...params: Array<string | number>): string {
  const row = ctx.db.prepare(sql).get(...params) as { id: string } | undefined;
  if (!row) throw new Error(`expected a row for: ${sql}`);
  return row.id;
}

function countOf(sql: string, ...params: Array<string | number>): number {
  const row = ctx.db.prepare(sql).get(...params) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

describe('Provider 生命周期', () => {
  it('迁移 0006：provider 外键 RESTRICT、mount 外键保留 CASCADE', () => {
    const mountProviders = ctx.db.prepare('PRAGMA foreign_key_list(mount_providers)').all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;
    expect(
      mountProviders.some((r) => r.table === 'storage_providers' && r.from === 'provider_id' && r.on_delete === 'RESTRICT')
    ).toBe(true);
    expect(mountProviders.some((r) => r.table === 'mounts' && r.from === 'mount_id' && r.on_delete === 'CASCADE')).toBe(true);

    const bucketMatrices = ctx.db.prepare('PRAGMA foreign_key_list(mount_provider_role_permissions)').all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;
    expect(
      bucketMatrices.some((r) => r.table === 'storage_providers' && r.from === 'provider_id' && r.on_delete === 'RESTRICT')
    ).toBe(true);
    expect(bucketMatrices.some((r) => r.table === 'mounts' && r.from === 'mount_id' && r.on_delete === 'CASCADE')).toBe(true);
  });

  it('被 mounts.provider_id（锚点）引用 → 409 且 details.mounts 计数', async () => {
    const providerId = await createProvider('plc-anchor');
    await createMount({ providerId, mountPath: '/plc-anchor', name: '锚点挂载' });

    const res = await deleteProvider(providerId);
    expect(res.status).toBe(409);
    const body = await json<ErrorBody>(res);
    expect(body.error.message).toContain('仍被引用');
    expect(body.error.details?.mounts ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('被 mount_providers（其他挂载的池成员）引用 → 409 且 details.poolMembers 计数', async () => {
    const member = await createProvider('plc-member');
    const anchor = await createProvider('plc-member-anchor');
    await createMount({
      providerId: anchor,
      mountPath: '/plc-member-mount',
      name: '池成员挂载',
      poolMembers: [{ providerId: anchor }, { providerId: member }],
    });

    const res = await deleteProvider(member);
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.details?.poolMembers ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('被 file_metadata.provider_id（物理落桶）引用 → 409 且 details.files 计数', async () => {
    const providerId = await createProvider('plc-file');
    const mountId = await createMount({ providerId, mountPath: '/plc-file', name: '文件挂载' });
    const owner = scalarId(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, provider_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'file', 1, ?, ?, ?, ?)`
      )
      .run('plc-file-row', mountId, 'plc-file-key', '/', 'a.txt', owner, providerId, now, now);

    const res = await deleteProvider(providerId);
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.details?.files ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('被未完成 upload_sessions.provider_id 引用 → 409 且 details.uploadSessions 计数', async () => {
    const providerId = await createProvider('plc-session');
    const mountId = await createMount({ providerId, mountPath: '/plc-session', name: '会话挂载' });
    const csrf = await getCsrf(ctx, adminCookie);
    const sessionRes = await request(ctx, '/api/files/upload-session', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/plc-session', fileName: 'a.txt', fileSize: 8, mimeType: 'text/plain' },
    });
    expect(sessionRes.status).toBe(200);
    expect(countOf(`SELECT COUNT(*) AS c FROM upload_sessions WHERE mount_id = ? AND provider_id = ?`, mountId, providerId)).toBe(1);

    const res = await deleteProvider(providerId);
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.details?.uploadSessions ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('被 blob_objects / blob_gc 引用 → 409 且计数', async () => {
    const providerId = await createProvider('plc-blob');
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO blob_objects (hash, provider_id, object_key, size, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      )
      .run('plc-hash-object', providerId, 'picumet:blob/plc', now, now);
    ctx.db
      .prepare(`INSERT INTO blob_gc (hash, provider_id, object_key, attempts, created_at) VALUES (?, ?, ?, 0, ?)`)
      .run('plc-hash-gc', providerId, 'picumet:blob/plc-gc', now);

    const res = await deleteProvider(providerId);
    expect(res.status).toBe(409);
    const body = await json<ErrorBody>(res);
    expect(body.error.details?.blobObjects ?? 0).toBeGreaterThanOrEqual(1);
    expect(body.error.details?.blobGc ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('被 mount_provider_role_permissions（桶级矩阵）引用 → 409 且 details.bucketMatrices 计数', async () => {
    const matrixProvider = await createProvider('plc-matrix');
    const anchor = await createProvider('plc-matrix-anchor');
    await createMount({
      providerId: anchor,
      mountPath: '/plc-matrix-mount',
      name: '桶级矩阵挂载',
      poolMembers: [
        { providerId: anchor },
        { providerId: matrixProvider, rolePermissions: [{ role: 'user', permissions: ['read'] }] },
      ],
    });

    const res = await deleteProvider(matrixProvider);
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.details?.bucketMatrices ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('无任何引用 → 可删除（200）', async () => {
    const providerId = await createProvider('plc-unused');
    const res = await deleteProvider(providerId);
    expect(res.status).toBe(200);
    expect(countOf(`SELECT COUNT(*) AS c FROM storage_providers WHERE id = ?`, providerId)).toBe(0);
  });

  it('成员移除前检查：仍有落桶文件/在途会话 → 409；清理后可移除且保留配置', async () => {
    const p1 = await createProvider('plc-rm-1');
    const p2 = await createProvider('plc-rm-2');
    const mountId = await createMount({
      providerId: p1,
      mountPath: '/plc-rm',
      name: '成员移除挂载',
      poolMembers: [{ providerId: p1, weight: 3 }, { providerId: p2, weight: 5 }],
    });
    const owner = scalarId(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, provider_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'file', 1, ?, ?, ?, ?)`
      )
      .run('plc-rm-file', mountId, 'plc-rm-key', '/', 'b.txt', owner, p2, now, now);

    const blocked = await patchMount(mountId, { poolMembers: [{ providerId: p1, weight: 3 }] });
    expect(blocked.status).toBe(409);
    expect((await json<ErrorBody>(blocked)).error.message).toContain('成员仍有文件/在途会话');

    // 清理该成员的文件后移除成功，保留成员 p1 的配置（差异化更新不丢参数）
    ctx.db.prepare(`DELETE FROM file_metadata WHERE id = ?`).run('plc-rm-file');
    const ok = await patchMount(mountId, { poolMembers: [{ providerId: p1, weight: 3 }] });
    expect(ok.status).toBe(200);
    const after = (await mounts()).find((m) => m.id === mountId);
    expect(after?.poolMembers.map((m) => m.providerId)).toEqual([p1]);
  });

  it('同一池混用 publicDomain → 400（全有或全无）', async () => {
    const publicProvider = await createProvider('plc-pub', 'https://cdn.example.com');
    const privateProvider = await createProvider('plc-priv');
    const res = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: {
        providerId: publicProvider,
        mountPath: '/plc-publicity',
        name: '公开性混用',
        priority: 200,
        poolMembers: [{ providerId: publicProvider }, { providerId: privateProvider }],
      },
    });
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).error.message).toContain('publicDomain 全有或全无');
  });
});
