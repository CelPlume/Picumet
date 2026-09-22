
-- Picumet 初始迁移：全部核心表 + 预置数据

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
-- 不在代码中硬编码固定凭据。

-- ============================================================

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

-- ============================================================

-- 审计 H-01：path_rules 增加 mount_id（挂载隔离）
-- 审计 H-05：users 增加 session_version（会话撤销）

-- 1) path_rules.mount_id：绑定规则到挂载点（NULL = 全局规则，兼容旧数据）
ALTER TABLE path_rules ADD COLUMN mount_id TEXT;
CREATE INDEX IF NOT EXISTS idx_path_rules_mount ON path_rules(mount_id, status);

-- 2) users.session_version：递增使旧 JWT 立即失效
ALTER TABLE users ADD COLUMN session_version INTEGER DEFAULT 0;

-- 注意：path_rules.mount_id 的外键约束需在重建表时加入（ALTER 无法加 FK）。
-- 查询层强制按挂载过滤。

-- ============================================================

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

-- ============================================================

-- Provider type 收敛（对照报告 §5.2）：运行时唯一语义 = 绑定与否。
--   type='r2' 且无 endpoint → R2 绑定；其余 → S3 兼容协议（AWS / R2 S3 API / Oracle / MinIO）。
-- 不重建 storage_providers 表：该表被 mounts.provider_id 外键引用，重建需停外键，风险高；
-- CHECK 约束保持 ('r2','s3','oracle')，'oracle' 历史值折叠为 's3'，此后新增值只会是 'r2'/'s3'。

-- 1) oracle → s3（Oracle 走 S3 兼容协议，type 无独立语义）
UPDATE storage_providers SET type = 's3' WHERE type = 'oracle';

-- 2) r2 + 已配置真实 endpoint → s3（R2 S3 API / 自配端点形态）
UPDATE storage_providers SET type = 's3'
WHERE type = 'r2'
  AND endpoint IS NOT NULL AND endpoint != '' AND endpoint != '__binding__';

-- 3) 绑定行哨兵归一：'__binding__' 占位 → ''（此后绑定判定 = type='r2' AND endpoint = ''）
UPDATE storage_providers SET endpoint = '' WHERE endpoint = '__binding__';
UPDATE storage_providers SET access_key_id = '' WHERE access_key_id = '__binding__';
UPDATE storage_providers SET secret_access_key = '' WHERE secret_access_key = '__binding__';

-- 4) upload_domain 死配置删除（报告 P1-6：建表/读写/schema 全链路存在但无消费者）
ALTER TABLE storage_providers DROP COLUMN upload_domain;

-- ============================================================

-- S3 兼容网关支持（docs/PICLIST_COMPAT_CN.md P2-2）
-- SigV4 验签需要服务端持有可逆的 secretAccessKey（sha256 哈希不可用），
-- 故为 API 密钥增加 AES-GCM 加密的 secret 密文列（enc: 前缀，密钥来自 ENCRYPTION_KEY）。
-- 存量密钥该列为 NULL：S3 网关对其实例返回明确错误，重建密钥后即可使用。

ALTER TABLE api_keys ADD COLUMN secret_cipher TEXT;

-- ============================================================

-- 用户模型完善（对照报告 §4.4）：
--   a) file_metadata.visibility    三级可见性（private | users | public）
--   b) file_metadata.review_status 公开审核状态（public 需 approved 才进 gallery）
--   c) path_rules.origin           规则来源（admin | user；system 仅内存合成规则，不入库）
--   d) path_rules.created_by       user-origin 规则的创建者
--   e) users.capabilities          能力位 JSON 数组（can_publish / can_share / can_grant）

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

-- ============================================================

-- 挂载点容量配额 + 用户默认限额 1GiB（方案 §A）：
--   挂载容量 = 空间分配单位（管理员按挂载点设置，NULL = 不限）；
--   用户限额 = 身份维度总预算（默认 1GiB）。
--   两层独立闸门：预留/落账/释放双层同步，实际可写 = min(两层剩余)。

-- 1) mounts 容量三列（base 建表不含，新装/存量统一由此补齐）
ALTER TABLE mounts ADD COLUMN max_storage INTEGER;
ALTER TABLE mounts ADD COLUMN used_storage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mounts ADD COLUMN quota_reserved INTEGER NOT NULL DEFAULT 0;

-- 2) 存量挂载用量回填：以 file_metadata 实际聚合为准
UPDATE mounts SET used_storage = (
  SELECT COALESCE(SUM(size), 0) FROM file_metadata
  WHERE file_metadata.mount_id = mounts.id AND file_metadata.type = 'file'
);

-- 3) 用户默认限额 10GiB → 1GiB（用户决策：存量一并回填）
UPDATE user_quotas SET max_storage = 1073741824;

-- ============================================================

-- 分享访问控制与时间增强（方案 §B）：
--   require_login：仅登录用户可查看/下载（默认 0 = 所有人可查看）
--   allowed_user_ids：指定用户白名单（JSON 数组，元素为用户 id；NULL = 不限）
--   时间支持绝对 expiresAt（前端折算毫秒时间戳，与相对 expiresIn 二选一，存既有 expires_at 列）
ALTER TABLE shares ADD COLUMN require_login INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shares ADD COLUMN allowed_user_ids TEXT;

-- ============================================================

-- 存储池（§E）：一个挂载点可挂多个存储，写入按策略选桶，读路径按文件自身 provider_id 定位。
--   mount_providers：池成员（weight 权重，least_used 按 per-provider 用量/权重比较）
--   mounts.pool_strategy：least_used（默认）| round_robin | hash
--   file_metadata.provider_id：文件实际落桶（NULL = 存量，回退 mounts.provider_id）
--   upload_sessions.provider_id：会话选定落桶（分片/中断续传期间保持不变）
ALTER TABLE file_metadata ADD COLUMN provider_id TEXT;
CREATE INDEX IF NOT EXISTS idx_file_metadata_provider ON file_metadata(mount_id, provider_id);

CREATE TABLE IF NOT EXISTS mount_providers (
  mount_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mount_id, provider_id),
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES storage_providers(id) ON DELETE CASCADE
);

ALTER TABLE mounts ADD COLUMN pool_strategy TEXT NOT NULL DEFAULT 'least_used';
ALTER TABLE upload_sessions ADD COLUMN provider_id TEXT;

-- 存量回填：文件落桶 = 挂载主 provider；池成员 = 主 provider
UPDATE file_metadata SET provider_id = (
  SELECT provider_id FROM mounts WHERE mounts.id = file_metadata.mount_id
) WHERE provider_id IS NULL;
INSERT OR IGNORE INTO mount_providers (mount_id, provider_id, weight, created_at)
  SELECT id, provider_id, 1, unixepoch() * 1000 FROM mounts;

-- ============================================================

-- 内容哈希寻址（§F）：物理对象按内容 SHA-256 命名并在文件之间共享（同内容只存一份）。
--   blob_objects：内容对象索引（hash 主键；object_key = 物理键 `<prefix>/picumet:blob/<h2>/<hash>`）
--   blob_gc：内容对象回收队列（最后一个引用消失后入队，由定时任务带保护期删除）
--   file_metadata.physical_key：提供方对象键（内容寻址 = blob 键；分片/存量 = 与 object_key 相同）
--   file_metadata.blob_hash：内容 SHA-256（NULL = 未内容寻址）
--   upload_sessions.blob_hash/physical_key：会话在 /upload/raw 阶段完成内容寻址后的落点
-- 引用计数不落列：删除判定用 NOT EXISTS(file_metadata.blob_hash = hash) 在同一批内原子求值。
ALTER TABLE file_metadata ADD COLUMN physical_key TEXT;
ALTER TABLE file_metadata ADD COLUMN blob_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_file_metadata_blob_hash ON file_metadata(blob_hash);
ALTER TABLE upload_sessions ADD COLUMN blob_hash TEXT;
ALTER TABLE upload_sessions ADD COLUMN physical_key TEXT;

CREATE TABLE IF NOT EXISTS blob_objects (
  hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_objects_provider ON blob_objects(provider_id);

CREATE TABLE IF NOT EXISTS blob_gc (
  hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 存量行：物理键 = 原对象键（路径键，未内容寻址）
UPDATE file_metadata SET physical_key = object_key WHERE physical_key IS NULL AND type = 'file';

-- ============ 17. share_items（分享项目表，多项目分享） ============
-- 一次分享可包含 1..50 个项目（文件与文件夹混合）：sort_order = 请求顺序（0 起）。
-- shares.file_id 保留首个项目（老列 NOT NULL，维持单文件兼容语义），项目全集以本表为准。
-- 文件被删除时 FK 级联清理对应项目行；分享行由「首项目删除」（shares.file_id 级联）或
-- 文件删除事务内追加的 deleteEmptyShares（已无任何项目）清理。
CREATE TABLE IF NOT EXISTS share_items (
  share_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, file_id),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES file_metadata(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_share_items_file_id ON share_items(file_id);

-- 存量回填：把已有 shares.file_id 变成第一条项目（幂等）
INSERT OR IGNORE INTO share_items (share_id, file_id, sort_order, created_at)
SELECT id, file_id, 0, created_at FROM shares;

-- ============ 18. transfer_slots（传输并发槽位） ============
-- 传输并发限制（system_settings.max_concurrent_transfers，默认 4，0 = 不限）的在途计数表：
-- 传输类接口（上传各通道 / 下载网关）进入时 INSERT 一个槽位，响应结束（含异常）时 DELETE。
-- 超过 30 分钟的槽位视为泄漏（进程中断等），计数时忽略并顺带清理。
-- 用 D1 而非 KV：KV 无原子自增且读缓存最长 60s，在途计数会读到旧值，起不到并发限制作用。
CREATE TABLE IF NOT EXISTS transfer_slots (
  token TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfer_slots_scope ON transfer_slots(scope, scope_id, created_at);

-- ============ 19. 挂载点皆目录（§H mount folders） ============
-- 每个非根挂载点必须在**父挂载点**命名空间内有一行 folder 记录（path = 绝对父目录、
-- name = 路径末段、object_key = 'folder:<绝对路径>'、id = 'mountfolder:<mountId>'），
-- 这样文件页 / 公开目录 / 分享选择器 / WebDAV / AList 等所有按路径列目录的入口都能看到它。
-- 运行期自愈见 workers/src/services/storage/mount-folders.ts（列目录、管理页、定时任务三处调用）；
-- 此段做一次存量回填（幂等：id 确定性生成，object_key 唯一约束保证不重复）。
-- 说明：SQLite 无 split_part，用 `rtrim(path, replace(path,'/',''))` 取「最后一个斜杠之前的前缀」
-- （rtrim 的第二个参数是字符集合，等于去掉所有斜杠后的字符串，会一直修剪到斜杠为止）。
INSERT OR IGNORE INTO file_metadata
  (id, mount_id, object_key, path, name, type, size, owner_id, custom_title, created_at, updated_at)
SELECT
  'mountfolder:' || m.id,
  (SELECT pm.id FROM mounts pm
    WHERE pm.id <> m.id
      AND (pm.mount_path = '/' OR pm.mount_path = CASE
             WHEN length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) > 1
             THEN substr(rtrim(m.mount_path, replace(m.mount_path, '/', '')), 1,
                         length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) - 1)
             ELSE '/' END
           OR CASE
             WHEN length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) > 1
             THEN substr(rtrim(m.mount_path, replace(m.mount_path, '/', '')), 1,
                         length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) - 1)
             ELSE '/' END LIKE pm.mount_path || '/%')
    ORDER BY length(pm.mount_path) DESC, pm.priority DESC
    LIMIT 1),
  'folder:' || m.mount_path,
  CASE
    WHEN length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) > 1
    THEN substr(rtrim(m.mount_path, replace(m.mount_path, '/', '')), 1,
                length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) - 1)
    ELSE '/' END,
  substr(m.mount_path, length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) + 1),
  'folder',
  0,
  (SELECT u.id FROM users u WHERE u.role = 'admin' ORDER BY u.created_at ASC LIMIT 1),
  m.name,
  m.created_at,
  m.created_at
FROM mounts m
WHERE m.mount_path <> '/'
  AND (SELECT pm.id FROM mounts pm
        WHERE pm.id <> m.id
          AND (pm.mount_path = '/' OR pm.mount_path = CASE
                 WHEN length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) > 1
                 THEN substr(rtrim(m.mount_path, replace(m.mount_path, '/', '')), 1,
                             length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) - 1)
                 ELSE '/' END
               OR CASE
                 WHEN length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) > 1
                 THEN substr(rtrim(m.mount_path, replace(m.mount_path, '/', '')), 1,
                             length(rtrim(m.mount_path, replace(m.mount_path, '/', ''))) - 1)
                 ELSE '/' END LIKE pm.mount_path || '/%')
        ORDER BY length(pm.mount_path) DESC, pm.priority DESC
        LIMIT 1) IS NOT NULL
  AND (SELECT u.id FROM users u WHERE u.role = 'admin' ORDER BY u.created_at ASC LIMIT 1) IS NOT NULL;

-- ============ 20. 修正挂载点目录行的 path 约定（§H 修复） ============
-- 背景：挂载点目录行最初把 path 写成了「父目录」，而文件夹行的约定是 path = 自身全路径
-- （见 services/files/handlers.ts 创建文件夹）。错误的 path 会让文件树把挂载点目录当作根节点、
-- 反复展开同一层，导致进入文件页卡死。此处按 object_key = 'folder:<绝对路径>' 反推修正，
-- 并兼容历史上由自愈逻辑以 uuid 建的行（同样带 object_key 前缀）。
UPDATE file_metadata
SET path = substr(object_key, 8)
WHERE type = 'folder'
  AND object_key LIKE 'folder:/%'
  AND path <> substr(object_key, 8);


-- ============ 21. 角色默认设置（原独立迁移 0004） ============
-- 角色维度的默认用户设置（默认存储位置 / 存储上限 / 文件数量 / 显示别名 / 默认启用状态 / 默认能力位）。
-- 保存角色默认时立即覆盖该角色下全部用户（见 RoleDefaultsRepo.applyToRole）。
-- is_system=1 标记内置角色（admin / user / guest），不允许删除。
CREATE TABLE IF NOT EXISTS role_defaults (
  role TEXT PRIMARY KEY,
  default_path TEXT NOT NULL DEFAULT '/',
  max_storage INTEGER,
  max_files INTEGER,
  alias TEXT,
  default_status TEXT NOT NULL DEFAULT 'active',
  capabilities TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  CONSTRAINT chk_role_default_status CHECK (default_status IN ('active', 'disabled'))
);

-- 预置内置角色三行：默认 '/'、1GiB、10000 文件、无别名、active、无能力位
INSERT OR IGNORE INTO role_defaults
  (role, default_path, max_storage, max_files, alias, default_status, capabilities, is_system, updated_at)
VALUES
  ('admin', '/', 1073741824, 10000, NULL, 'active', '[]', 1, unixepoch() * 1000),
  ('user',  '/', 1073741824, 10000, NULL, 'active', '[]', 1, unixepoch() * 1000),
  ('guest', '/', 1073741824, 10000, NULL, 'active', '[]', 1, unixepoch() * 1000);

-- ============ 22. 角色默认权限 + 文件级游客可见性（原独立迁移 0005） ============
-- role_defaults.permissions：角色默认权限（JSON 数组）；权限引擎第 8 步「用户默认路径权限」按此放行。
-- file_metadata.guest_visibility：文件级游客可见性（none/download/view；NULL = 不额外开放，
--   匿名访客仍由站点 allow_guest_access 总闸 + role='guest' 规则 / visibility 合成规则决定）。
ALTER TABLE role_defaults ADD COLUMN permissions TEXT NOT NULL DEFAULT '["read","write","update","delete","share","download"]';

-- 角色种子：admin/user 全量；guest 仅下载（与权限引擎 DEFAULT_ROLE_PERMISSIONS 兜底一致）
UPDATE role_defaults SET permissions = '["read","write","update","delete","share","download"]' WHERE role IN ('admin', 'user');
UPDATE role_defaults SET permissions = '["download"]' WHERE role = 'guest';

ALTER TABLE file_metadata ADD COLUMN guest_visibility TEXT;

-- ============ 23. 路由前缀设置（原独立迁移 0006） ============
-- 公开直链前缀（direct_prefix）与根路径语义（root_target）。前缀只作用于公开直链 / 签名直链
-- （path-serve），不作用于文件浏览页（固定 /files）、分享 URL、下载网关、WebDAV/S3/OpenList endpoint。
-- 默认值与历史行为完全等价：直链挂站点根（''）、'/' 是落地页（landing）。
INSERT OR IGNORE INTO system_settings (key, value, description, updated_at) VALUES
('direct_prefix', '""', '公开直链前缀（空 = 虚拟路径挂在站点根）', unixepoch() * 1000),
('root_target', '"landing"', '根路径语义（landing / files / direct）', unixepoch() * 1000);

-- ============ 24. 用户级默认权限 + 内置角色能力位种子（原独立迁移 0007） ============
-- users.permissions：用户个别默认权限（JSON 数组；NULL = 跟随角色默认 role_defaults.permissions）。
-- 优先级：user.permissions ?? role_defaults.permissions ?? DEFAULT_ROLE_PERMISSIONS[role]。
-- 默认权限矩阵收敛为 5 项（read/write/update/delete/download）：分享不在矩阵内，
-- 分享/发布/授权的唯一开关是能力位 can_share / can_publish / can_grant。
ALTER TABLE users ADD COLUMN permissions TEXT;

UPDATE role_defaults SET permissions = '["read","write","update","delete","download"]' WHERE role IN ('admin', 'user');

-- 内置角色能力位种子：admin/user 默认可分享，guest 无
UPDATE role_defaults SET capabilities = '["can_share"]' WHERE role IN ('admin', 'user');
UPDATE role_defaults SET capabilities = '[]' WHERE role = 'guest';

-- ============ 25. 分享密码可逆密文（原独立迁移 0008） ============
-- shares.password_cipher：分享密码的 AES-256-GCM 密文（encryptSecret 产出，统一带 `enc:` 前缀）。
-- 仅用于创建者本人的分享列表回看（GET /api/shares 解密返回明文）；任何公开响应都不得出现。
-- 未设置密码 / 写入时 ENCRYPTION_KEY 缺失 → NULL（降级为仅存 password_hash，功能不中断）。
ALTER TABLE shares ADD COLUMN password_cipher TEXT;

-- ============ 26. 文件封禁 + 挂载点容量（违规治理 / 仪表盘容量统计） ============
-- file_metadata.banned：违规封禁标记（1 = 封禁）。封禁文件：
--   - 用户端列表半透明展示、仅可删除（其余操作前端禁用）；
--   - 分享/下载/公开直链等所有内容出口返回 429 FILE_BANNED（提示文件违规）。
-- mounts.capacity_bytes：挂载点容量（字节，NULL = 未设置）。仪表盘内存占用 = 已占用 / Σ capacity_bytes；
--   挂载点管理页的容量输入（maxStorageGb）此前为纯前端死字段，本列使其真正落库。
ALTER TABLE file_metadata ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_file_metadata_banned ON file_metadata(banned);
ALTER TABLE mounts ADD COLUMN capacity_bytes INTEGER;

-- ============ 27. 公告显示时长（display policy） ============
-- display_mode：always 总是显示（默认，关闭后永久隐藏）| daily 当日显示（当日关闭次日复现）|
--   interval 每 x 间隔显示（关闭后一个间隔期内隐藏，interval_seconds 为秒）|
--   until 显示到 expires_at（绝对时间，到期自动隐藏）| duration 发布后 interval_seconds 内显示。
-- expires_at 沿用既有列承载 until 的绝对截止时间。
ALTER TABLE announcements ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'always';
ALTER TABLE announcements ADD COLUMN interval_seconds INTEGER;
-- kind：banner 常驻横幅（默认）| toast 临时弹窗（toast 样式展示片刻自动关闭；
--   display_mode 复用为频率/窗口语义：once 单次、interval 每 x 间隔、until 到期、duration 发布后 x）。
ALTER TABLE announcements ADD COLUMN kind TEXT NOT NULL DEFAULT 'banner';
