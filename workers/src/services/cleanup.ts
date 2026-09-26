// 定时任务：过期配额释放、移动源对象清理、过期分享标记
import { BlobRepo, Db, SessionRepo, ShareRepo, FileRepo, MountRepo, MountProviderQuotaRepo, ProviderRepo, ReconciliationRepo, ReservationRepo } from '../db';
import { getProvider } from './storage/providers';
import { ensureAllMountFolders } from './storage/mount-folders';
import { archiveAuditLogs } from './audit/archive';
import { isPathWithinBoundary } from '../utils/path';
import type { Env } from '../shared/types';

/** 释放过期上传会话的配额预留（用户 / 挂载点 / 池成员三层） */
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
      await tx.query(
        `UPDATE mounts SET quota_reserved = MAX(0, quota_reserved - ?), updated_at = ? WHERE id = ?`,
        [session.quota_reserved, Date.now(), session.mount_id]
      );
      // §30 池成员级预留：新建会话的 provider_id 必填（选桶时预留），据此释放成员预留；
      // provider_id 为空 = 池化前的存量会话（当时不存在成员级预留）→ 跳过，避免误扣他人在途预留。
      if (session.provider_id) {
        await MountProviderQuotaRepo.releaseTx(
          tx,
          String(session.mount_id),
          String(session.provider_id),
          Number(session.quota_reserved ?? 0)
        );
      }
      await tx.query(`UPDATE upload_sessions SET status = 'expired' WHERE id = ?`, [session.id]);
    });
    // 过期清扫必须同时终止 Provider 的未完成 multipart upload——分片对象留在桶里持续计费，
    // 而 cleanupOldObjects / orphan_objects 都没有该 uploadId 的定位信息。abort 失败登记带 upload_id 的
    // 可重试队列（cleanupMultipartAborts），释放预留与终止 Provider 会话互不阻塞（可重入）。
    if (session.upload_id) {
      await abortExpiredMultipart(db, env, {
        mountId: String(session.mount_id),
        objectKey: String(session.object_key),
        uploadId: String(session.upload_id),
        providerId: session.provider_id ? String(session.provider_id) : null,
      });
    }
    released++;
  }
  return released;
}

/** 终止过期会话的 Provider multipart upload；失败登记清理队列（reason='multipart_abort'） */
async function abortExpiredMultipart(
  db: Db,
  env: Env,
  ref: { mountId: string; objectKey: string; uploadId: string; providerId: string | null }
): Promise<void> {
  try {
    const mount = await MountRepo.getMountById(db, ref.mountId);
    const providerId = ref.providerId ?? mount?.providerId ?? null;
    const providerRow = providerId ? await ProviderRepo.getProviderById(db, providerId) : null;
    if (!providerRow) return; // provider 已删除：没有可终止的会话
    const provider = await getProvider(db, providerRow, env);
    await provider.abortMultipartUpload(ref.objectKey, ref.uploadId);
  } catch (err) {
    await ReconciliationRepo.createOrphanObject(db, {
      mountId: ref.mountId,
      objectKey: ref.objectKey,
      providerId: ref.providerId,
      uploadId: ref.uploadId,
      reason: 'multipart_abort',
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
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
      // §E 存储池：旧对象只从「文件落桶」provider 删除（拼好桶里各文件各自登记落桶）。
      // §G 镜像豁免：池内其余成员（副桶/镜像）永不是删除目标——镜像数据由外部同步通道维护，
      // 后端误删会让容灾读回退失去数据源；镜像副本没有元数据行，也不需要这里清理。
      const providerRow = mount ? await ProviderRepo.getProviderById(db, file.providerId ?? mount.providerId) : null;
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

/**
 * 自愈：修复跨挂载点移动文件夹遗留的子树孤儿。
 * 修复放行时代码只把文件夹主行切到目标挂载，子项 UPDATE 只改 path 前缀、mount_id 仍留在源挂载点。
 * 判定：folder 行 p（path=自身全路径）与子行 c（c.path 位于 p.path 子树内且 c.mount_id != p.mount_id）。
 * 例外：c 所在挂载点的 mount_path 位于 p.path 子树内 = 嵌套挂载点目录行（挂载点行归属父挂载点命名空间），
 * 属合法结构，跳过。只纠正 mount_id：provider_id 不动（对象物理位置未变），容量差值由随后的配额对账重算。
 */
export async function repairMovedFolderOrphans(env: Env): Promise<number> {
  const db = Db.fromAny(env.DB);
  const mounts = await MountRepo.listMounts(db);
  const mountPathById: Record<string, string> = {};
  for (const m of mounts) mountPathById[m.id] = m.mountPath;
  const rows = await db.all(
    // 不用 `path LIKE p.path || '/%'`——p.path（目录名可含 %/_）会被当通配符误命中兄弟子树，
    // 且 SQLite LIKE 对 ASCII 大小写不敏感；改用精确前缀切片比较（等价语义、无通配歧义）。
    `SELECT p.id AS pid, p.path AS ppath, p.mount_id AS pmount, c.id AS cid, c.mount_id AS cmount
     FROM file_metadata p
     JOIN file_metadata c
       ON c.mount_id != p.mount_id AND substr(c.path, 1, length(p.path) + 1) = p.path || '/'
     WHERE p.type = 'folder'`
  );
  let repaired = 0;
  for (const row of rows) {
    const parentPath = String(row.ppath);
    const childMountPath = mountPathById[String(row.cmount)];
    // 嵌套挂载点行：子行挂载点位于父文件夹路径子树内，mount_id 不同是合法结构
    if (childMountPath && isPathWithinBoundary(childMountPath, parentPath)) continue;
    await db.run(`UPDATE file_metadata SET mount_id = ?, updated_at = ? WHERE id = ?`, [
      String(row.pmount),
      Date.now(),
      String(row.cid),
    ]);
    repaired++;
  }
  return repaired;
}

/** 配额对账：纠正 used_storage / used_files（用户与挂载点双层）与三层预留（聚合对账，消除 N+1） */
export async function reconcileQuotas(env: Env): Promise<number> {
  const db = Db.fromAny(env.DB);
  let fixed = 0;

  // 用户层：单条 GROUP BY 聚合 + 配额行一次查出，内存比对后仅 UPDATE 漂移行
  const userAggRows = await db.all(
    `SELECT owner_id, COALESCE(SUM(size), 0) AS s, COUNT(*) AS c FROM file_metadata GROUP BY owner_id`
  );
  const aggByOwner: Record<string, { storage: number; files: number }> = {};
  for (const r of userAggRows) {
    aggByOwner[String(r.owner_id)] = { storage: Number(r.s ?? 0), files: Number(r.c ?? 0) };
  }
  const quotaRows = await db.all('SELECT user_id, used_storage, used_files FROM user_quotas');
  for (const q of quotaRows) {
    const agg = aggByOwner[String(q.user_id)] ?? { storage: 0, files: 0 };
    if (Number(q.used_storage ?? 0) !== agg.storage || Number(q.used_files ?? 0) !== agg.files) {
      await db.run(
        `UPDATE user_quotas SET used_storage = ?, used_files = ?, updated_at = ? WHERE user_id = ?`,
        [agg.storage, agg.files, Date.now(), String(q.user_id)]
      );
      fixed++;
    }
  }
  // 文件落桶回填（§E 池化前存量行 provider_id 为 NULL → 回退主 provider 落库）
  await db.run(
    `UPDATE file_metadata SET provider_id = (
       SELECT provider_id FROM mounts WHERE mounts.id = file_metadata.mount_id
     ) WHERE provider_id IS NULL`
  );

  // 挂载点已用容量对账（跨挂载移动/历史漂移自愈）：同样单条聚合（仅文件行计入容量，文件夹伪行 size=0）
  const mountAggRows = await db.all(
    `SELECT mount_id, COALESCE(SUM(size), 0) AS s FROM file_metadata WHERE type = 'file' GROUP BY mount_id`
  );
  const storageByMount: Record<string, number> = {};
  for (const r of mountAggRows) storageByMount[String(r.mount_id)] = Number(r.s ?? 0);
  const mountRows = await db.all('SELECT id, used_storage FROM mounts');
  for (const m of mountRows) {
    const storage = storageByMount[String(m.id)] ?? 0;
    if (Number(m.used_storage ?? 0) !== storage) {
      await db.run(`UPDATE mounts SET used_storage = ?, updated_at = ? WHERE id = ?`, [storage, Date.now(), String(m.id)]);
      fixed++;
    }
  }

  // 预留对账自愈：以实际在途会话（pending/uploading/verifying）为准重算用户/挂载两层预留。
  // 注意：与在途上传存在极小竞态窗口（读到会话快照后、UPDATE 前会话可能刚好完成/失败）——
  // 完成路径在同一事务里扣减预留并落账，此处重算可能短暂覆盖该扣减，下一轮对账即按在途会话收敛。
  await db.run(
    `UPDATE user_quotas SET quota_reserved = (
       SELECT COALESCE(SUM(quota_reserved), 0) FROM upload_sessions s
       WHERE s.user_id = user_quotas.user_id AND s.status IN ('pending', 'uploading', 'verifying')
     ), updated_at = ?`,
    [Date.now()]
  );
  await db.run(
    `UPDATE mounts SET quota_reserved = (
       SELECT COALESCE(SUM(quota_reserved), 0) FROM upload_sessions s
       WHERE s.mount_id = mounts.id AND s.status IN ('pending', 'uploading', 'verifying')
     ), updated_at = ?`,
    [Date.now()]
  );
  // §30 池成员级预留：合并**两个来源**——在途会话（分片/直传会话）+ 直写预留台账
  // （write.ts / 跨挂载移动不建会话，只按会话重算会把这些预留归零，短窗口削弱成员硬容量上限）。
  // 先清理 TTL 之外的滞留台账行（崩溃/异常路径残留），再按两来源重算；成员行此时必在
  // （移除仍有未完成会话/索引的成员会被 409 阻断）。与在途上传的极小竞态窗口语义同上层（下一轮收敛）。
  await ReservationRepo.purgeStale(db, Date.now() - RESERVATION_TTL_MS);
  await db.run(
    `UPDATE mount_providers SET quota_reserved = (
       SELECT COALESCE(SUM(quota_reserved), 0) FROM upload_sessions s
       WHERE s.mount_id = mount_providers.mount_id AND s.provider_id = mount_providers.provider_id
         AND s.status IN ('pending', 'uploading', 'verifying')
     ) + (
       SELECT COALESCE(SUM(size), 0) FROM quota_reservations r
       WHERE r.mount_id = mount_providers.mount_id AND r.provider_id = mount_providers.provider_id
     )`
  );
  return fixed;
}

/** 直写预留台账行保护期：超过此时长的行视为崩溃残留（直写是单请求窗口，正常远短于此） */
const RESERVATION_TTL_MS = 2 * 3600_000;

/** 内容对象回收保护期：期满且复查无引用才真正删除（避开在途写入/去重的竞争窗口） */
const BLOB_GC_GRACE_MS = 60_000;
const BLOB_GC_BATCH = 100;
/** 「用户删除」孤儿对象每轮处理量 */
const ORPHAN_OBJECT_BATCH = 100;

/**
 * 内容对象回收（§F）：处理 blob_gc 队列。
 * 删除前复查引用——期间被重新引用的对象撤销回收（对象键按内容确定，重写即同一对象）。
 */
export async function cleanupBlobObjects(env: Env, now: number = Date.now()): Promise<number> {
  const db = Db.fromAny(env.DB);
  const entries = await BlobRepo.listGc(db, BLOB_GC_BATCH);
  let cleaned = 0;
  for (const entry of entries) {
    if (now - entry.createdAt < BLOB_GC_GRACE_MS) continue;
    if (await BlobRepo.isReferenced(db, entry.hash)) {
      await BlobRepo.removeGc(db, entry.hash, entry.mountId);
      continue;
    }
    try {
      // §G 镜像豁免：只删 blob 索引登记的那一个 provider；镜像副本不登记索引，不在此列
      const providerRow = await ProviderRepo.getProviderById(db, entry.providerId);
      if (!providerRow) {
        // provider 已删除：对象不可达，直接出队
        await BlobRepo.removeGc(db, entry.hash, entry.mountId);
        continue;
      }
      const provider = await getProvider(db, providerRow, env);
      await provider.deleteObject(entry.objectKey);
      await BlobRepo.removeGc(db, entry.hash, entry.mountId);
      cleaned++;
    } catch {
      await BlobRepo.bumpGcAttempts(db, entry.hash, entry.mountId); // 下次重试
    }
  }
  return cleaned;
}

/** 内容索引对账（§F）：补回缺失索引行；无引用且未入队的索引行进入回收队列 */
export async function reconcileBlobs(env: Env, now: number = Date.now()): Promise<number> {
  const db = Db.fromAny(env.DB);
  let fixed = 0;
  const missing = await BlobRepo.listMissingIndex(db, BLOB_GC_BATCH);
  for (const m of missing) {
    await BlobRepo.register(db, { hash: m.hash, mountId: m.mountId, providerId: m.providerId, objectKey: m.objectKey, size: m.size, etag: m.etag }, now);
    fixed++;
  }
  const orphans = await BlobRepo.listOrphanIndex(db, now - BLOB_GC_GRACE_MS, BLOB_GC_BATCH);
  for (const o of orphans) {
    await BlobRepo.enqueueGc(db, { hash: o.hash, mountId: o.mountId }, now);
    fixed++;
  }
  return fixed;
}

/**
 * 消费「用户删除」登记的对象清理队列。
 * 传统路径键/分片对象没有 blob_hash，users 级联删除会带走 file_metadata 行——那是它们唯一的对账依据，
 * 因此在删除用户前先把落桶信息登记进 orphan_objects（reason='user_deleted'），这里逐条删除并标 cleaned=1。
 * provider_id 缺失（池化前的存量行）回退挂载锚点；provider/挂载都已不存在 = 对象不可达，直接出队。
 * 删除失败写 error 并保留 cleaned=0，下轮重试。
 */
export async function cleanupUserDeletedObjects(env: Env): Promise<number> {
  const db = Db.fromAny(env.DB);
  const rows = await db.all(
    `SELECT id, mount_id, provider_id, object_key FROM orphan_objects
     WHERE cleaned = 0 AND reason = 'user_deleted' ORDER BY created_at ASC LIMIT ?`,
    [ORPHAN_OBJECT_BATCH]
  );
  let cleaned = 0;
  for (const row of rows) {
    const id = String(row.id);
    const objectKey = String(row.object_key);
    try {
      const mount = await MountRepo.getMountById(db, String(row.mount_id));
      const providerId = row.provider_id ? String(row.provider_id) : mount?.providerId;
      const providerRow = providerId ? await ProviderRepo.getProviderById(db, providerId) : null;
      if (providerRow && !objectKey.startsWith('folder:')) {
        const provider = await getProvider(db, providerRow, env);
        await provider.deleteObject(objectKey);
      }
      await db.run('UPDATE orphan_objects SET cleaned = 1 WHERE id = ?', [id]);
      cleaned++;
    } catch (err) {
      await db.run('UPDATE orphan_objects SET error = ? WHERE id = ?', [
        err instanceof Error ? err.message : 'unknown',
        id,
      ]);
    }
  }
  return cleaned;
}

/**
 * 消费「multipart abort 失败」登记队列——过期会话/显式中止未能终止的 Provider 分片上传，
 * 在这里带 upload_id 重试。终止成功或 upload_id 缺失（无法定位）即出队；provider 已删除 = 无会话可终止。
 * 失败写 error 并保留 cleaned=0，下轮重试。
 */
export async function cleanupMultipartAborts(env: Env): Promise<number> {
  const db = Db.fromAny(env.DB);
  const rows = await db.all(
    `SELECT id, mount_id, provider_id, object_key, upload_id FROM orphan_objects
     WHERE cleaned = 0 AND reason = 'multipart_abort' ORDER BY created_at ASC LIMIT ?`,
    [ORPHAN_OBJECT_BATCH]
  );
  let cleaned = 0;
  for (const row of rows) {
    const id = String(row.id);
    const uploadId = row.upload_id ? String(row.upload_id) : null;
    if (!uploadId) {
      await db.run('UPDATE orphan_objects SET cleaned = 1 WHERE id = ?', [id]);
      cleaned++;
      continue;
    }
    try {
      const mount = await MountRepo.getMountById(db, String(row.mount_id));
      const providerId = row.provider_id ? String(row.provider_id) : mount?.providerId;
      const providerRow = providerId ? await ProviderRepo.getProviderById(db, providerId) : null;
      if (providerRow) {
        const provider = await getProvider(db, providerRow, env);
        await provider.abortMultipartUpload(String(row.object_key), uploadId);
      }
      await db.run('UPDATE orphan_objects SET cleaned = 1 WHERE id = ?', [id]);
      cleaned++;
    } catch (err) {
      await db.run('UPDATE orphan_objects SET error = ? WHERE id = ?', [
        err instanceof Error ? err.message : 'unknown',
        id,
      ]);
    }
  }
  return cleaned;
}

/** 全部定时任务 */
export async function runScheduledTasks(env: Env): Promise<Record<string, number>> {
  // 子树孤儿自愈先行：先把跨挂载点移动遗留的子树孤儿 mount_id 归位，
  // 随后 reconcileQuotas 的挂载容量对账才能按正确归属把容量跟着搬过去
  const moveOrphansRepaired = await repairMovedFolderOrphans(env);
  const [released, cleaned, expired, reconciled] = await Promise.all([
    releaseExpiredReservations(env),
    cleanupOldObjects(env),
    expireDueShares(env),
    reconcileQuotas(env),
  ]);
  // §F：内容对象回收与索引对账（依赖上面的配额/落桶回填完成后再跑）
  const blobsFixed = await reconcileBlobs(env);
  const blobGc = await cleanupBlobObjects(env);
  // 用户删除登记的传统路径键/分片对象清理（非内容寻址，不在上面的 blob GC 范围内）
  const userDeletedObjects = await cleanupUserDeletedObjects(env);
  // multipart abort 失败队列重试（带 upload_id）
  const multipartAborts = await cleanupMultipartAborts(env);
  // §H：挂载点目录行自愈（存量挂载点在首次列目录/管理页访问前也能被补齐）
  const mountFolders = await ensureAllMountFolders(Db.fromAny(env.DB));
  // 审计日志冷归档（未配置 AUDIT_BUCKET 或保留期 <= 0 时整体跳过，绝不先删后归档）
  const auditArchived = await archiveAuditLogs(env);
  return { released, cleaned, expired, reconciled, moveOrphansRepaired, blobsFixed, blobGc, userDeletedObjects, multipartAborts, mountFolders, auditArchived };
}
