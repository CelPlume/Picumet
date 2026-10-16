// 临时鉴权强一致状态仓库：管理 SSO state、SSO pending 等生命周期短、需原子消费的安全状态
import type { Db } from '../db';
import { num, str } from '../row';
import { sha256Hex, encryptSecret, decryptSecret } from '../../utils/crypto';

export interface AuthEphemeralState<T = unknown> {
  tokenHash: string;
  kind: string;
  payload: T;
  version: number;
  attempts: number;
  expiresAt: number;
  consumedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const AuthStateRepo = {
  /** 写入强一致鉴权状态：payload 使用环境变量密钥对称加密落库，索引使用 SHA-256 哈希值 */
  async createState<T>(
    db: Db,
    input: {
      token: string;
      kind: string;
      payload: T;
      expiresAt: number;
      encryptionKey: string;
    }
  ): Promise<void> {
    const tokenHash = await sha256Hex(input.token);
    const cipher = await encryptSecret(JSON.stringify(input.payload), input.encryptionKey);
    const now = Date.now();
    await db.run(
      `INSERT INTO auth_ephemeral_states
         (token_hash, kind, payload_cipher, expires_at, consumed_at, version, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 0, 0, ?, ?)
       ON CONFLICT(token_hash) DO UPDATE SET
         kind = excluded.kind,
         payload_cipher = excluded.payload_cipher,
         expires_at = excluded.expires_at,
         consumed_at = NULL,
         version = excluded.version,
         attempts = 0,
         updated_at = excluded.updated_at`,
      [tokenHash, input.kind, cipher, input.expiresAt, now, now]
    );
  },

  /**
   * 原子认领消费一次性状态：通过单条条件 UPDATE 将 consumed_at 标记为当前时间戳。
   * 仅当未被消费且未过期时成功（changes > 0），杜绝并发重放与条件竞争。
   */
  async consumeState<T>(
    db: Db,
    input: {
      token: string;
      kind: string;
      encryptionKey: string;
      now?: number;
    }
  ): Promise<T | null> {
    const tokenHash = await sha256Hex(input.token);
    const now = input.now ?? Date.now();

    // 原子声明所有权
    const res = await db.run(
      `UPDATE auth_ephemeral_states
       SET consumed_at = ?, updated_at = ?
       WHERE token_hash = ?
         AND kind = ?
         AND consumed_at IS NULL
         AND expires_at > ?`,
      [now, now, tokenHash, input.kind, now]
    );

    if (res.changes === 0) return null;

    const row = await db.first(
      `SELECT payload_cipher FROM auth_ephemeral_states WHERE token_hash = ?`,
      [tokenHash]
    );
    if (!row || !row.payload_cipher) return null;

    try {
      const plaintext = await decryptSecret(String(row.payload_cipher), input.encryptionKey);
      return JSON.parse(plaintext) as T;
    } catch {
      return null;
    }
  },

  /** 只读查看未消费状态（供多步骤表单展示或预检使用，不消耗状态） */
  async getState<T>(
    db: Db,
    input: {
      token: string;
      kind: string;
      encryptionKey: string;
      now?: number;
    }
  ): Promise<{ payload: T; version: number; attempts: number; expiresAt: number } | null> {
    const tokenHash = await sha256Hex(input.token);
    const now = input.now ?? Date.now();

    const row = await db.first(
      `SELECT payload_cipher, version, attempts, expires_at
       FROM auth_ephemeral_states
       WHERE token_hash = ?
         AND kind = ?
         AND consumed_at IS NULL
         AND expires_at > ?`,
      [tokenHash, input.kind, now]
    );

    if (!row || !row.payload_cipher) return null;

    try {
      const plaintext = await decryptSecret(String(row.payload_cipher), input.encryptionKey);
      const payload = JSON.parse(plaintext) as T;
      return {
        payload,
        version: num(row.version),
        attempts: num(row.attempts),
        expiresAt: num(row.expires_at),
      };
    } catch {
      return null;
    }
  },

  /** 乐观锁推进多步骤状态（例如补充注册的多因子验证与尝试计数） */
  async updateState<T>(
    db: Db,
    input: {
      token: string;
      kind: string;
      payload: T;
      expectedVersion: number;
      attempts?: number;
      expiresAt?: number;
      encryptionKey: string;
      now?: number;
    }
  ): Promise<boolean> {
    const tokenHash = await sha256Hex(input.token);
    const now = input.now ?? Date.now();
    const cipher = await encryptSecret(JSON.stringify(input.payload), input.encryptionKey);

    const res = await db.run(
      `UPDATE auth_ephemeral_states
       SET payload_cipher = ?,
           version = version + 1,
           attempts = COALESCE(?, attempts),
           expires_at = COALESCE(?, expires_at),
           updated_at = ?
       WHERE token_hash = ?
         AND kind = ?
         AND version = ?
         AND consumed_at IS NULL
         AND expires_at > ?`,
      [cipher, input.attempts ?? null, input.expiresAt ?? null, now, tokenHash, input.kind, input.expectedVersion, now]
    );

    return res.changes > 0;
  },

  /** 显式废除指定状态 */
  async invalidateState(db: Db, token: string, kind: string): Promise<void> {
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    await db.run(
      `UPDATE auth_ephemeral_states
       SET consumed_at = ?, updated_at = ?
       WHERE token_hash = ? AND kind = ?`,
      [now, now, tokenHash, kind]
    );
  },

  /** 定时任务批量清理过期或已消费的陈旧状态（受限批次删除，避免 D1 单次长事务写入） */
  async purgeExpired(db: Db, limit = 200): Promise<number> {
    const now = Date.now();
    const res = await db.run(
      `DELETE FROM auth_ephemeral_states
       WHERE rowid IN (
         SELECT rowid FROM auth_ephemeral_states
         WHERE expires_at <= ? OR consumed_at IS NOT NULL
         LIMIT ?
       )`,
      [now, limit]
    );
    return res.changes;
  },
};
