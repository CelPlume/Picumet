// 文件写入共享路径：兼容上传 / WebDAV / S3 网关 / AList shim 统一走这里，
// 保证配额、覆盖语义、目录行、补偿与访问日志的行为一致（P0-2 / P0-3 / P1-3.5）。
import type { Context } from 'hono';
import type { Mount } from '@shared/types';
import { FileRepo, QuotaRepo, ReconciliationRepo } from '../../db';
import type { Db } from '../../db';
import { getDb, getClientIp } from '../../middleware/auth';
import { ApiError } from '../../shared/errors';
import { normalizePath, objectKeyFromPath, validateFileType } from '../../utils/path';
import { uuid } from '../../utils/crypto';
import type { StorageProviderInterface, HeadResult } from '../storage/types';
import type { Env } from '../../shared/types';
import { signPath } from '../../utils/crypto';

/**
 * 逐级确保祖先文件夹行存在（P0-3：无目录行的文件在列表/PROPFIND 中不可见）。
 * 幂等：已存在的目录行跳过；目录行不消耗配额（size=0）。
 * objectKey 复用 MKCOL 的 `folder:` 前缀约定（webdav/handlers.ts）。
 */
export async function ensureFolders(db: Db, mount: Mount, targetPath: string, ownerId: string): Promise<void> {
  const segments = normalizePath(targetPath).split('/').filter(Boolean);
  let current = '';
  for (const seg of segments) {
    current = `${current}/${seg}`;
    const parent = current.slice(0, -(seg.length + 1)) || '/';
    // 目录行是共享命名空间（对象存储语义：前缀不归属个人）；文件占用才冲突。
    // 注意路径约定：文件夹行 path=自身全路径，文件行 path=父目录 → 两处都要查。
    const folderRow = await FileRepo.getFileAtPath(db, mount.id, current, seg);
    if (folderRow) {
      if (folderRow.type !== 'folder') {
        throw new ApiError(409, 'CONFLICT', `路径 ${current} 已被文件占用`);
      }
      continue;
    }
    const fileRow = await FileRepo.getFileAtPath(db, mount.id, parent, seg);
    if (fileRow) {
      throw new ApiError(409, 'CONFLICT', `路径 ${current} 已被文件占用`);
    }
    const objectKey = objectKeyFromPath(mount.mountPath, '', current);
    await FileRepo.createFile(db, {
      mountId: mount.id,
      objectKey: `folder:${objectKey}`,
      path: current,
      name: seg,
      type: 'folder',
      size: 0,
      ownerId,
    });
  }
}

export interface UpsertFileOpts {
  mount: Mount;
  provider: StorageProviderInterface;
  /** provider 的 pathPrefix（storage_providers.path_prefix，对象键前缀） */
  pathPrefix: string;
  /** 完整虚拟路径（含文件名），如 /uploads/2024/pic.png */
  targetPath: string;
  mimeType: string;
  /** 已知大小时 >0；未知传 0（以 head 结果为准） */
  size: number;
  body: ReadableStream<Uint8Array>;
  /** 配额归属用户（密钥所有者） */
  ownerId: string;
  /** 访问日志 via 标记：api / webdav / s3 / alist */
  via: string;
  metadata?: Record<string, string>;
  /** 是否自动补齐祖先目录行，默认 true */
  ensureParents?: boolean;
}

export interface UpsertFileResult {
  fileId: string;
  /** false 表示覆盖了既有文件 */
  created: boolean;
  objectKey: string;
  etag?: string;
  size: number;
}

/**
 * 对象落盘 + 元数据/配额事务的统一实现。
 * - 新建：putObject → 元数据事务；事务失败删除对象补偿（孤儿记录兜底）。
 * - 覆盖（P0-2 安全语义）：绝不删除对象（可能承载旧文件唯一副本）；事务失败记录对账，
 *   客户端收到错误但旧元数据仍指向已更新的对象（可通过重传恢复一致性）。
 * - 成败判据：headObject 大小与请求一致（size 未知时采信 head）。
 */
export async function upsertFileObject(c: Context, opts: UpsertFileOpts): Promise<UpsertFileResult> {
  const db = getDb(c);
  const userId = opts.ownerId;
  const targetPath = normalizePath(opts.targetPath);
  const segs = targetPath.split('/').filter(Boolean);
  const fileName = segs.pop();
  if (!fileName) throw ApiError.badRequest('目标路径无效');
  const parentPath = '/' + segs.join('/');
  const mimeType = opts.mimeType || 'application/octet-stream';
  validateFileType(fileName, mimeType);

  if (opts.ensureParents !== false) {
    await ensureFolders(db, opts.mount, parentPath, userId);
  }

  const objectKey = objectKeyFromPath(opts.mount.mountPath, opts.pathPrefix, targetPath);
  // 跨属主文件占用（对象键为挂载内全局命名空间）：写对象之前 409，禁止覆盖他人对象
  const rowByObjectKey = await FileRepo.getFileByObjectKey(db, opts.mount.id, objectKey);
  if (rowByObjectKey && rowByObjectKey.ownerId !== userId) {
    throw new ApiError(409, 'CONFLICT', '目标路径已被其他用户占用');
  }
  // 目录占用：同一路径已存在文件夹（任何属主）→ 不能作为文件写入
  const folderAtTarget = await FileRepo.getFolderAtPath(db, opts.mount.id, targetPath, fileName);
  if (folderAtTarget) {
    throw new ApiError(409, 'CONFLICT', `路径 ${targetPath} 已是文件夹`);
  }
  const existing = await FileRepo.getFileAtPath(db, opts.mount.id, parentPath, fileName, userId);
  const size = opts.size > 0 ? opts.size : 0;

  const reserved = await QuotaRepo.reserve(db, userId, size);
  if (!reserved) throw new ApiError(413, 'QUOTA_EXCEEDED', '存储配额不足');
  if (!existing || existing.type !== 'file') {
    const canAdd = await QuotaRepo.canAddFile(db, userId);
    if (!canAdd) {
      await QuotaRepo.releaseReservation(db, userId, size);
      throw new ApiError(413, 'QUOTA_EXCEEDED', '文件数量配额已满');
    }
  }

  const fileId = existing && existing.type === 'file' ? existing.id : uuid();
  const isOverwrite = !!(existing && existing.type === 'file');
  let head: HeadResult;
  try {
    await opts.provider.putObject(objectKey, opts.body, mimeType, opts.metadata);
    const headResult = await opts.provider.headObject(objectKey);
    if (!headResult) throw new ApiError(422, 'OPERATION_FAILED', '上传校验失败');
    if (size > 0 && headResult.size !== size) {
      throw new ApiError(422, 'OPERATION_FAILED', '上传校验失败：对象大小与请求不一致');
    }
    head = headResult;
    const finalSize = size > 0 ? size : headResult.size;

    await db.transaction(async (tx) => {
      if (isOverwrite && existing) {
        await FileRepo.updateFileTx(tx, existing.id, {
          object_key: objectKey, size: finalSize, etag: head.etag, mime_type: mimeType, path: parentPath,
        });
        await tx.query(
          `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ? + ?), quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE user_id = ?`,
          [existing.size, finalSize, size, Date.now(), userId]
        );
      } else {
        await FileRepo.createFileTx(tx, {
          id: fileId, mountId: opts.mount.id, objectKey, path: parentPath, name: fileName,
          type: 'file', mimeType, size: finalSize, etag: head.etag, ownerId: userId,
        });
        await tx.query(
          `UPDATE user_quotas SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?), used_files = used_files + 1, updated_at = ? WHERE user_id = ?`,
          [finalSize, size, Date.now(), userId]
        );
      }
      await tx.query(
        `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
         VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 200, ?)`,
        [uuid(), userId, targetPath, JSON.stringify({ fileName, via: opts.via }), getClientIp(c), c.req.header('user-agent'), finalSize, Date.now()]
      );
    });

    return { fileId, created: !isOverwrite, objectKey, etag: head.etag, size: finalSize };
  } catch (err) {
    await QuotaRepo.releaseReservation(db, userId, size);
    if (isOverwrite) {
      try {
        await ReconciliationRepo.createOrphanObject(db, {
          mountId: opts.mount.id,
          objectKey,
          reason: 'overwrite_db_failed',
          error: err instanceof Error ? err.message : 'unknown',
        });
      } catch {
        // 对账记录失败不影响主错误传播
      }
    } else {
      try {
        await opts.provider.deleteObject(objectKey);
      } catch (cleanupErr) {
        await ReconciliationRepo.createOrphanObject(db, {
          mountId: opts.mount.id,
          objectKey,
          reason: 'upload_db_failed',
          error: cleanupErr instanceof Error ? cleanupErr.message : 'unknown',
        });
      }
    }
    throw err;
  }
}

/**
 * 构建外部可用的文件访问 URL（P0-1，图床命门）：
 * 1. provider 配置了公网域名（getPublicUrl）→ 返回 CDN 直链；
 * 2. 否则返回 `{origin}{虚拟路径}?sign=` —— path-serve 用签名放行匿名 GET（能力范围=该路径）。
 */
export async function buildFileAccessUrl(
  c: Context,
  provider: StorageProviderInterface,
  objectKey: string,
  targetPath: string,
  expiresAt = 0
): Promise<string> {
  const env = c.env as Env;
  const cdn = provider.getPublicUrl(objectKey);
  if (cdn) return cdn;
  const encoded = targetPath.split('/').map((s) => (s ? encodeURIComponent(s) : '')).join('/');
  const sign = await signPath(targetPath, env.ENCRYPTION_KEY, expiresAt);
  return `${env.APP_BASE_URL || `${c.req.url.split('/').slice(0, 3).join('/')}`}${encoded}?sign=${sign}`;
}
