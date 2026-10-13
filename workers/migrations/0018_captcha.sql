-- 0018：人机验证（Cloudflare Turnstile / Google reCAPTCHA v2/v3 经典版）
--
-- 设置键（管理端「人机验证」卡片维护，运行时与环境变量并集无关——本组只存设置表）：
--   captcha_provider   提供方（turnstile | recaptcha），默认 turnstile；
--   captcha_enabled    总开关；
--   captcha_site_key   站点密钥（明文，公开面随 /api/public/settings 下发）；
--   captcha_secret_key 服务端密钥（AES-256-GCM 密文 'enc:' 前缀，写后不回读）；
--   captcha_face_*     七个防护面开关（login / register / share_download / upload /
--                      password_change / email_verify / password_reset），默认全部关闭。
-- 仅设置种子行，无表结构变更。
--
-- 回滚脚本（注释形式保留）：
--   DELETE FROM system_settings WHERE key LIKE 'captcha_%';

INSERT OR IGNORE INTO system_settings (key, value, description, updated_at) VALUES
('captcha_provider', 'turnstile', '人机验证提供方（turnstile | recaptcha）', unixepoch() * 1000),
('captcha_enabled', 'false', '人机验证总开关', unixepoch() * 1000),
('captcha_site_key', '', '人机验证 Site Key（公开下发）', unixepoch() * 1000),
('captcha_secret_key', '', '人机验证 Secret Key（AES-GCM 密文，写后不回读）', unixepoch() * 1000),
('captcha_face_login', 'false', '人机验证面：登录', unixepoch() * 1000),
('captcha_face_register', 'false', '人机验证面：注册', unixepoch() * 1000),
('captcha_face_share_download', 'false', '人机验证面：分享文件下载', unixepoch() * 1000),
('captcha_face_upload', 'false', '人机验证面：上传', unixepoch() * 1000),
('captcha_face_password_change', 'false', '人机验证面：修改密码', unixepoch() * 1000),
('captcha_face_email_verify', 'false', '人机验证面：验证邮箱（换绑 OTP）', unixepoch() * 1000),
('captcha_face_password_reset', 'false', '人机验证面：重置密码', unixepoch() * 1000);
