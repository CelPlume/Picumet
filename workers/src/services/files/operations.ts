// 文件路由 B：删除、移动、批量操作、任务状态
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { FileRepo, MountRepo, JobRepo, ShareRepo } from '../../db';
import type { Db } from '../../db';
import { getDb } from '../../middleware/auth';
import { requirePermission } from '../permissions/principal';
import { moveWithSaga, cleanupObjects } from '../files/move';
import { containsMountPointFile, isMountPointFile } from '../storage/mount-folders';
import { blobHashesOf, directObjectsOf, releaseBlobsTx } from './blob-gc';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import type { FileMetadata } from '@shared/types';
import { normalizePath, escapeLikePattern } from '../../utils/path';
import { requestIp } from '../../utils/ip';
import { MoveFileSchema, BatchOpSchema } from './schemas';

export const fileOpsRoutes = new Hono<AppBindings>();

async function resolveFile(c: Parameters<typeof ok>[0]) {
  const db = getDb(c);
  const id = c.req.param('id') as string;
  const file = await FileRepo.getFileById(db, id);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  const mount = await MountRepo.getMountById(db, file.mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  return { file, mount, db };
}

/**
 * 权限路径基准：文件行的 path 是父目录，路径规则需要文件全路径才能命中精确规则；
 * 文件夹行的 path 已是自身全路径。与 handlers.ts 的 filePermPath 同义。
 */
function filePermPath(f: { path: string; name: string; type: 'file' | 'folder' }): string {
  if (f.type === 'folder') return f.path;
  return f.path === '/' ? `/${f.name}` : `${f.path}/${f.name}`;
}

/**
 * 删除目标集合：文件夹取整棵子树（含自身目录行），单文件即自身。
 * totalSize 只统计文件行（挂载点容量口径，与 reconcileQuotas 一致）；rowCount 为响应/行数展示用的整行数。
 */
async function collectDeleteTargets(
  db: Db,
  mountId: string,
  file: FileMetadata
): Promise<{ targets: FileMetadata[]; totalSize: number; rowCount: number }> {
  if (file.type === 'folder') {
    const descendants = await FileRepo.listDescendants(db, mountId, file.path);
    const files = descendants.filter((d) => d.type === 'file');
    return { targets: files, totalSize: files.reduce((sum, d) => sum + d.size, 0), rowCount: descendants.length };
  }
  return { targets: [file], totalSize: file.size, rowCount: 1 };
}

/**
 * 用户配额扣减项按**文件行属主**分组——共享目录（upload_mode='free'）内多属主各自扣自己的，
 * 不能只按被删文件夹行的单一属主扣。used_files 只计文件行（与上传计账口径一致，folder 伪行不计）。
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

/** 子树删除谓词（folder 行 path=自身全路径，文件行 path=父目录）：转义 `%`/`_` 防误伤兄弟子树 */
function subtreeDeleteSql(mountId: string, folderPath: string): [string, unknown[]] {
  return [
    `DELETE FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`,
    [mountId, folderPath, `${escapeLikePattern(folderPath)}/%`],
  ];
}

// 日志 IP 统一走 utils/ip（requestIp，无来源时 undefined，不落回退值）。

// ============ 删除（硬删除） ============
fileOpsRoutes.delete('/:id', async (c) => {
  const { file, mount, db } = await resolveFile(c);
  // 单点 DELETE 与批量删除/读/改/下载同基准——使用文件全路径；若用 file.path=父目录，
  // 文件级精确 deny/allow 规则无法命中。
  await requirePermission(c, mount, filePermPath(file), 'delete', file.ownerId, undefined, undefined, undefined, file.providerId ?? undefined);
  // §H：挂载点目录行由系统维护；删除/移动包含挂载点的目录会让挂载点从父目录消失
  if (await isMountPointFile(db, file)) {
    throw new ApiError(409, 'OPERATION_FAILED', '挂载点目录由系统维护，请在存储配置中删除挂载点');
  }
  if (file.type === 'folder' && (await containsMountPointFile(db, file))) {
    throw new ApiError(409, 'OPERATION_FAILED', '该目录下存在挂载点，请先删除对应挂载点');
  }

  const { targets, totalSize, rowCount: fileCount } = await collectDeleteTargets(db, mount.id, file);
  // 用户配额按文件行属主分组扣减（共享目录内多属主各自扣自己的）
  const deltas = quotaDeltas(targets);
  // §F：内容寻址对象走引用释放（最后一个引用消失才入回收队列）；其余对象直接删除
  const blobHashes = blobHashesOf(targets);
  const objectKeys = directObjectsOf(targets);

  await db.transaction(async (tx) => {
    if (file.type === 'folder') {
      const [sql, params] = subtreeDeleteSql(mount.id, file.path);
      await tx.query(sql, params);
    } else {
      await tx.query(`DELETE FROM file_metadata WHERE id = ?`, [file.id]);
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
    await tx.query(
      `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
       VALUES (?, ?, 'delete', ?, ?, ?, ?, ?, 200, ?)`,
      [crypto.randomUUID(), c.get('userId'), file.path, JSON.stringify({ fileCount }), requestIp(c.req.raw), c.req.header('user-agent'), totalSize, Date.now()]
    );
    await tx.query(`DELETE FROM shares WHERE file_id = ?`, [file.id]);
    await ShareRepo.deleteEmptyShares(tx);
    await releaseBlobsTx(tx, blobHashes, Date.now());
  });

  if (objectKeys.length > 0) await cleanupObjects(c, mount.id, objectKeys);

  return ok(c, { deleted: fileCount, size: totalSize });
});

// ============ 移动（Saga：复制 → 校验 → 原子切换 → 异步清理源，复用 services/move） ============
fileOpsRoutes.post('/:id/move', async (c) => {
  const { file, db } = await resolveFile(c);
  const body = await c.req.json().catch(() => null);
  const parsed = MoveFileSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('缺少目标路径');
  // §H：挂载点目录行不可移动；移动含挂载点的目录会让挂载点路径与目录行脱节
  if (await isMountPointFile(db, file)) {
    throw new ApiError(409, 'OPERATION_FAILED', '挂载点目录由系统维护，请在存储配置中修改挂载路径');
  }
  if (file.type === 'folder' && (await containsMountPointFile(db, file))) {
    throw new ApiError(409, 'OPERATION_FAILED', '该目录下存在挂载点，无法移动');
  }
  const targetPath = normalizePath(parsed.data.targetPath);

  const job = await moveWithSaga(c, { fileId: file.id, targetDir: targetPath });
  return ok(c, { jobId: job.id, status: job.status });
});

// ============ 任务状态 ============
fileOpsRoutes.get('/jobs/:jobId', async (c) => {
  const db = getDb(c);
  const job = await JobRepo.getJob(db, c.req.param('jobId'));
  if (!job || job.userId !== c.get('userId')) throw new ApiError(404, 'NOT_FOUND', '任务不存在');
  return ok(c, {
    job: {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    },
  });
});

// ============ 批量操作 ============
fileOpsRoutes.post('/batch', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = BatchOpSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('批量参数无效');
  const { action, fileIds, targetPath } = parsed.data;

  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of fileIds) {
    try {
      const file = await FileRepo.getFileById(db, id);
      if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
      const mount = await MountRepo.getMountById(db, file.mountId);
      if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');

      if (action === 'delete') {
        if (await isMountPointFile(db, file)) {
          throw new ApiError(409, 'OPERATION_FAILED', '挂载点目录由系统维护，请在存储配置中删除挂载点');
        }
        if (file.type === 'folder' && (await containsMountPointFile(db, file))) {
          throw new ApiError(409, 'OPERATION_FAILED', '该目录下存在挂载点，请先删除对应挂载点');
        }
        await requirePermission(c, mount, filePermPath(file), 'delete', file.ownerId, undefined, undefined, undefined, file.providerId ?? undefined);
        const { targets, totalSize: size } = await collectDeleteTargets(db, mount.id, file);
        // 按文件行属主分组扣减用户配额
        const deltas = quotaDeltas(targets);
        const blobHashes = blobHashesOf(targets);
        const keys = directObjectsOf(targets);
        await db.transaction(async (tx) => {
          if (file.type === 'folder') {
            const [sql, params] = subtreeDeleteSql(mount.id, file.path);
            await tx.query(sql, params);
          } else {
            await tx.query(`DELETE FROM file_metadata WHERE id = ?`, [file.id]);
          }
          for (const delta of deltas) {
            await tx.query(
              `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ?), used_files = MAX(0, used_files - ?), updated_at = ? WHERE user_id = ?`,
              [delta.size, delta.count, Date.now(), delta.ownerId]
            );
          }
          await tx.query(
            `UPDATE mounts SET used_storage = MAX(0, used_storage - ?), updated_at = ? WHERE id = ?`,
            [size, Date.now(), mount.id]
          );
          await tx.query(`DELETE FROM shares WHERE file_id = ?`, [file.id]);
          await ShareRepo.deleteEmptyShares(tx);
          await releaseBlobsTx(tx, blobHashes, Date.now());
        });
        if (keys.length > 0) await cleanupObjects(c, mount.id, keys);
        succeeded.push(id);
      } else if (action === 'move') {
        if (await isMountPointFile(db, file)) {
          throw new ApiError(409, 'OPERATION_FAILED', '挂载点目录由系统维护，请在存储配置中修改挂载路径');
        }
        if (file.type === 'folder' && (await containsMountPointFile(db, file))) {
          throw new ApiError(409, 'OPERATION_FAILED', '该目录下存在挂载点，无法移动');
        }
        if (!targetPath) throw ApiError.badRequest('移动需要 targetPath');
        const tPath = normalizePath(targetPath);
        const job = await moveWithSaga(c, { fileId: id, targetDir: tPath });
        if (job.status === 'failed') {
          throw new ApiError(422, 'OPERATION_FAILED', job.errorMessage ?? '移动失败');
        }
        succeeded.push(id);
      }
    } catch (err) {
      failed.push({ id, error: err instanceof ApiError ? err.message : '操作失败' });
    }
  }

  return ok(c, { succeeded, failed });
});
