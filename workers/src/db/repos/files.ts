// 文件元数据、上传会话、操作任务仓库
import type { FileMetadata, Permission } from '@shared/types';
import { Db, type Tx } from '../db';
import { mapFile, mapUploadSession, toFileListItem, num, str, type Row } from '../row';
import { uuid } from '../../utils/crypto';

export interface FileInsert {
  mountId: string;
  objectKey: string;
  path: string;
  name: string;
  type: 'file' | 'folder';
  mimeType?: string;
  size?: number;
  etag?: string;
  checksumMd5?: string;
  ownerId: string;
  createdAt?: number;
  customTitle?: string;
  customColor?: string;
  coverUrl?: string;
  iconEmoji?: string;
  accessPassword?: string;
  manualPosition?: number;
  metadata?: string;
}

export const FileRepo = {
  async createFile(db: Db, f: FileInsert): Promise<FileMetadata> {
    const now = f.createdAt ?? Date.now();
    const id = uuid();
    await db.run(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, etag, checksum_md5,
        custom_title, custom_color, cover_url, icon_emoji, access_password, manual_position, metadata, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, f.mountId, f.objectKey, f.path, f.name, f.type, f.mimeType ?? null, f.size ?? 0, f.etag ?? null, f.checksumMd5 ?? null,
        f.customTitle ?? null, f.customColor ?? null, f.coverUrl ?? null, f.iconEmoji ?? null, f.accessPassword ?? null,
        f.manualPosition ?? null, f.metadata ?? null, f.ownerId, now, now]
    );
    return (await this.getFileById(db, id)) as FileMetadata;
  },
  /** 事务内插入（D1 batch / node:sqlite 事务均可）。审计 H-5：元数据 + 配额 + 日志应同批提交。 */
  async createFileTx(tx: Tx, f: FileInsert & { id: string }): Promise<void> {
    const now = f.createdAt ?? Date.now();
    await tx.query(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, etag, checksum_md5,
        custom_title, custom_color, cover_url, icon_emoji, access_password, manual_position, metadata, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.id, f.mountId, f.objectKey, f.path, f.name, f.type, f.mimeType ?? null, f.size ?? 0, f.etag ?? null, f.checksumMd5 ?? null,
        f.customTitle ?? null, f.customColor ?? null, f.coverUrl ?? null, f.iconEmoji ?? null, f.accessPassword ?? null,
        f.manualPosition ?? null, f.metadata ?? null, f.ownerId, now, now]
    );
  },
  async updateFileTx(tx: Tx, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await tx.query(`UPDATE file_metadata SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  async getFileById(db: Db, id: string): Promise<FileMetadata | null> {
    const row = await db.first('SELECT * FROM file_metadata WHERE id = ?', [id]);
    return row ? mapFile(row) : null;
  },
  async getFileByObjectKey(db: Db, mountId: string, objectKey: string): Promise<FileMetadata | null> {
    const row = await db.first('SELECT * FROM file_metadata WHERE mount_id = ? AND object_key = ?', [mountId, objectKey]);
    return row ? mapFile(row) : null;
  },
  async getFileAtPath(db: Db, mountId: string, path: string, name: string): Promise<FileMetadata | null> {
    const row = await db.first('SELECT * FROM file_metadata WHERE mount_id = ? AND path = ? AND name = ?', [mountId, path, name]);
    return row ? mapFile(row) : null;
  },
  async listChildren(db: Db, mountId: string, path: string, opts: { sortBy?: string; sortOrder?: string; search?: string; type?: string; limit?: number; offset?: number }): Promise<{ rows: FileMetadata[]; total: number }> {
    const where: string[] = ['mount_id = ?', 'path = ?'];
    const params: unknown[] = [mountId, path];
    if (opts.search) {
      where.push('name LIKE ?');
      params.push(`%${opts.search}%`);
    }
    if (opts.type) {
      where.push('type = ?');
      params.push(opts.type);
    }
    const whereSql = where.join(' AND ');
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM file_metadata WHERE ${whereSql}`, params);
    const total = num(countRow?.c);
    const sortMap: Record<string, string> = {
      name: 'name',
      time: 'updated_at',
      size: 'size',
      manual: 'manual_position',
    };
    const sortCol = sortMap[opts.sortBy ?? 'name'] ?? 'name';
    const order = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = await db.all(
      `SELECT * FROM file_metadata WHERE ${whereSql}
       ORDER BY type = 'folder' DESC, ${sortCol} ${order}, name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { rows: rows.map(mapFile), total };
  },
  /** 列出某路径下所有子项（含子文件夹，递归），用于文件夹删除/移动 */
  async listDescendants(db: Db, mountId: string, path: string): Promise<FileMetadata[]> {
    const rows = await db.all(
      `SELECT * FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ?)`,
      [mountId, path, `${path}/%`]
    );
    return rows.map(mapFile);
  },
  async updateFile(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE file_metadata SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  async updateVersion(db: Db, id: string): Promise<void> {
    await db.run(`UPDATE file_metadata SET version = version + 1, updated_at = ? WHERE id = ?`, [Date.now(), id]);
  },
  async deleteFileById(db: Db | Tx, id: string): Promise<void> {
    await db.query('DELETE FROM file_metadata WHERE id = ?', [id]);
  },
  async deleteByPath(db: Db | Tx, mountId: string, path: string): Promise<FileMetadata[]> {
    const rows = await db.all(
      `SELECT * FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ?)`,
      [mountId, path, `${path}/%`]
    );
    await db.query(
      `DELETE FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ?)`,
      [mountId, path, `${path}/%`]
    );
    return rows.map(mapFile);
  },
  async searchFiles(db: Db, opts: { query: string; mountIds?: string[]; ownerIds?: string[]; page?: number; limit?: number }): Promise<{ rows: FileMetadata[]; total: number }> {
    const where: string[] = ['name LIKE ?'];
    const params: unknown[] = [`%${opts.query}%`];
    if (opts.mountIds && opts.mountIds.length) {
      where.push(`mount_id IN (${opts.mountIds.map(() => '?').join(',')})`);
      params.push(...opts.mountIds);
    }
    if (opts.ownerIds && opts.ownerIds.length) {
      where.push(`owner_id IN (${opts.ownerIds.map(() => '?').join(',')})`);
      params.push(...opts.ownerIds);
    }
    const whereSql = where.join(' AND ');
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 50;
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM file_metadata WHERE ${whereSql}`, params);
    const total = num(countRow?.c);
    const rows = await db.all(
      `SELECT * FROM file_metadata WHERE ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    return { rows: rows.map(mapFile), total };
  },
  async countFiles(db: Db): Promise<{ total: number; size: number }> {
    const row = await db.first(`SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM file_metadata`);
    return { total: num(row?.c), size: num(row?.s) };
  },
  async countFilesByProvider(db: Db, providerIds: string[]): Promise<Array<{ providerId: string; usedSpace: number; fileCount: number }>> {
    if (providerIds.length === 0) return [];
    const rows = await db.all(
      `SELECT m.provider_id AS providerId, COALESCE(SUM(f.size), 0) AS usedSpace, COUNT(f.id) AS fileCount
       FROM mounts m LEFT JOIN file_metadata f ON f.mount_id = m.id
       WHERE m.provider_id IN (${providerIds.map(() => '?').join(',')})
       GROUP BY m.provider_id`,
      providerIds
    );
    return rows.map((r) => ({ providerId: str(r.providerId)!, usedSpace: num(r.usedSpace), fileCount: num(r.fileCount) }));
  },
  /** 需要清理旧对象的文件（移动后） */
  async listCleanupPending(db: Db, limit = 100): Promise<FileMetadata[]> {
    const rows = await db.all(
      `SELECT * FROM file_metadata WHERE source_cleanup_pending = 1 AND old_object_key IS NOT NULL LIMIT ?`,
      [limit]
    );
    return rows.map(mapFile);
  },
};

// ============ 上传会话 ============

export const SessionRepo = {
  async createSession(db: Db, s: {
    userId: string;
    mountId: string;
    objectKey: string;
    path: string;
    fileName: string;
    mimeType?: string;
    fileSize: number;
    quotaReserved: number;
    uploadId?: string;
    totalParts?: number;
    idempotencyKey?: string;
    expiresAt: number;
  }): Promise<string> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO upload_sessions (id, user_id, mount_id, object_key, path, file_name, mime_type, file_size,
        quota_reserved, upload_id, total_parts, idempotency_key, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [id, s.userId, s.mountId, s.objectKey, s.path, s.fileName, s.mimeType ?? null, s.fileSize,
        s.quotaReserved, s.uploadId ?? null, s.totalParts ?? null, s.idempotencyKey ?? null, s.expiresAt, now]
    );
    return id;
  },
  async getSession(db: Db, id: string) {
    const row = await db.first('SELECT * FROM upload_sessions WHERE id = ?', [id]);
    return row ? mapUploadSession(row) : null;
  },
  async getSessionByIdempotencyKey(db: Db, key: string) {
    const row = await db.first('SELECT * FROM upload_sessions WHERE idempotency_key = ?', [key]);
    return row ? mapUploadSession(row) : null;
  },
  async updateStatus(db: Db, id: string, fields: { status: string; completedAt?: number; uploadId?: string }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.status) {
      sets.push('status = ?');
      params.push(fields.status);
    }
    if (fields.completedAt !== undefined) {
      sets.push('completed_at = ?');
      params.push(fields.completedAt);
    }
    if (fields.uploadId !== undefined) {
      sets.push('upload_id = ?');
      params.push(fields.uploadId);
    }
    if (sets.length === 0) return;
    await db.run(`UPDATE upload_sessions SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  },
  /** 记录已成功上传的分片（断点续传依据，Worker 代理路径服务端留存） */
  async recordPart(db: Db, sessionId: string, partNumber: number, etag: string): Promise<void> {
    const row = await db.first('SELECT parts_completed FROM upload_sessions WHERE id = ?', [sessionId]);
    const existing = row?.parts_completed
      ? JSON.parse(String(row.parts_completed)) as Array<{ partNumber: number; etag: string }>
      : [];
    const merged = [...existing.filter((p) => p.partNumber !== partNumber), { partNumber, etag }].sort(
      (a, b) => a.partNumber - b.partNumber
    );
    await db.run('UPDATE upload_sessions SET parts_completed = ? WHERE id = ?', [JSON.stringify(merged), sessionId]);
  },
  async getParts(db: Db, sessionId: string): Promise<Array<{ partNumber: number; etag: string }>> {
    const row = await db.first('SELECT parts_completed FROM upload_sessions WHERE id = ?', [sessionId]);
    if (!row?.parts_completed) return [];
    try {
      return JSON.parse(String(row.parts_completed)) as Array<{ partNumber: number; etag: string }>;
    } catch {
      return [];
    }
  },
  async listExpired(db: Db): Promise<Row[]> {
    return db.all(
      `SELECT id, user_id, quota_reserved FROM upload_sessions
       WHERE status IN ('pending', 'uploading') AND expires_at < ?`,
      [Date.now()]
    );
  },
};

// ============ 操作任务 ============

export interface OperationJob {
  id: string;
  userId: string;
  type: 'move' | 'copy' | 'delete';
  fileId?: string;
  sourcePath: string;
  targetPath?: string;
  mountId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rollback';
  progress: number;
  errorMessage?: string;
  stateData?: string;
  idempotencyKey?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export function mapJob(row: Row): OperationJob {
  return {
    id: str(row.id)!,
    userId: str(row.user_id)!,
    type: (str(row.type) ?? 'move') as OperationJob['type'],
    fileId: str(row.file_id),
    sourcePath: str(row.source_path)!,
    targetPath: str(row.target_path),
    mountId: str(row.mount_id)!,
    status: (str(row.status) ?? 'pending') as OperationJob['status'],
    progress: num(row.progress),
    errorMessage: str(row.error_message),
    stateData: str(row.state_data),
    idempotencyKey: str(row.idempotency_key),
    createdAt: num(row.created_at),
    startedAt: row.started_at ? num(row.started_at) : undefined,
    completedAt: row.completed_at ? num(row.completed_at) : undefined,
  };
}

export const JobRepo = {
  async createJob(db: Db, j: Omit<OperationJob, 'id' | 'createdAt' | 'status' | 'progress'> & { status?: OperationJob['status'] }): Promise<OperationJob> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO operation_jobs (id, user_id, type, file_id, source_path, target_path, mount_id, status, progress, state_data, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, j.userId, j.type, j.fileId ?? null, j.sourcePath, j.targetPath ?? null, j.mountId, j.status ?? 'pending', j.stateData ?? null, j.idempotencyKey ?? null, now]
    );
    return (await this.getJob(db, id)) as OperationJob;
  },
  async getJob(db: Db, id: string): Promise<OperationJob | null> {
    const row = await db.first('SELECT * FROM operation_jobs WHERE id = ?', [id]);
    return row ? mapJob(row) : null;
  },
  async updateJob(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE operation_jobs SET ${sets} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
  },
  async listJobsByUser(db: Db, userId: string, limit = 50): Promise<OperationJob[]> {
    const rows = await db.all(
      `SELECT * FROM operation_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      [userId, limit]
    );
    return rows.map(mapJob);
  },
  async listPendingJobs(db: Db, limit = 50): Promise<OperationJob[]> {
    const rows = await db.all(
      `SELECT * FROM operation_jobs WHERE status IN ('pending', 'running') ORDER BY created_at ASC LIMIT ?`,
      [limit]
    );
    return rows.map(mapJob);
  },
};

export { toFileListItem };
