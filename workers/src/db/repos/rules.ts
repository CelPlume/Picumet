// 路径规则与 API 密钥仓库
import type { PathRule, Permission, Role, ApiKey } from '@shared/types';
import { Db } from '../db';
import { mapPathRule, mapApiKey, num, type Row } from '../row';
import { uuid } from '../../utils/crypto';

export const RuleRepo = {
  async createRule(db: Db, r: {
    pathPattern: string;
    effect: 'allow' | 'deny';
    role?: Role;
    userId?: string;
    apiKeyId?: string;
    permissions: Permission[];
    requirePassword?: boolean;
    passwordHash?: string;
    allowedIps?: string[];
    priority?: number;
  }): Promise<PathRule> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO path_rules (id, path_pattern, effect, role, user_id, api_key_id, permissions, require_password,
        password_hash, allowed_ips, priority, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [id, r.pathPattern, r.effect, r.role ?? null, r.userId ?? null, r.apiKeyId ?? null,
        JSON.stringify(r.permissions), r.requirePassword ? 1 : 0, r.passwordHash ?? null,
        r.allowedIps?.join(',') ?? null, r.priority ?? 0, now, now]
    );
    return (await this.getRuleById(db, id)) as PathRule;
  },
  async getRuleById(db: Db, id: string): Promise<PathRule | null> {
    const row = await db.first('SELECT * FROM path_rules WHERE id = ?', [id]);
    return row ? mapPathRule(row) : null;
  },
  async listRules(db: Db): Promise<PathRule[]> {
    const rows = await db.all('SELECT * FROM path_rules WHERE status = \'active\' ORDER BY priority DESC, created_at DESC');
    return rows.map(mapPathRule);
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
  /** 查询所有可能匹配某主体的规则（用户/角色/API密钥） */
  async findCandidates(db: Db, principal: { id?: string; role?: string; apiKeyId?: string }): Promise<PathRule[]> {
    const conditions: string[] = ['status = \'active\''];
    const params: unknown[] = [];
    if (principal.apiKeyId) {
      conditions.push('api_key_id = ?');
      params.push(principal.apiKeyId);
    }
    if (principal.id) {
      conditions.push('user_id = ?');
      params.push(principal.id);
    }
    if (principal.role) {
      conditions.push('role = ?');
      params.push(principal.role);
    }
    // 也包含任何主体都适用的规则？不——路径规则必须绑定主体
    const rows = await db.all(
      `SELECT * FROM path_rules WHERE ${conditions.join(' OR ')} ORDER BY priority DESC`,
      params
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
  }): Promise<string> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO api_keys (id, user_id, name, key_id, token_hash, permissions, protocols, upload_path, allowed_ips, expires_at, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [id, k.userId, k.name, k.keyId, k.tokenHash, JSON.stringify(k.permissions), JSON.stringify(k.protocols),
        k.uploadPath ?? '/', k.allowedIps?.join(',') ?? null, k.expiresAt ?? null, now]
    );
    return id;
  },
  async getKeyById(db: Db, id: string, userId?: string) {
    const row = userId
      ? await db.first('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [id, userId])
      : await db.first('SELECT * FROM api_keys WHERE id = ?', [id]);
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
