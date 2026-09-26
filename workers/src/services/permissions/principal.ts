// 路由辅助：构造 Principal、加载规则、统一权限校验
import type { Context } from 'hono';
import type { Principal, Mount, Permission, Conditions, PathRule, Visibility, GuestVisibility } from '@shared/types';
import { getDb } from '../../middleware/auth';
import { loadPrincipalRules, checkPermission, bucketMatrixDecision, DEFAULT_ROLE_PERMISSIONS, type PermissionResult } from './check';
import { RoleDefaultsRepo } from '../../db/repos/role-defaults';
import { MountRolePermissionsRepo } from '../../db/repos/mount-role-permissions';
import { MountProviderRolePermissionsRepo } from '../../db/repos/mount-provider-role-permissions';
import { ApiError } from '../../shared/errors';

export async function getPrincipal(c: Context): Promise<Principal> {
  const db = getDb(c);
  const user = c.get('user');
  const apiKey = c.get('apiKey');
  if (apiKey) {
    return {
      type: 'apiKey',
      id: user.id,
      role: user.role,
      apiKeyId: apiKey.keyId,
      defaultPath: user.defaultPath,
      allowedPermissions: apiKey.permissions as Permission[],
      capabilities: user.capabilities,
      // 网关密钥沿用其用户个别设置/角色默认权限（§4.4 第 8 步）
      defaultPermissions: user.permissions ?? (await RoleDefaultsRepo.permissionsOf(db, user.role)),
    };
  }
  if (!user) {
    // 匿名访客主体（§C）：仅能命中 role='guest' 规则、public 可见性合成规则与**文件级 guest_visibility**
    // 合成规则（syntheticGuestRule）；defaultPermissions 只表达 guest 角色默认（仅 download），
    // 引擎第 8 步只对登录用户生效，故匿名访客不会因此获得任何访问能力。
    // 站点级 allow_guest_access 开关由浏览面（公开列表 / path-serve 匿名读）另行把关。
    return {
      type: 'guest',
      id: 'anonymous',
      role: 'guest',
      defaultPath: '/',
      capabilities: [],
      defaultPermissions: DEFAULT_ROLE_PERMISSIONS.guest,
    };
  }
  return {
    type: 'user',
    id: user.id,
    role: user.role,
    defaultPath: user.defaultPath,
    capabilities: user.capabilities,
    // §4.4 第 8 步：用户个别设置优先，其次角色默认（role_defaults.permissions），最后引擎常量
    defaultPermissions: user.permissions ?? (await RoleDefaultsRepo.permissionsOf(db, user.role)),
  };
}

export async function getRules(c: Context, mountId?: string): Promise<PathRule[]> {
  const db = getDb(c);
  const principal = await getPrincipal(c);
  return loadPrincipalRules(db, principal, mountId);
}

/**
 * 默认角色权限矩阵的**每请求缓存**（§28 挂载点级 / §31 桶级）：
 * 键为当前请求的 Hono Context（每请求一个对象，随请求结束被 GC 回收），
 * 值为 缓存键 → 查询 Promise 的记忆表——同一请求内同一 (挂载点[, 桶]) 只查一次库，
 * 并发调用（如树形遍历逐子挂载复核、逐文件按落桶复核）共享同一 Promise，不产生重复往返。
 * 缓存键：挂载点级 = mountId；桶级 = `${mountId}\0${providerId}`（桶 id 非空，无碰撞）。
 * 矩阵为空时也只是多这一条按主键的查询，判定行为不变。
 *
 * 导出给所有**直接调用 checkPermission 的入口**复用（如公开目录浏览 public/fs.ts）：
 * 矩阵语义按挂载点/桶生效、与入口无关，缓存也必须按请求共享同一份。
 */
const matrixCache = new WeakMap<Context, Map<string, Promise<Map<string, Permission[]>>>>();

function cachedMatrix(c: Context, key: string, load: () => Promise<Map<string, Permission[]>>): Promise<Map<string, Permission[]>> {
  let perRequest = matrixCache.get(c);
  if (!perRequest) {
    perRequest = new Map();
    matrixCache.set(c, perRequest);
  }
  const cached = perRequest.get(key);
  if (cached) return cached;
  const pending = load();
  perRequest.set(key, pending);
  return pending;
}

export function getMountMatrix(c: Context, mountId: string): Promise<Map<string, Permission[]>> {
  return cachedMatrix(c, mountId, () => MountRolePermissionsRepo.getMatrix(getDb(c), mountId));
}

/**
 * §28 挂载点级矩阵判定：与桶级 `bucketMatrixDecision` 同语义——条目存在时构成该挂载点内该角色的
 * **封闭集合**（动作在条目内 → allow，不在 → deny）；无条目（Map 缺该角色 / 未传矩阵）→ undefined（不介入）。
 * share 不参与矩阵（同 §28/§31），一律不介入。
 * 导出供读路径容灾候选过滤（storage/failover.ts，补齐读侧）与晚解析入口门禁复用。
 */
export function mountMatrixDecision(
  role: string,
  action: Permission,
  mountMatrix?: Map<string, Permission[]> | null
): PermissionResult | undefined {
  if (action === 'share') return undefined;
  const entry = mountMatrix?.get(role);
  if (!entry) return undefined;
  return entry.includes(action) ? 'allow' : 'deny';
}

/** §31 桶级矩阵（键含 providerId，与挂载点级互不覆盖） */
export function getBucketMatrix(
  c: Context,
  mountId: string,
  providerId: string
): Promise<Map<string, Permission[]>> {
  return cachedMatrix(c, `${mountId}\u0000${providerId}`, () =>
    MountProviderRolePermissionsRepo.getMatrix(getDb(c), mountId, providerId)
  );
}

/**
 * 校验权限，失败抛出 403。
 * visibility：目标文件的可见性（§4.4a）——users/public 注入合成 allow 规则。
 * guestVisibility：目标文件的游客可见性（§C）——匿名访客按 none/download/view 注入合成 allow 规则。
 * providerId：目标文件的**实际落桶**（§31）——传入时判定顺序为 桶级矩阵 → 挂载点级矩阵 → 角色默认；
 * 缺省（落桶未知/目录行）与既有行为完全一致。
 */
export async function requirePermission(
  c: Context,
  mount: Mount,
  path: string,
  action: Permission,
  fileOwnerId?: string,
  conditions?: Conditions,
  visibility?: Visibility,
  guestVisibility?: GuestVisibility | null,
  providerId?: string
): Promise<void> {
  const principal = await getPrincipal(c);
  const rules = await getRules(c, mount.id);
  // §28：挂载点级默认角色权限矩阵（每请求按 mountId 缓存，见 getMountMatrix）
  const mountMatrix = await getMountMatrix(c, mount.id);
  // §31：桶级矩阵（每请求按 (mountId, providerId) 缓存，见 getBucketMatrix）
  const bucketMatrix = providerId ? await getBucketMatrix(c, mount.id, providerId) : undefined;
  const result = checkPermission(
    principal,
    mount,
    path,
    action,
    rules,
    fileOwnerId,
    conditions,
    visibility,
    guestVisibility,
    mountMatrix,
    providerId,
    bucketMatrix
  );
  if (result !== 'allow') {
    throw new ApiError(403, 'FORBIDDEN', '无权执行此操作');
  }
}

/** 返回布尔结果（不抛错） */
export async function can(
  c: Context,
  mount: Mount,
  path: string,
  action: Permission,
  fileOwnerId?: string,
  conditions?: Conditions,
  visibility?: Visibility,
  guestVisibility?: GuestVisibility | null,
  providerId?: string
): Promise<boolean> {
  try {
    await requirePermission(c, mount, path, action, fileOwnerId, conditions, visibility, guestVisibility, providerId);
    return true;
  } catch {
    return false;
  }
}

/**
 * §31 桶级门禁（晚解析入口用）：桶级条目明确禁止该动作时抛 403，无条目/落桶未知 → 放行。
 *
 * 用于「权限初检先于文件行解析」的入口（WebDAV GET/HEAD/PROPFIND、下载网关的分享令牌流）：
 * 这些入口的初检不含落桶，无法走 requirePermission(providerId)；此处补上桶级这一层。
 * 与引擎第 7 步同源（bucketMatrixDecision），因此「桶级条目明确禁止」的语义两处一致。
 * 注意：桶级条目**放行**时不会放宽前面的层级判定（那些层已由初检或令牌签发时定论）。
 */
export async function assertBucketPermission(
  c: Context,
  mountId: string,
  providerId: string | null | undefined,
  action: Permission
): Promise<void> {
  if (!providerId) return;
  const bucketMatrix = await getBucketMatrix(c, mountId, providerId);
  // 无桶级条目（绝大多数部署）：不解析主体，与既有语义完全一致
  if (bucketMatrix.size === 0) return;
  const principal = await getPrincipal(c);
  if (bucketMatrixDecision(principal.role, action, bucketMatrix) === 'deny') {
    throw new ApiError(403, 'FORBIDDEN', '当前存储桶的角色权限不允许此操作');
  }
}

/**
 * §28 挂载点级门禁（晚解析入口用）：挂载点级条目明确禁止该动作时抛 403，无条目 → 放行（不介入）。
 *
 * 与 §31 `assertBucketPermission` 同形、互补，补在它之后（两层矩阵在「令牌晚解析」出口对齐）：
 * 用于「权限初检先于文件行解析」的入口（下载网关的分享令牌流、兼容读端点、分享预览）——
 * 这些入口的初检不含挂载点级矩阵，或令牌签发时的判定无法覆盖消费主体。
 * 与引擎第 8 步同源（mountMatrixDecision），因此「条目明确禁止」的语义两处一致。
 */
export async function assertMountMatrixPermission(c: Context, mountId: string, action: Permission): Promise<void> {
  const mountMatrix = await getMountMatrix(c, mountId);
  // 无挂载点级条目（绝大多数部署）：不解析主体，与既有语义完全一致
  if (mountMatrix.size === 0) return;
  const principal = await getPrincipal(c);
  if (mountMatrixDecision(principal.role, action, mountMatrix) === 'deny') {
    throw new ApiError(403, 'FORBIDDEN', '当前挂载点的角色权限不允许此操作');
  }
}
