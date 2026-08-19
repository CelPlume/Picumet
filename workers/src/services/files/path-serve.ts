// 公开路径文件服务：{origin}{虚拟路径}（如 /drive/text/x.txt → 流式返回对象）
import { Hono } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import { FileRepo, MountRepo, ProviderRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { ApiError } from '../../shared/errors';
import { normalizePath } from '../../utils/path';
import { decideAccessMode, streamObject } from '../shares/tokens';
import { can } from '../permissions/principal';

export const pathPublicRoutes = new Hono<AppBindings>();

pathPublicRoutes.get('*', async (c) => {
  const db = getDb(c);
  const virtualPath = normalizePath(safeDecode(c.req.path));
  if (
    virtualPath === '/' ||
    virtualPath.startsWith('/api/') ||
    virtualPath.startsWith('/webdav') ||
    virtualPath.split('/').includes('..')
  ) {
    throw new ApiError(404, 'NOT_FOUND', '未找到');
  }

  const mount = await MountRepo.findMountForPath(db, virtualPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在或未挂载');

  const segs = virtualPath.split('/').filter(Boolean);
  const name = segs.pop();
  if (!name) throw new ApiError(404, 'NOT_FOUND', '未找到');
  const parent = '/' + segs.join('/');

  const file = await FileRepo.getFileAtPath(db, mount.id, parent, name);
  if (!file || file.type !== 'file') throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  if (file.accessPassword) throw new ApiError(403, 'PASSWORD_REQUIRED', '该文件受密码保护');

  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  const provider = await getProvider(db, providerRow, c.env as Env);

  // 公开挂载直接可读；私有挂载需登录且有读/下载权限
  const accessMode = decideAccessMode(file, provider, false);
  if (accessMode !== 'public_cdn') {
    const allowed = await can(c, mount, file.path, 'download', file.ownerId);
    if (!allowed) throw new ApiError(403, 'FORBIDDEN', '无权访问');
  }

  return streamObject(c, provider, file.objectKey, file.name, file.mimeType);
});

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
