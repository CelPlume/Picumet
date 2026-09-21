// 管理端分享设置：列表补创建者、详情全属性（不下发内部字段）、PATCH 落库与回读、密码重置/清除、撤销/恢复、权限；
// 以及文件属性修改的可见性级联开关（cascade）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';
let ownerCookie = '';
let ownerCsrf = '';
let ownerId = '';
/** 分享创建者用户名（PATCH 的 allowedUsers 用用户名寻址） */
const OWNER = 'as_owner';

let fileA = '';
let fileB = '';

/** 管理端分享详情（仅取测试用到的字段） */
interface AdminShareDetail {
  id: string;
  title?: string;
  creatorId: string;
  creatorName: string;
  status: string;
  expiresAt?: number;
  maxViews?: number;
  viewCount: number;
  maxDownloads?: number;
  downloadCount: number;
  allowPreview: boolean;
  allowDownload: boolean;
  requireLogin: boolean;
  allowedUserCount: number;
  passwordProtected: boolean;
  createdAt: number;
  lastAccessedAt?: number;
  items: Array<{ id: string; name: string; type: string }>;
}

/** 管理端分享列表行（仅取测试用到的字段） */
interface AdminShareListItem {
  id: string;
  creatorId: string;
  creatorName: string;
  itemCount: number;
  passwordProtected: boolean;
  requireLogin: boolean;
  allowedUserCount: number;
  file: { id: string; name: string } | null;
}

/** 管理端响应包络（helpers.json 泛型） */
interface AdminShareBody {
  data: { share: AdminShareDetail };
}
interface AdminShareListBody {
  data: { items: AdminShareListItem[] };
}
interface ErrorBody {
  error: { code: string; message: string };
}

/** shares 行快照（校验落库列，含不下发的内部列） */
interface ShareRow {
  status: string;
  expires_at: number | null;
  max_views: number | null;
  max_downloads: number | null;
  allow_preview: number;
  allow_download: number;
  require_login: number;
  allowed_user_ids: string | null;
  password_hash: string | null;
  password_cipher: string | null;
}

function cookieOf(res: Response): string {
  const match = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  return match ? `auth_token=${match[1]}` : '';
}

async function uploadFile(cookie: string, csrf: string, dir: string, fileName: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: dir, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  const initData = await json<{ data: { sessionId: string } }>(initRes);
  await request(ctx, `/api/files/upload/raw/${initData.data.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: initData.data.sessionId, etag: 'etag' },
  });
  return (await json<{ data: { file: { id: string } } }>(completeRes)).data.file.id;
}

async function createFolder(path: string, name: string): Promise<string> {
  const res = await request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie: ownerCookie,
    headers: { 'X-CSRF-Token': ownerCsrf },
    body: { path, name },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { file: { id: string } } }>(res)).data.file.id;
}

async function createShareId(fileIds: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(ctx, '/api/shares', {
    method: 'POST',
    cookie: ownerCookie,
    headers: { 'X-CSRF-Token': ownerCsrf },
    body: { fileIds, ...extra },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { share: { id: string } } }>(res)).data.share.id;
}

/** 管理端详情/改后回读（GET 与 PATCH 同一响应结构） */
async function adminShare(res: Response): Promise<AdminShareDetail> {
  return (await json<AdminShareBody>(res)).data.share;
}

function getAdminShare(id: string): Promise<Response> {
  return request(ctx, `/api/admin/shares/${id}`, { cookie: adminCookie });
}

function patchAdminShare(id: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/admin/shares/${id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

function shareRow(id: string): ShareRow | undefined {
  return ctx.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow | undefined;
}

function visibilityOf(fileId: string): string | undefined {
  const row = ctx.db.prepare('SELECT visibility FROM file_metadata WHERE id = ?').get(fileId) as
    | { visibility: string }
    | undefined;
  return row?.visibility;
}

function visibilityLogs(path: string): number {
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS c FROM access_logs WHERE action = 'visibility_change' AND path = ?`)
    .get(path) as { c: number };
  return Number(row.c);
}

function putFile(id: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/files/${id}`, {
    method: 'PUT',
    cookie: ownerCookie,
    headers: { 'X-CSRF-Token': ownerCsrf },
    body,
  });
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);

  await registerAndLogin(ctx, 'as_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'as_admin'`);
  const adminLogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'as_admin', password: 'password123' },
  });
  adminCookie = cookieOf(adminLogin);
  adminCsrf = await getCsrf(ctx, adminCookie);

  const owner = await registerAndLogin(ctx, OWNER);
  ownerId = owner.userId;
  ownerCookie = owner.authCookie;
  ownerCsrf = await getCsrf(ctx, ownerCookie);

  fileA = await uploadFile(ownerCookie, ownerCsrf, '/', 'admin-share-a.txt', 'aaa');
  fileB = await uploadFile(ownerCookie, ownerCsrf, '/', 'admin-share-b.txt', 'bbbb');
});

describe('管理端分享列表', () => {
  it('每行带出创建者用户名与既有字段', async () => {
    const shareId = await createShareId([fileA, fileB], { password: 'list-pass', allowedUsers: [OWNER] });
    const res = await request(ctx, '/api/admin/shares?limit=100', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const { items } = (await json<AdminShareListBody>(res)).data;
    const row = items.find((i) => i.id === shareId);
    expect(row).toBeTruthy();
    expect(row!.creatorId).toBe(ownerId);
    expect(row!.creatorName).toBe(OWNER);
    expect(row!.itemCount).toBe(2);
    expect(row!.passwordProtected).toBe(true);
    expect(row!.requireLogin).toBe(false);
    expect(row!.allowedUserCount).toBe(1);
    // 既有 file 字段（首项目）语义不变
    expect(row!.file?.id).toBe(fileA);
    expect(row!.file?.name).toBe('admin-share-a.txt');
  });
});

describe('管理端分享详情', () => {
  it('返回全属性与项目明细，且不下发密码密文 / 对象键', async () => {
    const shareId = await createShareId([fileA, fileB], {
      password: 'detail-pass',
      allowedUsers: [OWNER],
      maxViews: 10,
      maxDownloads: 5,
      allowPreview: true,
      allowDownload: false,
      expiresAt: Date.now() + 3600_000,
    });
    const res = await getAdminShare(shareId);
    expect(res.status).toBe(200);
    const raw = await res.text();
    // 内部字段绝不出现在响应体（含 items 嵌套）
    expect(raw).not.toContain('password_cipher');
    expect(raw).not.toContain('object_key');
    expect(raw).not.toContain('physical_key');

    // 已断言过原始报文，此处按测试定义的响应形状解析
    const body: AdminShareBody = JSON.parse(raw);
    const share = body.data.share;
    expect(share.id).toBe(shareId);
    expect(share.creatorId).toBe(ownerId);
    expect(share.creatorName).toBe(OWNER);
    expect(share.status).toBe('active');
    expect(share.maxViews).toBe(10);
    expect(share.maxDownloads).toBe(5);
    expect(share.allowPreview).toBe(true);
    expect(share.allowDownload).toBe(false);
    expect(share.requireLogin).toBe(false);
    expect(share.allowedUserCount).toBe(1);
    expect(share.passwordProtected).toBe(true);
    expect(typeof share.createdAt).toBe('number');
    expect(share.items.map((i) => i.id)).toEqual([fileA, fileB]);
    const itemKeys = Object.keys(share.items[0]);
    expect(itemKeys).not.toContain('objectKey');
    expect(itemKeys).not.toContain('physicalKey');
    expect(itemKeys).not.toContain('accessPassword');
  });

  it('不存在的分享 → 404', async () => {
    expect((await getAdminShare('no-such-share')).status).toBe(404);
    expect((await patchAdminShare('no-such-share', { status: 'revoked' })).status).toBe(404);
  });
});

describe('管理端修改分享属性', () => {
  it('单次修改多项：落库并回读一致', async () => {
    const shareId = await createShareId([fileA]);
    const res = await patchAdminShare(shareId, {
      status: 'active',
      expiresAt: 4100000000000,
      maxViews: 7,
      maxDownloads: 3,
      allowPreview: false,
      allowDownload: false,
      requireLogin: true,
      allowedUsers: [OWNER],
    });
    expect(res.status).toBe(200);
    const share = await adminShare(res);
    expect(share.expiresAt).toBe(4100000000000);
    expect(share.maxViews).toBe(7);
    expect(share.maxDownloads).toBe(3);
    expect(share.allowPreview).toBe(false);
    expect(share.allowDownload).toBe(false);
    expect(share.requireLogin).toBe(true);
    expect(share.allowedUserCount).toBe(1);

    const row = shareRow(shareId)!;
    expect(row.expires_at).toBe(4100000000000);
    expect(row.max_views).toBe(7);
    expect(row.max_downloads).toBe(3);
    expect(row.allow_preview).toBe(0);
    expect(row.allow_download).toBe(0);
    expect(row.require_login).toBe(1);
    expect(JSON.parse(row.allowed_user_ids ?? '[]')).toEqual([ownerId]);

    // 回读（另开一次 GET）与 PATCH 响应一致
    const reread = await adminShare(await getAdminShare(shareId));
    expect(reread).toMatchObject({
      maxViews: 7,
      maxDownloads: 3,
      allowPreview: false,
      allowDownload: false,
      requireLogin: true,
      allowedUserCount: 1,
      expiresAt: 4100000000000,
    });
  });

  it('null 清除限制：永久 / 不限次数 / 清空白名单', async () => {
    const shareId = await createShareId([fileA], {
      maxViews: 5,
      maxDownloads: 2,
      expiresAt: Date.now() + 600_000,
      allowedUsers: [OWNER],
    });
    const res = await patchAdminShare(shareId, { expiresAt: null, maxViews: null, maxDownloads: null, allowedUsers: null });
    expect(res.status).toBe(200);
    const share = await adminShare(res);
    expect(share.expiresAt).toBeUndefined();
    expect(share.maxViews).toBeUndefined();
    expect(share.maxDownloads).toBeUndefined();
    expect(share.allowedUserCount).toBe(0);

    const row = shareRow(shareId)!;
    expect(row.expires_at).toBeNull();
    expect(row.max_views).toBeNull();
    expect(row.max_downloads).toBeNull();
    expect(row.allowed_user_ids).toBeNull();
  });

  it('白名单可重新指定；未知用户名 → 400 且原值不变', async () => {
    const shareId = await createShareId([fileA]);
    expect((await patchAdminShare(shareId, { allowedUsers: [OWNER] })).status).toBe(200);
    expect(JSON.parse(shareRow(shareId)!.allowed_user_ids ?? '[]')).toEqual([ownerId]);

    const bad = await patchAdminShare(shareId, { allowedUsers: ['no_such_user_404'] });
    expect(bad.status).toBe(400);
    expect((await json<ErrorBody>(bad)).error.message).toContain('no_such_user_404');
    expect(JSON.parse(shareRow(shareId)!.allowed_user_ids ?? '[]')).toEqual([ownerId]);
  });

  it('参数校验：空对象 / 非法枚举 / 非法数字 → 400 且不落库', async () => {
    const shareId = await createShareId([fileA]);
    expect((await patchAdminShare(shareId, {})).status).toBe(400);
    expect((await patchAdminShare(shareId, { status: 'expired' })).status).toBe(400);
    expect((await patchAdminShare(shareId, { maxViews: 0 })).status).toBe(400);
    expect((await patchAdminShare(shareId, { maxDownloads: 1.5 })).status).toBe(400);
    expect((await patchAdminShare(shareId, { expiresAt: -1 })).status).toBe(400);

    const row = shareRow(shareId)!;
    expect(row.expires_at).toBeNull();
    expect(row.max_views).toBeNull();
    expect(row.max_downloads).toBeNull();
    expect(row.status).toBe('active');
  });

  it('重置密码：哈希与密文同时更新，新密码可直进、旧密码失效', async () => {
    const shareId = await createShareId([fileA, fileB], { password: 'old-pass' });
    const before = shareRow(shareId)!;
    expect(before.password_cipher?.startsWith('enc:')).toBe(true);

    const res = await patchAdminShare(shareId, { password: 'new-pass-2026' });
    expect(res.status).toBe(200);
    expect((await adminShare(res)).passwordProtected).toBe(true);

    const after = shareRow(shareId)!;
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(after.password_cipher).not.toBe(before.password_cipher);
    expect(after.password_cipher?.startsWith('enc:')).toBe(true);

    const newAccess = await request(ctx, `/api/shares/${shareId}?password=new-pass-2026`);
    expect(newAccess.status).toBe(200);
    const newDetail = await json<{ data: { share: { items: Array<{ id: string }> } } }>(newAccess);
    expect(newDetail.data.share.items.map((i) => i.id)).toEqual([fileA, fileB]);

    expect((await request(ctx, `/api/shares/${shareId}?password=old-pass`)).status).toBe(401);
  });

  it('清除密码（null 与空串）：两列置 NULL 且公开访问不再需要密码', async () => {
    const clears: Array<string | null> = [null, ''];
    for (const clear of clears) {
      const shareId = await createShareId([fileA], { password: 'to-clear' });
      const res = await patchAdminShare(shareId, { password: clear });
      expect(res.status).toBe(200);
      expect((await adminShare(res)).passwordProtected).toBe(false);

      const row = shareRow(shareId)!;
      expect(row.password_hash).toBeNull();
      expect(row.password_cipher).toBeNull();

      const access = await request(ctx, `/api/shares/${shareId}`);
      expect(access.status).toBe(200);
      const detail = await json<{ data: { share: { requiresPassword: boolean; items: Array<{ id: string }> } } }>(access);
      expect(detail.data.share.requiresPassword).toBe(false);
      expect(detail.data.share.items.map((i) => i.id)).toEqual([fileA]);
    }
  });

  it('status=revoked → 公开访问 410；恢复 active 后可访问', async () => {
    const shareId = await createShareId([fileA]);
    expect((await patchAdminShare(shareId, { status: 'revoked' })).status).toBe(200);
    expect(shareRow(shareId)!.status).toBe('revoked');
    expect((await request(ctx, `/api/shares/${shareId}`)).status).toBe(410);

    expect((await patchAdminShare(shareId, { status: 'active' })).status).toBe(200);
    expect(shareRow(shareId)!.status).toBe('active');
    expect((await request(ctx, `/api/shares/${shareId}`)).status).toBe(200);
  });
});

describe('管理端权限', () => {
  it('普通用户 → 403；匿名 → 401；均不改动分享', async () => {
    const shareId = await createShareId([fileA]);
    expect((await request(ctx, `/api/admin/shares/${shareId}`, { cookie: ownerCookie })).status).toBe(403);
    const ownerPatch = await request(ctx, `/api/admin/shares/${shareId}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      headers: { 'X-CSRF-Token': ownerCsrf },
      body: { status: 'revoked' },
    });
    expect(ownerPatch.status).toBe(403);
    expect((await request(ctx, `/api/admin/shares/${shareId}`)).status).toBe(401);
    const anonPatch = await request(ctx, `/api/admin/shares/${shareId}`, {
      method: 'PATCH',
      body: { status: 'revoked' },
    });
    expect(anonPatch.status).toBe(401);
    expect(shareRow(shareId)!.status).toBe('active');
  });
});

describe('文件可见性级联开关', () => {
  /** 每个用例独立子树：避免上一条用例把子树置为 public 后无法再触发可见性变更 */
  async function makeTree(name: string): Promise<{ folderId: string; childId: string }> {
    const folderId = await createFolder('/', name);
    const childId = await uploadFile(ownerCookie, ownerCsrf, `/${name}`, `${name}-child.txt`, 'child');
    return { folderId, childId };
  }

  it('cascade=false：只改本项，子项可见性不变，审计照常写入', async () => {
    const { folderId, childId } = await makeTree('casc-n');
    expect(visibilityOf(childId)).not.toBe('public');

    expect((await putFile(folderId, { visibility: 'public', cascade: false })).status).toBe(200);
    expect(visibilityOf(folderId)).toBe('public');
    expect(visibilityOf(childId)).not.toBe('public');
    expect(visibilityLogs('/casc-n')).toBe(1);
  });

  it('cascade 缺省或 true：子项跟随父文件夹，审计写入', async () => {
    const explicit = await makeTree('casc-t');
    expect((await putFile(explicit.folderId, { visibility: 'public', cascade: true })).status).toBe(200);
    expect(visibilityOf(explicit.childId)).toBe('public');

    const implicit = await makeTree('casc-d');
    expect((await putFile(implicit.folderId, { visibility: 'public' })).status).toBe(200);
    expect(visibilityOf(implicit.childId)).toBe('public');

    expect(visibilityLogs('/casc-t')).toBe(1);
    expect(visibilityLogs('/casc-d')).toBe(1);
  });
});
