-- 0002_add_parts_and_download_tokens.sql
-- 1) upload_sessions.parts_completed：记录已成功上传的分片（断点续传 / 服务端留存 ETag）
ALTER TABLE upload_sessions ADD COLUMN parts_completed TEXT;

-- 2) download_tokens：下载令牌持久化存储，支持原子消费（DELETE ... RETURNING）
CREATE TABLE IF NOT EXISTS download_tokens (
  token TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_download_tokens_expires_at ON download_tokens(expires_at);

-- ==================== 降级脚本（注释形式） ====================
-- DROP TABLE IF EXISTS download_tokens;
-- ALTER TABLE upload_sessions DROP COLUMN parts_completed;
