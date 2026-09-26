// 权限判定算法测试：覆盖权限排序真值表（主体特异度 > 路径特异度 > 显式优先级 > effect）
import { describe, it, expect } from 'vitest';
import {
  checkPermission,
} from '../src/services/permissions/check';
import {
  isPathWithinBoundary,
  normalizePath,
  pathMatches,
  matchPriority,
  PathError,
} from '../src/utils/path';
import type { Principal, Mount, PathRule } from '@shared/types';

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

function userPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'u1',
    role: 'user',
    defaultPath: '/',
    ...overrides,
  };
}

function rule(overrides: Partial<PathRule>): PathRule {
  return {
    id: 'r1',
    pathPattern: '/**',
    effect: 'allow',
    permissions: ['read', 'write', 'update', 'delete', 'share', 'download'],
    requirePassword: false,
    priority: 0,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('isPathWithinBoundary（路径段边界）', () => {
  it('根路径包含所有', () => {
    expect(isPathWithinBoundary('/users/alice/file.txt', '/')).toBe(true);
    expect(isPathWithinBoundary('/anything', '/')).toBe(true);
  });
  it('完全相等返回 true', () => {
    expect(isPathWithinBoundary('/users/alice', '/users/alice')).toBe(true);
  });
  it('/users/alice 不能访问 /users/alice2', () => {
    expect(isPathWithinBoundary('/users/alice2/file.txt', '/users/alice')).toBe(false);
    expect(isPathWithinBoundary('/users/alice2', '/users/alice')).toBe(false);
  });
  it('/users/alice 能访问 /users/alice/file.txt', () => {
    expect(isPathWithinBoundary('/users/alice/file.txt', '/users/alice')).toBe(true);
  });
  it('边界本身路径不存在时拒绝', () => {
    expect(isPathWithinBoundary('/alice2', '/alice')).toBe(false);
  });
});

describe('normalizePath（路径规范化）', () => {
  it('移除多余斜杠', () => {
    expect(normalizePath('//a///b')).toBe('/a/b');
  });
  it('移除尾部斜杠', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b');
  });
  it('拒绝任何 .. 相对路径（安全优先）', () => {
    expect(() => normalizePath('/a/b/../c')).toThrow(PathError);
  });
  it('拒绝 .. 逃逸', () => {
    expect(() => normalizePath('../../etc/passwd')).toThrow(PathError);
    expect(() => normalizePath('/users/../..')).toThrow(PathError);
  });
  it('拒绝 ~', () => {
    expect(() => normalizePath('~/secrets')).toThrow(PathError);
  });
  it('拒绝双重编码中的 ..', () => {
    expect(() => normalizePath('%2e%2e%2f%2e%2e%2f')).toThrow(PathError);
  });
  it('空路径返回 /', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/')).toBe('/');
  });
});

describe('pathMatches（路径模式匹配）', () => {
  it('精确匹配', () => {
    expect(pathMatches('/images/a.jpg', '/images/a.jpg')).toBe(true);
  });
  it('单星通配符匹配同层', () => {
    expect(pathMatches('/images/a.jpg', '/images/*')).toBe(true);
    expect(pathMatches('/images/a/b.jpg', '/images/*')).toBe(false);
    expect(pathMatches('/images', '/images/*')).toBe(true);
  });
  it('双星通配符递归匹配', () => {
    expect(pathMatches('/images/a/b/c.jpg', '/images/**')).toBe(true);
    expect(pathMatches('/images/a.jpg', '/images/**')).toBe(true);
    expect(pathMatches('/other', '/images/**')).toBe(false);
  });
  it('matchPriority：精确 > 变量 > 单星 > 双星', () => {
    expect(matchPriority('/exact/path')).toBeGreaterThan(matchPriority('/users/:id/*'));
    expect(matchPriority('/users/:id/*')).toBeGreaterThan(matchPriority('/images/*'));
    expect(matchPriority('/images/*')).toBeGreaterThan(matchPriority('/images/**'));
  });
});

describe('场景1：用户规则 vs 角色规则（主体特异度）', () => {
  const alice = userPrincipal({ id: 'alice', defaultPath: '/users/alice' });
  const userRule = (effect: 'allow' | 'deny') => rule({ id: 'ur', userId: 'alice', pathPattern: '/users/alice/**', effect });
  const roleRule = (effect: 'allow' | 'deny') => rule({ id: 'rr', role: 'user', pathPattern: '/users/alice/**', effect });
  const path = '/users/alice/file.txt';

  it('用户 allow + 角色 allow → allow', () => {
    expect(checkPermission(alice, mount, path, 'read', [userRule('allow'), roleRule('allow')])).toBe('allow');
  });
  it('用户 allow + 角色 deny → allow（用户特异度高）', () => {
    expect(checkPermission(alice, mount, path, 'read', [userRule('allow'), roleRule('deny')])).toBe('allow');
  });
  it('用户 deny + 角色 allow → deny（用户特异度高）', () => {
    expect(checkPermission(alice, mount, path, 'read', [userRule('deny'), roleRule('allow')])).toBe('deny');
  });
  it('用户 deny + 角色 deny → deny', () => {
    expect(checkPermission(alice, mount, path, 'read', [userRule('deny'), roleRule('deny')])).toBe('deny');
  });
  it('仅角色 allow → allow', () => {
    expect(checkPermission(alice, mount, path, 'read', [roleRule('allow')])).toBe('allow');
  });
  it('仅角色 deny → deny', () => {
    expect(checkPermission(alice, mount, path, 'read', [roleRule('deny')])).toBe('deny');
  });
  it('仅用户 allow → allow', () => {
    expect(checkPermission(alice, mount, path, 'read', [userRule('allow')])).toBe('allow');
  });
  it('仅用户 deny → deny', () => {
    expect(checkPermission(alice, mount, path, 'read', [userRule('deny')])).toBe('deny');
  });
});

describe('场景2：路径继承（路径特异度）', () => {
  const alice = userPrincipal({ id: 'alice', defaultPath: '/' });
  const parent = (effect: 'allow' | 'deny') => rule({ id: 'pr', role: 'user', pathPattern: '/images', effect });
  const childDeny = rule({ id: 'cd', role: 'user', pathPattern: '/images/private', effect: 'deny' });
  const childAllow = rule({ id: 'ca', role: 'user', pathPattern: '/images/public', effect: 'allow' });

  it('父 allow → 继承 allow', () => {
    expect(checkPermission(alice, mount, '/images/a.jpg', 'read', [parent('allow')])).toBe('allow');
  });
  it('父 deny → 继承 deny', () => {
    expect(checkPermission(alice, mount, '/images/a.jpg', 'read', [parent('deny')])).toBe('deny');
  });
  it('父 allow + 子 deny → 子路径特异度高，deny', () => {
    expect(checkPermission(alice, mount, '/images/private/f.txt', 'read', [parent('allow'), childDeny])).toBe('deny');
  });
  it('父 deny + 子 allow → 子路径特异度高，allow', () => {
    expect(checkPermission(alice, mount, '/images/public/f.txt', 'read', [parent('deny'), childAllow])).toBe('allow');
  });
  it('递归通配 vs 精确路径 → 精确优先', () => {
    const wild = rule({ id: 'w', role: 'user', pathPattern: '/images/**', effect: 'allow' });
    const exact = rule({ id: 'e', role: 'user', pathPattern: '/images/a/b.jpg', effect: 'deny' });
    expect(checkPermission(alice, mount, '/images/a/b.jpg', 'read', [wild, exact])).toBe('deny');
  });
});

describe('场景3：同主体同路径不同 effect（effect 优先级）', () => {
  const alice = userPrincipal({ id: 'alice', defaultPath: '/users/alice' });
  const p = '/users/alice/x.txt';
  it('deny(0) vs allow(0) → deny（deny 优先）', () => {
    expect(
      checkPermission(alice, mount, p, 'read', [
        rule({ id: 'a', role: 'user', pathPattern: p, effect: 'deny', priority: 0 }),
        rule({ id: 'b', role: 'user', pathPattern: p, effect: 'allow', priority: 0 }),
      ])
    ).toBe('deny');
  });
  it('allow(5) vs deny(3) → allow（显式优先级高优先）', () => {
    expect(
      checkPermission(alice, mount, p, 'read', [
        rule({ id: 'a', role: 'user', pathPattern: p, effect: 'allow', priority: 5 }),
        rule({ id: 'b', role: 'user', pathPattern: p, effect: 'deny', priority: 3 }),
      ])
    ).toBe('allow');
  });
});

describe('场景5：API 密钥作为 Principal（权限交集）', () => {
  const apiKeyPrincipal = (permissions: string[]): Principal => ({
    type: 'apiKey',
    id: 'key-user',
    role: 'user',
    apiKeyId: 'key1',
    defaultPath: '/',
    allowedPermissions: permissions as Principal['allowedPermissions'],
  });
  const allowAll = rule({ id: 'r', role: 'user', pathPattern: '/uploads/**', effect: 'allow', permissions: ['write', 'read'] });
  const denyWrite = rule({ id: 'd', role: 'user', pathPattern: '/uploads/**', effect: 'deny', permissions: ['write'] });

  it("密钥 ['write','read'] + 路径 allow:[write,read] write → allow", () => {
    expect(checkPermission(apiKeyPrincipal(['write', 'read']), mount, '/uploads/a.png', 'write', [allowAll])).toBe('allow');
  });
  it("密钥 ['write'] + 路径 allow:[write,read] write → allow", () => {
    expect(checkPermission(apiKeyPrincipal(['write']), mount, '/uploads/a.png', 'write', [allowAll])).toBe('allow');
  });
  it("密钥 ['write'] + 路径 allow:[write,read] read → deny（密钥未配置 read）", () => {
    expect(checkPermission(apiKeyPrincipal(['write']), mount, '/uploads/a.png', 'read', [allowAll])).toBe('deny');
  });
  it("密钥 ['write','read'] + 路径 allow:[write] read → deny（路径规则未授予 read）", () => {
    const allowWrite = rule({ id: 'r2', role: 'user', pathPattern: '/uploads/**', effect: 'allow', permissions: ['write'] });
    expect(checkPermission(apiKeyPrincipal(['write', 'read']), mount, '/uploads/a.png', 'read', [allowWrite])).toBe('deny');
  });
  it("密钥 ['write'] + 路径 deny:[write] write → deny（显式拒绝）", () => {
    expect(checkPermission(apiKeyPrincipal(['write']), mount, '/uploads/a.png', 'write', [denyWrite])).toBe('deny');
  });
  it('无匹配规则 → 默认拒绝', () => {
    expect(checkPermission(apiKeyPrincipal(['write']), mount, '/uploads/a.png', 'write', [])).toBe('deny');
  });
});

describe('管理员特权', () => {
  it('admin 绕过所有检查', () => {
    const admin = userPrincipal({ id: 'a1', role: 'admin' });
    expect(checkPermission(admin, mount, '/users/bob/private.txt', 'delete', [])).toBe('allow');
    expect(checkPermission(admin, mount, '/anything', 'admin', [])).toBe('allow');
  });
});

describe('用户根路径限制', () => {
  it('defaultPath=/users/user123 不能访问 /private', () => {
    const u = userPrincipal({ id: 'user123', defaultPath: '/users/user123' });
    expect(checkPermission(u, mount, '/private/data.pdf', 'download', [])).toBe('deny');
  });
  it('defaultPath=/users/user123 可访问 /users/user123/a.txt', () => {
    const u = userPrincipal({ id: 'user123', defaultPath: '/users/user123' });
    expect(checkPermission(u, mount, '/users/user123/a.txt', 'read', [])).toBe('allow');
  });
  it('/users/alice 不能越界访问 /users/alice2', () => {
    const u = userPrincipal({ id: 'alice', defaultPath: '/users/alice' });
    expect(checkPermission(u, mount, '/users/alice2/file.txt', 'read', [])).toBe('deny');
  });
});

describe('挂载边界检查', () => {
  it('路径在挂载外 → deny（不可绕过）', () => {
    const m: Mount = { ...mount, mountPath: '/images' };
    expect(checkPermission(userPrincipal(), m, '/videos/a.mp4', 'read', [])).toBe('deny');
    expect(checkPermission(userPrincipal(), m, '/images/a.jpg', 'read', [])).toBe('allow');
  });
});

describe('默认路径内用户权限（默认权限矩阵）', () => {
  it('用户在默认路径内获得全部默认权限（含 write）', () => {
    const u = userPrincipal({ id: 'alice', defaultPath: '/users/alice' });
    for (const action of ['read', 'write', 'update', 'delete', 'share', 'download'] as const) {
      expect(checkPermission(u, mount, '/users/alice/f.txt', action, [])).toBe('allow');
    }
  });
  it('文件所有者回退：defaultPath=/ 用户读取自有文件', () => {
    const u = userPrincipal({ id: 'owner1', defaultPath: '/' });
    expect(checkPermission(u, mount, '/f.txt', 'read', [], 'owner1')).toBe('allow');
    expect(checkPermission(u, mount, '/f.txt', 'update', [], 'owner1')).toBe('allow');
  });
  it('默认路径外的路径不能自动获得权限', () => {
    const u = userPrincipal({ id: 'alice', defaultPath: '/users/alice' });
    expect(checkPermission(u, mount, '/users/bob/f.txt', 'read', [])).toBe('deny');
  });
});

describe('条件检查（密码 / IP）', () => {
  const alice = userPrincipal({ id: 'alice', defaultPath: '/' });
  const pwdRule = rule({ id: 'p', role: 'user', pathPattern: '/private/**', effect: 'allow', requirePassword: true });
  const ipRule = rule({ id: 'i', role: 'user', pathPattern: '/secure/**', effect: 'allow', allowedIps: ['1.2.3.4'] });

  it('requirePassword 且未验证 → deny', () => {
    expect(checkPermission(alice, mount, '/private/x.txt', 'download', [pwdRule], undefined, {})).toBe('deny');
  });
  it('requirePassword 已验证 → allow', () => {
    expect(checkPermission(alice, mount, '/private/x.txt', 'download', [pwdRule], undefined, { passwordVerified: true })).toBe('allow');
  });
  it('allowedIps 不匹配 → deny', () => {
    expect(checkPermission(alice, mount, '/secure/x.txt', 'read', [ipRule], undefined, { ip: '9.9.9.9' })).toBe('deny');
  });
  it('allowedIps 匹配 → allow', () => {
    expect(checkPermission(alice, mount, '/secure/x.txt', 'read', [ipRule], undefined, { ip: '1.2.3.4' })).toBe('allow');
  });
});

// 规则创建面已收紧（RuleSchema 不再接受 requirePassword/allowedIps），但存量库行可能仍带这些字段。
// 引擎契约：存量行 fail-closed（不传 conditions 一律 deny，不放宽）；显式条件传入（文件密码验证流程构造）方可放行。
describe('存量规则条件 fail-closed（引擎契约）', () => {
  const alice = userPrincipal({ id: 'alice', defaultPath: '/' });
  const legacyPwdRule = rule({ id: 'lp', role: 'user', pathPattern: '/legacy/**', effect: 'allow', requirePassword: true });
  const legacyIpRule = rule({ id: 'li', role: 'user', pathPattern: '/legacy-ip/**', effect: 'allow', allowedIps: ['10.0.0.1'] });

  it('存量 requirePassword 规则：不传 conditions → deny', () => {
    expect(checkPermission(alice, mount, '/legacy/x.txt', 'download', [legacyPwdRule], undefined)).toBe('deny');
  });
  it('存量 requirePassword 规则：显式 passwordVerified → allow', () => {
    expect(checkPermission(alice, mount, '/legacy/x.txt', 'download', [legacyPwdRule], undefined, { passwordVerified: true })).toBe('allow');
  });
  it('存量 allowedIps 规则：不传 conditions → deny', () => {
    expect(checkPermission(alice, mount, '/legacy-ip/x.txt', 'download', [legacyIpRule], undefined)).toBe('deny');
  });
  it('存量 allowedIps 规则：IP 命中 → allow', () => {
    expect(checkPermission(alice, mount, '/legacy-ip/x.txt', 'download', [legacyIpRule], undefined, { ip: '10.0.0.1' })).toBe('allow');
  });
  it('存量 allowedIps 规则：IP 不命中 → deny', () => {
    expect(checkPermission(alice, mount, '/legacy-ip/x.txt', 'download', [legacyIpRule], undefined, { ip: '10.0.0.2' })).toBe('deny');
  });
});

describe('挂载隔离（findCandidates / loadPrincipalRules）', () => {
  it('findCandidates 按 mountId 过滤：另一挂载的规则不会返回', async () => {
    const { createTestContext, initSeeded } = await import('./helpers');
    const ctx = createTestContext();
    await initSeeded(ctx);
    const { RuleRepo, Db } = await import('../src/db');
    const db = Db.fromSqlite(ctx.db);
    const mountA = 'mount-a';
    const mountB = 'mount-b';
    const rA = await RuleRepo.createRule(db, {
      pathPattern: '/private/**', effect: 'deny', mountId: mountA,
      role: 'user', permissions: ['read'], requirePassword: false, priority: 0,
    });
    await RuleRepo.createRule(db, {
      pathPattern: '/private/**', effect: 'allow', mountId: mountB,
      role: 'user', permissions: ['read'], requirePassword: false, priority: 0,
    });
    const gotForA = await RuleRepo.findCandidates(db, { roles: ['user'] }, mountA);
    const gotForB = await RuleRepo.findCandidates(db, { roles: ['user'] }, mountB);
    expect(gotForA.some((r) => r.id === rA.id)).toBe(true);
    // 挂载 A 的规则不应出现在挂载 B 的候选中
    expect(gotForB.some((r) => r.id === rA.id)).toBe(false);
  });

  it('mountId 为空（全局规则）在所有挂载生效', async () => {
    const { createTestContext, initSeeded } = await import('./helpers');
    const ctx = createTestContext();
    await initSeeded(ctx);
    const { RuleRepo, Db } = await import('../src/db');
    const db = Db.fromSqlite(ctx.db);
    const g = await RuleRepo.createRule(db, {
      pathPattern: '/global/**', effect: 'allow', // mountId 省略 → 全局
      role: 'user', permissions: ['read'], requirePassword: false, priority: 0,
    });
    const gotA = await RuleRepo.findCandidates(db, { roles: ['user'] }, 'any-mount');
    const gotB = await RuleRepo.findCandidates(db, { roles: ['user'] }, 'another-mount');
    expect(gotA.some((r) => r.id === g.id)).toBe(true);
    expect(gotB.some((r) => r.id === g.id)).toBe(true);
  });

  it('checkPermission：同一路径不同挂载应用各自规则', async () => {
    const alice = userPrincipal({ id: 'alice', defaultPath: '/' });
    const mountA: Mount = { ...mount, id: 'mA' };
    const mountB: Mount = { ...mount, id: 'mB' };
    const denyA = rule({ id: 'dA', mountId: 'mA', role: 'user', pathPattern: '/private/**', effect: 'deny' });
    const allowB = rule({ id: 'aB', mountId: 'mB', role: 'user', pathPattern: '/private/**', effect: 'allow' });
    // 挂载 A 只看到自己的规则 → deny
    expect(checkPermission(alice, mountA, '/private/x.txt', 'read', [denyA])).toBe('deny');
    // 挂载 B 只看到自己的规则 → allow
    expect(checkPermission(alice, mountB, '/private/x.txt', 'read', [allowB])).toBe('allow');
  });
});

