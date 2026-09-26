// 分享、访问日志、系统设置、公告、对账仓库
import type { Share, ShareStatus, Announcement, FileMetadata, FileListItem } from '@shared/types';
import { Db, type Row, type Tx } from '../db';
import { mapShare, mapAnnouncement, mapFile, toFileListItem, num, str } from '../row';
import { uuid } from '../../utils/crypto';
import { isPathWithinBoundary } from '../../utils/path';

/** 创建分享入参：项目集合 + 访问控制（§多项目分享） */
export interface CreateShareInput {
  /** 项目 id（1..50，已去重且保持请求顺序；首项写入 shares.file_id） */
  fileIds: string[];
  creatorId: string;
  title?: string;
  passwordHash?: string;
  /** 密码可逆密文（`enc:` + AES-GCM），仅创建者列表回看用；缺省 = 不保存密文 */
  passwordCipher?: string;
  expiresAt?: number;
  maxViews?: number;
  maxDownloads?: number;
  allowPreview?: boolean;
  allowDownload?: boolean;
  requireLogin?: boolean;
  allowedUserIds?: string[] | null;
}

/** 我的分享列表条目：分享字段 + 项目聚合（一条 SQL 取回，无 N+1） */
export interface ShareSummary {
  share: Share;
  itemCount: number;
  totalSize: number;
  firstItem: FileListItem | null;
  /** 创建者用户名（同一 SQL 带出；创建者已被删除时为 ''） */
  creatorName: string;
}

/** 文件行绝对路径：文件夹行的 path 是自身全路径，文件行的 path 是父目录 */
function absolutePathOf(f: Pick<FileMetadata, 'type' | 'path' | 'name'>): string {
  if (f.type === 'folder') return f.path;
  return f.path === '/' ? `/${f.name}` : `${f.path}/${f.name}`;
}

/**
 * 我的列表聚合行 → 摘要：首项目列（first_*）重建为完整文件行后复用 mapFile/toFileListItem 映射
 */
function summaryOfRow(row: Row): ShareSummary {
  const first = row.first_id == null
    ? null
    : toFileListItem(
        mapFile({
          id: row.first_id,
          mount_id: row.first_mount_id,
          object_key: row.first_object_key,
          path: row.first_path,
          name: row.first_name,
          type: row.first_type,
          mime_type: row.first_mime_type,
          size: row.first_size,
          custom_title: row.first_custom_title,
          custom_color: row.first_custom_color,
          cover_url: row.first_cover_url,
          icon_emoji: row.first_icon_emoji,
          access_password: row.first_access_password,
          manual_position: row.first_manual_position,
          visibility: row.first_visibility,
          review_status: row.first_review_status,
          owner_id: row.first_owner_id,
          created_at: row.first_created_at,
          updated_at: row.first_updated_at,
        })
      );
  return {
    share: mapShare(row),
    itemCount: num(row.item_count),
    totalSize: num(row.total_size),
    firstItem: first,
    creatorName: str(row.creator_name) ?? '',
  };
}

/**
 * 分享列表聚合查询：一条 SQL 带出项目数、总大小与首项目行（子查询保序取 sort_order 最小项）。
 * 首项目列显式别名（first_*），避免与 shares.id / created_at 互相覆盖；WHERE 由调用方拼接。
 */
const SHARE_SUMMARY_SQL = `SELECT s.*,
        agg.item_count AS item_count, agg.total_size AS total_size,
        u.username AS creator_name,
        f.id AS first_id, f.mount_id AS first_mount_id, f.object_key AS first_object_key,
        f.path AS first_path, f.name AS first_name, f.type AS first_type,
        f.mime_type AS first_mime_type, f.size AS first_size,
        f.custom_title AS first_custom_title, f.custom_color AS first_custom_color,
        f.cover_url AS first_cover_url, f.icon_emoji AS first_icon_emoji,
        f.access_password AS first_access_password, f.manual_position AS first_manual_position,
        f.visibility AS first_visibility, f.review_status AS first_review_status,
        f.owner_id AS first_owner_id, f.created_at AS first_created_at, f.updated_at AS first_updated_at
 FROM shares s
 LEFT JOIN users u ON u.id = s.creator_id
 LEFT JOIN share_items fi ON fi.share_id = s.id
   AND fi.sort_order = (SELECT MIN(si2.sort_order) FROM share_items si2 WHERE si2.share_id = s.id)
 LEFT JOIN file_metadata f ON f.id = fi.file_id
 LEFT JOIN (
   SELECT si.share_id AS share_id, COUNT(*) AS item_count, COALESCE(SUM(fm.size), 0) AS total_size
   FROM share_items si JOIN file_metadata fm ON fm.id = si.file_id
   GROUP BY si.share_id
 ) agg ON agg.share_id = s.id`;

/** 分享列表分页（count + 聚合行），全量 SQL 条数与项目数无关 */
async function listSharesSummaryPage(
  db: Db,
  filterSql: string,
  params: unknown[],
  page: number,
  limit: number
): Promise<{ rows: ShareSummary[]; total: number }> {
  const countRow = await db.first(`SELECT COUNT(*) AS c FROM shares s WHERE ${filterSql}`, params);
  const total = num(countRow?.c);
  const rows = await db.all(
    `${SHARE_SUMMARY_SQL} WHERE ${filterSql} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit]
  );
  return { rows: rows.map(summaryOfRow), total };
}

export const ShareRepo = {
  async createShare(db: Db, s: CreateShareInput): Promise<Share> {
    const id = uuid().slice(0, 8);
    const now = Date.now();
    const [firstFileId] = s.fileIds;
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO shares (id, file_id, creator_id, title, password_hash, password_cipher, expires_at, max_views, max_downloads,
          allow_preview, allow_download, require_login, allowed_user_ids, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [id, firstFileId, s.creatorId, s.title ?? null, s.passwordHash ?? null, s.passwordCipher ?? null, s.expiresAt ?? null,
          s.maxViews ?? null, s.maxDownloads ?? null, s.allowPreview === false ? 0 : 1,
          s.allowDownload === false ? 0 : 1, s.requireLogin ? 1 : 0,
          s.allowedUserIds && s.allowedUserIds.length > 0 ? JSON.stringify(s.allowedUserIds) : null, now]
      );
      for (let i = 0; i < s.fileIds.length; i++) {
        await tx.query(
          `INSERT INTO share_items (share_id, file_id, sort_order, created_at) VALUES (?, ?, ?, ?)`,
          [id, s.fileIds[i], i, now]
        );
      }
    });
    return (await this.getShare(db, id)) as Share;
  },
  /** 分享项目行（含项目元数据），单条 JOIN 按 sort_order 升序取回 */
  async listItems(db: Db, shareId: string): Promise<Array<{ file: FileMetadata; sortOrder: number }>> {
    const rows = await db.all(
      `SELECT f.*, si.sort_order AS item_sort_order
       FROM share_items si JOIN file_metadata f ON f.id = si.file_id
       WHERE si.share_id = ?
       ORDER BY si.sort_order ASC`,
      [shareId]
    );
    return rows.map((r) => ({ file: mapFile(r), sortOrder: num(r.item_sort_order) }));
  },
  async getShare(db: Db, id: string): Promise<Share | null> {
    const row = await db.first('SELECT * FROM shares WHERE id = ?', [id]);
    return row ? mapShare(row) : null;
  },
  /** 我的分享列表（多项目）：项目数 / 总大小 / 首项目行由聚合 SQL 一次取回 */
  async listSharesWithSummary(db: Db, userId: string, opts: { page?: number; limit?: number; status?: ShareStatus }): Promise<{ rows: ShareSummary[]; total: number }> {
    const where = ['s.creator_id = ?'];
    const params: unknown[] = [userId];
    if (opts.status) {
      where.push('s.status = ?');
      params.push(opts.status);
    }
    return listSharesSummaryPage(db, where.join(' AND '), params, opts.page ?? 1, opts.limit ?? 20);
  },
  /** 管理员全局分享列表（多项目）：同聚合口径，含非属主分享 */
  async listAllSharesWithSummary(db: Db, opts: { page?: number; limit?: number; status?: string }): Promise<{ rows: ShareSummary[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push('s.status = ?');
      params.push(opts.status);
    }
    return listSharesSummaryPage(db, where.length ? where.join(' AND ') : '1 = 1', params, opts.page ?? 1, opts.limit ?? 20);
  },
  /**
   * 解析分享作用域内的文件：项目自身优先，其次为该分享任一文件夹项目的后代
   * （同一挂载点 + 同一属主 + 绝对路径在根子树内，路径段边界语义）。
   */
  async resolveShareFile(db: Db, share: Share, fileId: string): Promise<FileMetadata | null> {
    const items = (await this.listItems(db, share.id)).map((i) => i.file);
    const direct = items.find((f) => f.id === fileId);
    if (direct) return direct;
    const row = await db.first('SELECT * FROM file_metadata WHERE id = ?', [fileId]);
    if (!row) return null;
    const file = mapFile(row);
    const absPath = absolutePathOf(file);
    for (const root of items) {
      if (root.type !== 'folder') continue;
      if (root.mountId !== file.mountId || root.ownerId !== file.ownerId) continue;
      if (isPathWithinBoundary(absPath, root.path)) return file;
    }
    return null;
  },
  /** 已无任何项目的分享行（首项目删除、其余项目亦不存在时残留） */
  async deleteEmptyShares(db: Db | Tx): Promise<number> {
    const res = await db.query(
      `DELETE FROM shares WHERE NOT EXISTS (SELECT 1 FROM share_items WHERE share_items.share_id = shares.id)`
    );
    return res.changes;
  },
  async updateShare(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE shares SET ${sets} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
  },
  async deleteShare(db: Db, id: string): Promise<void> {
    await db.run('DELETE FROM shares WHERE id = ?', [id]);
  },
  async revokeShare(db: Db, id: string): Promise<boolean> {
    const res = await db.run(`UPDATE shares SET status = 'revoked' WHERE id = ?`, [id]);
    return res.changes > 0;
  },
  /** 增量浏览/下载计数，返回是否未超限 */
  async incrementView(db: Db, id: string, maxViews?: number): Promise<boolean> {
    if (maxViews === undefined || maxViews === null) {
      await db.run(`UPDATE shares SET view_count = view_count + 1, last_accessed_at = ? WHERE id = ?`, [Date.now(), id]);
      return true;
    }
    const res = await db.run(
      `UPDATE shares SET view_count = view_count + 1, last_accessed_at = ?
       WHERE id = ? AND view_count < ?`,
      [Date.now(), id, maxViews]
    );
    return res.changes > 0;
  },
  async incrementDownload(db: Db, id: string, maxDownloads?: number): Promise<boolean> {
    if (maxDownloads === undefined || maxDownloads === null) {
      await db.run(`UPDATE shares SET download_count = download_count + 1, last_accessed_at = ? WHERE id = ?`, [Date.now(), id]);
      return true;
    }
    const res = await db.run(
      `UPDATE shares SET download_count = download_count + 1, last_accessed_at = ?
       WHERE id = ? AND download_count < ?`,
      [Date.now(), id, maxDownloads]
    );
    return res.changes > 0;
  },
  async getShareWithFile(db: Db, id: string) {
    // 显式列名避免 SELECT * 中 shares.id 被 file_metadata.id 覆盖
    const row = await db.first(
      `SELECT f.id AS file_row_id, f.*, s.id, s.file_id, s.creator_id, s.title, s.password_hash, s.expires_at,
              s.max_views, s.view_count, s.max_downloads, s.download_count,
              s.allow_preview, s.allow_download, s.require_login, s.allowed_user_ids,
              s.created_at, s.last_accessed_at, s.status,
              u.username AS creator_name
       FROM shares s
       JOIN file_metadata f ON f.id = s.file_id
       LEFT JOIN users u ON u.id = s.creator_id
       WHERE s.id = ?`,
      [id]
    );
    if (!row) return null;
    const share = mapShare(row);
    // mapFile 读 row.id 会拿到分享 id（s.id 覆盖），用 file_row_id 修正
    const file = { ...mapFile(row), id: str(row.file_row_id) ?? '' };
    return {
      share,
      file,
      creatorName: str(row.creator_name) ?? 'unknown',
      listItem: toFileListItem(file),
    };
  },
  /** 分享 + 创作者名 + 全部项目（按 sort_order 升序）；显式列名避免 shares.id 覆盖 file_metadata.id */
  async getShareWithItems(db: Db, id: string): Promise<{ share: Share; creatorName: string; items: FileMetadata[] } | null> {
    const row = await db.first(
      `SELECT s.*, u.username AS creator_name
       FROM shares s
       LEFT JOIN users u ON u.id = s.creator_id
       WHERE s.id = ?`,
      [id]
    );
    if (!row) return null;
    const items = (await this.listItems(db, id)).map((i) => i.file);
    return {
      share: mapShare(row),
      creatorName: str(row.creator_name) ?? 'unknown',
      items,
    };
  },
  /** 自动过期标记 */
  async expireDueShares(db: Db): Promise<number> {
    const res = await db.run(
      `UPDATE shares SET status = 'expired'
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
      [Date.now()]
    );
    return res.changes;
  },
};

// ============ 访问日志 ============

export interface LogEntry {
  id: string;
  userId?: string;
  action: string;
  path?: string;
  metadata?: string;
  ipAddress?: string;
  userAgent?: string;
  bytesTransferred?: number;
  statusCode?: number;
  createdAt: number;
}

/**
 * 管理端日志列表的**热层行**：只含可检索的窄列，不返回 metadata/user_agent 宽字段。
 */
export interface LogHotRow {
  id: string;
  userId?: string;
  action: string;
  path?: string;
  ipAddress?: string;
  bytesTransferred: number;
  statusCode?: number;
  createdAt: number;
}

/** 归档清单行（D1 audit_archives）：冷层对象的可检索元数据 */
export interface AuditArchiveRecord {
  id: string;
  rangeStart: number;
  rangeEnd: number;
  rowCount: number;
  objectKey: string;
  bytes: number;
  sha256: string;
  version: number;
  pruned: boolean;
  createdAt: number;
}

/** 归档窗口的按小时聚合（D1 audit_rollups）：status_code 无值时以 0 占位 */
export interface AuditRollupAggregate {
  bucketStart: number;
  action: string;
  statusCode: number;
  eventCount: number;
  bytesTransferred: number;
}

/** 游标编码：`<created_at>_<id>`（id 为 uuid，不含下划线） */
function encodeLogCursor(createdAt: number, id: string): string {
  return `${createdAt}_${id}`;
}

function parseLogCursor(cursor: string): { createdAt: number; id: string } | null {
  const cut = cursor.indexOf('_');
  if (cut <= 0) return null;
  const createdAt = Number(cursor.slice(0, cut));
  const id = cursor.slice(cut + 1);
  if (!Number.isFinite(createdAt) || !id) return null;
  return { createdAt, id };
}

function mapArchive(row: Row): AuditArchiveRecord {
  return {
    id: str(row.id)!,
    rangeStart: num(row.range_start),
    rangeEnd: num(row.range_end),
    rowCount: num(row.row_count),
    objectKey: str(row.object_key)!,
    bytes: num(row.bytes),
    sha256: str(row.sha256)!,
    version: num(row.version),
    pruned: num(row.pruned) === 1,
    createdAt: num(row.created_at),
  };
}

export const LogRepo = {
  async create(db: Db, e: Omit<LogEntry, 'id' | 'createdAt'>): Promise<void> {
    await db.run(
      `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), e.userId ?? null, e.action, e.path ?? null, e.metadata ?? null, e.ipAddress ?? null, e.userAgent ?? null, e.bytesTransferred ?? 0, e.statusCode ?? null, Date.now()]
    );
  },
  async list(db: Db, opts: { page?: number; limit?: number; userId?: string; action?: string; search?: string; from?: number; to?: number }): Promise<{ rows: LogEntry[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.userId) {
      where.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts.action) {
      where.push('action = ?');
      params.push(opts.action);
    }
    if (opts.search) {
      where.push('(path LIKE ? OR metadata LIKE ?)');
      const like = `%${opts.search}%`;
      params.push(like, like);
    }
    if (opts.from) {
      where.push('created_at >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      where.push('created_at <= ?');
      params.push(opts.to);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM access_logs ${whereSql}`, params);
    const total = num(countRow?.c);
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 50;
    const rows = await db.all(
      `SELECT * FROM access_logs ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    return {
      rows: rows.map((r) => ({
        id: str(r.id)!,
        userId: str(r.user_id),
        action: str(r.action)!,
        path: str(r.path),
        metadata: str(r.metadata),
        ipAddress: str(r.ip_address),
        userAgent: str(r.user_agent),
        bytesTransferred: num(r.bytes_transferred),
        statusCode: r.status_code === null || r.status_code === undefined ? undefined : num(r.status_code),
        createdAt: num(r.created_at),
      })),
      total,
    };
  },
  async countRecent(db: Db, since: number): Promise<number> {
    const row = await db.first('SELECT COUNT(*) AS c FROM access_logs WHERE created_at >= ?', [since]);
    return num(row?.c);
  },
  async recentActivity(db: Db, limit = 10): Promise<Array<{ type: string; message: string; timestamp: number }>> {
    const rows = await db.all(
      `SELECT action, path, user_id, created_at FROM access_logs ORDER BY created_at DESC LIMIT ?`,
      [limit]
    );
    return rows.map((r) => ({
      type: str(r.action)!,
      message: `${str(r.user_id) ?? 'anonymous'} → ${str(r.action)} ${str(r.path) ?? ''}`.trim(),
      timestamp: num(r.created_at),
    }));
  },

  /**
   * 管理端游标分页：显式列（不返回 metadata/user_agent 宽字段）、稳定排序键
   * `(created_at, id)` 深页无 OFFSET、无每页 COUNT(*)。多取 1 行探测 hasMore，nextCursor 供下一页
   * （取更旧的行）。搜索仍走 path/metadata 的 LIKE（前导 % 不可索引，属已知取舍，不追加宽索引）。
   */
  async listCursor(
    db: Db,
    opts: {
      limit: number;
      cursor?: string | null;
      userId?: string;
      action?: string;
      search?: string;
      from?: number;
      to?: number;
    }
  ): Promise<{ rows: LogHotRow[]; nextCursor: string | null; hasMore: boolean }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.userId) {
      where.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts.action) {
      where.push('action = ?');
      params.push(opts.action);
    }
    if (opts.search) {
      where.push('(path LIKE ? OR metadata LIKE ?)');
      const like = `%${opts.search}%`;
      params.push(like, like);
    }
    if (opts.from) {
      where.push('created_at >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      where.push('created_at <= ?');
      params.push(opts.to);
    }
    const parsed = opts.cursor ? parseLogCursor(opts.cursor) : null;
    if (parsed) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await db.all(
      `SELECT id, user_id, action, path, ip_address, status_code, bytes_transferred, created_at
       FROM access_logs ${whereSql}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, opts.limit + 1]
    );
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const mapped: LogHotRow[] = page.map((r) => ({
      id: str(r.id)!,
      userId: str(r.user_id),
      action: str(r.action)!,
      path: str(r.path),
      ipAddress: str(r.ip_address),
      bytesTransferred: num(r.bytes_transferred),
      statusCode: r.status_code === null || r.status_code === undefined ? undefined : num(r.status_code),
      createdAt: num(r.created_at),
    }));
    const last = mapped[mapped.length - 1];
    return { rows: mapped, nextCursor: hasMore && last ? encodeLogCursor(last.createdAt, last.id) : null, hasMore };
  },

  /** 归档清单（最新在前，管理端只读展示） */
  async listArchives(db: Db, limit = 100): Promise<AuditArchiveRecord[]> {
    const rows = await db.all('SELECT * FROM audit_archives ORDER BY range_start DESC LIMIT ?', [limit]);
    return rows.map(mapArchive);
  },

  async getArchive(db: Db, id: string): Promise<AuditArchiveRecord | null> {
    const row = await db.first('SELECT * FROM audit_archives WHERE id = ?', [id]);
    return row ? mapArchive(row) : null;
  },

  /** 窗口是否已归档（存在 manifest = 导出/校验已完成，剩删除批次） */
  async getArchiveByRange(db: Db, rangeStart: number): Promise<AuditArchiveRecord | null> {
    const row = await db.first('SELECT * FROM audit_archives WHERE range_start = ? ORDER BY created_at DESC LIMIT 1', [rangeStart]);
    return row ? mapArchive(row) : null;
  },

  /** 未完成热行清理的归档窗口（归档先落库、删除分批；崩溃后由这里续跑，绝不重导/重复计数） */
  async listPendingPrunes(db: Db, limit: number): Promise<AuditArchiveRecord[]> {
    const rows = await db.all('SELECT * FROM audit_archives WHERE pruned = 0 ORDER BY range_start ASC LIMIT ?', [limit]);
    return rows.map(mapArchive);
  },

  /** 归档 manifest 落库（与 rollup 聚合同批，保证「清单存在 = 计数已入 rollup」） */
  async insertArchiveTx(tx: Tx, archive: Omit<AuditArchiveRecord, 'pruned'>): Promise<void> {
    await tx.query(
      `INSERT OR IGNORE INTO audit_archives (id, range_start, range_end, row_count, object_key, bytes, sha256, version, pruned, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [archive.id, archive.rangeStart, archive.rangeEnd, archive.rowCount, archive.objectKey, archive.bytes, archive.sha256, archive.version, archive.createdAt]
    );
  },

  /**
   * 归档窗口的按小时计数入 rollup。同一 (bucket_start, action, status_code) 以 SET 覆盖（非累加）——
   * 窗口只归档一次，重复执行幂等，不会重复计数。
   */
  async upsertRollupsTx(tx: Tx, aggregates: AuditRollupAggregate[]): Promise<void> {
    for (const a of aggregates) {
      await tx.query(
        `INSERT INTO audit_rollups (bucket_start, action, status_code, event_count, bytes_transferred)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bucket_start, action, status_code) DO UPDATE SET
           event_count = excluded.event_count,
           bytes_transferred = excluded.bytes_transferred`,
        [a.bucketStart, a.action, a.statusCode, a.eventCount, a.bytesTransferred]
      );
    }
  },

  async markArchivePruned(db: Db, id: string): Promise<void> {
    await db.run('UPDATE audit_archives SET pruned = 1 WHERE id = ?', [id]);
  },
};

// ============ 系统设置 ============

export const SettingsRepo = {
  async get(db: Db, key: string): Promise<string | null> {
    const row = await db.first('SELECT value FROM system_settings WHERE key = ?', [key]);
    return row ? (str(row.value) ?? null) : null;
  },
  /** 布尔设置读取：值按 JSON 存储（'true'/'false'），缺失或格式异常回退 fallback */
  async getBool(db: Db, key: string, fallback = false): Promise<boolean> {
    const raw = await this.get(db, key);
    if (raw == null || raw === 'null') return fallback;
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'boolean' ? parsed : fallback;
    } catch {
      return fallback;
    }
  },
  async set(db: Db, key: string, value: unknown): Promise<void> {
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    await db.run(
      `INSERT INTO system_settings (key, value, description, updated_at) VALUES (?, ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, v, Date.now()]
    );
  },
  async getAll(db: Db): Promise<Record<string, string>> {
    const rows = await db.all('SELECT key, value FROM system_settings');
    const out: Record<string, string> = {};
    for (const r of rows) out[str(r.key)!] = str(r.value)!;
    return out;
  },
};

// ============ 公告 ============

export const AnnouncementRepo = {
  async listActive(db: Db): Promise<Announcement[]> {
    const rows = await db.all(
      `SELECT * FROM announcements WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC`,
      [Date.now()]
    );
    return rows.map(mapAnnouncement);
  },
  async listAll(db: Db): Promise<Announcement[]> {
    const rows = await db.all('SELECT * FROM announcements ORDER BY created_at DESC');
    return rows.map(mapAnnouncement);
  },
  async create(db: Db, a: { title: string; content: string; level?: string; expiresAt?: number; displayMode?: string; intervalSeconds?: number; kind?: string }): Promise<string> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO announcements (id, title, content, level, active, created_at, updated_at, expires_at, display_mode, interval_seconds, kind)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [id, a.title, a.content, a.level ?? 'info', now, now, a.expiresAt ?? null, a.displayMode ?? 'always', a.intervalSeconds ?? null, a.kind ?? 'banner']
    );
    return id;
  },
  async update(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE announcements SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  async delete(db: Db, id: string): Promise<void> {
    await db.run('DELETE FROM announcements WHERE id = ?', [id]);
  },
  async dismiss(db: Db, userId: string, announcementId: string, forever: boolean): Promise<void> {
    await db.run(
      `INSERT INTO user_announcement_dismissals (user_id, announcement_id, dismissed_at, dismiss_forever)
       VALUES (?, ?, ?, ?) ON CONFLICT(user_id, announcement_id)
       DO UPDATE SET dismissed_at = excluded.dismissed_at, dismiss_forever = excluded.dismiss_forever`,
      [userId, announcementId, Date.now(), forever ? 1 : 0]
    );
  },
  async dismissedIds(db: Db, userId: string): Promise<string[]> {
    const rows = await db.all('SELECT announcement_id FROM user_announcement_dismissals WHERE user_id = ?', [userId]);
    return rows.map((r) => str(r.announcement_id)!);
  },
};

// ============ 对账 ============

export const ReconciliationRepo = {
  async createReport(db: Db, mountId: string, orphans: string[], ghosts: string[]): Promise<string> {
    const id = uuid();
    await db.run(
      `INSERT INTO reconciliation_reports (id, mount_id, orphan_objects, ghost_records, created_at, status)
       VALUES (?, ?, ?, ?, ?, 'pending_review')`,
      [id, mountId, JSON.stringify(orphans), JSON.stringify(ghosts), Date.now()]
    );
    return id;
  },
  async listReports(db: Db): Promise<Row[]> {
    return db.all('SELECT * FROM reconciliation_reports ORDER BY created_at DESC LIMIT 100');
  },
  async createOrphanObject(
    db: Db,
    o: { mountId: string; objectKey: string; reason?: string; error?: string; providerId?: string | null; uploadId?: string | null }
  ): Promise<void> {
    await db.run(
      `INSERT INTO orphan_objects (id, mount_id, object_key, reason, error, created_at, cleaned, provider_id, upload_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [uuid(), o.mountId, o.objectKey, o.reason ?? null, o.error ?? null, Date.now(), o.providerId ?? null, o.uploadId ?? null]
    );
  },
  /**
   * 登记「用户删除」前需要清理的传统路径键/分片对象（blob_hash IS NULL 的 file 行）。
   * 这些对象没有内容索引，users 级联删除会带走 file_metadata 行（唯一对账依据），因此必须在删除用户的
   * **同一事务内**先登记：orphan id 复用文件行 id（幂等），object_key 取物理键、provider_id 记录落桶
   * （为 NULL 的池化前存量行由消费端回退挂载锚点）。
   */
  async enqueueUserDeletedObjectsTx(tx: Tx, ownerId: string, now: number): Promise<void> {
    await tx.query(
      `INSERT OR IGNORE INTO orphan_objects (id, mount_id, object_key, reason, error, provider_id, created_at, cleaned)
       SELECT id, mount_id, COALESCE(physical_key, object_key), 'user_deleted', NULL, provider_id, ?, 0
       FROM file_metadata
       WHERE owner_id = ? AND type = 'file' AND blob_hash IS NULL`,
      [now, ownerId]
    );
  },
  async listOrphanObjects(db: Db): Promise<Row[]> {
    return db.all('SELECT * FROM orphan_objects WHERE cleaned = 0 ORDER BY created_at DESC LIMIT 100');
  },
};

export type { Row };
