// 跨挂载点移动阻断与存量子树孤儿自愈
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { repairMovedFolderOrphans } from '../src/services/cleanup';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'mc_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'mc_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'mc_admin', password: 'password123' },
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
    body: { name, bucket: 'mc-bucket' },
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

async function mkFolder(cookie: string, csrf: string, path: string, name: string): Promise<string> {
  const res = await request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, name },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { file: { id: string } }).file.id;
}

function fileRow(id: string): { id: string; mount_id: string; path: string; name: string; type: string } {
  const row = ctx.db
    .prepare('SELECT id, mount_id, path, name, type FROM file_metadata WHERE id = ?')
    .get(id) as { id: string; mount_id: string; path: string; name: string; type: string } | undefined;
  expect(row).toBeTruthy();
  return row as { id: string; mount_id: string; path: string; name: string; type: string };
}

function rootMountId(): string {
  return (ctx.db.prepare(`SELECT id FROM mounts WHERE mount_path = '/'`).get() as { id: string }).id;
}

function insertFileRow(id: string, mountId: string, objectKey: string, path: string, name: string, type: 'file' | 'folder', ownerId: string): void {
  const now = Date.now();
  ctx.db
    .prepare(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(id, mountId, objectKey, path, name, type, ownerId, now, now);
}

describe('跨挂载点移动', () => {
  it('跨挂载点移动文件夹 → 422，文件夹原位不动', async () => {
    const providerId = await createProvider('mc-cross');
    await createMount('/mc-crossvol', '跨挂载卷', providerId);

    const user = await registerAndLogin(ctx, 'mc_user1');
    const csrf = await getCsrf(ctx, user.authCookie);
    const folderId = await mkFolder(user.authCookie, csrf, '/', '搬家夹');
    const before = fileRow(folderId);

    const res = await request(ctx, `/api/files/${folderId}/move`, {
      method: 'POST',
      cookie: user.authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/mc-crossvol' },
    });
    expect(res.status).toBe(422);
    const data = await json(res);
    expect(data.error.code).toBe('OPERATION_FAILED');
    expect(data.error.message).toBe('暂不支持跨挂载点移动文件夹');

    // 未建任务、未切换元数据：主行 mount/path 原样
    const after = fileRow(folderId);
    expect(after.mount_id).toBe(before.mount_id);
    expect(after.path).toBe(before.path);
    expect(after.name).toBe(before.name);
  });

  it('同挂载点文件夹移动仍成功', async () => {
    const user = await registerAndLogin(ctx, 'mc_user2');
    const csrf = await getCsrf(ctx, user.authCookie);
    const srcId = await mkFolder(user.authCookie, csrf, '/', '来源夹');
    await mkFolder(user.authCookie, csrf, '/', '去处夹');

    const res = await request(ctx, `/api/files/${srcId}/move`, {
      method: 'POST',
      cookie: user.authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/去处夹' },
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.data.jobId).toBeTruthy();

    // Saga 同步执行：任务应已完成（失败会标 failed）
    const jobRes = await request(ctx, `/api/files/jobs/${data.data.jobId}`, { cookie: user.authCookie });
    expect(jobRes.status).toBe(200);
    const jobData = await json(jobRes);
    expect(jobData.data.job.status).toBe('completed');
  });
});

describe('存量孤儿自愈', () => {
  it('repairMovedFolderOrphans 归位跨挂载子树、跳过嵌套挂载点行', async () => {
    const providerId = await createProvider('mc-repair');
    const crossMountId = await createMount('/mc-repairvol', '自愈仓库', providerId);
    const user = await registerAndLogin(ctx, 'mc_user3');
    const rootId = rootMountId();

    // 文件夹主行（根挂载点）+ 跨挂载漂移的子文件夹与孙文件（历史移动遗留）
    insertFileRow('mc-orphan-p', rootId, 'folder:/孤儿夹', '/孤儿夹', '孤儿夹', 'folder', user.userId);
    insertFileRow('mc-orphan-sub', crossMountId, 'folder:/孤儿夹/漂移夹', '/孤儿夹/漂移夹', '漂移夹', 'folder', user.userId);
    insertFileRow('mc-orphan-inner', crossMountId, 'mc/inner.txt', '/孤儿夹/漂移夹', 'inner.txt', 'file', user.userId);

    // 嵌套挂载点行：子行 mount_id = 嵌套挂载（mount_path 位于父行子树内）→ 合法，必须跳过
    const nestedMountId = await createMount('/孤儿夹/nested', '嵌套挂载', providerId);
    insertFileRow('mc-nested-file', nestedMountId, 'mc/nested-a.txt', '/孤儿夹/nested', 'a.txt', 'file', user.userId);

    const repaired = await repairMovedFolderOrphans(ctx.env);
    expect(repaired).toBe(2);

    expect(fileRow('mc-orphan-sub').mount_id).toBe(rootId);
    expect(fileRow('mc-orphan-inner').mount_id).toBe(rootId);
    // 嵌套挂载点行保持原挂载归属；父行与 provider_id 均不动
    expect(fileRow('mc-nested-file').mount_id).toBe(nestedMountId);
    expect(fileRow('mc-orphan-p').mount_id).toBe(rootId);
    expect(fileRow('mc-orphan-inner').path).toBe('/孤儿夹/漂移夹');

    // 幂等：再跑一遍无新增修复
    expect(await repairMovedFolderOrphans(ctx.env)).toBe(0);
  });
});
