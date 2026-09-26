// 公开目录浏览（§C 游客）：GET /api/public/fs?path=/x
// 分级可见：匿名访客受站点 allow_guest_access 开关约束，逐项按权限引擎过滤
// （role='guest' 规则 / users·public 可见性合成规则 / 属主回退 / §28 挂载点级默认角色权限矩阵），
// 并为可读文件附签名直链。
import { Hono } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import { FileRepo, MountRepo, ProviderRepo, SettingsRepo } from '../../db';
import type { FileMetadataRow } from '../../db/row';
import { getDb } from '../../middleware/auth';
import { ApiError } from '../../shared/errors';
import { ok } from '../../shared/response';
import { normalizePath, safeDecodePath } from '../../utils/path';
import { getPrincipal, getMountMatrix, getBucketMatrix } from '../permissions/principal';
import { checkPermission, loadPrincipalRules } from '../permissions/check';
import { getProvider } from '../storage/providers';
import { physicalObjectKey } from '../storage/keys';
import { loadRoutePrefixes } from '../storage/direct-links';
import { resolveVirtualListing } from '../storage/root-view';
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
  if (!mount) {
    // 合成根：无挂载点覆盖该路径、但其下存在挂载拓扑时，聚合虚拟目录项。
    // 逐挂载点的 read 门禁由 root-view 纯函数判定（规则/矩阵每请求只查一次）；
    // 全部不可读或非挂载祖先 → null，保持既有 404，不泄露挂载拓扑存在性。
    const virtual = await resolveVirtualListing(c, virtualPath);
    if (!virtual) throw new ApiError(404, 'NOT_FOUND', '路径不存在或未挂载');
    return ok(c, {
      path: virtualPath,
      mountPath: null,
      items: virtual.map((item) => ({
        name: item.name,
        type: 'folder',
        path: item.path,
        size: item.size,
        updatedAt: item.updatedAt,
        hasPassword: false,
        url: null,
      })),
    });
  }

  const principal = await getPrincipal(c);
  const rules = await loadPrincipalRules(db, principal, mount.id);
  // §28：挂载点矩阵按挂载点生效、与入口无关（匿名访客按 role='guest' 条目判定）；
  // 与本请求内 requirePermission 共用同一份每请求缓存，不产生额外往返。
  const mountMatrix = await getMountMatrix(c, mount.id);

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
    folder?.guestVisibility,
    mountMatrix
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
    // §26 违规封禁：列表与出口一致——封禁行不出现在公开目录（内容出口另有 assertNotBanned）
    if ((row as FileMetadataRow).banned) continue;
    const itemPath = row.type === 'folder' ? row.path : (row.path === '/' ? `/${row.name}` : `${row.path}/${row.name}`);
    // §31 桶级矩阵：文件按实际落桶判定（每请求按 (挂载点, 桶) 缓存，逐项不产生重复往返）；
    // 目录行无桶语义 → 不传落桶，与既有行为一致
    const itemProviderId = row.type === 'file' ? (row.providerId ?? undefined) : undefined;
    const itemBucketMatrix = itemProviderId ? await getBucketMatrix(c, mount.id, itemProviderId) : undefined;
    // 逐项判定：文件夹需 read，文件需 download；visibility / guest_visibility / §28 挂载点矩阵 /
    // §31 桶级矩阵与属主回退在引擎内统一处理
    const decision = checkPermission(
      principal,
      mount,
      itemPath,
      row.type === 'folder' ? 'read' : 'download',
      rules,
      row.ownerId,
      undefined,
      row.visibility,
      row.guestVisibility,
      mountMatrix,
      itemProviderId,
      itemBucketMatrix
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
