-- 0015：两步验证（2FA / TOTP，登录第二因子）
--
-- users 扩展字段：
--   totp_secret_enc：AES-GCM 加密后的 TOTP Secret（Base32），enc: 前缀标记
--   totp_enabled：是否启用 TOTP，0 = 关闭，1 = 启用
--   totp_last_used_counter：最近一次成功验证的时间步计数器（防 30s 内重放）
--
-- totp_backup_codes：一次性备用码表
--   code_enc：AES-256-GCM 密文（enc: 前缀，ENCRYPTION_KEY 派生），保留密文而非仅哈希，
--     使「查看剩余备用码」可回读（对标 Google：剩余备用码可随时查看），核销时解密后常量时间比对
--   used_at：消费时间戳，NULL 表示未消费

ALTER TABLE users ADD COLUMN totp_secret_enc TEXT NULL;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_last_used_counter INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS totp_backup_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_totp_backup_codes_user ON totp_backup_codes(user_id, used_at);

-- 回滚脚本（注释形式保留）：
-- DROP INDEX IF EXISTS idx_totp_backup_codes_user;
-- DROP TABLE IF EXISTS totp_backup_codes;
-- ALTER TABLE users DROP COLUMN totp_last_used_counter;
-- ALTER TABLE users DROP COLUMN totp_enabled;
-- ALTER TABLE users DROP COLUMN totp_secret_enc;
