// 路径规则与 API 密钥仓库
import type { PathRule, Permission, Role, ApiKey } from '@shared/types';
import { Db } from '../db';
import { mapPathRule, mapApiKey, num, type Row } from '../row';
import { uuid } from '../../utils/crypto';

export const RuleRepo = {
  async createRule(db: Db, r: {
    pathPattern: string;
    effect: 'allow' | 'deny';
    mountId?: string;
    role?: Role;
    userId?: string;
    apiKeyId?: string;
    permissions: Permission[];
    requirePassword?: boolean;
    passwordHash?: string;
    allowedIps?: string[];
    priority?: number;
    /** 规则来源（§4.4b）：admin 缺省；user = 用户自建（须带 createdBy） */
    origin?: 'admin' | 'user';
    createdBy?: string;
  }): Promise<PathRule> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO path_rules (id, path_pattern, effect, mount_id, role, user_id, api_key_id, permissions, require_password,
        password_hash, allowed_ips, priority, origin, created_by, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [id, r.pathPattern, r.effect, r.mountId ?? null, r.role ?? null, r.userId ?? null, r.apiKeyId ?? null,
        JSON.stringify(r.permissions), r.requirePassword ? 1 : 0, r.passwordHash ?? null,
        r.allowedIps?.join(',') ?? null, r.priority ?? 0, r.origin ?? 'admin', r.createdBy ?? null, now, now]
    );
    return (await this.getRuleById(db, id)) as PathRule;
  },
  /** 用户自建规则列表（origin='user' 且 created_by 匹配） */
  async listByCreator(db: Db, userId: string): Promise<PathRule[]> {
    const rows = await db.all(
      `SELECT * FROM path_rules WHERE origin = 'user' AND created_by = ? AND status = 'active' ORDER BY created_at DESC`,
      [userId]
    );
    return rows.map(mapPathRule);
  },
  async getRuleById(db: Db, id: string): Promise<PathRule | null> {
    const row = await db.first('SELECT * FROM path_rules WHERE id = ?', [id]);
    return row ? mapPathRule(row) : null;
  },
  async listRules(db: Db, opts?: { page?: number; limit?: number }): Promise<{ rows: PathRule[]; total: number }> {
    const page = Math.max(1, opts?.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));
    const offset = (page - 1) * limit;
    const countRow = await db.first(`SELECT COUNT(*) AS c FROM path_rules WHERE status = 'active'`);
    const total = num(countRow?.c);
    const rows = await db.all(
      `SELECT * FROM path_rules WHERE status = 'active' ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return { rows: rows.map(mapPathRule), total };
  },
  async updateRule(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE path_rules SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  async deleteRule(db: Db, id: string): Promise<void> {
    await db.run('DELETE FROM path_rules WHERE id = ?', [id]);
  },
  /**
   * 查询所有可能匹配某主体的规则（用户/角色/API密钥）。
   * mountId 可选：传入时只返回该挂载的规则 + 全局规则（mount_id IS NULL）；
   * 不传时返回全部（管理/兼容场景）。
   */
  async findCandidates(db: Db, principal: { id?: string; role?: string; apiKeyId?: string }, mountId?: string): Promise<PathRule[]> {
    // mount 过滤是 AND 关系；主体条件之间是 OR 关系
    const scope: string[] = ['status = \'active\''];
    const scopeParams: unknown[] = [];
    if (mountId) {
      scope.push('(mount_id = ? OR mount_id IS NULL)');
      scopeParams.push(mountId);
    }
    const subject: string[] = [];
    const subjectParams: unknown[] = [];
    if (principal.apiKeyId) {
      subject.push('api_key_id = ?');
      subjectParams.push(principal.apiKeyId);
    }
    if (principal.id) {
      subject.push('user_id = ?');
      subjectParams.push(principal.id);
    }
    if (principal.role) {
      subject.push('role = ?');
      subjectParams.push(principal.role);
    }
    const rows = await db.all(
      `SELECT * FROM path_rules WHERE ${scope.join(' AND ')}${subject.length ? ` AND (${subject.join(' OR ')})` : ''} ORDER BY priority DESC`,
      [...scopeParams, ...subjectParams]
    );
    return rows.map(mapPathRule);
  },
};

export const ApiKeyRepo = {
  async createKey(db: Db, k: {
    userId: string;
    name: string;
    keyId: string;
    tokenHash: string;
    permissions: Permission[];
    protocols: string[];
    uploadPath?: string;
    allowedIps?: string[];
    expiresAt?: number;
    /** AES-GCM 加密的 secret 密文（S3 SigV4 网关验签用） */
    secretCipher?: string;
  }): Promise<string> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO api_keys (id, user_id, name, key_id, token_hash, permissions, protocols, upload_path, allowed_ips, expires_at, secret_cipher, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [id, k.userId, k.name, k.keyId, k.tokenHash, JSON.stringify(k.permissions), JSON.stringify(k.protocols),
        k.uploadPath ?? '/', k.allowedIps?.join(',') ?? null, k.expiresAt ?? null, k.secretCipher ?? null, now]
    );
    return id;
  },
  async getKeyById(db: Db, id: string, userId?: string) {
    const row = userId
      ? await db.first('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [id, userId])
      : await db.first('SELECT * FROM api_keys WHERE id = ?', [id]);
    return row ? mapApiKey(row) : null;
  },
  /** 按 keyId（SigV4 AccessKeyId）查询密钥 */
  async getKeyByKeyId(db: Db, keyId: string) {
    const row = await db.first('SELECT * FROM api_keys WHERE key_id = ?', [keyId]);
    return row ? mapApiKey(row) : null;
  },
  async getKeyByTokenHash(db: Db, tokenHash: string) {
    const row = await db.first('SELECT * FROM api_keys WHERE token_hash = ?', [tokenHash]);
    return row ? mapApiKey(row) : null;
  },
  async listKeysByUser(db: Db, userId: string): Promise<ApiKey[]> {
    const rows = await db.all('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    return rows.map(mapApiKey);
  },
  async revokeKey(db: Db, id: string, userId: string): Promise<boolean> {
    const res = await db.run(
      `UPDATE api_keys SET status = 'revoked' WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
    return res.changes > 0;
  },
  async touchKey(db: Db, id: string): Promise<void> {
    await db.run(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [Date.now(), id]);
  },
  async countActiveByUser(db: Db, userId: string): Promise<number> {
    const row = await db.first(`SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND status = 'active'`, [userId]);
    return num(row?.c);
  },
};

export type { Row };
