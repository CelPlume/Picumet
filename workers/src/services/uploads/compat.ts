// 兼容上传 API：PicGo/PicList 自定义上传（Bearer API Key 认证）
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import {
  FileRepo, QuotaRepo, MountRepo, ProviderRepo,
} from '../../db';
import { getDb, getClientIp } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { requirePermission } from '../permissions/principal';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import {
  normalizePath, objectKeyFromPath, isValidFileName, isPathWithinBoundary,
  renderPathTemplate, buildTemplateVars, validateFileType,
} from '../../utils/path';
import { uuid } from '../../utils/crypto';
import type { Env } from '../../shared/types';
import { ReconciliationRepo } from '../../db';

export const compatRoutes = new Hono();

/**
 * POST /api/upload（及 /api/compat/upload）
 * multipart/form-data：file 字段；可选 path 字段。
 * 成功返回 { success: true, data: { url, fileId, ... } }
 */
compatRoutes.post('/', handleCompatUpload);
compatRoutes.post('/upload', handleCompatUpload);

async function handleCompatUpload(c: Parameters<typeof ok>[0]) {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new ApiError(401, 'UNAUTHORIZED', '需要 API 密钥认证');
  if (!apiKey.permissions.includes('write')) throw new ApiError(403, 'FORBIDDEN', '密钥无上传权限');
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
    // 审计 H-03：multipart 用 file.stream() 流式写入，避免 arrayBuffer 整包入内存
    const stream = file.stream();
    return uploadBytes(c, db, userId, apiKey.uploadPath, file.name, file.type, file.size, stream, customPath);
  }

  // 原始 body 上传：x-file-name header 指定文件名
  fileName = c.req.header('x-file-name') ?? c.req.header('filename') ?? '';
  mimeType = c.req.header('content-type') ?? '';
  customPath = c.req.header('x-path');
  if (!fileName) throw ApiError.badRequest('缺少文件名（使用 X-File-Name 头或 multipart）');
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

async function uploadBytes(
  c: Parameters<typeof ok>[0],
  db: ReturnType<typeof getDb>,
  userId: string,
  uploadPathTemplate: string,
  fileName: string,
  mimeType: string,
  size: number,
  body: ReadableStream<Uint8Array>,
  customPath?: string
) {
  if (!isValidFileName(fileName)) throw ApiError.badRequest('文件名包含非法字符');
  validateFileType(fileName, mimeType);

  // M-3：密钥上传根（规范化），最终目标必须落在其边界内
  const uploadRoot = normalizePath(uploadPathTemplate || '/uploads');

  // 渲染路径模板
  const extMatch = fileName.match(/\.[^.]+$/)?.[0] ?? '';
  const vars = buildTemplateVars({
    uuid: uuid(),
    ext: extMatch.replace('.', ''),
    mime: mimeType,
    username: c.get('user')?.username ?? 'anonymous',
  });
  const rendered = normalizePath(renderPathTemplate(uploadPathTemplate || '/uploads', vars));
  const targetPath = customPath
    ? normalizePath(`${customPath}/${fileName}`)
    : rendered === '/'
      ? `/${fileName}`
      : rendered.endsWith('/' + fileName)
        ? rendered
        : normalizePath(`${rendered}/${fileName}`);

  // M-3：customPath 与模板结果都不得越过密钥上传根
  if (!isPathWithinBoundary(targetPath, uploadRoot)) {
    throw new ApiError(403, 'FORBIDDEN', '上传目标超出密钥配置的上传根目录');
  }

  // 配额预留
  const reserved = await QuotaRepo.reserve(db, userId, size);
  if (!reserved) throw new ApiError(413, 'QUOTA_EXCEEDED', '存储配额不足');
  const canAdd = await QuotaRepo.canAddFile(db, userId);
  if (!canAdd) {
    await QuotaRepo.releaseReservation(db, userId, size);
    throw new ApiError(413, 'QUOTA_EXCEEDED', '文件数量配额已满');
  }

  let objectKey: string | undefined;
  let mountId: string | undefined;

  try {
    const mount = await MountRepo.findMountForPath(db, targetPath);
    if (!mount) throw new ApiError(404, 'NOT_FOUND', '目标挂载点不存在');
    // M-3/H-3：最终路径再次通过统一权限服务（API Key 权限 ∩ 路径规则）
    await requirePermission(c, mount, targetPath, 'write');
    const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
    if (!providerRow) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
    const provider = await getProvider(db, providerRow, c.env as Env);
    const key = objectKeyFromPath(mount.mountPath, providerRow.pathPrefix, targetPath);
    objectKey = key;
    mountId = mount.id;

    await provider.putObject(key, body, mimeType);
    const head = await provider.headObject(key);
    if (!head || head.size !== size) {
      throw new ApiError(422, 'OPERATION_FAILED', '上传校验失败');
    }

    // H-5：元数据 + 配额 + 日志同一批提交（对象已写入，DB 侧原子；失败即补偿删对象）
    const fileId = uuid();
    await db.transaction(async (tx) => {
      await FileRepo.createFileTx(tx, {
        id: fileId,
        mountId: mount.id,
        objectKey: key,
        path: targetPath.slice(0, -(fileName.length + 1)) || '/',
        name: fileName,
        type: 'file',
        mimeType,
        size,
        etag: head.etag,
        ownerId: userId,
      });
      await tx.query(
        `UPDATE user_quotas SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?), used_files = used_files + 1, updated_at = ? WHERE user_id = ?`,
        [size, size, Date.now(), userId]
      );
      await tx.query(
        `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
         VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 200, ?)`,
        [uuid(), userId, targetPath, JSON.stringify({ fileName, via: 'api' }), getClientIp(c), c.req.header('user-agent'), size, Date.now()]
      );
    });

    // 兼容图床响应：返回 URL
    const base = c.env.APP_BASE_URL || `${c.req.url.split('/').slice(0, 3).join('/')}`;
    return ok(c, {
      url: `${base}/api/files/${fileId}/download`,
      fileId,
      path: targetPath,
      size,
      filename: fileName,
    });
  } catch (err) {
    // 补偿：释放预留；尽力删除已写对象，失败记录孤儿供对账
    await QuotaRepo.releaseReservation(db, userId, size);
    if (objectKey && mountId) {
      try {
        const mount = await MountRepo.getMountById(db, mountId);
        const providerRow = mount ? await ProviderRepo.getProviderById(db, mount.providerId) : null;
        if (providerRow) {
          const provider = await getProvider(db, providerRow, c.env as Env);
          await provider.deleteObject(objectKey);
        }
      } catch (cleanupErr) {
        await ReconciliationRepo.createOrphanObject(db, {
          mountId,
          objectKey,
          reason: 'upload_db_failed',
          error: cleanupErr instanceof Error ? cleanupErr.message : 'unknown',
        });
      }
    }
    throw err;
  }
}

export { uploadBytes };
