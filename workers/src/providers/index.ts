// Provider 工厂：根据 storage_providers 配置构造实例
import type { StorageProvider } from '@shared/types';
import { Db, ProviderRepo } from '../db';
import { decryptSecret } from '../utils/crypto';
import type { Env } from '../types';
import { R2BindingProvider } from './r2-provider';
import { S3Provider } from './s3-provider';
import type { StorageProviderInterface } from './types';

/**
 * 获取 provider 实例。
 * - type=r2 且未配置 endpoint → 使用 R2 绑定（本地/生产无 S3 endpoint 场景）
 * - 其余 → S3 协议客户端（R2 S3 API / AWS S3 / Oracle）
 */
export async function getProvider(db: Db, provider: StorageProvider, env: Env): Promise<StorageProviderInterface> {
  // 解密密钥
  let accessKeyId = provider.accessKeyId;
  let secretAccessKey = provider.secretAccessKey;
  if (provider.accessKeyId.startsWith('enc:')) {
    accessKeyId = await decryptSecret(provider.accessKeyId.slice(4), env.ENCRYPTION_KEY);
  }
  if (provider.secretAccessKey.startsWith('enc:')) {
    secretAccessKey = await decryptSecret(provider.secretAccessKey.slice(4), env.ENCRYPTION_KEY);
  }

  const isBindingR2 =
    provider.type === 'r2' && (!provider.endpoint || provider.endpoint.startsWith('__binding__'));

  if (isBindingR2) {
    return new R2BindingProvider(env.R2, {
      name: provider.name,
      bucketName: provider.bucket,
    });
  }

  return new S3Provider({
    name: provider.name,
    bucket: provider.bucket,
    endpoint: provider.endpoint,
    region: provider.region,
    accessKeyId,
    secretAccessKey,
    publicDomain: provider.publicDomain,
  });
}

export async function getProviderForMount(db: Db, mountId: string, env: Env): Promise<StorageProviderInterface> {
  const mount = await getMountOrThrow(db, mountId);
  const provider = await ProviderRepo.getProviderById(db, mount.providerId);
  if (!provider) throw new Error('Provider not found');
  return getProvider(db, provider, env);
}

import { MountRepo } from '../db';
async function getMountOrThrow(db: Db, mountId: string) {
  const mount = await MountRepo.getMountById(db, mountId);
  if (!mount) throw new Error('Mount not found');
  return mount;
}

export { R2BindingProvider, S3Provider };
export type { StorageProviderInterface };
