// 目录重命名必须在一个事务内迁移主行与整棵子树（直接子文件行 path=父目录、子目录行 path=自身全路径、深层行前缀替换），
// 否则子项留在旧路径成为孤儿。目标同名目录/文件冲突一律 409；目录内含嵌套挂载点时拒绝重命名且不改动任何行。
// 目录名可含 %/_，前缀迁移必须先 ESCAPE 再拼通配，否则会误伤 /d7pX、/d7uX1 这类兄弟目录。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'd7_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'd7_admin'`);
  const res = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'd7_admin', password: 'password123' },
  });
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${token?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function createProvider(name: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name, bucket: 'd7-bucket' },
  });
  expect(res.status).toBe(201);
  const data = await json<{ data: { provider: { id: string } } }>(res);
  return data.data.provider.id;
}

async function createMount(mountPath: string, name: string, providerId: string): Promise<string> {
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { providerId, mountPath, name, priority: 500 },
  });
  expect(res.status).toBe(201);
  const data = await json<{ data: { mount: { id: string } } }>(res);
  return data.data.mount.id;
}

async function mkFolder(path: string, name: string): Promise<string> {
  const res = await request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { path, name },
  });
  expect(res.status).toBe(201);
  const data = await json<{ data: { file: { id: string } } }>(res);
  return data.data.file.id;
}

async function uploadFile(dir: string, fileName: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { path: dir, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  expect(initRes.status).toBe(200);
  const init = await json<{ data: { sessionId: string } }>(initRes);
  const rawRes = await request(ctx, `/api/files/upload/raw/${init.data.sessionId}`, {
    method: 'PUT',
    cookie: adminCookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': adminCsrf },
    body: content,
  });
  expect(rawRes.status).toBe(200);
  const raw = await json<{ data: { etag: string } }>(rawRes);
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { sessionId: init.data.sessionId, etag: raw.data.etag },
  });
  expect(completeRes.status).toBe(200);
  const complete = await json<{ data: { file: { id: string } } }>(completeRes);
  return complete.data.file.id;
}

function rename(id: string, name: string): Promise<Response> {
  return request(ctx, `/api/files/${id}`, {
    method: 'PUT',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name },
  });
}

interface MetaRow {
  id: string;
  type: string;
  path: string;
  name: string;
  mount_id: string;
}

/** node:sqlite 返回 Record<string, unknown>；测试内按字段取值，缺行视为失败 */
function row(id: string): MetaRow {
  const rec = ctx.db
    .prepare('SELECT id, type, path, name, mount_id FROM file_metadata WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  if (!rec) throw new Error(`缺少 file_metadata 行：${id}`);
  return {
    id: String(rec.id),
    type: String(rec.type),
    path: String(rec.path),
    name: String(rec.name),
    mount_id: String(rec.mount_id),
  };
}

function rootMountId(): string {
  const rec = ctx.db.prepare(`SELECT id FROM mounts WHERE mount_path = '/'`).get() as
    | Record<string, unknown>
    | undefined;
  if (!rec) throw new Error('缺少根挂载点');
  return String(rec.id);
}

/** 该挂载点下 path = prefix 或位于 prefix/ 子树内的行数（与实现同基准转义前缀） */
function rowsAtOrUnder(mountId: string, prefix: string): number {
  const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const rec = ctx.db
    .prepare(`SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`)
    .get(mountId, prefix, `${escaped}/%`) as Record<string, unknown> | undefined;
  return rec ? Number(rec.c) : 0;
}

describe('目录重命名迁移整棵子树', () => {
  it('主行 + 直接子文件 + 子目录 + 深层子项全部迁移，旧路径无孤儿残留', async () => {
    const folderId = await mkFolder('/', 'd7a');
    const subId = await mkFolder('/d7a', 'sub');
    const deepId = await mkFolder('/d7a/sub', 'deep');
    const rootFile = await uploadFile('/d7a', 'root.txt', 'r');
    const innerFile = await uploadFile('/d7a/sub', 'inner.txt', 'i');
    const deepFile = await uploadFile('/d7a/sub/deep', 'deepest.txt', 'd');

    const res = await rename(folderId, 'd7b');
    expect(res.status).toBe(200);

    // 主行 path = 自身全路径
    expect(row(folderId)).toMatchObject({ type: 'folder', path: '/d7b', name: 'd7b' });
    // 直接子文件行 path = 父目录
    expect(row(rootFile)).toMatchObject({ type: 'file', path: '/d7b', name: 'root.txt' });
    // 子目录行 path = 自身全路径（一层与两层）
    expect(row(subId)).toMatchObject({ type: 'folder', path: '/d7b/sub', name: 'sub' });
    expect(row(deepId)).toMatchObject({ type: 'folder', path: '/d7b/sub/deep', name: 'deep' });
    expect(row(innerFile)).toMatchObject({ type: 'file', path: '/d7b/sub', name: 'inner.txt' });
    expect(row(deepFile)).toMatchObject({ type: 'file', path: '/d7b/sub/deep', name: 'deepest.txt' });

    // 新路径列目录可见，旧路径前缀下无任何残留行
    const listRes = await request(ctx, '/api/files?path=/d7b', { cookie: adminCookie });
    expect(listRes.status).toBe(200);
    const list = await json<{ data: { items: Array<{ name: string }> } }>(listRes);
    const names = list.data.items.map((i) => i.name);
    expect(names).toContain('sub');
    expect(names).toContain('root.txt');
    expect(rowsAtOrUnder(rootMountId(), '/d7a')).toBe(0);
  });

  it('单文件重命名行为不变（仅改主行 path/name）', async () => {
    const fileId = await uploadFile('/', 'd7f-old.txt', 'x');
    const res = await rename(fileId, 'd7f-new.txt');
    expect(res.status).toBe(200);
    expect(row(fileId)).toMatchObject({ type: 'file', path: '/', name: 'd7f-new.txt' });
  });
});

describe('目录名含 % 与 _ 时兄弟子树不被误伤', () => {
  it('重命名 /d7p% 与 /d7u_1：自身子树迁移，/d7pX、/d7uX1 原样不动', async () => {
    const pctId = await mkFolder('/', 'd7p%');
    const pctSub = await mkFolder('/d7p%', 'sub');
    const pctFile = await uploadFile('/d7p%', 'in.txt', 'i');
    // 未转义时 '/d7p%/%' 的 % 会匹配 '/d7pX/sub' → 兄弟子树被改写
    await mkFolder('/', 'd7pX');
    const sibSub = await mkFolder('/d7pX', 'sub');
    const sibFile = await uploadFile('/d7pX', 'sib.txt', 's');

    const usId = await mkFolder('/', 'd7u_1');
    const usFile = await uploadFile('/d7u_1', 'u.txt', 'u');
    // 未转义时 '/d7u_1/%' 的 _ 会匹配 '/d7uX1/sub'
    await mkFolder('/', 'd7uX1');
    const usSibSub = await mkFolder('/d7uX1', 'sub');

    expect((await rename(pctId, 'd7q')).status).toBe(200);
    expect((await rename(usId, 'd7v')).status).toBe(200);

    expect(row(pctId)).toMatchObject({ path: '/d7q', name: 'd7q' });
    expect(row(pctSub)).toMatchObject({ path: '/d7q/sub', name: 'sub' });
    expect(row(pctFile)).toMatchObject({ path: '/d7q', name: 'in.txt' });
    expect(row(usId)).toMatchObject({ path: '/d7v', name: 'd7v' });
    expect(row(usFile)).toMatchObject({ path: '/d7v', name: 'u.txt' });

    expect(row(sibSub)).toMatchObject({ path: '/d7pX/sub', name: 'sub' });
    expect(row(sibFile)).toMatchObject({ path: '/d7pX', name: 'sib.txt' });
    expect(row(usSibSub)).toMatchObject({ path: '/d7uX1/sub', name: 'sub' });
  });
});

describe('目标路径冲突', () => {
  it('目录改名撞已存在目录 → 409 且两侧行不动', async () => {
    const c1 = await mkFolder('/', 'd7c1');
    const c2 = await mkFolder('/', 'd7c2');
    const res = await rename(c1, 'd7c2');
    expect(res.status).toBe(409);
    const err = await json<{ error: { code: string; message: string } }>(res);
    expect(err.error.code).toBe('ALREADY_EXISTS');
    expect(err.error.message).toBe('同名文件夹已存在');
    expect(row(c1)).toMatchObject({ path: '/d7c1', name: 'd7c1' });
    expect(row(c2)).toMatchObject({ path: '/d7c2', name: 'd7c2' });
  });

  it('目录改名撞已存在文件 → 409（既有行为）', async () => {
    const c3 = await mkFolder('/', 'd7c3');
    await uploadFile('/', 'd7c4.txt', 'x');
    const res = await rename(c3, 'd7c4.txt');
    expect(res.status).toBe(409);
    const err = await json<{ error: { code: string } }>(res);
    expect(err.error.code).toBe('ALREADY_EXISTS');
    expect(row(c3)).toMatchObject({ path: '/d7c3', name: 'd7c3' });
  });

  it('文件改名撞目录名 → 409（目录行 path=自身全路径，原 file 行检查覆盖不到）', async () => {
    const fileId = await uploadFile('/', 'd7c5.txt', 'x');
    const res = await rename(fileId, 'd7c1');
    expect(res.status).toBe(409);
    const err = await json<{ error: { code: string } }>(res);
    expect(err.error.code).toBe('ALREADY_EXISTS');
    expect(row(fileId)).toMatchObject({ type: 'file', path: '/', name: 'd7c5.txt' });
  });
});

describe('目录内含嵌套挂载点时拒绝重命名', () => {
  it('嵌套挂载点目录行不会被迁离 mounts.mount_path，任何行都不改动', async () => {
    const parentId = await mkFolder('/', 'd7m');
    const keepFile = await uploadFile('/d7m', 'keep.txt', 'k');
    const otherFile = await uploadFile('/d7m', 'keep2.txt', 'k2');

    const providerId = await createProvider('d7-nested-provider');
    const nestedMountId = await createMount('/d7m/nested', '嵌套挂载', providerId);

    const res = await rename(parentId, 'd7m2');
    expect(res.status).toBe(409);
    const err = await json<{ error: { code: string; message: string } }>(res);
    expect(err.error.code).toBe('OPERATION_FAILED');
    expect(err.error.message).toBe('目录包含挂载点，无法重命名');

    // 主行、子文件行、挂载点目录行、mounts.mount_path 全部保持原位
    expect(row(parentId)).toMatchObject({ type: 'folder', path: '/d7m', name: 'd7m' });
    expect(row(keepFile)).toMatchObject({ path: '/d7m', name: 'keep.txt' });
    expect(row(`mountfolder:${nestedMountId}`)).toMatchObject({ path: '/d7m/nested', name: 'nested' });
    const mountRec = ctx.db.prepare('SELECT mount_path FROM mounts WHERE id = ?').get(nestedMountId) as
      | Record<string, unknown>
      | undefined;
    expect(mountRec ? String(mountRec.mount_path) : null).toBe('/d7m/nested');

    // 该守卫只针对目录：同目录内的普通文件重命名不受影响
    const fileRes = await rename(otherFile, 'keep2-renamed.txt');
    expect(fileRes.status).toBe(200);
    expect(row(otherFile)).toMatchObject({ type: 'file', path: '/d7m', name: 'keep2-renamed.txt' });
  });
});
