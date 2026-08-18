// 上传路由：单文件 + 分片 + Worker 代理上传 + 完成校验（防伪造）
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { SessionRepo, QuotaRepo, FileRepo, LogRepo, MountRepo, ReconciliationRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { requirePermission } from '../permissions/principal';
import { getProvider } from '../storage/providers';
import { ProviderRepo } from '../../db';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { normalizePath, objectKeyFromPath, isValidFileName, validateFileType } from '../../utils/path';
import { uuid } from '../../utils/crypto';
import { sha256Hex } from '../../utils/crypto';
import type { Env } from '../../shared/types';
import type { StorageProviderInterface } from '../storage/types';
import { InitUploadSchema, CompleteUploadSchema } from './schemas';

const SESSION_TTL = 60 * 60; // 1 小时
const PART_SIZE = 8 * 1024 * 1024; // 分片大小 8MB
const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB 自动分片

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

  const objectKey = objectKeyFromPath(mount.mountPath, (await getProviderCfg(db, mount.providerId)).pathPrefix, joinPath(targetPath, fileName));
  const provider = await getProvider(db, await ProviderRepo.getProviderById(db, mount.providerId) as NonNullable<Awaited<ReturnType<typeof ProviderRepo.getProviderById>>>, c.env as Env);

  // 判断是否分片
  const useMultipart = fileSize > MULTIPART_THRESHOLD || (parsed.data.partCount ?? 0) > 1;
  const totalParts = useMultipart ? Math.ceil(fileSize / PART_SIZE) : undefined;

  let uploadId: string | undefined;
  try {
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

  const provider = await providerForMount(db, session.mountId, c.env as Env);
  const body = c.req.raw.body as ReadableStream<Uint8Array> | null;
  if (!body) throw ApiError.badRequest('请求体为空');
  const contentType = c.req.header('content-type') ?? session.mimeType;

  await SessionRepo.updateStatus(db, sessionId, { status: 'uploading' });
  const res = await provider.putObject(session.objectKey, body, contentType);
  await SessionRepo.updateStatus(db, sessionId, { status: 'verifying' });

  const head = await provider.headObject(session.objectKey);
  if (!head || head.size !== session.fileSize) {
    await SessionRepo.updateStatus(db, sessionId, { status: 'failed' });
    throw new ApiError(422, 'OPERATION_FAILED', '文件大小校验失败');
  }

  return ok(c, {
    etag: head.etag,
    size: head.size,
  });
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

  const provider = await providerForMount(db, session.mountId, c.env as Env);
  const body = c.req.raw.body as ReadableStream<Uint8Array> | null;
  if (!body) throw ApiError.badRequest('分片内容为空');

  await SessionRepo.updateStatus(db, sessionId, { status: 'uploading' });
  const res = await provider.uploadPart(session.objectKey, session.uploadId, partNumber, body);
  // 服务端留存分片 ETag：断点续传与完成校验的依据（Worker 代理路径）
  await SessionRepo.recordPart(db, sessionId, partNumber, res.etag);
  return ok(c, { partNumber, etag: res.etag });
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
    const provider = await providerForMount(db, session.mountId, c.env as Env);
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
    const provider = await providerForMount(db, session.mountId, c.env as Env);
    try {
      await provider.abortMultipartUpload(session.objectKey, session.uploadId);
    } catch {
      // ignore
    }
  }
  await QuotaRepo.releaseReservation(db, userId, session.quotaReserved);
  await SessionRepo.updateStatus(db, sessionId, { status: 'aborted', completedAt: Date.now() });
  return ok(c, null);
});

// ============ 完成上传（HEAD 校验，防伪造） ============
uploadRoutes.post('/upload-complete', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  // 审计 M-05：upload-complete body 统一 Zod 校验
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

  const provider = await providerForMount(db, session.mountId, c.env as Env);

  // 1-3. 单文件：HEAD 验证对象真实存在与大小/ETag（分片对象在合并后才存在，跳过前置 HEAD）
  const head = await provider.headObject(session.objectKey);
  let finalEtag: string | undefined = head?.etag;
  if (!session.uploadId) {
    if (!head) {
      await SessionRepo.updateStatus(db, sessionId, { status: 'failed' });
      throw new ApiError(422, 'OPERATION_FAILED', '对象不存在，上传校验失败');
    }

    // 2. 校验大小
    if (head.size !== session.fileSize) {
      await SessionRepo.updateStatus(db, sessionId, { status: 'failed' });
      throw new ApiError(422, 'OPERATION_FAILED', `文件大小不匹配（期望 ${session.fileSize}，实际 ${head.size}）`);
    }

    // 3. 校验 ETag（单文件）
    if (!clientEtag) throw ApiError.badRequest('缺少 etag');
    if (head.etag && clientEtag && head.etag !== clientEtag && !head.etag.includes(clientEtag)) {
      await SessionRepo.updateStatus(db, sessionId, { status: 'failed' });
      throw new ApiError(422, 'OPERATION_FAILED', 'ETag 不匹配');
    }
    finalEtag = head.etag;
  }

  // 4. 分片上传：服务端合并（支持断点续传，优先用服务端记录的分片）
  if (session.uploadId) {
    await SessionRepo.updateStatus(db, sessionId, { status: 'verifying' });
    const total = session.totalParts ?? 0;
    // 服务端已记录分片（Worker 代理路径）→ 以服务端为准；否则使用客户端上报（预签名直传路径）
    const recorded = await SessionRepo.getParts(db, sessionId);
    const uploadParts = recorded.length > 0 ? recorded : (parts ?? []);
    if (total === 0 || uploadParts.length < total) {
      await SessionRepo.updateStatus(db, sessionId, { status: 'failed' });
      throw new ApiError(422, 'OPERATION_FAILED', `分片不完整，无法合并（已完成 ${uploadParts.length}/${total}）`);
    }
    // 校验分片编号覆盖 1..total（无缺口、无越界）
    const numbers = new Set(uploadParts.map((p) => p.partNumber));
    const coverageOk = uploadParts.length === total && (() => {
      for (let i = 1; i <= total; i++) if (!numbers.has(i)) return false;
      return true;
    })();
    if (!coverageOk) {
      await SessionRepo.updateStatus(db, sessionId, { status: 'failed' });
      throw new ApiError(422, 'OPERATION_FAILED', '分片编号不连续，无法合并');
    }
    const sorted = [...uploadParts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      const merged = await provider.completeMultipartUpload(
        session.objectKey,
        session.uploadId,
        sorted.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
      );
      finalEtag = merged.etag ?? finalEtag;
    } catch (err) {
      await SessionRepo.updateStatus(db, sessionId, { status: 'failed' });
      throw new ApiError(422, 'OPERATION_FAILED', `合并分片失败：${err instanceof Error ? err.message : '未知错误'}`);
    }
    const finalHead = await provider.headObject(session.objectKey);
    if (!finalHead || finalHead.size !== session.fileSize) {
      await SessionRepo.updateStatus(db, sessionId, { status: 'failed' });
      throw new ApiError(422, 'OPERATION_FAILED', '合并后文件校验失败');
    }
    finalEtag = finalHead.etag;
  }

  // 5. 事务提交元数据 + 配额（原子；DB 失败 → 记录孤儿 + 释放预留）
  const mount = await MountRepo.getMountById(db, session.mountId);
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
      });
      await tx.query(
        `UPDATE user_quotas SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?),
         used_files = used_files + 1, updated_at = ? WHERE user_id = ?`,
        [session.fileSize, session.quotaReserved, Date.now(), userId]
      );
      await tx.query(
        `UPDATE upload_sessions SET status = 'completed', completed_at = ? WHERE id = ?`,
        [Date.now(), sessionId]
      );
      await tx.query(
        `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
         VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 200, ?)`,
        [uuid(), userId, session.path, JSON.stringify({ fileName: session.fileName }), getIp(c), c.req.header('user-agent'), session.fileSize, Date.now()]
      );
    });
  } catch (err) {
    // H-5：对象已写入/合并，但元数据提交失败 → 释放预留并记录孤儿供对账
    await QuotaRepo.releaseReservation(db, userId, session.quotaReserved);
    await ReconciliationRepo.createOrphanObject(db, {
      mountId: session.mountId,
      objectKey: session.objectKey,
      reason: 'upload_commit_failed',
      error: err instanceof Error ? err.message : 'unknown',
    });
    throw err;
  }

  void mount;
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

async function getProviderCfg(db: ReturnType<typeof getDb>, providerId: string) {
  const provider = await ProviderRepo.getProviderById(db, providerId);
  if (!provider) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  return provider;
}

/** 通过挂载点解析 provider 实例 */
async function providerForMount(db: ReturnType<typeof getDb>, mountId: string, env: Env): Promise<StorageProviderInterface> {
  const mount = await MountRepo.getMountById(db, mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  const providerRow = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!providerRow) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  return getProvider(db, providerRow, env);
}

function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

function getIp(c: Parameters<typeof ok>[0]): string | undefined {
  const cf = (c.req.raw as Request & { cf?: { connectingIp?: string } }).cf;
  if (cf?.connectingIp) return cf.connectingIp;
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? undefined;
}

export { MULTIPART_THRESHOLD, PART_SIZE };
