// 文件/文件夹删除内部实现：供 WebDAV DELETE、MOVE Overwrite、S3 网关、AList shim 复用。
// 语义与原 WebDAV DELETE 完全一致（H-5 一致性边界）：元数据 + 配额 + 分享同一事务，对象清理异步对账。
import type { Context } from 'hono';
import type { FileMetadata, Mount } from '@shared/types';
import { FileRepo, ShareRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { cleanupObjects } from './move';
import { blobHashesOf, directObjectsOf, releaseBlobsTx } from './blob-gc';

export async function deleteFileInternal(c: Context, mount: Mount, file: FileMetadata, ownerId?: string): Promise<void> {
  const db = getDb(c);
  // 网关密钥流程（ownerId 传入）：删除范围限定属主自己的行（目录行共享，不跨属主清理）
  const own = (sql: string): string => (ownerId ? `${sql} AND owner_id = ?` : sql);
  let targets: FileMetadata[] = [];
  let totalSize = file.size;
  let count = 1;
  if (file.type === 'folder') {
    const desc = await FileRepo.listDescendants(db, mount.id, file.path, ownerId);
    targets = desc.filter((d) => d.type === 'file');
    totalSize = desc.reduce((s, d) => s + d.size, 0);
    count = desc.length;
  } else {
    targets = [file];
  }
  // §F：内容寻址对象由引用释放接管（最后一个引用消失才入回收队列），其余对象直接删除
  const hashes = blobHashesOf(targets);
  const objects = directObjectsOf(targets);

  await db.transaction(async (tx) => {
    if (file.type === 'folder') {
      await tx.query(
        own(`DELETE FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ?)`),
        ownerId ? [mount.id, file.path, `${file.path}/%`, ownerId] : [mount.id, file.path, `${file.path}/%`]
      );
    } else {
      await tx.query(
        own(`DELETE FROM file_metadata WHERE id = ?`),
        ownerId ? [file.id, ownerId] : [file.id]
      );
    }
    await releaseBlobsTx(tx, hashes, Date.now());
    await tx.query(
      `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ?), used_files = MAX(0, used_files - ?), updated_at = ? WHERE user_id = ?`,
      [totalSize, count, Date.now(), file.ownerId]
    );
    await tx.query(
      `UPDATE mounts SET used_storage = MAX(0, used_storage - ?), updated_at = ? WHERE id = ?`,
      [totalSize, Date.now(), mount.id]
    );
    await tx.query(`DELETE FROM shares WHERE file_id = ?`, [file.id]);
    // 首项目被删 → 分享行已随上面删除/级联消失；此处清理「其余项目也已全部删除」的残留分享行
    await ShareRepo.deleteEmptyShares(tx);
  });

  // 对象清理：失败记录孤儿供对账（H-5 一致性边界）
  if (objects.length > 0) await cleanupObjects(c, mount.id, objects);
}
