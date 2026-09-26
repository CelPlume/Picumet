// 桶级默认角色权限矩阵仓库（§31）：mount_provider_role_permissions 表
// 语义（比 §28 挂载点级矩阵更具体，判定时插在它**之前**）：
//   桶级条目（mount+provider+role）→ 挂载点级条目（mount+role）→ 角色默认权限；
//   桶级条目存在时构成该桶内该角色的**封闭集合**——无显式 path_rules 命中、且非文件属主时，
//   动作在条目内 → allow，不在条目内 → deny；无条目 → 回落挂载点级（再回落角色默认，存量行为零变化）。
//   share 不参与矩阵（分享开关是能力位 can_share，§4.4 防线 5）：读取侧过滤、写入侧剔除。
// 存储形态与解析规则与 mount_role_permissions 完全一致（见 mount-role-permissions.ts）：
//   permissions 列是逗号分隔的动作词表（词表 = read|write|update|delete|download），
//   非法值/share/空词表一律不入库、读回时按「无条目」处理。
import type { Permission } from '@shared/types';
import { Db, type Tx } from '../db';
import { ApiError } from '../../shared/errors';
import { str, type Row } from '../row';
import { MOUNT_ROLE_WHITELIST, mapEntry, serializePermissions } from './mount-role-permissions';

/** 桶级矩阵条目（管理端 GET /api/admin/mounts 的 poolMembers[].rolePermissions 同形） */
export interface MountProviderRolePermissionEntry {
  providerId: string;
  role: string;
  permissions: Permission[];
}

/** 行 → 条目；空词表（无有效动作）= 无条目，直接丢弃（不存在「空封闭集合」这种持久态） */
function mapRow(row: Row): MountProviderRolePermissionEntry | null {
  const entry = mapEntry(row);
  if (!entry) return null;
  return { providerId: str(row.provider_id) ?? '', ...entry };
}

export const MountProviderRolePermissionsRepo = {
  /** 单挂载点全部桶级条目（按 provider_id、role 升序；无条目 = 空数组） */
  async listByMount(db: Db, mountId: string): Promise<MountProviderRolePermissionEntry[]> {
    const rows = await db.all(
      `SELECT provider_id, role, permissions FROM mount_provider_role_permissions
       WHERE mount_id = ? ORDER BY provider_id ASC, role ASC`,
      [mountId]
    );
    return rows.map(mapRow).filter((e): e is MountProviderRolePermissionEntry => e !== null);
  },

  /**
   * 多挂载点条目（管理端列表专用）：一次 IN 查询后在内存按挂载点分组，避免逐挂载点 N+1。
   * 返回值只含**有条目**的挂载点；调用方对缺失键取 [] 即可。
   */
  async listByMounts(db: Db, mountIds: string[]): Promise<Map<string, MountProviderRolePermissionEntry[]>> {
    const grouped = new Map<string, MountProviderRolePermissionEntry[]>();
    const unique = [...new Set(mountIds)];
    if (unique.length === 0) return grouped;
    const placeholders = unique.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT mount_id, provider_id, role, permissions FROM mount_provider_role_permissions
       WHERE mount_id IN (${placeholders}) ORDER BY mount_id ASC, provider_id ASC, role ASC`,
      unique
    );
    for (const row of rows) {
      const entry = mapRow(row);
      if (!entry) continue;
      const mountId = str(row.mount_id) ?? '';
      const bucket = grouped.get(mountId);
      if (bucket) bucket.push(entry);
      else grouped.set(mountId, [entry]);
    }
    return grouped;
  },

  /**
   * 权限引擎用矩阵：role → 权限词表（限定到单个桶）。
   * 无条目的桶/角色不出现在 Map 中（空 Map = 该桶没有桶级矩阵，引擎回落挂载点级）；
   * 返回空词表的行按「无条目」处理，绝不产生空封闭集合。
   */
  async getMatrix(db: Db, mountId: string, providerId: string): Promise<Map<string, Permission[]>> {
    const matrix = new Map<string, Permission[]>();
    const rows = await db.all(
      `SELECT role, permissions FROM mount_provider_role_permissions
       WHERE mount_id = ? AND provider_id = ? ORDER BY role ASC`,
      [mountId, providerId]
    );
    for (const row of rows) {
      const entry = mapEntry(row);
      if (entry) matrix.set(entry.role, entry.permissions);
    }
    return matrix;
  },

  /**
   * 全量替换某 (挂载点, 桶) 的角色矩阵（事务内先按键清空、再插入传入条目）：
   * - entries 即**完整目标状态**：传 [] = 清空该桶矩阵；未出现在 entries 里的 role 条目一并删除；
   * - 单个条目的 permissions 为空数组（或只剩 share/非法值）= 该条目不存在，不写行；
   * - 词表去重、过滤 share；同一 role 重复出现时后者覆盖前者（避免主键冲突）；
   * - 非法 role 抛 ApiError(400)，此时事务尚未开始，落库零影响。
   * 并发语义：按 (挂载点, 桶) 整体替换，等价于管理端「桶级矩阵编辑器整体保存」。
   * 接受 Db|Tx：传入 Tx 时并入外层事务（不再自开事务，禁止嵌套）。
   */
  async setForMount(
    db: Db | Tx,
    mountId: string,
    providerId: string,
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
    const apply = async (writer: Db | Tx) => {
      await writer.query('DELETE FROM mount_provider_role_permissions WHERE mount_id = ? AND provider_id = ?', [
        mountId,
        providerId,
      ]);
      for (const [role, permissions] of targets) {
        await writer.query(
          `INSERT INTO mount_provider_role_permissions (mount_id, provider_id, role, permissions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [mountId, providerId, role, permissions, now, now]
        );
      }
    };
    if (db instanceof Db) await db.transaction(apply);
    else await apply(db);
  },
};
