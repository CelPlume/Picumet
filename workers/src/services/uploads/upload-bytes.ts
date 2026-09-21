// 兼容上传核心：路径模板渲染 + 边界校验 + 统一写入
// 供 /api/upload（compat）、Lsky V2 壳、AList shim 复用（P0-1/P0-2/P0-3 统一在此收口）。
import type { Context } from 'hono';
import type { Env } from '../../shared/types';
import { MountRepo, ProviderRepo } from '../../db';
import type { Db } from '../../db';
import { getDb } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { requirePermission } from '../permissions/principal';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import {
  normalizePath, isValidFileName, isPathWithinBoundary,
  renderPathTemplate, buildTemplateVars, validateFileType,
} from '../../utils/path';
import { uuid } from '../../utils/crypto';
import { upsertFileObject, buildFileAccessUrl } from '../files/write';

type Ctx = Parameters<typeof ok>[0];

export async function uploadBytes(
  c: Ctx,
  db: Db,
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
  // customPath：绝对路径按字面处理；相对路径（如嵌套文件名拆出的 '2024/06'）基于模板渲染结果解析
  const targetPath = customPath
    ? normalizePath(customPath.startsWith('/')
      ? `${customPath}/${fileName}`
      : `${rendered}/${customPath}/${fileName}`)
    : rendered === '/'
      ? `/${fileName}`
      : rendered.endsWith('/' + fileName)
        ? rendered
        : normalizePath(`${rendered}/${fileName}`);

  // M-3：customPath 与模板结果都不得越过密钥上传根
  if (!isPathWithinBoundary(targetPath, uploadRoot)) {
    throw new ApiError(403, 'FORBIDDEN', '上传目标超出密钥配置的上传根目录');
  }

  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '目标挂载点不存在');
  // M-3/H-3：最终路径再次通过统一权限服务（API Key 权限 ∩ 路径规则）
  await requirePermission(c, mount, targetPath, 'write');
  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  const provider = await getProvider(db, providerRow, c.env as Env);

  const result = await upsertFileObject(c, {
    mount,
    provider,
    pathPrefix: providerRow.pathPrefix,
    targetPath,
    mimeType,
    size,
    body,
    ownerId: userId,
    via: 'api',
  });

  // P0-1：返回外部可用的直链（provider 公网域名 → CDN；否则 path-serve + 签名）
  const url = await buildFileAccessUrl(c, provider, result.objectKey, targetPath);
  return ok(c, {
    url,
    fileId: result.fileId,
    path: targetPath,
    size: result.size,
    filename: fileName,
  });
}
