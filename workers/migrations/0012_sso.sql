-- Picumet 第三方登录（SSO / OIDC）迁移
-- 范围：身份提供商配置 + 第三方身份关联与凭据存储 + 站点级总开关种子键。
-- 语义见 docs/ARCHITECTURE_CN.md「SSO / OIDC 登录服务」与 docs/API_CN.md「第三方登录」。

PRAGMA foreign_keys = ON;

-- ============ 1. sso_providers（身份提供商配置） ============
-- kind 语义：
--   google / github = 内置端点（issuer_url 留空），各自至多一条（部分唯一索引）
--   oidc            = 通用 OpenID Connect（issuer_url 必填，经 discovery 取端点），数量不限
-- client_secret 以 AES-256-GCM 密文存储（`enc:` 前缀，与存储凭据/分享密码同一约定），
-- 读取时经 decryptSecret(ENCRYPTION_KEY) 还原；列表接口只回掩码 '******'。
CREATE TABLE IF NOT EXISTS sso_providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  issuer_url TEXT,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  scopes TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT chk_sso_provider_kind CHECK (kind IN ('google', 'github', 'oidc'))
);

-- 单例约束（google / github 各只能添加一个；自定义 OIDC 不限）。
-- 部分唯一索引只在 kind IN ('google','github') 的行上生效，oidc 行不受约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_sso_providers_singleton
  ON sso_providers(kind) WHERE kind IN ('google', 'github');

-- 登录页按钮列表按 enabled 过滤后按创建时间排序：覆盖扫描极少行，
-- 该索引仅服务于「启用列表 + 排序」这条读路径（EXPLAIN QUERY PLAN: SEARCH sso_providers USING INDEX idx_sso_providers_enabled）。
CREATE INDEX IF NOT EXISTS idx_sso_providers_enabled ON sso_providers(enabled, created_at);

-- ============ 2. sso_identities（第三方身份关联 + 令牌凭据） ============
-- subject = OIDC `sub` / GitHub 用户 id（提供方内稳定唯一，不用邮箱做键）。
-- email / username / display_name / avatar_url 为**关联当时**的提供方档案快照（身份识别留痕，
-- 不参与权限判定）。access_token / refresh_token 同样 AES-GCM 密文存储（`enc:` 前缀）。
CREATE TABLE IF NOT EXISTS sso_identities (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  username TEXT,
  display_name TEXT,
  avatar_url TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_type TEXT,
  scope TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES sso_providers(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 身份解析主键：同一提供方下 subject 唯一（回调第一步按此定位已有账号）
CREATE UNIQUE INDEX IF NOT EXISTS idx_sso_identities_provider_subject
  ON sso_identities(provider_id, subject);
-- 用户维度查询（账号关联列表 / 级联删除按 user_id 走此索引）
CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities(user_id);

-- ============ 3. 站点级总开关（种子键） ============
-- 关闭 = 全部 SSO 入口不可用（登录页不展示按钮、start/callback/complete 全部拒绝），
-- 各提供商行上的 enabled 是第二道门（总开关开 + 单源开才可用）。
INSERT OR IGNORE INTO system_settings (key, value, description, updated_at) VALUES
  ('sso_enabled', 'false', '是否启用第三方登录（SSO/OIDC）', unixepoch() * 1000);

-- ============ 回滚（降级脚本） ============
-- DELETE FROM system_settings WHERE key = 'sso_enabled';
-- DROP INDEX IF EXISTS idx_sso_identities_user;
-- DROP INDEX IF EXISTS idx_sso_identities_provider_subject;
-- DROP TABLE IF EXISTS sso_identities;
-- DROP INDEX IF EXISTS idx_sso_providers_enabled;
-- DROP INDEX IF EXISTS idx_sso_providers_singleton;
-- DROP TABLE IF EXISTS sso_providers;
