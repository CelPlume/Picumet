// 桶泳道树（bucketTree）/ 挂载点展开层（mountFolderSummary）/ 扁平化树视图（/files/tree、/admin/files/tree）：
// - bucketTree：主桶节点、拼好桶成员按 file_metadata.provider_id 分桶计数、备用桶（0 文件成员）badge 数据
// - mountFolderSummary：顶层文件夹递归计数按落桶过滤，0 文件夹隐藏
// - 树端点：文件行 path=父目录 + 文件夹行 path=自身全路径统一成树；用户端单挂载点作用域 +
//   子挂载点权限复核 + §4.4a 私有文件夹过滤；管理端全量 + 属主名
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, getCsrf, registerAndLogin, type TestContext } from './helpers';
import { Db, FileRepo } from '../src/db';
import type { DashboardBucket } from '../src/db/repos/dashboard';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';
let adminId = '';
let primaryProviderId = '';
let standbyProviderId = '';
let rootMountId = '';
let poolMountId = '';
let backupMountId = '';
let spareMountId = '';

interface Envelope<T = unknown> {
  data: T;
}

async function getMountTree(): Promise<DashboardBucket[]> {
  return (await json<Envelope<{ buckets: DashboardBucket[] }>>(await request(ctx, '/api/admin/mount-tree', { cookie: adminCookie }))).data.buckets;
}

async function seedFile(mountId: string, path: string, name: string, size: number, providerId?: string): Promise<void> {
  const db = Db.fromSqlite(ctx.db);
  await FileRepo.createFile(db, {
    mountId,
    objectKey: `${mountId}:${path}/${name}`,
    path,
    name,
    type: 'file',
    size,
    ownerId: adminId,
    providerId,
  });
}

async function seedFolder(mountId: string, fullPath: string, name: string): Promise<string> {
  const db = Db.fromSqlite(ctx.db);
  const folder = await FileRepo.createFile(db, {
    mountId,
    objectKey: `folder:${fullPath}`,
    path: fullPath,
    name,
    type: 'folder',
    size: 0,
    ownerId: adminId,
  });
  return folder.id;
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);

  const login = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' },
  });
  expect(login.status).toBe(200);
  adminId = (await json<{ data: { user: { id: string } } }>(login)).data.user.id;
  adminCookie = (login.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[0] ?? '';
  adminCsrf = await getCsrf(ctx, adminCookie);

  const provRes = await request(ctx, '/api/admin/storage/providers', { cookie: adminCookie });
  const providers = (await json<{ data: { providers: Array<{ id: string; name: string }> } }>(provRes)).data.providers;
  primaryProviderId = providers.find((p) => p.name === '本地存储')!.id;
  rootMountId = (await json<Envelope<{ mounts: Array<{ id: string; mountPath: string }> }>>(
    await request(ctx, '/api/admin/dashboard', { cookie: adminCookie })
  )).data.mounts.find((m) => m.mountPath === '/')!.id;

  standbyProviderId = await (async () => {
    const res = await request(ctx, '/api/admin/storage/providers', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { name: '备用桶', bucket: 'picumet-standby' },
    });
    expect(res.status).toBe(201);
    return (await json<{ data: { provider: { id: string } } }>(res)).data.provider.id;
  })();

  // 拼好桶挂载点：主桶 = 备用桶（让「本地存储」成为拼好桶成员，验证 member 分桶计数）；
  // §31：「本地存储」显式标记为备用（既持文件又标备用 → 应同时出现在 mounts 与 standbys）
  const poolRes = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: {
      providerId: standbyProviderId,
      mountPath: '/pool',
      name: '池挂载',
      poolMembers: [{ providerId: standbyProviderId }, { providerId: primaryProviderId, standby: true }],
    },
  });
  expect(poolRes.status).toBe(201);
  poolMountId = (await json<{ data: { mount: { id: string } } }>(poolRes)).data.mount.id;

  // 备份桶挂载点：主桶 = 本地存储，备用桶 = 备用桶且显式标记备用（§31 起备用由标记决定，与文件数无关）
  const backupRes = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: {
      providerId: primaryProviderId,
      mountPath: '/backup',
      name: '备份挂载',
      poolMembers: [{ providerId: primaryProviderId }, { providerId: standbyProviderId, standby: true }],
    },
  });
  expect(backupRes.status).toBe(201);
  backupMountId = (await json<{ data: { mount: { id: string } } }>(backupRes)).data.mount.id;

  // 未标备用挂载点：备用桶 0 文件但**没有** standby 标记 → 不应进 standbys（0 文件推断不再驱动语义）
  const spareRes = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: {
      providerId: primaryProviderId,
      mountPath: '/spare',
      name: '未标备用挂载',
      poolMembers: [{ providerId: primaryProviderId }, { providerId: standbyProviderId }],
    },
  });
  expect(spareRes.status).toBe(201);
  spareMountId = (await json<{ data: { mount: { id: string } } }>(spareRes)).data.mount.id;

  // 种子：根挂载点直置文件（主桶）
  await seedFile(rootMountId, '/', 'root-file.txt', 10, primaryProviderId);
  // 拼好桶：/pool/docs 文件夹（mount folder 行的 path = 挂载点自身全路径 /pool 由系统自愈，
  // 测试直接种子文件夹行 + 两桶分布的文件
  await seedFolder(poolMountId, '/pool/docs', 'docs');
  await seedFile(poolMountId, '/pool/docs', 'on-standby.bin', 100, standbyProviderId);
  await seedFile(poolMountId, '/pool/docs', 'on-primary.bin', 200, primaryProviderId);
  await seedFile(poolMountId, '/pool', 'pool-root.bin', 5, standbyProviderId);
});

describe('bucketTree：桶 → 挂载点泳道', () => {
  it('拼好桶成员按本桶物理存储计数，主桶节点带全部本桶文件', async () => {
    const buckets = await getMountTree();
    const primary = buckets.find((b) => b.id === primaryProviderId)!;
    const standby = buckets.find((b) => b.id === standbyProviderId)!;

    // 本地存储（主桶）：根挂载点（primary）+ 拼好桶 member（仅本桶文件）+ 备份挂载（primary）
    const root = primary.mounts.find((m) => m.id === rootMountId)!;
    expect(root.role).toBe('primary');
    expect(root.fileCount).toBe(3); // 种子 README.md + hello.txt + root-file.txt
    expect(root.usedSpace).toBeGreaterThanOrEqual(10);

    const poolOnPrimary = primary.mounts.find((m) => m.id === poolMountId)!;
    expect(poolOnPrimary.role).toBe('member'); // 主桶是备用桶 → 本地存储为拼好桶成员
    expect(poolOnPrimary.fileCount).toBe(1); // 只有 on-primary.bin
    expect(poolOnPrimary.usedSpace).toBe(200);

    const backup = primary.mounts.find((m) => m.id === backupMountId)!;
    expect(backup.role).toBe('primary');

    // 备用桶泳道：池挂载 member（standby 上的 2 个文件）；备份挂载显式标备用 → standbys badge
    const poolOnStandby = standby.mounts.find((m) => m.id === poolMountId)!;
    expect(poolOnStandby.role).toBe('primary');
    expect(poolOnStandby.fileCount).toBe(2); // on-standby.bin + pool-root.bin
    expect(poolOnStandby.usedSpace).toBe(105);

    const badge = standby.standbys.find((s) => s.mountId === backupMountId);
    expect(badge).toBeDefined();
    expect(badge!.primaryProviderId).toBe(primaryProviderId);
    // 该泳道的主桶（/pool）不会成为自身的备用条目
    expect(standby.standbys.some((s) => s.mountId === poolMountId)).toBe(false);
    // §31：「本地存储」对该挂载点是 0 文件成员但**未标 standby** → 不再进 standbys（0 文件推断不再驱动语义）
    expect(standby.standbys.some((s) => s.mountId === spareMountId)).toBe(false);
    expect(standby.mounts.some((m) => m.id === spareMountId)).toBe(false);
  });

  it('§31 显式备用标记：既持文件又标备用的桶同时出现在 mounts 与 standbys', async () => {
    const buckets = await getMountTree();
    const primary = buckets.find((b) => b.id === primaryProviderId)!;

    // /pool 把「本地存储」显式标为备用，且该桶实际持有 on-primary.bin：
    // → 既以 member 出现在 mounts（本桶文件计数），又以备用条目出现在 standbys（图里两行共存）
    const asMember = primary.mounts.find((m) => m.id === poolMountId)!;
    expect(asMember.role).toBe('member');
    expect(asMember.fileCount).toBe(1);

    const asStandby = primary.standbys.find((s) => s.mountId === poolMountId);
    expect(asStandby).toBeDefined();
    expect(asStandby!.mountName).toBe('池挂载');
    expect(asStandby!.mountPath).toBe('/pool');
    expect(asStandby!.primaryProviderId).toBe(standbyProviderId);
    expect(asStandby!.primaryProviderName).toBe('备用桶');
  });
});

describe('mountFolderSummary：挂载点展开层', () => {
  it('按落桶过滤计数并隐藏 0 文件夹', async () => {
    const q = (providerId: string) => `/api/admin/dashboard/mount-folders?mountId=${poolMountId}&providerId=${providerId}`;
    const onStandby = (await json<Envelope<{ rootFiles: { count: number; size: number }; folders: Array<{ name: string; fileCount: number; usedSpace: number }> }>>(
      await request(ctx, q(standbyProviderId), { cookie: adminCookie })
    )).data;
    expect(onStandby.rootFiles).toEqual({ count: 1, size: 5 });
    expect(onStandby.folders).toHaveLength(1);
    expect(onStandby.folders[0]).toMatchObject({ name: 'docs', fileCount: 1, usedSpace: 100 });

    const onPrimary = (await json<Envelope<{ rootFiles: { count: number }; folders: Array<{ name: string; fileCount: number }> }>>(
      await request(ctx, q(primaryProviderId), { cookie: adminCookie })
    )).data;
    expect(onPrimary.rootFiles.count).toBe(0);
    expect(onPrimary.folders).toHaveLength(1);
    expect(onPrimary.folders[0]).toMatchObject({ name: 'docs', fileCount: 1 });
  });

  it('未知挂载点 404', async () => {
    const res = await request(ctx, '/api/admin/dashboard/mount-folders?mountId=nope', { cookie: adminCookie });
    expect(res.status).toBe(404);
  });
});

describe('扁平化树视图端点', () => {
  it('用户端 /api/files/tree 返回单挂载点子树并含子挂载点内容（管理员）', async () => {
    const data = (await json<Envelope<{ items: Array<{ path: string; name: string; type: string }>; truncated: boolean }>>(
      await request(ctx, '/api/files/tree?path=/', { cookie: adminCookie })
    )).data;
    expect(data.truncated).toBe(false);
    // 文件行 path=父目录（根为 '/'）；文件夹行 path=自身全路径
    const fullPaths = data.items.map((r) => (r.type === 'folder' ? r.path : `${r.path === '/' ? '' : r.path}/${r.name}`)).sort();
    // 根挂载点文件 + 根挂载点的子挂载点目录行 + 子挂载点内容
    expect(fullPaths).toContain('/root-file.txt');
    expect(fullPaths).toContain('/pool'); // 挂载点目录行（mount_id = 根挂载点）
    expect(fullPaths).toContain('/pool/docs/on-standby.bin');
    expect(fullPaths).toContain('/backup');
  });

  it('用户端私有文件夹（非本人）自身与后代被过滤（§4.4a）', async () => {
    const owner = await registerAndLogin(ctx, 'tree_owner');
    const viewer = await registerAndLogin(ctx, 'tree_viewer');
    const db = Db.fromSqlite(ctx.db);
    const secret = await FileRepo.createFile(db, {
      mountId: rootMountId,
      objectKey: 'folder:/secret',
      path: '/secret',
      name: 'secret',
      type: 'folder',
      size: 0,
      ownerId: owner.userId,
    });
    ctx.db.prepare(`UPDATE file_metadata SET visibility = 'private' WHERE id = ?`).run(secret.id);
    await seedFile(rootMountId, '/secret', 'hidden.txt', 1, primaryProviderId);

    // 管理员可见
    const adminTree = (await json<Envelope<{ items: Array<{ name: string; path: string }> }>>(
      await request(ctx, '/api/files/tree?path=/', { cookie: adminCookie })
    )).data.items;
    expect(adminTree.some((r) => r.path === '/secret')).toBe(true);

    // 非属主普通用户不可见（含后代）
    const userTree = (await json<Envelope<{ items: Array<{ path: string }> }>>(
      await request(ctx, '/api/files/tree?path=/', { cookie: viewer.authCookie })
    )).data.items;
    expect(userTree.some((r) => r.path === '/secret')).toBe(false);
    expect(userTree.some((r) => r.path === '/secret/hidden.txt')).toBe(false);
  });

  it('管理端 /api/admin/files/tree 全量 + 属主名', async () => {
    const data = (await json<Envelope<{ items: Array<{ name: string; ownerName?: string; type: string }>; truncated: boolean }>>(
      await request(ctx, '/api/admin/files/tree', { cookie: adminCookie })
    )).data;
    expect(data.truncated).toBe(false);
    const file = data.items.find((r) => r.name === 'on-standby.bin');
    expect(file).toBeDefined();
    expect(file!.ownerName).toBe('admin');
  });
});
