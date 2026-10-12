// 邀请码仓库
// 码值唯一约束由表定义保证；碰撞重试在生成方（services/invites）。
// 写入面（createBatch）只走单条条件 INSERT：D1 事务（batch 收集器）不支持事务内读，
// 「事务内计数 + 逐条插入」在生产必 500；数量上限改由语句内 WHERE 子查询原子校验。
import type { Db } from '../db';
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
  /**
   * 批量插入邀请码（单条条件 INSERT，all-or-nothing）：
   * `WHERE (SELECT COUNT(*) …) + <count> <= <max>` 让数量上限校验随语句原子生效——
   * D1 单写者串行执行，无「先读后写」的 TOCTOU 窗口。
   * 返回实际写入行数：0 = 上限命中（调用方回 403 INVITE_LIMIT）；
   * 任一码值 UNIQUE 冲突则整句失败抛错（调用方重试整批换新码）。
   */
  async createBatch(db: Db, invites: Array<InviteCode>, maxPerUser: number): Promise<number> {
    if (invites.length === 0) return 0;
    const userId = invites[0]!.createdBy;
    const createdAt = invites[0]!.createdAt;
    // name 可能为 null：D1 绑定不接受 undefined，null 原样绑定（列可空）
    const name = invites[0]!.name;
    // SELECT 每码一行（UNION ALL 展开，首行无 FROM），列名只在首行声明
    const selects = invites.map((_, i) =>
      i === 0
        ? 'SELECT ? AS id, ? AS code'
        : 'SELECT ?, ?'
    );
    const sql = `INSERT INTO invite_codes (id, code, name, created_by, created_at)
SELECT v.id, v.code, ?, ?, ? FROM (
  ${selects.join(' UNION ALL ')}
) v
WHERE (SELECT COUNT(*) FROM invite_codes WHERE created_by = ?) + ? <= ?`;
    // 绑定顺序按占位符出现位置：SELECT 列 3 个（name/createdBy/createdAt）→
    // 每行 (id, code) → WHERE 子查询 3 个（createdBy / 本批行数 / 上限）
    const params: unknown[] = [name, userId, createdAt];
    for (const inv of invites) params.push(inv.id, inv.code);
    params.push(userId, invites.length, maxPerUser);
    const res = await db.run(sql, params);
    return res.changes;
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
