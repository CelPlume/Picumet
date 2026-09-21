// 仪表盘聚合仓库：/admin/dashboard 与 /admin/stats 共用的只读统计（§26）
import { Db } from '../db';
import { num, str } from '../row';

/** 顶层统计：与前端 AdminDashboard 契约的 stats 字段一一对应 */
export interface DashboardStats {
  userRoles: { admin: number; user: number; guest: number };
  /** 文件数（type='file'，不含文件夹行） */
  files: number;
  /** 占用空间（字节，type='file' 的 size 合计） */
  usedSpace: number;
  providers: number;
  activeMounts: number;
  /** Σ mounts.capacity_bytes；全部未设置（NULL）时为 null */
  totalCapacity: number | null;
}

/** 仪表盘挂载点行：主 provider、备用池成员与每挂载用量 */
export interface DashboardMount {
  id: string;
  name: string;
  mountPath: string;
  status: string;
  capacityBytes: number | null;
  usedSpace: number;
  fileCount: number;
  provider: { id: string; name: string; bucket: string };
  /** 备用桶池成员（mount_providers，排除主 provider） */
  standbys: Array<{ id: string; name: string; bucket: string; weight: number }>;
}

function roleCountsOf(rows: Array<Record<string, unknown>>): DashboardStats['userRoles'] {
  const roles: DashboardStats['userRoles'] = { admin: 0, user: 0, guest: 0 };
  for (const r of rows) {
    const role = str(r.role);
    if (role === 'admin' || role === 'user' || role === 'guest') roles[role] = num(r.c);
  }
  return roles;
}

export const DashboardRepo = {
  /** 顶层统计（5 条聚合查询） */
  async stats(db: Db): Promise<DashboardStats> {
    const [roleRows, fileRow, providerRow, mountRow, capacityRow] = await Promise.all([
      db.all('SELECT role, COUNT(*) AS c FROM users GROUP BY role'),
      db.first(`SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM file_metadata WHERE type = 'file'`),
      db.first('SELECT COUNT(*) AS c FROM storage_providers'),
      db.first(`SELECT COUNT(*) AS c FROM mounts WHERE status = 'active'`),
      db.first('SELECT COUNT(*) AS withCap, COALESCE(SUM(capacity_bytes), 0) AS total FROM mounts WHERE capacity_bytes IS NOT NULL'),
    ]);
    const withCapacity = num(capacityRow?.withCap);
    return {
      userRoles: roleCountsOf(roleRows),
      files: num(fileRow?.c),
      usedSpace: num(fileRow?.s),
      providers: num(providerRow?.c),
      activeMounts: num(mountRow?.c),
      totalCapacity: withCapacity === 0 ? null : num(capacityRow?.total),
    };
  },

  /**
   * 每挂载点用量（file_metadata GROUP BY mount_id WHERE type='file'，一次查询）。
   * 顶层 usedSpace 与 mounts[].usedSpace/fileCount 共用同一条聚合。
   */
  async usageByMount(db: Db): Promise<Map<string, { usedSpace: number; fileCount: number }>> {
    const rows = await db.all(
      `SELECT mount_id, COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM file_metadata WHERE type = 'file' GROUP BY mount_id`
    );
    const map = new Map<string, { usedSpace: number; fileCount: number }>();
    for (const r of rows) map.set(String(r.mount_id), { usedSpace: num(r.s), fileCount: num(r.c) });
    return map;
  },

  /** 挂载点总览（3 条查询 + 内存组装，禁止 N+1）：主 provider JOIN + 备用池成员 JOIN */
  async mounts(db: Db): Promise<DashboardMount[]> {
    const [mountRows, usage, standbyRows] = await Promise.all([
      db.all(
        `SELECT m.id, m.name, m.mount_path, m.status, m.capacity_bytes,
                p.id AS provider_id, p.name AS provider_name, p.bucket AS provider_bucket
         FROM mounts m
         JOIN storage_providers p ON p.id = m.provider_id
         ORDER BY m.priority DESC, m.mount_path ASC`
      ),
      this.usageByMount(db),
      db.all(
        `SELECT mp.mount_id, p.id, p.name, p.bucket, mp.weight
         FROM mount_providers mp
         JOIN mounts m ON m.id = mp.mount_id
         JOIN storage_providers p ON p.id = mp.provider_id
         WHERE mp.provider_id <> m.provider_id
         ORDER BY mp.mount_id ASC, mp.weight DESC, p.name ASC`
      ),
    ]);

    const standbys = new Map<string, DashboardMount['standbys']>();
    for (const r of standbyRows) {
      const mountId = String(r.mount_id);
      const list = standbys.get(mountId) ?? [];
      list.push({ id: String(r.id), name: String(r.name), bucket: String(r.bucket), weight: num(r.weight) });
      standbys.set(mountId, list);
    }

    return mountRows.map((m) => {
      const u = usage.get(String(m.id)) ?? { usedSpace: 0, fileCount: 0 };
      return {
        id: String(m.id),
        name: String(m.name),
        mountPath: String(m.mount_path),
        status: String(m.status),
        capacityBytes: m.capacity_bytes == null ? null : num(m.capacity_bytes),
        usedSpace: u.usedSpace,
        fileCount: u.fileCount,
        provider: { id: String(m.provider_id), name: String(m.provider_name), bucket: String(m.provider_bucket) },
        standbys: standbys.get(String(m.id)) ?? [],
      };
    });
  },
};
