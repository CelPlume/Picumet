-- 0004_smtp_and_otp.sql
-- 1) email_tokens 表：OTP 邮箱验证令牌（验证码流程）
CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'verify',
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, email);

-- 2) SMTP 设置种子键
INSERT OR IGNORE INTO system_settings (key, value, description, updated_at) VALUES
('smtp_host', '""', 'SMTP 服务器地址', unixepoch() * 1000),
('smtp_port', '"587"', 'SMTP 端口', unixepoch() * 1000),
('smtp_secure', 'true', '是否启用 TLS/SSL', unixepoch() * 1000),
('smtp_user', '""', 'SMTP 用户名', unixepoch() * 1000),
('smtp_password', '""', 'SMTP 密码', unixepoch() * 1000),
('smtp_from_name', '"Picumet"', '发件人名称', unixepoch() * 1000),
('smtp_from_email', '""', '发件人邮箱', unixepoch() * 1000),
('email_enabled', 'false', '是否启用邮件服务', unixepoch() * 1000);

-- ============ ROLLBACK ============
-- 如需降级：
-- DROP INDEX IF EXISTS idx_email_tokens_user;
-- DROP TABLE IF EXISTS email_tokens;
-- DELETE FROM system_settings WHERE key IN ('smtp_host','smtp_port','smtp_secure','smtp_user','smtp_password','smtp_from_name','smtp_from_email','email_enabled');
