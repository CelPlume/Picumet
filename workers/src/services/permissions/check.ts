// 权限判定服务：实现 docs/ARCHITECTURE_CN.md 的核心权限算法
import type {
  Principal,
  Mount,
  Permission,
  Conditions,
  PathRule,
  RuleEffect,
} from '@shared/types';
import { Db } from '../../db';
import { RuleRepo } from '../../db';
import { isPathWithinBoundary, normalizePath, pathMatches } from '../../utils/path';

export type PermissionResult = 'allow' | 'deny';

/**
 * 核心权限检查函数。
 * 判定顺序：
 * 1. 管理员特权（最高优先级，绕过所有检查）
 * 2. 挂载边界检查（安全边界，不可绕过）
 * 3. 用户根路径限制（安全边界，不可绕过）
 * 4. API密钥配置权限范围
 * 5. 收集匹配规则 → 排序 → 应用第一个
 * 6. 文件所有者回退
 * 7. 默认拒绝
 */
export function checkPermission(
  principal: Principal,
  mount: Mount,
  canonicalPath: string,
  action: Permission,
  allRules: PathRule[],
  fileOwnerId?: string,
  conditions?: Conditions
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
  if (principal.type === 'user' && principal.defaultPath !== '/') {
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
  }

  // 5. 收集并排序匹配规则
  const matching = allRules.filter((r) => r.status === 'active' && pathMatches(path, r.pathPattern));
  const sorted = sortRules(matching, path);

  // 6. 应用第一个匹配的规则
  for (const rule of sorted) {
    if (!rule.permissions.includes(action)) {
      continue;
    }
    // 条件检查
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

  // 8. 用户默认路径权限（默认权限矩阵：用户在自己的 defaultPath 内拥有全部默认权限）
  if (principal.type === 'user' && isPathWithinBoundary(path, principal.defaultPath)) {
    const defaultPerms: Permission[] = ['read', 'write', 'update', 'delete', 'share', 'download'];
    if (defaultPerms.includes(action)) {
      return 'allow';
    }
  }

  // 9. 默认拒绝（无匹配规则且非所有者）
  return 'deny';
}

/**
 * 规则排序：主体特异度 > 路径特异度 > 显式优先级 > effect（deny > allow）
 */
export function sortRules(rules: PathRule[], canonicalPath: string): PathRule[] {
  return [...rules].sort((a, b) => {
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
 * 加载某主体相关的全部候选规则。
 * mountId 可选：传入时只加载该挂载的规则 + 全局规则（审计 H-01 挂载隔离）。
 */
export async function loadPrincipalRules(db: Db, principal: Principal, mountId?: string): Promise<PathRule[]> {
  return RuleRepo.findCandidates(
    db,
    {
      id: principal.type === 'user' ? principal.id : undefined,
      role: principal.role,
      apiKeyId: principal.apiKeyId,
    },
    mountId
  );
}

/**
 * 移动操作的双重检查：源 delete + 目标 write
 */
export function checkMovePermission(
  principal: Principal,
  sourceMount: Mount,
  targetMount: Mount,
  sourcePath: string,
  targetPath: string,
  allRules: PathRule[],
  fileOwnerId?: string
): boolean {
  const canDeleteSource =
    checkPermission(principal, sourceMount, sourcePath, 'delete', allRules, fileOwnerId) === 'allow';
  const canWriteTarget =
    checkPermission(principal, targetMount, targetPath, 'write', allRules, fileOwnerId) === 'allow';
  return canDeleteSource && canWriteTarget;
}

/**
 * 密码保护检查：文件级 > 路径级
 */
export function checkPasswordProtection(
  fileAccessPassword: string | undefined,
  matchingRule?: PathRule
): { required: boolean; hash?: string } {
  if (fileAccessPassword) {
    return { required: true, hash: fileAccessPassword };
  }
  if (matchingRule?.requirePassword && matchingRule.passwordHash) {
    return { required: true, hash: matchingRule.passwordHash };
  }
  return { required: false };
}

export type { RuleEffect };
