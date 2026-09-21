// 多项目分享：项目集合创建/去重/上限、公开详情遮蔽、目录浏览作用域、下载令牌作用域、闸门与列表聚合
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let ownerCookie = '';
let ownerCsrf = '';
let adminCookie = '';
let adminCsrf = '';
/** 独立挂载点（priority 200 > 种子根挂载 100），文件与文件夹均落在其下 */
const MOUNT = '/mi';

// 夹具：两个文件 + 一个文件夹（含子目录与后代文件）+ 一棵树外目录
let fileA = '';
let fileB = '';
let dirItem = '';
let subDir = '';
let deepFile = '';
let innerFile = '';
let outsideFile = '';

async function uploadFile(cookie: string, csrf: string, dir: string, fileName: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: dir, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  const initData = (await json(initRes)).data as { sessionId: string };
  await request(ctx, `/api/files/upload/raw/${initData.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: initData.sessionId, etag: 'etag' },
  });
  return ((await json(completeRes)).data as { file: { id: string } }).file.id;
}

async function createFolder(cookie: string, csrf: string, path: string, name: string): Promise<string> {
  const res = await request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, name },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { file: { id: string } }).file.id;
}

function createShare(body: Record<string, unknown>): Promise<Response> {
  return request(ctx, '/api/shares', {
    method: 'POST',
    cookie: ownerCookie,
    headers: { 'X-CSRF-Token': ownerCsrf },
    body,
  });
}

type ShareDetail = {
  id: string;
  title?: string;
  items: Array<{ id: string; name: string; type: string; rootId: string }>;
  allowPreview: boolean;
  allowDownload: boolean;
  requiresPassword: boolean;
  viewCount: number;
  /** 旧字段（多项目改造后应不存在） */
  file?: unknown;
};

async function createShareId(fileIds: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await createShare({ fileIds, ...extra });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { share: { id: string } }).share.id;
}

function shareItemCount(shareId: string): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM share_items WHERE share_id = ?').get(shareId) as { c: number };
  return Number(row.c);
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);

  // 管理员：建独立挂载点（种子根挂载 priority 100，此处 200 确保 findMountForPath 命中）
  await registerAndLogin(ctx, 'mi_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'mi_admin'`);
  const adminLogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'mi_admin', password: 'password123' },
  });
  adminCookie = `auth_token=${(adminLogin.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
  const providers = ((await json(await request(ctx, '/api/admin/storage/providers', { cookie: adminCookie }))).data as {
    providers: Array<{ id: string }>;
  }).providers;
  const mountRes = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { providerId: providers[0].id, mountPath: MOUNT, name: 'mi-test', priority: 200 },
  });
  expect(mountRes.status).toBe(201);

  const { authCookie } = await registerAndLogin(ctx, 'mi_owner');
  ownerCookie = authCookie;
  ownerCsrf = await getCsrf(ctx, ownerCookie);

  fileA = await uploadFile(ownerCookie, ownerCsrf, MOUNT, 'a.txt', 'aaa');
  fileB = await uploadFile(ownerCookie, ownerCsrf, MOUNT, 'b.txt', 'bbbb');
  dirItem = await createFolder(ownerCookie, ownerCsrf, MOUNT, 'dir');
  innerFile = await uploadFile(ownerCookie, ownerCsrf, `${MOUNT}/dir`, 'inner.txt', 'inner');
  subDir = await createFolder(ownerCookie, ownerCsrf, `${MOUNT}/dir`, 'sub');
  deepFile = await uploadFile(ownerCookie, ownerCsrf, `${MOUNT}/dir/sub`, 'deep.txt', 'deep');
  await createFolder(ownerCookie, ownerCsrf, MOUNT, 'other');
  outsideFile = await uploadFile(ownerCookie, ownerCsrf, `${MOUNT}/other`, 'outside.txt', 'outside');
});

describe('多项目创建', () => {
  it('两个文件 + 一个文件夹 → 201，顺序/首项/share_items 与请求一致', async () => {
    const res = await createShare({ fileIds: [fileB, dirItem, fileA] });
    expect(res.status).toBe(201);
    const share = ((await json(res)).data as { share: { id: string; title?: string; items: Array<{ id: string; rootId: string }> } }).share;

    expect(share.items.map((i) => i.id)).toEqual([fileB, dirItem, fileA]);
    // 分享根项目：rootId = 自身 file_id
    expect(share.items.map((i) => i.rootId)).toEqual([fileB, dirItem, fileA]);
    // 多项目缺省标题
    expect(share.title).toBe('3 个项目');

    const row = ctx.db.prepare('SELECT file_id FROM shares WHERE id = ?').get(share.id) as { file_id: string };
    expect(row.file_id).toBe(fileB);
    expect(shareItemCount(share.id)).toBe(3);
    const order = ctx.db
      .prepare('SELECT file_id, sort_order FROM share_items WHERE share_id = ? ORDER BY sort_order ASC')
      .all(share.id) as Array<{ file_id: string; sort_order: number }>;
    expect(order.map((r) => r.file_id)).toEqual([fileB, dirItem, fileA]);
    expect(order.map((r) => Number(r.sort_order))).toEqual([0, 1, 2]);
  });

  it('单项目缺省标题取该项展示名', async () => {
    const id = await createShareId([fileA]);
    const res = await request(ctx, `/api/shares/${id}`);
    const detail = (await json(res)).data as { share: { title?: string } };
    expect(detail.share.title).toBe('a.txt');
  });

  it('重复 id 去重且保持首次出现顺序', async () => {
    const res = await createShare({ fileIds: [fileB, fileA, fileB, fileA] });
    expect(res.status).toBe(201);
    const share = ((await json(res)).data as { share: { id: string; title?: string; items: Array<{ id: string }> } }).share;
    expect(share.items.map((i) => i.id)).toEqual([fileB, fileA]);
    expect(share.title).toBe('2 个项目');
    expect(shareItemCount(share.id)).toBe(2);
  });

  it('超过 50 个项目 → 400；空数组 → 400', async () => {
    const tooMany = await createShare({ fileIds: Array.from({ length: 51 }, () => fileA) });
    expect(tooMany.status).toBe(400);
    const empty = await createShare({ fileIds: [] });
    expect(empty.status).toBe(400);
  });

  it('不存在的项目 id → 404 文件不存在', async () => {
    const res = await createShare({ fileIds: [fileA, 'no-such-file'] });
    expect(res.status).toBe(404);
    expect(((await json(res)).error as { message: string }).message).toContain('文件不存在');
  });
});

describe('公开详情', () => {
  it('返回全部项目且不下发对象键', async () => {
    const shareId = await createShareId([fileA, dirItem]);
    const res = await request(ctx, `/api/shares/${shareId}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    const share = (body.data as { share: ShareDetail }).share;

    expect(share.items.map((i) => i.id)).toEqual([fileA, dirItem]);
    expect(share.items.map((i) => i.type)).toEqual(['file', 'folder']);
    expect(share.items.every((i) => i.rootId === i.id)).toBe(true);
    expect(share.requiresPassword).toBe(false);

    // 公开响应不得出现物理键/对象键（哈希不下发）
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('physical_key');
    expect(raw).not.toContain('object_key');
    expect(raw).not.toContain('physicalKey');
    // 旧字段 file 已下线
    expect(share.file).toBeUndefined();
  });
});

describe('分享内目录浏览', () => {
  let shareId = '';

  beforeAll(async () => {
    shareId = await createShareId([fileA, dirItem]);
  });

  it('root = 文件夹项目 → 返回根目录下子项，rootId 指向该文件夹项目', async () => {
    const res = await request(ctx, `/api/shares/${shareId}/list?root=${dirItem}`);
    expect(res.status).toBe(200);
    const data = (await json(res)).data as { shareId: string; rootId: string; path: string; items: Array<{ id: string; name: string; rootId: string }> };
    expect(data.shareId).toBe(shareId);
    expect(data.rootId).toBe(dirItem);
    expect(data.path).toBe('/');
    // listChildren 排序：文件夹优先，其后按 name 升序
    expect(data.items.map((i) => i.name)).toEqual(['sub', 'inner.txt']);
    expect(data.items.every((i) => i.rootId === dirItem)).toBe(true);
  });

  it('sub 指向根内子目录 → 返回其后代', async () => {
    const res = await request(ctx, `/api/shares/${shareId}/list?root=${dirItem}&sub=${encodeURIComponent('/sub')}`);
    expect(res.status).toBe(200);
    const data = (await json(res)).data as { path: string; items: Array<{ id: string; rootId: string }> };
    expect(data.path).toBe('/sub');
    expect(data.items.map((i) => i.id)).toEqual([deepFile]);
    expect(data.items[0].rootId).toBe(dirItem);
  });

  it('sub 用 .. 逃逸根子树 → 403', async () => {
    for (const escape of ['/../other', '/..', '/sub/../..']) {
      const res = await request(ctx, `/api/shares/${shareId}/list?root=${dirItem}&sub=${encodeURIComponent(escape)}`);
      expect(res.status).toBe(403);
    }
  });

  it('sub 指向根子树内不存在的目录 → 404', async () => {
    const res = await request(ctx, `/api/shares/${shareId}/list?root=${dirItem}&sub=${encodeURIComponent('/nope')}`);
    expect(res.status).toBe(404);
  });

  it('root 不是该分享的项目 → 403；root 是文件项目 → 400', async () => {
    const outside = await request(ctx, `/api/shares/${shareId}/list?root=${outsideFile}`);
    expect(outside.status).toBe(403);
    const fileRoot = await request(ctx, `/api/shares/${shareId}/list?root=${fileA}`);
    expect(fileRoot.status).toBe(400);
  });
});

describe('下载令牌作用域', () => {
  let shareId = '';

  beforeAll(async () => {
    shareId = await createShareId([fileA, dirItem]);
  });

  function tokenPayload(token: string): { fileId: string; objectKey: string; name: string } {
    const row = ctx.db.prepare('SELECT payload FROM download_tokens WHERE token = ?').get(token) as { payload: string };
    return JSON.parse(row.payload) as { fileId: string; objectKey: string; name: string };
  }

  function tokenOf(url: string): string {
    return new URL(url).pathname.split('/').pop() as string;
  }

  it('itemId = 分享项目 → 200，令牌指向该文件的物理对象键与展示名', async () => {
    const res = await request(ctx, `/api/shares/${shareId}/download?itemId=${fileA}`);
    expect(res.status).toBe(200);
    const data = (await json(res)).data as { url: string; expiresIn: number };
    expect(data.expiresIn).toBe(900);

    const file = ctx.db
      .prepare('SELECT name, object_key, physical_key FROM file_metadata WHERE id = ?')
      .get(fileA) as { name: string; object_key: string; physical_key: string | null };
    const payload = tokenPayload(tokenOf(data.url));
    expect(payload.fileId).toBe(fileA);
    expect(payload.objectKey).toBe(file.physical_key ?? file.object_key);
    expect(payload.name).toBe(file.name);
  });

  it('itemId 缺省 = 第一个项目', async () => {
    const res = await request(ctx, `/api/shares/${shareId}/download`);
    expect(res.status).toBe(200);
    const data = (await json(res)).data as { url: string };
    expect(tokenPayload(tokenOf(data.url)).fileId).toBe(fileA);
  });

  it('itemId 为文件夹项目的后代（根子树内）→ 200', async () => {
    const res = await request(ctx, `/api/shares/${shareId}/download?itemId=${deepFile}`);
    expect(res.status).toBe(200);
    const data = (await json(res)).data as { url: string };
    expect(tokenPayload(tokenOf(data.url)).fileId).toBe(deepFile);
  });

  it('树外文件 id → 404；未知 id → 404；文件夹项目 → 400', async () => {
    const outside = await request(ctx, `/api/shares/${shareId}/download?itemId=${outsideFile}`);
    expect(outside.status).toBe(404);
    const unknown = await request(ctx, `/api/shares/${shareId}/download?itemId=nope`);
    expect(unknown.status).toBe(404);
    const folder = await request(ctx, `/api/shares/${shareId}/download?itemId=${dirItem}`);
    expect(folder.status).toBe(400);
  });

  it('预览同样按项目作用域：项目后代 200、树外 404', async () => {
    const inside = await request(ctx, `/api/shares/${shareId}/preview?itemId=${innerFile}`);
    expect(inside.status).toBe(200);
    expect(inside.headers.get('Content-Disposition')).toContain('inner.txt');
    const outside = await request(ctx, `/api/shares/${shareId}/preview?itemId=${outsideFile}`);
    expect(outside.status).toBe(404);
  });
});

describe('访问闸门', () => {
  it('撤销后详情 → 410 SHARE_REVOKED', async () => {
    const shareId = await createShareId([fileA]);
    const revoke = await request(ctx, `/api/shares/${shareId}`, {
      method: 'DELETE',
      cookie: ownerCookie,
      headers: { 'X-CSRF-Token': ownerCsrf },
    });
    expect(revoke.status).toBe(200);

    const res = await request(ctx, `/api/shares/${shareId}`);
    expect(res.status).toBe(410);
    expect(((await json(res)).error as { code: string }).code).toBe('SHARE_REVOKED');
  });

  it('过期后详情 → 410 SHARE_EXPIRED 且落 status=expired', async () => {
    const shareId = await createShareId([fileA], { expiresAt: Date.now() - 1000 });
    const res = await request(ctx, `/api/shares/${shareId}`);
    expect(res.status).toBe(410);
    expect(((await json(res)).error as { code: string }).code).toBe('SHARE_EXPIRED');
    const row = ctx.db.prepare('SELECT status FROM shares WHERE id = ?').get(shareId) as { status: string };
    expect(row.status).toBe('expired');

    // 目录浏览闸门一致
    const list = await request(ctx, `/api/shares/${shareId}/list?root=${dirItem}`);
    expect(list.status).toBe(410);
  });

  it('requireLogin 未登录：详情 401、目录浏览 401、下载 401', async () => {
    const shareId = await createShareId([fileA, dirItem], { requireLogin: true });

    const detail = await request(ctx, `/api/shares/${shareId}`);
    expect(detail.status).toBe(401);
    expect(((await json(detail)).error as { code: string }).code).toBe('LOGIN_REQUIRED');

    const list = await request(ctx, `/api/shares/${shareId}/list?root=${dirItem}`);
    expect(list.status).toBe(401);

    const download = await request(ctx, `/api/shares/${shareId}/download?itemId=${fileA}`);
    expect(download.status).toBe(401);

    // 登录后放行
    const asOwner = await request(ctx, `/api/shares/${shareId}/list?root=${dirItem}`, { cookie: ownerCookie });
    expect(asOwner.status).toBe(200);
  });

  it('密码未验证：详情遮蔽项目，目录浏览 401', async () => {
    const shareId = await createShareId([fileA, dirItem], { password: 'sharepass' });

    const detail = await request(ctx, `/api/shares/${shareId}`);
    expect(detail.status).toBe(200);
    const share = ((await json(detail)).data as { share: ShareDetail }).share;
    expect(share.requiresPassword).toBe(true);
    expect(share.items).toEqual([]);
    expect(share.allowPreview).toBe(false);
    expect(share.allowDownload).toBe(false);

    const list = await request(ctx, `/api/shares/${shareId}/list?root=${dirItem}`);
    expect(list.status).toBe(401);

    // 密码通过后可见
    const ok = await request(ctx, `/api/shares/${shareId}/download?itemId=${fileA}&password=sharepass`);
    expect(ok.status).toBe(200);
  });
});

describe('我的分享列表', () => {
  it('聚合 itemCount / totalSize / firstItem，且不含旧 file 字段', async () => {
    const res = await createShare({ fileIds: [fileA, fileB, dirItem] });
    const shareId = ((await json(res)).data as { share: { id: string } }).share.id;

    const listRes = await request(ctx, '/api/shares?limit=100', { cookie: ownerCookie });
    expect(listRes.status).toBe(200);
    const items = ((await json(listRes)).data as {
      items: Array<{
        id: string;
        itemCount: number;
        totalSize: number;
        firstItem: { id: string; name: string } | null;
        passwordProtected: boolean;
        requireLogin: boolean;
        allowedUserCount: number;
        file?: unknown;
      }>;
    }).items;
    const mine = items.find((i) => i.id === shareId);
    expect(mine).toBeTruthy();

    // 展示名取 file_metadata.name，大小之和 = 3 + 4 + 0（文件夹）
    expect(mine!.itemCount).toBe(3);
    expect(mine!.totalSize).toBe(7);
    expect(mine!.firstItem?.id).toBe(fileA);
    expect(mine!.firstItem?.name).toBe('a.txt');
    expect(mine!.file).toBeUndefined();
    // 未限制的分享：无密码、不限登录、无指定用户
    expect(mine!.passwordProtected).toBe(false);
    expect(mine!.requireLogin).toBe(false);
    expect(mine!.allowedUserCount).toBe(0);
  });

  it('列表逐项带出访问设置：密码 / 仅登录 / 指定用户数量', async () => {
    const res = await createShare({
      fileIds: [fileB],
      password: 'listpass',
      requireLogin: true,
      allowedUsers: ['mi_admin'],
    });
    const shareId = ((await json(res)).data as { share: { id: string } }).share.id;

    const listRes = await request(ctx, '/api/shares?limit=100', { cookie: ownerCookie });
    const items = ((await json(listRes)).data as {
      items: Array<{ id: string; passwordProtected: boolean; requireLogin: boolean; allowedUserCount: number }>;
    }).items;
    const mine = items.find((i) => i.id === shareId);
    expect(mine?.passwordProtected).toBe(true);
    expect(mine?.requireLogin).toBe(true);
    expect(mine?.allowedUserCount).toBe(1);
  });
});

describe('管理员分享列表', () => {
  it('每行带出权限设置与项目数', async () => {
    const res = await createShare({ fileIds: [fileA, dirItem], password: 'adminpass', allowedUsers: ['mi_admin'] });
    const shareId = ((await json(res)).data as { share: { id: string } }).share.id;

    const adminRes = await request(ctx, '/api/admin/shares?limit=100', { cookie: adminCookie });
    expect(adminRes.status).toBe(200);
    const items = ((await json(adminRes)).data as {
      items: Array<{
        id: string;
        file: { id: string; name: string } | null;
        itemCount: number;
        passwordProtected: boolean;
        requireLogin: boolean;
        allowedUserCount: number;
      }>;
    }).items;
    const row = items.find((i) => i.id === shareId);
    expect(row).toBeTruthy();
    expect(row!.itemCount).toBe(2);
    expect(row!.passwordProtected).toBe(true);
    expect(row!.requireLogin).toBe(false);
    expect(row!.allowedUserCount).toBe(1);
    // 既有 file 字段（首项目）语义不变
    expect(row!.file?.id).toBe(fileA);
    expect(row!.file?.name).toBe('a.txt');
  });
});

describe('项目文件删除', () => {
  it('删除非首项目 → 分享保留剩余项目；删除首项目 → 分享随之消失', async () => {
    const delFirst = await uploadFile(ownerCookie, ownerCsrf, MOUNT, 'del-first.txt', 'del-first');
    const delSecond = await uploadFile(ownerCookie, ownerCsrf, MOUNT, 'del-second.txt', 'del-second');
    const shareId = await createShareId([delFirst, delSecond]);

    const del = (id: string) =>
      request(ctx, `/api/files/${id}`, { method: 'DELETE', cookie: ownerCookie, headers: { 'X-CSRF-Token': ownerCsrf } });

    expect((await del(delSecond)).status).toBe(200);
    const afterSecond = (await json(await request(ctx, `/api/shares/${shareId}`))).data as { share: ShareDetail };
    expect(afterSecond.share.items.map((i) => i.id)).toEqual([delFirst]);

    expect((await del(delFirst)).status).toBe(200);
    expect((await request(ctx, `/api/shares/${shareId}`)).status).toBe(404);
  });
});
