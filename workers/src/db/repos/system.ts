// 分享、访问日志、系统设置、公告、对账仓库
import type { Share, ShareStatus, Announcement } from '@shared/types';
import { Db } from '../db';
import { mapShare, mapAnnouncement, num, str, type Row } from '../row';
import { uuid } from '../../utils/crypto';
import { toFileListItem } from './files';
import { mapFile } from '../row';

export const ShareRepo = {
  async createShare(db: Db, s: {
    fileId: string;
    creatorId: string;
    title?: string;
    passwordHash?: string;
    expiresAt?: number;
    maxViews?: number;
    maxDownloads?: number;
    allowPreview?: boolean;
    allowDownload?: boolean;
  }): Promise<Share> {
    const id = s.title ? uuid().slice(0, 8) : uuid().slice(0, 8);
    const now = Date.now();
    await db.run(
      `INSERT INTO shares (id, file_id, creator_id, title, password_hash, expires_at, max_views, max_downloads,
        allow_preview, allow_download, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [id, s.fileId, s.creatorId, s.title ?? null, s.passwordHash ?? null, s.expiresAt ?? null,
        s.maxViews ?? null, s.maxDownloads ?? null, s.allowPreview === false ? 0 : 1,
        s.allowDownload === false ? 0 : 1, now]
    );
    return (await this.getShare(db, id)) as Share;
  },
  async getShare(db: Db, id: string): Promise<Share | null> {
    const row = await db.first('SELECT * FROM shares WHERE id = ?', [id]);
    return row ? mapShare(row) : null;
  },
  async listSharesByUser(db: Db, userId: string, opts: { page?: number; limit?: number; status?: ShareStatus }): Promise<{ rows: Share[]; total: number }> {
    const where = ['creator_id = ?'];
    const params: unknown[] = [userId];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const whereSql = where.join(' AND ');
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM shares WHERE ${whereSql}`, params);
    const total = num(countRow?.c);
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 20;
    const rows = await db.all(
      `SELECT * FROM shares WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    return { rows: rows.map(mapShare), total };
  },
  async listAllShares(db: Db, opts: { page?: number; limit?: number; status?: string }): Promise<{ rows: Share[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM shares ${whereSql}`, params);
    const total = num(countRow?.c);
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 20;
    const rows = await db.all(
      `SELECT * FROM shares ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    return { rows: rows.map(mapShare), total };
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
    const row = await db.first(
      `SELECT s.*, f.*, u.username AS creator_name
       FROM shares s
       JOIN file_metadata f ON f.id = s.file_id
       LEFT JOIN users u ON u.id = s.creator_id
       WHERE s.id = ?`,
      [id]
    );
    if (!row) return null;
    const share = mapShare(row);
    const file = mapFile(row);
    return {
      share,
      file,
      creatorName: str(row.creator_name) ?? 'unknown',
      listItem: toFileListItem(file),
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
};

// ============ 系统设置 ============

export const SettingsRepo = {
  async get(db: Db, key: string): Promise<string | null> {
    const row = await db.first('SELECT value FROM system_settings WHERE key = ?', [key]);
    return row ? (str(row.value) ?? null) : null;
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
  async create(db: Db, a: { title: string; content: string; level?: string; expiresAt?: number }): Promise<string> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO announcements (id, title, content, level, active, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      [id, a.title, a.content, a.level ?? 'info', now, now, a.expiresAt ?? null]
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
  async createOrphanObject(db: Db, o: { mountId: string; objectKey: string; reason?: string; error?: string }): Promise<void> {
    await db.run(
      `INSERT INTO orphan_objects (id, mount_id, object_key, reason, error, created_at, cleaned)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [uuid(), o.mountId, o.objectKey, o.reason ?? null, o.error ?? null, Date.now()]
    );
  },
  async listOrphanObjects(db: Db): Promise<Row[]> {
    return db.all('SELECT * FROM orphan_objects WHERE cleaned = 0 ORDER BY created_at DESC LIMIT 100');
  },
};

export type { Row };
