-- 0010：邀请码注册机制
--
-- invite_codes：邀请码表。码值为 6 位数字 + 大写字母（[0-9A-Z]{6}，crypto 随机生成，
--   UNIQUE 约束 + 应用层碰撞重试，匹配区分大小写 = SQLite TEXT 默认 BINARY 排序）；
--   一个码可被多人核销，目前不设使用上限与过期。创建人删除时级联删除其生成的码。
-- users.invited_by_code_id：核销关联。注册事务内随建号一并写入（防并发重复核销由
--   「同一事务 + 外键」保证：码行消失则事务回滚）；码行删除时置 NULL 保留用户行。
-- 设置种子 4 项（注册设置分组）：invite_enabled / invite_required / invite_generation /
--   invite_max_per_user。「开放注册」「允许访客」两个既有键沿用 0001 种子，不迁移键名，
--   仅前端分组从「安全设置」挪入「注册设置」。
--
-- 索引说明（EXPLAIN QUERY PLAN 本地 node:sqlite 验证）：
--   idx_invite_codes_created_by 服务「我的邀请码」列表/计数（WHERE created_by = ?，SEARCH）；
--   idx_users_invited_by_code 服务受邀用户聚合（WHERE invited_by_code_id IN (…)，SEARCH）；
--   code 查找走 UNIQUE 约束自带的自动索引，无需另建。
--
-- 回滚脚本（注释形式保留）：
--   DROP INDEX IF EXISTS idx_users_invited_by_code;
--   DROP INDEX IF EXISTS idx_invite_codes_created_by;
--   DROP TABLE IF EXISTS invite_codes;
--   DELETE FROM system_settings WHERE key IN ('invite_enabled', 'invite_required', 'invite_generation', 'invite_max_per_user');
--   -- users.invited_by_code_id 列保留（SQLite DROP COLUMN 需 3.35+ 且 D1 不建议；列可空无副作用）

CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes(created_by);

ALTER TABLE users ADD COLUMN invited_by_code_id TEXT REFERENCES invite_codes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_invited_by_code ON users(invited_by_code_id);

INSERT OR IGNORE INTO system_settings (key, value, description, updated_at) VALUES
('invite_enabled', 'false', '是否开启邀请码注册', unixepoch() * 1000),
('invite_required', 'false', '开启后邀请码是否必填（必填 = 无码不可注册）', unixepoch() * 1000),
('invite_generation', 'all_users', '邀请码生成权限（all_users = 全部用户 / admin_only = 仅管理员）', unixepoch() * 1000),
('invite_max_per_user', '5', '每用户最大邀请码生成数量', unixepoch() * 1000);
