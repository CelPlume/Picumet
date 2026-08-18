// 用户与配额仓库
import type { Role, User } from '@shared/types';
import { Db } from '../db';
import { mapUser, mapQuota, num, type Row } from '../row';
import { uuid } from '../../utils/crypto';

export const UserRepo = {
  async createUser(db: Db, u: { username: string; email: string; passwordHash: string; role?: Role }): Promise<User> {
    const now = Date.now();
    const id = uuid();
    await db.run(
      `INSERT INTO users (id, username, email, email_verified, password_hash, role, default_path, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, '/', ?, ?)`,
      [id, u.username, u.email, u.passwordHash, u.role ?? 'user', now, now]
    );
    await db.run(`INSERT INTO user_quotas (user_id, updated_at) VALUES (?, ?)`, [id, now]);
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
  async getUserByEmail(db: Db, email: string): Promise<User | null> {
    const row = await db.first('SELECT * FROM users WHERE email = ?', [email]);
    return row ? mapUser(row) : null;
  },
  async updateUser(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  /** 递增会话版本（审计 H-05）：使该用户所有已签发 JWT 立即失效 */
  async bumpSessionVersion(db: Db, id: string): Promise<void> {
    await db.run(`UPDATE users SET session_version = session_version + 1, updated_at = ? WHERE id = ?`, [Date.now(), id]);
  },
  async deleteUser(db: Db, id: string): Promise<void> {
    await db.run('DELETE FROM users WHERE id = ?', [id]);
  },
  async listUsers(db: Db, opts: { page: number; limit: number; role?: string; status?: string; search?: string }): Promise<{ rows: User[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.role) {
      where.push('role = ?');
      params.push(opts.role);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.search) {
      where.push('(username LIKE ? OR email LIKE ? OR display_name LIKE ?)');
      const like = `%${opts.search}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM users ${whereSql}`, params);
    const total = num(countRow?.c);
    const rows = await db.all(
      `SELECT * FROM users ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, opts.limit, (opts.page - 1) * opts.limit]
    );
    return { rows: rows.map(mapUser), total };
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
