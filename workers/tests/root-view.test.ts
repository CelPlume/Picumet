// 合成根：虚拟目录解析与权限门控（纯函数，不触库）
import { describe, it, expect } from 'vitest';
import { virtualListingFor, virtualTreeFor, type MountPermissionDeps } from '../src/services/storage/root-view';
import type { Mount, PathRule, Permission, Principal } from '@shared/types';
import { PERMISSION_MATRIX } from '@shared/types';

const ALL: Permission[] = [...PERMISSION_MATRIX];

function mountAt(mountPath: string): Mount {
  return {
    id: `m${mountPath}`,
    mountPath,
    name: mountPath,
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
}

function principalOf(overrides: Partial<Principal> = {}): Principal {
  return { type: 'user', id: 'u1', role: 'user', defaultPath: '/', defaultPermissions: ALL, ...overrides };
}

function depsOf(
  mounts: Mount[],
  principal: Principal = principalOf(),
  extras: { rules?: Record<string, PathRule[]>; matrix?: Record<string, Map<string, Permission[]>> } = {}
): MountPermissionDeps {
  return {
    principal,
    mounts,
    rulesByMount: new Map(Object.entries(extras.rules ?? {})),
    matrixByMount: new Map(Object.entries(extras.matrix ?? {})),
  };
}

function denyReadRule(pathPattern: string, mountId: string): PathRule {
  return {
    id: 'deny-read',
    mountId,
    pathPattern,
    effect: 'deny',
    role: 'user',
    permissions: ['read'],
    requirePassword: false,
    priority: 0,
    origin: 'admin',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('virtualListingFor', () => {
  it('非挂载祖先返回 null；路径自身是挂载点也返回 null', () => {
    const mounts = [mountAt('/storage1')];
    expect(virtualListingFor(depsOf(mounts), '/other')).toBeNull();
    expect(virtualListingFor(depsOf(mounts), '/storage1')).toBeNull();
    expect(virtualListingFor(depsOf(mounts), '/storage1/deep')).toBeNull();
    expect(virtualListingFor(depsOf([]), '/')).toBeNull();
  });

  it('无根拓扑：聚合顶层挂载为虚拟目录项（id/name/path/type/安全默认）', () => {
    const mounts = [mountAt('/storage3'), mountAt('/storage1'), mountAt('/storage2')];
    const items = virtualListingFor(depsOf(mounts), '/');
    expect(items?.map((i) => i.name)).toEqual(['storage1', 'storage2', 'storage3']);
    expect(items?.map((i) => i.path)).toEqual(['/storage1', '/storage2', '/storage3']);
    expect(items?.map((i) => i.id)).toEqual(['vroot:/storage1', 'vroot:/storage2', 'vroot:/storage3']);
    for (const item of items ?? []) {
      expect(item.type).toBe('folder');
      expect(item.size).toBe(0);
      expect(item.visibility).toBe('private');
      expect(item.ownerId).toBe('');
      expect(item.hasPassword).toBe(false);
      expect(item.guestVisibility).toBeNull();
    }
  });

  it('中间虚拟目录按层级逐段展开', () => {
    const mounts = [mountAt('/a/b/c1'), mountAt('/a/b/c2'), mountAt('/a/x')];
    expect(virtualListingFor(depsOf(mounts), '/')?.map((i) => i.name)).toEqual(['a']);
    expect(virtualListingFor(depsOf(mounts), '/a')?.map((i) => i.name)).toEqual(['b', 'x']);
    expect(virtualListingFor(depsOf(mounts), '/a/b')?.map((i) => i.name)).toEqual(['c1', 'c2']);
    // 挂载根条目路径为自身全路径，供前端继续导航
    expect(virtualListingFor(depsOf(mounts), '/a/b')?.[0].path).toBe('/a/b/c1');
  });

  it('挂载根按该挂载点的 read 判定隐藏；管理员不受限', () => {
    const mounts = [mountAt('/storage1'), mountAt('/storage2'), mountAt('/storage3')];
    const matrix = { 'm/storage2': new Map([['user', ['write', 'download'] as Permission[]]]) };
    expect(virtualListingFor(depsOf(mounts, principalOf(), { matrix }), '/')?.map((i) => i.name)).toEqual([
      'storage1',
      'storage3',
    ]);
    // 管理员特权：矩阵 deny 不生效
    const admin = principalOf({ role: 'admin' });
    expect(virtualListingFor(depsOf(mounts, admin, { matrix }), '/')?.map((i) => i.name)).toEqual([
      'storage1',
      'storage2',
      'storage3',
    ]);
  });

  it('defaultPath 边界外的挂载点对普通用户隐藏', () => {
    const mounts = [mountAt('/storage1'), mountAt('/storage2')];
    const restricted = principalOf({ defaultPath: '/users/u1' });
    expect(virtualListingFor(depsOf(mounts, restricted), '/')).toBeNull();
  });

  it('deny 规则命中的挂载点隐藏', () => {
    const mounts = [mountAt('/storage1'), mountAt('/storage2')];
    const rules = { 'm/storage1': [denyReadRule('/storage1', 'm/storage1')] };
    expect(virtualListingFor(depsOf(mounts, principalOf(), { rules }), '/')?.map((i) => i.name)).toEqual([
      'storage2',
    ]);
  });

  it('中间虚拟目录：其下全部挂载点不可读则连目录一起隐藏', () => {
    const allDenied = { 'm/a/b/c1': new Map([['user', ['write'] as Permission[]]]), 'm/a/b/c2': new Map([['user', ['write'] as Permission[]]]) };
    const mounts = [mountAt('/a/b/c1'), mountAt('/a/b/c2')];
    expect(virtualListingFor(depsOf(mounts, principalOf(), { matrix: allDenied }), '/a')).toBeNull();
    expect(virtualListingFor(depsOf(mounts, principalOf(), { matrix: allDenied }), '/')).toBeNull();
    // 任一可读即显示中间目录
    const oneAllowed = { 'm/a/b/c1': new Map([['user', ['write'] as Permission[]]]) };
    expect(virtualListingFor(depsOf(mounts, principalOf(), { matrix: oneAllowed }), '/a')?.map((i) => i.name)).toEqual([
      'b',
    ]);
  });
});

describe('virtualTreeFor', () => {
  it('展平全部虚拟层级并按 path 升序', () => {
    const mounts = [mountAt('/a/b/c1'), mountAt('/a/b/c2'), mountAt('/storage1')];
    expect(virtualTreeFor(depsOf(mounts), '/')?.map((i) => i.path)).toEqual([
      '/a',
      '/a/b',
      '/a/b/c1',
      '/a/b/c2',
      '/storage1',
    ]);
  });

  it('非挂载祖先返回 null（调用方保持 404）', () => {
    expect(virtualTreeFor(depsOf([mountAt('/storage1')]), '/nope')).toBeNull();
  });

  it('中间目录整体不可读时其自身与后代都不出现', () => {
    const matrix = { 'm/a/b/c1': new Map([['user', ['write'] as Permission[]]]) };
    expect(virtualTreeFor(depsOf([mountAt('/a/b/c1')], principalOf(), { matrix }), '/')).toBeNull();
  });
});
