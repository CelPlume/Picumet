// 权限判定服务：实现 docs/ARCHITECTURE_CN.md 的核心权限算法
import type {
  Principal,
  Mount,
  Permission,
  Conditions,
  PathRule,
  RuleEffect,
  Visibility,
  GuestVisibility,
} from '@shared/types';
import { DEFAULT_ROLE_PERMISSIONS } from '@shared/types';
import { Db } from '../../db';
import { RuleRepo } from '../../db';
import { RoleDefaultsRepo } from '../../db/repos/role-defaults';
import { isPathWithinBoundary, normalizePath, pathMatches } from '../../utils/path';

export type PermissionResult = 'allow' | 'deny';

// 角色默认权限兜底表定义在 shared/types.ts（db 层读 role_defaults 时同样需要），此处转出以保持引擎侧单一入口
export { DEFAULT_ROLE_PERMISSIONS };

/**
 * 核心权限检查函数。
 * 判定顺序：
 * 1. 管理员特权（最高优先级，绕过所有检查）
 * 2. 挂载边界检查（安全边界，不可绕过）
 * 3. 用户根路径限制（安全边界，不可绕过）
 * 4. API密钥配置权限范围
 * 5. 收集匹配规则 → 排序 → 应用第一个
 * 6. 文件所有者回退
 * 7. 桶级默认角色权限矩阵（§31，封闭集合；仅在本步之前的路径规则/属主均未命中时生效）
 * 8. 挂载点级默认角色权限矩阵（§28，封闭集合，比桶级更泛）
 * 9. 用户默认路径权限（角色默认权限矩阵）
 * 10. 默认拒绝
 *
 * mountMatrix：挂载点级默认角色权限矩阵（§28，role → 权限词表）。由调用方（principal.ts）
 * 按请求缓存后传入——引擎内部**不查库**，避免把 DB 调用带进每请求热路径。
 * providerId / bucketMatrix：桶级默认角色权限矩阵（§31，限定到「文件实际落桶」的 provider）。
 * 落桶已知时由调用方传入（读/改/删/下载/分享按文件行 provider_id，写路径按候选成员），
 * 判定顺序为 桶级 → 挂载点级 → 角色默认；**未传 providerId 时与既有行为完全一致**。
 */
export function checkPermission(
  principal: Principal,
  mount: Mount,
  canonicalPath: string,
  action: Permission,
  allRules: PathRule[],
  fileOwnerId?: string,
  conditions?: Conditions,
  visibility?: Visibility,
  guestVisibility?: GuestVisibility | null,
  mountMatrix?: Map<string, Permission[]>,
  providerId?: string,
  bucketMatrix?: Map<string, Permission[]>
): PermissionResult {
  const path = normalizePath(canonicalPath);

  // 1. 管理员特权
  if (principal.role === 'admin') {
    return 'allow';
  }

  // 2. 挂载边界检查
  if (!isPathWithinBoundary(path, mount.mountPath)) {
    return 'deny';
  }

  // 3. 用户根路径限制
  // §4.4a：users/public 可见性对 read/download 豁免根边界（owner 主动授权的例外）；
  // 写入类操作永不豁免；deny 规则仍在本步之后的规则排序中正常压制（admin/user origin > system）。
  const visibilityAllowsRead =
    (visibility === 'users' || visibility === 'public') &&
    (action === 'read' || action === 'download');
  if (principal.type === 'user' && principal.defaultPath !== '/' && !visibilityAllowsRead) {
    const userRoot = normalizePath(principal.defaultPath);
    if (!isPathWithinBoundary(path, userRoot)) {
      return 'deny';
    }
  }

  // 4. API密钥配置权限范围
  if (principal.type === 'apiKey') {
    const allowed = principal.allowedPermissions ?? [];
    if (!allowed.includes(action)) {
      return 'deny';
    }
    // 网关密钥数据层所有者隔离：密钥只能触达属主自己的文件行，
    // 即使路径规则被误配为 /** 也无法越权到其他用户的数据。
    if (fileOwnerId !== undefined && fileOwnerId !== principal.id) {
      return 'deny';
    }
  }

  // 5. 收集并排序匹配规则（visibility / 文件级游客可见性的合成规则并入候选集，§4.4a、§C）
  const synthetic = syntheticVisibilityRule(path, visibility, mount.id, principal);
  const guestSynthetic = syntheticGuestRule(path, guestVisibility, mount.id, principal);
  const candidates = [...allRules, ...(synthetic ? [synthetic] : []), ...(guestSynthetic ? [guestSynthetic] : [])];
  const matching = candidates.filter((r) => r.status === 'active' && pathMatches(path, r.pathPattern));
  const sorted = sortRules(matching, path);

  // 6. 应用第一个匹配的规则
  for (const rule of sorted) {
    if (!rule.permissions.includes(action)) {
      continue;
    }
    // 条件检查：规则创建面已收紧（RuleSchema 不再接受 requirePassword/allowedIps），
    // 但存量库行可能仍带这些字段——本判定不传 conditions 一律 fail-closed（deny，不放宽），
    // 显式条件传入方可放行。目前唯一生产传入方是文件密码验证流程（verify-password 传 { ip, passwordVerified: true }）。
    if (rule.requirePassword && !conditions?.passwordVerified) {
      return 'deny';
    }
    if (rule.allowedIps?.length) {
      if (!conditions?.ip) return 'deny';
      if (!rule.allowedIps.includes(conditions.ip)) return 'deny';
    }
    return rule.effect;
  }

  // 7. 文件所有者回退
  if (principal.type === 'user' && fileOwnerId && fileOwnerId === principal.id) {
    const ownerPerms: Permission[] = ['read', 'update', 'delete', 'share', 'download'];
    if (ownerPerms.includes(action)) {
      return 'allow';
    }
  }

  // 7. 桶级默认角色权限矩阵（§31，比挂载点级更具体，封闭集合）：
  //    该 (挂载点, 文件实际落桶 provider, 角色) 有条目时——已走到这里说明无显式 path_rules 命中（第 6 步）、
  //    且非文件属主（第 7 步）——动作在条目内 → allow，不在条目内 → deny（封闭集合，兜底层不放宽）。
  //    无条目（Map 缺该角色 / 调用方未传落桶）→ 不介入，继续下一层，存量挂载点行为零变化。
  const bucketDecision = providerId ? bucketMatrixDecision(principal.role, action, bucketMatrix) : undefined;
  if (bucketDecision) {
    return bucketDecision;
  }

  // 8. 挂载点级默认角色权限矩阵（§28，封闭集合）：
  //    该 (挂载点, 角色) 有条目时——已走到这里说明无显式 path_rules 命中（第 6 步）、且非文件属主（第 7 步）——
  //    动作在条目内 → allow，不在条目内 → deny（矩阵是封闭集合，兜底层不放宽）。
  //    share 不参与矩阵（分享开关是能力位 can_share，§4.4 防线 5），出现 share 时整层跳过，交第 10 步既有语义。
  //    无条目（Map 缺该角色 / 调用方未传矩阵）→ 不介入，继续第 10 步，存量挂载点行为零变化。
  const matrixEntry = action === 'share' ? undefined : mountMatrix?.get(principal.role);
  if (matrixEntry) {
    return matrixEntry.includes(action) ? 'allow' : 'deny';
  }

  // 9. 用户默认路径权限（角色默认权限矩阵：user.permissions ?? role_defaults.permissions，缺省用兜底常量）
  // share 不在矩阵内（分享开关是能力位 can_share，§4.4 防线 5），默认路径内保持既有放行语义。
  if (principal.type === 'user' && isPathWithinBoundary(path, principal.defaultPath)) {
    const defaultPerms =
      principal.defaultPermissions ?? DEFAULT_ROLE_PERMISSIONS[principal.role] ?? DEFAULT_ROLE_PERMISSIONS.user;
    if (action === 'share' || defaultPerms.includes(action)) {
      return 'allow';
    }
  }

  // 10. 默认拒绝（无匹配规则且非所有者）
  return 'deny';
}

/**
 * 桶级矩阵判定（§31）：桶级条目存在时构成该桶内该角色的**封闭集合**——
 * 动作在条目内 → allow，不在条目内 → deny；无条目（Map 缺该角色 / 未传矩阵）→ undefined（不介入，回落下一层）。
 * share 不参与矩阵（同 §28），一律不介入。
 * 导出供两处复用：权限引擎第 7 步，以及写路径候选桶过滤（storage/pool.ts）与晚解析入口的桶级门禁
 * （principal.ts）——保证「哪些候选桶被跳过」与引擎判定同源。
 */
export function bucketMatrixDecision(
  role: string,
  action: Permission,
  bucketMatrix?: Map<string, Permission[]> | null
): PermissionResult | undefined {
  if (action === 'share') return undefined;
  const entry = bucketMatrix?.get(role);
  if (!entry) return undefined;
  return entry.includes(action) ? 'allow' : 'deny';
}

/**
 * 规则排序（§4.4 排序修订）：
 * origin（admin > user > system）> 主体特异度 > 路径特异度 > 显式优先级 > effect（deny > allow）
 *
 * origin 必须最先：user-origin「指定用户 allow」（主体特异度 3）若排在 admin「role 级 deny」
 * （主体特异度 1）之前即构成越权提权——管理员规则必须恒压用户规则；
 * 「公开但禁止某人」由 user-origin deny（origin user）压 system 合成 allow（origin system）成立。
 */
export function sortRules(rules: PathRule[], canonicalPath: string): PathRule[] {
  const originScore = (rule: PathRule): number =>
    rule.origin === 'user' ? 2 : rule.origin === 'system' ? 1 : 3;
  return [...rules].sort((a, b) => {
    // 5.0 规则来源（admin > user > system）
    const originDiff = originScore(b) - originScore(a);
    if (originDiff !== 0) return originDiff;

    // 5.1 主体特异度（user > apiKey > role）
    const subjectScore = (rule: PathRule): number => {
      if (rule.userId) return 3;
      if (rule.apiKeyId) return 2;
      return 1;
    };
    const subjectDiff = subjectScore(b) - subjectScore(a);
    if (subjectDiff !== 0) return subjectDiff;

    // 5.2 路径特异度（精确匹配 > 深层路径 > 浅层路径）
    const pathScore = (rule: PathRule): number => {
      if (rule.pathPattern === canonicalPath) return 1000;
      return rule.pathPattern.split('/').length;
    };
    const pathDiff = pathScore(b) - pathScore(a);
    if (pathDiff !== 0) return pathDiff;

    // 5.3 显式优先级
    const priorityDiff = (b.priority || 0) - (a.priority || 0);
    if (priorityDiff !== 0) return priorityDiff;

    // 5.4 effect（deny > allow）
    if (a.effect === 'deny' && b.effect === 'allow') return -1;
    if (a.effect === 'allow' && b.effect === 'deny') return 1;

    return 0;
  });
}

/**
 * visibility 合成规则（§4.4a）：users/public 可见性注入 read/download allow 规则
 * （origin=system，仅内存存在不入库）。
 * 主体感知（§C 游客）：users 仅对登录主体生效；public 对所有人（含匿名访客）生效。
 * public 的匿名面另由 gallery 路由独立处理（§4.2 权限交互）。
 * pattern 与调用方传入的 canonicalPath 同基准（文件走父目录约定），故为精确匹配。
 */
export function syntheticVisibilityRule(
  canonicalPath: string,
  visibility: Visibility | undefined,
  mountId: string,
  principal: Principal
): PathRule | null {
  if (visibility !== 'users' && visibility !== 'public') return null;
  const loggedIn = principal.type === 'user' || principal.type === 'apiKey';
  if (visibility === 'users' && !loggedIn) return null;
  return {
    id: '__synthetic_visibility__',
    mountId,
    pathPattern: normalizePath(canonicalPath),
    effect: 'allow',
    role: principal.role,
    permissions: ['read', 'download'],
    requirePassword: false,
    priority: 0,
    origin: 'system',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * 文件级游客可见性合成规则（§C）：**仅匿名访客**（principal.type === 'guest'）生效，注入 read/download allow。
 * 有效值直接取目标文件（或目录）的 guest_visibility —— NULL 不额外开放（保持既有语义：
 * 站点 allow_guest_access 总闸 + role='guest' 规则 / users·public 可见性合成规则）：
 *   'none'     → 不返回规则（落默认拒绝）；
 *   'download' → 允许 download；
 *   'view'     → 允许 read 与 download。
 * 站点级 allow_guest_access 开关由调用方（公开列表 / path-serve 匿名读）另行把关。
 */
export function syntheticGuestRule(
  canonicalPath: string,
  guestVisibility: GuestVisibility | null | undefined,
  mountId: string,
  principal: Principal
): PathRule | null {
  if (principal.type !== 'guest') return null;
  if (guestVisibility !== 'download' && guestVisibility !== 'view') return null;
  return {
    id: '__synthetic_guest__',
    mountId,
    pathPattern: normalizePath(canonicalPath),
    effect: 'allow',
    role: principal.role,
    permissions: guestVisibility === 'view' ? ['read', 'download'] : ['download'],
    requirePassword: false,
    priority: 0,
    origin: 'system',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * 密码门禁豁免（§4.4c）：管理员不受限；owner 本人跳过。
 * 其余主体访问带密码文件必须先验证密码。
 */
export function isPasswordExempt(principal: Principal, fileOwnerId?: string): boolean {
  if (principal.role === 'admin') return true;
  return principal.type === 'user' && !!fileOwnerId && fileOwnerId === principal.id;
}

/**
 * 加载某主体相关的全部候选规则。
 * mountId 可选：传入时只加载该挂载的规则 + 全局规则（挂载隔离）。
 * 规则主体支持角色别名：path_rules.role 写 role_defaults.alias（角色显示别名）时，
 * 命中该别名即视为写给该角色的规则（别名唯一性不做强约束，取到的别名全部并入候选集）。
 */
export async function loadPrincipalRules(db: Db, principal: Principal, mountId?: string): Promise<PathRule[]> {
  const aliases = await RoleDefaultsRepo.aliasesOf(db, principal.role);
  return RuleRepo.findCandidates(
    db,
    {
      id: principal.type === 'user' ? principal.id : undefined,
      roles: [principal.role, ...aliases],
      apiKeyId: principal.apiKeyId,
    },
    mountId
  );
}

// MOVE 的双重检查（源 delete + 目标 write）不走本引擎的简化包装——它不接收两级矩阵与落桶，
// 会让挂载点级/桶级矩阵对移动入口整体失效。改由 move.ts 直接调用 principal.ts 的
// requirePermission 两次（各自携带完整矩阵上下文，并按请求缓存），与其它入口同源。

export type { RuleEffect };
