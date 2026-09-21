// 违规封禁（§26）：封禁开关端点、内容出口门禁（公开直链 / 文件下载 / 下载网关 / 分享下载 / 分享预览）、
// 解封恢复、用户端列表 banned/hash 字段、管理端全部文件筛选（bucket/mount/hash/user/visibility/banned）与每行富化
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let ownerCookie = '';
let ownerCsrf = '';
let adminCookie = '';
let adminCsrf = '';

let fileA = ''; // 对照组（不封禁）
let fileB = ''; // 封禁对象
let shareId = '';
let providerId = '';
let providerName = '';
let mountId = '';
let mountName = '';
let ownerId = '';
let blobHashB = '';
/** 未封禁时预签发的网关令牌：验证封禁在令牌消费阶段依然拦截 */
let savedGatewayToken = '';

interface Envelope<T> {
  data: T;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface AdminFileItem {
  id: string;
  name: string;
  banned?: boolean;
  hash?: string | null;
  buckets?: string[];
  mounts?: string[];
}
interface AdminFileList {
  items: AdminFileItem[];
  pagination: { total: number; page: number; limit: number; pages: number };
}

async function uploadFile(dir: string, fileName: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie: ownerCookie,
    headers: { 'X-CSRF-Token': ownerCsrf },
    body: { path: dir, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  const sessionId = ((await json(initRes)).data as { sessionId: string }).sessionId;
  await request(ctx, `/api/files/upload/raw/${sessionId}`, {
    method: 'PUT',
    cookie: ownerCookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': ownerCsrf },
    body: content,
  });
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie: ownerCookie,
    headers: { 'X-CSRF-Token': ownerCsrf },
    body: { sessionId, etag: 'etag' },
  });
  return ((await json(completeRes)).data as { file: { id: string } }).file.id;
}

function banFile(id: string, banned: boolean): Promise<Response> {
  return request(ctx, `/api/admin/files/${id}/ban`, {
    method: 'PUT',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { banned },
  });
}

async function adminItems(query: string): Promise<AdminFileItem[]> {
  const res = await request(ctx, `/api/admin/files${query}`, { cookie: adminCookie });
  expect(res.status).toBe(200);
  return ((await json(res)).data as AdminFileList).items;
}

async function adminTotal(query: string): Promise<number> {
  const res = await request(ctx, `/api/admin/files${query}`, { cookie: adminCookie });
  expect(res.status).toBe(200);
  return ((await json(res)).data as AdminFileList).pagination.total;
}

async function expectFileBanned(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  expect(((await json(res)) as unknown as ErrorBody).error.code).toBe('FILE_BANNED');
}

async function issueGatewayToken(): Promise<string> {
  const res = await request(ctx, `/api/files/${fileB}/download`, { cookie: ownerCookie });
  expect(res.status).toBe(200);
  const url = ((await json(res)).data as { url: string }).url;
  const token = url.split('/').pop() ?? '';
  expect(token).toBeTruthy();
  return token;
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);

  // 管理员
  await registerAndLogin(ctx, 'ban_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'ban_admin'`);
  const adminLogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'ban_admin', password: 'password123' },
  });
  adminCookie = `auth_token=${(adminLogin.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);

  // 属主
  const { authCookie } = await registerAndLogin(ctx, 'ban_owner');
  ownerCookie = authCookie;
  ownerCsrf = await getCsrf(ctx, ownerCookie);

  fileA = await uploadFile('/', 'a.txt', 'aaa');
  fileB = await uploadFile('/', 'b.txt', 'bbbb');

  // 夹具元数据：落桶 provider、内容哈希、挂载点、属主
  const rowB = ctx.db
    .prepare('SELECT provider_id, blob_hash, owner_id FROM file_metadata WHERE id = ?')
    .get(fileB) as { provider_id: string; blob_hash: string; owner_id: string };
  providerId = rowB.provider_id;
  blobHashB = rowB.blob_hash;
  ownerId = rowB.owner_id;
  expect(blobHashB).toBeTruthy();
  const prov = ctx.db.prepare('SELECT name FROM storage_providers WHERE id = ?').get(providerId) as { name: string };
  providerName = prov.name;
  const mountRow = ctx.db
    .prepare('SELECT m.id, m.name FROM mounts m JOIN file_metadata f ON f.mount_id = m.id WHERE f.id = ?')
    .get(fileB) as { id: string; name: string };
  mountId = mountRow.id;
  mountName = mountRow.name;

  // 单项目分享（fileB）：验证分享下载/预览出口
  const shareRes = await request(ctx, '/api/shares', {
    method: 'POST',
    cookie: ownerCookie,
    headers: { 'X-CSRF-Token': ownerCsrf },
    body: { fileIds: [fileB], title: 'ban-share', allowPreview: true, allowDownload: true },
  });
  expect(shareRes.status).toBe(201);
  shareId = ((await json(shareRes)).data as { share: { id: string } }).share.id;
});

describe('未封禁基线（内容出口可用）', () => {
  it('公开直链流式返回文件内容', async () => {
    const res = await request(ctx, '/b.txt', { cookie: ownerCookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('bbbb');
  });

  it('文件下载签发网关链接且网关可读；第二个令牌留存给封禁后用例', async () => {
    const token1 = await issueGatewayToken();
    const gw = await request(ctx, `/api/gateway/download/${token1}`, { cookie: ownerCookie });
    expect(gw.status).toBe(200);
    expect(await gw.text()).toBe('bbbb');
    savedGatewayToken = await issueGatewayToken();
  });

  it('分享下载签发链接、分享预览直出内容', async () => {
    const dl = await request(ctx, `/api/shares/${shareId}/download`);
    expect(dl.status).toBe(200);
    expect(((await json(dl)).data as { url: string }).url).toBeTruthy();
    const pv = await request(ctx, `/api/shares/${shareId}/preview`);
    expect(pv.status).toBe(200);
    expect(await pv.text()).toBe('bbbb');
  });
});

describe('封禁开关端点', () => {
  it('封禁落库并返回 ok({ id, banned })', async () => {
    const res = await banFile(fileB, true);
    expect(res.status).toBe(200);
    expect(((await json(res)).data as { id: string; banned: boolean })).toEqual({ id: fileB, banned: true });
    const row = ctx.db.prepare('SELECT banned FROM file_metadata WHERE id = ?').get(fileB) as { banned: number };
    expect(Number(row.banned)).toBe(1);
  });

  it('文件不存在 → 404', async () => {
    const res = await banFile('no-such-file', true);
    expect(res.status).toBe(404);
    expect(((await json(res)) as unknown as ErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('body 缺少 banned 或类型非法 → 400', async () => {
    for (const body of [{ banned: 'yes' }, {}]) {
      const res = await request(ctx, `/api/admin/files/${fileA}/ban`, {
        method: 'PUT',
        cookie: adminCookie,
        headers: { 'X-CSRF-Token': adminCsrf },
        body,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('内容出口门禁（已封禁）', () => {
  it('公开直链 → 429 FILE_BANNED', async () => {
    await expectFileBanned(await request(ctx, '/b.txt', { cookie: ownerCookie }));
  });

  it('文件下载 → 429 FILE_BANNED', async () => {
    await expectFileBanned(await request(ctx, `/api/files/${fileB}/download`, { cookie: ownerCookie }));
  });

  it('下载网关（封禁前签发的令牌）→ 429 FILE_BANNED', async () => {
    await expectFileBanned(await request(ctx, `/api/gateway/download/${savedGatewayToken}`, { cookie: ownerCookie }));
  });

  it('分享下载 → 429 FILE_BANNED', async () => {
    await expectFileBanned(await request(ctx, `/api/shares/${shareId}/download`));
  });

  it('分享预览 → 429 FILE_BANNED', async () => {
    await expectFileBanned(await request(ctx, `/api/shares/${shareId}/preview`));
  });

  it('用户端列表输出 banned=true 供半透明禁用态', async () => {
    const res = await request(ctx, '/api/files?path=/', { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const items = ((await json(res)).data as { items: AdminFileItem[] }).items;
    const b = items.find((i) => i.name === 'b.txt');
    expect(b?.id).toBe(fileB);
    expect(b?.banned).toBe(true);
    expect(b?.hash).toBe(blobHashB);
  });
});

describe('管理端全部文件：筛选与每行富化', () => {
  it('banned=true 只命中封禁行，行内 banned/hash/buckets/mounts 富化齐全', async () => {
    const items = await adminItems('?banned=true');
    expect(items.map((i) => i.id)).toEqual([fileB]);
    expect(items[0].banned).toBe(true);
    expect(items[0].hash).toBe(blobHashB);
    expect(items[0].buckets).toContain(providerName);
    expect(items[0].mounts).toEqual([mountName]);
  });

  it('banned=false 排除封禁行', async () => {
    const ids = (await adminItems('?banned=false')).map((i) => i.id);
    expect(ids).toContain(fileA);
    expect(ids).not.toContain(fileB);
  });

  it('bucket 精确命中落桶；未知桶为空', async () => {
    const ids = (await adminItems(`?bucket=${providerId}`)).map((i) => i.id);
    expect(ids).toContain(fileA);
    expect(ids).toContain(fileB);
    expect(await adminTotal('?bucket=no-such-provider')).toBe(0);
  });

  it('hash 子串命中内容寻址行；无匹配哈希为空', async () => {
    expect((await adminItems(`?hash=${blobHashB.slice(0, 12)}`)).map((i) => i.id)).toEqual([fileB]);
    expect(await adminTotal('?hash=zzzzzzzz')).toBe(0);
  });

  it('user 精确命中属主文件', async () => {
    const ids = (await adminItems(`?user=${ownerId}`)).map((i) => i.id);
    expect(new Set(ids)).toEqual(new Set([fileA, fileB]));
  });

  it('mount 精确命中挂载点内文件', async () => {
    const ids = (await adminItems(`?mount=${mountId}`)).map((i) => i.id);
    expect(ids).toContain(fileA);
    expect(ids).toContain(fileB);
  });

  it('visibility 筛选命中', async () => {
    const patch = await request(ctx, `/api/admin/files/${fileA}/review`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { visibility: 'public' },
    });
    expect(patch.status).toBe(200);
    expect((await adminItems('?visibility=public')).map((i) => i.id)).toEqual([fileA]);
    const privateIds = (await adminItems('?visibility=private')).map((i) => i.id);
    expect(privateIds).toContain(fileB);
    expect(privateIds).not.toContain(fileA);
  });

  it('与既有 search 共存', async () => {
    expect((await adminItems('?search=b.txt')).map((i) => i.id)).toEqual([fileB]);
  });
});

describe('解封恢复', () => {
  it('解封后四个内容出口全部恢复', async () => {
    const res = await banFile(fileB, false);
    expect(res.status).toBe(200);
    expect(((await json(res)).data as { id: string; banned: boolean })).toEqual({ id: fileB, banned: false });
    const row = ctx.db.prepare('SELECT banned FROM file_metadata WHERE id = ?').get(fileB) as { banned: number };
    expect(Number(row.banned)).toBe(0);

    const direct = await request(ctx, '/b.txt', { cookie: ownerCookie });
    expect(direct.status).toBe(200);
    expect(await direct.text()).toBe('bbbb');

    expect((await request(ctx, `/api/files/${fileB}/download`, { cookie: ownerCookie })).status).toBe(200);
    expect((await request(ctx, `/api/shares/${shareId}/download`)).status).toBe(200);

    const pv = await request(ctx, `/api/shares/${shareId}/preview`);
    expect(pv.status).toBe(200);
    expect(await pv.text()).toBe('bbbb');
  });

  it('用户端列表 banned 归位 false', async () => {
    const res = await request(ctx, '/api/files?path=/', { cookie: ownerCookie });
    const items = ((await json(res)).data as { items: AdminFileItem[] }).items;
    const b = items.find((i) => i.name === 'b.txt');
    expect(b?.banned).toBe(false);
    expect(items.find((i) => i.name === 'a.txt')?.banned).toBe(false);
  });
});
