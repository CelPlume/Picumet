// 文件索引（标准/高级）与标准搜索端点：
// - 标准索引：本地元数据快速对账（补齐缺失父目录行），记录文件计数
// - 高级索引：底层对象存储（MockR2）vs D1 真实对账 → 产出 diff 快照
// - apply：removed 删行 + 扣配额；modified 覆盖 size/etag
// - 标准搜索：POST /api/files/search 严格按调用者权限过滤
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createTestContext, initSeeded, request, json, type TestContext } from './helpers';
import { Db } from '../src/db';
import { invalidateSettingsCache } from '../src/db/repos/system';
import { str } from '../src/db/row';

let ctx: TestContext;
let cookie = '';
let csrf = '';

interface PendingStats {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
}
interface PendingSnapshot {
  type: string;
  stats: PendingStats;
}

/** pending 为网络/持久化边界数据：收窄而非断言 */
function narrowPending(value: unknown): PendingSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  if (!('type' in value) || typeof value.type !== 'string') return null;
  if (!('stats' in value) || !value.stats || typeof value.stats !== 'object') return null;
  // stats 已确认是对象但编译器丢失索引签名：具名化为字典再逐字段校验数值
  const stats = { ...(value.stats as Record<string, unknown>) };
  const pick = (key: string): number => (typeof stats[key] === 'number' ? (stats[key] as number) : 0);
  return {
    type: value.type,
    stats: { added: pick('added'), removed: pick('removed'), modified: pick('modified'), unchanged: pick('unchanged') },
  };
}

async function adminSession(): Promise<{ cookie: string; csrf: string }> {
  const login = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' },
  });
  expect(login.status).toBe(200);
  const c = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const csrfRes = await request(ctx, '/api/auth/csrf-token', { cookie: c });
  const token = (await json<{ data: { token: string } }>(csrfRes)).data.token;
  return { cookie: c, csrf: token };
}

const dbOf = () => Db.fromSqlite(ctx.db);

async function buildIndex(type: 'standard' | 'advanced'): Promise<number> {
  const res = await request(ctx, '/api/admin/index/build', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { type },
  });
  return res.status;
}

async function indexStatus(): Promise<{
  running: boolean;
  lastRunAt: number | null;
  fileCount: number;
  pending: unknown;
}> {
  const res = await request(ctx, '/api/admin/index/status', { cookie });
  return (await json<{ data: { running: boolean; lastRunAt: number | null; fileCount: number; pending: unknown } }>(res)).data;
}

describe('文件索引（标准 / 高级）', () => {
  beforeAll(async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    const s = await adminSession();
    cookie = s.cookie;
    csrf = s.csrf;
  });

  beforeEach(async () => {
    await dbOf().query(`DELETE FROM system_settings WHERE key IN ('index_running','index_pending','index_last_run_at')`);
  invalidateSettingsCache();
  });

  it('标准索引：构建完成写入 pending，apply 后记录 lastRunAt 并清空 pending', async () => {
    expect(await buildIndex('standard')).toBe(202);
    const st = await indexStatus();
    expect(st.running).toBe(false);
    const pending = narrowPending(st.pending);
    expect(pending?.type).toBe('standard');
    expect(st.fileCount).toBeGreaterThan(0);

    const apply = await request(ctx, '/api/admin/index/apply', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(apply.status).toBe(200);
    const after = await indexStatus();
    expect(after.pending).toBeNull();
    expect(after.lastRunAt).toBeGreaterThan(0);
  });
  it('标准索引：一次 SQL 补齐嵌套父目录且重复构建幂等', async () => {
    const mount = await dbOf().first(`SELECT id FROM mounts WHERE mount_path = '/' LIMIT 1`);
    const admin = await dbOf().first(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
    expect(mount?.id).toBeTruthy();
    expect(admin?.id).toBeTruthy();
    const marker = crypto.randomUUID();
    const now = Date.now();
    await dbOf().query(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, size, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'file', 1, ?, ?, ?)`,
      [crypto.randomUUID(), String(mount!.id), `index:${marker}`, `/index-${marker}/nested`, 'payload.txt', String(admin!.id), now, now]
    );
    ctx.r2.putRaw(`index:${marker}`, new Uint8Array([0]), {});

    expect(await buildIndex('standard')).toBe(202);
    const first = await dbOf().all(
      `SELECT path, owner_id FROM file_metadata WHERE mount_id = ? AND type = 'folder' AND path IN (?, ?) ORDER BY path`,
      [String(mount!.id), `/index-${marker}`, `/index-${marker}/nested`]
    );
    expect(first.map((row) => String(row.path))).toEqual([`/index-${marker}`, `/index-${marker}/nested`]);
    expect(first.every((row) => String(row.owner_id) === String(admin!.id))).toBe(true);

    expect(await buildIndex('standard')).toBe(202);
    const second = await dbOf().first(
      `SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ? AND type = 'folder' AND path IN (?, ?)`,
      [String(mount!.id), `/index-${marker}`, `/index-${marker}/nested`]
    );
    expect(Number(second?.c)).toBe(2);
  });

  it('高级索引：存储与 D1 一致时不产生 removed/modified', async () => {
    expect(await buildIndex('advanced')).toBe(202);
    const st = await indexStatus();
    expect(st.running).toBe(false);
    const pending = narrowPending(st.pending);
    expect(pending?.type).toBe('advanced');
    expect(pending?.stats.removed).toBe(0);
    expect(pending?.stats.modified).toBe(0);
    expect(pending?.stats.unchanged).toBeGreaterThan(0);
  });

  it('高级索引：存储删掉对象 → removed 检出；apply 后行删除并扣配额', async () => {
    const row = await dbOf().first(`SELECT id, object_key, physical_key, size, owner_id FROM file_metadata WHERE type = 'file' LIMIT 1`);
    expect(row).toBeTruthy();
    const phys = str(row!.physical_key) || str(row!.object_key) || '';
    expect(phys).not.toBe('');
    const ownerId = str(row!.owner_id) ?? '';
    const size = Number(row!.size);
    const quotaBefore = await dbOf().first('SELECT used_storage, used_files FROM user_quotas WHERE user_id = ?', [ownerId]);

    await ctx.r2.delete(phys);

    expect(await buildIndex('advanced')).toBe(202);
    const st = await indexStatus();
    expect(narrowPending(st.pending)?.stats.removed ?? 0).toBeGreaterThanOrEqual(1);

    const apply = await request(ctx, '/api/admin/index/apply', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(apply.status).toBe(200);

    const gone = await dbOf().first('SELECT id FROM file_metadata WHERE id = ?', [str(row!.id)]);
    expect(gone ?? null).toBeNull();
    const quotaAfter = await dbOf().first('SELECT used_storage, used_files FROM user_quotas WHERE user_id = ?', [ownerId]);
    expect(Number(quotaAfter!.used_files)).toBe(Number(quotaBefore!.used_files) - 1);
    expect(Number(quotaAfter!.used_storage)).toBe(Math.max(0, Number(quotaBefore!.used_storage) - size));
  });

  it('标准搜索：POST /api/files/search 命中文件；空查询 400', async () => {
    const res = await request(ctx, '/api/files/search', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { query: '图', scope: 'all', page: 1, limit: 50 },
    });
    expect(res.status).toBe(200);
    const data = await json<{ data: { items: unknown[]; total: number } }>(res);
    expect(data.data.total).toBeGreaterThan(0);

    const bad = await request(ctx, '/api/files/search', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { query: '' },
    });
    expect(bad.status).toBe(400);
  });

  it('无 pending 时 apply → 409', async () => {
    const apply = await request(ctx, '/api/admin/index/apply', {
      method: 'POST',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(apply.status).toBe(409);
  });
});