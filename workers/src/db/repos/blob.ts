// 内容寻址对象索引与回收队列（§F）
//
// 设计要点：不在索引行上维护引用计数列——「最后一个引用是否已消失」由删除文件行的同一批
// 语句内用 `NOT EXISTS (SELECT 1 FROM file_metadata WHERE blob_hash = ?)` 原子求值（D1 batch
// 顺序执行，读到的就是同一批内删除后的状态），避免读-改-写竞态。
import { Db, type Tx } from '../db';
import { num, str, type Row } from '../row';

export interface BlobObject {
  hash: string;
  providerId: string;
  objectKey: string;
  size: number;
  etag?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BlobGcEntry {
  hash: string;
  providerId: string;
  objectKey: string;
  attempts: number;
  createdAt: number;
}

function mapBlob(row: Row): BlobObject {
  return {
    hash: str(row.hash)!,
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
    providerId: str(row.provider_id)!,
    objectKey: str(row.object_key)!,
    attempts: num(row.attempts),
    createdAt: num(row.created_at),
  };
}

export const BlobRepo = {
  async get(db: Db, hash: string): Promise<BlobObject | null> {
    const row = await db.first('SELECT * FROM blob_objects WHERE hash = ?', [hash]);
    return row ? mapBlob(row) : null;
  },

  /**
   * 登记内容对象（幂等）：并发写同内容时先到者生效，后到者复用其落点。
   * 同时撤销同 hash 的待回收条目——对象被重新引用（对象键按内容确定，重写即同一对象）。
   */
  async registerTx(tx: Tx, blob: { hash: string; providerId: string; objectKey: string; size: number; etag?: string }, now: number): Promise<void> {
    await tx.query(
      `INSERT OR IGNORE INTO blob_objects (hash, provider_id, object_key, size, etag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [blob.hash, blob.providerId, blob.objectKey, blob.size, blob.etag ?? null, now, now]
    );
    await tx.query('DELETE FROM blob_gc WHERE hash = ?', [blob.hash]);
  },

  /** 登记内容对象（自带事务；定时任务/对账路径使用） */
  async register(db: Db, blob: { hash: string; providerId: string; objectKey: string; size: number; etag?: string }, now: number): Promise<void> {
    await db.transaction(async (tx) => {
      await BlobRepo.registerTx(tx, blob, now);
    });
  },

  /**
   * 释放引用：必须在「删除/改写文件行」的同一批里、且排在其后调用。
   * 最后一个引用消失 → 入回收队列 + 删除索引行；仍有其他引用 → 什么都不做。
   */
  async releaseTx(tx: Tx, hash: string, now: number): Promise<void> {
    await tx.query(
      `INSERT OR IGNORE INTO blob_gc (hash, provider_id, object_key, attempts, created_at)
       SELECT hash, provider_id, object_key, 0, ? FROM blob_objects
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

  async removeGc(db: Db, hash: string): Promise<void> {
    await db.run('DELETE FROM blob_gc WHERE hash = ?', [hash]);
  },

  async bumpGcAttempts(db: Db, hash: string): Promise<void> {
    await db.run('UPDATE blob_gc SET attempts = attempts + 1 WHERE hash = ?', [hash]);
  },

  /** 引用数仍大于 0 的哈希（回收前复查：被重新引用的对象不删） */
  async isReferenced(db: Db, hash: string): Promise<boolean> {
    const row = await db.first('SELECT 1 AS x FROM file_metadata WHERE blob_hash = ? LIMIT 1', [hash]);
    return !!row;
  },

  /** 对账：缺索引行的内容文件（按 hash 聚合，取任一落点恢复索引） */
  async listMissingIndex(db: Db, limit: number): Promise<Array<{ hash: string; providerId: string; objectKey: string; size: number; etag?: string }>> {
    const rows = await db.all(
      `SELECT f.blob_hash AS hash,
              COALESCE(f.provider_id, m.provider_id) AS provider_id,
              COALESCE(f.physical_key, f.object_key) AS object_key,
              f.size AS size, f.etag AS etag
       FROM file_metadata f
       JOIN mounts m ON m.id = f.mount_id
       WHERE f.blob_hash IS NOT NULL AND f.type = 'file'
         AND NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.hash = f.blob_hash)
       LIMIT ?`,
      [limit]
    );
    return rows.map((r) => ({
      hash: str(r.hash)!,
      providerId: str(r.provider_id)!,
      objectKey: str(r.object_key)!,
      size: num(r.size),
      etag: str(r.etag),
    }));
  },

  /** 对账：无引用且未入回收队列的索引行（updated_at 早于 before 才纳入，避开在途写入） */
  async listOrphanIndex(db: Db, before: number, limit: number): Promise<BlobGcEntry[]> {
    const rows = await db.all(
      `SELECT b.hash AS hash, b.provider_id AS provider_id, b.object_key AS object_key,
              0 AS attempts, b.updated_at AS created_at
       FROM blob_objects b
       WHERE b.updated_at < ?
         AND NOT EXISTS (SELECT 1 FROM file_metadata f WHERE f.blob_hash = b.hash)
         AND NOT EXISTS (SELECT 1 FROM blob_gc g WHERE g.hash = b.hash)
       LIMIT ?`,
      [before, limit]
    );
    return rows.map(mapGc);
  },

  /** 入队回收（对账发现的无引用索引行） */
  async enqueueGc(db: Db, entry: { hash: string; providerId: string; objectKey: string }, now: number): Promise<void> {
    await db.run(
      `INSERT OR IGNORE INTO blob_gc (hash, provider_id, object_key, attempts, created_at) VALUES (?, ?, ?, 0, ?)`,
      [entry.hash, entry.providerId, entry.objectKey, now]
    );
    await db.run(
      `DELETE FROM blob_objects WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM file_metadata WHERE blob_hash = ?)`,
      [entry.hash, entry.hash]
    );
  },

  /** 去重统计：内容对象总数与逻辑/物理占用（管理端展示用） */
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
