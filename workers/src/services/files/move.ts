// 移动操作 Saga（复制 → 校验 → 原子切换 → 异步清理源，带失败补偿）
// 主文件 API 与 WebDAV MOVE 统一走此服务，各入口禁止直接改 file_metadata。
import type { Context } from 'hono';
import { FileRepo, MountRepo, JobRepo, ReconciliationRepo, ProviderRepo, MountQuotaRepo, MountProviderQuotaRepo, ReservationRepo } from '../../db';
import type { OperationJob } from '../../db';
import { getDb } from '../../middleware/auth';
import { getPrincipal, requirePermission } from '../permissions/principal';
import { getProvider } from '../storage/providers';
import { pickWriteProvider } from '../storage/pool';
import { COPY_OBJECT_MAX_BYTES } from '../storage/s3';
import { ApiError } from '../../shared/errors';
import { normalizePath, isPathWithinBoundary, objectKeyFromPath, escapeLikePattern } from '../../utils/path';
import { assertWritable } from './upload-mode';
import type { Env } from '../../shared/types';
import type { StorageProvider } from '@shared/types';

type Ctx = Parameters<typeof getPrincipal>[0];

/**
 * 文件全路径基准（与 handlers.ts 的 filePermPath 同义）：文件行 path=父目录，
 * 文件夹行 path=自身全路径。MOVE 源侧 delete 判定与单点 DELETE 一致使用该基准。
 */
function filePermPath(f: { path: string; name: string; type: 'file' | 'folder' }): string {
  if (f.type === 'folder') return f.path;
  return f.path === '/' ? `/${f.name}` : `${f.path}/${f.name}`;
}

async function cleanupObjects(c: Ctx, mountId: string, objects: Array<{ providerId?: string | null; objectKey: string }>) {
  const db = getDb(c);
  const mount = await MountRepo.getMountById(db, mountId);
  if (!mount) return;
  // §E 存储池：按落桶分组删除（池内对象的删除目标 provider 可能不同）
  const groups = new Map<string, string[]>();
  for (const obj of objects) {
    if (obj.objectKey.startsWith('folder:')) continue;
    const pid = obj.providerId ?? mount.providerId;
    const list = groups.get(pid);
    if (list) list.push(obj.objectKey);
    else groups.set(pid, [obj.objectKey]);
  }
  for (const [providerId, keys] of groups) {
    if (keys.length === 0) continue;
    try {
      const providerRow = await ProviderRepo.getProviderById(db, providerId);
      if (!providerRow) continue;
      const provider = await getProvider(db, providerRow, c.env as Env);
      try {
        // 批量删除（单请求 ≤1000 个键），替代 N 次单对象删除
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

  // 跨挂载点移动文件夹会撕裂子树：主行切到目标挂载后，子项 UPDATE 只改 path 前缀，
  // 子树的 mount_id 无法在同一事务内一致迁移（还与嵌套挂载点目录行、容量统计纠缠），
  // 直接阻断以避免产生新的孤儿子树；存量孤儿由清扫任务 repairMovedFolderOrphans 自愈。
  if (file.type === 'folder' && file.mountId !== targetMount.id) {
    throw new ApiError(422, 'OPERATION_FAILED', '暂不支持跨挂载点移动文件夹');
  }

  // blob 内容寻址对象的物理键与 (hash, mount_id) 索引一起绑定在源挂载池。跨挂载只改元数据
  // 会把物理对象留在源挂载（目标容量/GC 边界与物理归属撕裂）→ 暂时拒绝；同挂载改名/移动不受影响。
  // 以后若要支持：必须复制到目标池、切换 provider_id/physical_key、在目标挂载登记 blob 索引，
  // 并在提交后按引用安全释放源对象，不能只改元数据。
  // 该能力判定放在**两侧权限检查之后**：先授权、后能力，否则会以 422 抢先于 403、掩盖权限拒绝结果，
  // 该顺序不可调整。

  // 源侧 delete + 目标侧 write 双重权限校验：移动同时作用于两个挂载点，任一权限不足即拒绝
  const principal = await getPrincipal(c);
  // 网关密钥数据层所有者隔离：密钥不能移动属主之外的文件
  if (principal.type === 'apiKey' && file.ownerId !== principal.id) {
    throw new ApiError(403, 'FORBIDDEN', '无权操作其他用户的文件');
  }
  // 源侧 delete：文件全路径基准（文件行 path=父目录，父目录 pattern 经 pathMatches 继承仍匹配）+
  // 源文件实际落桶 providerId —— requirePermission 内部加载挂载点级（§28）与桶级（§31）矩阵，
  // 与读/写/删入口同源，堵住「挂载级 deny delete / 桶级 deny delete 对移动失效」的旁路。
  await requirePermission(
    c,
    mount,
    filePermPath(file),
    'delete',
    file.ownerId,
    undefined,
    undefined,
    undefined,
    file.providerId ?? undefined
  );

  // §28 写入口模式：目标位置同样受写入口约束（user_space 下只能移入自身空间、flat 无路径约束）。
  // 移动**不转移属主**（提交事务不改 owner_id），目标 user_space 必须按 file.ownerId 判定；
  // 按发起者判定会让属主 Y 的文件被移入发起者 X 的空间，物理路径与配额/权限属主不一致。
  await assertWritable(db, targetMount, file.ownerId, targetFullPath);

  // 目标同名冲突双检：文件行（path=父目录）与文件夹行（path=自身全路径）都要查。
  // 只查文件行会漏掉同名文件夹——随后写出的文件行与既有文件夹语义相同而对象键不同，
  // 唯一约束不必然阻断，列表/路径解析/删除会按查询顺序给出同名异类型行。
  const conflict = await FileRepo.getFileAtPath(db, targetMount.id, targetDir, targetName);
  if (conflict && conflict.id !== file.id) throw new ApiError(409, 'ALREADY_EXISTS', '目标位置已存在同名文件');
  const folderConflict = await FileRepo.getFolderAtPath(db, targetMount.id, targetFullPath, targetName);
  if (folderConflict && folderConflict.id !== file.id) {
    throw new ApiError(409, 'ALREADY_EXISTS', '目标位置已存在同名文件夹');
  }

  // 目标对象键（§E：目标 provider 按池策略选定；同挂载移动复用源落桶，避免无谓跨桶拷贝）。
  // 跨挂载移动同时持有**挂载级**与**成员级**预留（同一 file.size）——成员级由
  // pickWriteProvider 缺省预留，挂载级在其后条件 UPDATE 预留；提交事务内完成 transfer
  // （目标 used_storage +size / quota_reserved -size、源 used_storage -size、成员预留同批释放）。
  // 同挂载移动复用源落桶（源 provider 行存在时不再选桶），用量不变、无需任何预留。
  const isCrossMount = file.mountId !== targetMount.id;
  let targetProviderRow: StorageProvider;
  if (!isCrossMount) {
    targetProviderRow =
      (await ProviderRepo.getProviderById(db, file.providerId ?? targetMount.providerId)) ??
      (await pickWriteProvider(db, targetMount, targetFullPath, c.env as Env, file.size, {
        reserve: false,
        principalRole: principal.role,
      }));
  } else {
    // 成员级容量不足 → 413；桶级矩阵全拒 → 403（§30/§31）
    targetProviderRow = await pickWriteProvider(db, targetMount, targetFullPath, c.env as Env, file.size, {
      principalRole: principal.role,
    });
  }
  // 目标侧 write：目标全路径 + 目标落桶 providerId。同挂载复用源桶时 providerId 即源桶，
  // 桶级矩阵同样生效；挂载点级 deny write 的挂载在此被拦。
  // 判定先于对象拷贝/任务创建，绝不先落盘后判权。
  await requirePermission(
    c,
    targetMount,
    targetFullPath,
    'write',
    file.ownerId,
    undefined,
    file.visibility,
    undefined,
    targetProviderRow.id
  );
  // 挂载级预留：条件 UPDATE 原子判定目标挂载 max_storage——避免「先 fits 后 UPDATE」
  // 的 TOCTOU（并发移动/上传共同挤爆挂载上限）。预留失败要把已持有的成员级预留一并释放。
  let reservationId: string | null = null;
  if (isCrossMount) {
    // 两侧权限均已通过后才做能力判定：blob 内容寻址对象跨挂载只改元数据会把物理对象
    // 留在源挂载（目标容量/GC 边界与物理归属撕裂）→ 暂时 422（先释放刚选桶时持有的成员级预留）。
    if (file.type === 'file' && file.blobHash) {
      await MountProviderQuotaRepo.release(db, targetMount.id, targetProviderRow.id, file.size);
      throw new ApiError(422, 'OPERATION_FAILED', '内容寻址文件暂不支持跨挂载点移动，请复制到目标挂载点后删除源文件');
    }
    const mountReserved = await MountQuotaRepo.reserve(db, targetMount.id, file.size);
    if (!mountReserved) {
      await MountProviderQuotaRepo.release(db, targetMount.id, targetProviderRow.id, file.size);
      throw new ApiError(413, 'MOUNT_QUOTA_EXCEEDED', '目标挂载点容量不足');
    }
    // 移动的成员级预留单独登记台账：对账若只按在途会话重算会把该预留归零，台账提供独立来源（跨请求窗口较长）
    try {
      reservationId = await ReservationRepo.create(db, {
        mountId: targetMount.id,
        providerId: targetProviderRow.id,
        size: file.size,
      });
    } catch (err) {
      await MountQuotaRepo.releaseReservation(db, targetMount.id, file.size);
      await MountProviderQuotaRepo.release(db, targetMount.id, targetProviderRow.id, file.size);
      throw err;
    }
  }
  const targetObjectKey = objectKeyFromPath(targetMount.mountPath, targetProviderRow.pathPrefix ?? '', targetFullPath);

  // 创建操作任务（建任务失败也必须释放本次持有的两层预留）
  let job: OperationJob;
  try {
    job = await JobRepo.createJob(db, {
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
        sourceProviderId: file.providerId ?? mount.providerId,
        targetMountId: targetMount.id,
        targetProviderId: targetProviderRow.id,
        targetObjectKey,
        destDir: targetDir,
        targetFullPath,
        isFolder: file.type === 'folder',
        // 预留标记：仅跨挂载移动持有；executeMove 成功在提交事务内转已用/释放，失败在补偿里释放
        memberReserved: isCrossMount,
        reservedSize: isCrossMount ? file.size : 0,
        reservationId,
      }),
    });
  } catch (err) {
    if (isCrossMount) {
      await MountQuotaRepo.releaseReservation(db, targetMount.id, file.size);
      await MountProviderQuotaRepo.release(db, targetMount.id, targetProviderRow.id, file.size);
      if (reservationId) await ReservationRepo.remove(db, reservationId);
    }
    throw err;
  }

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
    sourceProviderId?: string;
    targetMountId: string;
    targetProviderId?: string;
    targetObjectKey: string;
    destDir: string;
    targetFullPath: string;
    isFolder?: boolean;
    /** 跨挂载移动持有的成员级/挂载级预留标记与预留字节数 */
    memberReserved?: boolean;
    reservedSize?: number;
    /** 直写预留台账行 id（提交/失败时删除） */
    reservationId?: string | null;
  };

  // §F 内容寻址：blob_hash 非空的文件其物理对象与虚拟路径解耦 → 移动/改名是纯元数据操作
  const movingFile = await FileRepo.getFileById(db, job.fileId as string);
  const isBlobBacked = !!movingFile?.blobHash && movingFile.type === 'file';

  try {
    await JobRepo.updateJob(db, jobId, {
      status: 'running',
      started_at: Date.now(),
      state_data: JSON.stringify({ ...state, phase: 'copying' }),
    });

    const sourceMount = await MountRepo.getMountById(db, state.sourceMountId);
    const targetMount = await MountRepo.getMountById(db, state.targetMountId);
    const sourceRow = sourceMount
      ? await ProviderRepo.getProviderById(db, state.sourceProviderId ?? sourceMount.providerId)
      : null;
    const targetRow = targetMount
      ? await ProviderRepo.getProviderById(db, state.targetProviderId ?? targetMount.providerId)
      : null;
    if (!sourceRow || !targetRow) throw new Error('Provider not found');
    const sourceProvider = await getProvider(db, sourceRow, c.env as Env);
    const targetProvider = await getProvider(db, targetRow, c.env as Env);

    if (isBlobBacked) {
      // 内容寻址对象由内容哈希决定键，目标文件直接引用同一对象（无需复制、无跨桶残留）
    } else if (state.sourceMountId === state.targetMountId) {
      if (state.sourceObjectKey.startsWith('folder:')) {
        // 文件夹对象无需复制
      } else {
        // >5GB 走 UploadPartCopy 分片复制：AWS CopyObject 单命令有大小上限
        if (movingFile && movingFile.size > COPY_OBJECT_MAX_BYTES && sourceProvider.copyObjectMultipart) {
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

    // 校验目标对象（非文件夹；内容寻址文件未复制对象，无需校验）
    if (!isBlobBacked && !state.sourceObjectKey.startsWith('folder:')) {
      const head = await targetProvider.headObject(state.targetObjectKey);
      if (!head || (movingFile && head.size !== movingFile.size)) {
        throw new Error('Size mismatch after copy');
      }
    }

    await JobRepo.updateJob(db, jobId, { state_data: JSON.stringify({ ...state, phase: 'committing' }), progress: 90 });

    // 提交事务是只写批（D1 batch，tx 内不可读）：容量转移所需的文件大小在事务外读取一次，
    // 事务内不再用外层 db 句柄读取，避免依赖隔离语义。
    const movedFile = await FileRepo.getFileById(db, job.fileId as string);
    const movedSize = movedFile?.size ?? movingFile?.size ?? 0;
    const isCrossMountMove = state.sourceMountId !== state.targetMountId;

    // 原子切换元数据（含重命名：name 取目标完整路径最后一段）
    await db.transaction(async (tx) => {
      const sourcePath = job.sourcePath;
      const destDir = state.destDir ?? '/';
      const itemFull = state.targetFullPath ?? state.targetObjectKey;
      const targetName = itemFull.split('/').filter(Boolean).pop() ?? '';
      // 主行 path：文件行 = 父目录 destDir；文件夹行 = 自身全路径 itemFull（§H 约定，与创建/列目录一致）。
      // 若文件夹行写 destDir，移动后目录行不在目标目录的子项谓词内 → 目录及其子树不可列出/不可删除。
      const mainPath = state.isFolder ? itemFull : destDir;
      // §F：内容寻址文件保留原落桶 provider（对象留在原桶），因此不置清理标记、无需旧键清理
      const keepProviderId = isBlobBacked ? (movingFile?.providerId ?? state.sourceProviderId ?? null) : (state.targetProviderId ?? null);
      await tx.query(
        `UPDATE file_metadata SET
           name = ?,
           path = ?,
           object_key = CASE WHEN ? THEN object_key ELSE ? END,
           mount_id = ?,
           provider_id = ?,
           source_cleanup_pending = ?,
           old_object_key = CASE WHEN ? THEN ? ELSE NULL END,
           updated_at = ?
         WHERE id = ?`,
        [targetName, mainPath, state.isFolder, state.targetObjectKey, state.targetMountId, keepProviderId, isBlobBacked ? 0 : 1, isBlobBacked ? 0 : state.sourceObjectKey, isBlobBacked ? null : state.sourceObjectKey, Date.now(), job.fileId]
      );
      // 子项：仅文件夹有子树（文件移动无子项；未加此门会让「path 前缀」误改父目录的兄弟子树）。
      // 前缀匹配必须 `ESCAPE '\'` 且目录名先经 escapeLikePattern——文件夹名可含 `%`/`_`，
      // 原样拼接会把它们当通配符误伤 `/a/100x/` 这类兄弟目录。限定源挂载点与主行迁移语义一致。
      if (state.isFolder) {
        // 直接子文件行的 path = 父目录 = sourcePath（文件夹主行已在上一条改成自身全路径 itemFull，不再等于 sourcePath）
        await tx.query(
          `UPDATE file_metadata SET path = ?, updated_at = ? WHERE mount_id = ? AND path = ?`,
          [itemFull, Date.now(), state.sourceMountId, sourcePath]
        );
        // 更深层子项：将 sourcePath/ 前缀替换为 itemFull/
        await tx.query(
          `UPDATE file_metadata SET path = ? || substr(path, ?), updated_at = ? WHERE mount_id = ? AND path LIKE ? ESCAPE '\\'`,
          [itemFull, sourcePath.length + 1, Date.now(), state.sourceMountId, `${escapeLikePattern(sourcePath)}/%`]
        );
      }
      // 跨挂载移动文件：挂载容量 transfer（目标侧预留转已用、源侧扣减；用户配额不变：
      // 属主与大小均不变；文件夹伪行 size=0 无需处理）。文件大小从事务外读取（D1 事务为只写批）。
      if (isCrossMountMove && !state.isFolder && movedSize > 0) {
        await tx.query(
          `UPDATE mounts SET used_storage = MAX(0, used_storage - ?), updated_at = ? WHERE id = ?`,
          [movedSize, Date.now(), state.sourceMountId]
        );
        await tx.query(
          `UPDATE mounts SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE id = ?`,
          [movedSize, movedSize, Date.now(), state.targetMountId]
        );
        // §30 成员级预留：文件行已落目标成员（已用聚合已含本文件）→ 与落账同批释放；台账行同批删除
        if (state.memberReserved && state.targetProviderId) {
          await MountProviderQuotaRepo.releaseTx(tx, state.targetMountId, state.targetProviderId, movedSize);
        }
        if (state.reservationId) await ReservationRepo.remove(tx, state.reservationId);
      }
      await tx.query(
        `UPDATE operation_jobs SET status = 'completed', completed_at = ?, progress = 100 WHERE id = ?`,
        [Date.now(), jobId]
      );
    });

    if (!isBlobBacked) {
      // 异步清理源对象（此处直接清理；§E 按源落桶 provider 定位）
      await cleanupObjects(c, state.sourceMountId, [{ providerId: state.sourceProviderId, objectKey: state.sourceObjectKey }]);
      // 清理标记
      await FileRepo.updateFile(db, job.fileId as string, { source_cleanup_pending: 0, old_object_key: null });
    }
  } catch (err) {
    // 补偿：删除已复制的目标对象（内容寻址文件未复制对象，无补偿动作）
    try {
      if (!isBlobBacked) {
        await cleanupObjects(c, state.targetMountId, [{ providerId: state.targetProviderId, objectKey: state.targetObjectKey }]);
      }
    } catch {
      // ignore
    }
    // 释放跨挂载移动持有的两层预留（未走到提交事务即失败；提交成功时已在事务内转已用/释放）
    if (state.memberReserved) {
      const reservedSize = state.reservedSize ?? 0;
      await MountQuotaRepo.releaseReservation(db, state.targetMountId, reservedSize);
      if (state.targetProviderId) {
        await MountProviderQuotaRepo.release(db, state.targetMountId, state.targetProviderId, reservedSize);
      }
      if (state.reservationId) await ReservationRepo.remove(db, state.reservationId);
    }
    await JobRepo.updateJob(db, jobId, {
      status: 'failed',
      error_message: err instanceof Error ? err.message : '移动失败',
      completed_at: Date.now(),
    });
  }
}
