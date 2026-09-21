// 存储池（§E）：写路径按策略选桶，读/删路径按文件自身 provider_id 定位。
// 池成员在 mount_providers；成员为空时回退 mounts.provider_id（单桶语义）。
import type { Mount, StorageProvider } from '@shared/types';
import { Db, MountProviderRepo, ProviderRepo, num } from '../../db';
import type { Env } from '../../shared/types';
import { ApiError } from '../../shared/errors';
import { getProvider } from './providers';
import type { StorageProviderInterface } from './types';

/** FNV-1a 32 位：稳定路径哈希（hash 策略的确定性路由，跨进程一致） */
function fnv1a(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 池成员（含权重）；表为空时回退主 provider 单成员 */
export async function listPoolMembers(db: Db, mount: Mount): Promise<Array<{ providerId: string; weight: number }>> {
  const members = await MountProviderRepo.listMembers(db, mount.id);
  if (members.length > 0) return members;
  return [{ providerId: mount.providerId, weight: 1 }];
}

/** 单成员 → 直接返回；多成员按 mount.poolStrategy 选桶（least_used 默认） */
async function chooseMemberId(db: Db, mount: Mount, targetPath: string, env: Env): Promise<string> {
  const members = await listPoolMembers(db, mount);
  if (members.length === 1) return members[0].providerId;

  if (mount.poolStrategy === 'hash') {
    return members[fnv1a(targetPath) % members.length].providerId;
  }

  if (mount.poolStrategy === 'round_robin') {
    const key = `pool:rr:${mount.id}`;
    const current = Number((await env.KV.get(key)) ?? '0') || 0;
    await env.KV.put(key, String(current + 1));
    return members[current % members.length].providerId;
  }

  // least_used：per-provider 已用量 / 权重，取最小；平局按 provider_id 升序（稳定）
  const scored: Array<{ providerId: string; ratio: number }> = [];
  for (const member of members) {
    const row = await db.first(
      `SELECT COALESCE(SUM(size), 0) AS s FROM file_metadata
       WHERE mount_id = ? AND type = 'file'
         AND (provider_id = ? OR (provider_id IS NULL AND ? = ?))`,
      [mount.id, member.providerId, member.providerId, mount.providerId]
    );
    scored.push({ providerId: member.providerId, ratio: (num(row?.s) + 1) / member.weight });
  }
  scored.sort((a, b) => (a.ratio !== b.ratio ? a.ratio - b.ratio : a.providerId.localeCompare(b.providerId)));
  return scored[0].providerId;
}

/**
 * 写路径选桶：返回 provider 配置行（调用方用它算对象键 pathPrefix + 实例化写入）。
 * 选中的 provider 行缺失或停用时回退挂载主 provider；两者都不可用才报错。
 */
export async function pickWriteProvider(db: Db, mount: Mount, targetPath: string, env: Env): Promise<StorageProvider> {
  const chosenId = await chooseMemberId(db, mount, targetPath, env);
  const row = (await ProviderRepo.getProviderById(db, chosenId)) ?? (await ProviderRepo.getProviderById(db, mount.providerId));
  if (!row) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  return row;
}

/** 读/删路径定位：文件实际落桶优先，缺失回退挂载主 provider */
export async function resolveFileProviderId(db: Db, file: { providerId?: string | null }, mount: Mount): Promise<string> {
  const providerId = file.providerId ?? mount.providerId;
  const row = await ProviderRepo.getProviderById(db, providerId);
  return row ? providerId : mount.providerId;
}

/** 读路径实例化：按文件落桶 provider 构造实例（池内文件分散时读路径与写路径解耦） */
export async function getProviderForFile(
  db: Db,
  file: { providerId?: string | null },
  mount: Mount,
  env: Env
): Promise<StorageProviderInterface> {
  const providerId = await resolveFileProviderId(db, file, mount);
  const row = await ProviderRepo.getProviderById(db, providerId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  return getProvider(db, row, env);
}
