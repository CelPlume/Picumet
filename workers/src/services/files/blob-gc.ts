// 内容对象引用释放（§F）：与「删除/改写文件行」放进同一批语句是硬性要求。
//
// 判定用 NOT EXISTS(file_metadata.blob_hash = ?) 在批内求值——排在删除语句之后，读到的
// 就是本批删除后的引用状态，因此无需引用计数列，也不存在读-改-写竞态。
import type { Tx } from '../../db';
import { BlobRepo } from '../../db';
import type { FileMetadata } from '@shared/types';

/** 待删除行 → 内容哈希（去重；未内容寻址的行忽略） */
export function blobHashesOf(rows: Array<Pick<FileMetadata, 'blobHash'>>): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.blobHash && !out.includes(row.blobHash)) out.push(row.blobHash);
  }
  return out;
}

/** 待删除行 → 可直接删除的物理对象（非内容寻址：分片/存量对象的键随行独占） */
export function directObjectsOf(
  rows: Array<Pick<FileMetadata, 'blobHash' | 'physicalKey' | 'objectKey' | 'providerId'>>
): Array<{ providerId?: string | null; objectKey: string }> {
  const out: Array<{ providerId?: string | null; objectKey: string }> = [];
  for (const row of rows) {
    if (row.blobHash) continue;
    out.push({ providerId: row.providerId, objectKey: row.physicalKey ?? row.objectKey });
  }
  return out;
}

/**
 * 释放内容引用：必须在同一事务批内、且排在该批的删除/改写语句之后调用。
 * 最后一个引用消失时把对象写入回收队列（blob_gc），索引行删除；仍有引用则无副作用。
 */
export async function releaseBlobsTx(tx: Tx, hashes: string[], now: number): Promise<void> {
  for (const hash of hashes) {
    await BlobRepo.releaseTx(tx, hash, now);
  }
}
