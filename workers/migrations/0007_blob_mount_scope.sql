-- 0007：内容对象索引按挂载隔离 + 用户删除对象清理队列
--
-- blob_objects 由全局 `hash` 主键改为复合主键 `(hash, mount_id)`。全局去重会让新挂载的文件行
--   指向另一个挂载池的 provider/对象键（跨挂载物理归属泄漏：failover、桶级矩阵、容量展示与对象
--   生命周期全部耦合）。改为挂载内去重：同挂载仍只存一份，跨挂载同内容各写一份并各自登记索引行。
--   存量行回填：同一 hash 取 file_metadata 中首个引用行的 mount_id；无任何引用（历史孤儿索引）的行
--   用空串哨兵 ''，由 reconcileBlobs 的孤儿扫描按无同挂载引用识别并进入回收队列。
-- orphan_objects 补 provider_id 列（登记时记录落桶，缺失回退挂载锚点）与队列索引。

-- 回滚（blob_objects）：
--   CREATE TABLE blob_objects_old (
--     hash TEXT PRIMARY KEY, provider_id TEXT NOT NULL, object_key TEXT NOT NULL,
--     size INTEGER NOT NULL DEFAULT 0, etag TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
--   INSERT OR REPLACE INTO blob_objects_old
--     SELECT hash, provider_id, object_key, size, etag, created_at, updated_at FROM blob_objects;
--   DROP TABLE blob_objects;
--   ALTER TABLE blob_objects_old RENAME TO blob_objects;
--   CREATE INDEX IF NOT EXISTS idx_blob_objects_provider ON blob_objects(provider_id);
-- 回滚（orphan_objects）：ALTER TABLE orphan_objects DROP COLUMN provider_id; 并 DROP INDEX idx_orphan_objects_queue;

-- ============ 孤儿对象队列补 provider_id ============
ALTER TABLE orphan_objects ADD COLUMN provider_id TEXT;
CREATE INDEX IF NOT EXISTS idx_orphan_objects_queue ON orphan_objects(reason, cleaned, created_at);

-- ============ blob_objects 重建为 (hash, mount_id) ============
CREATE TABLE IF NOT EXISTS blob_objects_scoped (
  hash TEXT NOT NULL,
  mount_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (hash, mount_id)
);

INSERT OR IGNORE INTO blob_objects_scoped (hash, mount_id, provider_id, object_key, size, etag, created_at, updated_at)
SELECT b.hash,
       COALESCE(
         (SELECT f.mount_id FROM file_metadata f WHERE f.blob_hash = b.hash ORDER BY f.mount_id LIMIT 1),
         ''
       ),
       b.provider_id, b.object_key, b.size, b.etag, b.created_at, b.updated_at
FROM blob_objects b;

DROP TABLE blob_objects;
ALTER TABLE blob_objects_scoped RENAME TO blob_objects;

CREATE INDEX IF NOT EXISTS idx_blob_objects_provider ON blob_objects(provider_id);
CREATE INDEX IF NOT EXISTS idx_blob_objects_mount ON blob_objects(mount_id);
