// 公开路径文件服务：{origin}{虚拟路径}（如 /drive/text/x.txt → 流式返回对象）
import { Hono } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import { FileRepo, MountRepo, ProviderRepo, SettingsRepo, LogRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { requestIp } from '../../utils/ip';
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
 * 扫描器噪声路径：`.env*` / `.git/*` / `.aws/*` / `*.bak` 等。
 *
 * 背景：公网扫描器会持续探测 `/.env`、`/.git/config`、`/config.php.bak`、`/.aws/credentials`。
 * path-serve 是 catch-all，这些请求原本全部落进 `loadRoutePrefixes` → `findMountForPath`
 * → `getFileAtPath` 的 **3 次 D1 查询**后才 404——扫描器量级下这既是纯粹的 D1 浪费，
 * 也会把正常直链的响应排队拖慢（表现为偶发 ERR_TIMED_OUT）。
 *
 * 这里的文件名规则本身就被上传校验挡住（`isValidFileName` 禁止以 `.` 开头、禁止 `:` 等），
 * 所以这些路径**永远不可能是合法文件**，直接在查库前拒绝，零 D1 开销。
 */
const SCANNER_SEGMENTS = new Set([
  '.git', '.svn', '.hg', '.env', '.aws', '.ssh', '.docker', '.vscode', '.idea',
  'wp-admin', 'wp-content', 'wp-login.php', 'phpmyadmin', 'adminer',
]);
const SCANNER_FILE_RE = /^(\.env|\.git|\.svn|\.hg|\.aws|\.ssh|\.docker|web\.config|appsettings|composer\.(json|lock)|package(-lock)?\.json|yarn\.lock|docker-compose|makefile|id_rsa|authorized_keys|\.htaccess|\.htpasswd|wp-config|configuration)\./i;
const SCANNER_SUFFIX_RE = /\.(bak|old|orig|save|swp|swo|dist|example|sample|tmp|temp|log|ini|sql|db|sqlite|key|pem|crt|p12|pfx|conf|config)$/i;

/** 路径是否命中扫描器噪声（任一段命中即拒） */
function isScannerNoise(path: string): boolean {
  const segs = path.split('/').filter(Boolean);
  for (const seg of segs) {
    if (SCANNER_SEGMENTS.has(seg.toLowerCase())) return true;
    // 以点开头的隐藏文件（.env / .gitignore / .npmrc）
    if (seg.startsWith('.')) return true;
    if (SCANNER_FILE_RE.test(seg)) return true;
    if (SCANNER_SUFFIX_RE.test(seg)) return true;
  }
  return false;
}

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
    path.split('/').includes('..') ||
    isScannerNoise(path)
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
    // 扫描器噪声（.env / .git / *.bak …）在任何 D1 查询之前直接 404：
    // 这些路径不可能是合法文件（上传侧 isValidFileName 已禁），零查库成本，
    // 避免公网扫描流量把正常直链的 D1 配额与延迟吃满。
    if (isScannerNoise(safeDecodePath(c.req.path))) {
      throw new ApiError(404, 'NOT_FOUND', '未找到');
    }
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

    // 公开挂载直接可读；私有挂载需登录且有读/下载权限，或持有该路径的有效签名（?sign=）
    const accessMode = urlProvider ? decideAccessMode(file, urlProvider, false) : 'private_gateway';
    // LAB F-07：签名与可见性分拆——public_cdn 只豁免「签名」这一层，不豁免可见性：
    // 非 public 文件即使落在公网域名 provider 上，匿名无签名访问也必须走同一道权限面。
    const sign = c.req.query('sign');
    const signOk = sign ? await verifyPathSign(virtualPath, (c.env as Env).ENCRYPTION_KEY, sign) : false;
    const publicCdnReadable = accessMode === 'public_cdn' && file.visibility === 'public';
    if (!signOk && !publicCdnReadable) {
      // §C：匿名读受站点游客开关约束（签名链接是显式能力凭证，不受此限）
      const userId = c.get('userId') as string | undefined;
      if (!userId && !(await SettingsRepo.getBool(db, 'allow_guest_access', false))) {
        throw new ApiError(401, 'LOGIN_REQUIRED', '站点未开放游客访问，请先登录');
      }
      // 此处 file.type 必为 'file'（上方已过滤）：permPath = 文件全路径
      const permPath = file.path === '/' ? `/${file.name}` : `${file.path}/${file.name}`;
      // §C：文件级 guest_visibility 随文件行传入（匿名访客按 none/download/view 合成规则放行）
      const allowed = await can(c, mount, permPath, 'download', file.ownerId, undefined, file.visibility, file.guestVisibility, file.providerId ?? undefined);
      if (!allowed) throw new ApiError(403, 'FORBIDDEN', '无权访问');
    }

    const isMedia = Boolean(file.mimeType?.startsWith('image/') || file.mimeType?.startsWith('video/'));
    const cacheControl = (signOk || publicCdnReadable || file.visibility === 'public')
      ? (isMedia ? 'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400' : 'public, max-age=86400, s-maxage=604800')
      : 'private, max-age=300';

    return await serveFileObject({
      db,
      env: c.env as Env,
      mount,
      ref: { fileId: file.id, mountId: file.mountId, providerId: file.providerId, physicalKey: physicalObjectKey(file), size: file.size, blobHash: file.blobHash },
      name: file.name,
      mimeType: file.mimeType,
      rangeHeader: c.req.header('range'),
      totalSize: file.size,
      cacheControl,
      // §31/§28 读回退补判：直链内容出口按 download 动作、以访问主体角色逐候选重判（匿名 = guest）
      principalRole: (c.get('userRole') as string) ?? 'guest',
      action: 'download',
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
      ipAddress: requestIp(c.req.raw),
      userAgent: c.req.header('user-agent'),
      statusCode: status,
    });
  } catch {
    // 追踪写入失败不覆盖主错误
  }
}
