// 移动操作 Saga（复制 → 校验 → 原子切换 → 异步清理源，带失败补偿）
// 审计 H-4：主文件 API 与 WebDAV MOVE 统一走此服务，禁止各入口直接改 file_metadata。
import type { Context } from 'hono';
import { FileRepo, MountRepo, JobRepo, ReconciliationRepo, ProviderRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { getPrincipal } from '../permissions/principal';
import { checkMovePermission, loadPrincipalRules } from '../permissions/check';
import { getProvider } from '../storage/providers';
import { COPY_OBJECT_MAX_BYTES } from '../storage/s3';
import { ApiError } from '../../shared/errors';
import { normalizePath, isPathWithinBoundary } from '../../utils/path';
import type { Env } from '../../shared/types';

type Ctx = Parameters<typeof getPrincipal>[0];

async function cleanupObjects(c: Ctx, mountId: string, objectKeys: string[]) {
  const db = getDb(c);
  const mount = await MountRepo.getMountById(db, mountId);
  if (!mount) return;
  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) return;
  try {
    const provider = await getProvider(db, providerRow, c.env as Env);
    const keys = objectKeys.filter((key) => !key.startsWith('folder:'));
    if (keys.length === 0) return;
    try {
      // P1-4：批量删除（单请求 ≤1000），替代 N 次单对象删除
      await provider.deleteObjects(keys);
    } catch (batchErr) {
      // 批量失败回退逐个删除，孤儿精确记录
      for (const key of keys) {
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
      void batchErr;
    }
  } catch {
    // 清理失败由对账任务处理
  }
}

export { cleanupObjects };

/**
 * 移动文件（Saga）：校验权限/冲突/循环 → 建任务 → 复制+校验 → 原子切换元数据 → 异步清理源对象。
 * 返回完成后的任务记录（用于响应）。
 */
export async function moveWithSaga(
  c: Ctx,
  opts: { fileId: string; targetDir: string; targetName?: string }
): Promise<NonNullable<Awaited<ReturnType<typeof JobRepo.getJob>>>> {
  const db = getDb(c);
  const file = await FileRepo.getFileById(db, opts.fileId);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  const mount = await MountRepo.getMountById(db, file.mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');

  const targetDir = normalizePath(opts.targetDir);
  const targetName = opts.targetName ?? file.name;
  const targetFullPath = targetDir === '/' ? `/${targetName}` : `${targetDir}/${targetName}`;

  // 文件夹不能移动到自身内部（含移动到自身）
  if (file.type === 'folder' && isPathWithinBoundary(targetFullPath, file.path)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '不能将文件夹移动到自身内部');
  }

  const targetMount = await MountRepo.findMountForPath(db, targetFullPath);
  if (!targetMount) throw new ApiError(404, 'NOT_FOUND', '目标路径不存在');

  // 源 delete + 目标 write 双重权限
  const principal = await getPrincipal(c);
  // 网关密钥数据层所有者隔离：密钥不能移动属主之外的文件
  if (principal.type === 'apiKey' && file.ownerId !== principal.id) {
    throw new ApiError(403, 'FORBIDDEN', '无权操作其他用户的文件');
  }
  const rules = await loadPrincipalRules(db, principal, mount.id);
  // 源 delete 检查走文件全路径（文件行 path=父目录；父目录 pattern 仍继承匹配）
  const sourceCheckPath =
    file.type === 'folder' ? file.path : (file.path === '/' ? `/${file.name}` : `${file.path}/${file.name}`);
  const allowed = checkMovePermission(principal, mount, targetMount, sourceCheckPath, targetFullPath, rules, file.ownerId);
  if (!allowed) throw new ApiError(403, 'FORBIDDEN', '无权移动文件');

  // 目标同名冲突
  const conflict = await FileRepo.getFileAtPath(db, targetMount.id, targetDir, targetName);
  if (conflict && conflict.id !== file.id) throw new ApiError(409, 'ALREADY_EXISTS', '目标位置已存在同名文件');

  // 目标对象键
  const mountCfg = await MountRepo.getMountById(db, targetMount.id);
  const providerRow = await ProviderRepo.getProviderById(db, mountCfg!.providerId);
  const pathPrefix = providerRow?.pathPrefix ?? '';
  const { objectKeyFromPath } = await import('../../utils/path');
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
      destDir: targetDir,
      targetFullPath,
      isFolder: file.type === 'folder',
    }),
  });

  // 同步执行（本地场景）——任务完成或失败状态已写入
  try {
    await executeMove(c, job.id);
  } catch {
    // 失败状态已在 executeMove 内记录
  }

  const updated = await JobRepo.getJob(db, job.id);
  return (updated as NonNullable<typeof updated>)!;
}

async function executeMove(c: Ctx, jobId: string) {
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
    await JobRepo.updateJob(db, jobId, {
      status: 'running',
      started_at: Date.now(),
      state_data: JSON.stringify({ ...state, phase: 'copying' }),
    });

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
        // P1-2：>5GB 走 UploadPartCopy 分片复制（AWS CopyObject 单命令上限）
        const file = await FileRepo.getFileById(db, job.fileId as string);
        if (file && file.size > COPY_OBJECT_MAX_BYTES && sourceProvider.copyObjectMultipart) {
          await sourceProvider.copyObjectMultipart(state.sourceObjectKey, state.targetObjectKey);
        } else {
          await sourceProvider.copyObject(state.sourceObjectKey, state.targetObjectKey);
        }
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

    // 原子切换元数据（含重命名：name 取目标完整路径最后一段）
    await db.transaction(async (tx) => {
      const sourcePath = job.sourcePath;
      const destDir = state.destDir ?? '/';
      const itemFull = state.targetFullPath ?? state.targetObjectKey;
      const targetName = itemFull.split('/').filter(Boolean).pop() ?? '';
      // 项目本身：path 更新为父目录（destDir），文件夹保留伪对象键
      await tx.query(
        `UPDATE file_metadata SET
           name = ?,
           path = ?,
           object_key = CASE WHEN ? THEN object_key ELSE ? END,
           mount_id = ?,
           source_cleanup_pending = 1,
           old_object_key = CASE WHEN ? THEN ? ELSE NULL END,
           updated_at = ?
         WHERE id = ?`,
        [targetName, destDir, state.isFolder, state.targetObjectKey, state.targetMountId, state.sourceObjectKey, state.sourceObjectKey, Date.now(), job.fileId]
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
