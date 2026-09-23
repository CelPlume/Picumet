// 挂载点级默认角色权限矩阵仓库（§28）：mount_role_permissions 表
// 语义（与权限引擎第 8 步「角色默认权限矩阵」并列，插入其**之前**）：
//   条目存在时构成该挂载点内该角色的**封闭集合**——无显式 path_rules 命中、且非文件属主时，
//   动作在条目内 → allow，不在条目内 → deny；无条目 → 引擎回落角色默认权限矩阵（存量行为零变化）。
//   share 不参与矩阵（分享开关是能力位 can_share，§4.4 防线 5）：读取侧过滤、写入侧剔除。
// 存储形态：permissions 列是**逗号分隔**的动作词表（词表 = read|write|update|delete|download）。
import type { Permission } from '@shared/types';
import { PERMISSION_MATRIX } from '@shared/types';
import { ApiError } from '../../shared/errors';
import { Db } from '../db';
import { str, type Row } from '../row';

/** 矩阵条目（管理端读写与 GET /api/admin/mounts 的 rolePermissions 同形） */
export interface MountRolePermissionEntry {
  role: string;
  permissions: Permission[];
}

/** 可配置角色白名单：矩阵只对三个内置角色生效（自定义角色走角色默认权限） */
export const MOUNT_ROLE_WHITELIST = ['admin', 'user', 'guest'] as const;

const MATRIX: readonly Permission[] = PERMISSION_MATRIX;

/**
 * 列值（逗号分隔）→ 权限矩阵子集：去空白、剔除非法值与 share（历史值/脏值）、按出现顺序去重。
 * 矩阵外的一切值都不进入引擎，避免出现「矩阵里放着一个引擎不认的动作」这种哑档。
 */
export function parsePermissions(raw: unknown): Permission[] {
  const out: Permission[] = [];
  for (const part of (str(raw) ?? '').split(',')) {
    const action = part.trim() as Permission;
    if (!MATRIX.includes(action)) continue;
    if (!out.includes(action)) out.push(action);
  }
  return out;
}

/** 权限词表 → 列值（逗号分隔）：保序去重、剔除非法值与 share；空串 = 无条目 */
export function serializePermissions(permissions: readonly string[]): string {
  const out: Permission[] = [];
  for (const permission of permissions) {
    const action = permission as Permission;
    if (!MATRIX.includes(action)) continue;
    if (!out.includes(action)) out.push(action);
  }
  return out.join(',');
}

/** 行 → 条目；空词表（无有效动作）= 无条目，直接丢弃（不存在「空封闭集合」这种持久态） */
export function mapEntry(row: Row): MountRolePermissionEntry | null {
  const permissions = parsePermissions(row.permissions);
  if (permissions.length === 0) return null;
  return { role: str(row.role) ?? '', permissions };
}

export const MountRolePermissionsRepo = {
  /** 单挂载点全部条目（按 role 升序；无条目 = 空数组） */
  async listByMount(db: Db, mountId: string): Promise<MountRolePermissionEntry[]> {
    const rows = await db.all(
      'SELECT role, permissions FROM mount_role_permissions WHERE mount_id = ? ORDER BY role ASC',
      [mountId]
    );
    return rows.map(mapEntry).filter((e): e is MountRolePermissionEntry => e !== null);
  },

  /**
   * 多挂载点条目（管理端列表专用）：一次 IN 查询后在内存按挂载点分组，避免逐挂载点 N+1。
   * 返回值只含**有条目**的挂载点；调用方对缺失键取 [] 即可。
   */
  async listByMounts(db: Db, mountIds: string[]): Promise<Map<string, MountRolePermissionEntry[]>> {
    const grouped = new Map<string, MountRolePermissionEntry[]>();
    const unique = [...new Set(mountIds)];
    if (unique.length === 0) return grouped;
    const placeholders = unique.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT mount_id, role, permissions FROM mount_role_permissions
       WHERE mount_id IN (${placeholders}) ORDER BY mount_id ASC, role ASC`,
      unique
    );
    for (const row of rows) {
      const entry = mapEntry(row);
      if (!entry) continue;
      const mountId = str(row.mount_id) ?? '';
      const bucket = grouped.get(mountId);
      if (bucket) bucket.push(entry);
      else grouped.set(mountId, [entry]);
    }
    return grouped;
  },

  /**
   * 权限引擎用矩阵：role → 权限词表。
   * 无条目的挂载点/角色不出现在 Map 中（空 Map = 该挂载点没有矩阵，引擎回落第 9 步）；
   * 返回空词表的行按「无条目」处理，绝不产生空封闭集合。
   */
  async getMatrix(db: Db, mountId: string): Promise<Map<string, Permission[]>> {
    const matrix = new Map<string, Permission[]>();
    for (const entry of await this.listByMount(db, mountId)) {
      matrix.set(entry.role, entry.permissions);
    }
    return matrix;
  },

  /**
   * 全量替换某挂载点的角色矩阵（事务内先按挂载点清空、再插入传入条目）：
   * - entries 即**完整目标状态**：传 [] = 清空矩阵；未出现在 entries 里的 role 条目一并删除；
   * - 单个条目的 permissions 为空数组（或只剩 share/非法值）= 该条目不存在，不写行；
   * - 词表去重、过滤 share；同一 role 重复出现时后者覆盖前者（避免主键冲突）；
   * - 非法 role 抛 ApiError(400)，此时事务尚未开始，落库零影响。
   * 并发语义：整表按挂载点替换，等价于管理端「矩阵编辑器整体保存」。
   */
  async setForMount(
    db: Db,
    mountId: string,
    entries: Array<{ role: string; permissions: readonly string[] }>
  ): Promise<void> {
    const targets = new Map<string, string>();
    for (const entry of entries) {
      if (!(MOUNT_ROLE_WHITELIST as readonly string[]).includes(entry.role)) {
        throw new ApiError(400, 'VALIDATION_ERROR', `角色必须为 ${MOUNT_ROLE_WHITELIST.join('/')} 之一`);
      }
      const serialized = serializePermissions(entry.permissions);
      if (serialized === '') continue;
      targets.set(entry.role, serialized);
    }
    const now = Date.now();
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM mount_role_permissions WHERE mount_id = ?', [mountId]);
      for (const [role, permissions] of targets) {
        await tx.query(
          `INSERT INTO mount_role_permissions (mount_id, role, permissions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [mountId, role, permissions, now, now]
        );
      }
    });
  },
};
