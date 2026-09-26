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
  /** 实际落桶 provider（§E 存储池；NULL/缺省 = 挂载主 provider） */
  providerId?: string | null;
  /** 物理对象键（§F 内容寻址；缺省 = object_key） */
  physicalKey?: string | null;
  /** 内容 SHA-256（§F；NULL = 未内容寻址） */
  blobHash?: string | null;
  /** 显式 id（§H 挂载点目录行用确定性 id，便于诊断与清理；缺省自动生成） */
  id?: string;
}

export const FileRepo = {
  async createFile(db: Db, f: FileInsert): Promise<FileMetadata> {
    const now = f.createdAt ?? Date.now();
    const id = f.id ?? uuid();
    await db.run(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, etag, checksum_md5,
        custom_title, custom_color, cover_url, icon_emoji, access_password, manual_position, metadata, owner_id, provider_id,
        physical_key, blob_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, f.mountId, f.objectKey, f.path, f.name, f.type, f.mimeType ?? null, f.size ?? 0, f.etag ?? null, f.checksumMd5 ?? null,
        f.customTitle ?? null, f.customColor ?? null, f.coverUrl ?? null, f.iconEmoji ?? null, f.accessPassword ?? null,
        f.manualPosition ?? null, f.metadata ?? null, f.ownerId, f.providerId ?? null, f.physicalKey ?? (f.type === 'file' ? f.objectKey : null), f.blobHash ?? null, now, now]
    );
    return (await this.getFileById(db, id)) as FileMetadata;
  },
  /** 事务内插入（D1 batch / node:sqlite 事务均可）。审计 H-5：元数据 + 配额 + 日志应同批提交。 */
  async createFileTx(tx: Tx, f: FileInsert & { id: string }): Promise<void> {
    const now = f.createdAt ?? Date.now();
    await tx.query(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, etag, checksum_md5,
        custom_title, custom_color, cover_url, icon_emoji, access_password, manual_position, metadata, owner_id, provider_id,
        physical_key, blob_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.id, f.mountId, f.objectKey, f.path, f.name, f.type, f.mimeType ?? null, f.size ?? 0, f.etag ?? null, f.checksumMd5 ?? null,
        f.customTitle ?? null, f.customColor ?? null, f.coverUrl ?? null, f.iconEmoji ?? null, f.accessPassword ?? null,
        f.manualPosition ?? null, f.metadata ?? null, f.ownerId, f.providerId ?? null, f.physicalKey ?? (f.type === 'file' ? f.objectKey : null), f.blobHash ?? null, now, now]
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
  /** 批量按 id 取文件行（审计 DESIGN-02：分享创建等批量入口一次取回，调用方按 id 建 Map 补顺序） */
  async getFilesByIds(db: Db, ids: string[]): Promise<FileMetadata[]> {
    if (ids.length === 0) return [];
    const rows = await db.all(`SELECT * FROM file_metadata WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    return rows.map(mapFile);
  },
  async getFileByObjectKey(db: Db, mountId: string, objectKey: string): Promise<FileMetadata | null> {
    const row = await db.first('SELECT * FROM file_metadata WHERE mount_id = ? AND object_key = ?', [mountId, objectKey]);
    return row ? mapFile(row) : null;
  },
  /** ownerId（网关密钥所有者隔离）：传入时仅返回该用户的文件行 */
  async getFileAtPath(db: Db, mountId: string, path: string, name: string, ownerId?: string): Promise<FileMetadata | null> {
    const sql = `SELECT * FROM file_metadata WHERE mount_id = ? AND path = ? AND name = ?${ownerId ? ' AND owner_id = ?' : ''}`;
    const row = await db.first(sql, ownerId ? [mountId, path, name, ownerId] : [mountId, path, name]);
    return row ? mapFile(row) : null;
  },
  /** 目录行表示为 path=自身完整路径：按完整路径+名字查目录（file-form 查不到目录行） */
  async getFolderAtPath(db: Db, mountId: string, fullPath: string, name: string): Promise<FileMetadata | null> {
    const row = await db.first(
      `SELECT * FROM file_metadata WHERE mount_id = ? AND path = ? AND name = ? AND type = 'folder'`,
      [mountId, fullPath, name]
    );
    return row ? mapFile(row) : null;
  },
  async listChildren(db: Db, mountId: string, path: string, opts: { sortBy?: string; sortOrder?: string; search?: string; type?: string; limit?: number; offset?: number }, ownerId?: string): Promise<{ rows: FileMetadata[]; total: number }> {
    // 文件行 path = 父目录；文件夹行 path = 自身全路径 → 需额外匹配深度 1 的子文件夹
    const base: string[] = [];
    const params: unknown[] = [mountId];
    if (ownerId) {
      // 目录行为共享命名空间（所有网关密钥可见），仅文件行按属主隔离
      base.push("(type = 'folder' OR owner_id = ?)");
      params.push(ownerId);
    }
    if (opts.type) {
      if (opts.type === 'file') {
        base.push("type = 'file' AND path = ?");
        params.push(path);
      } else if (opts.type === 'folder') {
        base.push("type = 'folder' AND path LIKE ? AND path NOT LIKE ?");
        params.push(`${path === '/' ? '' : path}/%`, `${path === '/' ? '' : path}/%/%`);
      }
    } else {
      base.push("(type = 'file' AND path = ?) OR (type = 'folder' AND path LIKE ? AND path NOT LIKE ?)");
      params.push(path, `${path === '/' ? '' : path}/%`, `${path === '/' ? '' : path}/%/%`);
    }
    if (opts.search) {
      base.push('name LIKE ?');
      params.push(`%${opts.search}%`);
    }
    const whereSql = base.map((b) => `(${b})`).join(' AND ');
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ? AND ${whereSql}`, params);
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
      `SELECT * FROM file_metadata WHERE mount_id = ? AND ${whereSql}
       ORDER BY type = 'folder' DESC, ${sortCol} ${order}, name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { rows: rows.map(mapFile), total };
  },
  /** 列出某路径下所有子项（含子文件夹，递归），用于文件夹删除/移动；ownerId 传入时限定属主 */
  async listDescendants(db: Db, mountId: string, path: string, ownerId?: string): Promise<FileMetadata[]> {
    const sql = `SELECT * FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ?)${ownerId ? ' AND owner_id = ?' : ''}`;
    const rows = await db.all(sql, ownerId ? [mountId, path, `${path}/%`, ownerId] : [mountId, path, `${path}/%`]);
    return rows.map(mapFile);
  },

  /**
   * 扁平化树视图数据源：按路径前缀取整棵子树的行（文件行 path=父目录、文件夹行 path=自身全路径，
   * 同一谓词同时命中两类）。mountId 传入时限定单挂载点（用户端树只展开当前挂载点，子挂载点
   * 由前端点击目录行导航）；rootPath='/' 且不传 mountId = 全命名空间（管理端树）。
   * withOwner 时 LEFT JOIN users 带出属主用户名（管理端树显示上传用户，避免按页 IN 补齐）。
   * LIMIT+1 探测截断：树行数可能很大，前端按 5000 封顶并提示。
   */
  async listTree(
    db: Db,
    opts: {
      rootPath?: string;
      mountId?: string;
      withOwner?: boolean;
      limit?: number;
      /** 管理端树筛选（与 /admin/files 列表同语义）：挂载点/落桶/属主/可见性/哈希子串 */
      filters?: { mountId?: string; providerId?: string; ownerId?: string; visibility?: string; blobHashLike?: string };
    }
  ): Promise<{ rows: Array<FileMetadata & { ownerName?: string }>; truncated: boolean }> {
    const root = opts.rootPath && opts.rootPath !== '/' ? opts.rootPath : null;
    // LIKE 通配符转义（目录名可含 % _ \）；root 为空 = 全命名空间（管理端树）
    const where: string[] = root ? ["(f.path = ? OR f.path LIKE ? ESCAPE '\\')"] : ['1=1'];
    const params: unknown[] = root ? [root, `${root.replace(/([\\%_])/g, '\\$1')}/%`] : [];
    const f = opts.filters;
    if (opts.mountId || f?.mountId) {
      where.push('f.mount_id = ?');
      params.push(opts.mountId ?? f!.mountId);
    }
    // 结构性筛选（落桶/哈希）只作用于文件行：文件夹行是树的骨架，须整段保留
    if (f?.providerId) {
      where.push("(f.type = 'folder' OR f.provider_id = ?)");
      params.push(f.providerId);
    }
    if (f?.ownerId) {
      where.push('f.owner_id = ?');
      params.push(f.ownerId);
    }
    if (f?.visibility === 'private' || f?.visibility === 'users' || f?.visibility === 'public') {
      where.push('f.visibility = ?');
      params.push(f.visibility);
    }
    if (f?.blobHashLike) {
      where.push("(f.type = 'folder' OR f.blob_hash LIKE ?)");
      params.push(`%${f.blobHashLike}%`);
    }
    const limit = opts.limit ?? 5000;
    const sql = `SELECT f.*${opts.withOwner ? ', u.username AS owner_name' : ''}
       FROM file_metadata f${opts.withOwner ? ' LEFT JOIN users u ON u.id = f.owner_id' : ''}
       WHERE ${where.join(' AND ')}
       ORDER BY f.path ASC, f.type = 'folder' DESC, f.name ASC
       LIMIT ?`;
    const raw = await db.all(sql, [...params, limit + 1]);
    const truncated = raw.length > limit;
    const rows = raw.slice(0, limit).map((r) => {
      const mapped = mapFile(r) as FileMetadata & { ownerName?: string };
      if (opts.withOwner && r.owner_name != null) mapped.ownerName = String(r.owner_name);
      return mapped;
    });
    return { rows, truncated };
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
  async searchFiles(db: Db, opts: {
    query: string;
    mountIds?: string[];
    ownerIds?: string[];
    page?: number;
    limit?: number;
    /** §26 全部文件筛选：挂载点精确 */
    mountId?: string;
    /** §26 全部文件筛选：落桶 provider 精确 */
    providerId?: string;
    /** §26 全部文件筛选：内容 SHA-256 子串（LIKE） */
    blobHashLike?: string;
    /** §26 全部文件筛选：属主精确 */
    ownerId?: string;
    /** §26 全部文件筛选：可见性精确 */
    visibility?: 'private' | 'users' | 'public';
    /** §26 全部文件筛选：封禁态 */
    banned?: boolean;
  }): Promise<{ rows: FileMetadata[]; total: number }> {
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
    if (opts.mountId) {
      where.push('mount_id = ?');
      params.push(opts.mountId);
    }
    if (opts.providerId) {
      where.push('provider_id = ?');
      params.push(opts.providerId);
    }
    if (opts.blobHashLike) {
      where.push('blob_hash LIKE ?');
      params.push(`%${opts.blobHashLike}%`);
    }
    if (opts.ownerId) {
      where.push('owner_id = ?');
      params.push(opts.ownerId);
    }
    if (opts.visibility) {
      where.push('visibility = ?');
      params.push(opts.visibility);
    }
    if (opts.banned !== undefined) {
      where.push('banned = ?');
      params.push(opts.banned ? 1 : 0);
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
  /** 需要清理旧对象的文件（移动后） */
  async listCleanupPending(db: Db, limit = 100): Promise<FileMetadata[]> {
    const rows = await db.all(
      `SELECT * FROM file_metadata WHERE source_cleanup_pending = 1 AND old_object_key IS NOT NULL LIMIT ?`,
      [limit]
    );
    return rows.map(mapFile);
  },
  /** 公开空间 gallery（§4.2）：visibility=public 且审核通过的直接文件行 */
  async listPublic(db: Db, opts: { page: number; limit: number }): Promise<{ rows: FileMetadata[]; total: number }> {
    const page = Math.max(1, opts.page);
    const limit = Math.min(100, Math.max(1, opts.limit));
    const offset = (page - 1) * limit;
    const where = `type = 'file' AND visibility = 'public' AND review_status = 'approved'`;
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM file_metadata WHERE ${where}`);
    const total = num(countRow?.c);
    const rows = await db.all(
      `SELECT * FROM file_metadata WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return { rows: rows.map(mapFile), total };
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
    /** §E 存储池：会话选定落桶 provider */
    providerId?: string | null;
    uploadId?: string;
    totalParts?: number;
    idempotencyKey?: string;
    expiresAt: number;
  }): Promise<string> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO upload_sessions (id, user_id, mount_id, object_key, path, file_name, mime_type, file_size,
        quota_reserved, provider_id, upload_id, total_parts, idempotency_key, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [id, s.userId, s.mountId, s.objectKey, s.path, s.fileName, s.mimeType ?? null, s.fileSize,
        s.quotaReserved, s.providerId ?? null, s.uploadId ?? null, s.totalParts ?? null, s.idempotencyKey ?? null, s.expiresAt, now]
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
  /** §F 内容寻址结果：Worker 代理单文件上传完成后记录内容哈希与物理键 */
  async recordContent(db: Db, id: string, content: { blobHash: string | null; physicalKey: string; providerId: string }): Promise<void> {
    await db.run('UPDATE upload_sessions SET blob_hash = ?, physical_key = ?, provider_id = ? WHERE id = ?', [
      content.blobHash,
      content.physicalKey,
      content.providerId,
      id,
    ]);
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
  // 审计 SEC-11：过期回收覆盖所有非终态——verifying 仍属在途（预留未落账）可过期；
  // failed 仅存量行（新失败路径一律直接标 aborted），标 'expired' 后不再是可选中状态，无双重释放。
  async listExpired(db: Db): Promise<Row[]> {
    return db.all(
      `SELECT id, user_id, mount_id, quota_reserved, provider_id FROM upload_sessions
       WHERE status IN ('pending', 'uploading', 'verifying', 'failed') AND expires_at < ?`,
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
