// AList v3 / OpenList 兼容 shim（P2-1，docs/PICLIST_COMPAT_CN.md）：挂载于 /openlist 前缀。
// 独立前缀原因：Picumet 已占用 /api/auth/login（自有 JWT 登录），PicList url 填 https://host/openlist。
// 契约（PicList-Core uploader/alist.ts 实测钉死）：
//   POST /openlist/api/auth/login  {username:keyId, password:secret} → {code:200,message:'success',data:{token}}
//   PUT  /openlist/api/fs/form     multipart(file) + Authorization:<裸 token> + File-Path:encodeURIComponent(完整路径)
//   POST /openlist/api/fs/list     {path} → data.content[{name,size,is_dir,modified}]
//   POST /openlist/api/fs/get      {path} → data.sign（/d 直链签名能力）
//   GET  /openlist/d<encodedPath>?sign=  直链下载（公开挂载匿名；私有挂载凭 sign）
//   POST /openlist/api/fs/remove   {dir, names:[...]}
// handleResError 要求 HTTP 200 + code===200 + message==='success'，缺一即整次上传报错
//（fs/form 落地后仍会调 fs/list + fs/get，四端点缺一不可）。
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import { FileRepo, MountRepo, ProviderRepo } from '../../db';
import { getDb, getClientIp, apiKeyTokenAuthMiddleware, assertApiKeyProtocol, resolveApiKeyByToken } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { requirePermission } from '../permissions/principal';
import { deleteFileInternal } from '../files/remove';
import { serveObject } from '../storage/serve';
import { uploadBytes } from '../uploads/upload-bytes';
import { normalizePath, isPathWithinBoundary } from '../../utils/path';
import { signPath, verifyPathSign } from '../../utils/crypto';
import { decideAccessMode } from '../shares/tokens';
import { ApiError } from '../../shared/errors';
import type { ApiKey } from '@shared/types';

export const alistRoutes = new Hono<AppBindings>();

const AListFail = (code: number, message: string) => ({ code, message, data: null });
const AListOk = (data: unknown) => ({ code: 200, message: 'success', data });

function pctDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 密钥上传根与目标路径的可达性（目录允许祖先，对象要求精确边界内） */
function assertScope(apiKey: { uploadPath: string }, virtualPath: string, exact: boolean): string | null {
  const uploadRoot = normalizePath(apiKey.uploadPath || '/');
  if (isPathWithinBoundary(virtualPath, uploadRoot)) return null;
  if (!exact && isPathWithinBoundary(uploadRoot, virtualPath)) return null;
  return '目标超出密钥上传根目录';
}

// ============ 登录：keyId/secret 即 username/password，验证后回发完整 token（无服务端会话） ============

alistRoutes.post('/api/auth/login', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null) as { username?: string; password?: string } | null;
  const fail = () => c.json(AListFail(403, '用户名或密码错误'));
  if (!body?.username || !body?.password) return fail();
  const token = `${body.username}.${body.password}`;
  if (!/^pk_[a-zA-Z0-9]+\.sk_[a-zA-Z0-9]+$/.test(token)) return fail();
  const apiKey = await resolveApiKeyByToken(db, token);
  if (!apiKey || apiKey.status !== 'active') return fail();
  if (apiKey.expiresAt && Date.now() > apiKey.expiresAt) return fail();
  if (apiKey.allowedIps && apiKey.allowedIps.length > 0) {
    if (!apiKey.allowedIps.includes(getClientIp(c))) return fail();
  }
  return c.json(AListOk({ token }));
});

// ============ fs/*：全部需要 API 密钥（裸 token / Bearer / Basic 均可） ============

const fsApi = new Hono<AppBindings>();

fsApi.use('*', apiKeyTokenAuthMiddleware);

// PUT /api/fs/form：multipart 上传，File-Path 为完整虚拟路径（encodeURIComponent）
fsApi.put('/form', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey')!;
  if (!apiKey.permissions.includes('write')) return c.json(AListFail(403, '密钥无上传权限'));
  try {
    assertApiKeyProtocol(apiKey, 'api');
  } catch {
    return c.json(AListFail(403, '该密钥未授权 api 协议'));
  }

  const rawFilePath = c.req.header('file-path');
  if (!rawFilePath) return c.json(AListFail(400, '缺少 File-Path 头'));
  const targetFullPath = normalizePath(pctDecode(rawFilePath));
  const segs = targetFullPath.split('/').filter(Boolean);
  const fileName = segs.pop();
  if (!fileName) return c.json(AListFail(400, 'File-Path 无效'));
  const dir = '/' + segs.join('/');

  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json(AListFail(400, '缺少 file 字段'));

  try {
    // 统一写入路径：边界/权限/配额/覆盖/目录行与 /api/upload 完全一致
    await uploadBytes(c, db, apiKey.userId, apiKey.uploadPath, fileName, file.type, file.size, file.stream(), dir);
    return c.json(AListOk(null));
  } catch (err) {
    // ApiError 语义码透传（403/404/409/413…），其余按 500
    const code = err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    const message = err instanceof ApiError || err instanceof Error ? err.message : '上传失败';
    return c.json(AListFail(code, message));
  }
});

// POST /api/fs/list：目录列表（属主范围内）
fsApi.post('/list', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey')!;
  const body = await c.req.json().catch(() => null) as { path?: string; per_page?: number } | null;
  const dir = normalizePath(body?.path ?? '/');
  const scopeError = assertScope(apiKey, dir, false);
  if (scopeError) return c.json(AListFail(403, scopeError));
  const mount = await MountRepo.findMountForPath(db, dir);
  if (!mount) return c.json(AListFail(500, '挂载点不存在'));
  try {
    await requirePermission(c, mount, dir, 'read');
  } catch {
    return c.json(AListFail(403, '无权读取该目录'));
  }
  const { rows, total } = await FileRepo.listChildren(db, mount.id, dir, { limit: body?.per_page ?? 100 }, apiKey.userId);
  const content = rows.map((r) => ({
    name: r.name,
    size: r.size,
    is_dir: r.type === 'folder',
    modified: Math.floor(r.updatedAt / 1000),
  }));
  return c.json(AListOk({ content, total, readme: '', header: '', write: true, provider: 'Picumet' }));
});

// POST /api/fs/get：取单条元数据 + /d 直链签名（PicList 用 data.sign 拼 imgUrl）
fsApi.post('/get', async (c) => {
  const db = getDb(c);
  const env = c.env as Env;
  const apiKey = c.get('apiKey')!;
  const body = await c.req.json().catch(() => null) as { path?: string } | null;
  if (!body?.path) return c.json(AListFail(400, '缺少 path'));
  const virtualPath = normalizePath(body.path);
  const scopeError = assertScope(apiKey, virtualPath, true);
  if (scopeError) return c.json(AListFail(403, scopeError));
  const mount = await MountRepo.findMountForPath(db, virtualPath);
  if (!mount) return c.json(AListFail(500, 'object not found'));
  const segs = virtualPath.split('/').filter(Boolean);
  const name = segs.pop()!;
  const parent = '/' + segs.join('/');
  const file = await FileRepo.getFileAtPath(db, mount.id, parent, name)
    ?? await FileRepo.getFolderAtPath(db, mount.id, virtualPath, name);
  if (!file) return c.json(AListFail(500, 'object not found'));
  try {
    await requirePermission(c, mount, virtualPath, 'read', file.ownerId);
  } catch {
    return c.json(AListFail(403, '无权读取'));
  }
  // 长期路径签名（能力范围 = 该精确路径的匿名 GET）
  const sign = await signPath(virtualPath, env.ENCRYPTION_KEY);
  return c.json(AListOk({
    name: file.name,
    size: file.size,
    is_dir: file.type === 'folder',
    modified: Math.floor(file.updatedAt / 1000),
    sign,
    raw_url: '',
    provider: 'Picumet',
    related: null,
  }));
});

// POST /api/fs/remove：删除（复用 WebDAV 同款 Saga 删除语义）
fsApi.post('/remove', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey')!;
  const body = await c.req.json().catch(() => null) as { dir?: string; names?: string[] } | null;
  if (!body?.dir || !Array.isArray(body.names)) return c.json(AListFail(400, '参数无效'));
  const dir = normalizePath(body.dir);
  for (const name of body.names) {
    const virtualPath = normalizePath(`${dir}/${name}`);
    const scopeError = assertScope(apiKey, virtualPath, true);
    if (scopeError) return c.json(AListFail(403, scopeError));
    const mount = await MountRepo.findMountForPath(db, virtualPath);
    if (!mount) return c.json(AListFail(500, '挂载点不存在'));
    const segs = virtualPath.split('/').filter(Boolean);
    const baseName = segs.pop()!;
    const parent = '/' + segs.join('/');
    const file = await FileRepo.getFileAtPath(db, mount.id, parent, baseName)
      ?? await FileRepo.getFolderAtPath(db, mount.id, virtualPath, baseName);
    if (!file) return c.json(AListFail(500, 'object not found'));
    if (file.type === 'file' && file.ownerId !== apiKey.userId) return c.json(AListFail(500, 'object not found'));
    try {
      await requirePermission(c, mount, virtualPath, 'delete', file.ownerId);
    } catch {
      return c.json(AListFail(403, '无权删除'));
    }
    await deleteFileInternal(c, mount, file, apiKey.userId);
  }
  return c.json(AListOk(null));
});

alistRoutes.route('/api/fs', fsApi);

// ============ /d 直链：公开挂载匿名；私有挂载凭 fs/get 下发的 sign ============
// 注意：Hono RegExpRouter 将 '/d*' 中的 '*'（非 '/*'）按字面量转义，永不匹配；
// 故用子应用级 GET 兜底（注册于最后，不遮蔽上面的 login/fs 路由），
// 覆盖 PicList 的 raw %2F 形态（'/openlist/d%2Fuploads%2F…'）与浏览器字面斜杠形态。
async function handleDirectLink(c: Context<AppBindings>): Promise<Response> {
  const db = getDb(c);
  const env = c.env as Env;
  const raw = new URL(c.req.raw.url).pathname;
  if (!raw.startsWith('/openlist/d')) {
    return c.text('not found', 404);
  }
  // PicList 拼接形态：'/d' + encodeURIComponent(path)（路径以 %2F 出现）或浏览器直接访问（字面 '/'）
  const rest = raw.replace(/^\/openlist\/d/, '');
  if (!rest) return c.text('not found', 404);
  const virtualPath = normalizePath(pctDecode(rest));
  if (virtualPath.split('/').includes('..')) return c.text('not found', 404);

  const mount = await MountRepo.findMountForPath(db, virtualPath);
  if (!mount) return c.text('not found', 404);
  const segs = virtualPath.split('/').filter(Boolean);
  const name = segs.pop();
  if (!name) return c.text('not found', 404);
  const parent = '/' + segs.join('/');
  const file = await FileRepo.getFileAtPath(db, mount.id, parent, name);
  if (!file || file.type !== 'file') return c.text('not found', 404);
  if (file.accessPassword) return c.text('password required', 403);

  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) return c.text('not found', 404);
  const provider = await getProvider(db, providerRow, env);

  const accessMode = decideAccessMode(file, provider, false);
  if (accessMode !== 'public_cdn') {
    const sign = c.req.query('sign');
    const signOk = sign ? await verifyPathSign(virtualPath, env.ENCRYPTION_KEY, sign) : false;
    if (!signOk) return c.text('forbidden', 403);
  }

  return serveObject({
    provider,
    objectKey: file.objectKey,
    name: file.name,
    mimeType: file.mimeType,
    rangeHeader: c.req.header('range'),
    totalSize: file.size,
  });
}

alistRoutes.get('*', handleDirectLink);
