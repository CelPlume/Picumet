// 上传路由：单文件 + 分片 + Worker 代理上传 + 完成校验（防伪造）
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { SessionRepo, QuotaRepo, FileRepo, LogRepo, MountRepo, MountQuotaRepo, MountProviderQuotaRepo, ReconciliationRepo } from '../../db';
import type { Db } from '../../db';
import { getDb } from '../../middleware/auth';
import { requirePermission, getPrincipal } from '../permissions/principal';
import { assertWritable } from '../files/upload-mode';
import { getProvider } from '../storage/providers';
import { pickWriteProvider } from '../storage/pool';
import { ProviderRepo } from '../../db';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { normalizePath, objectKeyFromPath, isValidFileName, validateFileType } from '../../utils/path';
import { uuid } from '../../utils/crypto';
import { sha256Hex } from '../../utils/crypto';
import { requestIp } from '../../utils/ip';
import type { Env } from '../../shared/types';
import type { StorageProvider } from '@shared/types';
import type { StorageProviderInterface } from '../storage/types';
import { writeContentAddressed } from '../storage/content';
import { InitUploadSchema, CompleteUploadSchema } from './schemas';
import type { UploadSessionRow } from '../../db/row';

const SESSION_TTL = 60 * 60; // 1 小时
const PART_SIZE = 8 * 1024 * 1024; // 分片大小 8MB
const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB 自动分片
/** 完成领取的残留窗口——崩溃请求的领取超过此时长后可被重试请求接管 */
const COMPLETE_CLAIM_STALE_MS = 5 * 60_000;

/** 分片清单可用性：数量覆盖 1..total、编号无缺口且 ETag 齐全（合并的必要条件） */
function isUsablePartList(list: Array<{ partNumber: number; etag?: string }>, total: number): boolean {
  if (total === 0 || list.length !== total) return false;
  const numbers = new Set<number>();
  for (const part of list) {
    if (!part.etag) return false;
    numbers.add(part.partNumber);
  }
  for (let i = 1; i <= total; i++) if (!numbers.has(i)) return false;
  return true;
}

export const uploadRoutes = new Hono<AppBindings>();

// ============ 创建上传会话 ============
uploadRoutes.post('/upload-session', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = InitUploadSchema.safeParse(body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '上传参数无效', parsed.error.flatten());
  }
  const { path, fileName, fileSize, mimeType, idempotencyKey } = parsed.data;

  if (!isValidFileName(fileName)) throw ApiError.badRequest('文件名包含非法字符');
  validateFileType(fileName, mimeType);

  const targetPath = normalizePath(path);
  const mount = await MountRepo.findMountForPath(db, targetPath);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '目标挂载点不存在');

  await requirePermission(c, mount, targetPath, 'write');

  // §28 写入口模式：上传会话在创建时就固定最终路径（raw/complete 沿用它），故在入口处校验
  // user_space 的用户空间约束（flat 不约束路径）。此处与 compat/AList/WebDAV/S3 各入口行为一致。
  await assertWritable(db, mount, userId, joinPath(targetPath, fileName));

  // 幂等检查
  if (idempotencyKey) {
    const idemKey = await sha256Hex(`upload:${userId}:${idempotencyKey}`);
    const existing = await SessionRepo.getSessionByIdempotencyKey(db, idemKey);
    if (existing) {
      if (existing.status === 'completed') {
        return ok(c, { sessionId: existing.id, alreadyCompleted: true });
      }
      return ok(c, { sessionId: existing.id, alreadyCompleted: false, uploadUrl: null, expiresAt: existing.expiresAt });
    }
    parsed.data.idempotencyKey = idemKey;
  }

  // 原子预留配额
  const reserved = await QuotaRepo.reserve(db, userId, fileSize);
  if (!reserved) throw new ApiError(413, 'QUOTA_EXCEEDED', '存储配额不足');
  const canAdd = await QuotaRepo.canAddFile(db, userId);
  if (!canAdd) {
    await QuotaRepo.releaseReservation(db, userId, fileSize);
    throw new ApiError(413, 'QUOTA_EXCEEDED', '文件数量配额已满');
  }
  // 第二道闸门：挂载点容量（与用户限额独立，取交集语义）
  const mountReserved = await MountQuotaRepo.reserve(db, mount.id, fileSize);
  if (!mountReserved) {
    await QuotaRepo.releaseReservation(db, userId, fileSize);
    throw new ApiError(413, 'MOUNT_QUOTA_EXCEEDED', '挂载点容量不足');
  }

  let uploadId: string | undefined;
  // §30 会话选定的池成员：选桶时已在该成员上预留 fileSize 字节，凡「会话未落库」的失败路径都要释放
  let sessionProviderRow: StorageProvider | null = null;
  try {
    // §E 存储池：上传会话开始时选定落桶并原子预留成员容量（分片/续传期间保持不变）。
    // 选桶失败（如池成员全满 413）与后续建会话失败同属「会话未落库」路径，
    // 必须与下面共用同一补偿块，先释放上面三道预留再抛出。
    sessionProviderRow = await pickWriteProvider(db, mount, joinPath(targetPath, fileName), c.env as Env, fileSize, {
      // §31 桶级矩阵：候选桶对发起者角色明确禁止 write → 跳过该候选（全部被拒 → 403）
      principalRole: (await getPrincipal(c)).role,
    });
    const objectKey = objectKeyFromPath(mount.mountPath, sessionProviderRow.pathPrefix ?? '', joinPath(targetPath, fileName));
    const provider = await getProvider(db, sessionProviderRow, c.env as Env);

    // 判断是否分片
    const useMultipart = fileSize > MULTIPART_THRESHOLD || (parsed.data.partCount ?? 0) > 1;
    const totalParts = useMultipart ? Math.ceil(fileSize / PART_SIZE) : undefined;

    if (useMultipart) {
      const res = await provider.createMultipartUpload(objectKey, mimeType);
      uploadId = res.uploadId;
    }
    const sessionId = await SessionRepo.createSession(db, {
      userId,
      mountId: mount.id,
      objectKey,
      path: targetPath,
      fileName,
      mimeType,
      fileSize,
      quotaReserved: fileSize,
      providerId: sessionProviderRow.id,
      uploadId,
      totalParts,
      idempotencyKey: parsed.data.idempotencyKey,
      expiresAt: Date.now() + SESSION_TTL * 1000,
    });

    let uploadUrl: string | null = null;
    let parts: Array<{ partNumber: number; url: string }> = [];
    if (!useMultipart) {
      uploadUrl = await provider.getUploadUrl(objectKey, mimeType, 900);
    } else if (typeof provider.getMultipartUploadUrl === 'function' && uploadId) {
      // 支持分片预签名的 Provider（如 S3）：一次性下发全部预签名分片 URL（前端并发直传）
      for (let i = 1; i <= (totalParts ?? 0); i++) {
        const url = await provider.getMultipartUploadUrl(objectKey, uploadId, i, 900);
        if (!url) break;
        parts.push({ partNumber: i, url });
      }
      if (parts.length !== totalParts) parts = []; // 不完整则整体退回 Worker 代理
    }

    return ok(c, {
      sessionId,
      uploadUrl,
      uploadId,
      uploadMode: useMultipart && parts.length > 0 ? 'presigned' : uploadUrl ? 'presigned' : 'worker',
      totalParts,
      parts,
      expiresAt: Date.now() + SESSION_TTL * 1000,
      expiresIn: SESSION_TTL,
    });
  } catch (err) {
    await QuotaRepo.releaseReservation(db, userId, fileSize);
    await MountQuotaRepo.releaseReservation(db, mount.id, fileSize);
    if (sessionProviderRow) await MountProviderQuotaRepo.release(db, mount.id, sessionProviderRow.id, fileSize);
    throw err;
  }
});

// ============ Worker 代理上传（非预签名场景） ============
uploadRoutes.put('/upload/raw/:sessionId', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const sessionId = c.req.param('sessionId');
  const session = await SessionRepo.getSession(db, sessionId);
  if (!session || session.userId !== userId) throw new ApiError(404, 'NOT_FOUND', '上传会话不存在');
  if (session.status !== 'pending') throw new ApiError(409, 'OPERATION_FAILED', '会话状态异常');
  if (Date.now() > session.expiresAt) throw new ApiError(410, 'UPLOAD_SESSION_EXPIRED', '上传会话已过期');

  const providerRow = await providerRowForMount(db, session.mountId, session.providerId);
  const body = c.req.raw.body as ReadableStream<Uint8Array> | null;
  if (!body) throw ApiError.badRequest('请求体为空');
  const contentType = c.req.header('content-type') ?? session.mimeType ?? 'application/octet-stream';

  await SessionRepo.updateStatus(db, sessionId, { status: 'uploading' });
  try {
    // §F 内容寻址：暂存 + 流式哈希 → 去重复用或复制到内容键；结果记录在会话上供 complete 使用
    const outcome = await writeContentAddressed(db, c.env as Env, {
      providerRow,
      mountId: session.mountId,
      fallbackKey: session.objectKey,
      body,
      mimeType: contentType,
      declaredSize: session.fileSize,
    });
    await SessionRepo.recordContent(db, sessionId, {
      blobHash: outcome.hash,
      physicalKey: outcome.objectKey,
      providerId: outcome.providerId,
    });
    await SessionRepo.updateStatus(db, sessionId, { status: 'verifying' });
    return ok(c, { etag: outcome.etag, size: outcome.size });
  } catch (err) {
    // 异常即终态——先释放三层预留（用户/挂载/池成员）再标 aborted，
    // 不让预留滞留到过期清扫；'failed' 仅留给存量行由清扫任务回收。
    await QuotaRepo.releaseReservation(db, userId, session.quotaReserved);
    await MountQuotaRepo.releaseReservation(db, session.mountId, session.quotaReserved);
    if (session.providerId) {
      await MountProviderQuotaRepo.release(db, session.mountId, session.providerId, session.quotaReserved);
    }
    await SessionRepo.updateStatus(db, sessionId, { status: 'aborted' });
    throw err;
  }
});

// ============ 分片上传：Worker 代理上传分片 ============
uploadRoutes.put('/upload/multipart/:sessionId/part/:partNumber', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const sessionId = c.req.param('sessionId');
  const partNumber = Number(c.req.param('partNumber'));
  const session = await SessionRepo.getSession(db, sessionId);
  if (!session || session.userId !== userId) throw new ApiError(404, 'NOT_FOUND', '上传会话不存在');
  if (!session.uploadId) throw new ApiError(409, 'OPERATION_FAILED', '非分片上传会话');
  if (partNumber < 1 || (session.totalParts && partNumber > session.totalParts)) {
    throw ApiError.badRequest('分片编号无效');
  }
  if (Date.now() > session.expiresAt) throw new ApiError(410, 'UPLOAD_SESSION_EXPIRED', '上传会话已过期');

  const provider = await providerForMount(db, session.mountId, c.env as Env, session.providerId);
  const body = c.req.raw.body as ReadableStream<Uint8Array> | null;
  if (!body) throw ApiError.badRequest('分片内容为空');

  await SessionRepo.updateStatus(db, sessionId, { status: 'uploading' });
  try {
    const res = await provider.uploadPart(session.objectKey, session.uploadId, partNumber, body);
    // 服务端留存分片 ETag：断点续传与完成校验的依据（Worker 代理路径）
    await SessionRepo.recordPart(db, sessionId, partNumber, res.etag);
    return ok(c, { partNumber, etag: res.etag });
  } catch (err) {
    // 分片失败会话回到 pending——三层预留保持不变（会话仍可续传），
    // 状态不再滞留 uploading；过期后由清扫任务按在途状态正常回收。
    await SessionRepo.updateStatus(db, sessionId, { status: 'pending' });
    throw err;
  }
});

// ============ 分片状态查询（断点续传契约） ============
uploadRoutes.get('/upload/multipart/:sessionId/parts', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const sessionId = c.req.param('sessionId');
  const session = await SessionRepo.getSession(db, sessionId);
  if (!session || session.userId !== userId) throw new ApiError(404, 'NOT_FOUND', '上传会话不存在');
  if (!session.uploadId) throw new ApiError(409, 'OPERATION_FAILED', '非分片上传会话');

  const recorded = await SessionRepo.getParts(db, sessionId);
  const done = new Set(recorded.map((p) => p.partNumber));
  const missing: number[] = [];
  for (let i = 1; i <= (session.totalParts ?? 0); i++) {
    if (!done.has(i)) missing.push(i);
  }

  // 支持预签名的 Provider：为缺失分片补发预签名 URL（仅返回缺失部分，支持续传）
  let presigned: Array<{ partNumber: number; url: string }> = [];
  if (missing.length > 0) {
    const provider = await providerForMount(db, session.mountId, c.env as Env, session.providerId);
    if (typeof provider.getMultipartUploadUrl === 'function') {
      for (const partNumber of missing) {
        const url = await provider.getMultipartUploadUrl(session.objectKey, session.uploadId, partNumber, 900);
        if (!url) break;
        presigned.push({ partNumber, url });
      }
      if (presigned.length !== missing.length) presigned = [];
    }
  }

  return ok(c, {
    sessionId,
    totalParts: session.totalParts ?? 0,
    completedCount: recorded.length,
    parts: recorded,
    missingParts: missing,
    presignedParts: presigned,
    uploadMode: presigned.length > 0 ? 'presigned' : 'worker',
  });
});

// ============ 中止分片上传 ============
uploadRoutes.delete('/upload/multipart/:sessionId', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const sessionId = c.req.param('sessionId');
  const session = await SessionRepo.getSession(db, sessionId);
  if (!session || session.userId !== userId) throw new ApiError(404, 'NOT_FOUND', '上传会话不存在');
  if (session.uploadId) {
    const provider = await providerForMount(db, session.mountId, c.env as Env, session.providerId);
    try {
      await provider.abortMultipartUpload(session.objectKey, session.uploadId);
    } catch (err) {
      // 终止失败不再静默忽略——登记带 upload_id 的清理队列，由清扫任务重试
      await ReconciliationRepo.createOrphanObject(db, {
        mountId: session.mountId,
        objectKey: session.objectKey,
        providerId: session.providerId ?? null,
        uploadId: session.uploadId,
        reason: 'multipart_abort',
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
  await QuotaRepo.releaseReservation(db, userId, session.quotaReserved);
  await MountQuotaRepo.releaseReservation(db, session.mountId, session.quotaReserved);
  // §30 成员级预留：会话创建时在选定池成员上预留过 quotaReserved，随会话中止释放
  if (session.providerId) {
    await MountProviderQuotaRepo.release(db, session.mountId, session.providerId, session.quotaReserved);
  }
  await SessionRepo.updateStatus(db, sessionId, { status: 'aborted', completedAt: Date.now() });
  return ok(c, null);
});

/**
 * 上传校验失败的统一终态——先释放三层预留（用户/挂载/池成员），再标 aborted。
 * 按「终态状态约定」：失败路径一律 aborted；'failed' 仅保留给存量行，由清扫任务回收。
 * 注意：aborted 后客户端**仍可补齐分片重试**（分片上传成功会把状态改回 uploading，见断点续传契约），
 * 因此这里不 abort Provider 的 multipart upload——真正无人续传的会话（过期）由清扫任务终止。
 * 合并已成功后的校验失败（finalHead 不符）由调用方清理已合并对象，同样无需 abort。
 */
async function failSession(db: Db, session: UploadSessionRow): Promise<void> {
  await QuotaRepo.releaseReservation(db, session.userId, session.quotaReserved);
  await MountQuotaRepo.releaseReservation(db, session.mountId, session.quotaReserved);
  if (session.providerId) {
    await MountProviderQuotaRepo.release(db, session.mountId, session.providerId, session.quotaReserved);
  }
  await SessionRepo.updateStatus(db, session.id, { status: 'aborted' });
  // 释放完成领取：会话可续传（补齐分片后重新 complete），否则失败残留会把重试请求挡在 409
  await SessionRepo.releaseCompleteClaim(db, session.id);
}

// ============ 完成上传（HEAD 校验，防伪造） ============
uploadRoutes.post('/upload-complete', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  // upload-complete body 统一 Zod 校验
  const completeParse = CompleteUploadSchema.safeParse(body);
  if (!completeParse.success) throw ApiError.badRequest('上传完成参数无效');
  const { sessionId, etag: clientEtag, parts } = completeParse.data;

  const session = await SessionRepo.getSession(db, sessionId);
  if (!session || session.userId !== userId) throw new ApiError(404, 'NOT_FOUND', '上传会话不存在');
  if (session.status === 'completed') {
    // 幂等：已完成直接返回
    return ok(c, { alreadyCompleted: true, fileId: session.objectKey });
  }
  if (!['pending', 'uploading', 'verifying'].includes(session.status)) {
    throw new ApiError(409, 'OPERATION_FAILED', '会话状态异常，无法完成');
  }
  if (Date.now() > session.expiresAt) {
    throw new ApiError(410, 'UPLOAD_SESSION_EXPIRED', '上传会话已过期');
  }

  // 原子领取会话——并发完成请求只有一个赢家执行合并/提交（其余 409），
  // 避免重复合并/重复提交与竞争补偿；崩溃请求的领取超过残留窗口后可被重试请求接管。
  const claimed = await SessionRepo.claimComplete(db, sessionId, COMPLETE_CLAIM_STALE_MS);
  if (!claimed) throw new ApiError(409, 'OPERATION_FAILED', '会话正在完成中，请稍后重试');

  const provider = await providerForMount(db, session.mountId, c.env as Env, session.providerId);
  // §F：/upload/raw 已内容寻址时对象落在内容键；分片/直传会话仍为虚拟路径键
  const physicalKey = session.physicalKey ?? session.objectKey;

  // 1-3. 单文件：HEAD 验证对象真实存在与大小/ETag（分片对象在合并后才存在，跳过前置 HEAD）
  const head = await provider.headObject(physicalKey);
  let finalEtag: string | undefined = head?.etag;
  if (!session.uploadId) {
    if (!head) {
      await failSession(db, session);
      throw new ApiError(422, 'OPERATION_FAILED', '对象不存在，上传校验失败');
    }

    // 2. 校验大小
    if (head.size !== session.fileSize) {
      await failSession(db, session);
      throw new ApiError(422, 'OPERATION_FAILED', `文件大小不匹配（期望 ${session.fileSize}，实际 ${head.size}）`);
    }

    // 3. 校验 ETag（单文件）
    if (!clientEtag) throw ApiError.badRequest('缺少 etag');
    if (head.etag && clientEtag && head.etag !== clientEtag && !head.etag.includes(clientEtag)) {
      await failSession(db, session);
      throw new ApiError(422, 'OPERATION_FAILED', 'ETag 不匹配');
    }
    finalEtag = head.etag;
  }

  // 4. 分片上传：服务端合并（支持断点续传，优先用服务端记录的分片）
  if (session.uploadId) {
    await SessionRepo.updateStatus(db, sessionId, { status: 'verifying' });
    const total = session.totalParts ?? 0;
    // 服务端已记录分片（Worker 代理路径）→ 以服务端为准；否则使用客户端上报（预签名直传路径）。
    // 完整性兜底：客户端可能读不到 ETag（桶 CORS 未暴露 ETag）或上报不完整 →
    // 改用 Provider 的分片清单（服务端真值，比客户端上报更可信）。
    const recorded = await SessionRepo.getParts(db, sessionId);
    let uploadParts: Array<{ partNumber: number; etag: string }> =
      recorded.length > 0 ? recorded : (parts ?? []);
    if (!isUsablePartList(uploadParts, total) && typeof provider.listParts === 'function') {
      const remote = await provider.listParts(physicalKey, session.uploadId);
      if (remote && isUsablePartList(remote, total)) uploadParts = remote;
    }
    if (total === 0 || uploadParts.length < total) {
      await failSession(db, session);
      throw new ApiError(422, 'OPERATION_FAILED', `分片不完整，无法合并（已完成 ${uploadParts.length}/${total}）`);
    }
    // 校验分片编号覆盖 1..total（无缺口、无越界）
    const numbers = new Set(uploadParts.map((p) => p.partNumber));
    const coverageOk = uploadParts.length === total && (() => {
      for (let i = 1; i <= total; i++) if (!numbers.has(i)) return false;
      return true;
    })();
    if (!coverageOk) {
      await failSession(db, session);
      throw new ApiError(422, 'OPERATION_FAILED', '分片编号不连续，无法合并');
    }
    if (uploadParts.some((p) => !p.etag)) {
      await failSession(db, session);
      throw new ApiError(422, 'OPERATION_FAILED', '分片 ETag 缺失，无法合并');
    }
    const sorted = [...uploadParts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      const merged = await provider.completeMultipartUpload(
        physicalKey,
        session.uploadId,
        sorted.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
      );
      finalEtag = merged.etag ?? finalEtag;
    } catch (err) {
      await failSession(db, session);
      throw new ApiError(422, 'OPERATION_FAILED', `合并分片失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
    const finalHead = await provider.headObject(physicalKey);
    if (!finalHead || finalHead.size !== session.fileSize) {
      // 合并已成功（uploadId 已失效，abort 会 NoSuchUpload）：改为清理已合并对象
      await failSession(db, session);
      try {
        await provider.deleteObject(physicalKey);
      } catch (err) {
        await ReconciliationRepo.createOrphanObject(db, {
          mountId: session.mountId,
          objectKey: physicalKey,
          providerId: session.providerId ?? null,
          reason: 'multipart_verify_failed',
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
      throw new ApiError(422, 'OPERATION_FAILED', '合并后文件校验失败');
    }
    finalEtag = finalHead.etag;
  }

  // 5. 事务提交元数据 + 配额（原子；DB 失败 → 记录孤儿 + 释放预留）
  const mount = await MountRepo.getMountById(db, session.mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  const fileId = uuid();
  try {
    await db.transaction(async (tx) => {
      await FileRepo.createFileTx(tx, {
        id: fileId,
        mountId: session.mountId,
        objectKey: session.objectKey,
        path: session.path,
        name: session.fileName,
        type: 'file',
        mimeType: session.mimeType,
        size: session.fileSize,
        etag: finalEtag,
        ownerId: userId,
        providerId: session.providerId ?? mount.providerId,
        physicalKey,
        blobHash: session.blobHash ?? null,
      });
      await tx.query(
        `UPDATE user_quotas SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?),
         used_files = used_files + 1, updated_at = ? WHERE user_id = ?`,
        [session.fileSize, session.quotaReserved, Date.now(), userId]
      );
      await tx.query(
        `UPDATE mounts SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE id = ?`,
        [session.fileSize, session.quotaReserved, Date.now(), session.mountId]
      );
      // §30 成员级预留：文件行已落库（该成员已用聚合已含本文件）→ 与落账同批释放
      if (session.providerId) {
        await MountProviderQuotaRepo.releaseTx(tx, session.mountId, session.providerId, session.quotaReserved);
      }
      await tx.query(
        `UPDATE upload_sessions SET status = 'completed', completed_at = ? WHERE id = ?`,
        [Date.now(), sessionId]
      );
      await tx.query(
        `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
         VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 200, ?)`,
        [uuid(), userId, session.path, JSON.stringify({ fileName: session.fileName }), requestIp(c.req.raw), c.req.header('user-agent'), session.fileSize, Date.now()]
      );
    });
  } catch (err) {
    // 对象已写入/合并，但元数据提交失败 → 释放预留并记录孤儿供对账
    await QuotaRepo.releaseReservation(db, userId, session.quotaReserved);
    await MountQuotaRepo.releaseReservation(db, session.mountId, session.quotaReserved);
    if (session.providerId) {
      await MountProviderQuotaRepo.release(db, session.mountId, session.providerId, session.quotaReserved);
    }
    await ReconciliationRepo.createOrphanObject(db, {
      mountId: session.mountId,
      objectKey: physicalKey,
      reason: 'upload_commit_failed',
      error: err instanceof Error ? err.message : 'unknown',
    });
    // 事务已回滚，会话仍停在在途状态——显式标 aborted 清终态，
    // 否则过期清扫会把它当在途会话二次释放预留。
    await SessionRepo.updateStatus(db, sessionId, { status: 'aborted' });
    throw err;
  }

  return ok(c, {
    file: {
      id: fileId,
      name: session.fileName,
      path: session.path,
      size: session.fileSize,
      createdAt: Date.now(),
    },
  });
});

/** 会话落桶 provider 行（§E 存储池：会话选定优先，缺省回退挂载主 provider） */
async function providerRowForMount(db: Db, mountId: string, providerId?: string | null): Promise<StorageProvider> {
  const mount = await MountRepo.getMountById(db, mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  const providerRow = await ProviderRepo.getProviderById(db, providerId ?? mount.providerId);
  if (!providerRow) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  return providerRow;
}

async function providerForMount(db: Db, mountId: string, env: Env, providerId?: string | null): Promise<StorageProviderInterface> {
  return getProvider(db, await providerRowForMount(db, mountId, providerId), env);
}

function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

export { MULTIPART_THRESHOLD, PART_SIZE };
