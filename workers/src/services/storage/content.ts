// 内容寻址写入（§F）：把「确定内容哈希 → 确定物理对象键 → 落对象」这段逻辑收口，
// 供统一写入路径（兼容上传/WebDAV/S3 网关/AList）与上传会话 Worker 代理路径共用。
//
// 写入策略：
//   1. 已知哈希（调用方整包校验，如 S3 网关 SigV4）：库内已有 → 不写对象；否则直写内容键；
//   2. 未知哈希：暂存键 + 流式哈希 → 命中删除暂存，未命中复制到内容键后删除暂存。
import type { Db } from '../../db';
import { BlobRepo, ReconciliationRepo } from '../../db';
import type { StorageProvider } from '@shared/types';
import type { Env } from '../../shared/types';
import { ApiError } from '../../shared/errors';
import { uuid } from '../../utils/crypto';
import { hashPassThrough } from '../../utils/sha256';
import { getProvider } from './providers';
import { blobObjectKey, stagingObjectKey } from './keys';
import type { StorageProviderInterface } from './types';

/** 落点结果 */
export interface ContentWriteResult {
  providerId: string;
  objectKey: string;
  size: number;
  etag?: string;
  /** 内容 SHA-256；null = 本次未内容寻址（未知长度流回退路径键写入） */
  hash: string | null;
  /** true = 复用库内既有内容对象（本次未写入对象） */
  deduped: boolean;
}

export interface ContentWriteOpts {
  /** 选定落桶 provider（去重命中时以既有内容的落点为最终结果） */
  providerRow: StorageProvider;
  /** 归属挂载点（孤儿对象对账记录用） */
  mountId: string;
  /** 回退虚拟对象键：未知长度流（无法定长包装）时直接写入该键，不参与去重 */
  fallbackKey: string;
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  /** 已知大小时 >0；未知传 0（以实际字节数为准） */
  declaredSize: number;
  /** 已知内容哈希（调用方已整包校验） */
  contentHash?: string;
  metadata?: Record<string, string>;
}

/**
 * 内容寻址写入：确定内容哈希与物理对象键，返回落点。
 * - 已知哈希 + 库内已有内容 → 不写对象（去重完全命中）；
 * - 已知哈希 + 库内没有 → 直写内容键（键由哈希决定，无需暂存）；
 * - 未知哈希 → 暂存写入并流式哈希 → 命中删除暂存，未命中复制到内容键并删除暂存。
 */
export async function writeContentAddressed(db: Db, env: Env, opts: ContentWriteOpts): Promise<ContentWriteResult> {
  const { providerRow, mountId, mimeType, declaredSize, metadata } = opts;
  const knownHash = opts.contentHash;
  // R2 绑定要求流带已知长度（request/response body 或 FixedLengthStream 的可读端），
  // 而边写边哈希必须包装原始流 → 长度未知时无从包装，退化为路径键写入（不参与去重）。
  const needsKnownLength = providerRow.type === 'r2' && !providerRow.endpoint;

  if (!knownHash && declaredSize <= 0 && needsKnownLength) {
    const provider = await getProvider(db, providerRow, env);
    await provider.putObject(opts.fallbackKey, opts.body, mimeType, metadata);
    const head = await provider.headObject(opts.fallbackKey);
    if (!head) throw new ApiError(422, 'OPERATION_FAILED', '上传校验失败');
    return {
      providerId: providerRow.id,
      objectKey: opts.fallbackKey,
      size: head.size,
      etag: head.etag,
      hash: null,
      deduped: false,
    };
  }

  if (knownHash) {
    const blob = await BlobRepo.get(db, knownHash);
    if (blob) {
      // 去重命中：内容已在库，丢弃上传流（不再写对象）
      opts.body.cancel().catch(() => undefined);
      return {
        providerId: blob.providerId,
        objectKey: blob.objectKey,
        size: declaredSize || blob.size,
        etag: blob.etag,
        hash: knownHash,
        deduped: true,
      };
    }
    const provider = await getProvider(db, providerRow, env);
    const key = blobObjectKey(providerRow.pathPrefix, knownHash);
    const put = await provider.putObject(key, withKnownLength(opts.body, declaredSize, needsKnownLength), mimeType, metadata);
    // 未计数字节的路径：以 HEAD 结果为准（大小/ETag 校验，防止流被截断）
    const head = await provider.headObject(key);
    if (!head) throw new ApiError(422, 'OPERATION_FAILED', '上传校验失败');
    if (declaredSize > 0 && head.size !== declaredSize) {
      throw new ApiError(422, 'OPERATION_FAILED', '上传校验失败：对象大小与请求不一致');
    }
    return {
      providerId: providerRow.id,
      objectKey: key,
      size: declaredSize > 0 ? declaredSize : head.size,
      etag: head.etag ?? put.etag,
      hash: knownHash,
      deduped: false,
    };
  }

  const provider = await getProvider(db, providerRow, env);
  const stagingKey = stagingObjectKey(providerRow.pathPrefix, uuid());
  const { body, digest } = hashPassThrough(opts.body);
  await provider.putObject(stagingKey, withKnownLength(body, declaredSize, needsKnownLength), mimeType, metadata);
  const { hex, size } = await digest;
  if (declaredSize > 0 && size !== declaredSize) {
    await deleteObjectQuietly(db, provider, stagingKey, mountId, 'staging_mismatch');
    throw new ApiError(422, 'OPERATION_FAILED', '上传校验失败：对象大小与请求不一致');
  }

  const blob = await BlobRepo.get(db, hex);
  if (blob) {
    await deleteObjectQuietly(db, provider, stagingKey, mountId, 'staging_dedupe_hit');
    return { providerId: blob.providerId, objectKey: blob.objectKey, size, etag: blob.etag, hash: hex, deduped: true };
  }

  const key = blobObjectKey(providerRow.pathPrefix, hex);
  try {
    const copied = await provider.copyObject(stagingKey, key);
    await deleteObjectQuietly(db, provider, stagingKey, mountId, 'staging_after_copy');
    return { providerId: providerRow.id, objectKey: key, size, etag: copied.etag, hash: hex, deduped: false };
  } catch (err) {
    await deleteObjectQuietly(db, provider, stagingKey, mountId, 'staging_copy_failed');
    throw err;
  }
}

/** 尽力删除对象；失败记录孤儿供对账（暂存对象清理路径） */
async function deleteObjectQuietly(
  db: Db,
  provider: StorageProviderInterface,
  key: string,
  mountId: string,
  reason: string
): Promise<void> {
  try {
    await provider.deleteObject(key);
  } catch (err) {
    try {
      await ReconciliationRepo.createOrphanObject(db, {
        mountId,
        objectKey: key,
        reason,
        error: err instanceof Error ? err.message : 'unknown',
      });
    } catch {
      // 对账记录失败不影响主流程
    }
  }
}

/** Cloudflare 运行时全局（node 测试环境没有）：定长包装后 R2 绑定才接受构造出的流 */
interface FixedLengthStreamCtor {
  new (length: number): TransformStream<Uint8Array, Uint8Array>;
}

/**
 * R2 绑定要求已知长度的流；包装后的哈希流长度未知，用声明大小包一层 FixedLengthStream。
 * 长度未知（declaredSize<=0）或运行时无该全局时原样返回（S3 协议客户端不要求）。
 */
function withKnownLength(stream: ReadableStream<Uint8Array>, length: number, needed: boolean): ReadableStream<Uint8Array> {
  if (!needed || length <= 0) return stream;
  const ctor = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
  if (!ctor) return stream;
  const fixed = new ctor(length);
  stream.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}
