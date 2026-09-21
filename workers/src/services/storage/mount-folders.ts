// 挂载点即目录（§H）：每个挂载点在**父挂载点命名空间**内维护一行 folder 记录，
// 使其在文件页、分享选择器、公开目录、WebDAV、AList 等所有「按路径列目录」的入口自然可见，
// 不需要这些入口各自做挂载点合成。
//
// 约定：
// - 行 id 确定性生成（`mountfolder:<mountId>`），保证幂等与可清理；
// - 行归属父挂载点（mount_id = 父挂载点），path = 绝对父目录，name = 路径末段；
// - object_key 用 `folder:<绝对路径>`，与用户手建文件夹的键规则一致（同名则复用已有行）；
// - custom_title 记录挂载点显示名（导航仍按路径，显示名不进路径）；
// - 根挂载点（'/'）没有父命名空间，不需要目录行。
import type { Mount } from '@shared/types';
import type { Db } from '../../db';
import { FileRepo, MountRepo } from '../../db';
import { normalizePath } from '../../utils/path';

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
 * 在父挂载点命名空间内登记该挂载点的目录行（幂等）：
 * - 父挂载点不存在（例如挂载点路径挂在未挂载的目录下）时跳过；
 * - 已存在同名文件夹行时只更新显示名，不覆盖用户数据。
 */
export async function ensureMountFolder(db: Db, mount: Mount, ownerId?: string): Promise<void> {
  const split = splitMountPath(mount.mountPath);
  if (!split) return;
  const parent = await MountRepo.findMountForPath(db, split.parentPath);
  if (!parent) return;
  const owner = ownerId ?? (await fallbackOwnerId(db));
  if (!owner) return;

  // 文件夹行的约定：path = 自身全路径（见 files/handlers.ts 的创建文件夹），故用 mountPath 查
  const existing = await FileRepo.getFileAtPath(db, parent.id, mount.mountPath, split.segment);
  if (existing) {
    if (existing.type === 'folder' && (existing.customTitle ?? null) !== mount.name) {
      await FileRepo.updateFile(db, existing.id, { custom_title: mount.name });
    }
    return;
  }
  await FileRepo.createFile(db, {
    id: mountFolderId(mount.id),
    mountId: parent.id,
    objectKey: `folder:${mount.mountPath}`,
    // 文件夹行 path = 自身全路径（此前误写成父目录，会让文件树把它当作根节点无限递归）
    path: mount.mountPath,
    name: split.segment,
    type: 'folder',
    size: 0,
    ownerId: owner,
    customTitle: mount.name,
  });
}

/** 移除挂载点目录行（挂载点被删除或改路径时调用）：只删自己维护的那一行 */
export async function removeMountFolder(db: Db, mount: Mount): Promise<void> {
  const split = splitMountPath(mount.mountPath);
  if (!split) return;
  const parent = await MountRepo.findMountForPath(db, split.parentPath);
  if (!parent) return;
  await db.run('DELETE FROM file_metadata WHERE mount_id = ? AND path = ? AND name = ? AND type = \'folder\'', [
    parent.id,
    mount.mountPath,
    split.segment,
  ]);
}

/** 全量补齐：给所有非根挂载点补目录行，返回新建数量（文件页列表与定时任务用它自愈） */
export async function ensureAllMountFolders(db: Db): Promise<number> {
  const mounts = await MountRepo.allMounts(db);
  const owner = await fallbackOwnerId(db);
  if (!owner) return 0;
  let created = 0;
  for (const mount of mounts) {
    const split = splitMountPath(mount.mountPath);
    if (!split) continue;
    const parent = await MountRepo.findMountForPath(db, split.parentPath);
    if (!parent) continue;
    const existing = await FileRepo.getFileAtPath(db, parent.id, mount.mountPath, split.segment);
    if (existing) continue;
    await ensureMountFolder(db, mount, owner);
    created += 1;
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

