// §H 合成根：请求路径没有任何覆盖它的挂载点、但其下存在挂载拓扑时，
// 把「该路径下的挂载骨架」合成为虚拟目录项，使无 `/` 根挂载的部署（仅 /storage1、/storage2…）
// 在文件页列表与树里仍能看到顶层挂载点。
//
// 约定（共享契约）：
// - 虚拟项没有 file_metadata 行，id 形如 `vroot:<虚拟全路径>`，type=folder，
//   path=自身全路径（与 folder 行一致），其余字段取安全默认；
// - 挂载根条目以其挂载点做一次 read 门禁（纯函数 checkPermission，规则/矩阵由本模块预加载一次）；
// - 中间虚拟目录只要其下至少一个挂载点 read 通过就显示，全部不可读则连目录本身也不显示；
// - 上传/详情等入口不做合成——对虚拟路径仍按 404 处理。
import type { Context } from 'hono';
import type { AppBindings } from '../../shared/types';
import type { FileListItem, Mount, PathRule, Permission, Principal } from '@shared/types';
import { MountRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { getMountMatrix, getPrincipal } from '../permissions/principal';
import { checkPermission, loadPrincipalRules } from '../permissions/check';
import { normalizePath } from '../../utils/path';

/** 虚拟目录项 id 前缀（共享契约）：`vroot:<虚拟全路径>` */
export const VIRTUAL_ROOT_ID_PREFIX = 'vroot:';

/** 判定上下文：主体 + 全量挂载点 + 各挂载点的候选规则与角色矩阵（每请求只查一次库） */
export interface MountPermissionDeps {
  principal: Principal;
  mounts: Mount[];
  rulesByMount: Map<string, PathRule[]>;
  matrixByMount: Map<string, Map<string, Permission[]>>;
}

/**
 * 预加载主体/挂载点/各挂载点的规则与矩阵一次。
 * checkPermission 是纯函数，判定时不再触库——树最多 5000 行也不产生 N 次往返。
 */
export async function loadMountPermissionDeps(c: Context<AppBindings>): Promise<MountPermissionDeps> {
  const db = getDb(c);
  const principal = await getPrincipal(c);
  const mounts = await MountRepo.listMounts(db);
  const rulesByMount = new Map<string, PathRule[]>();
  const matrixByMount = new Map<string, Map<string, Permission[]>>();
  for (const mount of mounts) {
    rulesByMount.set(mount.id, await loadPrincipalRules(db, principal, mount.id));
    matrixByMount.set(mount.id, await getMountMatrix(c, mount.id));
  }
  return { principal, mounts, rulesByMount, matrixByMount };
}

/** 该挂载点根对当前主体是否可读（纯函数判定，不查库） */
function mountReadable(deps: MountPermissionDeps, mount: Mount): boolean {
  return (
    checkPermission(
      deps.principal,
      mount,
      mount.mountPath,
      'read',
      deps.rulesByMount.get(mount.id) ?? [],
      undefined,
      undefined,
      undefined,
      undefined,
      deps.matrixByMount.get(mount.id)
    ) === 'allow'
  );
}

/** 该路径的严格后代挂载点（按路径段；path 自身有挂载点时不适用，由 findMountForPath 先行处理） */
function mountsUnder(deps: MountPermissionDeps, path: string): Mount[] {
  return deps.mounts.filter(
    (m) => m.mountPath !== path && (path === '/' ? m.mountPath !== '/' : m.mountPath.startsWith(path + '/'))
  );
}

/** 构造虚拟目录项（folder 行语义：path = 自身全路径；安全默认见文件头注释） */
function virtualFolderItem(fullPath: string, name: string, now: number): FileListItem {
  return {
    id: `${VIRTUAL_ROOT_ID_PREFIX}${fullPath}`,
    name,
    path: fullPath,
    type: 'folder',
    size: 0,
    hasPassword: false,
    visibility: 'private',
    reviewStatus: 'approved',
    guestVisibility: null,
    ownerId: '',
    createdAt: now,
    updatedAt: now,
    hash: null,
  };
}

/**
 * 合成该路径的下一级目录项；返回 null 表示 «该路径不是任何挂载点的祖先»
 * （含：路径自身就是挂载点——此时不应合成，交由常规挂载流程）。
 */
export function virtualListingFor(deps: MountPermissionDeps, rawPath: string): FileListItem[] | null {
  const path = normalizePath(rawPath);
  if (deps.mounts.some((m) => m.mountPath === path)) return null;
  const under = mountsUnder(deps, path);
  if (under.length === 0) return null;

  const prefix = path === '/' ? '/' : `${path}/`;
  // 按下一级名聚合：名字即挂载根，或其下还有更深的挂载点（中间虚拟目录）
  const groups = new Map<string, Mount[]>();
  for (const mount of under) {
    const segment = mount.mountPath.slice(prefix.length).split('/')[0];
    if (!segment) continue;
    const bucket = groups.get(segment);
    if (bucket) bucket.push(mount);
    else groups.set(segment, [mount]);
  }

  const now = Date.now();
  const items: FileListItem[] = [];
  for (const [segment, group] of groups) {
    const fullPath = path === '/' ? `/${segment}` : `${path}/${segment}`;
    const mountRoot = group.find((m) => m.mountPath === fullPath);
    // 挂载根条目：该挂载点自身读通过才显示；中间虚拟目录：其下任一挂载点读通过即显示
    const visible = mountRoot ? mountReadable(deps, mountRoot) : group.some((m) => mountReadable(deps, m));
    if (visible) items.push(virtualFolderItem(fullPath, segment, now));
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  // 全部不可读 = 该层没有可见项：不显示（调用方保持 404），避免泄露挂载拓扑存在性
  return items.length === 0 ? null : items;
}

/**
 * 树视图用：该路径下全部虚拟层级的合成 folder 行（含中间虚拟目录与挂载根）。
 * 挂载根以下的层级属于该挂载点的 file_metadata 命名空间，不在此合成（前端导航到该路径时再按挂载点展开）。
 * 返回 null 表示该路径不是任何挂载点的祖先。
 */
export function virtualTreeFor(deps: MountPermissionDeps, rawPath: string): FileListItem[] | null {
  const path = normalizePath(rawPath);
  const rootItems = virtualListingFor(deps, path);
  if (!rootItems) return null;

  const mountPaths = new Set(deps.mounts.map((m) => m.mountPath));
  const out: FileListItem[] = [];
  const seen = new Set<string>();
  const walk = (items: FileListItem[]): void => {
    for (const item of items) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      out.push(item);
      if (!mountPaths.has(item.path)) walk(virtualListingFor(deps, item.path) ?? []);
    }
  };
  walk(rootItems);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** 路由入口：合成根的下一级目录项；无根拓扑之外返回 null（调用方保持 404） */
export async function resolveVirtualListing(
  c: Context<AppBindings>,
  rawPath: string
): Promise<FileListItem[] | null> {
  return virtualListingFor(await loadMountPermissionDeps(c), rawPath);
}

/** 路由入口：合成根的整棵虚拟骨架；无根拓扑之外返回 null（调用方保持 404） */
export async function resolveVirtualTree(
  c: Context<AppBindings>,
  rawPath: string
): Promise<FileListItem[] | null> {
  return virtualTreeFor(await loadMountPermissionDeps(c), rawPath);
}
