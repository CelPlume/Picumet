// 存储提供商与挂载点仓库
import type { Mount, StorageProvider } from '@shared/types';
import { Db } from '../db';
import { mapProvider, mapMount, type Row } from '../row';
import { uuid } from '../../utils/crypto';

export const ProviderRepo = {
  async createProvider(db: Db, p: Omit<StorageProvider, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<StorageProvider> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO storage_providers (id, name, type, endpoint, region, bucket, access_key_id, secret_access_key, public_domain, upload_domain, path_prefix, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [id, p.name, p.type, p.endpoint, p.region, p.bucket, p.accessKeyId, p.secretAccessKey, p.publicDomain ?? null, p.uploadDomain ?? null, p.pathPrefix ?? '', now, now]
    );
    return (await this.getProviderById(db, id)) as StorageProvider;
  },
  async getProviderById(db: Db, id: string): Promise<StorageProvider | null> {
    const row = await db.first('SELECT * FROM storage_providers WHERE id = ?', [id]);
    return row ? mapProvider(row) : null;
  },
  async listProviders(db: Db): Promise<StorageProvider[]> {
    const rows = await db.all('SELECT * FROM storage_providers ORDER BY created_at ASC');
    return rows.map(mapProvider);
  },
  async updateProvider(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE storage_providers SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  async deleteProvider(db: Db, id: string): Promise<void> {
    await db.run('DELETE FROM storage_providers WHERE id = ?', [id]);
  },
};

export const MountRepo = {
  async createMount(db: Db, m: { providerId: string; mountPath: string; name: string; sortBy?: string; sortOrder?: string; priority?: number }): Promise<Mount> {
    const id = uuid();
    const now = Date.now();
    await db.run(
      `INSERT INTO mounts (id, provider_id, mount_path, name, sort_by, sort_order, priority, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [id, m.providerId, m.mountPath, m.name, m.sortBy ?? 'name', m.sortOrder ?? 'asc', m.priority ?? 0, now, now]
    );
    return (await this.getMountById(db, id)) as Mount;
  },
  async getMountById(db: Db, id: string): Promise<Mount | null> {
    const row = await db.first('SELECT * FROM mounts WHERE id = ?', [id]);
    return row ? mapMount(row) : null;
  },
  async listMounts(db: Db): Promise<Mount[]> {
    const rows = await db.all('SELECT * FROM mounts WHERE status = \'active\' ORDER BY priority DESC, mount_path ASC');
    return rows.map(mapMount);
  },
  async allMounts(db: Db): Promise<Mount[]> {
    const rows = await db.all('SELECT * FROM mounts ORDER BY priority DESC, mount_path ASC');
    return rows.map(mapMount);
  },
  /** 找到能包含该路径的挂载点（priority 高优先，同 priority 路径更深优先） */
  async findMountForPath(db: Db, canonicalPath: string): Promise<Mount | null> {
    const mounts = await this.listMounts(db);
    const candidates = mounts.filter((m) => {
      if (m.mountPath === '/') return true;
      return canonicalPath === m.mountPath || canonicalPath.startsWith(m.mountPath + '/');
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.mountPath.length - a.mountPath.length;
    });
    return candidates[0];
  },
  async updateMount(db: Db, id: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    await db.run(`UPDATE mounts SET ${sets}, updated_at = ? WHERE id = ?`, [...entries.map(([, v]) => v), Date.now(), id]);
  },
  async deleteMount(db: Db, id: string): Promise<void> {
    await db.run('DELETE FROM mounts WHERE id = ?', [id]);
  },
};

export type { Row };
