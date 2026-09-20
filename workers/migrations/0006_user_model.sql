-- 0006_user_model.sql
-- 用户模型完善（对照报告 §4.4）：
--   a) file_metadata.visibility    三级可见性（private | users | public）
--   b) file_metadata.review_status 公开审核状态（public 需 approved 才进 gallery）
--   c) path_rules.origin           规则来源（admin | user；system 仅内存合成规则，不入库）
--   d) path_rules.created_by       user-origin 规则的创建者
--   e) users.capabilities          能力位 JSON 数组（can_publish / can_share / can_grant）
-- 升级脚本（本文件）；降级脚本见文件末尾注释。

-- 1) 三级可见性：默认 private 保持既有行为。
--    users = 全部登录用户可 read/download；public = 在 users 基础上进入公开空间（gallery 匿名面）。
ALTER TABLE file_metadata ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
CREATE INDEX IF NOT EXISTS idx_file_metadata_visibility ON file_metadata(visibility, owner_id);

-- 2) 公开审核：public 提交后默认 pending，管理员 approved 后进入 gallery；
--    private/users 语义与该列无关（默认 approved 便于统一查询）。
ALTER TABLE file_metadata ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_file_metadata_review ON file_metadata(visibility, review_status);

-- 3) path_rules 规则来源：user-origin 规则由用户在设置页创建（创建时校验边界与所有权），
--    sortRules 按 origin（admin > user > system）压制，用户规则不可越权。
ALTER TABLE path_rules ADD COLUMN origin TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE path_rules ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_path_rules_created_by ON path_rules(created_by);

-- 4) 能力位：JSON 数组（如 '["can_share"]'）。NULL 视为空集；
--    存量用户回填 can_share 保持既有分享行为不变。
ALTER TABLE users ADD COLUMN capabilities TEXT;
UPDATE users SET capabilities = '["can_share"]' WHERE capabilities IS NULL;

-- ==================== 降级脚本（注释形式） ====================
-- DROP INDEX IF EXISTS idx_file_metadata_visibility;
-- DROP INDEX IF EXISTS idx_file_metadata_review;
-- ALTER TABLE file_metadata DROP COLUMN review_status;
-- ALTER TABLE file_metadata DROP COLUMN visibility;
-- DROP INDEX IF EXISTS idx_path_rules_created_by;
-- ALTER TABLE path_rules DROP COLUMN created_by;
-- ALTER TABLE path_rules DROP COLUMN origin;
-- ALTER TABLE users DROP COLUMN capabilities;
