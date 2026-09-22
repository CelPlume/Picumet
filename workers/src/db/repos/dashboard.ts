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

/** 桶视角的挂载点节点：主桶节点，或本桶持有文件的拼好桶成员节点 */
export interface DashboardBucketMount {
  id: string;
  name: string;
  mountPath: string;
  status: string;
  capacityBytes: number | null;
  /** 本桶内该挂载点的物理文件数/字节（file_metadata.provider_id = 本桶） */
  fileCount: number;
  usedSpace: number;
  /** primary = 本桶是该挂载点主桶；member = 拼好桶成员（主桶在别处） */
  role: 'primary' | 'member';
}

/** 桶泳道：挂载点节点 + 仅作备用的挂载点（badge 跳主桶） */
export interface DashboardBucket {
  id: string;
  name: string;
  bucket: string;
  type: string;
  /** 本桶物理存储合计（所有挂载点） */
  fileCount: number;
  usedSpace: number;
  mounts: DashboardBucketMount[];
  /** 备份桶参与：本桶为该挂载点备用成员且 0 文件 → 前端渲染跳主桶 badge */
  standbys: Array<{
    mountId: string;
    mountName: string;
    mountPath: string;
    primaryProviderId: string;
    primaryProviderName: string;
  }>;
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

  /**
   * 桶 → 挂载点树（活跃挂载点泳道图 + 全部文件挂载点视图共用，一次查询禁止 N+1）：
   * 每桶列出「持有该挂载点文件」的挂载点节点（主桶或拼好桶成员，计数按 file_metadata.provider_id
   * 落桶统计）；仅作备用（该桶内 0 文件）的池成员进入 standbys，前端给出跳主桶的备用桶 badge。
   */
  async bucketTree(db: Db): Promise<DashboardBucket[]> {
    const [providerRows, mountRows, memberRows, usageRows] = await Promise.all([
      db.all('SELECT id, name, bucket, type FROM storage_providers ORDER BY created_at ASC, id ASC'),
      db.all('SELECT id, name, mount_path, status, capacity_bytes, provider_id FROM mounts ORDER BY priority DESC, mount_path ASC'),
      db.all('SELECT mount_id, provider_id FROM mount_providers'),
      db.all(
        `SELECT mount_id, provider_id, COUNT(*) AS c, COALESCE(SUM(size), 0) AS s
         FROM file_metadata WHERE type = 'file' AND provider_id IS NOT NULL
         GROUP BY mount_id, provider_id`
      ),
    ]);
    // key: `${mountId}:${providerId}` → 本桶物理存储的文件数/字节
    const perBucket = new Map<string, { fileCount: number; usedSpace: number }>();
    for (const r of usageRows) {
      perBucket.set(`${String(r.mount_id)}:${String(r.provider_id)}`, { fileCount: num(r.c), usedSpace: num(r.s) });
    }
    // mount_id → 池成员 provider id 集（含主桶）
    const members = new Map<string, Set<string>>();
    for (const r of memberRows) {
      const set = members.get(String(r.mount_id)) ?? new Set<string>();
      set.add(String(r.provider_id));
      members.set(String(r.mount_id), set);
    }
    const mountById = new Map(mountRows.map((m) => [String(m.id), m]));

    return providerRows.map((p) => {
      const providerId = String(p.id);
      const nodeMounts: DashboardBucket['mounts'] = [];
      const standbyEntries: DashboardBucket['standbys'] = [];
      let bucketFiles = 0;
      let bucketSpace = 0;
      for (const m of mountRows) {
        const mountId = String(m.id);
        if (!members.get(mountId)?.has(providerId)) continue;
        const u = perBucket.get(`${mountId}:${providerId}`) ?? { fileCount: 0, usedSpace: 0 };
        bucketFiles += u.fileCount;
        bucketSpace += u.usedSpace;
        const isPrimary = String(m.provider_id) === providerId;
        if (isPrimary || u.fileCount > 0) {
          nodeMounts.push({
            id: mountId,
            name: String(m.name),
            mountPath: String(m.mount_path),
            status: String(m.status),
            capacityBytes: m.capacity_bytes == null ? null : num(m.capacity_bytes),
            fileCount: u.fileCount,
            usedSpace: u.usedSpace,
            role: isPrimary ? 'primary' : 'member',
          });
        } else {
          // 备份桶：该挂载点的备用成员且本桶 0 文件 → badge 跳主桶
          const primary = mountById.get(mountId);
          const primaryRow = providerRows.find((pp) => String(pp.id) === String(primary?.provider_id));
          if (primaryRow) {
            standbyEntries.push({
              mountId,
              mountName: String(m.name),
              mountPath: String(m.mount_path),
              primaryProviderId: String(primaryRow.id),
              primaryProviderName: String(primaryRow.name),
            });
          }
        }
      }
      return {
        id: providerId,
        name: String(p.name),
        bucket: String(p.bucket),
        type: String(p.type),
        fileCount: bucketFiles,
        usedSpace: bucketSpace,
        mounts: nodeMounts,
        standbys: standbyEntries,
      };
    });
  },

  /**
   * 挂载点展开层（仪表盘泳道节点按需加载）：顶层文件夹行 + 每夹递归文件计数。
   * providerId 传入时文件计数只统计该桶物理存储（拼好桶「只显示本桶存储的文件」），
   * 且隐藏 0 文件的文件夹。两条查询 + 内存聚合，禁止逐夹 N+1。
   */
  async mountFolderSummary(
    db: Db,
    mount: { id: string; mountPath: string },
    providerId?: string
  ): Promise<{
    mountId: string;
    providerId: string | null;
    rootFiles: { count: number; size: number };
    folders: Array<{ id: string; name: string; path: string; fileCount: number; usedSpace: number }>;
    truncated: boolean;
  }> {
    const root = mount.mountPath;
    // 顶层文件夹 = 挂载点根下一级（文件夹行 path=自身全路径 → LIKE root/% 且不含更深一层）
    const esc = root.replace(/([\\%_])/g, '\\$1');
    const [folderRows, fileRows] = await Promise.all([
      db.all(
        `SELECT id, name, path FROM file_metadata
         WHERE mount_id = ? AND type = 'folder' AND path LIKE ? ESCAPE '\\' AND path NOT LIKE ? ESCAPE '\\'
         ORDER BY name COLLATE NOCASE ASC LIMIT 200`,
        [mount.id, `${esc}/%`, `${esc}/%/%`]
      ),
      db.all(
        `SELECT path, size FROM file_metadata
         WHERE mount_id = ? AND type = 'file'${providerId ? ' AND provider_id = ?' : ''}
         LIMIT 20000`,
        providerId ? [mount.id, providerId] : [mount.id]
      ),
    ]);
    // 顶层片段 → 计数聚合（path = 根为根目录直置文件；否则取根后第一段）
    const rootFiles = { count: 0, size: 0 };
    const agg = new Map<string, { fileCount: number; usedSpace: number }>();
    for (const r of fileRows) {
      const p = String(r.path);
      if (p === root) {
        rootFiles.count += 1;
        rootFiles.size += num(r.size);
        continue;
      }
      const rest = p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
      const top = rest.split('/')[0];
      const cur = agg.get(top) ?? { fileCount: 0, usedSpace: 0 };
      cur.fileCount += 1;
      cur.usedSpace += num(r.size);
      agg.set(top, cur);
    }
    const folders = folderRows
      .map((f) => {
        const name = String(f.name);
        const a = agg.get(name) ?? { fileCount: 0, usedSpace: 0 };
        return { id: String(f.id), name, path: String(f.path), fileCount: a.fileCount, usedSpace: a.usedSpace };
      })
      .filter((f) => f.fileCount > 0);
    return {
      mountId: mount.id,
      providerId: providerId ?? null,
      rootFiles,
      folders,
      truncated: fileRows.length >= 20000,
    };
  },
};
