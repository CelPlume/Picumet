// 文件索引（系统设置 → 文件索引）：标准（快速本地对账）+ 高级（底层对象存储 vs D1 真实对账）。
// 高级索引为后台异步任务：遍历所选挂载点底层 R2/S3 对象列表，与 file_metadata 比对，
// 产出「索引前后差异」diff 快照（+ 新增 / - 缺失 / ! 变动），管理员确认后增量应用。
// 状态存 system_settings：index_running（'1'/'0'）、index_pending（JSON）、index_last_run_at（ms 字符串）。
import { Hono } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import { Db, FileRepo, MountRepo, SettingsRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { getProviderForMount } from '../storage/providers';
import { num, str } from '../../db/row';
import type { StorageProviderInterface } from '../storage/types';

export const adminIndexRoutes = new Hono<AppBindings>();

const RUNNING_KEY = 'index_running';
const PENDING_KEY = 'index_pending';
const LAST_RUN_KEY = 'index_last_run_at';
function guessMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mkv': return 'video/x-matroska';
    case 'mov': return 'video/quicktime';
    case 'pdf': return 'application/pdf';
    case 'txt': return 'text/plain';
    case 'json': return 'application/json';
    case 'md': return 'text/markdown';
    case 'html': return 'text/html';
    case 'css': return 'text/css';
    case 'js': return 'application/javascript';
    case 'zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

export interface IndexDiffEntry {
  path: string;
  name: string;
  type: 'added' | 'removed' | 'modified';
  size?: number;
  prevSize?: number;
  /** modified 时记录文件行 id（apply 用） */
  fileId?: string;
  ownerId?: string;
}

export interface IndexPending {
  jobId: string;
  type: 'standard' | 'advanced';
  startedAt: number;
  completedAt: number;
  stats: { added: number; removed: number; modified: number; unchanged: number; total: number };
  diffSnippet: string;
  entries: IndexDiffEntry[];
}

export interface IndexStatus {
  running: boolean;
  lastRunAt: number | null;
  fileCount: number;
  pending: IndexPending | null;
}

async function fileCount(db: Db): Promise<number> {
  const row = await db.first('SELECT COUNT(*) AS c FROM file_metadata');
  return num(row?.c);
}

export async function getIndexStatus(db: Db): Promise<IndexStatus> {
  const running = (await SettingsRepo.get(db, RUNNING_KEY)) === '1';
  const lastRaw = await SettingsRepo.get(db, LAST_RUN_KEY);
  const lastRunAt = lastRaw == null || lastRaw === 'null' ? null : Number(lastRaw) || null;
  const rawPending = await SettingsRepo.get(db, PENDING_KEY);
  let pending: IndexPending | null = null;
  if (rawPending && rawPending !== 'null') {
    try {
      pending = JSON.parse(rawPending) as IndexPending;
    } catch {
      pending = null;
    }
  }
  return { running, lastRunAt, fileCount: await fileCount(db), pending };
}

/** 原生 diff 代码块渲染：+ 新增（绿）、- 缺失（红）、! 变动（橙）、空格一致（灰）。 */
function renderDiffSnippet(entries: IndexDiffEntry[], unchanged: number): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.type === 'added') lines.push(`+ ${e.path}`);
    else if (e.type === 'removed') lines.push(`- ${e.path}`);
    else if (e.type === 'modified') {
      lines.push(`! ${e.path} (${e.prevSize ?? 0} → ${e.size ?? 0} 字节)`);
    }
  }
  // 一致项过多时只汇总，避免 diff 快照体积爆炸
  const UNCHANGED_CAP = 200;
  if (unchanged > 0 && unchanged <= UNCHANGED_CAP) {
    lines.push('');
    lines.push(`# ${unchanged} 个一致项`);
  } else if (unchanged > UNCHANGED_CAP) {
    lines.push('');
    lines.push(`# ${unchanged} 个一致项（超出展示上限，仅汇总）`);
  }
  return lines.join('\n');
}

/**
 * 标准索引：本地快速对账（零远端扫描）。
 * - 清理悬空父目录：文件行 path 指向不存在的父目录行时，补齐父目录行（幂等）。
 * - 重算文件计数并记录 last_run_at。
 */
async function runStandardIndex(db: Db): Promise<IndexPending> {
  const startedAt = Date.now();
  // 补齐缺失的父目录行（遍历文件行 path 的每一级，缺失即补）——保证索引树完整
  const fileRows = await db.all(`SELECT DISTINCT path, mount_id FROM file_metadata WHERE type = 'file'`);
  const dirs = new Map<string, Set<string>>();
  for (const r of fileRows) {
    const p = str(r.path) ?? '';
    if (!p || p === '/') continue;
    const segs = p.split('/').filter(Boolean);
    let acc = '';
    for (const s of segs) {
      acc = acc ? `${acc}/${s}` : `/${s}`;
      if (!dirs.has(String(r.mount_id))) dirs.set(String(r.mount_id), new Set());
      dirs.get(String(r.mount_id))!.add(acc);
    }
  }
  for (const [mountId, paths] of dirs) {
    for (const dirPath of paths) {
      const exist = await db.first(
        `SELECT id FROM file_metadata WHERE mount_id = ? AND type = 'folder' AND path = ?`,
        [mountId, dirPath]
      );
      if (!exist) {
        const name = dirPath.split('/').filter(Boolean).pop() ?? dirPath;
        await db.run(
          `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, visibility, review_status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'folder', 0, ?, 'private', 'approved', 0, ?, ?)`,
          [crypto.randomUUID(), mountId, `folder:${dirPath}`, dirPath, name, 'system', Date.now(), Date.now()]
        );
      }
    }
  }
  const completedAt = Date.now();
  const total = await fileCount(db);
  const pending: IndexPending = {
    jobId: crypto.randomUUID(),
    type: 'standard',
    startedAt,
    completedAt,
    stats: { added: 0, removed: 0, modified: 0, unchanged: total, total },
    diffSnippet: `# 标准索引完成：${total} 个文件（本地元数据对账，未扫描远端存储）`,
    entries: [],
  };
  return pending;
}

/** 高级索引：底层对象存储 vs D1 真实对账（后台任务）。 */
async function runAdvancedIndex(db: Db, env: Env): Promise<IndexPending> {
  const startedAt = Date.now();
  const mounts = await MountRepo.allMounts(db);
  const fileRows = await db.all(
    `SELECT id, mount_id, object_key, path, name, owner_id, size, etag, physical_key, blob_hash, type FROM file_metadata WHERE type = 'file'`
  );

  const referenced = new Set<string>();
  const byPhysKey = new Map<string, Array<{ fileId: string; size: number; etag?: string }>>();
  for (const r of fileRows) {
    const phys = str(r.physical_key) ?? str(r.object_key) ?? '';
    if (!phys) continue;
    referenced.add(phys);
    if (!byPhysKey.has(phys)) byPhysKey.set(phys, []);
    byPhysKey.get(phys)!.push({ fileId: str(r.id)!, size: num(r.size), etag: str(r.etag) });
  }

  // 按 provider 缓存对象清单（多个挂载可共用同一 provider/桶）
  const listingByProvider = new Map<string, Map<string, number>>();
  for (const mount of mounts) {
    const provider = await getProviderForMount(db, mount.id, env).catch(() => null);
    if (!provider) continue;
    const cacheKey = `${provider.type}:${provider.bucketName}`;
    let keySize = listingByProvider.get(cacheKey);
    if (!keySize) {
      keySize = await listAllObjects(provider);
      listingByProvider.set(cacheKey, keySize);
    }
    // 本挂载文件行的物理键若不在对象清单 → 缺失（removed）；size 不符 → modified
    // 注：byPhysKey 与 listingByProvider 为全局集合；不同挂载的物理键天然不冲突（键含 mount 路径前缀/哈希）。
  }

  // 缺失/变动判定
  const entries: IndexDiffEntry[] = [];
  for (const [phys, refs] of byPhysKey) {
    const objSize = listingHas(listingByProvider, phys);
    for (const ref of refs) {
      const row = fileRows.find((x) => str(x.id) === ref.fileId);
      const vpath =
        row && str(row.path) && str(row.name)
          ? `${str(row.path) === '/' ? '' : str(row.path)}/${str(row.name)}`
          : phys;
      if (objSize === undefined) {
        entries.push({
          type: 'removed',
          fileId: ref.fileId,
          ownerId: str(row?.owner_id),
          path: vpath,
          name: str(row?.name) ?? '',
          size: ref.size,
        });
      } else if (objSize !== ref.size) {
        entries.push({
          type: 'modified',
          fileId: ref.fileId,
          path: vpath,
          name: str(row?.name) ?? '',
          prevSize: ref.size,
          size: objSize,
        });
      }
    }
  }

  // 对象清单中未被任何文件引用的键 → 新增（孤儿/未索引对象）
  for (const keySize of listingByProvider.values()) {
    for (const [phys, size] of keySize) {
      if (referenced.has(phys)) continue;
      // 暂存/临时对象与文件夹占位不参与统计
      if (phys.includes('picumet:staging/')) continue;
      entries.push({ type: 'added', path: phys, name: phys.split('/').pop() ?? phys, size });
    }
  }

  const added = entries.filter((e) => e.type === 'added').length;
  const removed = entries.filter((e) => e.type === 'removed').length;
  const modified = entries.filter((e) => e.type === 'modified').length;
  const unchanged = Math.max(0, fileRows.length - removed - modified);
  const completedAt = Date.now();

  const pending: IndexPending = {
    jobId: crypto.randomUUID(),
    type: 'advanced',
    startedAt,
    completedAt,
    stats: { added, removed, modified, unchanged, total: fileRows.length },
    diffSnippet: renderDiffSnippet(entries, unchanged),
    entries,
  };
  return pending;
}

/** 遍历 provider 全部对象：key → size（分页拉取） */
async function listAllObjects(provider: StorageProviderInterface): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let token: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const res = await provider.listObjects('', { continuationToken: token });
    for (const k of res.keys) out.set(k.key, k.size);
    if (!res.truncated || !res.continuationToken) break;
    token = res.continuationToken;
  }
  return out;
}

/** 对象清单里是否含物理键（跨 provider 缓存合并判断） */
function listingHas(listingByProvider: Map<string, Map<string, number>>, key: string): number | undefined {
  for (const m of listingByProvider.values()) {
    if (m.has(key)) return m.get(key);
  }
  return undefined;
}

// ============ 路由 ============

/** 启动后台构建；返回立即，构建异步执行（waitUntil），完成后写入 pending。 */
adminIndexRoutes.post('/build', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const type = body?.type === 'advanced' ? 'advanced' : 'standard';
  const running = (await SettingsRepo.get(db, RUNNING_KEY)) === '1';
  if (running) throw new ApiError(409, 'INDEX_RUNNING', '已有索引任务在构建中');
  if ((await SettingsRepo.get(db, PENDING_KEY)) && type === 'advanced') {
    // 存在未确认的 advanced diff：清空旧的，允许重新扫描
    await SettingsRepo.set(db, PENDING_KEY, null);
  }
  await SettingsRepo.set(db, RUNNING_KEY, '1');
  const jobId = crypto.randomUUID();
  const scanTask = (async () => {
    try {
      const pending =
        type === 'advanced' ? await runAdvancedIndex(db, c.env as Env) : await runStandardIndex(db);
      pending.jobId = jobId;
      await SettingsRepo.set(db, PENDING_KEY, JSON.stringify(pending));
    } catch (err) {
      console.error('[index] build failed', err);
    } finally {
      await SettingsRepo.set(db, RUNNING_KEY, '0');
    }
  })();
  // 生产（waitUntil 可用）后台异步；测试环境（无 waitUntil）同步执行便于断言
  const ectx = c.executionCtx as { waitUntil?: (p: Promise<void>) => void } | undefined;
  const background = typeof ectx?.waitUntil === 'function' ? ectx.waitUntil.bind(ectx) : null;
  if (background) {
    background(scanTask);
  } else {
    await scanTask;
  }
  return ok(c, { jobId, status: 'running', type }, undefined, 202);
});

/** 查询索引状态（前端轮询用） */
adminIndexRoutes.get('/status', async (c) => {
  const db = getDb(c);
  return ok(c, await getIndexStatus(db));
});

/** 确认并增量应用 pending diff：removed 删行+扣配额，modified 覆盖 size/etag。 */
adminIndexRoutes.post('/apply', async (c) => {
  const db = getDb(c);
  const rawPending = await SettingsRepo.get(db, PENDING_KEY);
  if (!rawPending) throw new ApiError(409, 'NO_PENDING_INDEX', '没有待确认的索引差异');
  const pending = JSON.parse(rawPending) as IndexPending;

  const adminUser = await db.first(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  const ownerId = adminUser && adminUser.id ? String(adminUser.id) : 'admin';
  const mounts = await MountRepo.listMounts(db);
  const rootMount = mounts.find((m) => m.mountPath === '/') ?? mounts[0];
  const mountId = rootMount?.id ?? 'default';
  const providerId = rootMount?.providerId;

  await db.transaction(async (tx) => {
    for (const e of pending.entries) {
      if (e.type === 'removed' && e.fileId) {
        await tx.query(`DELETE FROM file_metadata WHERE id = ?`, [e.fileId]);
        if (e.ownerId && (e.size ?? 0) > 0) {
          await tx.query(
            `UPDATE user_quotas SET used_storage = MAX(0, used_storage - ?), used_files = MAX(0, used_files - ?),
             updated_at = ? WHERE user_id = ?`,
            [e.size ?? 0, 1, Date.now(), e.ownerId]
          );
        }
      } else if (e.type === 'modified' && e.fileId) {
        await tx.query(`UPDATE file_metadata SET size = ?, etag = ?, updated_at = ? WHERE id = ?`, [
          e.size ?? 0,
          e.size != null ? String(e.size) : null,
          Date.now(),
          e.fileId,
        ]);
      } else if (e.type === 'added' && e.path) {
        const rel = e.path.replace(/^\/+/, '');
        const segs = rel.split('/');
        const fileName = segs.pop() ?? e.name;
        const parentPath = segs.length === 0 ? '/' : `/${segs.join('/')}`;
        const mimeType = guessMimeType(fileName);
        const fileId = crypto.randomUUID();
        const now = Date.now();

        let currPath = '';
        for (const seg of segs) {
          currPath = `${currPath}/${seg}`;
          const folderObjKey = `folder:${currPath.slice(1)}`;
          await tx.query(
            `INSERT OR IGNORE INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, visibility, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'folder', 0, ?, 'private', ?, ?)`,
            [crypto.randomUUID(), mountId, folderObjKey, currPath, seg, ownerId, now, now]
          );
        }

        const insertRes = await tx.query(
          `INSERT OR IGNORE INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, owner_id, visibility, provider_id, physical_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, 'private', ?, ?, ?, ?)`,
          [fileId, mountId, rel, parentPath, fileName, mimeType, e.size ?? 0, ownerId, providerId, rel, now, now]
        );

        if (insertRes.changes > 0) {
          await tx.query(
            `UPDATE user_quotas SET used_storage = used_storage + ?, used_files = used_files + 1, updated_at = ? WHERE user_id = ?`,
            [e.size ?? 0, now, ownerId]
          );
        }
      }
    }
  });

  await SettingsRepo.set(db, LAST_RUN_KEY, String(Date.now()));
  await SettingsRepo.set(db, PENDING_KEY, null);
  return ok(c, {
    message: '索引已更新',
    applied: {
      added: pending.stats.added,
      removed: pending.stats.removed,
      modified: pending.stats.modified,
    },
  });
});

/** 放弃本次 diff（不应用） */
adminIndexRoutes.post('/dismiss', async (c) => {
  const db = getDb(c);
  await SettingsRepo.set(db, PENDING_KEY, null);
  return ok(c, { message: '已放弃本次索引差异' });
});
