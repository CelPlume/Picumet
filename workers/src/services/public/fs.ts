// 公开目录浏览（§C 游客）：GET /api/public/fs?path=/x
// 分级可见：匿名访客受站点 allow_guest_access 开关约束，逐项按权限引擎过滤
// （role='guest' 规则 / users·public 可见性合成规则 / 属主回退），并为可读文件附签名直链。
import { Hono } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import { FileRepo, MountRepo, ProviderRepo, SettingsRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { ApiError } from '../../shared/errors';
import { ok } from '../../shared/response';
import { normalizePath, safeDecodePath } from '../../utils/path';
import { getPrincipal } from '../permissions/principal';
import { checkPermission, loadPrincipalRules } from '../permissions/check';
import { getProvider } from '../storage/providers';
import { physicalObjectKey } from '../storage/keys';
import { loadRoutePrefixes } from '../storage/direct-links';
import { buildFileAccessUrl } from '../files/write';

export const publicFsRoutes = new Hono<AppBindings>();

/** 列表条目：仅暴露浏览所需字段（对象键、属主不外泄） */
interface PublicFsItem {
  name: string;
  type: 'file' | 'folder';
  path: string;
  size: number;
  updatedAt: number;
  hasPassword: boolean;
  /** 文件的可读直链（含 1 小时签名）；受密码保护或不可读时为 null */
  url: string | null;
}

const SIGN_TTL_MS = 60 * 60 * 1000;

publicFsRoutes.get('/fs', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId') as string | undefined;

  // 站点级游客开关：仅约束匿名请求；登录用户不受影响
  if (!userId && !(await SettingsRepo.getBool(db, 'allow_guest_access', false))) {
    throw new ApiError(401, 'LOGIN_REQUIRED', '站点未开放游客访问，请先登录');
  }

  const rawPath = c.req.query('path') ?? '/';
  const virtualPath = normalizePath(safeDecodePath(rawPath));
  if (virtualPath.split('/').includes('..')) throw new ApiError(400, 'VALIDATION_ERROR', '路径非法');

  const mount = await MountRepo.findMountForPath(db, virtualPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在或未挂载');

  const principal = await getPrincipal(c);
  const rules = await loadPrincipalRules(db, principal, mount.id);

  // 目录本身可读（目录行的读权限）；根目录对 guest 亦需显式规则授权。
  // 文件级游客可见性（§C）：目录行 guest_visibility='view' 时匿名访客可列目录（'download' 只给下载，不给列表）。
  const segs = virtualPath.split('/').filter(Boolean);
  const folderName = segs.pop();
  const folder = folderName ? await FileRepo.getFolderAtPath(db, mount.id, virtualPath, folderName) : null;
  const folderRead = checkPermission(
    principal,
    mount,
    virtualPath,
    'read',
    rules,
    undefined,
    undefined,
    undefined,
    folder?.guestVisibility
  );
  if (folderRead !== 'allow') {
    throw new ApiError(403, 'FORBIDDEN', '无权访问该目录');
  }

  const { rows } = await FileRepo.listChildren(db, mount.id, virtualPath, {
    sortBy: mount.sortBy,
    sortOrder: mount.sortOrder,
    limit: 500,
  });

  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  const provider = providerRow ? await getProvider(db, providerRow, c.env as Env) : null;
  const expiresAt = Date.now() + SIGN_TTL_MS;
  // 直链前缀一次读出，逐项复用（避免每个条目一次设置查询）
  const prefixes = await loadRoutePrefixes(db);

  const items: PublicFsItem[] = [];
  for (const row of rows) {
    const itemPath = row.type === 'folder' ? row.path : (row.path === '/' ? `/${row.name}` : `${row.path}/${row.name}`);
    // 逐项判定：文件夹需 read，文件需 download；visibility / guest_visibility 与属主回退在引擎内统一处理
    const decision = checkPermission(
      principal,
      mount,
      itemPath,
      row.type === 'folder' ? 'read' : 'download',
      rules,
      row.ownerId,
      undefined,
      row.visibility,
      row.guestVisibility
    );
    if (decision !== 'allow') continue;
    const locked = !!row.accessPassword;
    items.push({
      name: row.name,
      type: row.type === 'folder' ? 'folder' : 'file',
      path: itemPath,
      size: row.size,
      updatedAt: row.updatedAt || row.createdAt,
      hasPassword: locked,
      url:
        row.type === 'file' && provider && !locked
          ? await buildFileAccessUrl(c, provider, physicalObjectKey(row), itemPath, expiresAt, prefixes)
          : null,
    });
  }

  return ok(c, {
    path: virtualPath,
    mountPath: mount.mountPath,
    items,
  });
});
