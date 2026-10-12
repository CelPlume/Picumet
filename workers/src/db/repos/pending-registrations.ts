// 待验证注册仓库（迁移 0016）
//
// 语义：/register 只登记「待验证注册」，**不写 users**；点验证链接时核销建号。
// 详见迁移注释里的死循环根因说明。
import type { Db } from '../db';
import { str } from '../row';

export interface PendingRegistration {
  id: string;
  token: string;
  username: string;
  email: string;
  /** AES-GCM 密文（enc: 前缀），建号时解密出 bcrypt 哈希 */
  passwordHash: string;
  invitedByCodeId: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface CreatePendingInput {
  token: string;
  username: string;
  email: string;
  passwordHashEnc: string;
  invitedByCodeId?: string | null;
  /** 有效期（毫秒时间戳），默认 24 小时 */
  expiresAt: number;
}

function mapRow(r: Record<string, unknown>): PendingRegistration {
  return {
    id: str(r.id) ?? '',
    token: str(r.token) ?? '',
    username: str(r.username) ?? '',
    email: str(r.email) ?? '',
    passwordHash: str(r.password_hash) ?? '',
    invitedByCodeId: str(r.invited_by_code_id) ?? null,
    expiresAt: Number(r.expires_at ?? 0),
    createdAt: Number(r.created_at ?? 0),
  };
}

export const PendingRegistrationRepo = {
  /**
   * 登记待验证注册。同邮箱/同用户名的旧待验证行先删（避免堆积多条，
   * 也让重新提交注册时不被旧行占位而误报「用户名已被占用」）。
   */
  async create(db: Db, input: CreatePendingInput): Promise<PendingRegistration> {
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.run('DELETE FROM pending_registrations WHERE email = ? OR username = ?', [input.email, input.username]);
    await db.run(
      `INSERT INTO pending_registrations (id, token, username, email, password_hash, invited_by_code_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.token, input.username, input.email, input.passwordHashEnc, input.invitedByCodeId ?? null, input.expiresAt, now]
    );
    return { id, token: input.token, username: input.username, email: input.email, passwordHash: input.passwordHashEnc, invitedByCodeId: input.invitedByCodeId ?? null, expiresAt: input.expiresAt, createdAt: now };
  },

  /** 按令牌取待验证注册（含已过期行，调用方自行判过期以便给不同文案） */
  async getByToken(db: Db, token: string): Promise<PendingRegistration | null> {
    const row = await db.first('SELECT * FROM pending_registrations WHERE token = ? LIMIT 1', [token]);
    return row ? mapRow(row) : null;
  },

  async deleteByToken(db: Db, token: string): Promise<void> {
    await db.run('DELETE FROM pending_registrations WHERE token = ?', [token]);
  },

  /** 清理过期行（定时任务调用），返回回收条数 */
  async purgeExpired(db: Db): Promise<number> {
    const res = await db.run('DELETE FROM pending_registrations WHERE expires_at <= ?', [Date.now()]);
    return res.changes ?? 0;
  },

  /** 该邮箱/用户名是否已被待验证注册占用（注册期冲突提示用；与 users 表分开判定） */
  async isTaken(db: Db, email: string, username: string): Promise<{ email: boolean; username: boolean }> {
    const rows = await db.all(
      'SELECT email, username FROM pending_registrations WHERE (lower(email) = lower(?)) OR username = ? LIMIT 2',
      [email, username]
    );
    return {
      email: rows.some((r) => String(r.email).toLowerCase() === email.toLowerCase()),
      username: rows.some((r) => String(r.username) === username),
    };
  },
};