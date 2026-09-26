// 仪表盘聚合仓库：/admin/dashboard 与 /admin/stats 共用的只读统计（§26）
import { Db } from '../db';
import { num, str, b } from '../row';
import { escapeLikePattern } from '../../utils/path';

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
  /** 显式标记为备用（mount_providers.standby = 1）的池成员（排除主 provider）；不再按「该桶 0 文件」推断 */
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
  /**
   * 备份桶参与：本桶显式标记为备用（§31，`mount_providers.standby = 1`）且不是该挂载点主桶。
   * 与文件数无关——既持文件又标备用的桶会**同时**出现在 mounts 与 standbys（泳道图两行共存）。
   */
  standbys: Array<{
    mountId: string;
    mountName: string;
    mountPath: string;
    primaryProviderId: string;
    primaryProviderName: string;
  }>;
}

// ============ 趋势聚合（§33 组合索引：仪表盘趋势曲线） ============

/** 趋势指标：downloads = 下载（action='download'）、logins = 登录成功、share_visits = 分享访问、
 *  shares = 新建分享（shares.created_at） */
export const TREND_METRICS = ['downloads', 'logins', 'shares', 'share_visits'] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];

/** 趋势粒度：hour/day/week（周一起算）/month，桶边界一律 UTC 对齐 */
export const TREND_GRANULARITIES = ['hour', 'day', 'week', 'month'] as const;
export type TrendGranularity = (typeof TREND_GRANULARITIES)[number];

export interface TrendBucket {
  /** 桶起始时间（UTC 对齐毫秒） */
  t: number;
  count: number;
}

/**
 * 指标 → 数据源：全部按 created_at 落桶，一次 GROUP BY 出全桶。
 * downloads/logins/share_visits 复用 access_logs 的既有动作命名；shares 直接数新建分享行（各状态都算创建事件）。
 * action 字段供趋势合并 audit_rollups（已归档窗口的计数来源）。
 */
const TREND_SOURCES: Record<TrendMetric, { table: string; where: string; action?: string }> = {
  downloads: { table: 'access_logs', where: `action = 'download'`, action: 'download' },
  logins: { table: 'access_logs', where: `action = 'login'`, action: 'login' },
  share_visits: { table: 'access_logs', where: `action = 'share'`, action: 'share' },
  shares: { table: 'shares', where: '1 = 1' },
};

/**
 * 粒度 → SQLite 分桶表达式（UTC；毫秒时间戳先整除 1000 再 unixepoch）。column 可换成
 * `bucket_start`（rollup 表同为小时对齐的毫秒时间戳，分桶键与明细行一致，两源可直接相加）。
 * 周：'weekday 0' 前进到最近的周日后回退 6 天 = 该日所在周的周一（周日归属前一个周一）。
 */
function trendGroupExpr(granularity: TrendGranularity, column: string): string {
  switch (granularity) {
    case 'hour':
      return `strftime('%Y-%m-%d %H:00', ${column} / 1000, 'unixepoch')`;
    case 'day':
      return `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;
    case 'week':
      return `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch', 'weekday 0', '-6 days')`;
    case 'month':
      return `strftime('%Y-%m', ${column} / 1000, 'unixepoch')`;
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** 桶起始（UTC 对齐）：hour=整点、day=当日 0 点、week=周一 0 点、month=当月 1 日 0 点 */
function trendBucketStart(ts: number, granularity: TrendGranularity): number {
  const d = new Date(ts);
  switch (granularity) {
    case 'hour':
      return Math.floor(ts / HOUR_MS) * HOUR_MS;
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case 'week': {
      const day = d.getUTCDay(); // 0 = 周日
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (day === 0 ? 6 : day - 1) * DAY_MS;
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
}

/** 下一个桶起始（UTC 无夏令时，hour/day/week 为定长步进） */
function trendNextBucket(start: number, granularity: TrendGranularity): number {
  if (granularity === 'hour') return start + HOUR_MS;
  if (granularity === 'day') return start + DAY_MS;
  if (granularity === 'week') return start + WEEK_MS;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** 桶起始 → SQL 分桶键：与 TREND_GROUP_EXPR 的输出逐字符一致（零填充靠它在对齐桶上查表） */
function trendBucketKey(start: number, granularity: TrendGranularity): string {
  const d = new Date(start);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  if (granularity === 'month') return ym;
  const day = `${ym}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return granularity === 'hour' ? `${day} ${String(d.getUTCHours()).padStart(2, '0')}:00` : day;
}

/**
 * 区间 [from, to) 的桶数（调用方据此做上限保护，避免生成超大数组）。
 * hour/day/week 定长可整除直算；month 逐月计数（受区间上限约束，最多数百次）。
 */
export function trendBucketCount(from: number, to: number, granularity: TrendGranularity): number {
  const start = trendBucketStart(from, granularity);
  if (to <= start) return 0;
  if (granularity === 'hour') return Math.ceil((to - start) / HOUR_MS);
  if (granularity === 'day') return Math.ceil((to - start) / DAY_MS);
  if (granularity === 'week') return Math.ceil((to - start) / WEEK_MS);
  let n = 0;
  for (let t = start; t < to; t = trendNextBucket(t, 'month')) n += 1;
  return n;
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
   * 趋势曲线（一次 GROUP BY 出全部桶 + 内存零填充，无 N+1、无逐桶查询）：
   * 区间左闭右开 [from, to)；桶从 floor(from) 起、到「桶起点 < to」为止（to 恰在边界时不产生尾部空桶）。
   * 无数据的桶补 0，保证前端能画连续曲线。
   */
  async trends(
    db: Db,
    opts: { metric: TrendMetric; granularity: TrendGranularity; from: number; to: number }
  ): Promise<TrendBucket[]> {
    const { metric, granularity, from, to } = opts;
    const source = TREND_SOURCES[metric];
    // 已归档窗口的明细行已移入冷层（rollups 计其数），热表查询排除这些小时桶，
    // 避免「rollup 已计数 + 热行未删完」的短暂重叠被双计；rollups 侧按同一分桶表达式给出同桶键。
    const archivedFilter = source.action
      ? `AND NOT EXISTS (SELECT 1 FROM audit_rollups r WHERE r.bucket_start = CAST(created_at / 3600000 AS INTEGER) * 3600000)`
      : '';
    const rows = await db.all(
      `SELECT ${trendGroupExpr(granularity, 'created_at')} AS k, COUNT(*) AS c
       FROM ${source.table}
       WHERE ${source.where} AND created_at >= ? AND created_at < ? ${archivedFilter}
       GROUP BY k`,
      [from, to]
    );
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(String(r.k), num(r.c));
    if (source.action) {
      const rollupRows = await db.all(
        `SELECT ${trendGroupExpr(granularity, 'bucket_start')} AS k, SUM(event_count) AS c
         FROM audit_rollups
         WHERE action = ? AND bucket_start >= ? AND bucket_start < ?
         GROUP BY k`,
        [source.action, from, to]
      );
      for (const r of rollupRows) counts.set(String(r.k), (counts.get(String(r.k)) ?? 0) + num(r.c));
    }
    const buckets: TrendBucket[] = [];
    for (let t = trendBucketStart(from, granularity); t < to; t = trendNextBucket(t, granularity)) {
      buckets.push({ t, count: counts.get(trendBucketKey(t, granularity)) ?? 0 });
    }
    return buckets;
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

  /** 挂载点总览（3 条查询 + 内存组装，禁止 N+1）：主 provider JOIN + 显式备用池成员 JOIN */
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
      // §31：备用桶是显式标记（standby = 1），不再由「该桶对此挂载点 0 文件」推断
      db.all(
        `SELECT mp.mount_id, p.id, p.name, p.bucket, mp.weight
         FROM mount_providers mp
         JOIN mounts m ON m.id = mp.mount_id
         JOIN storage_providers p ON p.id = mp.provider_id
         WHERE mp.provider_id <> m.provider_id AND mp.standby = 1
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
   * 落桶统计）；**显式标记备用**（§31，`mount_providers.standby = 1`）且非该挂载点主桶的成员进入
   * standbys —— 与文件数无关（0 文件不再作为任何判定依据，推断路径已移除），故「既持文件又标备用」的桶会同时
   * 出现在 mounts 与 standbys（泳道图备用行与挂载点行同泳道共存）。
   */
  async bucketTree(db: Db): Promise<DashboardBucket[]> {
    const [providerRows, mountRows, memberRows, usageRows] = await Promise.all([
      db.all('SELECT id, name, bucket, type FROM storage_providers ORDER BY created_at ASC, id ASC'),
      db.all('SELECT id, name, mount_path, status, capacity_bytes, provider_id FROM mounts ORDER BY priority DESC, mount_path ASC'),
      db.all('SELECT mount_id, provider_id, standby FROM mount_providers'),
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
    // mount_id → provider_id → 是否显式备用（§31；成员存在性用 has() 判断，含主桶行）
    const members = new Map<string, Map<string, boolean>>();
    for (const r of memberRows) {
      const inner = members.get(String(r.mount_id)) ?? new Map<string, boolean>();
      inner.set(String(r.provider_id), b(r.standby));
      members.set(String(r.mount_id), inner);
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
        const memberFlags = members.get(mountId);
        if (!memberFlags?.has(providerId)) continue;
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
        }
        // §31：备用条目只由显式标记决定（与文件数无关）
        if (!isPrimary && memberFlags.get(providerId) === true) {
          const primaryMount = mountById.get(mountId);
          const primaryRow = providerRows.find((pp) => String(pp.id) === String(primaryMount?.provider_id));
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
    const esc = escapeLikePattern(root);
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
