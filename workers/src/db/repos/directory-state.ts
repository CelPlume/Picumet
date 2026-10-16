// 目录状态与权限版本仓库：管理目录 revision、结构指纹与 ETag 条件请求版本
import type { Db, Tx } from '../db';
import { num, str } from '../row';

export interface DirectoryState {
  mountId: string;
  path: string;
  revision: number;
  structureHash: string | null;
  childCount: number;
  fileCount: number;
  totalSize: number;
  lastChangedAt: number;
  lastIndexedAt: number | null;
  source: string;
}

export const DirectoryStateRepo = {
  /** 获取指定挂载点下某个目录的状态 */
  async get(db: Db, mountId: string, path: string): Promise<DirectoryState | null> {
    const row = await db.first(
      `SELECT mount_id, path, revision, structure_hash, child_count, file_count, total_size,
              last_changed_at, last_indexed_at, source
       FROM directory_states
       WHERE mount_id = ? AND path = ?`,
      [mountId, path]
    );
    if (!row) return null;
    return {
      mountId: str(row.mount_id)!,
      path: str(row.path)!,
      revision: num(row.revision),
      structureHash: str(row.structure_hash) ?? null,
      childCount: num(row.child_count),
      fileCount: num(row.file_count),
      totalSize: num(row.total_size),
      lastChangedAt: num(row.last_changed_at),
      lastIndexedAt: row.last_indexed_at ? num(row.last_indexed_at) : null,
      source: str(row.source) ?? 'application',
    };
  },

  /** 递增目录 revision（单条或批量，支持在事务内执行） */
  async bumpRevision(
    db: Db | Tx,
    mountId: string,
    path: string,
    source = 'application'
  ): Promise<void> {
    const now = Date.now();
    await db.query(
      `INSERT INTO directory_states (mount_id, path, revision, last_changed_at, source)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(mount_id, path) DO UPDATE SET
         revision = directory_states.revision + 1,
         last_changed_at = excluded.last_changed_at,
         source = excluded.source`,
      [mountId, path, now, source]
    );
  },

  /** 批量递增受影响目录的 revision */
  async bumpRevisions(
    db: Db | Tx,
    entries: Array<{ mountId: string; path: string }>,
    source = 'application'
  ): Promise<void> {
    if (entries.length === 0) return;
    const seen = new Set<string>();
    const unique: Array<{ mountId: string; path: string }> = [];
    for (const e of entries) {
      const key = `${e.mountId}\u0000${e.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(e);
      }
    }
    const now = Date.now();
    for (const u of unique) {
      await db.query(
        `INSERT INTO directory_states (mount_id, path, revision, last_changed_at, source)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(mount_id, path) DO UPDATE SET
           revision = directory_states.revision + 1,
           last_changed_at = excluded.last_changed_at,
           source = excluded.source`,
        [u.mountId, u.path, now, source]
      );
    }
  },

  /** 更新目录的结构指纹与子项计数（对账或高级索引生成 diff 时使用） */
  async updateFingerprint(
    db: Db | Tx,
    mountId: string,
    path: string,
    structureHash: string,
    childCount: number,
    bumpRevision = false
  ): Promise<void> {
    const now = Date.now();
    await db.query(
      `INSERT INTO directory_states (mount_id, path, revision, structure_hash, child_count, last_changed_at, last_indexed_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'reconcile')
       ON CONFLICT(mount_id, path) DO UPDATE SET
         revision = CASE WHEN ? THEN directory_states.revision + 1 ELSE directory_states.revision END,
         structure_hash = excluded.structure_hash,
         child_count = excluded.child_count,
         last_changed_at = CASE WHEN ? THEN excluded.last_changed_at ELSE directory_states.last_changed_at END,
         last_indexed_at = excluded.last_indexed_at,
         source = excluded.source`,
      [mountId, path, bumpRevision ? 2 : 1, structureHash, childCount, now, now, bumpRevision ? 1 : 0, bumpRevision ? 1 : 0]
    );
  },

  /** 批量获取目录状态 Map（键为 path） */
  async listByMount(db: Db, mountId: string): Promise<Map<string, DirectoryState>> {
    const rows = await db.all(
      `SELECT mount_id, path, revision, structure_hash, child_count, file_count, total_size,
              last_changed_at, last_indexed_at, source
       FROM directory_states
       WHERE mount_id = ?`,
      [mountId]
    );
    const map = new Map<string, DirectoryState>();
    for (const r of rows) {
      const p = str(r.path)!;
      map.set(p, {
        mountId: str(r.mount_id)!,
        path: p,
        revision: num(r.revision),
        structureHash: str(r.structure_hash) ?? null,
        childCount: num(r.child_count),
        fileCount: num(r.file_count),
        totalSize: num(r.total_size),
        lastChangedAt: num(r.last_changed_at),
        lastIndexedAt: r.last_indexed_at ? num(r.last_indexed_at) : null,
        source: str(r.source) ?? 'application',
      });
    }
    return map;
  },
};

/** 权限版本缓存与仓库：权限规则、挂载角色矩阵修改时递增，确保 ETag 权限敏感失效 */
export const PermissionRevisionRepo = {
  async get(db: Db, scope = 'global'): Promise<number> {
    const row = await db.first(
      `SELECT revision FROM permission_revisions WHERE scope = ?`,
      [scope]
    );
    return row ? num(row.revision) : 1;
  },

  async bump(db: Db | Tx, scope = 'global'): Promise<number> {
    const now = Date.now();
    await db.query(
      `INSERT INTO permission_revisions (scope, revision, updated_at)
       VALUES (?, 1, ?)
       ON CONFLICT(scope) DO UPDATE SET
         revision = permission_revisions.revision + 1,
         updated_at = excluded.updated_at`,
      [scope, now]
    );
    return this.get(db as Db, scope);
  },
};
