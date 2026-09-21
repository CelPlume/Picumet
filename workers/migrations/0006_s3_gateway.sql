-- 0005: S3 兼容网关支持（docs/PICLIST_COMPAT_CN.md P2-2）
-- SigV4 验签需要服务端持有可逆的 secretAccessKey（sha256 哈希不可用），
-- 故为 API 密钥增加 AES-GCM 加密的 secret 密文列（enc: 前缀，密钥来自 ENCRYPTION_KEY）。
-- 存量密钥该列为 NULL：S3 网关对其实例返回明确错误，重建密钥后即可使用。

ALTER TABLE api_keys ADD COLUMN secret_cipher TEXT;

-- ROLLBACK（回滚脚本，勿直接执行）：
-- ALTER TABLE api_keys DROP COLUMN secret_cipher;
