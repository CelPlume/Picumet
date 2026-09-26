// 文件/文件夹删除内部实现：供 WebDAV DELETE、MOVE Overwrite、S3 网关、AList shim 复用。
// 语义与 WebDAV DELETE 完全一致（一致性边界）：元数据 + 配额 + 分享同一事务，对象清理异步对账。
import type { Context } from 'hono';
import type { FileMetadata, Mount } from '@shared/types';
import { FileRepo, ShareRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { escapeLikePattern } from '../../utils/path';
import { cleanupObjects } from './move';
import { blobHashesOf, directObjectsOf, releaseBlobsTx } from './blob-gc';

/**
 * 用户配额扣减项按**文件行属主**分组——共享目录内多属主各自扣自己的，
 * 不能只按被删文件夹行的单一属主扣。used_files 只计文件行（folder 伪行不计，与上传计账口径一致）。
 */
function quotaDeltas(targets: FileMetadata[]): Array<{ ownerId: string; size: number; count: number }> {
  const grouped = new Map<string, { size: number; count: number }>();
  for (const t of targets) {
    const entry = grouped.get(t.ownerId);
    if (entry) {
      entry.size += t.size;
      entry.count += 1;
    } else {
      grouped.set(t.ownerId, { size: t.size, count: 1 });
    }
  }
  return [...grouped].map(([ownerId, v]) => ({ ownerId, size: v.size, count: v.count }));
}

export async function deleteFileInternal(c: Context, mount: Mount, file: FileMetadata, ownerId?: string): Promise<void> {
  const db = getDb(c);
  // 网关密钥流程（ownerId 传入）：删除范围限定属主自己的行（目录行共享，不跨属主清理）
  const own = (sql: string): string => (ownerId ? `${sql} AND owner_id = ?` : sql);
  let targets: FileMetadata[] = [];
  if (file.type === 'folder') {
    const desc = await FileRepo.listDescendants(db, mount.id, file.path, ownerId);
    targets = desc.filter((d) => d.type === 'file');
  } else {
    targets = [file];
  }
  // 用户配额按文件行属主分组扣减；挂载点 used_storage 按被删文件总量扣（两个维度不混）
  const deltas = quotaDeltas(targets);
  const totalSize = targets.reduce((s, d) => s + d.size, 0);
  // §F：内容寻址对象由引用释放接管（最后一个引用消失才入回收队列），其余对象直接删除
  const hashes = blobHashesOf(targets);
  const objects = directObjectsOf(targets);

  await db.transaction(async (tx) => {
    if (file.type === 'folder') {
      // 子树前缀先转义再拼 `/%`（folder 行 path=自身全路径，file 行 path=父目录）；
      // 目录名可含 %/_，未转义的 LIKE 会误伤 `/a/100x/…` 这类兄弟子树。
      const subtreeLike = `${escapeLikePattern(file.path)}/%`;
      await tx.query(
        own(`DELETE FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`),
        ownerId ? [mount.id, file.path, subtreeLike, ownerId] : [mount.id, file.path, subtreeLike]
      );
    } else {
      await tx.query(
        own(`DELETE FROM file_metadata WHERE id = ?`),
        ownerId ? [file.id, ownerId] : [file.id]
      );
    }
    for (const delta of deltas) {
      await tx.query(
        `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ?), used_files = MAX(0, used_files - ?), updated_at = ? WHERE user_id = ?`,
        [delta.size, delta.count, Date.now(), delta.ownerId]
      );
    }
    await tx.query(
      `UPDATE mounts SET used_storage = MAX(0, used_storage - ?), updated_at = ? WHERE id = ?`,
      [totalSize, Date.now(), mount.id]
    );
    await releaseBlobsTx(tx, hashes, Date.now());
    await tx.query(`DELETE FROM shares WHERE file_id = ?`, [file.id]);
    // 首项目被删 → 分享行已随上面删除/级联消失；此处清理「其余项目也已全部删除」的残留分享行
    await ShareRepo.deleteEmptyShares(tx);
  });

  // 对象清理：失败记录孤儿供对账（一致性边界）
  if (objects.length > 0) await cleanupObjects(c, mount.id, objects);
}
