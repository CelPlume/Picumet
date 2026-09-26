// MOVE 全上下文鉴权：源 delete + 目标 write 各自携带挂载点级 §28 与桶级 §31 矩阵与落桶
// MOVE 子项前缀改写先 ESCAPE（文件夹名含 % 不误伤兄弟子树）+ 文件夹行 path=自身全路径
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext,
  initSeeded,
  request,
  json,
  registerAndLogin,
  getCsrf,
  grantApiKeyRule,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';
/** 目标挂载 /mvz：挂载点级 user 角色无 write（封闭集合） */
let targetMountId = '';
/** 源挂载 /msrc：桶级 user 角色无 delete */
let sourceMountId = '';
let sourceProviderId = '';

function basicAuth(keyId: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
}

async function createProvider(name: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name, bucket: 'mp-bucket' },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { provider: { id: string } } }>(res)).data.provider.id;
}

async function createMount(body: Record<string, unknown>): Promise<string> {
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { priority: 900, ...body },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { mount: { id: string } } }>(res)).data.mount.id;
}

function patchMount(mountId: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/admin/mounts/${mountId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

async function mkFolder(cookie: string, csrf: string, path: string, name: string): Promise<string> {
  const res = await request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, name },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { file: { id: string } } }>(res)).data.file.id;
}

async function uploadFile(
  cookie: string,
  csrf: string,
  dir: string,
  fileName: string,
  content: string
): Promise<{ fileId: string; providerId: string | null }> {
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: dir, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  expect(initRes.status).toBe(200);
  const init = await json<{ data: { sessionId: string } }>(initRes);
  await request(ctx, `/api/files/upload/raw/${init.data.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: init.data.sessionId, etag: 'etag' },
  });
  const fileId = (await json<{ data: { file: { id: string } } }>(completeRes)).data.file.id;
  const row = ctx.db.prepare('SELECT provider_id FROM file_metadata WHERE id = ?').get(fileId) as {
    provider_id: string | null;
  };
  return { fileId, providerId: row.provider_id };
}

function fileRow(id: string): { path: string; mount_id: string; name: string } {
  const row = ctx.db.prepare('SELECT path, mount_id, name FROM file_metadata WHERE id = ?').get(id) as
    | { path: string; mount_id: string; name: string }
    | undefined;
  expect(row).toBeTruthy();
  return row as { path: string; mount_id: string; name: string };
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'mp_admin');
  ctx.db.exec("UPDATE users SET role = 'admin' WHERE username = 'mp_admin'");
  const res = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'mp_admin', password: 'password123' },
  });
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${token?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);

  // 目标挂载：/mvz —— 挂载点级矩阵给 user 只留 read/download（无 write）
  const targetProvider = await createProvider('mp-target');
  targetMountId = await createMount({ providerId: targetProvider, mountPath: '/mvz', name: '移动目标' });
  const patchTarget = await patchMount(targetMountId, {
    rolePermissions: [{ role: 'user', permissions: ['read', 'download'] }],
  });
  expect(patchTarget.status).toBe(200);

  // 源挂载：/msrc —— 桶级矩阵给 user 只留 read/write（无 delete）
  sourceProviderId = await createProvider('mp-src');
  sourceMountId = await createMount({ providerId: sourceProviderId, mountPath: '/msrc', name: '移动源' });
  const patchSrc = await patchMount(sourceMountId, {
    poolMembers: [{ providerId: sourceProviderId, rolePermissions: [{ role: 'user', permissions: ['read', 'write'] }] }],
  });
  expect(patchSrc.status).toBe(200);
});

describe('目标挂载点级矩阵 deny write 拦截 MOVE', () => {
  it('UI 移动：移入 deny write 的挂载 → 403，源文件原位未动', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'mp_ui');
    const csrf = await getCsrf(ctx, authCookie);
    const { fileId } = await uploadFile(authCookie, csrf, '/', 'ui-move.txt', 'ui');

    const res = await request(ctx, `/api/files/${fileId}/move`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/mvz' },
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('FORBIDDEN');

    const row = fileRow(fileId);
    expect(row.path).toBe('/');
    expect(row.mount_id).not.toBe(targetMountId);
    expect(row.name).toBe('ui-move.txt');
  });

  it('WebDAV MOVE：同一 Saga，目标挂载 deny write → 403（源对象仍在）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'mp_dav');
    const csrf = await getCsrf(ctx, authCookie);
    const keyRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'mp-dav', permissions: ['write', 'delete', 'read'], protocols: ['webdav'], uploadPath: '/' },
    });
    expect(keyRes.status).toBe(201);
    const key = (await json<{ data: { key: { keyId: string; secret: string } } }>(keyRes)).data.key;
    // 规则只覆盖源文件全路径：PUT 与源 delete 命中规则，目标 /mvz/... 不命中 → 由目标挂载矩阵裁决
    await grantApiKeyRule(ctx, key.keyId, ['write', 'delete', 'read'], '/dav-move.txt');
    const auth = { Authorization: basicAuth(key.keyId, key.secret) };

    const put = await request(ctx, '/webdav/dav-move.txt', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: 'dav',
    });
    expect(put.status).toBe(201);

    const move = await request(ctx, '/webdav/dav-move.txt', {
      method: 'MOVE',
      headers: { ...auth, Destination: 'http://localhost:8787/webdav/mvz/dav-move.txt' },
    });
    expect(move.status).toBe(403);

    const stillThere = await request(ctx, '/webdav/dav-move.txt', { headers: auth });
    expect(stillThere.status).toBe(200);
  });
});

describe('源桶桶级矩阵 deny delete 拦截 MOVE', () => {
  it('非属主把 /msrc 内文件移出 → 403（桶级条目无 delete）', async () => {
    // 管理员在源挂载落文件（属主 = 管理员，移动者非属主 → 属主回退不介入，桶级矩阵生效）
    const { fileId, providerId } = await uploadFile(adminCookie, adminCsrf, '/msrc', 'bucket-src.txt', 'src');
    expect(providerId).toBe(sourceProviderId);

    const { authCookie } = await registerAndLogin(ctx, 'mp_bucket');
    const csrf = await getCsrf(ctx, authCookie);
    const res = await request(ctx, `/api/files/${fileId}/move`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/' },
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('FORBIDDEN');

    // 源行仍在源挂载、路径未变
    const row = fileRow(fileId);
    expect(row.path).toBe('/msrc');
    expect(row.mount_id).toBe(sourceMountId);
  });
});

describe('正常移动与子项前缀 ESCAPE', () => {
  it('同挂载点文件移动成功并到位', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'mp_norm');
    const csrf = await getCsrf(ctx, authCookie);
    await mkFolder(authCookie, csrf, '/', 'normsrc');
    await mkFolder(authCookie, csrf, '/', 'normdst');
    const { fileId } = await uploadFile(authCookie, csrf, '/normsrc', 'n.txt', 'n');

    const res = await request(ctx, `/api/files/${fileId}/move`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/normdst' },
    });
    expect(res.status).toBe(200);
    const jobId = (await json<{ data: { jobId: string } }>(res)).data.jobId;
    const jobRes = await request(ctx, `/api/files/jobs/${jobId}`, { cookie: authCookie });
    expect((await json<{ data: { job: { status: string } } }>(jobRes)).data.job.status).toBe('completed');

    const row = fileRow(fileId);
    expect(row.path).toBe('/normdst');
    expect(row.name).toBe('n.txt');
  });

  it('文件夹名含 % 时移动：兄弟子树不被误伤，直接/深层子项 path 均正确改写', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'mp_pct');
    const csrf = await getCsrf(ctx, authCookie);
    await mkFolder(authCookie, csrf, '/', 'dest');
    const pctFolderId = await mkFolder(authCookie, csrf, '/', '100%');
    await mkFolder(authCookie, csrf, '/100%', 'sub');
    await uploadFile(authCookie, csrf, '/100%', 'inside.txt', 'in');
    // 兄弟目录：未转义时 '/100%/%' 会匹配 '/100x/sub' 并把其前缀改写进被移动文件夹
    await mkFolder(authCookie, csrf, '/', '100x');
    await mkFolder(authCookie, csrf, '/100x', 'sub');

    const res = await request(ctx, `/api/files/${pctFolderId}/move`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/dest' },
    });
    expect(res.status).toBe(200);

    const rows = ctx.db
      .prepare(`SELECT type, path, name FROM file_metadata WHERE name IN ('100%', 'sub', 'inside.txt', '100x')`)
      .all() as Array<{ type: string; path: string; name: string }>;

    // 移动后的子树：主行 path=自身全路径；直接子文件与深层子目录前缀均改写
    expect(rows).toContainEqual({ type: 'folder', path: '/dest/100%', name: '100%' });
    expect(rows).toContainEqual({ type: 'file', path: '/dest/100%', name: 'inside.txt' });
    expect(rows).toContainEqual({ type: 'folder', path: '/dest/100%/sub', name: 'sub' });
    // 兄弟子树原样不动
    expect(rows).toContainEqual({ type: 'folder', path: '/100x', name: '100x' });
    expect(rows).toContainEqual({ type: 'folder', path: '/100x/sub', name: 'sub' });
  });
});
