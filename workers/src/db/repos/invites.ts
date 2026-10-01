// 邀请码仓库
// 码值唯一约束由表定义保证；碰撞重试在生成方（services/invites）。
// 写入面（countByUser / create）接受 `Db | Tx`：生成服务在单事务内「计数 + 插入」，
// 消除并发请求各自读到同一计数而越过数量上限的竞态。
import type { Db, Tx } from '../db';
import { num, str, type Row } from '../row';

export interface InviteCode {
  id: string;
  code: string;
  name: string | null;
  createdBy: string;
  createdAt: number;
}

/** 受邀用户行：用户名 + 所用邀请码 + 注册时间（users.created_at） */
export interface InvitedUserRow {
  codeId: string;
  code: string;
  username: string;
  registeredAt: number;
}

function mapInviteCode(row: Row): InviteCode {
  return {
    id: str(row.id)!,
    code: str(row.code)!,
    name: str(row.name) ?? null,
    createdBy: str(row.created_by)!,
    createdAt: num(row.created_at),
  };
}

export const InviteRepo = {
  /** 按码值精确查找（BINARY 排序 = 区分大小写） */
  async findByCode(db: Db, code: string): Promise<InviteCode | null> {
    const row = await db.first('SELECT * FROM invite_codes WHERE code = ?', [code]);
    return row ? mapInviteCode(row) : null;
  },
  async countByUser(db: Db | Tx, userId: string): Promise<number> {
    const row = await db.first('SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ?', [userId]);
    return num(row?.n);
  },
  /** 插入一条邀请码；code 冲突时由底层抛 UNIQUE 约束错误，调用方重试 */
  async create(db: Db | Tx, invite: { id: string; code: string; name: string | null; createdBy: string; createdAt: number }): Promise<void> {
    await db.query(
      `INSERT INTO invite_codes (id, code, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      [invite.id, invite.code, invite.name, invite.createdBy, invite.createdAt]
    );
  },
  async listByUser(db: Db, userId: string): Promise<InviteCode[]> {
    const rows = await db.all('SELECT * FROM invite_codes WHERE created_by = ? ORDER BY created_at DESC, id DESC', [userId]);
    return rows.map(mapInviteCode);
  },
  /** 批量取若干邀请码的受邀用户（一次 IN 查询，避免逐码 N+1） */
  async listInvitedUsers(db: Db, codeIds: string[]): Promise<InvitedUserRow[]> {
    if (codeIds.length === 0) return [];
    const rows = await db.all(
      `SELECT ic.id AS code_id, ic.code AS code, u.username AS username, u.created_at AS registered_at
       FROM users u JOIN invite_codes ic ON u.invited_by_code_id = ic.id
       WHERE ic.id IN (${codeIds.map(() => '?').join(',')})
       ORDER BY u.created_at ASC`,
      codeIds
    );
    return rows.map((r) => ({
      codeId: str(r.code_id)!,
      code: str(r.code)!,
      username: str(r.username)!,
      registeredAt: num(r.registered_at),
    }));
  },
};
