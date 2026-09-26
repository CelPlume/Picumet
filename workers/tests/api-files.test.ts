// API 集成测试：文件全流程（上传/列表/下载/重命名/密码/删除/移动）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { Db, MountRepo, MountRolePermissionsRepo, ProviderRepo, RuleRepo } from '../src/db';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

async function uploadFile(cookie: string, fileName: string, content: string, path = '/', mime = 'text/plain') {
  const bytes = new TextEncoder().encode(content);
  const csrf = await getCsrf(ctx, cookie);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, fileName, fileSize: bytes.byteLength, mimeType: mime },
  });
  expect(initRes.status).toBe(200);
  const initData = (await json(initRes)).data as { sessionId: string; uploadMode: string };

  // worker 模式：PUT 原始 body
  const rawRes = await request(ctx, `/api/files/upload/raw/${initData.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': mime, 'X-CSRF-Token': csrf },
    body: new TextDecoder().decode(bytes),
  });
  expect(rawRes.status).toBe(200);
  const rawData = (await json(rawRes)).data as { etag: string; size: number };

  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: initData.sessionId, etag: rawData.etag },
  });
  expect(completeRes.status).toBe(200);
  return (await json(completeRes)).data as { file: { id: string; name: string; path: string; size: number } };
}

describe('文件全流程', () => {
  it('上传 → 列表 → 详情 → 下载', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'fileuser');
    const uploaded = await uploadFile(authCookie, 'hello.txt', 'Hello Picumet!\n');
    expect(uploaded.file.size).toBe(15);

    // 列表
    const listRes = await request(ctx, '/api/files?path=/', { cookie: authCookie });
    expect(listRes.status).toBe(200);
    const listData = await json(listRes);
    expect(listData.data.items.length).toBeGreaterThan(0);
    expect(listData.data.items.some((i: { name: string }) => i.name === 'hello.txt')).toBe(true);

    // 详情
    const detailRes = await request(ctx, `/api/files/${uploaded.file.id}`, { cookie: authCookie });
    expect(detailRes.status).toBe(200);
    const detailData = await json(detailRes);
    expect(detailData.data.file.name).toBe('hello.txt');
    expect(detailData.data.permissions).toContain('read');

    // 下载链接
    const dlRes = await request(ctx, `/api/files/${uploaded.file.id}/download`, { cookie: authCookie });
    expect(dlRes.status).toBe(200);
    const dlData = await json(dlRes);
    expect(dlData.data.url).toContain('/api/gateway/download/');

    // 通过网关实际下载
    const gwRes = await request(ctx, dlData.data.url.replace('http://localhost:8787', ''));
    expect(gwRes.status).toBe(200);
    expect(await gwRes.text()).toBe('Hello Picumet!\n');

    // 复制链接（直链为公开路径 URL）
    const linkRes = await request(ctx, `/api/files/${uploaded.file.id}/copy-links`, { cookie: authCookie });
    const linkData = await json(linkRes);
    expect(linkData.data.formats.direct).toContain('/hello.txt');
    expect(linkData.data.formats.markdown).toContain('![hello.txt](');
  });

  it('创建文件夹并上传到子目录', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'folderuser');
    const csrf = await getCsrf(ctx, authCookie);
    const mkRes = await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: '子目录' },
    });
    expect(mkRes.status).toBe(201);

    await uploadFile(authCookie, 'inside.txt', 'inside', '/子目录');
    const listRes = await request(ctx, '/api/files?path=/子目录', { cookie: authCookie });
    const listData = await json(listRes);
    expect(listData.data.items.some((i: { name: string }) => i.name === 'inside.txt')).toBe(true);
  });

  it('重命名文件', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'renameuser');
    const uploaded = await uploadFile(authCookie, 'old.txt', 'x');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, `/api/files/${uploaded.file.id}`, {
      method: 'PUT',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'new.txt' },
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.data.file.name).toBe('new.txt');
  });

  it('设置密码 → owner 免密下载（§4.4c 豁免）→ 非 owner 需验密 → 验证后可下载', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'pwduser');
    const uploaded = await uploadFile(authCookie, 'secret.txt', 'topsecret');
    const csrf = await getCsrf(ctx, authCookie);

    // 设置密码
    const setRes = await request(ctx, `/api/files/${uploaded.file.id}`, {
      method: 'PUT',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { accessPassword: 's3cret', visibility: 'users' },
    });
    expect(setRes.status).toBe(200);

    // owner 直接下载：§4.4c 密码豁免（管理员/owner 不受限）
    const ownerRes = await request(ctx, `/api/files/${uploaded.file.id}/download`, { cookie: authCookie });
    expect(ownerRes.status).toBe(200);
    const ownerData = await json(ownerRes);
    expect(ownerData.data.url).toContain('/api/gateway/download/');

    // 非 owner（users 可见性有 download 权限）无密码被拒
    const other = await registerAndLogin(ctx, 'pwother' + Math.random().toString(36).slice(2, 6));
    const otherCsrf = await getCsrf(ctx, other.authCookie);
    const dlRes = await request(ctx, `/api/files/${uploaded.file.id}/download`, { cookie: other.authCookie });
    expect(dlRes.status).toBe(403);
    expect((await json(dlRes)).error.code).toBe('PASSWORD_REQUIRED');

    // 错误密码
    const badRes = await request(ctx, `/api/files/${uploaded.file.id}/verify-password`, {
      method: 'POST',
      cookie: other.authCookie,
      headers: { 'X-CSRF-Token': otherCsrf },
      body: { password: 'wrong' },
    });
    expect(badRes.status).toBe(401);

    // 正确密码
    const okRes = await request(ctx, `/api/files/${uploaded.file.id}/verify-password`, {
      method: 'POST',
      cookie: other.authCookie,
      headers: { 'X-CSRF-Token': otherCsrf },
      body: { password: 's3cret' },
    });
    expect(okRes.status).toBe(200);
    const okData = await json(okRes);
    expect(okData.data.url).toContain('/api/gateway/download/');

    // 用密码验证后的 token 下载
    const gwRes = await request(ctx, okData.data.url.replace('http://localhost:8787', ''));
    expect(gwRes.status).toBe(200);
    expect(await gwRes.text()).toBe('topsecret');

    // owner 的豁免 token 同样可下载
    const ownerGw = await request(ctx, ownerData.data.url.replace('http://localhost:8787', ''));
    expect(ownerGw.status).toBe(200);
    expect(await ownerGw.text()).toBe('topsecret');
  });

  it('删除文件', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'deluser');
    const uploaded = await uploadFile(authCookie, 'del.txt', 'bye');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, `/api/files/${uploaded.file.id}`, {
      method: 'DELETE',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(200);
    const detailRes = await request(ctx, `/api/files/${uploaded.file.id}`, { cookie: authCookie });
    expect(detailRes.status).toBe(404);
  });

  it('移动文件（Saga）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'moveuser');
    const csrf = await getCsrf(ctx, authCookie);
    // 创建目标文件夹
    await request(ctx, '/api/files/folder', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/', name: '目标' },
    });
    const uploaded = await uploadFile(authCookie, 'moveme.txt', 'mv');

    const moveRes = await request(ctx, `/api/files/${uploaded.file.id}/move`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/目标' },
    });
    expect(moveRes.status).toBe(200);
    const moveData = await json(moveRes);
    expect(moveData.data.jobId).toBeTruthy();

    // 任务状态
    const jobRes = await request(ctx, `/api/files/jobs/${moveData.data.jobId}`, { cookie: authCookie });
    const jobData = await json(jobRes);
    expect(['completed', 'running', 'pending']).toContain(jobData.data.job.status);

    // 目标路径下出现文件
    const listRes = await request(ctx, '/api/files?path=/目标', { cookie: authCookie });
    const listData = await json(listRes);
    expect(listData.data.items.some((i: { name: string }) => i.name === 'moveme.txt')).toBe(true);
  });

  it('批量删除', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'batchuser');
    const a = await uploadFile(authCookie, 'a.txt', 'a');
    const b = await uploadFile(authCookie, 'b.txt', 'b');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, '/api/files/batch', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { action: 'delete', fileIds: [a.file.id, b.file.id], permanent: true },
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.data.succeeded).toContain(a.file.id);
    expect(data.data.succeeded).toContain(b.file.id);
  });
});

// ============ 可见性过滤、子目录规则复核与无根拓扑 ============

type ListItems = Array<{ id: string; name: string; path: string; type: string; size: number; visibility: string }>;

async function uploadTo(c: TestContext, cookie: string, fileName: string, content: string, path = '/'): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const csrf = await getCsrf(c, cookie);
  const initRes = await request(c, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  expect(initRes.status).toBe(200);
  const sessionId = (await json<{ data: { sessionId: string } }>(initRes)).data.sessionId;
  const raw = await request(c, `/api/files/upload/raw/${sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  expect(raw.status).toBe(200);
  const etag = (await json<{ data: { etag: string } }>(raw)).data.etag;
  const done = await request(c, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId, etag },
  });
  expect(done.status).toBe(200);
  return (await json<{ data: { file: { id: string } } }>(done)).data.file.id;
}

async function createFolder(c: TestContext, cookie: string, path: string, name: string): Promise<string> {
  const csrf = await getCsrf(c, cookie);
  const res = await request(c, '/api/files/folder', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, name },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { file: { id: string } } }>(res)).data.file.id;
}

async function patchVisibility(c: TestContext, cookie: string, fileId: string, visibility: string): Promise<Response> {
  const csrf = await getCsrf(c, cookie);
  return request(c, `/api/files/${fileId}`, {
    method: 'PUT',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { visibility, cascade: true },
  });
}

/** 注册并把角色提升为 admin（角色变更需重新登录，JWT 与库内角色一致性校验） */
async function registerAdmin(c: TestContext, username: string): Promise<string> {
  await registerAndLogin(c, username);
  c.db.exec(`UPDATE users SET role = 'admin' WHERE username = '${username}'`);
  const res = await request(c, '/api/auth/login', { method: 'POST', body: { username, password: 'password123' } });
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  return `auth_token=${token?.[1] ?? ''}`;
}

async function listItems(c: TestContext, cookie: string, path: string): Promise<ListItems> {
  const res = await request(c, `/api/files?path=${encodeURIComponent(path)}`, { cookie });
  expect(res.status).toBe(200);
  return (await json<{ data: { items: ListItems } }>(res)).data.items;
}

async function treeItems(c: TestContext, cookie: string, path = '/'): Promise<ListItems> {
  const res = await request(c, `/api/files/tree?path=${encodeURIComponent(path)}`, { cookie });
  expect(res.status).toBe(200);
  return (await json<{ data: { items: ListItems } }>(res)).data.items;
}

describe('列表与树统一 §4.4a 可见性过滤', () => {
  let c: TestContext;
  beforeAll(async () => {
    c = createTestContext();
    await initSeeded(c);
  });

  it('非属主看不到他人 private 文件与文件夹；属主与管理员可见（列表与树一致）', async () => {
    const owner = await registerAndLogin(c, 'vis_owner');
    await uploadTo(c, owner.authCookie, '私有文件.txt', 'secret');
    await createFolder(c, owner.authCookie, '/', '私有目录');
    await uploadTo(c, owner.authCookie, '里.txt', 'inner', '/私有目录');

    const other = await registerAndLogin(c, 'vis_other');
    const otherList = await listItems(c, other.authCookie, '/');
    expect(otherList.some((i) => i.name === '私有文件.txt')).toBe(false);
    expect(otherList.some((i) => i.name === '私有目录')).toBe(false);
    const otherTree = await treeItems(c, other.authCookie);
    expect(otherTree.some((i) => i.name === '私有文件.txt')).toBe(false);
    expect(otherTree.some((i) => i.path === '/私有目录')).toBe(false);
    expect(otherTree.some((i) => i.name === '里.txt')).toBe(false);

    const ownerList = await listItems(c, owner.authCookie, '/');
    expect(ownerList.some((i) => i.name === '私有文件.txt')).toBe(true);
    expect(ownerList.some((i) => i.name === '私有目录')).toBe(true);
    const ownerTree = await treeItems(c, owner.authCookie);
    expect(ownerTree.some((i) => i.path === '/私有目录')).toBe(true);
    expect(ownerTree.some((i) => i.name === '里.txt')).toBe(true);

    const adminCookie = await registerAdmin(c, 'vis_admin');
    const adminList = await listItems(c, adminCookie, '/');
    expect(adminList.some((i) => i.name === '私有文件.txt')).toBe(true);
    expect(adminList.some((i) => i.name === '私有目录')).toBe(true);
    const adminTree = await treeItems(c, adminCookie);
    expect(adminTree.some((i) => i.path === '/私有目录')).toBe(true);
  });
});

describe('树按规则复核子目录', () => {
  let c: TestContext;
  let db: Db;
  beforeAll(async () => {
    c = createTestContext();
    await initSeeded(c);
    db = Db.fromSqlite(c.db);
  });

  it('deny 规则命中的目录及其后代在树中隐藏（同路径直接列表 403 一致）', async () => {
    const owner = await registerAndLogin(c, 'rule_owner');
    const folderId = await createFolder(c, owner.authCookie, '/', '受限目录');
    await uploadTo(c, owner.authCookie, '内部.txt', 'x', '/受限目录');
    // 置 users：让隐藏只可能来自规则，而不是 §4.4a 可见性
    expect((await patchVisibility(c, owner.authCookie, folderId, 'users')).status).toBe(200);

    const other = await registerAndLogin(c, 'rule_viewer');
    const before = await treeItems(c, other.authCookie);
    expect(before.some((i) => i.path === '/受限目录')).toBe(true);
    expect(before.some((i) => i.name === '内部.txt')).toBe(true);

    const rootMount = (await MountRepo.listMounts(db)).find((m) => m.mountPath === '/');
    expect(rootMount).toBeTruthy();
    await RuleRepo.createRule(db, {
      pathPattern: '/受限目录',
      effect: 'deny',
      mountId: rootMount!.id,
      role: 'user',
      permissions: ['read'],
      requirePassword: false,
      priority: 0,
    });

    const after = await treeItems(c, other.authCookie);
    expect(after.some((i) => i.path === '/受限目录')).toBe(false);
    expect(after.some((i) => i.name === '内部.txt')).toBe(false);

    // 与树过滤同一门禁：同路径直接列表同样 403
    const direct = await request(c, `/api/files?path=${encodeURIComponent('/受限目录')}`, { cookie: other.authCookie });
    expect(direct.status).toBe(403);
  });
});

describe('可见性级联 LIKE 转义', () => {
  let c: TestContext;
  beforeAll(async () => {
    c = createTestContext();
    await initSeeded(c);
  });

  it('含 % 的目录名级联只影响自身子树，不误伤共享前缀的兄弟目录', async () => {
    const owner = await registerAndLogin(c, 'pct_owner');
    const pctId = await createFolder(c, owner.authCookie, '/', '100%');
    await createFolder(c, owner.authCookie, '/100%', 'deep');
    await uploadTo(c, owner.authCookie, 'a.txt', 'a', '/100%');

    await createFolder(c, owner.authCookie, '/', '100x');
    await createFolder(c, owner.authCookie, '/100x', 'sub');
    await uploadTo(c, owner.authCookie, 'b.txt', 'b', '/100x/sub');

    expect((await patchVisibility(c, owner.authCookie, pctId, 'users')).status).toBe(200);

    // 自身子树（含更深后代）已级联
    const ownDeep = await listItems(c, owner.authCookie, '/100%');
    expect(ownDeep.find((i) => i.name === 'deep')?.visibility).toBe('users');
    expect(ownDeep.find((i) => i.name === 'a.txt')?.visibility).toBe('users');

    // 兄弟子树（名字共享前缀）不受影响：未转义的 '/100%/%' 会误伤 '/100x/sub'
    const siblingSub = await listItems(c, owner.authCookie, '/100x');
    expect(siblingSub.find((i) => i.name === 'sub')?.visibility).toBe('private');
    const siblingDeep = await listItems(c, owner.authCookie, '/100x/sub');
    expect(siblingDeep.find((i) => i.name === 'b.txt')?.visibility).toBe('private');
  });
});

describe('合成根（无根拓扑）', () => {
  let c: TestContext;
  let db: Db;
  let adminCookie = '';
  beforeAll(async () => {
    c = createTestContext();
    await initSeeded(c);
    db = Db.fromSqlite(c.db);
    // 删根挂载（file_metadata / mount_providers 级联清理），构造仅 /storage1..3 的无根拓扑
    const root = (await MountRepo.listMounts(db)).find((m) => m.mountPath === '/');
    expect(root).toBeTruthy();
    await db.run('DELETE FROM mounts WHERE id = ?', [root!.id]);
    const providerId = (await ProviderRepo.listProviders(db))[0].id;
    for (const name of ['storage1', 'storage2', 'storage3']) {
      await MountRepo.createMount(db, { providerId, mountPath: `/${name}`, name });
    }
    adminCookie = await registerAdmin(c, 'noroot_admin');
  });

  it('GET /api/files?path=/ 返回三个虚拟目录，树同样可见；未挂载路径仍 404', async () => {
    const u = await registerAndLogin(c, 'noroot_user');
    const listRes = await request(c, '/api/files?path=/', { cookie: u.authCookie });
    expect(listRes.status).toBe(200);
    const listData = (
      await json<{
        data: { items: ListItems; mount: unknown; pagination: { total: number; page: number; limit: number; pages: number } };
      }>(listRes)
    ).data;
    expect(listData.mount).toBeNull();
    expect(listData.items.map((i) => i.name).sort()).toEqual(['storage1', 'storage2', 'storage3']);
    expect(listData.items.every((i) => i.id === `vroot:${i.path}` && i.type === 'folder' && i.size === 0)).toBe(true);
    expect(listData.pagination).toEqual({ total: 3, page: 1, limit: 3, pages: 1 });

    const tree = await treeItems(c, u.authCookie);
    expect(tree.map((i) => i.path).sort()).toEqual(['/storage1', '/storage2', '/storage3']);

    const nf = await request(c, '/api/files?path=/nope', { cookie: u.authCookie });
    expect(nf.status).toBe(404);

    // 上传/其它入口不做合成：虚拟路径上传自然 404
    const csrf = await getCsrf(c, u.authCookie);
    const up = await request(c, '/api/files/upload-session', {
      method: 'POST',
      cookie: u.authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { path: '/vroot-ghost', fileName: 'x.txt', fileSize: 1, mimeType: 'text/plain' },
    });
    expect(up.status).toBe(404);
  });

  it('不可读挂载的虚拟项对普通用户隐藏，管理员可见', async () => {
    const u = await registerAndLogin(c, 'noroot_user2');
    const s2 = (await MountRepo.listMounts(db)).find((m) => m.mountPath === '/storage2');
    expect(s2).toBeTruthy();
    await MountRolePermissionsRepo.setForMount(db, s2!.id, [{ role: 'user', permissions: ['write', 'download'] }]);
    try {
      const list = await listItems(c, u.authCookie, '/');
      expect(list.map((i) => i.name).sort()).toEqual(['storage1', 'storage3']);
      const tree = await treeItems(c, u.authCookie);
      expect(tree.map((i) => i.path).sort()).toEqual(['/storage1', '/storage3']);

      const adminList = await listItems(c, adminCookie, '/');
      expect(adminList.map((i) => i.name).sort()).toEqual(['storage1', 'storage2', 'storage3']);
    } finally {
      await MountRolePermissionsRepo.setForMount(db, s2!.id, []);
    }
  });
});
