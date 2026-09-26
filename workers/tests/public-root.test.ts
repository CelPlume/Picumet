// 合成根（非文件页入口：公开浏览 / AList list / WebDAV PROPFIND）与公开列表的封禁过滤。
// 基线为「无 `/` 根挂载、仅 /storage1 /storage2 /storage3 三个顶层挂载」的无根拓扑。
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule,
  type TestContext,
} from './helpers';
import { Db, MountRepo, ProviderRepo, MountRolePermissionsRepo } from '../src/db';

let ctx: TestContext;
let db: Db;
let adminCookie = '';
let adminCsrf = '';

function basicAuth(keyId: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
}

async function registerAdmin(username: string): Promise<string> {
  await registerAndLogin(ctx, username);
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = '${username}'`);
  const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username, password: 'password123' } });
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  return `auth_token=${token?.[1] ?? ''}`;
}

interface UploadSessionBody {
  data: { sessionId: string };
}
interface UploadCompleteBody {
  data: { file: { id: string } };
}

async function uploadFile(cookie: string, dir: string, fileName: string, content: string): Promise<string> {
  const csrf = await getCsrf(ctx, cookie);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: dir, fileName, fileSize: content.length, mimeType: 'text/plain' },
  });
  const initData = await json<UploadSessionBody>(initRes);
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
  const complete = await json<UploadCompleteBody>(completeRes);
  return complete.data.file.id;
}

interface CreatedKeyBody {
  data: { key: { keyId: string; secret: string } };
}

async function createApiKey(username: string, name: string, protocols: string[], permissions: string[]): Promise<{ keyId: string; secret: string }> {
  const { authCookie } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name, permissions, protocols, uploadPath: '/' },
  });
  expect(res.status).toBe(201);
  const created = await json<CreatedKeyBody>(res);
  await grantApiKeyRule(ctx, created.data.key.keyId, permissions, '/');
  return created.data.key;
}

interface PublicFsBody {
  data: {
    path: string;
    mountPath: string | null;
    items: Array<{ name: string; type: string; path: string; size: number; hasPassword: boolean; url: string | null }>;
  };
}

interface GalleryBody {
  data: { items: Array<{ name: string }>; pagination: { total: number } };
}

interface AlistListBody {
  code: number;
  data: { content: Array<{ name: string; is_dir: boolean }> };
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromSqlite(ctx.db);
  // 无根拓扑：删根挂载（file_metadata / mount_providers 级联清理），仅保留 /storage1..3
  const root = (await MountRepo.listMounts(db)).find((m) => m.mountPath === '/');
  expect(root).toBeTruthy();
  await db.run('DELETE FROM mounts WHERE id = ?', [root!.id]);
  const providerId = (await ProviderRepo.listProviders(db))[0].id;
  for (const name of ['storage1', 'storage2', 'storage3']) {
    await MountRepo.createMount(db, { providerId, mountPath: `/${name}`, name });
  }
  adminCookie = await registerAdmin('proot_admin');
  adminCsrf = await getCsrf(ctx, adminCookie);
});

describe('合成根（非文件页入口）', () => {
  it('公开浏览 /：聚合三个虚拟目录；未挂载且非虚拟祖先仍 404；逐挂载 read 门禁生效', async () => {
    const u = await registerAndLogin(ctx, 'proot_user');
    const res = await request(ctx, '/api/public/fs?path=%2F', { cookie: u.authCookie });
    expect(res.status).toBe(200);
    const body = await json<PublicFsBody>(res);
    expect(body.data.path).toBe('/');
    expect(body.data.mountPath).toBeNull();
    expect(body.data.items.map((i) => i.name).sort()).toEqual(['storage1', 'storage2', 'storage3']);
    expect(body.data.items.every((i) => i.type === 'folder' && i.path === `/${i.name}` && i.url === null)).toBe(true);

    // 非挂载祖先：维持既有 404
    const nf = await request(ctx, '/api/public/fs?path=%2Fnope', { cookie: u.authCookie });
    expect(nf.status).toBe(404);

    // §28 挂载级矩阵：/storage2 对 user deny read → 虚拟项隐藏
    const s2 = (await MountRepo.listMounts(db)).find((m) => m.mountPath === '/storage2')!;
    await MountRolePermissionsRepo.setForMount(db, s2.id, [{ role: 'user', permissions: ['write', 'download'] }]);
    try {
      const gated = await request(ctx, '/api/public/fs?path=%2F', { cookie: u.authCookie });
      expect(gated.status).toBe(200);
      const gatedItems = await json<PublicFsBody>(gated);
      expect(gatedItems.data.items.map((i) => i.name).sort()).toEqual(['storage1', 'storage3']);
    } finally {
      await MountRolePermissionsRepo.setForMount(db, s2.id, []);
    }
  });

  it('匿名公开浏览 /：仅显示 guest 规则覆盖的挂载点', async () => {
    const settings = await request(ctx, '/api/admin/settings', {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { allowGuestAccess: true },
    });
    expect(settings.status).toBe(200);
    const rule = await request(ctx, '/api/admin/rules', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { pathPattern: '/storage1', effect: 'allow', role: 'guest', permissions: ['read', 'download'] },
    });
    expect(rule.status).toBe(201);
    try {
      const res = await request(ctx, '/api/public/fs?path=%2F');
      expect(res.status).toBe(200);
      const body = await json<PublicFsBody>(res);
      expect(body.data.items.map((i) => i.name)).toEqual(['storage1']);
    } finally {
      ctx.db.exec("DELETE FROM path_rules WHERE role = 'guest' AND path_pattern = '/storage1'");
      await request(ctx, '/api/admin/settings', {
        method: 'PATCH',
        cookie: adminCookie,
        headers: { 'X-CSRF-Token': adminCsrf },
        body: { allowGuestAccess: false },
      });
    }
  });

  it('AList fs/list /：返回三个虚拟目录项', async () => {
    const key = await createApiKey('proot_alist', 'proot-alist', ['api'], ['read']);
    const res = await request(ctx, '/openlist/api/fs/list', {
      method: 'POST',
      headers: { Authorization: `${key.keyId}.${key.secret}` },
      body: { path: '/' },
    });
    expect(res.status).toBe(200);
    const body = await json<AlistListBody>(res);
    expect(body.code).toBe(200);
    expect(body.data.content.map((e) => e.name).sort()).toEqual(['storage1', 'storage2', 'storage3']);
    expect(body.data.content.every((e) => e.is_dir)).toBe(true);
  });

  it('WebDAV PROPFIND /：返回 collection 骨架（自项 + 虚拟目录）', async () => {
    const key = await createApiKey('proot_webdav', 'proot-webdav', ['webdav'], ['read']);
    const res = await request(ctx, '/webdav/', {
      method: 'PROPFIND',
      headers: { Authorization: basicAuth(key.keyId, key.secret), Depth: '1' },
    });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain('<d:collection/>');
    for (const name of ['storage1', 'storage2', 'storage3']) {
      expect(xml).toContain(`/webdav/${name}`);
    }
  });
});

describe('公开列表过滤封禁项', () => {
  it('gallery 与公开目录列表都不返回封禁行', async () => {
    const owner = await registerAndLogin(ctx, 'proot_banned');
    await uploadFile(owner.authCookie, '/storage1', 'gallery-open.png', 'open');
    const bannedId = await uploadFile(owner.authCookie, '/storage1', 'gallery-banned.png', 'banned');
    ctx.db.exec(
      "UPDATE file_metadata SET visibility = 'public', review_status = 'approved' WHERE name IN ('gallery-open.png','gallery-banned.png')"
    );
    ctx.db.exec(`UPDATE file_metadata SET banned = 1 WHERE id = '${bannedId}'`);

    // gallery：匿名列表只含未封禁的公开文件
    const gallery = await request(ctx, '/api/gallery?page=1&limit=50');
    expect(gallery.status).toBe(200);
    const galleryBody = await json<GalleryBody>(gallery);
    const names = galleryBody.data.items.map((i) => i.name);
    expect(names).toContain('gallery-open.png');
    expect(names).not.toContain('gallery-banned.png');
    expect(galleryBody.data.pagination.total).toBe(names.length);

    // public/fs：目录列表同样不展示封禁项
    const listed = await request(ctx, '/api/public/fs?path=%2Fstorage1', { cookie: owner.authCookie });
    expect(listed.status).toBe(200);
    const listedBody = await json<PublicFsBody>(listed);
    const listedNames = listedBody.data.items.map((i) => i.name);
    expect(listedNames).toContain('gallery-open.png');
    expect(listedNames).not.toContain('gallery-banned.png');
  });
});
