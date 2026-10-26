-- 目录列表复合索引：listChildren 改为 UNION ALL 双分支取数后，
-- 文件分支按 (mount_id, type, path) 三列等值、目录分支两列等值 + path 范围。
-- 缺此索引时 SQLite 退化为「按 mount 前缀扫描 + 临时 B 树排序」，读行数等于整个挂载点
-- （实测线上 3,022 行/次），有索引后收敛为当前目录自身子项数。
--
-- 回滚脚本（注释形式，按需手工执行）：
--   DROP INDEX IF EXISTS idx_file_metadata_listing;

CREATE INDEX IF NOT EXISTS idx_file_metadata_listing ON file_metadata(mount_id, type, path);
