// 路由辅助：构造 Principal、加载规则、统一权限校验
import type { Context } from 'hono';
import type { Principal, Mount, Permission, Conditions, PathRule, Visibility, GuestVisibility } from '@shared/types';
import { getDb } from '../../middleware/auth';
import { loadPrincipalRules, checkPermission, DEFAULT_ROLE_PERMISSIONS } from './check';
import { RoleDefaultsRepo } from '../../db/repos/role-defaults';
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

export function getConditions(c: Context): Conditions {
  return { ip: getClientIpSafe(c) };
}

function getClientIpSafe(c: Context): string {
  const cf = (c.req.raw as Request & { cf?: { connectingIp?: string } }).cf;
  if (cf?.connectingIp) return cf.connectingIp;
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return c.req.header('x-real-ip') ?? '127.0.0.1';
}

/**
 * 校验权限，失败抛出 403。
 * visibility：目标文件的可见性（§4.4a）——users/public 注入合成 allow 规则。
 * guestVisibility：目标文件的游客可见性（§C）——匿名访客按 none/download/view 注入合成 allow 规则。
 */
export async function requirePermission(
  c: Context,
  mount: Mount,
  path: string,
  action: Permission,
  fileOwnerId?: string,
  conditions?: Conditions,
  visibility?: Visibility,
  guestVisibility?: GuestVisibility | null
): Promise<void> {
  const principal = await getPrincipal(c);
  const rules = await getRules(c, mount.id);
  const result = checkPermission(principal, mount, path, action, rules, fileOwnerId, conditions, visibility, guestVisibility);
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
  guestVisibility?: GuestVisibility | null
): Promise<boolean> {
  try {
    await requirePermission(c, mount, path, action, fileOwnerId, conditions, visibility, guestVisibility);
    return true;
  } catch {
    return false;
  }
}
