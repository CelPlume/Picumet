// 路由辅助：构造 Principal、加载规则、统一权限校验
import type { Context } from 'hono';
import type { Principal, Mount, Permission, Conditions, PathRule } from '@shared/types';
import { getDb } from '../middleware/auth';
import { loadPrincipalRules, checkPermission } from './permission';
import { ApiError } from '../utils/errors';

export async function getPrincipal(c: Context): Promise<Principal> {
  const user = c.get('user');
  const apiKey = c.get('apiKey');
  if (apiKey) {
    return {
      type: 'apiKey',
      id: user.id,
      role: user.role,
      apiKeyId: apiKey.id,
      defaultPath: user.defaultPath,
      allowedPermissions: apiKey.permissions as Permission[],
    };
  }
  return {
    type: 'user',
    id: user.id,
    role: user.role,
    defaultPath: user.defaultPath,
  };
}

export async function getRules(c: Context): Promise<PathRule[]> {
  const db = getDb(c);
  const principal = await getPrincipal(c);
  return loadPrincipalRules(db, principal);
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
 * 校验权限，失败抛出 403
 */
export async function requirePermission(
  c: Context,
  mount: Mount,
  path: string,
  action: Permission,
  fileOwnerId?: string,
  conditions?: Conditions
): Promise<void> {
  const principal = await getPrincipal(c);
  const rules = await getRules(c);
  const result = checkPermission(principal, mount, path, action, rules, fileOwnerId, conditions);
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
  fileOwnerId?: string
): Promise<boolean> {
  try {
    await requirePermission(c, mount, path, action, fileOwnerId);
    return true;
  } catch {
    return false;
  }
}
