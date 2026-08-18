// 定时任务：过期配额释放、移动源对象清理、过期分享标记
import { Db, SessionRepo, ShareRepo, FileRepo, MountRepo, ProviderRepo, QuotaRepo } from '../db';
import { getProvider } from './storage/providers';
import type { Env } from '../shared/types';

/** 释放过期上传会话的配额预留 */
export async function releaseExpiredReservations(env: Env): Promise<number> {
  const db = Db.fromAny(env.DB);
  const expired = await SessionRepo.listExpired(db);
  let released = 0;
  for (const session of expired) {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE user_quotas SET quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE user_id = ?`,
        [session.quota_reserved, Date.now(), session.user_id]
      );
      await tx.query(`UPDATE upload_sessions SET status = 'expired' WHERE id = ?`, [session.id]);
    });
    released++;
  }
  return released;
}

/** 清理移动后遗留的源对象（source_cleanup_pending） */
export async function cleanupOldObjects(env: Env): Promise<number> {
  const db = Db.fromAny(env.DB);
  const files = await FileRepo.listCleanupPending(db, 100);
  let cleaned = 0;
  for (const file of files) {
    if (!file.oldObjectKey) continue;
    try {
      const mount = await MountRepo.getMountById(db, file.mountId);
      const providerRow = mount ? await ProviderRepo.getProviderById(db, mount.providerId) : null;
      if (mount && providerRow) {
        const provider = await getProvider(db, providerRow, env);
        if (!file.oldObjectKey.startsWith('folder:')) {
          await provider.deleteObject(file.oldObjectKey);
        }
      }
      await FileRepo.updateFile(db, file.id, { source_cleanup_pending: 0, old_object_key: null });
      cleaned++;
    } catch {
      // 下次重试
    }
  }
  return cleaned;
}

/** 标记过期分享 */
export async function expireDueShares(env: Env): Promise<number> {
  const db = Db.fromAny(env.DB);
  return ShareRepo.expireDueShares(db);
}

/** 配额对账：纠正 used_storage / used_files */
export async function reconcileQuotas(env: Env): Promise<number> {
  const db = Db.fromAny(env.DB);
  const users = await db.all('SELECT id FROM users');
  let fixed = 0;
  for (const u of users) {
    const row = await db.first(
      `SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS c FROM file_metadata WHERE owner_id = ?`,
      [u.id]
    );
    const storage = Number(row?.s ?? 0);
    const files = Number(row?.c ?? 0);
    const quota = await QuotaRepo.getQuota(db, u.id as string);
    if (quota && (quota.usedStorage !== storage || quota.usedFiles !== files)) {
      await db.run(
        `UPDATE user_quotas SET used_storage = ?, used_files = ?, quota_reserved = MAX(0, quota_reserved), updated_at = ? WHERE user_id = ?`,
        [storage, files, Date.now(), u.id]
      );
      fixed++;
    }
  }
  return fixed;
}

/** 全部定时任务 */
export async function runScheduledTasks(env: Env): Promise<Record<string, number>> {
  const [released, cleaned, expired, reconciled] = await Promise.all([
    releaseExpiredReservations(env),
    cleanupOldObjects(env),
    expireDueShares(env),
    reconcileQuotas(env),
  ]);
  return { released, cleaned, expired, reconciled };
}
