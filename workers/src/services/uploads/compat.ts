// 兼容上传 API：PicGo/PicList 自定义上传（Bearer API Key 认证）
// P0-1 可用直链 / P0-2 覆盖语义 / P0-3 祖先目录行 —— 统一委托 files/write.ts
import { Hono } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import {
  FileRepo, MountRepo, ProviderRepo, LogRepo,
} from '../../db';
import { getDb } from '../../middleware/auth';
import { assertApiKeyProtocol } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { requirePermission } from '../permissions/principal';
import { serveObject } from '../storage/serve';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import {
  normalizePath, isPathWithinBoundary,
  renderPathTemplate, buildTemplateVars, splitNestedFileName,
} from '../../utils/path';
import { uuid } from '../../utils/crypto';
import { uploadBytes } from './upload-bytes';

export const compatRoutes = new Hono();

/**
 * POST /api/upload（及 /api/compat/upload）
 * multipart/form-data：file 字段；可选 path 字段。
 * 成功返回 { success: true, data: { url, fileId, ... } }
 */
compatRoutes.post('/', handleCompatUpload);
compatRoutes.post('/upload', handleCompatUpload);

/**
 * GET /api/compat/file?path=/uploads/a.png（P1-4：密钥可用的程序化只读端点）
 * 要求 read 权限；目标必须位于密钥上传根内。
 */
compatRoutes.get('/file', handleCompatDownload);

async function handleCompatUpload(c: Parameters<typeof ok>[0]) {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 API 密钥认证');
  if (!apiKey.permissions.includes('write')) throw new ApiError(403, 'FORBIDDEN', '密钥无上传权限');
  assertApiKeyProtocol(apiKey, 'api');
  const userId = c.get('userId');

  const contentType = c.req.header('content-type') ?? '';
  let fileName = '';
  let mimeType = '';
  let customPath: string | undefined;

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    customPath = (form.get('path') as string | null) ?? undefined;
    if (!(file instanceof File)) throw ApiError.badRequest('缺少 file 字段');
    // P1-3.6：{localFolder:N} 等重命名可让 multipart 文件名携带嵌套路径段
    const split = splitNestedFileName(file.name, customPath);
    // 审计 H-03：multipart 用 file.stream() 流式写入，避免 arrayBuffer 整包入内存
    const stream = file.stream();
    return uploadBytes(c, db, userId, apiKey.uploadPath, split.fileName, file.type, file.size, stream, split.customPath);
  }

  // 原始 body 上传：x-file-name header 指定文件名
  const rawName = c.req.header('x-file-name') ?? c.req.header('filename') ?? '';
  mimeType = c.req.header('content-type') ?? '';
  customPath = c.req.header('x-path');
  if (!rawName) throw ApiError.badRequest('缺少文件名（使用 X-File-Name 头或 multipart）');
  const split = splitNestedFileName(rawName, customPath);
  fileName = split.fileName;
  customPath = split.customPath;
  // 审计 H-03：raw body 流式转发；Content-Length 已知则流式，缺失（chunked）回退读取
  const rawLength = Number(c.req.header('content-length') ?? '');
  const hasLength = Number.isFinite(rawLength) && rawLength > 0;
  let size: number;
  let body: ReadableStream<Uint8Array>;
  if (hasLength) {
    size = rawLength;
    const stream = c.req.raw.body as ReadableStream<Uint8Array> | null;
    if (!stream) throw ApiError.badRequest('请求体为空');
    body = stream;
  } else {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    size = bytes.byteLength;
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  return uploadBytes(c, db, userId, apiKey.uploadPath, fileName, mimeType, size, body, customPath);
}

async function handleCompatDownload(c: Parameters<typeof ok>[0]) {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 API 密钥认证');
  if (!apiKey.permissions.includes('read')) throw new ApiError(403, 'FORBIDDEN', '密钥无读取权限');
  assertApiKeyProtocol(apiKey, 'api');

  const rawPath = c.req.query('path');
  if (!rawPath) throw ApiError.badRequest('缺少 path 查询参数');
  const targetPath = normalizePath(rawPath);
  const uploadRoot = normalizePath(apiKey.uploadPath || '/');
  if (!isPathWithinBoundary(targetPath, uploadRoot)) {
    throw new ApiError(403, 'FORBIDDEN', '目标路径超出密钥上传根目录');
  }

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在或未挂载');
  await requirePermission(c, mount, targetPath, 'read');

  const segs = targetPath.split('/').filter(Boolean);
  const name = segs.pop();
  if (!name) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  const parent = '/' + segs.join('/');
  // 网关密钥数据层所有者绑定：按属主过滤查询 → 他人文件不可见（404，与 WebDAV 语义一致）
  const file = await FileRepo.getFileAtPath(db, mount.id, parent, name, apiKey.userId);
  if (!file || file.type !== 'file') throw new ApiError(404, 'NOT_FOUND', '文件不存在');

  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  const provider = await getProvider(db, providerRow, c.env as Env);

  await LogRepo.create(db, {
    userId: apiKey.userId,
    action: 'download',
    path: file.path,
    metadata: JSON.stringify({ fileName: file.name, via: 'compat-api' }),
    ipAddress: c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? undefined,
    userAgent: c.req.header('user-agent'),
    bytesTransferred: file.size,
  });

  return serveObject({
    provider,
    objectKey: file.objectKey,
    name: file.name,
    mimeType: file.mimeType,
    rangeHeader: c.req.header('range'),
    totalSize: file.size,
  });
}

export { uploadBytes };
