// 删除用户会遗留传统路径键/分片对象（blob_hash IS NULL，没有内容索引）。
// 覆盖：删除用户前把落桶信息登记进 orphan_objects（reason='user_deleted'）；scheduled 任务
// cleanupUserDeletedObjects 消费队列并删除物理对象、标 cleaned=1；provider_id 缺失回退挂载锚点；
// 内容寻址行不进该队列；runScheduledTasks 纳入结果键。
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  createTestContext,
  initSeeded,
  request,
  registerAndLogin,
  getCsrf,
  type TestContext,
} from './helpers';
import { cleanupUserDeletedObjects, runScheduledTasks } from '../src/services/cleanup';
import { R2BindingProvider } from '../src/services/storage/r2';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

interface OrphanRow {
  id: string;
  mount_id: string;
  object_key: string;
  reason: string | null;
  provider_id: string | null;
  cleaned: number;
  error: string | null;
}

interface CountRow {
  c: number;
}

interface IdRow {
  id: string;
  provider_id: string | null;
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'orphan_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'orphan_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'orphan_admin', password: 'password123' },
  });
  adminCookie = `auth_token=${(relogin.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 测试库直读：列集由本函数的 SQL 固定 */
function rootMount(): IdRow {
  const row = ctx.db.prepare(`SELECT id, provider_id FROM mounts WHERE mount_path = '/'`).get() as IdRow | undefined;
  if (!row) throw new Error('root mount missing');
  return row;
}

/** 构造传统路径键行（blob_hash 为空、物理键 = 虚拟键）并写入独占对象 */
function insertLegacyRow(userId: string, name: string, content: string, withProvider: boolean): string {
  const mount = rootMount();
  const now = Date.now();
  const bytes = new TextEncoder().encode(content);
  ctx.db
    .prepare(
      `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, owner_id, provider_id,
        physical_key, blob_hash, created_at, updated_at)
       VALUES (?, ?, ?, '/', ?, 'file', 'text/plain', ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(
      `legacy-${name}`,
      mount.id,
      name,
      name,
      bytes.byteLength,
      userId,
      withProvider ? mount.provider_id : null,
      name,
      now,
      now
    );
  ctx.r2.putRaw(name, bytes, {});
  return name;
}

function orphanRows(): OrphanRow[] {
  const rows = ctx.db
    .prepare(`SELECT id, mount_id, object_key, reason, provider_id, cleaned, error FROM orphan_objects ORDER BY object_key`)
    .all();
  return rows.map((r) => ({
    id: String(r.id),
    mount_id: String(r.mount_id),
    object_key: String(r.object_key),
    reason: r.reason == null ? null : String(r.reason),
    provider_id: r.provider_id == null ? null : String(r.provider_id),
    cleaned: Number(r.cleaned),
    error: r.error == null ? null : String(r.error),
  }));
}

function userFileCount(userId: string): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM file_metadata WHERE owner_id = ?').get(userId) as
    | CountRow
    | undefined;
  return Number(row?.c ?? 0);
}

describe('用户删除对象清理队列', () => {
  it('删用户登记传统对象 → 调度任务消费并删除、标 cleaned', async () => {
    const victim = await registerAndLogin(ctx, 'orphan_victim');
    const legacyWithProvider = insertLegacyRow(victim.userId, 'legacy-a.bin', 'legacy-bytes-a', true);
    // provider_id 缺失（池化前存量行）→ 消费时回退挂载锚点
    const legacyNoProvider = insertLegacyRow(victim.userId, 'legacy-b.bin', 'legacy-bytes-b', false);
    // 内容寻址行不属于本队列（由 blob GC 负责）：落一条带 blob_hash 的行确认被过滤
    const mount = rootMount();
    ctx.db
      .prepare(
        `INSERT INTO file_metadata (id, mount_id, object_key, path, name, type, mime_type, size, owner_id, provider_id,
          physical_key, blob_hash, created_at, updated_at)
         VALUES ('addressed-victim', ?, 'addressed.bin', '/', 'addressed.bin', 'file', 'text/plain', 4, ?, ?, 'addressed.bin', 'deadbeef', ?, ?)`
      )
      .run(mount.id, victim.userId, mount.provider_id, Date.now(), Date.now());
    expect(await ctx.r2.head(legacyWithProvider)).not.toBeNull();
    expect(await ctx.r2.head(legacyNoProvider)).not.toBeNull();

    const res = await request(ctx, `/api/admin/users/${victim.userId}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
    });
    expect(res.status).toBe(200);

    // 文件行已随用户级联删除（对象此时仍在桶里）
    expect(userFileCount(victim.userId)).toBe(0);
    expect(await ctx.r2.head(legacyWithProvider)).not.toBeNull();
    expect(await ctx.r2.head(legacyNoProvider)).not.toBeNull();

    // 两条传统对象入库待清理，内容寻址行不在此队列
    const queued = orphanRows();
    expect(queued.length).toBe(2);
    expect(queued.map((r) => r.object_key).sort()).toEqual([legacyNoProvider, legacyWithProvider].sort());
    for (const row of queued) {
      expect(row.reason).toBe('user_deleted');
      expect(row.cleaned).toBe(0);
      expect(row.mount_id).toBe(mount.id);
    }
    expect(queued.find((r) => r.object_key === legacyWithProvider)?.provider_id).toBe(mount.provider_id);
    expect(queued.find((r) => r.object_key === legacyNoProvider)?.provider_id).toBeNull();

    // 调度任务消费：两对象删除、全部 cleaned=1（含 provider_id 缺失回退挂载锚点的那条）
    expect(await cleanupUserDeletedObjects(ctx.env)).toBe(2);
    expect(await ctx.r2.head(legacyWithProvider)).toBeNull();
    expect(await ctx.r2.head(legacyNoProvider)).toBeNull();
    expect(orphanRows().every((r) => r.cleaned === 1 && r.error === null)).toBe(true);
    // 队列已空：重复执行不再消费
    expect(await cleanupUserDeletedObjects(ctx.env)).toBe(0);
  });

  it('runScheduledTasks 纳入 userDeletedObjects 结果键', async () => {
    const key = 'scheduled-legacy.bin';
    const victim = await registerAndLogin(ctx, 'orphan_victim2');
    insertLegacyRow(victim.userId, key, 'scheduled-bytes', true);
    const res = await request(ctx, `/api/admin/users/${victim.userId}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
    });
    expect(res.status).toBe(200);
    expect(await ctx.r2.head(key)).not.toBeNull();

    const result = await runScheduledTasks(ctx.env);
    expect(result.userDeletedObjects).toBe(1);
    expect(await ctx.r2.head(key)).toBeNull();
  });

  it('删除失败：保留 cleaned=0 并记录 error，恢复后重试成功', async () => {
    const key = 'retry-legacy.bin';
    const victim = await registerAndLogin(ctx, 'orphan_retry');
    insertLegacyRow(victim.userId, key, 'retry-bytes', true);
    const res = await request(ctx, `/api/admin/users/${victim.userId}`, {
      method: 'DELETE',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
    });
    expect(res.status).toBe(200);

    vi.spyOn(R2BindingProvider.prototype, 'deleteObject').mockRejectedValue(new Error('storage unavailable'));
    expect(await cleanupUserDeletedObjects(ctx.env)).toBe(0);
    const failed = orphanRows().find((r) => r.object_key === key);
    expect(failed?.cleaned).toBe(0);
    expect(failed?.error).toBe('storage unavailable');
    expect(await ctx.r2.head(key)).not.toBeNull();

    vi.restoreAllMocks();
    expect(await cleanupUserDeletedObjects(ctx.env)).toBe(1);
    expect(await ctx.r2.head(key)).toBeNull();
    expect(orphanRows().find((r) => r.object_key === key)?.cleaned).toBe(1);
  });
});
