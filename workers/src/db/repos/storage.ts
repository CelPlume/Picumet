// 存储提供商与挂载点仓库
import type { Mount, StorageProvider } from '@shared/types';
import { Db, type Tx } from '../db';
import { mapProvider, mapMount, b, num, type Row } from '../row';
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
  async deleteProvider(db: Db | Tx, id: string): Promise<void> {
    await db.query('DELETE FROM storage_providers WHERE id = ?', [id]);
  },
};

export const MountRepo = {
  /**
   * 写入挂载行（write-only，接受 Db|Tx 以便事务内调用）。
   * 只做 INSERT，**不回读**（D1 事务内不支持读）；调用方在事务外按 id 读回。
   */
  async insertMount(
    db: Db | Tx,
    m: {
      id: string;
      providerId: string;
      mountPath: string;
      name: string;
      sortBy?: string;
      sortOrder?: string;
      priority?: number;
      maxStorage?: number | null;
      poolStrategy?: string;
      capacityBytes?: number | null;
      uploadMode?: string;
    }
  ): Promise<void> {
    const now = Date.now();
    await db.query(
      `INSERT INTO mounts (id, provider_id, mount_path, name, sort_by, sort_order, priority, max_storage, pool_strategy, capacity_bytes, upload_mode, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        m.id,
        m.providerId,
        m.mountPath,
        m.name,
        m.sortBy ?? 'name',
        m.sortOrder ?? 'asc',
        m.priority ?? 0,
        m.maxStorage ?? null,
        m.poolStrategy ?? 'least_used',
        m.capacityBytes ?? null,
        m.uploadMode ?? 'free',
        now,
        now,
      ]
    );
  },
  async createMount(db: Db, m: { providerId: string; mountPath: string; name: string; sortBy?: string; sortOrder?: string; priority?: number; maxStorage?: number | null; poolStrategy?: string; capacityBytes?: number | null; uploadMode?: string }): Promise<Mount> {
    const id = uuid();
    const now = Date.now();
    await this.insertMount(db, { id, ...m });
    // §E 存储池：主 provider 自动成为池成员
    await db.query(
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
    // 末位键 created_at/id 让平局次序确定，不依赖 SQL 的隐式行序
    const rows = await db.all('SELECT * FROM mounts WHERE status = \'active\' ORDER BY priority DESC, mount_path ASC, created_at ASC, id ASC');
    return rows.map(mapMount);
  },
  async allMounts(db: Db): Promise<Mount[]> {
    const rows = await db.all('SELECT * FROM mounts ORDER BY priority DESC, mount_path ASC, created_at ASC, id ASC');
    return rows.map(mapMount);
  },
  /**
   * 找到能包含该路径的挂载点（priority 高优先，同 priority 路径更深优先）。
   * 同 priority 且同路径长度时按 created_at ASC、id ASC 稳定决胜：
   * 平局不依赖 listMounts 的输入次序或 SQL 的隐式顺序。
   */
  async findMountForPath(db: Db, canonicalPath: string): Promise<Mount | null> {
    const mounts = await this.listMounts(db);
    const candidates = mounts.filter((m) => {
      if (m.mountPath === '/') return true;
      return canonicalPath === m.mountPath || canonicalPath.startsWith(m.mountPath + '/');
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (b.mountPath.length !== a.mountPath.length) return b.mountPath.length - a.mountPath.length;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });
    return candidates[0];
  },
  async updateMount(db: Db | Tx, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.query(`UPDATE mounts SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
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
};

/** 池成员（§E）：weight = 加权系数；capacityBytes = 成员容量上限（null = 不限）；sortOrder = ordered 队列次序 */
export interface MountProviderMember {
  providerId: string;
  weight: number;
  capacityBytes: number | null;
  sortOrder: number;
  /** §31 显式「作为备用桶」标记（1 = 备用）；「0 文件」推断只作界面提示，不再驱动语义 */
  standby: boolean;
  /** §30 该成员在途预留字节数：放置判定 = used(聚合) + quotaReserved + 待写大小 <= capacityBytes */
  quotaReserved: number;
}

/** 池成员写入入参：weight 缺省 1、capacityBytes 缺省 null（不限）、sortOrder 缺省 0、standby 缺省 false */
export interface MountProviderMemberInput {
  providerId: string;
  weight?: number | null;
  capacityBytes?: number | null;
  sortOrder?: number | null;
  standby?: boolean | null;
}

/**
 * 池成员入参归一化（§E）：去重、weight >= 1、capacityBytes >= 0 或 null（不限）、
 * sortOrder >= 0、standby = 显式布尔。**空成员集 = 单桶语义**：回填 primaryProviderId 作为唯一成员。
 * 供 MountProviderRepo.setMembers 与管理端主锚点派生共用，保证两处对「最终成员集」的理解一致。
 */
export function normalizeMemberInputs(
  members: MountProviderMemberInput[],
  primaryProviderId: string
): Required<MountProviderMemberInput>[] {
  const normalized: Required<MountProviderMemberInput>[] = [];
  const seen = new Set<string>();
  const push = (m: MountProviderMemberInput) => {
    if (!m.providerId || seen.has(m.providerId)) return;
    seen.add(m.providerId);
    normalized.push({
      providerId: m.providerId,
      weight: m.weight == null ? 1 : Math.max(1, Math.trunc(m.weight)),
      capacityBytes: m.capacityBytes == null ? null : Math.max(0, Math.trunc(m.capacityBytes)),
      sortOrder: m.sortOrder == null ? 0 : Math.max(0, Math.trunc(m.sortOrder)),
      standby: m.standby === true,
    });
  };
  for (const m of members) push(m);
  if (normalized.length === 0) push({ providerId: primaryProviderId });
  return normalized;
}

/**
 * §32 可写池成员：池内排除备用桶后的成员集（**保序过滤**——策略的哈希取模/轮转次序沿用池成员原次序）。
 * 「除备用桶外都是主桶」——备用桶只作**读回退**候选（§G 用池成员全集，含备用），不参与写入放置。
 */
export function writableMembers(members: MountProviderMember[]): MountProviderMember[] {
  return members.filter((m) => !m.standby);
}

/**
 * §32 主存储锚点派生：池内**第一个可写成员**（sort_order 升序、同序 provider_id 升序，与 ordered 策略一致）。
 * 池内没有可写成员（清空池 / 成员全为备用）→ null（调用方保持单桶语义或按坏配置处理）。次序确定，与成员集无关。
 */
export function firstWritableMember(members: MountProviderMember[]): MountProviderMember | null {
  return (
    writableMembers(members).sort((a, b) =>
      a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.providerId.localeCompare(b.providerId)
    )[0] ?? null
  );
}

/**
 * 存储池成员（§E）：mount_providers 关联表。
 * weight 供 least_used / free_weighted 打分，capacityBytes 供 free_weighted / ordered 判满，
 * sortOrder 供 ordered 排序；成员为空时写路径回退 mounts.provider_id（单桶语义）。
 */
export const MountProviderRepo = {
  async listMembers(db: Db, mountId: string): Promise<MountProviderMember[]> {
    const rows = await db.all(
      `SELECT provider_id, weight, capacity_bytes, sort_order, standby, quota_reserved FROM mount_providers WHERE mount_id = ? ORDER BY provider_id ASC`,
      [mountId]
    );
    return rows.map((r) => ({
      providerId: String(r.provider_id),
      weight: Math.max(1, num(r.weight)),
      capacityBytes: r.capacity_bytes == null ? null : Math.max(0, num(r.capacity_bytes)),
      sortOrder: Math.max(0, num(r.sort_order)),
      standby: b(r.standby),
      quotaReserved: Math.max(0, num(r.quota_reserved)),
    }));
  },
  /**
   * 池成员**差异化**替换（接受 Db|Tx，调用方负责事务边界）：
   * - 保留成员走 UPSERT（DO UPDATE SET weight/capacity_bytes/sort_order/standby），
   *   **不动 quota_reserved 与 created_at**——在途预留不因配置保存而丢失；
   * - 只 DELETE 真正被移除的行（不在最终成员集里）；
   * - 空成员集 = 单桶语义：回填主 provider 作为唯一成员。
   * 传入 Db 时自包一层事务（独立调用仍原子）；传入 Tx 时直接并入外层事务（禁止嵌套事务）。
   */
  async setMembers(
    db: Db | Tx,
    mountId: string,
    primaryProviderId: string,
    members: MountProviderMemberInput[]
  ): Promise<void> {
    const normalized = normalizeMemberInputs(members, primaryProviderId);
    const apply = async (writer: Db | Tx) => {
      const now = Date.now();
      for (const m of normalized) {
        await writer.query(
          `INSERT INTO mount_providers (mount_id, provider_id, weight, capacity_bytes, sort_order, standby, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(mount_id, provider_id) DO UPDATE SET
             weight = excluded.weight,
             capacity_bytes = excluded.capacity_bytes,
             sort_order = excluded.sort_order,
             standby = excluded.standby`,
          [mountId, m.providerId, m.weight, m.capacityBytes, m.sortOrder, m.standby ? 1 : 0, now]
        );
      }
      const placeholders = normalized.map(() => '?').join(', ');
      await writer.query(
        `DELETE FROM mount_providers WHERE mount_id = ? AND provider_id NOT IN (${placeholders})`,
        [mountId, ...normalized.map((m) => m.providerId)]
      );
    };
    if (db instanceof Db) await db.transaction(apply);
    else await apply(db);
  },
};

export type { Row };

/**
 * 直写预留台账：
 * write.ts（兼容/WebDAV/S3/AList 直写）与跨挂载移动不创建 upload_sessions——它们的成员级预留
 * 此前不在对账来源内，reconcileQuotas 按在途会话重算时会把这类预留归零（短窗口削弱成员硬容量上限）。
 * 台账行在预留建立后写入、释放/落账时删除；对账合并「在途会话 + 台账」两来源，并清理 TTL 之外的滞留行。
 */
export const ReservationRepo = {
  async create(db: Db, r: { mountId: string; providerId: string; size: number }): Promise<string> {
    const id = uuid();
    await db.run(
      `INSERT INTO quota_reservations (id, mount_id, provider_id, size, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, r.mountId, r.providerId, r.size, Date.now()]
    );
    return id;
  },
  /** 释放/落账时删除台账行（写路径可并入提交事务：Db|Tx 通用） */
  async remove(db: Db | Tx, id: string): Promise<void> {
    await db.query('DELETE FROM quota_reservations WHERE id = ?', [id]);
  },
  /** 清理滞留台账行（TTL 之外的崩溃残留；返回删除行数）。对账在重算成员预留前调用。 */
  async purgeStale(db: Db, before: number): Promise<number> {
    const res = await db.run('DELETE FROM quota_reservations WHERE created_at < ?', [before]);
    return res.changes;
  },
};

const MEMBER_RELEASE_SQL = `UPDATE mount_providers SET quota_reserved = MAX(0, quota_reserved - ?) WHERE mount_id = ? AND provider_id = ?`;

/**
 * 池成员级容量预留（§30）：与 MountQuotaRepo 同构，作用域从「挂载点」下沉到「单个池成员」。
 *
 * 判定式（契约）：`used(由 file_metadata 聚合) + quota_reserved + 待写大小 <= capacity_bytes`；
 * capacity_bytes IS NULL = 不限 → 不判满、不预留（调用方按快照直接放行，不进入本仓库）；
 * 下面 SQL 里保留 `capacity_bytes IS NULL` 分支，用于兜住「判定期间管理员刚清空容量」的并发。
 * used 口径与写路径聚合一致：provider_id IS NULL 的存量行记在挂载主 provider 名下。
 *
 * 原子性：判定与记账在同一条条件 UPDATE 内完成——受影响行数 = 0 即该成员此刻不可用（并发写不会
 * 一起通过判定后各自超容量）。
 *
 * 生命周期与挂载点级预留对齐：写入成功/失败/补偿、上传会话完成/失败/过期都要释放（release / releaseTx）。
 */
export const MountProviderQuotaRepo = {
  /** 原子预留成员容量；false = 该成员此刻放不下，或该 (mount, provider) 不是池成员行 */
  async reserve(db: Db, mountId: string, providerId: string, primaryProviderId: string, size: number): Promise<boolean> {
    const res = await db.run(
      `UPDATE mount_providers
          SET quota_reserved = quota_reserved + ?
        WHERE mount_id = ? AND provider_id = ?
          AND (capacity_bytes IS NULL
               OR quota_reserved + COALESCE((SELECT SUM(size) FROM file_metadata
                    WHERE mount_id = ? AND type = 'file'
                      AND (provider_id = ? OR (provider_id IS NULL AND ? = ?))), 0) + ? <= capacity_bytes)`,
      [size, mountId, providerId, mountId, providerId, providerId, primaryProviderId, size]
    );
    return res.changes > 0;
  },
  /**
   * 只判定不预留：同一条件式，读路径无记账副作用。
   * 供不持有在途窗口的入口使用（如跨挂载移动的候选预检；正式预留走 reserve）。
   */
  async fits(db: Db, mountId: string, providerId: string, primaryProviderId: string, size: number): Promise<boolean> {
    const row = await db.first(
      `SELECT 1 AS placeable FROM mount_providers
        WHERE mount_id = ? AND provider_id = ?
          AND (capacity_bytes IS NULL
               OR quota_reserved + COALESCE((SELECT SUM(size) FROM file_metadata
                    WHERE mount_id = ? AND type = 'file'
                      AND (provider_id = ? OR (provider_id IS NULL AND ? = ?))), 0) + ? <= capacity_bytes)`,
      [mountId, providerId, mountId, providerId, providerId, primaryProviderId, size]
    );
    return row != null;
  },
  async release(db: Db, mountId: string, providerId: string, size: number): Promise<void> {
    await db.run(MEMBER_RELEASE_SQL, [size, mountId, providerId]);
  },
  /** 事务内释放（写路径提交事务里与落账同批，避免「已记账 + 仍预留」的双重占额窗口） */
  async releaseTx(tx: Tx, mountId: string, providerId: string, size: number): Promise<void> {
    await tx.query(MEMBER_RELEASE_SQL, [size, mountId, providerId]);
  },
};
