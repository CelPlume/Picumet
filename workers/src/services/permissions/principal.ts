// 路由辅助：构造 Principal、加载规则、统一权限校验
import type { Context } from 'hono';
import type { Principal, Mount, Permission, Conditions, PathRule, Visibility } from '@shared/types';
import { getDb } from '../../middleware/auth';
import { loadPrincipalRules, checkPermission } from './check';
import { ApiError } from '../../shared/errors';

export async function getPrincipal(c: Context): Promise<Principal> {
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
    };
  }
  return {
    type: 'user',
    id: user.id,
    role: user.role,
    defaultPath: user.defaultPath,
    capabilities: user.capabilities,
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
 */
export async function requirePermission(
  c: Context,
  mount: Mount,
  path: string,
  action: Permission,
  fileOwnerId?: string,
  conditions?: Conditions,
  visibility?: Visibility
): Promise<void> {
  const principal = await getPrincipal(c);
  const rules = await getRules(c, mount.id);
  const result = checkPermission(principal, mount, path, action, rules, fileOwnerId, conditions, visibility);
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
  visibility?: Visibility
): Promise<boolean> {
  try {
    await requirePermission(c, mount, path, action, fileOwnerId, conditions, visibility);
    return true;
  } catch {
    return false;
  }
}
