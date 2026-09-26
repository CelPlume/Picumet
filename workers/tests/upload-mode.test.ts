// §28 写入口模式（mounts.upload_mode）：
//   user_space —— 写路径强制落在 <mountPath>/<用户名>，该目录首用自动创建；
//   flat       —— 挂载点内禁止新建文件夹（平铺上传），上传路径本身不额外约束；
//   free       —— 现状（无额外约束）。
// 断言全部走真实 HTTP 面（compat 上传 / 文件端点 / WebDAV MKCOL / 会话上传），
// 保证「同一挂载点在任一写入口行为一致」。
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, grantApiKeyRule,
  type TestContext,
} from './helpers';
import { Db, MountRepo, ProviderRepo } from '../src/db';

interface UploadResponse {
  data: { path: string };
}

interface ErrorResponse {
  error: { code: string };
}

interface SessionInitResponse {
  data: { sessionId: string };
}

interface RawUploadResponse {
  data: { etag: string };
}

interface CompleteResponse {
  data: { file: { id: string; path: string } };
}

let ctx: TestContext;
let publicMountId: string;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  const db = Db.fromSqlite(ctx.db);
  const provider = (await ProviderRepo.listProviders(db))[0];
  // priority 必须高于种子根挂载（100），否则 findMountForPath 会把 /public/** 全部归到根挂载
  const mount = await MountRepo.createMount(db, {
    providerId: provider.id,
    mountPath: '/public',
    name: '公共上传区',
    priority: 200,
  });
  publicMountId = mount.id;
});

/** 切换 /public 挂载点的写入口模式（DDL 默认 free = 现状） */
async function setMode(mode: 'free' | 'user_space' | 'flat'): Promise<void> {
  await Db.fromSqlite(ctx.db).run(`UPDATE mounts SET upload_mode = ? WHERE id = ?`, [mode, publicMountId]);
}

interface KeyBundle {
  fullToken: string;
  keyId: string;
  secret: string;
}

/** 建带指定协议的密钥（上传根 /public），并授 '/public/**' 的读写删规则 */
async function createKey(username: string, protocols: string[] = ['api']): Promise<KeyBundle> {
  const { authCookie } = await registerAndLogin(ctx, username);
  const csrf = await getCsrf(ctx, authCookie);
  const res = await request(ctx, '/api/keys', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { name: 'up', permissions: ['read', 'write', 'delete'], protocols, uploadPath: '/public' },
  });
  expect(res.status).toBe(201);
  const data = await json<{ data: { key: { keyId: string; secret: string; fullToken: string } } }>(res);
  await grantApiKeyRule(ctx, data.data.key.keyId, ['read', 'write', 'delete'], '/public/**');
  return { fullToken: data.data.key.fullToken, keyId: data.data.key.keyId, secret: data.data.key.secret };
}

/** compat 上传（POST /api/upload，multipart）：dir 为绝对目录，缺省落在上传根 */
async function compatUpload(token: string, fileName: string, content: string, dir?: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new File([new Blob([content])], fileName, { type: 'text/plain' }));
  if (dir) form.append('path', dir);
  return request(ctx, '/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

async function uploadPathOf(res: Response): Promise<string> {
  const data = await json<UploadResponse>(res);
  return data.data.path;
}

async function errorCodeOf(res: Response): Promise<string> {
  const data = await json<ErrorResponse>(res);
  return data.error.code;
}

async function createFolder(cookie: string, path: string, name: string): Promise<Response> {
  const csrf = await getCsrf(ctx, cookie);
  return request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, name },
  });
}

interface SessionUploadResult {
  init: Response;
  raw: Response | null;
  complete: Response | null;
  file?: { id: string; path: string };
}

/** 会话上传通道（upload-session → raw → complete） */
async function sessionUpload(cookie: string, path: string, fileName: string, content: string): Promise<SessionUploadResult> {
  const csrf = await getCsrf(ctx, cookie);
  const bytes = new TextEncoder().encode(content);
  const init = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  if (init.status !== 200) return { init, raw: null, complete: null };
  const sessionId = (await json<SessionInitResponse>(init)).data.sessionId;
  const raw = await request(ctx, `/api/files/upload/raw/${sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  if (raw.status !== 200) return { init, raw, complete: null };
  const etag = (await json<RawUploadResponse>(raw)).data.etag;
  const complete = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId, etag },
  });
  if (complete.status !== 200) return { init, raw, complete };
  const file = (await json<CompleteResponse>(complete)).data.file;
  return { init, raw, complete, file };
}

describe('挂载点写入口模式（§28）', () => {
  it('user_space：写入自身空间成功，且用户目录首用自动创建', async () => {
    await setMode('user_space');
    const alice = await createKey('usalice');

    const res = await compatUpload(alice.fullToken, 'photo.txt', 'alice-body', '/public/usalice');
    expect(res.status).toBe(200);
    expect(await uploadPathOf(res)).toBe('/public/usalice/photo.txt');

    // 目录行自愈：用户空间目录已自动创建
    const folder = ctx.db
      .prepare(`SELECT type FROM file_metadata WHERE mount_id = ? AND path = ? AND name = ?`)
      .get(publicMountId, '/public/usalice', 'usalice') as { type?: string } | undefined;
    expect(folder?.type).toBe('folder');
  });

  it('user_space：写他人空间或挂载根 → 403', async () => {
    await setMode('user_space');
    const bob = await createKey('usbob');

    const otherSpace = await compatUpload(bob.fullToken, 'x.txt', 'x', '/public/usalice');
    expect(otherSpace.status).toBe(403);
    expect(await errorCodeOf(otherSpace)).toBe('FORBIDDEN');

    const mountRoot = await compatUpload(bob.fullToken, 'x.txt', 'x', '/public');
    expect(mountRoot.status).toBe(403);
  });

  it('user_space：/public/alice2 不被 /public/alice 边界误放行（路径段边界）', async () => {
    await setMode('user_space');
    const alice = await createKey('alice');
    const alice2 = await createKey('alice2');

    // alice 写 alice2 目录：朴素 startsWith 判定会误放行，必须按路径段边界 403
    const cross = await compatUpload(alice.fullToken, 'x.txt', 'x', '/public/alice2');
    expect(cross.status).toBe(403);

    // alice2 写自身空间不受前缀关系影响
    const own = await compatUpload(alice2.fullToken, 'x.txt', 'x', '/public/alice2');
    expect(own.status).toBe(200);
    expect(await uploadPathOf(own)).toBe('/public/alice2/x.txt');
  });

  it('flat：平铺上传成功，新建文件夹（文件端点 / WebDAV MKCOL）→ 403', async () => {
    await setMode('flat');
    const key = await createKey('flatup');

    const up = await compatUpload(key.fullToken, 'flat.txt', 'flat-body');
    expect(up.status).toBe(200);
    expect(await uploadPathOf(up)).toBe('/public/flat.txt');

    const { authCookie } = await registerAndLogin(ctx, 'flatmk');
    const mk = await createFolder(authCookie, '/public', '子目录');
    expect(mk.status).toBe(403);
    expect(await errorCodeOf(mk)).toBe('FORBIDDEN');

    const davKey = await createKey('flatdav', ['webdav']);
    const davAuth = 'Basic ' + Buffer.from(`${davKey.keyId}:${davKey.secret}`).toString('base64');
    const mkcol = await request(ctx, '/webdav/public/newdir', {
      method: 'MKCOL',
      headers: { Authorization: davAuth },
    });
    expect(mkcol.status).toBe(403);
  });

  it('flat：上传到需要新建祖先目录的嵌套路径 → 403（不再静默建目录行）', async () => {
    await setMode('flat');
    const key = await createKey('flatnest');
    const res = await compatUpload(key.fullToken, 'nested.txt', 'body', '/public/sub');
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('FORBIDDEN');
    // 目录行与文件行都未产生（写入先于 ensureFolders 的建目录被拒）
    const rows = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM file_metadata WHERE name IN ('sub', 'nested.txt')`)
      .get() as { c: number };
    expect(Number(rows.c)).toBe(0);
  });

  it('flat：第二个用户上传同名文件仍是既有 409 CONFLICT', async () => {
    await setMode('flat');
    const first = await createKey('flatsame1');
    const second = await createKey('flatsame2');

    const r1 = await compatUpload(first.fullToken, 'same.txt', 'first');
    expect(r1.status).toBe(200);

    const r2 = await compatUpload(second.fullToken, 'same.txt', 'second');
    expect(r2.status).toBe(409);
    expect(await errorCodeOf(r2)).toBe('CONFLICT');
  });

  it('free：行为与现状一致（任意目录写入 + 新建文件夹均放行）', async () => {
    await setMode('free');
    const key = await createKey('freeuser');

    const up = await compatUpload(key.fullToken, 'free.txt', 'free-body', '/public/任意目录');
    expect(up.status).toBe(200);
    expect(await uploadPathOf(up)).toBe('/public/任意目录/free.txt');

    const { authCookie } = await registerAndLogin(ctx, 'freemk');
    const mk = await createFolder(authCookie, '/public', '子目录');
    expect(mk.status).toBe(201);
  });

  it('user_space：会话上传通道（upload-session）同样受约束', async () => {
    await setMode('user_space');
    const { authCookie } = await registerAndLogin(ctx, 'ussess');

    // 他人空间：会话创建即 403（路径在 init 时固定，raw/complete 不会改路径）
    const denied = await sessionUpload(authCookie, '/public/otherspace', 'a.txt', 'body');
    expect(denied.init.status).toBe(403);
    expect(await errorCodeOf(denied.init)).toBe('FORBIDDEN');

    // 自身空间：全流程可走通
    const allowed = await sessionUpload(authCookie, '/public/ussess', 'a.txt', 'body');
    expect(allowed.complete?.status).toBe(200);
    expect(allowed.file?.path).toBe('/public/ussess');
  });

  it('user_space：移动目标落在他人空间 → 403', async () => {
    await setMode('user_space');
    const { authCookie } = await registerAndLogin(ctx, 'usmove');
    const uploaded = await sessionUpload(authCookie, '/public/usmove', 'mine.txt', 'mine');
    expect(uploaded.file?.id).toBeTruthy();
    const fileId = uploaded.file?.id ?? '';

    const csrf = await getCsrf(ctx, authCookie);
    const move = await request(ctx, `/api/files/${fileId}/move`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/public/elsewhere' },
    });
    expect(move.status).toBe(403);
    expect(await errorCodeOf(move)).toBe('FORBIDDEN');

    // 目标落在自身空间内仍可移动
    const okMove = await request(ctx, `/api/files/${fileId}/move`, {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { targetPath: '/public/usmove/sub' },
    });
    expect(okMove.status).toBe(200);
  });
});
