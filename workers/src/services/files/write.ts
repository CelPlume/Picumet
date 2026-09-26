// 文件写入共享路径：兼容上传 / WebDAV / S3 网关 / AList shim 统一走这里，
// 保证配额、覆盖语义、目录行、补偿与访问日志的行为一致。
//
// §F 内容哈希寻址：物理对象按内容 SHA-256 命名（`<prefix>/picumet:blob/<h2>/<hash>`）并在文件
// 之间共享——同内容只存一份，重命名/移动退化为元数据操作。写入策略：
//   1. 已知哈希（调用方整包校验，如 S3 网关 SigV4）：库内已有 → 不写对象；否则直写内容键；
//   2. 未知哈希：暂存键 + 流式哈希 → 命中删除暂存，未命中复制到内容键后删除暂存。
// 分片上传（上传会话 multipart）不经过这里：分片直传存储商，物理键仍为虚拟路径键（blob_hash 为空）。
import type { Context } from 'hono';
import type { Mount, StorageProvider } from '@shared/types';
import { BlobRepo, FileRepo, QuotaRepo, ReconciliationRepo, MountQuotaRepo, MountProviderQuotaRepo, ProviderRepo, ReservationRepo } from '../../db';
import type { Db } from '../../db';
import { getDb } from '../../middleware/auth';
import { requestIp } from '../../utils/ip';
import { ApiError } from '../../shared/errors';
import { normalizePath, objectKeyFromPath, validateFileType } from '../../utils/path';
import { uuid, signPath } from '../../utils/crypto';
import type { StorageProviderInterface } from '../storage/types';
import type { Env } from '../../shared/types';
import { getProvider } from '../storage/providers';
import { directUrl, loadRoutePrefixes, type RoutePrefixes } from '../storage/direct-links';
import { pickWriteProvider } from '../storage/pool';
import { getPrincipal } from '../permissions/principal';
import { writeContentAddressed, type ContentWriteResult } from '../storage/content';
import { assertWritable } from './upload-mode';

/**
 * 逐级确保祖先文件夹行存在（无目录行的文件在列表/PROPFIND 中不可见）。
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
    // flat = 挂载点内禁止文件夹。上传到需要新建祖先目录的路径时这里会静默创建 folder 行，
    // 使「不允许文件夹」契约只在显式建目录入口生效——写入路径同样拒绝（已存在的目录不受影响）。
    if (mount.uploadMode === 'flat') {
      throw new ApiError(403, 'FORBIDDEN', '该挂载点不允许文件夹，请上传到挂载根目录');
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
  /** 完整虚拟路径（含文件名），如 /uploads/2024/pic.png */
  targetPath: string;
  mimeType: string;
  /** 已知大小时 >0；未知传 0（以实际写入字节数为准） */
  size: number;
  body: ReadableStream<Uint8Array>;
  /** 配额归属用户（密钥所有者） */
  ownerId: string;
  /** 访问日志 via 标记：api / webdav / s3 / alist */
  via: string;
  metadata?: Record<string, string>;
  /** 是否自动补齐祖先目录行，默认 true */
  ensureParents?: boolean;
  /** §F 已知内容 SHA-256（调用方已对整包做过校验，如 S3 网关 SigV4 载荷哈希） */
  contentHash?: string;
}

export interface UpsertFileResult {
  fileId: string;
  /** false 表示覆盖了既有文件 */
  created: boolean;
  /** 物理对象键（§F：内容键；去重命中时为既有内容键）——调用方据此构造直链/后续操作 */
  objectKey: string;
  etag?: string;
  size: number;
  /** 实际承载对象的 provider（§E 池化 + §F 去重后可能与挂载主 provider 不同） */
  providerId: string;
  /** §F 内容 SHA-256（未内容寻址时为空） */
  blobHash?: string;
}

/**
 * 对象落盘 + 元数据/配额事务的统一实现（§F 内容寻址）。
 * - 内容寻址：物理键由内容哈希决定，同内容跨文件共享（对象只存一份）。
 * - 新建：写对象 → 元数据事务；事务失败且库内仍无该内容 → 删除对象补偿（否则记录孤儿）。
 * - 覆盖（安全语义）：绝不删除已写入的对象（可能承载旧文件唯一副本）；事务失败记录对账，
 *   客户端收到错误但旧元数据仍指向已更新的对象（可通过重传恢复一致性）。
 */
export async function upsertFileObject(c: Context, opts: UpsertFileOpts): Promise<UpsertFileResult> {
  const db = getDb(c);
  const env = c.env as Env;
  const userId = opts.ownerId;
  const targetPath = normalizePath(opts.targetPath);
  const segs = targetPath.split('/').filter(Boolean);
  const fileName = segs.pop();
  if (!fileName) throw ApiError.badRequest('目标路径无效');
  const parentPath = '/' + segs.join('/');
  const mimeType = opts.mimeType || 'application/octet-stream';
  validateFileType(fileName, mimeType);

  // §28 写入口模式：user_space 下对象必须落在调用者用户空间内（free/flat 无路径约束）。
  // 先于 ensureFolders：避免在用户空间之外自愈出目录行；用户空间内自愈的祖先目录天然合规，无需再判。
  await assertWritable(db, opts.mount, userId, targetPath);

  if (opts.ensureParents !== false) {
    await ensureFolders(db, opts.mount, parentPath, userId);
  }

  const existing = await FileRepo.getFileAtPath(db, opts.mount.id, parentPath, fileName, userId);
  const isOverwrite = !!(existing && existing.type === 'file');

  // 虚拟路径是挂载内全局命名空间：他人占用在写对象之前 409（§F 起物理键可跨文件共享，
  // 占用判定必须落在路径行上，不能再依赖对象键唯一性）。
  const occupant = await FileRepo.getFileAtPath(db, opts.mount.id, parentPath, fileName);
  if (occupant && occupant.ownerId !== userId) {
    throw new ApiError(409, 'CONFLICT', '目标路径已被其他用户占用');
  }
  // 目录占用：同一路径已存在文件夹（任何属主）→ 不能作为文件写入
  const folderAtTarget = await FileRepo.getFolderAtPath(db, opts.mount.id, targetPath, fileName);
  if (folderAtTarget) {
    throw new ApiError(409, 'CONFLICT', `路径 ${targetPath} 已是文件夹`);
  }

  const declaredSize = opts.size > 0 ? opts.size : 0;
  // §E/§30 存储池选桶：覆盖写优先粘住原 provider（容量装不下才按策略回退，避免跨桶残留旧对象）；
  // 新文件按池策略选桶。成员级容量在选桶时原子预留——覆盖写的增量 = 新大小 − 旧大小（旧行仍计入聚合），
  // 与用户/挂载两道预留同生命周期：提交事务内释放，失败/补偿路径释放。
  const memberReserved = isOverwrite && existing ? Math.max(0, declaredSize - existing.size) : declaredSize;
  // §31 桶级矩阵：候选桶对发起者角色明确禁止 write → 跳过该候选（全部被拒 → 403）
  const principal = await getPrincipal(c);
  const intentRow = await pickWriteProvider(db, opts.mount, targetPath, env, memberReserved, {
    preferProviderId: isOverwrite ? (existing?.providerId ?? null) : null,
    principalRole: principal.role,
  });
  // 直写不创建 upload_sessions——成员预留登记到台账，对账据此合并全部预留来源
  // （否则对账按在途会话重算会把直写预留归零）。台账随各释放路径删除，写路径并入提交事务。
  let reservationId: string;
  try {
    reservationId = await ReservationRepo.create(db, {
      mountId: opts.mount.id,
      providerId: intentRow.id,
      size: memberReserved,
    });
  } catch (err) {
    await MountProviderQuotaRepo.release(db, opts.mount.id, intentRow.id, memberReserved);
    throw err;
  }

  const reserved = await QuotaRepo.reserve(db, userId, declaredSize);
  if (!reserved) {
    await MountProviderQuotaRepo.release(db, opts.mount.id, intentRow.id, memberReserved);
    await ReservationRepo.remove(db, reservationId);
    throw new ApiError(413, 'QUOTA_EXCEEDED', '存储配额不足');
  }
  if (!existing || existing.type !== 'file') {
    const canAdd = await QuotaRepo.canAddFile(db, userId);
    if (!canAdd) {
      await QuotaRepo.releaseReservation(db, userId, declaredSize);
      await MountProviderQuotaRepo.release(db, opts.mount.id, intentRow.id, memberReserved);
      await ReservationRepo.remove(db, reservationId);
      throw new ApiError(413, 'QUOTA_EXCEEDED', '文件数量配额已满');
    }
  }
  // 第二道闸门：挂载点容量（与用户限额独立，取交集语义）
  const mountReserved = await MountQuotaRepo.reserve(db, opts.mount.id, declaredSize);
  if (!mountReserved) {
    await QuotaRepo.releaseReservation(db, userId, declaredSize);
    await MountProviderQuotaRepo.release(db, opts.mount.id, intentRow.id, memberReserved);
    await ReservationRepo.remove(db, reservationId);
    throw new ApiError(413, 'MOUNT_QUOTA_EXCEEDED', '挂载点容量不足');
  }
  // 虚拟对象键：文件行的稳定标识（内容寻址后不再等于物理键，但唯一性/`folder:` 约定不变）
  const objectKey = objectKeyFromPath(opts.mount.mountPath, intentRow.pathPrefix ?? '', targetPath);

  const fileId = isOverwrite && existing ? existing.id : uuid();
  // 已写入对象的结果（补偿用）：只在写入成功后赋值
  let written: ContentWriteResult | null = null;
  try {
    const outcome = await writeContentAddressed(db, env, {
      providerRow: intentRow,
      mountId: opts.mount.id,
      fallbackKey: objectKey,
      body: opts.body,
      mimeType,
      declaredSize,
      contentHash: opts.contentHash,
      metadata: opts.metadata,
    });
    written = outcome;

    const finalSize = outcome.size;
    const now = Date.now();
    await db.transaction(async (tx) => {
      if (isOverwrite && existing) {
        // 旧对象清理：非内容寻址旧行独占物理键，覆盖后成为孤儿 → 交清理队列（sweeper 重试/记孤儿）；
        // 内容寻址旧行走引用释放（下面 releaseTx）。
        const oldPhysicalKey = existing.physicalKey ?? existing.objectKey;
        const legacyCleanup = !existing.blobHash && oldPhysicalKey !== outcome.objectKey;
        await FileRepo.updateFileTx(tx, existing.id, {
          object_key: objectKey,
          physical_key: outcome.objectKey,
          blob_hash: outcome.hash,
          size: finalSize,
          etag: outcome.etag,
          mime_type: mimeType,
          path: parentPath,
          provider_id: outcome.providerId,
          ...(legacyCleanup ? { source_cleanup_pending: 1, old_object_key: oldPhysicalKey } : {}),
        });
        // 旧内容引用释放：同一批内判定「最后一个引用」，归零则入回收队列
        if (existing.blobHash && existing.blobHash !== outcome.hash) {
          await BlobRepo.releaseTx(tx, existing.blobHash, now);
        }
        await tx.query(
          `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ? + ?), quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE user_id = ?`,
          [existing.size, finalSize, declaredSize, now, userId]
        );
        await tx.query(
          `UPDATE mounts SET used_storage = MAX(0, used_storage - ? + ?), quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE id = ?`,
          [existing.size, finalSize, declaredSize, now, opts.mount.id]
        );
      } else {
        await FileRepo.createFileTx(tx, {
          id: fileId, mountId: opts.mount.id, objectKey, path: parentPath, name: fileName,
          type: 'file', mimeType, size: finalSize, etag: outcome.etag, ownerId: userId,
          providerId: outcome.providerId, physicalKey: outcome.objectKey, blobHash: outcome.hash,
        });
        await tx.query(
          `UPDATE user_quotas SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?), used_files = used_files + 1, updated_at = ? WHERE user_id = ?`,
          [finalSize, declaredSize, now, userId]
        );
        await tx.query(
          `UPDATE mounts SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE id = ?`,
          [finalSize, declaredSize, now, opts.mount.id]
        );
      }
      // §30 成员级容量：文件行已落库（已用聚合已含本文件）→ 与落账同批释放预留，
      // 避免「已记账 + 仍预留」的双重占额窗口。台账行同批删除。
      await MountProviderQuotaRepo.releaseTx(tx, opts.mount.id, intentRow.id, memberReserved);
      await ReservationRepo.remove(tx, reservationId);
      // 内容索引登记（幂等，按 (hash, mount_id) 隔离）+ 撤销同 hash 的待回收条目；未内容寻址（hash 为空）跳过
      if (outcome.hash) {
        await BlobRepo.registerTx(tx, {
          hash: outcome.hash,
          mountId: opts.mount.id,
          providerId: outcome.providerId,
          objectKey: outcome.objectKey,
          size: finalSize,
          etag: outcome.etag,
        }, now);
      }
      await tx.query(
        `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
         VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 200, ?)`,
        [uuid(), userId, targetPath, JSON.stringify({ fileName, via: opts.via, deduped: outcome.deduped }), requestIp(c.req.raw) ?? null, c.req.header('user-agent'), finalSize, now]
      );
    });

    return {
      fileId,
      created: !isOverwrite,
      objectKey: outcome.objectKey,
      etag: outcome.etag,
      size: finalSize,
      providerId: outcome.providerId,
      blobHash: outcome.hash ?? undefined,
    };
  } catch (err) {
    await QuotaRepo.releaseReservation(db, userId, declaredSize);
    await MountQuotaRepo.releaseReservation(db, opts.mount.id, declaredSize);
    await MountProviderQuotaRepo.release(db, opts.mount.id, intentRow.id, memberReserved);
    await ReservationRepo.remove(db, reservationId);
    if (written && !written.deduped) {
      const reason = isOverwrite ? 'overwrite_db_failed' : 'upload_db_failed';
      // 覆盖失败保留对象（可能承载旧文件唯一副本）；新建失败尝试删除，失败则记录孤儿。
      // 删除前复查内容索引：并发写入同内容（本挂载内）已登记时对象被共享，不能删。
      const stillUnreferenced = !written.hash || !(await BlobRepo.get(db, written.hash, opts.mount.id));
      if (!isOverwrite && stillUnreferenced) {
        try {
          const row = await ProviderRepo.getProviderById(db, written.providerId);
          const provider = row ? await getProvider(db, row, env) : null;
          if (!provider) throw new Error('provider not found');
          await provider.deleteObject(written.objectKey);
        } catch (cleanupErr) {
          await ReconciliationRepo.createOrphanObject(db, {
            mountId: opts.mount.id,
            objectKey: written.objectKey,
            reason,
            error: cleanupErr instanceof Error ? cleanupErr.message : 'unknown',
          });
        }
      } else if (isOverwrite) {
        try {
          await ReconciliationRepo.createOrphanObject(db, {
            mountId: opts.mount.id,
            objectKey: written.objectKey,
            reason,
            error: err instanceof Error ? err.message : 'unknown',
          });
        } catch {
          // 对账记录失败不影响主错误传播
        }
      }
    }
    throw err;
  }
}

/**
 * 构建外部可用的文件访问 URL（图床命门）：
 * 1. provider 配置了公网域名（getPublicUrl）→ 返回 CDN 直链；
 * 2. 否则返回 `{origin}{directPrefix}{虚拟路径}?sign=` —— path-serve 用签名放行匿名 GET（能力范围=该路径）。
 * `objectKey` 传物理键（§F：内容键），CDN 直链需指向真实对象。
 * `prefixes` 可选：批量生成（如公开列表逐项）时先 loadRoutePrefixes 一次并复用，避免 N 次设置查询。
 */
export async function buildFileAccessUrl(
  c: Context,
  provider: StorageProviderInterface,
  objectKey: string,
  targetPath: string,
  expiresAt = 0,
  prefixes?: RoutePrefixes
): Promise<string> {
  const env = c.env as Env;
  const cdn = provider.getPublicUrl(objectKey);
  if (cdn) return cdn;
  const { directPrefix } = prefixes ?? (await loadRoutePrefixes(getDb(c)));
  const sign = await signPath(targetPath, env.ENCRYPTION_KEY, expiresAt);
  const origin = env.APP_BASE_URL || `${c.req.url.split('/').slice(0, 3).join('/')}`;
  return directUrl(origin, directPrefix, targetPath, sign);
}
