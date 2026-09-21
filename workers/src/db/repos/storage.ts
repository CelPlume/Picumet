// 存储提供商与挂载点仓库
import type { Mount, StorageProvider } from '@shared/types';
import { Db } from '../db';
import { mapProvider, mapMount, num, type Row } from '../row';
import { uuid } from '../../utils/crypto';

export const ProviderRepo = {
  async createProvider(db: Db, p: Omit<StorageProvider, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<StorageProvider> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO storage_providers (id, name, type, endpoint, region, bucket, access_key_id, secret_access_key, public_domain, path_prefix, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [id, p.name, p.type, p.endpoint, p.region, p.bucket, p.accessKeyId, p.secretAccessKey, p.publicDomain ?? null, p.pathPrefix ?? '', now, now]
    );
    return (await this.getProviderById(db, id)) as StorageProvider;
  },
  async getProviderById(db: Db, id: string): Promise<StorageProvider | null> {
    const row = await db.first('SELECT * FROM storage_providers WHERE id = ?', [id]);
    return row ? mapProvider(row) : null;
  },
  async listProviders(db: Db): Promise<StorageProvider[]> {
    const rows = await db.all('SELECT * FROM storage_providers ORDER BY created_at ASC');
    return rows.map(mapProvider);
  },
  async updateProvider(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE storage_providers SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  async deleteProvider(db: Db, id: string): Promise<void> {
    await db.run('DELETE FROM storage_providers WHERE id = ?', [id]);
  },
};

export const MountRepo = {
  async createMount(db: Db, m: { providerId: string; mountPath: string; name: string; sortBy?: string; sortOrder?: string; priority?: number; maxStorage?: number | null; poolStrategy?: string; capacityBytes?: number | null }): Promise<Mount> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO mounts (id, provider_id, mount_path, name, sort_by, sort_order, priority, max_storage, pool_strategy, capacity_bytes, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [id, m.providerId, m.mountPath, m.name, m.sortBy ?? 'name', m.sortOrder ?? 'asc', m.priority ?? 0, m.maxStorage ?? null, m.poolStrategy ?? 'least_used', m.capacityBytes ?? null, now, now]
    );
    // §E 存储池：主 provider 自动成为池成员
    await db.run(
      `INSERT OR IGNORE INTO mount_providers (mount_id, provider_id, weight, created_at) VALUES (?, ?, 1, ?)`,
      [id, m.providerId, now]
    );
    return (await this.getMountById(db, id)) as Mount;
  },
  async getMountById(db: Db, id: string): Promise<Mount | null> {
    const row = await db.first('SELECT * FROM mounts WHERE id = ?', [id]);
    return row ? mapMount(row) : null;
  },
  async listMounts(db: Db): Promise<Mount[]> {
    const rows = await db.all('SELECT * FROM mounts WHERE status = \'active\' ORDER BY priority DESC, mount_path ASC');
    return rows.map(mapMount);
  },
  async allMounts(db: Db): Promise<Mount[]> {
    const rows = await db.all('SELECT * FROM mounts ORDER BY priority DESC, mount_path ASC');
    return rows.map(mapMount);
  },
  /** 找到能包含该路径的挂载点（priority 高优先，同 priority 路径更深优先） */
  async findMountForPath(db: Db, canonicalPath: string): Promise<Mount | null> {
    const mounts = await this.listMounts(db);
    const candidates = mounts.filter((m) => {
      if (m.mountPath === '/') return true;
      return canonicalPath === m.mountPath || canonicalPath.startsWith(m.mountPath + '/');
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.mountPath.length - a.mountPath.length;
    });
    return candidates[0];
  },
  async updateMount(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE mounts SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  async deleteMount(db: Db, id: string): Promise<void> {
    await db.run('DELETE FROM mounts WHERE id = ?', [id]);
  },
};

/**
 * 挂载点容量配额：与 QuotaRepo（用户维度）并行的第二道闸门。
 * 语义完全镜像：预留（防并发超卖）→ 落账/释放；max_storage IS NULL = 不限。
 * 实际可写 = min(用户剩余, 挂载剩余)。
 */
export const MountQuotaRepo = {
  /** 原子预留挂载容量；超限返回 false */
  async reserve(db: Db, mountId: string, size: number): Promise<boolean> {
    const res = await db.run(
      `UPDATE mounts SET quota_reserved = quota_reserved + ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND (max_storage IS NULL OR used_storage + quota_reserved + ? <= max_storage)`,
      [size, Date.now(), mountId, size]
    );
    return res.changes > 0;
  },
  async releaseReservation(db: Db, mountId: string, size: number): Promise<void> {
    await db.run(
      `UPDATE mounts SET quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE id = ?`,
      [size, Date.now(), mountId]
    );
  },
  /** 落账：reserved 转为 used（size 可与预留不同，如以 head 实测为准） */
  async commitUsage(db: Db, mountId: string, size: number, reserved: number): Promise<void> {
    await db.run(
      `UPDATE mounts SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE id = ?`,
      [size, reserved, Date.now(), mountId]
    );
  },
  /** 删除/跨挂载移出时扣减已用 */
  async decrementUsage(db: Db, mountId: string, size: number): Promise<void> {
    await db.run(
      `UPDATE mounts SET used_storage = MAX(0, used_storage - ?), updated_at = ? WHERE id = ?`,
      [size, Date.now(), mountId]
    );
  },
  /** 跨挂载移动：源扣减 + 目标落账（无预留语义，移动不改用户配额） */
  async transferUsage(db: Db, sourceMountId: string, targetMountId: string, size: number): Promise<void> {
    if (sourceMountId === targetMountId || size <= 0) return;
    await db.run(
      `UPDATE mounts SET used_storage = MAX(0, used_storage - ?), updated_at = ? WHERE id = ?`,
      [size, Date.now(), sourceMountId]
    );
    await db.run(
      `UPDATE mounts SET used_storage = used_storage + ?, updated_at = ? WHERE id = ?`,
      [size, Date.now(), targetMountId]
    );
  },
};

/**
 * 存储池成员（§E）：mount_providers 关联表。
 * weight 供 least_used 策略按 用量/权重 比较；成员为空时写路径回退 mounts.provider_id。
 */
export const MountProviderRepo = {
  async listMembers(db: Db, mountId: string): Promise<Array<{ providerId: string; weight: number }>> {
    const rows = await db.all(
      `SELECT provider_id, weight FROM mount_providers WHERE mount_id = ? ORDER BY provider_id ASC`,
      [mountId]
    );
    return rows.map((r) => ({ providerId: String(r.provider_id), weight: Math.max(1, num(r.weight)) }));
  },
  /** 全量替换池成员（事务内先删后插；主 provider 始终保留且权重不可为 0） */
  async setMembers(db: Db, mountId: string, primaryProviderId: string, providerIds: string[]): Promise<void> {
    const now = Date.now();
    await db.transaction(async (tx) => {
      await tx.query(`DELETE FROM mount_providers WHERE mount_id = ?`, [mountId]);
      const unique = providerIds.includes(primaryProviderId) ? providerIds : [primaryProviderId, ...providerIds];
      for (const pid of unique) {
        await tx.query(
          `INSERT OR IGNORE INTO mount_providers (mount_id, provider_id, weight, created_at) VALUES (?, ?, 1, ?)`,
          [mountId, pid, now]
        );
      }
    });
  },
};

export type { Row };
