// 目录/权限版本的安全读取：revision 只服务于缓存失效与条件请求（ETag），
// **不是**权限或正确性依据。因此读取失败（例如存量库尚未补齐 directory_states /
// permission_revisions 表）必须降级为常量版本，绝不能让文件列表这条核心路径 500。
//
// 写路径（bumpRevisions / bump）保持严格：版本推进必须与元数据写入同批，失败即整批回滚。
import type { Db } from '../../db';
import { DirectoryStateRepo, PermissionRevisionRepo } from '../../db';

/** 表缺失/读取异常只告警一次，避免每个请求刷屏 */
let warned = false;
function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn('[revision] 版本表不可读，已降级为常量版本（请确认迁移已应用到该库）:', err instanceof Error ? err.message : String(err));
}

/** 目录 revision：读取失败返回 1（等价于「尚未记录版本」） */
export async function safeDirectoryRevision(db: Db, mountId: string, path: string): Promise<number> {
  try {
    const state = await DirectoryStateRepo.get(db, mountId, path);
    return state?.revision ?? 1;
  } catch (err) {
    warnOnce(err);
    return 1;
  }
}

/** 权限 revision：读取失败返回 1 */
export async function safePermissionRevision(db: Db): Promise<number> {
  try {
    return await PermissionRevisionRepo.get(db);
  } catch (err) {
    warnOnce(err);
    return 1;
  }
}
