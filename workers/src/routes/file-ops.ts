// 文件路由 B：删除、移动、批量操作、任务状态
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { z } from 'zod';
import { FileRepo, MountRepo, JobRepo, ReconciliationRepo, ProviderRepo } from '../db';
import { getDb } from '../middleware/auth';
import { getPrincipal, requirePermission } from '../services/principal';
import { checkMovePermission, loadPrincipalRules } from '../services/permission';
import { getProvider } from '../providers';
import { ok } from '../utils/response';
import { ApiError } from '../utils/errors';
import { normalizePath, isPathWithinBoundary } from '../utils/path';
import { toFileListItem } from '../db/repos/files';
import type { Env } from '../types';

const moveSchema = z.object({ targetPath: z.string().min(1) });
const batchSchema = z.object({
  action: z.enum(['delete', 'move']),
  fileIds: z.array(z.string()).min(1).max(100),
  targetPath: z.string().optional(),
  permanent: z.boolean().optional(),
});

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

function ipOf(c: Parameters<typeof ok>[0]): string | undefined {
  const cf = (c.req.raw as Request & { cf?: { connectingIp?: string } }).cf;
  if (cf?.connectingIp) return cf.connectingIp;
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? undefined;
}

async function cleanupObjects(c: Parameters<typeof ok>[0], mountId: string, objectKeys: string[]) {
  const db = getDb(c);
  const mount = await MountRepo.getMountById(db, mountId);
  if (!mount) return;
  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) return;
  try {
    const provider = await getProvider(db, providerRow, c.env as Env);
    for (const key of objectKeys) {
      if (key.startsWith('folder:')) continue;
      try {
        await provider.deleteObject(key);
      } catch (err) {
        await ReconciliationRepo.createOrphanObject(db, {
          mountId,
          objectKey: key,
          reason: 'deletion_failed',
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
  } catch {
    // 清理失败由对账任务处理
  }
}

// ============ 删除（硬删除） ============
fileOpsRoutes.delete('/:id', async (c) => {
  const { file, mount, db } = await resolveFile(c);
  await requirePermission(c, mount, file.path, 'delete', file.ownerId);

  let objectKeys: string[] = [];
  let totalSize = 0;
  let fileCount = 0;

  if (file.type === 'folder') {
    const descendants = await FileRepo.listDescendants(db, mount.id, file.path);
    objectKeys = descendants.filter((d) => d.type === 'file').map((d) => d.objectKey);
    totalSize = descendants.reduce((sum, d) => sum + d.size, 0);
    fileCount = descendants.length;
  } else {
    objectKeys = [file.objectKey];
    totalSize = file.size;
    fileCount = 1;
  }

  await db.transaction(async (tx) => {
    if (file.type === 'folder') {
      await tx.query(
        `DELETE FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ?)`,
        [mount.id, file.path, `${file.path}/%`]
      );
    } else {
      await tx.query(`DELETE FROM file_metadata WHERE id = ?`, [file.id]);
    }
    await tx.query(
      `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ?), used_files = MAX(0, used_files - ?), updated_at = ? WHERE user_id = ?`,
      [totalSize, fileCount, Date.now(), file.ownerId]
    );
    await tx.query(
      `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
       VALUES (?, ?, 'delete', ?, ?, ?, ?, ?, 200, ?)`,
      [crypto.randomUUID(), c.get('userId'), file.path, JSON.stringify({ fileCount }), ipOf(c), c.req.header('user-agent'), totalSize, Date.now()]
    );
    await tx.query(`DELETE FROM shares WHERE file_id = ?`, [file.id]);
  });

  await cleanupObjects(c, mount.id, objectKeys);

  return ok(c, { deleted: fileCount, size: totalSize });
});

// ============ 移动（Saga：复制 → 校验 → 原子切换 → 异步清理源） ============
fileOpsRoutes.post('/:id/move', async (c) => {
  const { file, mount, db } = await resolveFile(c);
  const body = await c.req.json().catch(() => null);
  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('缺少目标路径');
  const targetPath = normalizePath(parsed.data.targetPath);

  if (file.type === 'folder' && isPathWithinBoundary(targetPath, file.path)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '不能将文件夹移动到自身内部');
  }

  const targetMount = await MountRepo.findMountForPath(db, targetPath);
  if (!targetMount) throw new ApiError(404, 'NOT_FOUND', '目标路径不存在');

  const principal = await getPrincipal(c);
  const rules = await loadPrincipalRules(db, principal);
  const allowed = checkMovePermission(principal, mount, targetMount, file.path, targetPath, rules, file.ownerId);
  if (!allowed) throw new ApiError(403, 'FORBIDDEN', '无权移动文件');

  const targetName = file.name;
  const targetFullPath = targetPath === '/' ? `/${targetName}` : `${targetPath}/${targetName}`;
  const conflict = await FileRepo.getFileAtPath(db, targetMount.id, targetPath, targetName);
  if (conflict && conflict.id !== file.id) throw new ApiError(409, 'ALREADY_EXISTS', '目标位置已存在同名文件');

  // 目标对象键
  const mountCfg = await MountRepo.getMountById(db, targetMount.id);
  const providerRow = await ProviderRepo.getProviderById(db, mountCfg!.providerId);
  const pathPrefix = providerRow?.pathPrefix ?? '';
  const { objectKeyFromPath } = await import('../utils/path');
  const targetObjectKey = objectKeyFromPath(targetMount.mountPath, pathPrefix, targetFullPath);

  // 创建操作任务
  const job = await JobRepo.createJob(db, {
    userId: c.get('userId'),
    type: 'move',
    fileId: file.id,
    sourcePath: file.path,
    targetPath: targetFullPath,
    mountId: file.mountId,
    stateData: JSON.stringify({
      phase: 'init',
      sourceObjectKey: file.objectKey,
      sourceMountId: file.mountId,
      targetMountId: targetMount.id,
      targetObjectKey,
      destDir: targetPath,
      targetFullPath,
      isFolder: file.type === 'folder',
    }),
  });

  // 同步执行（本地场景）——任务完成或失败
  try {
    await executeMove(c, job.id);
  } catch (err) {
    // 失败状态已写入
  }

  const updated = await JobRepo.getJob(db, job.id);
  return ok(c, { jobId: job.id, status: updated?.status ?? 'pending' });
});

async function executeMove(c: Parameters<typeof ok>[0], jobId: string) {
  const db = getDb(c);
  const job = await JobRepo.getJob(db, jobId);
  if (!job) throw new ApiError(404, 'NOT_FOUND', '任务不存在');
  const state = JSON.parse(job.stateData ?? '{}') as {
    sourceObjectKey: string;
    sourceMountId: string;
    targetMountId: string;
    targetObjectKey: string;
    destDir: string;
    targetFullPath: string;
    isFolder?: boolean;
  };

  try {
    await JobRepo.updateJob(db, jobId, { status: 'running', started_at: Date.now(), state_data: JSON.stringify({ ...state, phase: 'copying' }) });

    const sourceMount = await MountRepo.getMountById(db, state.sourceMountId);
    const targetMount = await MountRepo.getMountById(db, state.targetMountId);
    const sourceRow = sourceMount ? await ProviderRepo.getProviderById(db, sourceMount.providerId) : null;
    const targetRow = targetMount ? await ProviderRepo.getProviderById(db, targetMount.providerId) : null;
    if (!sourceRow || !targetRow) throw new Error('Provider not found');
    const sourceProvider = await getProvider(db, sourceRow, c.env as Env);
    const targetProvider = await getProvider(db, targetRow, c.env as Env);

    if (state.sourceMountId === state.targetMountId) {
      if (state.sourceObjectKey.startsWith('folder:')) {
        // 文件夹对象无需复制
      } else {
        await sourceProvider.copyObject(state.sourceObjectKey, state.targetObjectKey);
      }
    } else {
      const obj = await sourceProvider.getObject(state.sourceObjectKey);
      if (!obj) throw new Error('Source object not found');
      await targetProvider.putObject(state.targetObjectKey, obj.body, obj.contentType);
    }

    await JobRepo.updateJob(db, jobId, { state_data: JSON.stringify({ ...state, phase: 'verifying' }), progress: 70 });

    // 校验目标对象（非文件夹）
    if (!state.sourceObjectKey.startsWith('folder:')) {
      const head = await targetProvider.headObject(state.targetObjectKey);
      const file = await FileRepo.getFileById(db, job.fileId as string);
      if (!head || (file && head.size !== file.size)) {
        throw new Error('Size mismatch after copy');
      }
    }

    await JobRepo.updateJob(db, jobId, { state_data: JSON.stringify({ ...state, phase: 'committing' }), progress: 90 });

    // 原子切换元数据
    await db.transaction(async (tx) => {
      const sourcePath = job.sourcePath;
      const destDir = state.destDir ?? '/';
      const itemFull = state.targetFullPath ?? state.targetObjectKey;
      // 项目本身：path 更新为父目录（destDir），文件夹保留伪对象键
      await tx.query(
        `UPDATE file_metadata SET
           path = ?,
           object_key = CASE WHEN ? THEN object_key ELSE ? END,
           mount_id = ?,
           source_cleanup_pending = 1,
           old_object_key = CASE WHEN ? THEN ? ELSE NULL END,
           updated_at = ?
         WHERE id = ?`,
        [destDir, state.isFolder, state.targetObjectKey, state.targetMountId, state.sourceObjectKey, state.sourceObjectKey, Date.now(), job.fileId]
      );
      // 子项：将 sourcePath/ 前缀替换为 itemFull/
      await tx.query(
        `UPDATE file_metadata SET path = ? || substr(path, ?), updated_at = ? WHERE path LIKE ?`,
        [itemFull, sourcePath.length + 1, Date.now(), `${sourcePath}/%`]
      );
      await tx.query(
        `UPDATE operation_jobs SET status = 'completed', completed_at = ?, progress = 100 WHERE id = ?`,
        [Date.now(), jobId]
      );
    });

    // 异步清理源对象（此处直接清理）
    await cleanupObjects(c, state.sourceMountId, [state.sourceObjectKey]);
    // 清理标记
    await FileRepo.updateFile(db, job.fileId as string, { source_cleanup_pending: 0, old_object_key: null });
  } catch (err) {
    // 补偿：删除已复制的目标对象
    try {
      await cleanupObjects(c, state.targetMountId, [state.targetObjectKey]);
    } catch {
      // ignore
    }
    await JobRepo.updateJob(db, jobId, {
      status: 'failed',
      error_message: err instanceof Error ? err.message : '移动失败',
      completed_at: Date.now(),
    });
  }
}

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
  const parsed = batchSchema.safeParse(body);
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
        await requirePermission(c, mount, file.path, 'delete', file.ownerId);
        let keys: string[] = [];
        let size = file.size;
        let count = 1;
        if (file.type === 'folder') {
          const desc = await FileRepo.listDescendants(db, mount.id, file.path);
          keys = desc.filter((d) => d.type === 'file').map((d) => d.objectKey);
          size = desc.reduce((s, d) => s + d.size, 0);
          count = desc.length;
        } else {
          keys = [file.objectKey];
        }
        await db.transaction(async (tx) => {
          if (file.type === 'folder') {
            await tx.query(`DELETE FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ?)`, [mount.id, file.path, `${file.path}/%`]);
          } else {
            await tx.query(`DELETE FROM file_metadata WHERE id = ?`, [file.id]);
          }
          await tx.query(
            `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ?), used_files = MAX(0, used_files - ?), updated_at = ? WHERE user_id = ?`,
            [size, count, Date.now(), file.ownerId]
          );
          await tx.query(`DELETE FROM shares WHERE file_id = ?`, [file.id]);
        });
        await cleanupObjects(c, mount.id, keys);
        succeeded.push(id);
      } else if (action === 'move') {
        if (!targetPath) throw ApiError.badRequest('移动需要 targetPath');
        const tPath = normalizePath(targetPath);
        const targetMount = await MountRepo.findMountForPath(db, tPath);
        if (!targetMount) throw new ApiError(404, 'NOT_FOUND', '目标路径不存在');
        const principal = await getPrincipal(c);
        const rules = await loadPrincipalRules(db, principal);
        if (!checkMovePermission(principal, mount, targetMount, file.path, tPath, rules, file.ownerId)) {
          throw new ApiError(403, 'FORBIDDEN', '无权移动');
        }
        const targetFull = tPath === '/' ? `/${file.name}` : `${tPath}/${file.name}`;
        // 项目本身 path = 目标目录；子项前缀替换为目标完整路径
        await FileRepo.updateFile(db, file.id, { path: tPath, mount_id: targetMount.id });
        await db.run(
          `UPDATE file_metadata SET path = ? || substr(path, ?), updated_at = ? WHERE path LIKE ?`,
          [targetFull, file.path.length + 1, Date.now(), `${file.path}/%`]
        );
        succeeded.push(id);
      }
    } catch (err) {
      failed.push({ id, error: err instanceof ApiError ? err.message : '操作失败' });
    }
  }

  return ok(c, { succeeded, failed });
});

export { toFileListItem };
