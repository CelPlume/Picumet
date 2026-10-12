// 挂载点写入口模式（§28）的写路径约束。
//
// 与权限引擎的分工：checkPermission 回答「谁、在哪个路径、能做什么动作」，写入口模式回答
// 「这个挂载点允许把文件/文件夹落到哪些路径形态」。两者正交，且在写路径上依次生效。
//
// 三档语义（mounts.upload_mode）：
//   free       现状：不额外约束，写路径只受路径规则与配额约束（既有挂载点行为零变化）；
//   user_space 写路径强制落在 <mountPath>/<用户名>（该目录首次使用自动创建）；
//   flat       挂载点内禁止新建文件夹（平铺上传），上传路径本身不额外约束。
//
// 所有写入通道（/api/upload、兼容上传、WebDAV PUT/MKCOL、S3 网关、AList shim）在落盘前统一
// 经过这里，保证「同一挂载点在任一入口行为一致」。
import type { Db } from '../../db';
import { UserRepo } from '../../db';
import type { Mount } from '@shared/types';
import { ApiError } from '../../shared/errors';
import { basename, isPathWithinBoundary, normalizePath } from '../../utils/path';

/**
 * 用户空间根（每个用户一个独立文件夹）：
 *   1. 用户 `default_path` 非 `/` 且落在本挂载点边界内 → `<defaultPath>/<username>`。
 *      defaultPath 是「该用户的家所在区域」（如角色默认 `/public`），用户空间是其下
 *      以用户名命名的独立子目录（`/public/<username>`）——不同用户互不可写对方目录。
 *      特例：defaultPath 的末段已经是用户名（管理员把某用户的家指到个人目录，
 *      如 `/users/alice`）→ 直接用 defaultPath，避免拼出 `/users/alice/alice`。
 *   2. defaultPath 为 `/`、未设置、或不在本挂载点边界内（如 defaultPath 指向另一挂载点）
 *      → 回落 `<mountPath>/<username>`（用户名唯一，跨用户零冲突）。
 *
 * 用户改名后其旧目录留在原处不迁移、也不被新用户名接管（改名迁移不在 §28 范围内）。
 */
export async function resolveUserSpaceRoot(db: Db, mount: Mount, ownerId: string): Promise<string> {
  const user = await UserRepo.getUserById(db, ownerId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  const mountPath = normalizePath(mount.mountPath);
  const fallback = mountPath === '/' ? `/${user.username}` : `${mountPath}/${user.username}`;
  const home = user.defaultPath ? normalizePath(user.defaultPath) : '/';
  if (home !== '/' && isPathWithinBoundary(home, mountPath)) {
    return home.split('/').filter(Boolean).pop() === user.username ? home : `${home}/${user.username}`;
  }
  return fallback;
}

/**
 * 写路径入口校验（对象写入 / 移动目标 / 新建文件夹共用）：
 * - **admin 恒放行**：与权限引擎的「admin 一切规则之上」同源——user_space 是
 *   「普通用户写入隔离」的挂载点策略，不是给管理员上的枷锁。管理员要能跨目录
 *   整理文件、在网页建目录，否则管理端连「帮用户挪个文件」都做不到。
 * - free：直接放行；
 * - user_space：`targetPath` 必须落在调用者的用户空间内（路径段边界判定，
 *   `/public/alice2` 不会被 `/public/alice` 误放行）；
 * - flat：路径本身不额外约束（平铺约束由 `assertFolderCreateAllowed` 在「新建文件夹」入口施加）。
 */
export async function assertWritable(db: Db, mount: Mount, ownerId: string, targetPath: string): Promise<void> {
  if (mount.uploadMode !== 'user_space') return;
  const user = await UserRepo.getUserById(db, ownerId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  if (user.role === 'admin') return;
  const root = await resolveUserSpaceRoot(db, mount, ownerId);
  if (!isPathWithinBoundary(normalizePath(targetPath), root)) {
    throw new ApiError(403, 'FORBIDDEN', `该挂载点仅允许写入 ${basename(root)} 目录`);
  }
}

/**
 * 新建文件夹入口校验：flat 档禁止在挂载点内新建文件夹（无论通过哪个协议），其余档放行。
 * 注意只作用于显式的「建文件夹」入口；写入时自愈补齐的祖先目录不在此列。
 */
export function assertFolderCreateAllowed(mount: Mount): void {
  if (mount.uploadMode === 'flat') {
    throw new ApiError(403, 'FORBIDDEN', '该挂载点不允许新建文件夹');
  }
}
