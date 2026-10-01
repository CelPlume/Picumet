-- 0013：第三方登录来源新增「信任提供方邮箱验证」开关
--
-- 自动关联既有账号依赖提供方声明的 `email_verified`；该声明只有在提供方**真的**验证邮箱时
-- 才等价于邮箱控制权证明；自定义 OIDC 来源（issuer 仅过地址白名单）不保证这一点，若其允许
-- 用户自填任意邮箱并回 `email_verified=true`，攻击者可借此登录到该邮箱对应的既有账号。
--
-- 语义：trust_email_verified = 1 时，提供方已验证的邮箱可用于自动关联；= 0 时一律走补充注册页
-- （邮箱已被占用则返回 409 SSO_EMAIL_TAKEN，提示改用密码登录）。
-- 默认值 0；内置 google / github 端点固定、邮箱验证由提供方保证，回填为 1；自定义 oidc 需管理员显式开启。
ALTER TABLE sso_providers ADD COLUMN trust_email_verified INTEGER NOT NULL DEFAULT 0;

UPDATE sso_providers SET trust_email_verified = 1 WHERE kind IN ('google', 'github');

-- 回滚（降级脚本）：
--   -- SQLite 3.35+ 支持 DROP COLUMN，但 D1 不建议；列可空/有默认值，保留无副作用
--   -- ALTER TABLE sso_providers DROP COLUMN trust_email_verified;
