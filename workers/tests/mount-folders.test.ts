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

describe('挂载点目录行身份化', () => {
  /** 测试夹具：单列查询的已知列形状 */
  function scalarId(sql: string, ...params: Array<string | number>): string {
    const row = ctx.db.prepare(sql).get(...params) as { id: string } | undefined;
    if (!row) throw new Error(`expected a row for: ${sql}`);
    return row.id;
  }

  function folderRow(name: string): { id: string; custom_title: string | null } | undefined {
    return ctx.db
      .prepare(`SELECT id, custom_title FROM file_metadata WHERE name = ? AND type = 'folder'`)
      .get(name) as { id: string; custom_title: string | null } | undefined;
  }

  it('同路径被用户目录行占用时拒绝创建挂载（不隐式复用用户行）', async () => {
    const providerId = await createProvider('mfi-provider-1');
    const csrf = await getCsrf(ctx, adminCookie);
    const created = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: 'mfi-occ' },
    });
    expect(created.status).toBe(201);
    const before = folderRow('mfi-occ');
    expect(before).toBeTruthy();

    const res = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { providerId, mountPath: '/mfi-occ', name: '占用挂载', priority: 300 },
    });
    expect(res.status).toBe(409);
    const after = folderRow('mfi-occ');
    expect(after?.id).toBe(before?.id);
    expect(after?.custom_title ?? null).toBe(before?.custom_title ?? null);
  });

  it('同路径被用户文件行占用时拒绝创建挂载（file 行 path=父目录，仍按显示路径判定）', async () => {
    const providerId = await createProvider('mfi-provider-2');
    const rootId = scalarId(`SELECT id FROM mounts WHERE mount_path = '/'`);
    const owner = scalarId(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'file', 1, ?, ?, ?)`
      )
      .run('mfi-user-file', rootId, 'mfi-file', '/', 'mfi-file', owner, now, now);

    const res = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { providerId, mountPath: '/mfi-file', name: '文件占用挂载', priority: 300 },
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: { message: string } }>(res)).error.message).toContain('目标路径已被现有目录/文件占用');
    // 未登记任何挂载身份行（不隐式覆盖用户文件）
    expect(
      ctx.db.prepare(`SELECT id FROM file_metadata WHERE name = 'mfi-file' AND type = 'folder'`).all()
    ).toHaveLength(0);
  });

  it('后台自愈容错：存量挂载点被用户行占用时跳过登记并保留用户行', async () => {
    const providerId = await createProvider('mfi-provider-3');
    const rootId = scalarId(`SELECT id FROM mounts WHERE mount_path = '/'`);
    const owner = scalarId(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
    const now = Date.now();
    const legacyMountId = 'mfi-legacy-mount';
    ctx.db
      .prepare(
        `INSERT INTO mounts (id, provider_id, mount_path, name, priority, created_at, updated_at, status)
         VALUES (?, ?, '/mfi-legacy', '存量挂载', 300, ?, ?, 'active')`
      )
      .run(legacyMountId, providerId, now, now);
    ctx.db
      .prepare(
        `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, custom_title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'folder', 0, ?, ?, ?, ?)`
      )
      .run('mfi-legacy-user', rootId, 'folder:/mfi-legacy', '/mfi-legacy', 'mfi-legacy', owner, '用户目录', now, now);

    const res = await request(ctx, '/api/admin/mounts', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const rows = ctx.db
      .prepare(`SELECT id, custom_title FROM file_metadata WHERE name = 'mfi-legacy' AND type = 'folder'`)
      .all() as Array<{ id: string; custom_title: string | null }>;
    expect(rows.map((r) => r.id)).toEqual(['mfi-legacy-user']);
    expect(rows[0].custom_title).toBe('用户目录');
  });

  it('删除挂载只按确定性身份删行：身份行缺失时用户行不被回收', async () => {
    const providerId = await createProvider('mfi-provider-4');
    const mountId = await createMount('/mfi-idvol', '身份挂载', providerId);
    const rootId = scalarId(`SELECT id FROM mounts WHERE mount_path = '/'`);
    const owner = scalarId(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
    const now = Date.now();
    // 模拟存量复用：删掉身份行，改成用户行（同 mount_id/path/name/type）
    ctx.db.prepare(`DELETE FROM file_metadata WHERE id = ?`).run(`mountfolder:${mountId}`);
    ctx.db
      .prepare(
        `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'folder', 0, ?, ?, ?)`
      )
      .run('mfi-idvol-user', rootId, 'folder:/mfi-idvol', '/mfi-idvol', 'mfi-idvol', owner, now, now);

    const removed = await request(ctx, `/api/admin/mounts/${mountId}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
    });
    expect(removed.status).toBe(200);
    const rows = ctx.db
      .prepare(`SELECT id FROM file_metadata WHERE name = 'mfi-idvol' AND type = 'folder'`)
      .all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['mfi-idvol-user']);
  });
});
