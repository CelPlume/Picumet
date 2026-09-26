// 挂载点即目录（§H）：每个挂载点在**父挂载点命名空间**内维护一行 folder 记录，
// 使其在文件页、分享选择器、公开目录、WebDAV、AList 等所有「按路径列目录」的入口自然可见，
// 不需要这些入口各自做挂载点合成。
//
// 约定：
// - 行 id 确定性生成（`mountfolder:<mountId>`），保证幂等与可清理；
// - 行归属父挂载点（mount_id = 父挂载点），path = 绝对父目录，name = 路径末段；
// - object_key 用 `folder:<绝对路径>`（与用户手建文件夹同键规则：**同路径已有行时不再隐式复用**）；
// - custom_title 记录挂载点显示名（导航仍按路径，显示名不进路径）；
// - 根挂载点（'/'）没有父命名空间，不需要目录行。
//
// 身份化：创建/更新挂载时同路径已有非本挂载身份的 folder/file 行 → 管理端 409 拒绝；
// 后台自愈（ensureAllMountFolders）容错模式只 warn 跳过，不判失败、不改用户行；
// 删除只按确定性身份 id 删（不再按 (mount_id,path,name,type) 误删用户行），身份行不存在 = no-op。
import type { Mount } from '@shared/types';
import type { Db, Tx } from '../../db';
import { FileRepo, MountRepo } from '../../db';
import { ApiError } from '../../shared/errors';
import { normalizePath } from '../../utils/path';

/** 挂载点目录行登记只需这三个字段（便于在事务前构造轻量对象） */
type MountFolderSource = Pick<Mount, 'id' | 'mountPath' | 'name'>;

/** 挂载点目录行的确定性 id */
export function mountFolderId(mountId: string): string {
  return `mountfolder:${mountId}`;
}

/** 拆出父目录与末段：'/a/b' → { parentPath: '/a', segment: 'b' }；'/' → null */
export function splitMountPath(mountPath: string): { parentPath: string; segment: string } | null {
  const canonical = normalizePath(mountPath);
  if (canonical === '/') return null;
  const idx = canonical.lastIndexOf('/');
  const segment = canonical.slice(idx + 1);
  const parentPath = idx <= 0 ? '/' : canonical.slice(0, idx);
  if (!segment) return null;
  return { parentPath, segment };
}

/** 目录行归属的用户：首个管理员（folder 行是所有登录用户共享的命名空间，owner 仅作 FK 占位） */
async function fallbackOwnerId(db: Db): Promise<string | null> {
  const row = await db.first(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
  return row ? String(row.id) : null;
}

/**
 * 目录行登记计划：读阶段解析（父挂载、属主、现有行），写阶段只落库——
 * 这样管理端可把「目录行登记」并入外层 db.transaction（D1 事务内不支持读，读必须前置）。
 */
export interface MountFolderPlan {
  /** 确定性身份 id（= mountFolderId(mount.id)） */
  identityId: string;
  mountPath: string;
  segment: string;
  parentMountId: string;
  ownerId: string;
  /** 现有同名行（非本挂载身份的行已在下面拦截）；null = 需新建身份行 */
  existing: { id: string; type: string; customTitle: string | null } | null;
}

/**
 * 读阶段：解析挂载点目录行的登记计划。
 * - 父挂载点不存在（挂在未挂载目录下）/ 无属主 → null（静默跳过）；
 * - 同路径已有**非本挂载身份**的 folder/file 行：
 *   · strict（管理端创建/更新挂载）→ 409「目标路径已被现有目录/文件占用」；
 *   · 非 strict（后台自愈）→ warn 跳过，返回 null（存量复用行不被判失败，也不被改写）。
 */
export async function resolveMountFolderPlan(
  db: Db,
  mount: MountFolderSource,
  ownerId?: string,
  opts?: { strict?: boolean }
): Promise<MountFolderPlan | null> {
  const split = splitMountPath(mount.mountPath);
  if (!split) return null;
  const parent = await MountRepo.findMountForPath(db, split.parentPath);
  if (!parent) return null;
  const owner = ownerId ?? (await fallbackOwnerId(db));
  if (!owner) return null;
  const identityId = mountFolderId(mount.id);
  // 同「显示路径」的占用行：folder 行 path = 自身全路径；file 行 path = 父目录。
  // 只看其中一种会漏判另一种（如根目录下的同名文件），故一次查询同时覆盖两类。
  const conflict = await db.first(
    `SELECT id, type, custom_title FROM file_metadata
      WHERE mount_id = ? AND name = ?
        AND ((type = 'folder' AND path = ?) OR (type = 'file' AND path = ?))
      LIMIT 1`,
    [parent.id, split.segment, mount.mountPath, split.parentPath]
  );
  if (conflict && String(conflict.id) !== identityId) {
    if (opts?.strict) {
      throw new ApiError(
        409,
        'OPERATION_FAILED',
        `目标路径已被现有目录/文件占用：${mount.mountPath}（挂载点目录行使用确定性身份，不隐式复用用户行）`
      );
    }
    console.warn(
      `[mount-folders] 挂载点 ${mount.mountPath} 的同名 ${String(conflict.type)} 行不属于本挂载身份（id=${String(conflict.id)}），跳过登记；不隐式复用用户行。`
    );
    return null;
  }
  const existing = conflict
    ? {
        id: String(conflict.id),
        type: String(conflict.type),
        customTitle: typeof conflict.custom_title === 'string' ? conflict.custom_title : null,
      }
    : null;
  return {
    identityId,
    mountPath: mount.mountPath,
    segment: split.segment,
    parentMountId: parent.id,
    ownerId: owner,
    existing,
  };
}

/** 写阶段：按计划落库（幂等）。身份行存在→仅更新显示名；缺失→插入确定性 id 行。 */
export async function applyMountFolderPlan(
  writer: Db | Tx,
  plan: MountFolderPlan,
  mount: MountFolderSource
): Promise<void> {
  if (plan.existing) {
    if (plan.existing.type === 'folder' && plan.existing.customTitle !== mount.name) {
      await FileRepo.updateFileTx(writer, plan.identityId, { custom_title: mount.name });
    }
    return;
  }
  await FileRepo.createFileTx(writer, {
    id: plan.identityId,
    mountId: plan.parentMountId,
    objectKey: `folder:${plan.mountPath}`,
    // 文件夹行 path = 自身全路径（此前误写成父目录，会让文件树把它当作根节点无限递归）
    path: plan.mountPath,
    name: plan.segment,
    type: 'folder',
    size: 0,
    ownerId: plan.ownerId,
    customTitle: mount.name,
  });
}

/**
 * 登记挂载点目录行（读+写便捷入口，非事务路径用）。返回是否**新建**身份行。
 * opts.strict = true 时同路径被用户行占用直接 409（管理端创建/更新挂载）。
 */
export async function ensureMountFolder(
  db: Db,
  mount: MountFolderSource,
  ownerId?: string,
  opts?: { strict?: boolean }
): Promise<boolean> {
  const plan = await resolveMountFolderPlan(db, mount, ownerId, opts);
  if (!plan) return false;
  await applyMountFolderPlan(db, plan, mount);
  return plan.existing === null;
}

/**
 * 移除挂载点目录行（挂载点被删除或改路径时调用）——**只按确定性身份 id 删除**。
 * 不再用 (mount_id, path, name, type) 误删用户行；身份行不存在时 no-op。
 * 对存量复用行给 warn：挂载删除不再回收用户行（安全方向：宁可不删，也不误删用户数据）。
 */
export async function removeMountFolder(db: Db | Tx, mount: MountFolderSource): Promise<void> {
  const res = await db.query('DELETE FROM file_metadata WHERE id = ?', [mountFolderId(mount.id)]);
  if (res.changes === 0 && splitMountPath(mount.mountPath) !== null) {
    console.warn(
      `[mount-folders] 挂载点 ${mount.mountPath} 无确定性身份目录行；未回收任何行（存量复用行属用户数据，挂载删除不再回收）。`
    );
  }
}

/** 全量补齐：给所有非根挂载点补目录行，返回新建数量（文件页列表与定时任务用它自愈，容错模式） */
export async function ensureAllMountFolders(db: Db): Promise<number> {
  const mounts = await MountRepo.allMounts(db);
  const owner = await fallbackOwnerId(db);
  if (!owner) return 0;
  let created = 0;
  for (const mount of mounts) {
    if (await ensureMountFolder(db, mount, owner)) created += 1;
  }
  return created;
}

/**
 * 列出某路径下的**子挂载点**（形如父路径 + 一段：/ 的子挂载点是 /poolui）。
 * 用于：列目录时自愈补齐其目录行；禁止对包含挂载点的目录做删除/重命名。
 */
export function childMountsOf(mounts: Mount[], parentPath: string): Mount[] {
  const canonical = normalizePath(parentPath);
  return mounts.filter((m) => {
    const split = splitMountPath(m.mountPath);
    return split !== null && split.parentPath === canonical;
  });
}

/** 文件行的绝对路径：folder 行 path 是自身全路径，file 行 path 是父目录 */
function absolutePathOf(f: { path: string; name: string; type: string }): string {
  if (f.type === 'folder') return normalizePath(f.path);
  return normalizePath(f.path === '/' ? `/${f.name}` : `${f.path}/${f.name}`);
}

/** 该行本身是挂载点（挂载点目录不允许重命名/移动/删除） */
export async function isMountPointFile(db: Db, f: { path: string; name: string; type: string }): Promise<boolean> {
  const abs = absolutePathOf(f);
  const mounts = await MountRepo.allMounts(db);
  return mounts.some((m) => m.mountPath === abs);
}

/** 该文件夹内部含有挂载点（删除/重命名/移动父目录会连带隐藏挂载点行，必须拒绝） */
export async function containsMountPointFile(db: Db, f: { path: string; name: string; type: string }): Promise<boolean> {
  const abs = absolutePathOf(f);
  const mounts = await MountRepo.allMounts(db);
  return mounts.some((m) => m.mountPath !== abs && (abs === '/' || m.mountPath.startsWith(abs + '/')));
}

