-- Picumet 初始迁移：全部核心表 + 预置数据
-- 升级脚本（本文件）
-- 降级脚本（注释形式，见文件末尾 ROLLBACK 段）

PRAGMA foreign_keys = ON;

-- ============ 1. users（用户表） ============
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER DEFAULT 0,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT,
  avatar_url TEXT,
  default_path TEXT NOT NULL DEFAULT '/',
  locale TEXT DEFAULT 'zh-CN',
  theme TEXT DEFAULT 'system',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  status TEXT DEFAULT 'active',
  CONSTRAINT chk_default_path CHECK (default_path LIKE '/%')
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ============ 2. user_quotas（用户配额表） ============
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id TEXT PRIMARY KEY,
  max_storage INTEGER DEFAULT 10737418240,
  used_storage INTEGER DEFAULT 0,
  quota_reserved INTEGER DEFAULT 0,
  max_files INTEGER DEFAULT 10000,
  used_files INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_quotas_user_id ON user_quotas(user_id);

-- ============ 3. storage_providers（存储提供商表） ============
CREATE TABLE IF NOT EXISTS storage_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  region TEXT NOT NULL,
  bucket TEXT NOT NULL,
  access_key_id TEXT NOT NULL,
  secret_access_key TEXT NOT NULL,
  public_domain TEXT,
  upload_domain TEXT,
  path_prefix TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  CONSTRAINT chk_type CHECK (type IN ('r2', 's3', 'oracle'))
);

CREATE INDEX IF NOT EXISTS idx_storage_providers_type ON storage_providers(type);
CREATE INDEX IF NOT EXISTS idx_storage_providers_status ON storage_providers(status);

-- ============ 4. mounts（挂载点表） ============
CREATE TABLE IF NOT EXISTS mounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_by TEXT DEFAULT 'name',
  sort_order TEXT DEFAULT 'asc',
  priority INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (provider_id) REFERENCES storage_providers(id) ON DELETE CASCADE,
  CONSTRAINT chk_mount_path CHECK (mount_path LIKE '/%'),
  CONSTRAINT chk_sort_by CHECK (sort_by IN ('name', 'time', 'size', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_mounts_mount_path ON mounts(mount_path, priority DESC);
CREATE INDEX IF NOT EXISTS idx_mounts_provider_id ON mounts(provider_id);
CREATE INDEX IF NOT EXISTS idx_mounts_status ON mounts(status);

-- ============ 5. file_metadata（文件元数据表） ============
CREATE TABLE IF NOT EXISTS file_metadata (
  id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER DEFAULT 0,
  etag TEXT,
  checksum_md5 TEXT,
  version INTEGER DEFAULT 1,
  custom_title TEXT,
  custom_color TEXT,
  cover_url TEXT,
  icon_emoji TEXT,
  access_password TEXT,
  manual_position INTEGER,
  metadata TEXT,
  owner_id TEXT NOT NULL,
  source_cleanup_pending INTEGER DEFAULT 0,
  old_object_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_type CHECK (type IN ('file', 'folder')),
  UNIQUE (mount_id, object_key)
);

CREATE INDEX IF NOT EXISTS idx_file_metadata_mount_path ON file_metadata(mount_id, path);
CREATE INDEX IF NOT EXISTS idx_file_metadata_owner_id ON file_metadata(owner_id);
CREATE INDEX IF NOT EXISTS idx_file_metadata_name ON file_metadata(name);
CREATE INDEX IF NOT EXISTS idx_file_metadata_type ON file_metadata(type);
CREATE INDEX IF NOT EXISTS idx_file_metadata_manual_position ON file_metadata(manual_position);
CREATE INDEX IF NOT EXISTS idx_file_metadata_cleanup ON file_metadata(source_cleanup_pending);

-- ============ 6. upload_sessions（上传会话表） ============
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mount_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER NOT NULL,
  quota_reserved INTEGER NOT NULL,
  upload_id TEXT,
  total_parts INTEGER,
  status TEXT DEFAULT 'pending',
  idempotency_key TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
  CONSTRAINT chk_status CHECK (status IN ('pending', 'uploading', 'verifying', 'completed', 'failed', 'expired', 'aborted'))
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_id ON upload_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions(status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires_at ON upload_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_idempotency_key ON upload_sessions(idempotency_key);

-- ============ 7. operation_jobs（操作任务表） ============
CREATE TABLE IF NOT EXISTS operation_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  file_id TEXT,
  source_path TEXT NOT NULL,
  target_path TEXT,
  mount_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  error_message TEXT,
  state_data TEXT,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
  CONSTRAINT chk_type CHECK (type IN ('move', 'copy', 'delete')),
  CONSTRAINT chk_status CHECK (status IN ('pending', 'running', 'completed', 'failed', 'rollback'))
);

CREATE INDEX IF NOT EXISTS idx_operation_jobs_user_id ON operation_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_operation_jobs_status ON operation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_operation_jobs_created_at ON operation_jobs(created_at DESC);

-- ============ 8. path_rules（路径权限规则表） ============
CREATE TABLE IF NOT EXISTS path_rules (
  id TEXT PRIMARY KEY,
  path_pattern TEXT NOT NULL,
  effect TEXT NOT NULL DEFAULT 'allow',
  role TEXT,
  user_id TEXT,
  api_key_id TEXT,
  permissions TEXT NOT NULL,
  require_password INTEGER DEFAULT 0,
  password_hash TEXT,
  allowed_ips TEXT,
  priority INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_effect CHECK (effect IN ('allow', 'deny'))
);

CREATE INDEX IF NOT EXISTS idx_path_rules_path_pattern ON path_rules(path_pattern);
CREATE INDEX IF NOT EXISTS idx_path_rules_role ON path_rules(role);
CREATE INDEX IF NOT EXISTS idx_path_rules_user_id ON path_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_path_rules_priority ON path_rules(priority DESC);
CREATE INDEX IF NOT EXISTS idx_path_rules_status ON path_rules(status);

-- ============ 9. api_keys（API密钥表） ============
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_id TEXT UNIQUE NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  permissions TEXT NOT NULL,
  protocols TEXT NOT NULL,
  upload_path TEXT DEFAULT '/',
  allowed_ips TEXT,
  expires_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_token_hash ON api_keys(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys(key_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);

-- ============ 10. shares（分享链接表） ============
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  title TEXT,
  password_hash TEXT,
  expires_at INTEGER,
  max_views INTEGER,
  view_count INTEGER DEFAULT 0,
  max_downloads INTEGER,
  download_count INTEGER DEFAULT 0,
  allow_preview INTEGER DEFAULT 1,
  allow_download INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (file_id) REFERENCES file_metadata(id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shares_file_id ON shares(file_id);
CREATE INDEX IF NOT EXISTS idx_shares_creator_id ON shares(creator_id);
CREATE INDEX IF NOT EXISTS idx_shares_status ON shares(status);
CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares(expires_at);

-- ============ 11. access_logs（访问日志表，无 file_id 外键） ============
CREATE TABLE IF NOT EXISTS access_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  path TEXT,
  metadata TEXT,
  ip_address TEXT,
  user_agent TEXT,
  bytes_transferred INTEGER DEFAULT 0,
  status_code INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_access_logs_user_id ON access_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_access_logs_created_at ON access_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_logs_action ON access_logs(action);
CREATE INDEX IF NOT EXISTS idx_access_logs_path ON access_logs(path);

-- ============ 12. system_settings（系统设置表） ============
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at INTEGER NOT NULL
);

-- ============ 13. announcements（公告表） ============
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  level TEXT DEFAULT 'info',
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  CONSTRAINT chk_level CHECK (level IN ('info', 'warning', 'danger'))
);

-- ============ 14. user_announcement_dismissals（公告关闭记录） ============
CREATE TABLE IF NOT EXISTS user_announcement_dismissals (
  user_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  dismiss_forever INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, announcement_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE
);

-- ============ 15. reconciliation_reports（对账报告） ============
CREATE TABLE IF NOT EXISTS reconciliation_reports (
  id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL,
  orphan_objects TEXT NOT NULL,
  ghost_records TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  processed_by TEXT,
  status TEXT DEFAULT 'pending_review',
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE
);

-- ============ 16. orphan_objects（孤儿对象记录） ============
CREATE TABLE IF NOT EXISTS orphan_objects (
  id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  reason TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  cleaned INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orphan_objects_mount ON orphan_objects(mount_id);

-- ============ 预置系统设置 ============
INSERT OR IGNORE INTO system_settings (key, value, description, updated_at) VALUES
('site_title', '"Picumet"', '网站标题', unixepoch() * 1000),
('site_logo', 'null', 'Logo URL', unixepoch() * 1000),
('site_favicon', 'null', 'Favicon URL', unixepoch() * 1000),
('allow_registration', 'true', '是否允许注册', unixepoch() * 1000),
('allow_guest_access', 'false', '是否允许访客访问', unixepoch() * 1000),
('require_email_verification', 'false', '是否需要邮箱验证', unixepoch() * 1000),
('enable_turnstile', 'false', '是否启用Turnstile', unixepoch() * 1000),
('turnstile_site_key', 'null', 'Turnstile Site Key', unixepoch() * 1000),
('rate_limit_enabled', 'true', '是否启用速率限制', unixepoch() * 1000),
('rate_limit_requests_per_minute', '50', '每分钟最大请求数', unixepoch() * 1000);

-- ============ 初始管理员账户 ============
-- 管理员账户由 seed 逻辑创建：生产环境从 env.ADMIN_PASSWORD 注入（审计 H-02），
-- 不再在代码/迁移中硬编码固定凭据。

-- ============ ROLLBACK ============
-- 如需降级，按逆序删除表：
-- DROP TABLE IF EXISTS orphan_objects;
-- DROP TABLE IF EXISTS reconciliation_reports;
-- DROP TABLE IF EXISTS user_announcement_dismissals;
-- DROP TABLE IF EXISTS announcements;
-- DROP TABLE IF EXISTS system_settings;
-- DROP TABLE IF EXISTS access_logs;
-- DROP TABLE IF EXISTS shares;
-- DROP TABLE IF EXISTS api_keys;
-- DROP TABLE IF EXISTS path_rules;
-- DROP TABLE IF EXISTS operation_jobs;
-- DROP TABLE IF EXISTS upload_sessions;
-- DROP TABLE IF EXISTS file_metadata;
-- DROP TABLE IF EXISTS mounts;
-- DROP TABLE IF EXISTS storage_providers;
-- DROP TABLE IF EXISTS user_quotas;
-- DROP TABLE IF EXISTS users;
