-- 0016：待验证注册（注册未完成邮箱验证前不落库 users）
--
-- 死循环根因与修复：
--   旧流程 /register 先 createUser 落库、再发验证邮件。若用户从未点验证链接（或发信失败、
--   邮件进垃圾箱），users 里已存在一条 email_verified=0 的行：
--     · 再次 /register → 409「用户名已被占用」/「邮箱已被注册」
--     · /auth/login  → 要么 TOTP/邮箱验证拦截，要么直接登录失败
--   形成「注册说占用、登录进不去」的死循环，且管理员无法从 UI 判断该账号是否可用。
--
-- 新流程：
--   /register 只写 pending_registrations（凭证 + 邀请码核销意图），**不写 users**；
--   用户点击验证链接 /api/auth/verify-email?token=… 时，在同一事务内
--   校验令牌 → 核销邀请码 → 建号（email_verified=1）→ 删除待验证行。
--   任何一步失败都回滚，users 保持干净。
--
-- 字段说明：
--   token            邮件里的一次性令牌（randomString(40)），明文存 D1（同 email_tokens.code 口径）
--   username/email   预校验通过的标识，仅在 pending 期占用，核销成功后随建号一并写入 users
--   password_hash    bcrypt 哈希，**用 ENCRYPTION_KEY 做 AES-GCM 加密后落库**，
--                    避免数据库泄露即等于密码泄露（未加密的哈希列等同明文凭证）
--   invited_by_code_id 预校验通过的邀请码 id；建号事务里再次核销（防期间被他人用掉）
--   expires_at       24 小时过期，与旧「验证邮件 24 小时有效」口径一致；
--                    由 cleanup 的清理任务按 expires_at 回收（见 services/cleanup.ts）
CREATE TABLE IF NOT EXISTS pending_registrations (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  invited_by_code_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 核销按 token 定位（唯一约束已建索引，这里补显式索引供 EXPLAIN 验证）
CREATE INDEX IF NOT EXISTS idx_pending_registrations_token ON pending_registrations(token);
-- 清理任务按过期时间扫描回收悬挂行
CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires_at ON pending_registrations(expires_at);
-- 同邮箱/用户名重复提交时覆盖旧待验证行（避免堆积多条）
CREATE INDEX IF NOT EXISTS idx_pending_registrations_email ON pending_registrations(email);
CREATE INDEX IF NOT EXISTS idx_pending_registrations_username ON pending_registrations(username);

-- 回滚脚本（注释形式保留）：
-- DROP INDEX IF EXISTS idx_pending_registrations_username;
-- DROP INDEX IF EXISTS idx_pending_registrations_email;
-- DROP INDEX IF EXISTS idx_pending_registrations_expires_at;
-- DROP INDEX IF EXISTS idx_pending_registrations_token;
-- DROP TABLE IF EXISTS pending_registrations;