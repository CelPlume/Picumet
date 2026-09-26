// 内容寻址对象索引与回收队列（§F）
//
// 设计要点：
// 1. 索引行按 (hash, mount_id) 隔离：同内容只在**同一挂载内**去重，跨挂载各写一份并各自
//    登记索引行——全局去重会让新挂载的文件行指向其它挂载池的 provider/对象键，使 failover、桶级矩阵、
//    容量展示与对象生命周期跨挂载耦合。
// 2. 不在索引行上维护引用计数列——「最后一个引用是否已消失」由删除文件行的同一批语句内用
//    `NOT EXISTS (SELECT 1 FROM file_metadata WHERE blob_hash = ?)` 原子求值（D1 batch 顺序执行，
//    读到的就是同一批内删除后的状态），避免读-改-写竞态。
//    引用判定**保持全局按 hash**，不按挂载缩小引用集：历史/跨挂载索引可能共享同一物理对象，
//    全局保守判定只会少删（留待对账）、不会误删仍在用的对象。
import { Db, type Tx } from '../db';
import { num, str, type Row } from '../row';

export interface BlobObject {
  hash: string;
  mountId: string;
  providerId: string;
  objectKey: string;
  size: number;
  etag?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BlobGcEntry {
  hash: string;
  /** 挂载 ID：回收队列与 blob_objects 同为 (hash, mount_id) 复合键——跨挂载同内容副本各自成条，互不覆盖 */
  mountId: string;
  providerId: string;
  objectKey: string;
  attempts: number;
  createdAt: number;
}

function mapBlob(row: Row): BlobObject {
  return {
    hash: str(row.hash)!,
    mountId: str(row.mount_id)!,
    providerId: str(row.provider_id)!,
    objectKey: str(row.object_key)!,
    size: num(row.size),
    etag: str(row.etag),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function mapGc(row: Row): BlobGcEntry {
  return {
    hash: str(row.hash)!,
    mountId: str(row.mount_id) ?? '',
    providerId: str(row.provider_id)!,
    objectKey: str(row.object_key)!,
    attempts: num(row.attempts),
    createdAt: num(row.created_at),
  };
}

export const BlobRepo = {
  /** 挂载内查找内容对象：跨挂载同内容互相不可见（去重只在同一挂载内成立） */
  async get(db: Db, hash: string, mountId: string): Promise<BlobObject | null> {
    const row = await db.first('SELECT * FROM blob_objects WHERE hash = ? AND mount_id = ?', [hash, mountId]);
    return row ? mapBlob(row) : null;
  },

  /**
   * 登记内容对象（幂等）：并发写同内容时先到者生效，后到者复用其落点。
   * 同时撤销**本挂载**该 hash 的待回收条目——对象被重新引用（对象键按内容确定，重写即同一对象）。
   * 队列按 (hash, mount_id) 隔离，撤销不得跨挂载误删他挂载的待回收条目。
   */
  async registerTx(
    tx: Tx,
    blob: { hash: string; mountId: string; providerId: string; objectKey: string; size: number; etag?: string },
    now: number
  ): Promise<void> {
    await tx.query(
      `INSERT OR IGNORE INTO blob_objects (hash, mount_id, provider_id, object_key, size, etag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [blob.hash, blob.mountId, blob.providerId, blob.objectKey, blob.size, blob.etag ?? null, now, now]
    );
    await tx.query('DELETE FROM blob_gc WHERE hash = ? AND mount_id = ?', [blob.hash, blob.mountId]);
  },

  /** 登记内容对象（自带事务；定时任务/对账路径使用） */
  async register(
    db: Db,
    blob: { hash: string; mountId: string; providerId: string; objectKey: string; size: number; etag?: string },
    now: number
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await BlobRepo.registerTx(tx, blob, now);
    });
  },

  /**
   * 释放引用：必须在「删除/改写文件行」的同一批里、且排在其后调用。
   * 最后一个引用消失 → 每个挂载的索引行各入回收队列一条（(hash, mount_id) 复合键）+ 删除该 hash 的全部索引行；
   * 仍有其他引用 → 什么都不做。
   * 判定保持全局（不按挂载缩小引用集）：跨挂载索引可能共享同一物理对象，保守判定只少删不误删。
   * 某挂载自身已无引用、但其他挂载仍引用同一 hash 时，该挂载的陈旧索引行由 reconcileBlobs 的
   * 孤儿扫描（按同挂载引用判定）清掉，避免长时间占位。
   */
  async releaseTx(tx: Tx, hash: string, now: number): Promise<void> {
    await tx.query(
      `INSERT OR IGNORE INTO blob_gc (hash, mount_id, provider_id, object_key, attempts, created_at)
       SELECT hash, mount_id, provider_id, object_key, 0, ? FROM blob_objects
       WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM file_metadata WHERE blob_hash = ?)`,
      [now, hash, hash]
    );
    await tx.query(
      `DELETE FROM blob_objects WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM file_metadata WHERE blob_hash = ?)`,
      [hash, hash]
    );
  },

  /** 待回收内容对象（保护期由调用方按 createdAt 判断） */
  async listGc(db: Db, limit: number): Promise<BlobGcEntry[]> {
    const rows = await db.all('SELECT * FROM blob_gc ORDER BY created_at ASC LIMIT ?', [limit]);
    return rows.map(mapGc);
  },

  async removeGc(db: Db, hash: string, mountId: string): Promise<void> {
    await db.run('DELETE FROM blob_gc WHERE hash = ? AND mount_id = ?', [hash, mountId]);
  },

  async bumpGcAttempts(db: Db, hash: string, mountId: string): Promise<void> {
    await db.run('UPDATE blob_gc SET attempts = attempts + 1 WHERE hash = ? AND mount_id = ?', [hash, mountId]);
  },

  /**
   * 引用数仍大于 0 的哈希（回收前复查：被重新引用的对象不删）。
   * **全局按 hash** 检查，不按挂载缩小引用集——跨挂载历史索引可能指向同一物理对象，
   * 只按本挂载判定会误删其他挂载仍在用的镜像/共享对象。
   */
  async isReferenced(db: Db, hash: string): Promise<boolean> {
    const row = await db.first('SELECT 1 AS x FROM file_metadata WHERE blob_hash = ? LIMIT 1', [hash]);
    return !!row;
  },

  /** 对账：缺索引行的内容文件（按挂载内 hash 判定，取任一落点恢复索引） */
  async listMissingIndex(
    db: Db,
    limit: number
  ): Promise<Array<{ hash: string; mountId: string; providerId: string; objectKey: string; size: number; etag?: string }>> {
    const rows = await db.all(
      `SELECT f.blob_hash AS hash,
              f.mount_id AS mount_id,
              COALESCE(f.provider_id, m.provider_id) AS provider_id,
              COALESCE(f.physical_key, f.object_key) AS object_key,
              f.size AS size, f.etag AS etag
       FROM file_metadata f
       JOIN mounts m ON m.id = f.mount_id
       WHERE f.blob_hash IS NOT NULL AND f.type = 'file'
         AND NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.hash = f.blob_hash AND b.mount_id = f.mount_id)
       LIMIT ?`,
      [limit]
    );
    return rows.map((r) => ({
      hash: str(r.hash)!,
      mountId: str(r.mount_id)!,
      providerId: str(r.provider_id)!,
      objectKey: str(r.object_key)!,
      size: num(r.size),
      etag: str(r.etag),
    }));
  },

  /**
   * 对账：本挂载已无引用且未入回收队列的索引行（updated_at 早于 before 才纳入，避开在途写入）。
   * 孤儿按 (hash, mount_id) 判定——其他挂载的引用不阻止本挂载陈旧行出队（物理删除仍由全局引用兜底）。
   */
  async listOrphanIndex(db: Db, before: number, limit: number): Promise<BlobGcEntry[]> {
    const rows = await db.all(
      `SELECT b.hash AS hash, b.mount_id AS mount_id, b.provider_id AS provider_id, b.object_key AS object_key,
              0 AS attempts, b.updated_at AS created_at
       FROM blob_objects b
       WHERE b.updated_at < ?
         AND NOT EXISTS (SELECT 1 FROM file_metadata f WHERE f.blob_hash = b.hash AND f.mount_id = b.mount_id)
         AND NOT EXISTS (SELECT 1 FROM blob_gc g WHERE g.hash = b.hash AND g.mount_id = b.mount_id)
       LIMIT ?`,
      [before, limit]
    );
    return rows.map(mapGc);
  },

  /**
   * 入队回收（对账发现的无引用索引行）。落点直接取索引行本身，避免调用方快照与库内状态漂移；
   * 仍有**全局**引用时不入队（保守），只清掉本挂载的陈旧索引行。队列键 (hash, mount_id)。
   */
  async enqueueGc(db: Db, entry: { hash: string; mountId: string }, now: number): Promise<void> {
    await db.run(
      `INSERT OR IGNORE INTO blob_gc (hash, mount_id, provider_id, object_key, attempts, created_at)
       SELECT hash, mount_id, provider_id, object_key, 0, ? FROM blob_objects
       WHERE hash = ? AND mount_id = ?
         AND NOT EXISTS (SELECT 1 FROM file_metadata WHERE blob_hash = ?)`,
      [now, entry.hash, entry.mountId, entry.hash]
    );
    await db.run(
      `DELETE FROM blob_objects WHERE hash = ? AND mount_id = ?
         AND NOT EXISTS (SELECT 1 FROM file_metadata WHERE blob_hash = ? AND mount_id = ?)`,
      [entry.hash, entry.mountId, entry.hash, entry.mountId]
    );
  },

  /** 去重统计：内容对象索引行数与逻辑/物理占用（管理端展示用；跨挂载共享物理对象会计入多次） */
  async stats(db: Db): Promise<{ blobs: number; physicalBytes: number; logicalBytes: number; dedupedFiles: number }> {
    const blobRow = await db.first('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM blob_objects');
    const fileRow = await db.first(
      `SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS c FROM file_metadata WHERE type = 'file' AND blob_hash IS NOT NULL`
    );
    return {
      blobs: num(blobRow?.c),
      physicalBytes: num(blobRow?.s),
      logicalBytes: num(fileRow?.s),
      dedupedFiles: num(fileRow?.c),
    };
  },
};
