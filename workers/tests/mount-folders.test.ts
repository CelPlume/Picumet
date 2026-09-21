// 挂载点皆目录（§H）：非根挂载点在父命名空间内自动登记为文件夹行，
// 文件页列目录能看到它；挂载点目录行禁止改名/删除；包含挂载点的父目录禁止删除/移动；删除挂载点连带清理行。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'mf_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'mf_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'mf_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${tokenMatch?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function createProvider(name: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name, bucket: 'mf-bucket' },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { provider: { id: string } }).provider.id;
}

async function createMount(mountPath: string, name: string, providerId: string): Promise<string> {
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { providerId, mountPath, name, priority: 300 },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { mount: { id: string } }).mount.id;
}

async function listFiles(path: string): Promise<Array<{ id: string; name: string; type: string; customTitle?: string }>> {
  const res = await request(ctx, `/api/files?path=${encodeURIComponent(path)}`, { cookie: adminCookie });
  expect(res.status).toBe(200);
  return ((await json(res)).data as { items: Array<{ id: string; name: string; type: string; customTitle?: string }> }).items;
}

function rowByPath(path: string, name: string): Array<{ id: string; object_key: string }> {
  return ctx.db
    .prepare(`SELECT id, object_key FROM file_metadata WHERE path = ? AND name = ? AND type = 'folder'`)
    .all(path, name) as Array<{ id: string; object_key: string }>;
}

describe('挂载点皆目录', () => {
  it('新建挂载点后，父目录列表里出现同名文件夹（挂载点目录行）', async () => {
    const providerId = await createProvider('mf-provider-1');
    await createMount('/mfvol', '挂载卷', providerId);

    const items = await listFiles('/');
    const mountFolder = items.find((i) => i.name === 'mfvol');
    expect(mountFolder).toBeTruthy();
    expect(mountFolder?.type).toBe('folder');
    expect(mountFolder?.customTitle).toBe('挂载卷');

    // 文件夹行的约定：path = 自身全路径（写成父目录会让文件树把它当根节点无限递归 → 文件页卡死）
    const rows = ctx.db
      .prepare(`SELECT id, path, object_key FROM file_metadata WHERE name = 'mfvol' AND type = 'folder'`)
      .all() as Array<{ id: string; path: string; object_key: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('/mfvol');
    expect(rows[0].object_key).toBe('folder:/mfvol');
    expect(rows[0].id).toBe(`mountfolder:${(await json(await request(ctx, '/api/admin/mounts', { cookie: adminCookie }))).data.mounts.find((m: { mountPath: string }) => m.mountPath === '/mfvol').id}`);
  });

  it('挂载点目录行禁止改名与删除', async () => {
    const items = await listFiles('/');
    const target = items.find((i) => i.name === 'mfvol');
    expect(target).toBeTruthy();

    const rename = await request(ctx, `/api/files/${target?.id}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { name: 'mfvol-renamed' },
    });
    expect(rename.status).toBe(409);

    const del = await request(ctx, `/api/files/${target?.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
    });
    expect(del.status).toBe(409);
    expect(ctx.db.prepare(`SELECT id FROM file_metadata WHERE name = 'mfvol' AND type = 'folder'`).all()).toHaveLength(1);
  });

  it('包含挂载点的父目录禁止删除与移动', async () => {
    const csrf = await getCsrf(ctx, adminCookie);
    const created = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: 'mfparent' },
    });
    expect(created.status).toBe(201);
    const providerId = await createProvider('mf-provider-2');
    await createMount('/mfparent/child', '子挂载', providerId);

    const parent = (await listFiles('/')).find((i) => i.name === 'mfparent');
    expect(parent).toBeTruthy();

    const del = await request(ctx, `/api/files/${parent?.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(del.status).toBe(409);

    const move = await request(ctx, `/api/files/${parent?.id}/move`, {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/mfvol' },
    });
    expect(move.status).toBe(409);
  });

  it('挂载点路径变更会迁移目录行，删除挂载点会清理目录行', async () => {
    const mountsRes = await json(await request(ctx, '/api/admin/mounts', { cookie: adminCookie }));
    const mount = (mountsRes.data as { mounts: Array<{ id: string; mountPath: string }> }).mounts.find((m) => m.mountPath === '/mfparent/child');
    expect(mount).toBeTruthy();

    const moved = await request(ctx, `/api/admin/mounts/${mount?.id}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { mountPath: '/mfparent/child2' },
    });
    expect(moved.status).toBe(200);
    expect(rowByPath('/mfparent/child', 'child')).toHaveLength(0);
    expect(rowByPath('/mfparent/child2', 'child2')).toHaveLength(1);

    const removed = await request(ctx, `/api/admin/mounts/${mount?.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
    });
    expect(removed.status).toBe(200);
    expect(rowByPath('/mfparent/child2', 'child2')).toHaveLength(0);
  });

  it('迁移回填：缺失目录行的存量挂载点在列目录时自愈补齐', async () => {
    const providerId = await createProvider('mf-provider-3');
    const mountId = await createMount('/mflegacy', '历史挂载', providerId);
    // 模拟存量数据：目录行被手工删掉
    ctx.db.prepare(`DELETE FROM file_metadata WHERE id = ?`).run(`mountfolder:${mountId}`);
    expect(rowByPath('/mflegacy', 'mflegacy')).toHaveLength(0);

    const items = await listFiles('/');
    expect(items.some((i) => i.name === 'mflegacy')).toBe(true);
    expect(rowByPath('/mflegacy', 'mflegacy')).toHaveLength(1);
  });
});
