// TOTP 备用码仓库：一次性备用码的加密存储、核销与回读
// 明文以 AES-256-GCM 密文（enc: 前缀）落库，使「查看剩余备用码」可回读（对标 Google）；
// 核销时解密后逐条常量时间比对，命中即置 used_at（单次消费）。
import type { Db } from '../db';
import { num, str, type Row } from '../row';
import { uuid } from '../../utils/crypto';
import { encryptSecret, decryptSecret, timingSafeEqualStr } from '../../utils/crypto';

export interface TotpBackupCode {
  id: string;
  userId: string;
  createdAt: number;
  usedAt?: number | null;
}

export const TotpBackupRepo = {
  /** 覆盖写入用户的备用码（重新生成时作废旧码） */
  async saveCodes(db: Db, encryptionKey: string, userId: string, codes: string[], now = Date.now()): Promise<void> {
    await db.run('DELETE FROM totp_backup_codes WHERE user_id = ?', [userId]);
    for (const code of codes) {
      const cipher = await encryptSecret(code, encryptionKey);
      await db.run(
        'INSERT INTO totp_backup_codes (id, user_id, code_enc, created_at, used_at) VALUES (?, ?, ?, ?, NULL)',
        [uuid(), userId, `enc:${cipher}`, now]
      );
    }
  },

  /**
   * 原子核销：取该用户全部未消费行，逐条解密比对，命中即条件 UPDATE 置 used_at。
   * 返回是否消费成功（条件 UPDATE 的 changes > 0 保证并发下只成功一次）。
   */
  async verifyAndConsumeCode(db: Db, encryptionKey: string, userId: string, rawCode: string): Promise<boolean> {
    const code = rawCode.trim();
    if (!code) return false;
    const rows = await db.all(
      'SELECT id, code_enc FROM totp_backup_codes WHERE user_id = ? AND used_at IS NULL',
      [userId]
    );
    for (const r of rows) {
      const enc = str(r.code_enc);
      if (!enc || !enc.startsWith('enc:')) continue;
      let plain: string;
      try {
        plain = await decryptSecret(enc.slice(4), encryptionKey);
      } catch {
        continue;
      }
      if (timingSafeEqualStr(plain, code)) {
        const res = await db.run(
          'UPDATE totp_backup_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
          [Date.now(), str(r.id)]
        );
        return (res.changes ?? 0) > 0;
      }
    }
    return false;
  },

  /** 回读未消费的备用码明文（「查看剩余备用码」，对标 Google） */
  async listRemaining(db: Db, encryptionKey: string, userId: string): Promise<string[]> {
    const rows = await db.all(
      'SELECT code_enc FROM totp_backup_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at, id',
      [userId]
    );
    const out: string[] = [];
    for (const r of rows) {
      const enc = str(r.code_enc);
      if (!enc || !enc.startsWith('enc:')) continue;
      try {
        out.push(await decryptSecret(enc.slice(4), encryptionKey));
      } catch {
        // 密钥轮换等导致无法解密时跳过，不泄露明文
      }
    }
    return out;
  },

  /** 清空用户所有备用码（禁用 2FA 时调用） */
  async deleteCodes(db: Db, userId: string): Promise<void> {
    await db.run('DELETE FROM totp_backup_codes WHERE user_id = ?', [userId]);
  },

  /** 统计用户剩余未消费的备用码数量 */
  async countRemaining(db: Db, userId: string): Promise<number> {
    const row = await db.first(
      'SELECT COUNT(*) AS c FROM totp_backup_codes WHERE user_id = ? AND used_at IS NULL',
      [userId]
    );
    return num(row?.c);
  },
};