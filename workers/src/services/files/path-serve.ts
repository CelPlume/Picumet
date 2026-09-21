// 公开路径文件服务：{origin}{虚拟路径}（如 /drive/text/x.txt → 流式返回对象）
import { Hono } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import { FileRepo, MountRepo, ProviderRepo, SettingsRepo, LogRepo } from '../../db';
import { getDb, getClientIp } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { ApiError } from '../../shared/errors';
import { normalizePath, safeDecodePath } from '../../utils/path';
import { verifyPathSign } from '../../utils/crypto';
import { decideAccessMode } from '../shares/tokens';
import { ProviderError } from '../storage/errors';
import { serveFileObject } from '../storage/failover';
import { physicalObjectKey } from '../storage/keys';
import { can } from '../permissions/principal';
import { loadRoutePrefixes } from '../storage/direct-links';
import { assertNotBanned } from './ban';

export const pathPublicRoutes = new Hono<AppBindings>();

/**
 * path-serve 排除清单：保留路由命名空间与非法路径一律不当作虚拟路径直服（§ ROUTING_CN §1.6）。
 * 在剥离 directPrefix 之后判定，所以 `/d/api/x` 与 `/api/x` 同样被拒。
 */
function isExcludedFromDirectServe(path: string): boolean {
  return (
    path === '/' ||
    path.startsWith('/api/') ||
    path.startsWith('/webdav') ||
    path.startsWith('/s3') ||
    path.startsWith('/openlist') ||
    path.split('/').includes('..')
  );
}

/**
 * 请求路径 → 直服虚拟路径；不带前缀配置时虚拟路径就是站点根命名空间下的路径。
 * directPrefix 非空时只服务 `${directPrefix}/*`，前缀被剥掉后才是虚拟路径；其余返回 null（交给上层 404）。
 */
function resolveDirectVirtualPath(requestPath: string, directPrefix: string): string | null {
  const rest =
    directPrefix === ''
      ? requestPath
      : requestPath === directPrefix
        ? '/'
        : requestPath.startsWith(`${directPrefix}/`)
          ? requestPath.slice(directPrefix.length)
          : null;
  if (rest === null || isExcludedFromDirectServe(rest)) return null;
  return normalizePath(rest);
}

pathPublicRoutes.get('*', async (c) => {
  // 仅记录已挂载路径上的失败/异常（成功直链与未挂载 404 噪声不落库，控制 D1 写入放大）
  let mounted = false;
  try {
    const db = getDb(c);
    const prefixes = await loadRoutePrefixes(db);
    const virtualPath = resolveDirectVirtualPath(safeDecodePath(c.req.path), prefixes.directPrefix);
    if (virtualPath === null) {
      throw new ApiError(404, 'NOT_FOUND', '未找到');
    }

    const mount = await MountRepo.findMountForPath(db, virtualPath);
    if (!mount) throw new ApiError(404, 'NOT_FOUND', '路径不存在或未挂载');
    mounted = true;

    const segs = virtualPath.split('/').filter(Boolean);
    const name = segs.pop();
    if (!name) throw new ApiError(404, 'NOT_FOUND', '未找到');
    const parent = '/' + segs.join('/');

    const file = await FileRepo.getFileAtPath(db, mount.id, parent, name);
    if (!file || file.type !== 'file') throw new ApiError(404, 'NOT_FOUND', '文件不存在');
    // §26 违规封禁：公开/签名直链内容出口门禁（仅拦文件流，目录列举不在此路由）
    await assertNotBanned(db, [file.id]);
    if (file.accessPassword) throw new ApiError(403, 'PASSWORD_REQUIRED', '该文件受密码保护');

    // 直链公开判定用文件落桶 provider；真正的对象读取由 serveFileObject 做池内回退（§G）
    const urlProviderRow = await ProviderRepo.getProviderById(db, file.providerId ?? mount.providerId);
    const urlProvider = urlProviderRow ? await getProvider(db, urlProviderRow, c.env as Env) : null;

    // 公开挂载直接可读；私有挂载需登录且有读/下载权限，或持有该路径的有效签名（?sign=，P0-1）
    const accessMode = urlProvider ? decideAccessMode(file, urlProvider, false) : 'private_gateway';
    if (accessMode !== 'public_cdn') {
      const sign = c.req.query('sign');
      const signOk = sign ? await verifyPathSign(virtualPath, (c.env as Env).ENCRYPTION_KEY, sign) : false;
      if (!signOk) {
        // §C：匿名读受站点游客开关约束（签名链接是显式能力凭证，不受此限）
        const userId = c.get('userId') as string | undefined;
        if (!userId && !(await SettingsRepo.getBool(db, 'allow_guest_access', false))) {
          throw new ApiError(401, 'LOGIN_REQUIRED', '站点未开放游客访问，请先登录');
        }
        // 此处 file.type 必为 'file'（上方已过滤）：permPath = 文件全路径
        const permPath = file.path === '/' ? `/${file.name}` : `${file.path}/${file.name}`;
        // §C：文件级 guest_visibility 随文件行传入（匿名访客按 none/download/view 合成规则放行）
        const allowed = await can(c, mount, permPath, 'download', file.ownerId, undefined, file.visibility, file.guestVisibility);
        if (!allowed) throw new ApiError(403, 'FORBIDDEN', '无权访问');
      }
    }

    return await serveFileObject({
      db,
      env: c.env as Env,
      mount,
      ref: { fileId: file.id, mountId: file.mountId, providerId: file.providerId, physicalKey: physicalObjectKey(file), size: file.size },
      name: file.name,
      mimeType: file.mimeType,
      rangeHeader: c.req.header('range'),
      totalSize: file.size,
    });
  } catch (err) {
    if (mounted) await logServeFailure(c, err);
    throw err;
  }
});

/** 失败/异常追踪：动作 download_failed，含错误码、签名命中与对象层错误类别 */
async function logServeFailure(c: Parameters<typeof getDb>[0], err: unknown): Promise<void> {
  try {
    const db = getDb(c);
    const status = err instanceof ApiError ? err.statusCode : err instanceof ProviderError && err.kind === 'not-found' ? 404 : 502;
    const code = err instanceof ApiError ? err.code : err instanceof ProviderError ? `PROVIDER_${err.kind}` : 'INTERNAL';
    await LogRepo.create(db, {
      userId: c.get('userId') as string | undefined,
      action: 'download_failed',
      path: safeDecodePath(c.req.path),
      metadata: JSON.stringify({ code, method: c.req.method, sign: c.req.query('sign') !== undefined, range: c.req.header('range') ?? null }),
      ipAddress: getClientIp(c),
      userAgent: c.req.header('user-agent'),
      statusCode: status,
    });
  } catch {
    // 追踪写入失败不覆盖主错误
  }
}
