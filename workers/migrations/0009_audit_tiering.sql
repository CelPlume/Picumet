-- 0009：审计日志冷热分层
--
-- 热层（D1 access_logs）：
--   1) 管理列表改为显式列 + 游标分页（(created_at, id) 稳定排序键），索引补
--      idx_access_logs_created_id（时间线）与 idx_access_logs_action_created_id（按动作筛选的时间线）；
--   2) 单列 idx_access_logs_action 是 idx_access_logs_action_created_at 的左前缀重叠候选，
--      调用方（列表行筛选 / 趋势动作过滤）全部按 action + created_at 组合使用 → 删除以省写放大。
--      （删除前已用 EXPLAIN QUERY PLAN 在本地 SQLite 验证：两条查询均命中 action_created 复合索引。）
-- 冷层（R2 + D1 manifest）：
--   3) audit_archives：归档清单（时间范围、行数、对象键、字节数、SHA-256、导出版本）；
--   4) audit_rollups：归档窗口内非安全动作的按小时计数（趋势查询合并热表 + rollups 两源，避免
--      归档删除后曲线缺段）。status_code 无值时以 0 占位（SQLite 主键列不允许 NULL）。
--
-- 回滚脚本（注释形式保留）：
--   DROP INDEX IF EXISTS idx_access_logs_created_id;
--   DROP INDEX IF EXISTS idx_access_logs_action_created_id;
--   CREATE INDEX IF NOT EXISTS idx_access_logs_action ON access_logs(action);
--   DROP TABLE IF EXISTS audit_rollups;
--   DROP TABLE IF EXISTS audit_archives;

CREATE INDEX IF NOT EXISTS idx_access_logs_created_id ON access_logs(created_at, id);
CREATE INDEX IF NOT EXISTS idx_access_logs_action_created_id ON access_logs(action, created_at, id);
DROP INDEX IF EXISTS idx_access_logs_action;

CREATE TABLE IF NOT EXISTS audit_archives (
  id TEXT PRIMARY KEY,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  /** 热行清理是否已完成（0 = manifest 已落库但删除批次未跑完，下轮继续只删不重导） */
  pruned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_archives_range ON audit_archives(range_start, range_end);

CREATE TABLE IF NOT EXISTS audit_rollups (
  bucket_start INTEGER NOT NULL,
  action TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  bytes_transferred INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, action, status_code)
);
