// 用户模型 API 集成测试（§4.4 + §4.2）：规则路由 / 能力位门禁 / 可见性 / 审核流 / gallery
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule,
  type TestContext,
} from './helpers';
import { UserRepo, MountRepo, FileRepo, Db } from '../src/db';

let ctx: TestContext;
let alice = { authCookie: '', userId: '', csrf: '' };
let bob = { authCookie: '', userId: '', csrf: '' };
let fileId = '';
let folderId = '';

async function loginAs(name: string) {
  const { authCookie, userId } = await registerAndLogin(ctx, name);
  const csrf = await getCsrf(ctx, authCookie);
  return { authCookie, userId, csrf };
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  alice = await loginAs('ua' + Math.random().toString(36).slice(2, 6));
  bob = await loginAs('ub' + Math.random().toString(36).slice(2, 6));

  const db = Db.fromSqlite(ctx.db);
  const mount = (await MountRepo.listMounts(db))[0];
  // alice 的文件夹 + 文件（file 行 path=父目录）
  const folder = await FileRepo.createFile(db, {
    mountId: mount.id, objectKey: 'folder:alice-home', path: '/alice-home', name: 'alice-home',
    type: 'folder', size: 0, ownerId: alice.userId,
  });
  folderId = folder.id;
  const file = await FileRepo.createFile(db, {
    mountId: mount.id, objectKey: 'alice-home/pic.png', path: '/alice-home', name: 'pic.png',
    type: 'file', size: 10, mimeType: 'image/png', ownerId: alice.userId,
  });
  fileId = file.id;
  // bob 的根边界收紧到自己的空间（否则 defaultPath='/' 无边界可测）
  await UserRepo.updateUser(db, bob.userId, { default_path: `/home-${bob.userId}` });
});

describe('用户自建访问规则（§4.4b）', () => {
  it('无 can_grant 能力位 → 403', async () => {
    const res = await request(ctx, '/api/users/rules', {
      method: 'POST', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
      body: { itemId: fileId, effect: 'allow', allUsers: true, permissions: ['read', 'download'] },
    });
    expect(res.status).toBe(403);
  });

  it('管理员授予 can_grant 后创建成功（针对全部用户）', async () => {
    const db = Db.fromSqlite(ctx.db);
    await UserRepo.updateUser(db, alice.userId, { capabilities: JSON.stringify(['can_grant', 'can_publish']) });
    const res = await request(ctx, '/api/users/rules', {
      method: 'POST', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
      body: { itemId: fileId, effect: 'allow', allUsers: true, permissions: ['read', 'download'] },
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.data.rule.origin).toBe('user');
    expect(data.data.rule.createdBy).toBe(alice.userId);
    expect(data.data.rule.priority).toBe(0);
  });

  it('规则列表仅含本人 user-origin 规则', async () => {
    const res = await request(ctx, '/api/users/rules', { cookie: alice.authCookie });
    const data = await json(res);
    expect(data.data.rules.length).toBe(1);
  });

  it('禁止以管理员为目标 / 写入权限拒绝', async () => {
    const db = Db.fromSqlite(ctx.db);
    const admin = await UserRepo.getUserByUsername(db, 'admin');
    const resAdmin = await request(ctx, '/api/users/rules', {
      method: 'POST', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
      body: { itemId: fileId, effect: 'allow', targetUserId: admin!.id, permissions: ['read'] },
    });
    expect(resAdmin.status).toBe(400);
    const resWrite = await request(ctx, '/api/users/rules', {
      method: 'POST', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
      body: { itemId: fileId, effect: 'allow', allUsers: true, permissions: ['write'] },
    });
    expect(resWrite.status).toBe(400);
  });
});

describe('可见性（§4.4a）', () => {
  it('bob 越界读取被拒（默认 private + 根边界）', async () => {
    const res = await request(ctx, `/api/files/${fileId}`, { cookie: bob.authCookie });
    expect(res.status).toBe(403);
  });

  it('alice 置 visibility=users（无需能力位）→ bob 可读', async () => {
    const put = await request(ctx, `/api/files/${fileId}`, {
      method: 'PUT', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
      body: { visibility: 'users' },
    });
    expect(put.status).toBe(200);
    const res = await request(ctx, `/api/files/${fileId}`, { cookie: bob.authCookie });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.data.file.visibility).toBe('users');
  });

  it('alice 针对性 deny bob → bob 被拒（公开但禁止某人）', async () => {
    const create = await request(ctx, '/api/users/rules', {
      method: 'POST', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
      body: { itemId: fileId, effect: 'deny', targetUserId: bob.userId, permissions: ['read', 'download'] },
    });
    expect(create.status).toBe(201);
    const res = await request(ctx, `/api/files/${fileId}`, { cookie: bob.authCookie });
    expect(res.status).toBe(403);
  });

  it('写入类永不豁免：bob 不可删除/更新 alice 的 users 文件', async () => {
    const res = await request(ctx, `/api/files/${fileId}`, {
      method: 'PUT', cookie: bob.authCookie, headers: { 'X-CSRF-Token': bob.csrf },
      body: { visibility: 'private' },
    });
    expect(res.status).toBe(403);
  });

  it('撤销 deny 规则后 bob 恢复可读；他人规则不可删', async () => {
    const list = await json(await request(ctx, '/api/users/rules', { cookie: alice.authCookie }));
    const deny = list.data.rules.find((r: { effect: string }) => r.effect === 'deny');
    const foreign = await request(ctx, `/api/users/rules/${deny.id}`, {
      method: 'DELETE', cookie: bob.authCookie, headers: { 'X-CSRF-Token': bob.csrf },
    });
    expect(foreign.status).toBe(403);
    const del = await request(ctx, `/api/users/rules/${deny.id}`, {
      method: 'DELETE', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
    });
    expect(del.status).toBe(200);
    const res = await request(ctx, `/api/files/${fileId}`, { cookie: bob.authCookie });
    expect(res.status).toBe(200);
  });
});

describe('公开空间与审核（§4.2）', () => {
  it('alice（无 can_publish 亦可提交）置 public → pending，不出现在 gallery', async () => {
    const db = Db.fromSqlite(ctx.db);
    await UserRepo.updateUser(db, alice.userId, { capabilities: JSON.stringify(['can_grant']) });
    const put = await request(ctx, `/api/files/${fileId}`, {
      method: 'PUT', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
      body: { visibility: 'public' },
    });
    expect(put.status).toBe(200);
    const file = await FileRepo.getFileById(db, fileId);
    expect(file?.reviewStatus).toBe('pending');
    const gallery = await json(await request(ctx, '/api/gallery'));
    expect(gallery.data.items.find((i: { id: string }) => i.id === fileId)).toBeUndefined();
  });

  it('folder 置 public 级联子树；admin 批准后进入 gallery 并可取下载链接', async () => {
    const db = Db.fromSqlite(ctx.db);
    // JWT 携带登录时角色：先提权再登录
    const adminName = 'admr' + Math.random().toString(36).slice(2, 6);
    const pending = await loginAs(adminName);
    await UserRepo.updateUser(db, pending.userId, { role: 'admin' });
    const admin = await loginAs(adminName);

    const put = await request(ctx, `/api/files/${folderId}`, {
      method: 'PUT', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
      body: { visibility: 'public' },
    });
    expect(put.status).toBe(200);
    const child = await FileRepo.getFileById(db, fileId);
    expect(child?.visibility).toBe('public');
    expect(child?.reviewStatus).toBe('pending');

    const review = await request(ctx, `/api/admin/files/${fileId}/review`, {
      method: 'PATCH', cookie: admin.authCookie, headers: { 'X-CSRF-Token': admin.csrf },
      body: { status: 'approved' },
    });
    expect(review.status).toBe(200);

    const gallery = await json(await request(ctx, '/api/gallery'));
    const item = gallery.data.items.find((i: { id: string }) => i.id === fileId);
    expect(item).toBeTruthy();
    expect(item.ownerName).toBeTruthy();

    const dl = await json(await request(ctx, `/api/gallery/${fileId}/download`));
    expect(dl.data.url).toContain('/api/gateway/download/');
  });

  it('can_publish 用户置 public 直接 approved', async () => {
    const db = Db.fromSqlite(ctx.db);
    await UserRepo.updateUser(db, alice.userId, { capabilities: JSON.stringify(['can_grant', 'can_publish']) });
    const put = await request(ctx, `/api/files/${fileId}`, {
      method: 'PUT', cookie: alice.authCookie, headers: { 'X-CSRF-Token': alice.csrf },
      body: { visibility: 'public' },
    });
    expect(put.status).toBe(200);
    const file = await FileRepo.getFileById(db, fileId);
    expect(file?.reviewStatus).toBe('approved');
  });
});

describe('上传链路 owner 绑定 + 管理员可见性管控', () => {
  async function createKey(user: { authCookie: string; csrf: string }) {
    const res = await request(ctx, '/api/keys', {
      method: 'POST', cookie: user.authCookie, headers: { 'X-CSRF-Token': user.csrf },
      body: { name: 'k', permissions: ['write', 'read'], protocols: ['api'], uploadPath: '/uploads' },
    });
    const data = await json(res);
    await grantApiKeyRule(ctx, data.data.key.keyId, ['write', 'read'], '/uploads/**');
    return data.data.key.fullToken as string;
  }

  it('compat 上传绑定属主；跨属主读取 403', async () => {
    const aliceToken = await createKey(alice);
    const bobToken = await createKey(bob);

    const form = new FormData();
    form.append('file', new File([new Blob(['owned-by-alice'])], 'own.png', { type: 'image/png' }));
    const up = await request(ctx, '/api/upload', {
      method: 'POST', headers: { Authorization: `Bearer ${aliceToken}` }, body: form,
    });
    expect(up.status).toBe(200);
    const upData = await json(up);
    const fileId2 = upData.data.fileId as string;

    // alice 自己可读
    const own = await request(ctx, `/api/compat/file?path=/uploads/own.png`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(own.status).toBe(200);

    // bob 的密钥读 alice 的文件 → owner 绑定，他人文件不可见（404）
    const foreign = await request(ctx, `/api/compat/file?path=/uploads/own.png`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    expect(foreign.status).toBe(404);

    // 跨属主覆盖 → 409（write.ts 对象键占用保护）
    const form2 = new FormData();
    form2.append('file', new File([new Blob(['owned-by-bob'])], 'own.png', { type: 'image/png' }));
    const overwrite = await request(ctx, '/api/upload', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}` }, body: form2,
    });
    expect(overwrite.status).toBe(409);

    void fileId2;
  });

  it('管理员可见可改用户文件可见性（管理管控面）', async () => {
    const db = Db.fromSqlite(ctx.db);
    const adminName = 'adm2' + Math.random().toString(36).slice(2, 6);
    const pending = await loginAs(adminName);
    await UserRepo.updateUser(db, pending.userId, { role: 'admin' });
    const admin = await loginAs(adminName);

    const res = await request(ctx, `/api/admin/files/${fileId}/review`, {
      method: 'PATCH', cookie: admin.authCookie, headers: { 'X-CSRF-Token': admin.csrf },
      body: { visibility: 'private' },
    });
    expect(res.status).toBe(200);
    let file = await FileRepo.getFileById(db, fileId);
    expect(file?.visibility).toBe('private');

    await request(ctx, `/api/admin/files/${fileId}/review`, {
      method: 'PATCH', cookie: admin.authCookie, headers: { 'X-CSRF-Token': admin.csrf },
      body: { visibility: 'public' },
    });
    file = await FileRepo.getFileById(db, fileId);
    expect(file?.visibility).toBe('public');
    expect(file?.reviewStatus).toBe('approved');
  });
});
