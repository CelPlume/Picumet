-- ============================================================
-- 34. Provider 生命周期外键收紧
-- ============================================================
-- 背景：mount_providers.provider_id 原为 ON DELETE CASCADE——删除 Provider 会静默级联移除池成员行，
--   而 file_metadata.provider_id 没有外键，历史文件的落桶指针随即悬空（failover 跳过已删 Provider、
--   读回退静默换桶）。mount_provider_role_permissions 甚至没有 provider 外键，删除 Provider 会留下
--   dangling 桶级矩阵。
-- 变更：
--   1) mount_providers：provider 外键 CASCADE → RESTRICT（mount 外键保留 CASCADE：删挂载点仍清理成员）；
--   2) mount_provider_role_permissions：补 provider 外键 RESTRICT（mount 外键保留 CASCADE）。
-- 应用层（admin DELETE /storage/providers/:id）先做全引用计数并 409；本迁移的 RESTRICT 是数据库兜底。
-- SQLite/D1 无法 ALTER 外键动作，按「建新表 → 拷数据 → 删旧表 → 改名」重建。
-- 关闭外键约束不是必须：新增的是子表（引用 storage_providers/mounts），拷贝时逐行校验通过即可；
-- 下面用 EXISTS 过滤历史悬空行，避免拷入时触发 FK 校验失败。
-- ============================================================

CREATE TABLE IF NOT EXISTS mount_providers_new (
  mount_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  capacity_bytes INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  quota_reserved INTEGER NOT NULL DEFAULT 0,
  standby INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mount_id, provider_id),
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES storage_providers(id) ON DELETE RESTRICT
);

INSERT OR IGNORE INTO mount_providers_new
  (mount_id, provider_id, weight, created_at, capacity_bytes, sort_order, quota_reserved, standby)
SELECT p.mount_id, p.provider_id, p.weight, p.created_at, p.capacity_bytes, p.sort_order, p.quota_reserved, p.standby
  FROM mount_providers p
 WHERE EXISTS (SELECT 1 FROM storage_providers s WHERE s.id = p.provider_id)
   AND EXISTS (SELECT 1 FROM mounts m WHERE m.id = p.mount_id);

DROP TABLE mount_providers;
ALTER TABLE mount_providers_new RENAME TO mount_providers;

CREATE TABLE IF NOT EXISTS mount_provider_role_permissions_new (
  mount_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  role TEXT NOT NULL,
  permissions TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mount_id, provider_id, role),
  FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES storage_providers(id) ON DELETE RESTRICT
);

-- 旧表无 provider 外键，可能存在 dangling 行 → EXISTS 过滤（不迁移已删 Provider 的矩阵行）
INSERT OR IGNORE INTO mount_provider_role_permissions_new
  (mount_id, provider_id, role, permissions, created_at, updated_at)
SELECT r.mount_id, r.provider_id, r.role, r.permissions, r.created_at, r.updated_at
  FROM mount_provider_role_permissions r
 WHERE EXISTS (SELECT 1 FROM storage_providers s WHERE s.id = r.provider_id)
   AND EXISTS (SELECT 1 FROM mounts m WHERE m.id = r.mount_id);

DROP TABLE mount_provider_role_permissions;
ALTER TABLE mount_provider_role_permissions_new RENAME TO mount_provider_role_permissions;

-- ============================================================
-- 回滚 SQL（注释保留，按需执行）
-- 1) mount_providers 恢复 provider 外键 ON DELETE CASCADE：
--   CREATE TABLE mount_providers_old (
--     mount_id TEXT NOT NULL, provider_id TEXT NOT NULL, weight INTEGER NOT NULL DEFAULT 1,
--     created_at INTEGER NOT NULL, capacity_bytes INTEGER, sort_order INTEGER NOT NULL DEFAULT 0,
--     quota_reserved INTEGER NOT NULL DEFAULT 0, standby INTEGER NOT NULL DEFAULT 0,
--     PRIMARY KEY (mount_id, provider_id),
--     FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
--     FOREIGN KEY (provider_id) REFERENCES storage_providers(id) ON DELETE CASCADE
--   );
--   INSERT OR IGNORE INTO mount_providers_old
--     (mount_id, provider_id, weight, created_at, capacity_bytes, sort_order, quota_reserved, standby)
--     SELECT mount_id, provider_id, weight, created_at, capacity_bytes, sort_order, quota_reserved, standby
--       FROM mount_providers;
--   DROP TABLE mount_providers;
--   ALTER TABLE mount_providers_old RENAME TO mount_providers;
-- 2) mount_provider_role_permissions 去掉 provider 外键：
--   CREATE TABLE mount_provider_role_permissions_old (
--     mount_id TEXT NOT NULL, provider_id TEXT NOT NULL, role TEXT NOT NULL, permissions TEXT NOT NULL,
--     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
--     PRIMARY KEY (mount_id, provider_id, role),
--     FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE
--   );
--   INSERT OR IGNORE INTO mount_provider_role_permissions_old
--     (mount_id, provider_id, role, permissions, created_at, updated_at)
--     SELECT mount_id, provider_id, role, permissions, created_at, updated_at
--       FROM mount_provider_role_permissions;
--   DROP TABLE mount_provider_role_permissions;
--   ALTER TABLE mount_provider_role_permissions_old RENAME TO mount_provider_role_permissions;
-- ============================================================
