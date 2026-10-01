// 用户与配额仓库
import type { Role, User } from '@shared/types';
import { Db, type Tx } from '../db';
import { mapUser, mapQuota, num, str, type Row } from '../row';
import { RoleDefaultsRepo } from './role-defaults';
import { uuid } from '../../utils/crypto';

/** 用户列表行：User + 受邀信息（管理端「邀请人 / 邀请码」两列；未受邀为 null） */
export type UserListRow = User & {
  /** 核销的邀请码码值 */
  inviteCode: string | null;
  /** 邀请人用户名（邀请码创建人） */
  invitedBy: string | null;
};

export const UserRepo = {
  /** 新用户默认存储限额：1GiB（存量由迁移统一回填） */
  DEFAULT_MAX_STORAGE: 1073741824,
  /**
   * 新建用户。default_path 来源与优先级：
   *   显式入参 > 该角色 role_defaults.default_path > '/'。
   * 注册（auth）与自由模式等所有创建路径共用此来源；管理员改角色默认路径后对新用户生效，
   * 不影响存量用户（角色默认批量覆盖走 RoleDefaultsRepo.applyToRole）。
   */
  async createUser(
    db: Db,
    u: { username: string; email: string; passwordHash: string; role?: Role; defaultPath?: string; invitedByCodeId?: string | null }
  ): Promise<User> {
    const now = Date.now();
    const id = uuid();
    const role = u.role ?? 'user';
    const defaultPath = u.defaultPath ?? (await RoleDefaultsRepo.defaultPathOf(db, role));
    // 邀请码核销与建号同一事务原子完成：用户行（含 invited_by_code_id）+ 配额行同成败；
    // 码行并发消失时外键约束使事务整体回滚（防「建号成功、核销悬空」）。
    // default_path 的角色默认值是读操作，放事务外（D1 事务内禁读）。
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users (id, username, email, email_verified, password_hash, role, default_path, invited_by_code_id, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [id, u.username, u.email, u.passwordHash, role, defaultPath, u.invitedByCodeId ?? null, now, now]
      );
      await tx.query(`INSERT INTO user_quotas (user_id, max_storage, updated_at) VALUES (?, ?, ?)`, [id, UserRepo.DEFAULT_MAX_STORAGE, now]);
    });
    return (await this.getUserById(db, id)) as User;
  },
  async getUserById(db: Db, id: string): Promise<User | null> {
    const row = await db.first('SELECT * FROM users WHERE id = ?', [id]);
    return row ? mapUser(row) : null;
  },
  async getUserByUsername(db: Db, username: string): Promise<User | null> {
    const row = await db.first('SELECT * FROM users WHERE username = ?', [username]);
    return row ? mapUser(row) : null;
  },
  /** 批量按用户名取用户：分享指定用户列表一次取回，缺失用户名由调用方逐个报错 */
  async getUsersByUsernames(db: Db, usernames: string[]): Promise<User[]> {
    if (usernames.length === 0) return [];
    const rows = await db.all(`SELECT * FROM users WHERE username IN (${usernames.map(() => '?').join(',')})`, usernames);
    return rows.map(mapUser);
  },
  async getUserByEmail(db: Db, email: string): Promise<User | null> {
    const row = await db.first('SELECT * FROM users WHERE email = ?', [email]);
    return row ? mapUser(row) : null;
  },
  /**
   * 邮箱存在性/归属判定（**大小写无关**）：`users.email` 是 BINARY 排序且按用户输入原样存储，
   * 精确匹配会漏掉 `Victim@example.com` 与 `victim@example.com` 这类同一邮箱的大小写变体，
   * 从而允许同一邮箱建出两个账号（登录侧按 `lower(email)` 解析，行序歧义）。
   * 注册、改绑邮箱与第三方登录的查重/自动关联都走这里，保证「一个邮箱一个账号」。
   * 注意：`lower(email)` 用不上 `idx_users_email`，用户表规模下全表扫描成本可忽略。
   */
  async findByEmailInsensitive(db: Db, email: string): Promise<User | null> {
    const row = await db.first('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1', [email.trim()]);
    return row ? mapUser(row) : null;
  },
  /**
   * 登录标识取用户：用户名或邮箱皆可（登录页同一输入框）。
   * 顺序为 用户名（精确）→ 邮箱（大小写无关）：
   * - 用户名优先且保持精确匹配，用户名注册规则为 `[a-zA-Z0-9_]`、大小写敏感；
   * - 邮箱列是 BINARY 排序（大小写敏感）且注册时按用户输入原样存储，故用 `lower(email)` 侧做
   *   大小写无关匹配，让 `Li.Mixed@Test.local` 也能用 `li.mixed@test.local` 登录
   *   （对存量大小写混合的邮箱同样生效，无需数据迁移；users 表规模小且登录受认证限流约束）。
   * 查不到一律返回 null，由调用方回同一「用户名或密码错误」，不泄露账号是否存在。
   */
  async findByLoginIdentifier(db: Db, identifier: string): Promise<User | null> {
    const key = identifier.trim();
    if (!key) return null;
    const byName = await this.getUserByUsername(db, key);
    if (byName) return byName;
    if (!key.includes('@')) return null;
    const row = await db.first('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1', [key]);
    return row ? mapUser(row) : null;
  },
  async updateUser(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  /** 递增会话版本：使该用户所有已签发 JWT 立即失效 */
  async bumpSessionVersion(db: Db, id: string): Promise<void> {
    await db.run(`UPDATE users SET session_version = session_version + 1, updated_at = ? WHERE id = ?`, [Date.now(), id]);
  },
  /**
   * 删除用户（事务内版本）：与「登记待清理对象」同事务执行，避免登记成功而删除失败时
   * 清理队列指向仍被引用的对象。级联删除 user_quotas / file_metadata / upload_sessions 等从属行。
   */
  async deleteUserTx(tx: Tx, id: string): Promise<void> {
    await tx.query('DELETE FROM users WHERE id = ?', [id]);
  },
  async deleteUser(db: Db, id: string): Promise<void> {
    await this.deleteUserTx(db, id);
  },
  async listUsers(db: Db, opts: { page: number; limit: number; role?: string; status?: string; search?: string }): Promise<{ rows: UserListRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.role) {
      where.push('u.role = ?');
      params.push(opts.role);
    }
    if (opts.status) {
      where.push('u.status = ?');
      params.push(opts.status);
    }
    if (opts.search) {
      // instr 替代 '%q%' LIKE：不受 D1 模式长度上限约束
      where.push('(instr(u.username, ?) > 0 OR instr(u.email, ?) > 0 OR instr(u.display_name, ?) > 0)');
      params.push(opts.search, opts.search, opts.search);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM users u ${whereSql}`, params);
    const total = num(countRow?.c);
    // 受邀信息随列表一次 LEFT JOIN 取回（管理端「邀请人 / 邀请码」两列），避免逐行查询（N+1）；
    // 核销列被置空或码行随创建人删除时两列为 null
    const rows = await db.all(
      `SELECT u.*, ic.code AS invite_code, creator.username AS invited_by
       FROM users u
       LEFT JOIN invite_codes ic ON ic.id = u.invited_by_code_id
       LEFT JOIN users creator ON creator.id = ic.created_by
       ${whereSql} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, opts.limit, (opts.page - 1) * opts.limit]
    );
    return {
      rows: rows.map((r) => ({ ...mapUser(r), inviteCode: str(r.invite_code) ?? null, invitedBy: str(r.invited_by) ?? null })),
      total,
    };
  },
  async countUsers(db: Db): Promise<{ total: number; active: number }> {
    const row = await db.first(`SELECT COUNT(*) AS c FROM users`);
    const activeRow = await db.first(`SELECT COUNT(*) AS c FROM users WHERE status = 'active'`);
    return { total: num(row?.c), active: num(activeRow?.c) };
  },
};

export const QuotaRepo = {
  async getQuota(db: Db, userId: string) {
    const row = await db.first('SELECT * FROM user_quotas WHERE user_id = ?', [userId]);
    return row ? mapQuota(row) : null;
  },
  /** 原子预留配额；超限返回 false */
  async reserve(db: Db, userId: string, size: number): Promise<boolean> {
    const res = await db.run(
      `UPDATE user_quotas SET quota_reserved = quota_reserved + ?, updated_at = ?
       WHERE user_id = ? AND used_storage + quota_reserved + ? <= max_storage`,
      [size, Date.now(), userId, size]
    );
    return res.changes > 0;
  },
  async canAddFile(db: Db, userId: string): Promise<boolean> {
    const row = await db.first(`SELECT used_files < max_files AS ok FROM user_quotas WHERE user_id = ?`, [userId]);
    return row ? row.ok === 1 || row.ok === true : false;
  },
  async releaseReservation(db: Db, userId: string, size: number): Promise<void> {
    await db.run(
      `UPDATE user_quotas SET quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE user_id = ?`,
      [size, Date.now(), userId]
    );
  },
  async commitUsage(db: Db, userId: string, size: number, reserved: number): Promise<void> {
    await db.run(
      `UPDATE user_quotas SET used_storage = used_storage + ?, quota_reserved = MAX(0, quota_reserved - ?),
       used_files = used_files + 1, updated_at = ? WHERE user_id = ?`,
      [size, reserved, Date.now(), userId]
    );
  },
  async decrementUsage(db: Db, userId: string, size: number, count: number): Promise<void> {
    await db.run(
      `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ?), used_files = MAX(0, used_files - ?),
       updated_at = ? WHERE user_id = ?`,
      [size, count, Date.now(), userId]
    );
  },
  async setQuota(db: Db, userId: string, maxStorage?: number, maxFiles?: number): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (maxStorage !== undefined) {
      sets.push('max_storage = ?');
      params.push(maxStorage);
    }
    if (maxFiles !== undefined) {
      sets.push('max_files = ?');
      params.push(maxFiles);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(Date.now(), userId);
    await db.run(`UPDATE user_quotas SET ${sets.join(', ')} WHERE user_id = ?`, params);
  },
};

export type { Row };
