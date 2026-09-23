// 仪表盘聚合（§26）：/admin/dashboard 与 /admin/stats 新契约（stats 七项 + mounts 主/备用桶关系）、
// 挂载点 capacityBytes 持久化往返（POST/PUT/GET）与参数校验、totalCapacity 求和与 null 兜底
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, getCsrf, registerAndLogin, type TestContext } from './helpers';
import { Db, FileRepo } from '../src/db';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';
let adminId = '';
let primaryProviderId = '';
let standbyProviderId = '';
let poolMountId = '';
let rootMountId = '';

interface DashboardStats {
  users: { total: number; active: number };
  userRoles: { admin: number; user: number; guest: number };
  files: number;
  providers: number;
  activeMounts: number;
  usedSpace: number;
  totalCapacity: number | null;
}
interface DashboardMountRow {
  id: string;
  name: string;
  mountPath: string;
  status: string;
  capacityBytes: number | null;
  usedSpace: number;
  fileCount: number;
  provider: { id: string; name: string; bucket: string };
  standbys: Array<{ id: string; name: string; bucket: string; weight: number }>;
}
interface DashboardPayload {
  stats: DashboardStats;
  mounts: DashboardMountRow[];
  recentActivity: unknown[];
  requests24h?: number;
}
interface Envelope {
  data: DashboardPayload;
}
interface ErrorBody {
  error: { code: string; message: string };
}

const BASE_FILES = 2; // 种子：README.md + hello.txt（文件夹行不计）

async function getDashboard(): Promise<DashboardPayload> {
  return (await json<Envelope>(await request(ctx, '/api/admin/dashboard', { cookie: adminCookie }))).data;
}

async function getStats(): Promise<DashboardPayload> {
  return (await json<Envelope>(await request(ctx, '/api/admin/stats', { cookie: adminCookie }))).data;
}

/** 直查库的文件基线（type='file' 的数量与占用），避免把种子内容字节数硬编码进断言 */
function dbFileStats(): { files: number; usedSpace: number } {
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM file_metadata WHERE type = 'file'`)
    .get() as { c: number; s: number };
  return { files: Number(row.c), usedSpace: Number(row.s) };
}

async function createProvider(name: string, bucket: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name, bucket },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { provider: { id: string } } }>(res)).data.provider.id;
}

async function seedFile(
  mountId: string,
  name: string,
  size: number,
  type: 'file' | 'folder' = 'file',
  providerId?: string
): Promise<void> {
  const db = Db.fromSqlite(ctx.db);
  await FileRepo.createFile(db, {
    mountId,
    objectKey: `${mountId}:${name}`,
    path: '/seeded',
    name,
    type,
    size: type === 'file' ? size : 0,
    ownerId: adminId,
    providerId,
  });
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);

  // 种子管理员（dev 默认 admin/admin123456）
  const login = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' },
  });
  expect(login.status).toBe(200);
  const loginData = (await json<{ data: { user: { id: string } } }>(login)).data;
  adminId = loginData.user.id;
  adminCookie = (login.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[0] ?? '';
  adminCsrf = await getCsrf(ctx, adminCookie);

  // 补一位 guest 用户，验证角色分组（缺的角色补 0 由 guest=1 之外的断言覆盖）
  await registerAndLogin(ctx, 'dash_guest');
  ctx.db.exec(`UPDATE users SET role = 'guest' WHERE username = 'dash_guest'`);

  // 主 provider = 种子的本地存储
  const provRes = await request(ctx, '/api/admin/storage/providers', { cookie: adminCookie });
  const providers = (await json<{ data: { providers: Array<{ id: string; name: string; bucket: string }> } }>(provRes)).data.providers;
  primaryProviderId = providers.find((p) => p.name === '本地存储')!.id;
  rootMountId = (await getDashboard()).mounts.find((m) => m.mountPath === '/')!.id;
});

describe('baseline：种子态的 stats 与 null 容量兜底', () => {
  it('stats 七项聚合与挂载点关系数组符合契约', async () => {
    const data = await getDashboard();
    const base = dbFileStats();

    expect(data.stats.users).toEqual({ total: 3, active: 3 }); // admin + demo + dash_guest
    expect(data.stats.userRoles).toEqual({ admin: 1, user: 1, guest: 1 });
    expect(data.stats.files).toBe(base.files);
    expect(data.stats.files).toBe(BASE_FILES);
    expect(data.stats.usedSpace).toBe(base.usedSpace);
    expect(data.stats.providers).toBe(1);
    expect(data.stats.activeMounts).toBe(1);
    expect(data.stats.totalCapacity).toBeNull(); // 全部挂载点未设置容量

    // 顶层键：dashboard 保留 requests24h；buckets = 桶泳道树（活跃挂载点图/挂载点视图共用）
    expect(Object.keys(data).sort()).toEqual(['buckets', 'mounts', 'recentActivity', 'requests24h', 'stats']);
    expect(Object.keys(data.stats).sort()).toEqual([
      'activeMounts', 'files', 'providers', 'totalCapacity', 'usedSpace', 'userRoles', 'users',
    ]);
    expect(typeof data.requests24h).toBe('number');
    expect(Array.isArray(data.recentActivity)).toBe(true);

    // mounts：根挂载点（主桶关系、未设置容量、无备用桶）
    expect(data.mounts).toHaveLength(1);
    const root = data.mounts[0];
    expect(root.name).toBe('根存储');
    expect(root.mountPath).toBe('/');
    expect(root.status).toBe('active');
    expect(root.capacityBytes).toBeNull();
    expect(root.usedSpace).toBe(base.usedSpace);
    expect(root.fileCount).toBe(BASE_FILES);
    expect(root.provider.id).toBe(primaryProviderId);
    expect(root.provider.name).toBe('本地存储');
    expect(root.provider.bucket).toBe('picumet-storage');
    expect(root.standbys).toEqual([]);
  });

  it('/stats 输出同一契约但不带 requests24h', async () => {
    const data = await getStats();
    expect(Object.keys(data).sort()).toEqual(['buckets', 'mounts', 'recentActivity', 'stats']);
    expect(Object.keys(data.stats).sort()).toEqual([
      'activeMounts', 'files', 'providers', 'totalCapacity', 'usedSpace', 'userRoles', 'users',
    ]);
    expect(data.stats.userRoles).toEqual({ admin: 1, user: 1, guest: 1 });
  });
});

describe('挂载点容量与池关系（1 主桶 + 1 备用桶成员）', () => {
  it('POST /mounts 持久化 capacityBytes 并在列表回显', async () => {
    standbyProviderId = await createProvider('备用桶', 'picumet-standby');

    const res = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: {
        providerId: standbyProviderId,
        mountPath: '/pool',
        name: '池挂载',
        capacityBytes: 1024,
        // §31：备用由显式标记决定（本地存储标为备用），主桶 = 备用桶
        poolMembers: [{ providerId: standbyProviderId }, { providerId: primaryProviderId, standby: true }],
      },
    });
    expect(res.status).toBe(201);
    const mount = (await json<{ data: { mount: DashboardMountRow } }>(res)).data.mount;
    poolMountId = mount.id;
    expect(mount.capacityBytes).toBe(1024);

    // 落库验证
    const row = ctx.db.prepare('SELECT capacity_bytes FROM mounts WHERE id = ?').get(poolMountId) as
      | { capacity_bytes: number | null }
      | undefined;
    expect(row?.capacity_bytes).toBe(1024);

    // GET /api/admin/mounts 行带 capacityBytes
    const list = (await json<{ data: { mounts: DashboardMountRow[] } }>(
      await request(ctx, '/api/admin/mounts', { cookie: adminCookie })
    )).data.mounts;
    const pool = list.find((m) => m.id === poolMountId)!;
    expect(pool.capacityBytes).toBe(1024);
    const rootRow = list.find((m) => m.mountPath === '/')!;
    expect(rootRow.capacityBytes).toBeNull();
  });

  it('dashboard：容量求和、备用桶关系与每挂载用量（文件夹行不计）', async () => {
    const before = await getDashboard();

    await seedFile(poolMountId, 'a1.png', 100);
    await seedFile(poolMountId, 'a2.png', 200);
    await seedFile(poolMountId, 'a3.png', 300);
    await seedFile(poolMountId, 'empty-dir', 0, 'folder'); // 不计入 files/usedSpace
    await seedFile(rootMountId, 'b1.png', 50);

    const data = await getDashboard();

    expect(data.stats.files).toBe(before.stats.files + 4); // 4 个新文件（文件夹除外）
    expect(data.stats.usedSpace).toBe(before.stats.usedSpace + 650);
    expect(data.stats.providers).toBe(2);
    expect(data.stats.activeMounts).toBe(2);
    expect(data.stats.totalCapacity).toBe(1024); // 根 null + 池 1024

    const root = data.mounts.find((m) => m.mountPath === '/')!;
    const rootBefore = before.mounts.find((m) => m.mountPath === '/')!;
    const pool = data.mounts.find((m) => m.id === poolMountId)!;

    expect(root.fileCount).toBe(rootBefore.fileCount + 1);
    expect(root.usedSpace).toBe(rootBefore.usedSpace + 50);
    expect(root.standbys).toEqual([]);

    expect(pool.name).toBe('池挂载');
    expect(pool.status).toBe('active');
    expect(pool.capacityBytes).toBe(1024);
    expect(pool.usedSpace).toBe(600);
    expect(pool.fileCount).toBe(3);
    // 主桶 = 创建时指定的 providerId
    expect(pool.provider).toEqual({ id: standbyProviderId, name: '备用桶', bucket: 'picumet-standby' });
    // 备用桶 = 显式标记备用的池成员（排除主 provider，带 weight）；§31 起与文件数无关
    expect(pool.standbys).toEqual([
      { id: primaryProviderId, name: '本地存储', bucket: 'picumet-storage', weight: 1 },
    ]);
  });

  it('PUT /mounts/:id 更新与清空 capacityBytes', async () => {
    const upd = await request(ctx, `/api/admin/mounts/${poolMountId}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { capacityBytes: 2048 },
    });
    expect(upd.status).toBe(200);
    expect((await getDashboard()).stats.totalCapacity).toBe(2048);

    const cleared = await request(ctx, `/api/admin/mounts/${poolMountId}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { capacityBytes: null },
    });
    expect(cleared.status).toBe(200);
    expect((await getDashboard()).stats.totalCapacity).toBeNull();
    const row = ctx.db.prepare('SELECT capacity_bytes FROM mounts WHERE id = ?').get(poolMountId) as
      | { capacity_bytes: number | null }
      | undefined;
    expect(row?.capacity_bytes).toBeNull();
  });

  it('capacityBytes 负数被 400 拒绝', async () => {
    const post = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { providerId: primaryProviderId, mountPath: '/neg', name: '负容量', capacityBytes: -1 },
    });
    expect(post.status).toBe(400);
    const postBody = (await json<ErrorBody>(post)).error;
    expect(postBody.message).toBe('挂载点参数无效');

    const put = await request(ctx, `/api/admin/mounts/${poolMountId}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { capacityBytes: -5 },
    });
    expect(put.status).toBe(400);
  });
});

// ============ §31 备用桶由显式标记决定（不再由「该桶 0 文件」推断） ============
describe('备用桶显式标记（§31）', () => {
  it('未标 standby 的 0 文件池成员不进 standbys；标 standby 的桶持文件仍进 standbys', async () => {
    // 未标记：备用桶上 0 文件也不再被当作备用
    const unmarkedRes = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: {
        providerId: primaryProviderId,
        mountPath: '/dash-unmarked',
        name: '未标备用',
        poolProviderIds: [primaryProviderId, standbyProviderId],
      },
    });
    expect(unmarkedRes.status).toBe(201);
    const unmarkedId = (await json<{ data: { mount: { id: string } } }>(unmarkedRes)).data.mount.id;

    // 显式标记备用，且该桶随后持有文件 → 仍然进 standbys（标记与文件数解耦）
    const markedRes = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: {
        providerId: primaryProviderId,
        mountPath: '/dash-marked',
        name: '标备用',
        poolMembers: [{ providerId: primaryProviderId }, { providerId: standbyProviderId, standby: true }],
      },
    });
    expect(markedRes.status).toBe(201);
    const markedId = (await json<{ data: { mount: { id: string } } }>(markedRes)).data.mount.id;
    await seedFile(markedId, 'on-standby.bin', 7, 'file', standbyProviderId);

    const data = await getDashboard();
    // 未标记：零文件成员不出现
    expect(data.mounts.find((m) => m.id === unmarkedId)?.standbys).toEqual([]);
    // 已标记且持文件：仍出现（排除主 provider）
    expect(data.mounts.find((m) => m.id === markedId)?.standbys).toEqual([
      { id: standbyProviderId, name: '备用桶', bucket: 'picumet-standby', weight: 1 },
    ]);
    // 落库列语义：standby = 1 才是备用
    const rows = ctx.db
      .prepare('SELECT provider_id, standby FROM mount_providers WHERE mount_id = ?')
      .all(markedId) as Array<{ provider_id: string; standby: number }>;
    expect(Object.fromEntries(rows.map((r) => [r.provider_id, Number(r.standby)]))).toEqual({
      [primaryProviderId]: 0,
      [standbyProviderId]: 1,
    });
  });
});
