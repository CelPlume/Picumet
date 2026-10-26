-- 目录状态、权限版本与临时鉴权强一致状态表
--
-- 背景：`0001_initial.sql` 已包含这三张表（新库单基线直接建全）。
-- 本文件用于**已在旧基线上运行过的存量库**补齐同样的结构（可重复执行，全部 IF NOT EXISTS）。
--
-- 回滚脚本（注释形式，按需手工执行）：
--   DROP TABLE IF EXISTS auth_ephemeral_states;
--   DROP TABLE IF EXISTS permission_revisions;
--   DROP TABLE IF EXISTS directory_states;

-- ============ 1. 目录状态与版本（增量索引与条件请求） ============
CREATE TABLE IF NOT EXISTS directory_states (
  mount_id TEXT NOT NULL,
  path TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  structure_hash TEXT,
  child_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_size INTEGER NOT NULL DEFAULT 0,
  last_changed_at INTEGER NOT NULL,
  last_indexed_at INTEGER,
  source TEXT NOT NULL DEFAULT 'application',
  PRIMARY KEY (mount_id, path),
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_directory_states_changed
  ON directory_states(mount_id, last_changed_at);

-- ============ 2. 权限版本控制（ETag 权限敏感失效） ============
CREATE TABLE IF NOT EXISTS permission_revisions (
  scope TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO permission_revisions (scope, revision, updated_at) VALUES
('global', 1, unixepoch() * 1000);

-- ============ 3. 临时鉴权强一致状态表（SSO / 一次性状态原子消费） ============
CREATE TABLE IF NOT EXISTS auth_ephemeral_states (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_cipher TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_ephemeral_states_expiry
  ON auth_ephemeral_states(expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_ephemeral_states_kind_expiry
  ON auth_ephemeral_states(kind, expires_at);
