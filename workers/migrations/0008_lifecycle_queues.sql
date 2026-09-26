-- 0008：回收队列挂载隔离 + 孤儿对象 abort 重试 + 上传完成原子领取 + 直写预留台账
--
-- 1) blob_gc 回收队列由 hash 单键升级为 (hash, mount_id) 复合键：
--    blob_objects 已按 (hash, mount_id) 隔离，回收队列仍按 hash 单键会让跨挂载同 hash 副本
--    在队列中互相覆盖/一一对应不上（回收滞后、物理对象遗留）。存量行无 mount_id：
--    从同 hash 的 blob_objects 行回填；确实无索引行可回填（历史孤儿）用空串哨兵，由处理端照常删除。
-- 2) orphan_objects 补 upload_id（记录 multipart upload id，abort 失败后可重试）。
-- 3) upload_sessions 补 complete_claimed_at（upload-complete 原子领取）。
-- 4) quota_reservations 直写预留台账（成员级 quota_reserved 对账合并全部预留来源）。
--
-- 回滚脚本（注释形式保留）：
--   -- 1) 还原 blob_gc 为 hash 单键：
--   CREATE TABLE blob_gc_old (hash TEXT PRIMARY KEY, provider_id TEXT NOT NULL, object_key TEXT NOT NULL,
--     attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
--   INSERT OR IGNORE INTO blob_gc_old SELECT hash, provider_id, object_key, attempts, created_at FROM blob_gc;
--   DROP TABLE blob_gc; ALTER TABLE blob_gc_old RENAME TO blob_gc;
--   -- 2)/3) SQLite 支持 DROP COLUMN（3.35+）：ALTER TABLE orphan_objects DROP COLUMN upload_id;
--   --      ALTER TABLE upload_sessions DROP COLUMN complete_claimed_at;
--   -- 4) DROP INDEX IF EXISTS idx_quota_reservations_scope; DROP TABLE IF EXISTS quota_reservations;

-- ============ 1) blob_gc → (hash, mount_id) ============
CREATE TABLE IF NOT EXISTS blob_gc_scoped (
  hash TEXT NOT NULL,
  mount_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hash, mount_id)
);

INSERT OR IGNORE INTO blob_gc_scoped (hash, mount_id, provider_id, object_key, attempts, created_at)
SELECT g.hash,
       COALESCE((SELECT b.mount_id FROM blob_objects b WHERE b.hash = g.hash ORDER BY b.mount_id LIMIT 1), ''),
       g.provider_id, g.object_key, g.attempts, g.created_at
FROM blob_gc g;

DROP TABLE blob_gc;
ALTER TABLE blob_gc_scoped RENAME TO blob_gc;
CREATE INDEX IF NOT EXISTS idx_blob_gc_mount ON blob_gc(mount_id, provider_id);

-- ============ 2) orphan_objects.upload_id ============
ALTER TABLE orphan_objects ADD COLUMN upload_id TEXT;

-- ============ 3) upload_sessions.complete_claimed_at ============
ALTER TABLE upload_sessions ADD COLUMN complete_claimed_at INTEGER;

-- ============ 4) quota_reservations 直写预留台账 ============
-- 直写（write.ts / 跨挂载移动）不创建 upload_sessions，成员级预留此前无法被对账感知；
-- 台账行在预留建立时写入、释放/落账时删除；对账把「在途会话 + 台账」两来源合并。
CREATE TABLE IF NOT EXISTS quota_reservations (
  id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_scope ON quota_reservations(mount_id, provider_id);
