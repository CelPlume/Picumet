// 用户模型单测（§4.4）：origin 排序防越权 / visibility 合成规则 / 边界豁免 / 密码豁免 / 用户规则校验防线
import { describe, it, expect } from 'vitest';
import { checkPermission, sortRules, syntheticVisibilityRule, isPasswordExempt } from '../src/services/permissions/check';
import { validateUserRule, itemFullPath } from '../src/services/users/rule-guard';
import type { PathRule, Principal, Mount, Visibility } from '@shared/types';

function rule(overrides: Partial<PathRule>): PathRule {
  return {
    id: 'r',
    pathPattern: '/',
    effect: 'allow',
    permissions: ['read'],
    requirePassword: false,
    priority: 0,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const mount: Mount = {
  id: 'm1',
  mountPath: '/',
  name: 'root',
  providerId: 'p1',
  sortBy: 'name',
  sortOrder: 'asc',
  priority: 0,
  status: 'active',
  maxStorage: null,
  usedStorage: 0,
  quotaReserved: 0,
  createdAt: 0,
  poolStrategy: 'least_used',
  capacityBytes: null,
  uploadMode: 'free',
};

function user(id: string, defaultPath: string, capabilities: string[] = []): Principal {
  return { type: 'user', id, role: 'user', defaultPath, capabilities };
}

const adminRule = (overrides: Partial<PathRule>) => rule({ origin: 'admin', ...overrides });
const userRule = (overrides: Partial<PathRule>) => rule({ origin: 'user', ...overrides });

describe('sortRules origin 防越权排序', () => {
  it('admin role 级 deny 压过 user-origin 指定用户 allow（防提权）', () => {
    const adminDeny = adminRule({ id: 'a1', role: 'user', effect: 'deny', permissions: ['read'] });
    const userGrant = userRule({ id: 'u1', userId: 'bob', effect: 'allow', permissions: ['read'] });
    const sorted = sortRules([userGrant, adminDeny], '/a/file.png');
    expect(sorted[0].id).toBe('a1');
  });

  it('user-origin 指定用户 deny 压过 system 合成 allow（公开但禁止某人）', () => {
    const synthetic = syntheticVisibilityRule('/a/photos', 'users', 'm1', user('bob', '/'))!;
    const userDeny = userRule({ id: 'u1', userId: 'bob', effect: 'deny', permissions: ['read', 'download'] });
    const sorted = sortRules([synthetic, userDeny], '/a/photos');
    expect(sorted[0].id).toBe('u1');
  });

  it('同 origin 内保持既有排序：主体特异度 > 路径特异度 > priority > deny 优先', () => {
    const role = adminRule({ id: 'r1', role: 'user', pathPattern: '/' });
    const specific = adminRule({ id: 'r2', userId: 'bob', pathPattern: '/' });
    const sorted = sortRules([role, specific], '/a');
    expect(sorted[0].id).toBe('r2');
    const deny = adminRule({ id: 'd1', role: 'user', effect: 'deny' });
    const allow = adminRule({ id: 'a1', role: 'user', effect: 'allow' });
    expect(sortRules([allow, deny], '/a')[0].id).toBe('d1');
  });
});

describe('checkPermission visibility 合成规则', () => {
  const owner = user('alice', '/alice');
  const other = user('bob', '/bob');
  const targetPath = '/alice/photos';

  it('private：其他用户被根边界拦截（不豁免）', () => {
    const result = checkPermission(other, mount, targetPath, 'read', [], 'alice', undefined, 'private');
    expect(result).toBe('deny');
  });

  it('users：其他用户可 read/download（边界豁免 + 合成 allow）', () => {
    expect(checkPermission(other, mount, targetPath, 'read', [], 'alice', undefined, 'users')).toBe('allow');
    expect(checkPermission(other, mount, targetPath, 'download', [], 'alice', undefined, 'public')).toBe('allow');
  });

  it('写入类永不豁免：users 可见性不可写他人文件', () => {
    expect(checkPermission(other, mount, targetPath, 'write', [], 'alice', undefined, 'users')).toBe('deny');
    expect(checkPermission(other, mount, targetPath, 'delete', [], 'alice', undefined, 'public')).toBe('deny');
  });

  it('admin deny 压过 visibility 合成 allow', () => {
    const rules = [adminRule({ id: 'a1', role: 'user', effect: 'deny', permissions: ['read'] })];
    const result = checkPermission(other, mount, targetPath, 'read', rules, 'alice', undefined, 'users');
    expect(result).toBe('deny');
  });

  it('用户 deny 指定人压过 visibility（公开但禁止某人）', () => {
    const rules = [userRule({ id: 'u1', userId: 'bob', effect: 'deny', permissions: ['read', 'download'] })];
    // bob 的候选集含针对自己的 deny（findCandidates 按 subject 过滤）→ 拒绝
    expect(checkPermission(other, mount, targetPath, 'read', rules, 'alice', undefined, 'users')).toBe('deny');
    // carol 的候选集不含针对 bob 的规则 → 合成 allow 生效
    const carol = user('carol', '/carol');
    expect(checkPermission(carol, mount, targetPath, 'read', [], 'alice', undefined, 'users')).toBe('allow');
  });

  it('owner 不受 visibility 影响（自身路径始终全权）', () => {
    expect(checkPermission(owner, mount, targetPath, 'update', [], 'alice', undefined, 'private')).toBe('allow');
  });
});

describe('isPasswordExempt（§4.4c）', () => {
  it('admin 与 owner 豁免，其他用户不豁免', () => {
    const admin: Principal = { type: 'user', id: 'adm', role: 'admin', defaultPath: '/' };
    expect(isPasswordExempt(admin, 'alice')).toBe(true);
    expect(isPasswordExempt(user('alice', '/alice'), 'alice')).toBe(true);
    expect(isPasswordExempt(user('bob', '/bob'), 'alice')).toBe(false);
    expect(isPasswordExempt(user('alice', '/alice'), undefined)).toBe(false);
  });
});

describe('validateUserRule 越权防线', () => {
  const creator = { id: 'alice', defaultPath: '/alice', capabilities: ['can_grant'], isAdmin: false };
  const item = { mountId: 'm1', ownerId: 'alice', path: '/alice/photos', name: 'photos', type: 'folder' as const };
  const base: Parameters<typeof validateUserRule>[0] = {
    itemId: 'f1',
    effect: 'allow',
    allUsers: true,
    permissions: ['read'],
  };

  it('无 can_grant 能力位 → 403', () => {
    const result = validateUserRule(base, { ...creator, capabilities: [] }, item);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('admin 无需能力位', () => {
    const result = validateUserRule(base, { ...creator, isAdmin: true, capabilities: [] }, item);
    expect(result.ok).toBe(true);
  });

  it('写入类权限拒绝（权限白名单）', () => {
    const result = validateUserRule({ ...base, permissions: ['read', 'write'] }, creator, item);
    expect(result.ok).toBe(false);
  });

  it('目标主体必须二选一', () => {
    expect(validateUserRule({ ...base, allUsers: undefined, targetUserId: undefined }, creator, item).ok).toBe(false);
    expect(validateUserRule({ ...base, allUsers: true, targetUserId: 'bob' }, creator, item).ok).toBe(false);
  });

  it('他人文件拒绝（所有权防线）', () => {
    const result = validateUserRule(base, creator, { ...item, ownerId: 'mallory' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('defaultPath 之外拒绝（边界防线）', () => {
    const result = validateUserRule(base, creator, { ...item, path: '/other/path', name: 'x' });
    expect(result.ok).toBe(false);
  });

  it('合法输入归一化：role=user / priority=0 / origin=user / 精确路径', () => {
    const result = validateUserRule(base, creator, item);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized).toMatchObject({
        mountId: 'm1',
        pathPattern: '/alice/photos',
        role: 'user',
        permissions: ['read'],
        priority: 0,
        origin: 'user',
        createdBy: 'alice',
      });
    }
  });

  it('文件行 pattern 取全路径（path=父目录 + name）', () => {
    expect(itemFullPath({ path: '/alice/photos', name: 'a.png', type: 'file' })).toBe('/alice/photos/a.png');
    expect(itemFullPath({ path: '/alice/photos', name: 'photos', type: 'folder' })).toBe('/alice/photos');
  });
});
