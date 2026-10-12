-- 0014：注册限流强化——IP 封禁表 + 用户封禁原因 + 三个设置种子键
--
-- ip_bans：IP 封禁名单（管理端「安全设置」维护，ipBanMiddleware 全局门禁）。
--   expires_at NULL = 永久封禁；命中判定忽略已过期行（过期行保留供管理端追溯，不主动清理）。
--   独立表而非「按用户行标记」：封禁要覆盖未注册访客的攻击流量（见 docs/PROGRESS.md 注册限流强化）。
-- users.ban_reason：账号封禁（status='banned'）原因，管理端可见、随封禁审计落库；可空。
-- 设置种子 3 项：
--   auth_rate_limit_per_minute：认证接口限流阈值（次/分钟），默认 10，0 = 关闭该档；
--     注意按 IP 计数在移动/运营商 NAT 出口下会连坐同出口的正常用户，
--     实际生效的判定是「IP 维度 ∩ 账号标识维度」双计数（见 middleware/rate-limit.ts），
--     因此阈值不宜过小（原 2 次/分钟会让「注册 + 登录」就把整个出口打死）。
--   register_success_per_hour_per_ip：每 IP 每小时注册成功数上限，默认 3，0 = 关闭；
--   auto_ban_register_failures：同 IP 注册失败自动封禁阈值，默认 0 = 关闭（自动计数逻辑为后续项，暂只落键）。
--
-- 索引说明（EXPLAIN QUERY PLAN 本地 node:sqlite 验证）：
--   idx_ip_bans_ip 服务中间件命中判定与 isBanned（WHERE ip = ? AND (expires_at IS NULL OR expires_at > ?)，SEARCH）；
--   idx_ip_bans_created_at 服务管理端列表（ORDER BY created_at DESC，SCAN→SEARCH + USE TEMP B-TREE 消除）。
--
-- 回滚脚本（注释形式保留）：
--   DROP INDEX IF EXISTS idx_ip_bans_created_at;
--   DROP INDEX IF EXISTS idx_ip_bans_ip;
--   DROP TABLE IF EXISTS ip_bans;
--   DELETE FROM system_settings WHERE key IN ('auth_rate_limit_per_minute', 'register_success_per_hour_per_ip', 'auto_ban_register_failures');
--   -- users.ban_reason 列保留（SQLite DROP COLUMN 需 3.35+ 且 D1 不建议；列可空无副作用）

CREATE TABLE IF NOT EXISTS ip_bans (
  id TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ip_bans_ip ON ip_bans(ip);
CREATE INDEX IF NOT EXISTS idx_ip_bans_created_at ON ip_bans(created_at);

ALTER TABLE users ADD COLUMN ban_reason TEXT;

INSERT OR IGNORE INTO system_settings (key, value, description, updated_at) VALUES
('auth_rate_limit_per_minute', '10', '认证接口限流阈值（次/分钟；IP 与账号标识双维度；0 = 关闭该档）', unixepoch() * 1000),
('register_success_per_hour_per_ip', '3', '每 IP 每小时注册成功数上限（0 = 关闭）', unixepoch() * 1000),
('auto_ban_register_failures', '0', '同 IP 注册失败自动封禁阈值（0 = 关闭）', unixepoch() * 1000);
