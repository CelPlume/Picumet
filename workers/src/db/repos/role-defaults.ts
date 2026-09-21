// 角色默认设置仓库：role_defaults 表 + 角色级设置批量覆盖到用户
import type { Permission, Role } from '@shared/types';
import { DEFAULT_ROLE_PERMISSIONS } from '@shared/types';
import { Db } from '../db';
import { num, b, str, parseJson, parseMatrixPermissions, type Row } from '../row';

export type RoleStatus = 'active' | 'disabled';

export interface RoleDefault {
  role: Role;
  alias: string | null;
  defaultPath: string;
  maxStorage: number | null;
  maxFiles: number | null;
  defaultStatus: RoleStatus;
  capabilities: string[];
  /** 角色默认权限（JSON 列，§4.4 第 8 步）；空数组 = 显式不放行，缺列/NULL = 兜底常量 */
  permissions: Permission[];
  isSystem: boolean;
  members: number;
}

/** 保存角色默认并应用到成员的载荷；可选字段缺省 = 保持对应列现状 */
export interface RoleDefaultsPatch {
  defaultPath: string;
  maxStorage: number;
  maxFiles: number;
  alias?: string | null;
  defaultStatus?: RoleStatus;
  capabilities?: string[];
  /** 角色默认权限（§4.4）；缺省 = 保持列现状（新建行取列默认值）。不写 users 表 */
  permissions?: Permission[];
}

const intOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

/**
 * 列值 → 角色默认权限：显式空数组原样保留（= 该角色默认路径内一律不放行）；
 * 缺列/NULL/脏值（存量库未补跑迁移）按兜底常量，未登记的自定义角色按 user 语义；
 * 非矩阵项（历史值 share）在解析层过滤（分享由能力位 can_share 表达）。
 */
function parseRolePermissions(role: Role, raw: unknown): Permission[] {
  if (raw === undefined || raw === null) return DEFAULT_ROLE_PERMISSIONS[role] ?? DEFAULT_ROLE_PERMISSIONS.user;
  return parseMatrixPermissions(raw);
}

function mapRoleDefault(row: Row): RoleDefault {
  const caps = parseJson<unknown>(row.capabilities, []);
  const role = String(row.role) as Role;
  return {
    role,
    alias: str(row.alias) ?? null,
    defaultPath: String(row.default_path ?? '/'),
    maxStorage: intOrNull(row.max_storage),
    maxFiles: intOrNull(row.max_files),
    defaultStatus: (str(row.default_status) ?? 'active') as RoleStatus,
    capabilities: Array.isArray(caps) ? caps.map(String) : [],
    permissions: parseRolePermissions(role, row.permissions),
    isSystem: b(row.is_system),
    members: num(row.members),
  };
}

export const RoleDefaultsRepo = {
  /** 全量角色列表（LEFT JOIN users 按 role 计数 members）；内置角色排前 */
  async list(db: Db): Promise<RoleDefault[]> {
    const rows = await db.all(
      `SELECT rd.*, COUNT(u.id) AS members
       FROM role_defaults rd
       LEFT JOIN users u ON u.role = rd.role
       GROUP BY rd.role
       ORDER BY rd.is_system DESC, rd.role ASC`
    );
    return rows.map(mapRoleDefault);
  },

  /**
   * 新建自定义角色：默认 '/'、1GiB、10000、无别名、active、'[]'，is_system=0。
   * permissions = 权限矩阵全量（与内置 user 角色一致；列默认值已收敛为 5 项（0001 §24），
   * 这里显式写入以免依赖历史列默认）。
   */
  async create(db: Db, role: Role, alias?: string | null): Promise<RoleDefault> {
    await db.run(
      `INSERT INTO role_defaults
         (role, default_path, max_storage, max_files, alias, default_status, capabilities, permissions, is_system, updated_at)
       VALUES (?, '/', 1073741824, 10000, ?, 'active', '[]', ?, 0, ?)`,
      [role, alias ?? null, JSON.stringify(DEFAULT_ROLE_PERMISSIONS.user), Date.now()]
    );
    const row = await db.first(
      `SELECT rd.*, (SELECT COUNT(*) FROM users u WHERE u.role = rd.role) AS members
       FROM role_defaults rd WHERE rd.role = ?`,
      [role]
    );
    if (!row) throw new Error('角色默认行创建失败');
    return mapRoleDefault(row);
  },

  /** 删除角色默认行；返回是否确有删除 */
  async remove(db: Db, role: Role): Promise<boolean> {
    const res = await db.run('DELETE FROM role_defaults WHERE role = ?', [role]);
    return res.changes > 0;
  },

  /**
   * upsert 角色默认设置。冲突更新不触碰 is_system；
   * alias / defaultStatus / capabilities / permissions 未提供（undefined）时保持原列值
   * （新建行 permissions 取矩阵全量，与 user 一致），alias 显式传 null 表示清空；
   * permissions 只写 role_defaults，用户行的覆盖由 applyToRole 负责。
   */
  async upsertDefaults(db: Db, role: Role, patch: RoleDefaultsPatch): Promise<void> {
    const sets = [
      'default_path = excluded.default_path',
      'max_storage = excluded.max_storage',
      'max_files = excluded.max_files',
    ];
    if (patch.alias !== undefined) sets.push('alias = excluded.alias');
    if (patch.defaultStatus !== undefined) sets.push('default_status = excluded.default_status');
    if (patch.capabilities !== undefined) sets.push('capabilities = excluded.capabilities');
    if (patch.permissions !== undefined) sets.push('permissions = excluded.permissions');
    await db.run(
      `INSERT INTO role_defaults
         (role, default_path, max_storage, max_files, alias, default_status, capabilities, permissions, is_system, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(role) DO UPDATE SET ${sets.join(', ')}, updated_at = excluded.updated_at`,
      [
        role,
        patch.defaultPath,
        patch.maxStorage,
        patch.maxFiles,
        patch.alias ?? null,
        patch.defaultStatus ?? 'active',
        patch.capabilities === undefined ? '[]' : JSON.stringify(patch.capabilities),
        JSON.stringify(patch.permissions ?? DEFAULT_ROLE_PERMISSIONS.user),
        Date.now(),
      ]
    );
  },

  /** 角色别名（role_defaults.alias）：规则主体按别名匹配时使用；无别名/未登记 → [] */
  async aliasesOf(db: Db, role: Role): Promise<string[]> {
    const rows = await db.all(
      'SELECT alias FROM role_defaults WHERE role = ? AND alias IS NOT NULL',
      [role]
    );
    return rows.map((r) => str(r.alias) ?? '').filter((a) => a.length > 0 && a !== role);
  },

  /** 角色默认权限（role_defaults.permissions）；未登记/NULL/缺列 → 兜底常量（未登记角色按 user 语义） */
  async permissionsOf(db: Db, role: Role): Promise<Permission[]> {
    // SELECT *：存量库若整列缺失也不报错，交由 parseRolePermissions 走兜底
    const row = await db.first('SELECT * FROM role_defaults WHERE role = ?', [role]);
    return parseRolePermissions(role, row?.permissions);
  },

  /**
   * 将角色默认设置立即覆盖到该角色下全部用户（事务内，任一步失败整体回滚）：
   *   1. users：default_path 恒更；permissions 恒更（写成角色权限值，**覆盖用户个别设置**）；
   *      status / capabilities 仅在参数提供时更新
   *      （角色级禁用沿用审计 H-05 约定，递增 session_version 使已签发 JWT 立即失效）；
   *   2. user_quotas：批量 upsert（缺行则插入，有行则更新 max_storage / max_files）。
   * 返回 affected（该角色用户数）。D1 事务批不回传真实 changes，
   * 故统一以应用后的成员计数为准（node:sqlite 语义相同）。
   */
  async applyToRole(db: Db, role: Role, patch: RoleDefaultsPatch): Promise<number> {
    // 角色权限值：以本次 patch 为准，未提供则取该角色当前生效值（含兜底常量）
    const rolePermissions = patch.permissions ?? (await this.permissionsOf(db, role));
    await db.transaction(async (tx) => {
      const now = Date.now();
      const userSets = ['default_path = ?', 'permissions = ?'];
      const userParams: unknown[] = [patch.defaultPath, JSON.stringify(rolePermissions)];
      if (patch.defaultStatus !== undefined) {
        userSets.push('status = ?');
        userParams.push(patch.defaultStatus);
        if (patch.defaultStatus !== 'active') userSets.push('session_version = session_version + 1');
      }
      if (patch.capabilities !== undefined) {
        userSets.push('capabilities = ?');
        userParams.push(JSON.stringify(patch.capabilities));
      }
      userParams.push(role);
      await tx.query(`UPDATE users SET ${userSets.join(', ')} WHERE role = ?`, userParams);
      // SELECT 带 WHERE 子句，规避 SQLite 对 upsert ON CONFLICT 与 join ON 的解析歧义
      await tx.query(
        `INSERT INTO user_quotas (user_id, max_storage, max_files, updated_at)
         SELECT id, ?, ?, ? FROM users WHERE role = ?
         ON CONFLICT(user_id) DO UPDATE SET
           max_storage = excluded.max_storage,
           max_files = excluded.max_files,
           updated_at = excluded.updated_at`,
        [patch.maxStorage, patch.maxFiles, now, role]
      );
    });
    const row = await db.first(`SELECT COUNT(*) AS c FROM users WHERE role = ?`, [role]);
    return num(row?.c);
  },
};
