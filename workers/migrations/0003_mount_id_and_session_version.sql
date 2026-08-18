-- 0003_mount_id_and_session_version.sql
-- 审计 H-01：path_rules 增加 mount_id（挂载隔离）
-- 审计 H-05：users 增加 session_version（会话撤销）
-- 迁移 0001 之后追加：直接 ALTER TABLE（0001 中两表已创建）

-- 1) path_rules.mount_id：绑定规则到挂载点（NULL = 全局规则，兼容旧数据）
ALTER TABLE path_rules ADD COLUMN mount_id TEXT;
CREATE INDEX IF NOT EXISTS idx_path_rules_mount ON path_rules(mount_id, status);

-- 2) users.session_version：递增使旧 JWT 立即失效
ALTER TABLE users ADD COLUMN session_version INTEGER DEFAULT 0;

-- 注意：path_rules.mount_id 的外键约束需在重建表时加入（ALTER 无法加 FK）。
-- 查询层强制按挂载过滤，迁移不重建表以保留数据。

-- ==================== 降级脚本（注释形式） ====================
-- DROP INDEX IF EXISTS idx_path_rules_mount;
-- ALTER TABLE path_rules DROP COLUMN mount_id;
-- ALTER TABLE users DROP COLUMN session_version;
