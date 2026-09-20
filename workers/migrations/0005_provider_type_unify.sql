-- 0005_provider_type_unify.sql
-- Provider type 收敛（对照报告 §5.2）：运行时唯一语义 = 绑定与否。
--   type='r2' 且无 endpoint → R2 绑定；其余 → S3 兼容协议（AWS / R2 S3 API / Oracle / MinIO）。
-- 不重建 storage_providers 表：该表被 mounts.provider_id 外键引用，重建需停外键，风险高；
-- CHECK 约束保持 ('r2','s3','oracle')，'oracle' 历史值折叠为 's3'，此后新增值只会是 'r2'/'s3'。
-- 升级脚本（本文件）；降级脚本见文件末尾注释。

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

-- ==================== 降级脚本（注释形式） ====================
-- ALTER TABLE storage_providers ADD COLUMN upload_domain TEXT;
-- UPDATE storage_providers SET endpoint='__binding__', access_key_id='__binding__', secret_access_key='__binding__'
--   WHERE type='r2' AND (endpoint IS NULL OR endpoint='');
-- 注意：'oracle' → 's3' 折叠不可精确逆转，两者在运行时语义等价（同一 S3Provider），无需回滚。
