// 存储池（§E）：五档策略（least_used / round_robin / hash / free_weighted / ordered）、
// 管理端池成员管道（capacityBytes / sortOrder 往返与全量替换）、按文件落桶读路径、删除与存量回归。
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestContext,
  initSeeded,
  request,
  json,
  registerAndLogin,
  getCsrf,
  grantApiKeyRule,
  type TestContext,
} from './helpers';
import { releaseExpiredReservations } from '../src/services/cleanup';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'pool_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'pool_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'pool_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${tokenMatch?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

async function createProvider(name: string): Promise<string> {
  const res = await request(ctx, '/api/admin/storage/providers', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { name, bucket: 'pool-bucket' },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { provider: { id: string } }).provider.id;
}

/** 池成员入参（§E）：缺省 weight=1 / capacityBytes=null（不限）/ sortOrder=0；§31 standby 与桶级矩阵 */
type MemberInput = {
  providerId: string;
  weight?: number;
  capacityBytes?: number | null;
  sortOrder?: number;
  standby?: boolean;
  rolePermissions?: Array<{ role: string; permissions: string[] }>;
};

async function createMount(body: Record<string, unknown>): Promise<string> {
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { priority: 300, ...body },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { mount: { id: string } }).mount.id;
}

async function createPoolMount(
  mountPath: string,
  providerIds: string[],
  poolStrategy: string,
  members?: MemberInput[]
): Promise<string> {
  return createMount({
    providerId: providerIds[0],
    mountPath,
    name: `pool${mountPath}`,
    poolStrategy,
    poolProviderIds: providerIds,
    ...(members ? { poolMembers: members } : {}),
  });
}

interface AdminMountRow {
  id: string;
  mountPath: string;
  /** §32 主存储锚点（内部字段，自动派生） */
  providerId: string;
  maxStorage: number | null;
  poolStrategy: string;
  poolMembers: Array<{
    providerId: string;
    weight: number;
    name: string;
    capacityBytes: number | null;
    sortOrder: number;
    /** §31 显式备用标记 + 该桶桶级角色矩阵（沿用 §28 rolePermissions 形状） */
    standby: boolean;
    rolePermissions: Array<{ role: string; permissions: string[] }>;
  }>;
}

async function listMounts(): Promise<AdminMountRow[]> {
  const res = await request(ctx, '/api/admin/mounts', { cookie: adminCookie });
  expect(res.status).toBe(200);
  return ((await json(res)).data as { mounts: AdminMountRow[] }).mounts;
}

/** §32 主存储锚点（GET 契约值）：多处断言需要，统一读回口 */
async function anchorOf(mountId: string): Promise<string | undefined> {
  return (await listMounts()).find((m) => m.id === mountId)?.providerId;
}

async function patchMount(mountId: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/admin/mounts/${mountId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body,
  });
}

async function ensureFolder(cookie: string, path: string, name: string): Promise<void> {
  const csrf = await getCsrf(ctx, cookie);
  const res = await request(ctx, '/api/files/folder', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path, name },
  });
  expect(res.status).toBe(201);
}

/** 仅建上传会话（不落盘）：用于断言选桶失败等入口行为 */
async function initUploadSession(cookie: string, dir: string, fileName: string, content = 'init'): Promise<Response> {
  const csrf = await getCsrf(ctx, cookie);
  return request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: dir, fileName, fileSize: new TextEncoder().encode(content).byteLength, mimeType: 'text/plain' },
  });
}

async function uploadFile(cookie: string, dir: string, fileName: string, content: string): Promise<{ fileId: string; providerId: string | null }> {
  const csrf = await getCsrf(ctx, cookie);
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: dir, fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  const initData = (await json(initRes)).data as { sessionId: string };
  await request(ctx, `/api/files/upload/raw/${initData.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: initData.sessionId, etag: 'etag' },
  });
  const fileId = ((await json(completeRes)).data as { file: { id: string } }).file.id;
  const row = ctx.db.prepare('SELECT provider_id FROM file_metadata WHERE id = ?').get(fileId) as { provider_id: string | null };
  return { fileId, providerId: row.provider_id };
}

function fnv1a(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function byProviderId(a: string, b: string): number {
  return a.localeCompare(b);
}

describe('存储池', () => {
  it('least_used：两个成员时新文件依次落到不同 provider', async () => {
    const p1 = await createProvider('pool-p1');
    const p2 = await createProvider('pool-p2');
    await createPoolMount('/pool-lu', [p1, p2], 'least_used');

    const { authCookie } = await registerAndLogin(ctx, 'pool_user1');
    const first = await uploadFile(authCookie, '/pool-lu', 'a.txt', 'content-a');
    const second = await uploadFile(authCookie, '/pool-lu', 'b.txt', 'content-b');

    expect(first.providerId).toBeTruthy();
    expect(second.providerId).toBeTruthy();
    // 第一次落桶后该 provider 已用量 > 0 → 第二次选另一个（least_used）
    expect(first.providerId).not.toBe(second.providerId);

    // 读路径按文件落桶解析：两个文件签名直链均可匿名取回
    for (const item of [first, second]) {
      const csrf = await getCsrf(ctx, authCookie);
      const linksRes = await request(ctx, `/api/files/${item.fileId}/copy-links?signed=true&expiresIn=3600`, {
        cookie: authCookie,
        headers: { 'X-CSRF-Token': csrf },
      });
      expect(linksRes.status).toBe(200);
      const direct = ((await json(linksRes)).data as { formats: { direct: string } }).formats.direct;
      const u = new URL(direct);
      const fetched = await request(ctx, u.pathname + u.search);
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toContain('content-');
    }
  });

  it('least_used：ratio = (已用 + 1) / weight，权重高者先被填', async () => {
    const p1 = await createProvider('pool-luw1');
    const p2 = await createProvider('pool-luw2');
    // 两个成员都空：ratio 分别 1/4 与 1/1 → 权重高的 p1 先收
    await createPoolMount('/pool-lu-weight', [p1, p2], 'least_used', [
      { providerId: p1, weight: 4 },
      { providerId: p2, weight: 1 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_luw');
    expect((await uploadFile(authCookie, '/pool-lu-weight', 'a.txt', 'w-a')).providerId).toBe(p1);
    // p1 已用 3 字节 → ratio 4/4 = 1 = p2 的 1/1 → 平局按 provider_id 升序
    expect((await uploadFile(authCookie, '/pool-lu-weight', 'b.txt', 'w-b')).providerId).toBe([p1, p2].sort(byProviderId)[0]);
  });

  it('hash：同目录粘性（同目录落同一桶、不同目录可分流、成员集不变时可重放）', async () => {
    const p1 = await createProvider('pool-h1');
    const p2 = await createProvider('pool-h2');
    await createPoolMount('/pool-hash', [p1, p2], 'hash');

    // 成员按 provider_id 升序（与实现一致）；路由 = fnv1a(挂载内相对父目录路径) % 成员数，挂载根 = '/'
    const members = [p1, p2].sort(byProviderId);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user2');

    // 同目录多文件 → 同一桶
    const sameA = await uploadFile(authCookie, '/pool-hash/dirA', 'a.txt', 'hash-a');
    const sameB = await uploadFile(authCookie, '/pool-hash/dirA', 'b.txt', 'hash-b');
    expect(sameA.providerId).toBe(members[fnv1a('/dirA') % members.length]);
    expect(sameB.providerId).toBe(sameA.providerId);

    // 不同目录可分流：逐目录与「目录键取模」比对，且两个桶都被覆盖
    const dirs = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
    const expected = dirs.map((d) => members[fnv1a(`/${d}`) % members.length]);
    expect(new Set(expected).size).toBe(2);
    for (const [i, dir] of dirs.entries()) {
      await ensureFolder(authCookie, '/pool-hash', dir);
      const uploaded = await uploadFile(authCookie, `/pool-hash/${dir}`, 'x.txt', `hash-${dir}`);
      expect(uploaded.providerId).toBe(expected[i]);
    }

    // 成员集不变 → 确定性可重放：同目录追加文件仍落同一桶
    const replay = await uploadFile(authCookie, '/pool-hash/dirA', 'c.txt', 'hash-c');
    expect(replay.providerId).toBe(sameA.providerId);

    // 挂载根下的文件用 '/' 作为目录键
    const root = await uploadFile(authCookie, '/pool-hash', 'root.txt', 'hash-root');
    expect(root.providerId).toBe(members[fnv1a('/') % members.length]);
  });

  it('round_robin：新写入在成员间轮转', async () => {
    const p1 = await createProvider('pool-rr1');
    const p2 = await createProvider('pool-rr2');
    await createPoolMount('/pool-rr', [p1, p2], 'round_robin');

    const members = [p1, p2].sort(byProviderId);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_rr');
    // 计数器从 0 起：第 1、2 个文件分别落成员 0、1，第 3 个回到成员 0
    const first = await uploadFile(authCookie, '/pool-rr', 'a.txt', 'rr-a');
    const second = await uploadFile(authCookie, '/pool-rr', 'b.txt', 'rr-b');
    const third = await uploadFile(authCookie, '/pool-rr', 'c.txt', 'rr-c');
    expect([first.providerId, second.providerId, third.providerId]).toEqual([members[0], members[1], members[0]]);
  });

  it('free_weighted：同样余量下 weight 高者胜出', async () => {
    const p1 = await createProvider('pool-fw1a');
    const p2 = await createProvider('pool-fw1b');
    await createPoolMount('/pool-fw1', [p1, p2], 'free_weighted', [
      { providerId: p1, weight: 1, capacityBytes: 1000 },
      { providerId: p2, weight: 3, capacityBytes: 1000 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_fw1');
    // 余量同为 1000：(1000) × 3 > (1000) × 1 → p2
    expect((await uploadFile(authCookie, '/pool-fw1', 'a.txt', 'fw1-a')).providerId).toBe(p2);
  });

  it('free_weighted：满员成员（已用 >= capacity）被排除', async () => {
    const p1 = await createProvider('pool-fw2a');
    const p2 = await createProvider('pool-fw2b');
    // p1 capacity 0 → 余量 0，永远算满；p2 未满
    await createPoolMount('/pool-fw2', [p1, p2], 'free_weighted', [
      { providerId: p1, weight: 100, capacityBytes: 0 },
      { providerId: p2, weight: 1, capacityBytes: 1000 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_fw2');
    const uploaded = await uploadFile(authCookie, '/pool-fw2', 'a.txt', 'fw2-a');
    expect(uploaded.providerId).toBe(p2);
    // 余量足够 → p2 继续收；p1 始终不参与
    expect((await uploadFile(authCookie, '/pool-fw2', 'b.txt', 'fw2-b')).providerId).toBe(p2);
  });

  it('free_weighted：未配容量的成员优先于任何有限余量', async () => {
    const p1 = await createProvider('pool-fw3a');
    const p2 = await createProvider('pool-fw3b');
    // p1 余量极大且 weight 极高，但 p2 不限容量 → 一律 p2
    await createPoolMount('/pool-fw3', [p1, p2], 'free_weighted', [
      { providerId: p1, weight: 100, capacityBytes: 1_000_000_000 },
      { providerId: p2, weight: 1, capacityBytes: null },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_fw3');
    expect((await uploadFile(authCookie, '/pool-fw3', 'a.txt', 'fw3-a')).providerId).toBe(p2);
    expect((await uploadFile(authCookie, '/pool-fw3', 'b.txt', 'fw3-b')).providerId).toBe(p2);
  });

  it('free_weighted：全部成员都满 → 413 MOUNT_QUOTA_EXCEEDED；清空 capacity 后恢复', async () => {
    const p1 = await createProvider('pool-fw4a');
    const p2 = await createProvider('pool-fw4b');
    const mountId = await createPoolMount('/pool-fw4', [p1, p2], 'free_weighted', [
      { providerId: p1, capacityBytes: 0 },
      { providerId: p2, capacityBytes: 0 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_fw4');
    const rejected = await initUploadSession(authCookie, '/pool-fw4', 'a.txt');
    expect(rejected.status).toBe(413);
    expect((await json(rejected)).error.code).toBe('MOUNT_QUOTA_EXCEEDED');

    // 管理员清空 capacity → 回到不限，写入恢复
    const upd = await request(ctx, `/api/admin/mounts/${mountId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { poolMembers: [{ providerId: p1, capacityBytes: null }, { providerId: p2, capacityBytes: null }] },
    });
    expect(upd.status).toBe(200);
    const recovered = await uploadFile(authCookie, '/pool-fw4', 'b.txt', 'fw4-b');
    expect([p1, p2]).toContain(recovered.providerId);
  });

  it('池成员全满 413 不泄漏预留：用户/挂载预留归零且上传会话未落库', async () => {
    const p1 = await createProvider('pool-fw6a');
    const p2 = await createProvider('pool-fw6b');
    const mountId = await createPoolMount('/pool-fw6', [p1, p2], 'free_weighted', [
      { providerId: p1, capacityBytes: 0 },
      { providerId: p2, capacityBytes: 0 },
    ]);
    const { authCookie, userId } = await registerAndLogin(ctx, 'pool_user_fw6');
    const rejected = await initUploadSession(authCookie, '/pool-fw6', 'a.txt', 'blocked-content');
    expect(rejected.status).toBe(413);
    expect((await json(rejected)).error.code).toBe('MOUNT_QUOTA_EXCEEDED');

    // 选桶发生在用户配额 + 挂载容量两道预留之后 → 失败必须补偿归零，否则容量被永久占用
    const userQuota = ctx.db.prepare('SELECT quota_reserved FROM user_quotas WHERE user_id = ?').get(userId) as {
      quota_reserved: number;
    };
    expect(Number(userQuota.quota_reserved)).toBe(0);
    const mountQuota = ctx.db.prepare('SELECT quota_reserved FROM mounts WHERE id = ?').get(mountId) as {
      quota_reserved: number;
    };
    expect(Number(mountQuota.quota_reserved)).toBe(0);
    // §30 成员级预留同样不残留（选桶失败时任何成员都不该被记账）
    const memberQuotas = ctx.db
      .prepare('SELECT provider_id, quota_reserved FROM mount_providers WHERE mount_id = ?')
      .all(mountId) as Array<{ provider_id: string; quota_reserved: number }>;
    expect(memberQuotas.map((m) => Number(m.quota_reserved))).toEqual([0, 0]);
    const sessions = ctx.db.prepare('SELECT COUNT(*) AS c FROM upload_sessions WHERE user_id = ?').get(userId) as { c: number };
    expect(Number(sessions.c)).toBe(0);

    // 同一用户随后写入别的挂载点仍正常（预留无残留）
    await ensureFolder(authCookie, '/', 'fw6-space');
    const okUpload = await uploadFile(authCookie, '/fw6-space', 'ok.txt', 'fw6-ok');
    expect(okUpload.providerId).toBeTruthy();
  });

  it('free_weighted：全部成员都未配容量 → 退化为 least_used', async () => {
    const p1 = await createProvider('pool-fw5a');
    const p2 = await createProvider('pool-fw5b');
    await createPoolMount('/pool-fw5', [p1, p2], 'free_weighted');
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_fw5');
    // least_used 平局按 provider_id 升序 → 先落小 id，第二份落另一个
    const first = await uploadFile(authCookie, '/pool-fw5', 'a.txt', 'fw5-a');
    expect(first.providerId).toBe([p1, p2].sort(byProviderId)[0]);
    const second = await uploadFile(authCookie, '/pool-fw5', 'b.txt', 'fw5-b');
    expect(second.providerId).not.toBe(first.providerId);
  });

  it('ordered：首选成员装不下待写对象 → 回退到下一成员（容量是硬上限）', async () => {
    const p1 = await createProvider('pool-ord1a');
    const p2 = await createProvider('pool-ord1b');
    // 队首 p2（sort_order 0，容量 100）先收；p1（sort_order 1）不限容量
    const ord1MountId = await createPoolMount('/pool-ord1', [p1, p2], 'ordered', [
      { providerId: p1, sortOrder: 1, capacityBytes: null },
      { providerId: p2, sortOrder: 0, capacityBytes: 100 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_ord1');
    // 180 字节 > p2 容量 100 → 队首放不下，按次序回退到 p1（修前这里会把 p2 撑爆）
    expect((await uploadFile(authCookie, '/pool-ord1', 'a.txt', 'x'.repeat(180))).providerId).toBe(p1);
    // 小文件仍走队首 p2（回退不改变策略次序）
    expect((await uploadFile(authCookie, '/pool-ord1', 'b.txt', 'ord1-b')).providerId).toBe(p2);
    // p2 已用 6 字节：6 + 95 > 100 → 再次回退 p1
    expect((await uploadFile(authCookie, '/pool-ord1', 'c.txt', 'y'.repeat(95))).providerId).toBe(p1);
    // 成员已用（file_metadata 聚合）始终不越过容量
    const used = ctx.db
      .prepare(`SELECT COALESCE(SUM(size), 0) AS s FROM file_metadata WHERE mount_id = ? AND type = 'file' AND provider_id = ?`)
      .get(ord1MountId, p2) as { s: number };
    expect(Number(used.s)).toBeLessThanOrEqual(100);
  });

  it('ordered：同 sort_order 时按 provider_id 升序', async () => {
    const p1 = await createProvider('pool-ord2a');
    const p2 = await createProvider('pool-ord2b');
    await createPoolMount('/pool-ord2', [p1, p2], 'ordered', [
      { providerId: p1, sortOrder: 3 },
      { providerId: p2, sortOrder: 3 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_ord2');
    const expected = [p1, p2].sort(byProviderId)[0];
    expect((await uploadFile(authCookie, '/pool-ord2', 'a.txt', 'ord2-a')).providerId).toBe(expected);
    expect((await uploadFile(authCookie, '/pool-ord2', 'b.txt', 'ord2-b')).providerId).toBe(expected);
  });

  it('ordered：全部成员都满 → 413 MOUNT_QUOTA_EXCEEDED', async () => {
    const p1 = await createProvider('pool-ord3a');
    const p2 = await createProvider('pool-ord3b');
    await createPoolMount('/pool-ord3', [p1, p2], 'ordered', [
      { providerId: p1, sortOrder: 0, capacityBytes: 0 },
      { providerId: p2, sortOrder: 1, capacityBytes: 0 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_ord3');
    const rejected = await initUploadSession(authCookie, '/pool-ord3', 'a.txt');
    expect(rejected.status).toBe(413);
    expect((await json(rejected)).error.code).toBe('MOUNT_QUOTA_EXCEEDED');
  });

  it('存量回归：未配置池成员的挂载不受容量判定影响；单成员池仍守成员容量', async () => {
    const p1 = await createProvider('pool-solo1');
    // 未配置池成员：写路径回退主 provider（单桶语义），无容量配置 → 不判满也不预留
    await createMount({ providerId: p1, mountPath: '/pool-solo1', name: '单桶挂载', poolStrategy: 'ordered' });
    // 单成员池 + 显式容量 0：无其余成员可回退，容量是硬上限 → 413
    const single = await createProvider('pool-solo2');
    const singleMountId = await createMount({
      providerId: single,
      mountPath: '/pool-solo2',
      name: '单成员零容量',
      poolStrategy: 'free_weighted',
      poolMembers: [{ providerId: single, capacityBytes: 0 }],
    });

    const { authCookie } = await registerAndLogin(ctx, 'pool_user_solo');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      expect((await uploadFile(authCookie, '/pool-solo1', name, `solo-${name}`)).providerId).toBe(p1);
    }
    const rejected = await initUploadSession(authCookie, '/pool-solo2', 'a.txt');
    expect(rejected.status).toBe(413);
    expect((await json(rejected)).error.code).toBe('MOUNT_QUOTA_EXCEEDED');

    // 未配置池成员 → 库内只有主 provider 一行（成员为空 = 无容量配置）
    const soloRows = (await listMounts()).find((m) => m.mountPath === '/pool-solo1')?.poolMembers ?? [];
    expect(soloRows.map((m) => m.providerId)).toEqual([p1]);
    expect(soloRows[0]).toMatchObject({ weight: 1, capacityBytes: null, sortOrder: 0 });
    const rows = await listMounts();
    expect(rows.find((m) => m.id === singleMountId)?.poolMembers).toHaveLength(1);
  });

  it('删除文件后落桶记录与挂载用量同步回收', async () => {
    const p1 = await createProvider('pool-d1');
    const p2 = await createProvider('pool-d2');
    const mountId = await createPoolMount('/pool-del', [p1, p2], 'least_used');
    const { authCookie } = await registerAndLogin(ctx, 'pool_user3');
    const uploaded = await uploadFile(authCookie, '/pool-del', 'd.txt', 'content-d');
    const csrf = await getCsrf(ctx, authCookie);

    const del = await request(ctx, `/api/files/${uploaded.fileId}`, {
      method: 'DELETE',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(del.status).toBe(200);

    const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM file_metadata WHERE id = ?').get(uploaded.fileId) as { c: number };
    expect(Number(row.c)).toBe(0);
    const mountRow = ctx.db.prepare('SELECT used_storage FROM mounts WHERE id = ?').get(mountId) as { used_storage: number };
    expect(Number(mountRow.used_storage)).toBe(0);
  });

  it('管理端可见池策略与成员', async () => {
    const p1 = await createProvider('pool-a1');
    const p2 = await createProvider('pool-a2');
    await createPoolMount('/pool-admin', [p1, p2], 'round_robin');

    const res = await request(ctx, '/api/admin/mounts', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const mounts = ((await json(res)).data as {
      mounts: Array<{ mountPath: string; poolStrategy: string; poolMembers: Array<{ providerId: string }> }>;
    }).mounts;
    const target = mounts.find((m) => m.mountPath === '/pool-admin');
    expect(target?.poolStrategy).toBe('round_robin');
    const memberIds = (target?.poolMembers ?? []).map((m) => m.providerId).sort();
    expect(memberIds).toEqual([p1, p2].sort((a, b) => a.localeCompare(b)));
  });

  it('管理端往返：poolMembers 读写 capacityBytes/sortOrder，PATCH 全量替换生效', async () => {
    const p1 = await createProvider('pool-mr1');
    const p2 = await createProvider('pool-mr2');
    const p3 = await createProvider('pool-mr3');
    const mountId = await createPoolMount('/pool-mr', [p1, p2], 'free_weighted', [
      { providerId: p1, weight: 2, capacityBytes: 4096, sortOrder: 5 },
      { providerId: p2, weight: 1, capacityBytes: null, sortOrder: 0 },
    ]);

    // POST 落库 → GET 回显新字段
    const created = (await listMounts()).find((m) => m.id === mountId);
    expect(created?.poolStrategy).toBe('free_weighted');
    const createdById = Object.fromEntries((created?.poolMembers ?? []).map((m) => [m.providerId, m]));
    expect(createdById[p1]).toEqual({
      providerId: p1,
      weight: 2,
      name: 'pool-mr1',
      capacityBytes: 4096,
      sortOrder: 5,
      standby: false,
      rolePermissions: [],
    });
    expect(createdById[p2]).toEqual({
      providerId: p2,
      weight: 1,
      name: 'pool-mr2',
      capacityBytes: null,
      sortOrder: 0,
      standby: false,
      rolePermissions: [],
    });
    const dbRows = ctx.db
      .prepare('SELECT provider_id, weight, capacity_bytes, sort_order FROM mount_providers WHERE mount_id = ?')
      .all(mountId) as Array<{ provider_id: string; weight: number; capacity_bytes: number | null; sort_order: number }>;
    const dbById = Object.fromEntries(dbRows.map((r) => [r.provider_id, r]));
    expect([dbById[p1].weight, dbById[p1].capacity_bytes, dbById[p1].sort_order]).toEqual([2, 4096, 5]);
    expect([dbById[p2].weight, dbById[p2].capacity_bytes, dbById[p2].sort_order]).toEqual([1, null, 0]);

    // PATCH 全量替换：§32 池 = 入参成员集——p2 被移除、p3 新入；主 provider p1 不再强制保留
    const patch = await request(ctx, `/api/admin/mounts/${mountId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { poolMembers: [{ providerId: p3, weight: 4, capacityBytes: 8192, sortOrder: 2 }] },
    });
    expect(patch.status).toBe(200);

    const after = (await listMounts()).find((m) => m.id === mountId);
    expect((after?.poolMembers ?? []).map((m) => m.providerId)).toEqual([p3]);
    expect((after?.poolMembers ?? []).find((m) => m.providerId === p3)).toMatchObject({
      weight: 4,
      capacityBytes: 8192,
      sortOrder: 2,
    });
    // §32 主存储锚点自动改指池内第一个非备用成员（p1 已不在池内）
    expect(after?.providerId).toBe(p3);
  });

  it('更新池成员：替换为单个 provider 后新文件回到该 provider', async () => {
    const p1 = await createProvider('pool-u1');
    const p2 = await createProvider('pool-u2');
    const mountId = await createPoolMount('/pool-update', [p1, p2], 'least_used');

    const upd = await request(ctx, `/api/admin/mounts/${mountId}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { poolProviderIds: [p2] },
    });
    expect(upd.status).toBe(200);
    // §32 池 = 入参成员集（p1 被移出池），主存储锚点随派生为 p2
    expect((await listMounts()).find((m) => m.id === mountId)?.poolMembers.map((m) => m.providerId)).toEqual([p2]);
    expect(await anchorOf(mountId)).toBe(p2);

    const { authCookie } = await registerAndLogin(ctx, 'pool_user4');
    const uploaded = await uploadFile(authCookie, '/pool-update', 'e.txt', 'content-e');
    // p1 已不在池内 → 唯一的写入候选是 p2
    expect(uploaded.providerId).toBe(p2);
  });
});

// ============ §30 池成员级容量：判定（含待写大小）/ 原子预留 / 释放 ============
describe('池成员容量判定与预留（§30）', () => {
  /** 成员在途预留字节（mount_providers.quota_reserved） */
  function memberReserved(mountId: string, providerId: string): number {
    const row = ctx.db
      .prepare('SELECT quota_reserved FROM mount_providers WHERE mount_id = ? AND provider_id = ?')
      .get(mountId, providerId) as { quota_reserved: number } | undefined;
    return Number(row?.quota_reserved ?? 0);
  }

  /** 单成员池（无其余成员可回退）：capacityBytes 为硬上限，null = 不限 */
  async function soloPool(
    name: string,
    capacityBytes: number | null,
    maxStorage?: number
  ): Promise<{ mountId: string; providerId: string }> {
    const providerId = await createProvider(name);
    const mountId = await createMount({
      providerId,
      mountPath: `/${name}`,
      name,
      ...(maxStorage === undefined ? {} : { maxStorage }),
      poolMembers: [{ providerId, capacityBytes }],
    });
    return { mountId, providerId };
  }

  async function expectRejected(res: Response): Promise<void> {
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe('MOUNT_QUOTA_EXCEEDED');
  }

  it('容量边界：used + size == capacity 放行，超出 1 字节拒绝', async () => {
    const { mountId, providerId } = await soloPool('pool-cap-edge', 100);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_edge');

    // 恰好填满：0 + 0 + 100 <= 100
    expect((await uploadFile(authCookie, '/pool-cap-edge', 'exact.txt', 'x'.repeat(100))).providerId).toBe(providerId);
    // 写完即释放预留（已用改由 file_metadata 聚合承担）
    expect(memberReserved(mountId, providerId)).toBe(0);

    // 已用 100 + 1 > 100 → 拒绝
    await expectRejected(await initUploadSession(authCookie, '/pool-cap-edge', 'over.txt', 'y'));
    expect(memberReserved(mountId, providerId)).toBe(0);
  });

  it('大小感知：同容量下先写 80 再写 30 被拒、写 20 放行', async () => {
    const { mountId, providerId } = await soloPool('pool-cap-size', 100);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_size');

    expect((await uploadFile(authCookie, '/pool-cap-size', 'a.txt', 'a'.repeat(80))).providerId).toBe(providerId);
    // 80 + 30 > 100（修前只看「当前是否已满」，30 字节会照样落桶）
    await expectRejected(await initUploadSession(authCookie, '/pool-cap-size', 'b.txt', 'b'.repeat(30)));
    // 80 + 20 == 100 → 放行
    expect((await uploadFile(authCookie, '/pool-cap-size', 'c.txt', 'c'.repeat(20))).providerId).toBe(providerId);
    expect(memberReserved(mountId, providerId)).toBe(0);
  });

  it('并发预留：不释放的情况下第二次预留超容量 → 413', async () => {
    const { mountId, providerId } = await soloPool('pool-cap-conc', 100);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_conc');

    const first = await initUploadSession(authCookie, '/pool-cap-conc', 'a.txt', 'a'.repeat(60));
    expect(first.status).toBe(200);
    expect(memberReserved(mountId, providerId)).toBe(60);

    // 第一个会话仍在途（未写完/未中止）→ 60 + 60 > 100，第二个会话必须被拒
    await expectRejected(await initUploadSession(authCookie, '/pool-cap-conc', 'b.txt', 'b'.repeat(60)));
    expect(memberReserved(mountId, providerId)).toBe(60);
  });

  it('释放：写完 / 中止 / 会话过期后成员预留归零且可再次写入', async () => {
    // 容量 200：写完 60 后仍有空间让后续会话预留（否则会先撞容量闸门，测不到释放）
    const { mountId, providerId } = await soloPool('pool-cap-release', 200);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_release');

    // 1. 写完（落账同批释放）
    expect((await uploadFile(authCookie, '/pool-cap-release', 'a.txt', 'a'.repeat(60))).providerId).toBe(providerId);
    expect(memberReserved(mountId, providerId)).toBe(0);

    // 2. 中止会话
    const aborted = await initUploadSession(authCookie, '/pool-cap-release', 'b.txt', 'b'.repeat(60));
    const abortedData = (await json(aborted)).data as { sessionId: string };
    expect(memberReserved(mountId, providerId)).toBe(60);
    const csrf = await getCsrf(ctx, authCookie);
    const del = await request(ctx, `/api/files/upload/multipart/${abortedData.sessionId}`, {
      method: 'DELETE',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(del.status).toBe(200);
    expect(memberReserved(mountId, providerId)).toBe(0);

    // 3. 会话过期（定时任务释放）
    const expiring = await initUploadSession(authCookie, '/pool-cap-release', 'c.txt', 'c'.repeat(60));
    const expiringData = (await json(expiring)).data as { sessionId: string };
    expect(memberReserved(mountId, providerId)).toBe(60);
    ctx.db.prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, expiringData.sessionId);
    expect(await releaseExpiredReservations(ctx.env)).toBeGreaterThan(0);
    expect(memberReserved(mountId, providerId)).toBe(0);

    // 无残留预留 → 再次写入正常落桶（不会因残留预留被永久拒绝）
    expect((await uploadFile(authCookie, '/pool-cap-release', 'd.txt', 'd'.repeat(40))).providerId).toBe(providerId);
    expect(memberReserved(mountId, providerId)).toBe(0);
  });

  it('不限容量成员：capacity_bytes IS NULL 不判满也不预留（回归）', async () => {
    const p1 = await createProvider('pool-cap-null1');
    const p2 = await createProvider('pool-cap-null2');
    const mountId = await createPoolMount('/pool-cap-null', [p1, p2], 'least_used');
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_nullcap');

    const uploaded = await uploadFile(authCookie, '/pool-cap-null', 'a.txt', 'z'.repeat(4096));
    expect([p1, p2]).toContain(uploaded.providerId);
    // 不限容量 → 不记账预留
    const rows = ctx.db
      .prepare('SELECT quota_reserved FROM mount_providers WHERE mount_id = ?')
      .all(mountId) as Array<{ quota_reserved: number }>;
    expect(rows.map((r) => Number(r.quota_reserved))).toEqual([0, 0]);

    // 大文件照样通过（无任何容量闸门）
    expect((await uploadFile(authCookie, '/pool-cap-null', 'b.txt', 'w'.repeat(50_000))).providerId).toBeTruthy();

    // 在途会话同样不记成员预留（契约：capacity_bytes IS NULL = 不判满、不预留）
    const inFlight = await initUploadSession(authCookie, '/pool-cap-null', 'c.txt', 'c'.repeat(1000));
    expect(inFlight.status).toBe(200);
    const reservedAfterInit = ctx.db
      .prepare('SELECT quota_reserved FROM mount_providers WHERE mount_id = ?')
      .all(mountId) as Array<{ quota_reserved: number }>;
    expect(reservedAfterInit.map((r) => Number(r.quota_reserved))).toEqual([0, 0]);
  });

  it('least_used：首选成员装不下 → 回退次选；全部装不下 → 413', async () => {
    const p1 = await createProvider('pool-lucap1');
    const p2 = await createProvider('pool-lucap2');
    // p1 权重高 → ratio 最小 = 首选，但容量 5 放不下 20 字节；p2 容量 1000
    await createPoolMount('/pool-lucap', [p1, p2], 'least_used', [
      { providerId: p1, weight: 100, capacityBytes: 5 },
      { providerId: p2, weight: 1, capacityBytes: 1000 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_lucap');
    expect((await uploadFile(authCookie, '/pool-lucap', 'a.txt', 'a'.repeat(20))).providerId).toBe(p2);

    const p3 = await createProvider('pool-lucap3');
    const p4 = await createProvider('pool-lucap4');
    await createPoolMount('/pool-lucap-full', [p3, p4], 'least_used', [
      { providerId: p3, capacityBytes: 5 },
      { providerId: p4, capacityBytes: 5 },
    ]);
    await expectRejected(await initUploadSession(authCookie, '/pool-lucap-full', 'b.txt', 'b'.repeat(20)));
  });

  it('hash：哈希命中的成员装不下 → 按取模次序回退到其余成员', async () => {
    const p1 = await createProvider('pool-hcap1');
    const p2 = await createProvider('pool-hcap2');
    const members = [p1, p2].sort(byProviderId);
    // 挂载根下的文件目录键 = '/'，命中成员 = members[fnv1a('/') % 2]
    const hitIndex = fnv1a('/') % members.length;
    const capped = members[hitIndex];
    const other = members[(hitIndex + 1) % members.length];
    await createPoolMount('/pool-hcap', members, 'hash', [
      { providerId: capped, capacityBytes: 5 },
      { providerId: other, capacityBytes: 1000 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_hcap');

    // 20 字节 > 命中成员容量 → 按取模次序回退到另一个成员
    expect((await uploadFile(authCookie, '/pool-hcap', 'a.txt', 'a'.repeat(20))).providerId).toBe(other);
    // 装得下（≤5）时粘性仍然生效
    expect((await uploadFile(authCookie, '/pool-hcap', 'b.txt', 'bbbbb')).providerId).toBe(capped);
  });

  it('round_robin：轮转起始成员装不下 → 顺延到下一成员（失败候选不算一轮）', async () => {
    const p1 = await createProvider('pool-rrcap1');
    const p2 = await createProvider('pool-rrcap2');
    const members = [p1, p2].sort(byProviderId);
    // 计数器从 0 起 → 起始成员 = members[0]（容量 5），另一成员容量 1000
    await createPoolMount('/pool-rrcap', members, 'round_robin', [
      { providerId: members[0], capacityBytes: 5 },
      { providerId: members[1], capacityBytes: 1000 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_rrcap');

    expect((await uploadFile(authCookie, '/pool-rrcap', 'a.txt', 'a'.repeat(20))).providerId).toBe(members[1]);
    // 计数器只在预留成功后推进到「落桶成员的下一个」→ 下一个小文件回到起始成员
    expect((await uploadFile(authCookie, '/pool-rrcap', 'b.txt', 'bbbbb')).providerId).toBe(members[0]);
  });

  it('free_weighted：评分最高的成员装不下 → 回退；全满 → 413', async () => {
    const p1 = await createProvider('pool-fwcap1');
    const p2 = await createProvider('pool-fwcap2');
    // p1 评分 (10 − 0) × 100 = 1000 最高但放不下 12 字节；p2 余量 15 是唯一放得下的
    await createPoolMount('/pool-fwcap', [p1, p2], 'free_weighted', [
      { providerId: p1, weight: 100, capacityBytes: 10 },
      { providerId: p2, weight: 1, capacityBytes: 15 },
    ]);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_fwcap');
    expect((await uploadFile(authCookie, '/pool-fwcap', 'a.txt', 'a'.repeat(12))).providerId).toBe(p2);

    const p3 = await createProvider('pool-fwcap3');
    const p4 = await createProvider('pool-fwcap4');
    await createPoolMount('/pool-fwcap-full', [p3, p4], 'free_weighted', [
      { providerId: p3, capacityBytes: 10 },
      { providerId: p4, capacityBytes: 10 },
    ]);
    await expectRejected(await initUploadSession(authCookie, '/pool-fwcap-full', 'b.txt', 'b'.repeat(20)));
  });

  it('写路径（WebDAV PUT）：成员容量装不下 → 413；落账前失败释放成员预留', async () => {
    const { mountId, providerId } = await soloPool('pool-wp', 100);
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_wp');
    const csrf = await getCsrf(ctx, authCookie);
    const keyRes = await request(ctx, '/api/keys', {
      method: 'POST',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { name: 'wp', permissions: ['write', 'read'], protocols: ['webdav'], uploadPath: '/' },
    });
    expect(keyRes.status).toBe(201);
    const keyData = (await json(keyRes)).data as { key: { keyId: string; secret: string } };
    await grantApiKeyRule(ctx, keyData.key.keyId, ['write', 'read'], '/');
    const auth = { Authorization: 'Basic ' + Buffer.from(`${keyData.key.keyId}:${keyData.key.secret}`).toString('base64') };
    const put = (path: string, content: string) =>
      request(ctx, `/webdav${path}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'text/plain' },
        body: content,
      });

    // 50 字节 ≤ 100：落桶成功，预留释放
    expect((await put('/pool-wp/ok.txt', 'o'.repeat(50))).status).toBe(201);
    expect(memberReserved(mountId, providerId)).toBe(0);
    // 150 字节 > 100：成员容量拒绝
    await expectRejected(await put('/pool-wp/big.txt', 'b'.repeat(150)));
    expect(memberReserved(mountId, providerId)).toBe(0);

    // 成员放得下、挂载点闸门拦下（maxStorage 10）→ 成员预留必须补偿归零
    const tight = await soloPool('pool-wp-tight', 100, 10);
    await expectRejected(await put('/pool-wp-tight/x.txt', 'x'.repeat(50)));
    expect(memberReserved(tight.mountId, tight.providerId)).toBe(0);

    // 挂载点闸门恢复后照常写入（无残留预留）；§31 起总上限不得大于成员上限之和 → 抬到 100（= 该成员上限）
    const upd = await request(ctx, `/api/admin/mounts/${tight.mountId}`, {
      method: 'PUT',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { maxStorage: 100 },
    });
    expect(upd.status).toBe(200);
    expect((await put('/pool-wp-tight/x.txt', 'x'.repeat(50))).status).toBe(201);
    expect(memberReserved(tight.mountId, tight.providerId)).toBe(0);
  });
});

// ============ §31 备用桶显式标记 + 总上限 ≤ Σ 桶上限 ============
describe('桶级备用标记与容量两层校验（§31）', () => {
  it('standby 显式标记往返；有文件的桶标为备用仍是备用（0 文件推断不再驱动语义）', async () => {
    const p1 = await createProvider('pool-sb1');
    const p2 = await createProvider('pool-sb2');
    const mountId = await createPoolMount('/pool-sb', [p1, p2], 'ordered', [
      { providerId: p1, sortOrder: 0, standby: true },
      { providerId: p2, sortOrder: 1 },
    ]);

    // POST 落库 → GET 回显（主 provider p1 显式备用、p2 缺省 false）
    const created = (await listMounts()).find((m) => m.id === mountId);
    const createdById = Object.fromEntries((created?.poolMembers ?? []).map((m) => [m.providerId, m]));
    expect(createdById[p1].standby).toBe(true);
    expect(createdById[p2].standby).toBe(false);
    // §32 请求锚点 p1 已被标为备用 → 锚点派生为池内第一个非备用成员 p2
    expect(created?.providerId).toBe(p2);

    // §32 备用桶不参与写入：ordered 首选 p1 已标备用 → 写入落到唯一可写成员 p2
    const { authCookie } = await registerAndLogin(ctx, 'pool_user_sb');
    const uploaded = await uploadFile(authCookie, '/pool-sb', 'a.txt', 'sb-a');
    expect(uploaded.providerId).toBe(p2);
    // p1 随后持有文件（直改库模拟既有落桶数据）：显式标记不因「该桶 0 文件」推断而改变
    ctx.db.prepare('UPDATE file_metadata SET provider_id = ? WHERE id = ?').run(p1, uploaded.fileId);
    const afterUpload = (await listMounts()).find((m) => m.id === mountId);
    expect(afterUpload?.poolMembers.find((m) => m.providerId === p1)?.standby).toBe(true);

    // PATCH 全量替换：标记翻转并落库
    const upd = await request(ctx, `/api/admin/mounts/${mountId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { poolMembers: [{ providerId: p1, sortOrder: 0 }, { providerId: p2, sortOrder: 1, standby: true }] },
    });
    expect(upd.status).toBe(200);
    const flipped = (await listMounts()).find((m) => m.id === mountId);
    expect(flipped?.poolMembers.find((m) => m.providerId === p1)?.standby).toBe(false);
    expect(flipped?.poolMembers.find((m) => m.providerId === p2)?.standby).toBe(true);
    const dbRows = ctx.db
      .prepare('SELECT provider_id, standby FROM mount_providers WHERE mount_id = ?')
      .all(mountId) as Array<{ provider_id: string; standby: number }>;
    expect(Object.fromEntries(dbRows.map((r) => [r.provider_id, Number(r.standby)]))).toEqual({
      [p1]: 0,
      [p2]: 1,
    });

    // §32 标记翻转后放置随之翻转：可写成员只剩 p1（锚点也回到 p1）
    expect(flipped?.providerId).toBe(p1);
    expect((await uploadFile(authCookie, '/pool-sb', 'b.txt', 'sb-b')).providerId).toBe(p1);
  });

  it('总上限 > Σ 桶上限 → 400；等于/小于 → 通过；PATCH 以最终状态判定且不产生部分写入', async () => {
    const p1 = await createProvider('pool-total1');
    const p2 = await createProvider('pool-total2');
    const members: MemberInput[] = [
      { providerId: p1, capacityBytes: 100 },
      { providerId: p2, capacityBytes: 50 },
    ];

    // POST：200 > 100 + 50 → 400 VALIDATION_ERROR，且挂载点未落库（校验先于创建）
    const bad = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { providerId: p1, mountPath: '/pool-total-bad', name: '总上限超标', maxStorage: 200, poolMembers: members },
    });
    expect(bad.status).toBe(400);
    const badBody = await json<{ error: { code: string; message: string } }>(bad);
    expect(badBody.error.code).toBe('VALIDATION_ERROR');
    expect(badBody.error.message).toContain('总上限不得超过各存储桶上限之和');
    expect((await listMounts()).some((m) => m.mountPath === '/pool-total-bad')).toBe(false);

    // 等于 Σ → 通过；小于 Σ → 通过
    const equalMountId = await createMount({
      providerId: p1,
      mountPath: '/pool-total-eq',
      name: '总上限等于桶上限之和',
      maxStorage: 150,
      poolMembers: members,
    });
    await createMount({
      providerId: p1,
      mountPath: '/pool-total-lt',
      name: '总上限小于桶上限之和',
      maxStorage: 100,
      poolMembers: [
        { providerId: p1, capacityBytes: 100 },
        { providerId: p2, capacityBytes: 50 },
      ],
    });

    // PATCH 抬高超限 → 400，且 maxStorage 未被部分写入
    const over = await request(ctx, `/api/admin/mounts/${equalMountId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { maxStorage: 151 },
    });
    expect(over.status).toBe(400);
    const overBody = await json<{ error: { code: string } }>(over);
    expect(overBody.error.code).toBe('VALIDATION_ERROR');
    expect((await listMounts()).find((m) => m.id === equalMountId)?.maxStorage).toBe(150);

    // PATCH 收紧桶上限（Σ 10 < 总上限 150）→ 400
    const shrink = await request(ctx, `/api/admin/mounts/${equalMountId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { poolMembers: [{ providerId: p1, capacityBytes: 10 }] },
    });
    expect(shrink.status).toBe(400);

    // 未设上限的桶不参与求和：Σ = 150（p2 不限）→ 总上限 150 通过
    const ok = await request(ctx, `/api/admin/mounts/${equalMountId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { poolMembers: [{ providerId: p1, capacityBytes: 150 }, { providerId: p2 }] },
    });
    expect(ok.status).toBe(200);

    // 总上限清空（null = 不限）→ 无约束
    const cleared = await request(ctx, `/api/admin/mounts/${equalMountId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { maxStorage: null },
    });
    expect(cleared.status).toBe(200);
    expect((await listMounts()).find((m) => m.id === equalMountId)?.maxStorage).toBeNull();
  });
});

// ============ §32 备用桶不参与写入 + 主存储锚点自动维护 ============
describe('备用桶与主存储锚点（§32）', () => {
  it('① 写入候选排除备用成员：五档策略下备用桶都拿不到新文件', async () => {
    const strategies = ['least_used', 'round_robin', 'hash', 'free_weighted', 'ordered'] as const;
    const { authCookie } = await registerAndLogin(ctx, 'sb_writer');

    for (const strategy of strategies) {
      const path = `/sb-${strategy}`;
      const standby = await createProvider(`sb-${strategy}-standby`);
      const writable = await createProvider(`sb-${strategy}-writable`);
      const mountId = await createMount({
        providerId: standby,
        mountPath: path,
        name: `sb-${strategy}`,
        poolStrategy: strategy,
        // 备用桶放在最优先位置（ordered 队首 / least_used 高权重）：策略只在非备用成员里选，故一律落另一个桶
        poolMembers: [
          { providerId: standby, sortOrder: 0, weight: 100, standby: true },
          { providerId: writable, sortOrder: 1 },
        ],
      });
      await ensureFolder(authCookie, path, 'd1');
      for (const [dir, name] of [
        [path, 'a.txt'],
        [`${path}/d1`, 'b.txt'],
      ] as const) {
        expect((await uploadFile(authCookie, dir, name, `sb-${strategy}-${name}`)).providerId).toBe(writable);
      }
      // 备用桶 0 文件；锚点派生为唯一非备用成员
      const standbyFiles = ctx.db
        .prepare(`SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ? AND provider_id = ?`)
        .get(mountId, standby) as { c: number };
      expect(Number(standbyFiles.c)).toBe(0);
      expect(await anchorOf(mountId)).toBe(writable);
    }
  });

  it('② 全部成员都被标为备用（直改库绕过校验）→ 拒写 409，错误可读且无残留', async () => {
    const p1 = await createProvider('sb-all1');
    const p2 = await createProvider('sb-all2');
    const mountId = await createMount({
      providerId: p1,
      mountPath: '/sb-all',
      name: 'sb-all',
      poolMembers: [
        { providerId: p1, sortOrder: 0 },
        { providerId: p2, sortOrder: 1 },
      ],
    });
    // 管理端保存时会 400（见 ⑥），这里直改库模拟「配置坏掉」的存量状态
    ctx.db.prepare('UPDATE mount_providers SET standby = 1 WHERE mount_id = ?').run(mountId);

    const { authCookie, userId } = await registerAndLogin(ctx, 'sb_all_user');
    const rejected = await initUploadSession(authCookie, '/sb-all', 'x.txt', 'all-standby');
    expect(rejected.status).toBe(409);
    const body = await json<{ error: { code: string; message: string } }>(rejected);
    expect(body.error.code).toBe('OPERATION_FAILED');
    expect(body.error.message).toContain('没有可用于写入的非备用桶');
    expect(body.error.message).toContain('至少保留一个非备用桶');

    // 拒写发生在落库之前：三道预留都无残留、无上传会话、无文件行
    const userQuota = ctx.db
      .prepare('SELECT quota_reserved FROM user_quotas WHERE user_id = ?')
      .get(userId) as { quota_reserved: number };
    expect(Number(userQuota.quota_reserved)).toBe(0);
    const mountQuota = ctx.db
      .prepare('SELECT quota_reserved FROM mounts WHERE id = ?')
      .get(mountId) as { quota_reserved: number };
    expect(Number(mountQuota.quota_reserved)).toBe(0);
    const memberQuotas = ctx.db
      .prepare('SELECT quota_reserved FROM mount_providers WHERE mount_id = ?')
      .all(mountId) as Array<{ quota_reserved: number }>;
    expect(memberQuotas.map((r) => Number(r.quota_reserved))).toEqual([0, 0]);
    const sessions = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM upload_sessions WHERE user_id = ?')
      .get(userId) as { c: number };
    expect(Number(sessions.c)).toBe(0);
    const files = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ?')
      .get(mountId) as { c: number };
    expect(Number(files.c)).toBe(0);
  });

  it('③ 主存储锚点自动维护：移出成员 / 标备用 / 成员重排都派生到池内第一个非备用成员', async () => {
    const p1 = await createProvider('sb-anchor1');
    const p2 = await createProvider('sb-anchor2');
    const mountId = await createMount({
      providerId: p1,
      mountPath: '/sb-anchor',
      name: 'sb-anchor',
      poolStrategy: 'ordered',
      poolMembers: [
        { providerId: p1, sortOrder: 0 },
        { providerId: p2, sortOrder: 1 },
      ],
    });
    // 创建：显式 providerId p1 是池内可写成员 → 锚点 = p1（GET 回显与落库列一致）
    expect(await anchorOf(mountId)).toBe(p1);
    const createdRow = ctx.db.prepare('SELECT provider_id FROM mounts WHERE id = ?').get(mountId) as {
      provider_id: string;
    };
    expect(createdRow.provider_id).toBe(p1);

    // 锚点成员被移出池 → 改指池内第一个非备用成员
    expect((await patchMount(mountId, { poolMembers: [{ providerId: p2, sortOrder: 1 }] })).status).toBe(200);
    expect(await anchorOf(mountId)).toBe(p2);

    // 成员集合重排（p1 回到队首）→ 锚点跟随池内次序派生回 p1
    expect(
      (
        await patchMount(mountId, {
          poolMembers: [
            { providerId: p1, sortOrder: 0 },
            { providerId: p2, sortOrder: 1 },
          ],
        })
      ).status
    ).toBe(200);
    expect(await anchorOf(mountId)).toBe(p1);

    // 锚点成员被标为备用 → 改指第一个非备用成员 p2
    expect(
      (
        await patchMount(mountId, {
          poolMembers: [
            { providerId: p1, sortOrder: 0, standby: true },
            { providerId: p2, sortOrder: 1 },
          ],
        })
      ).status
    ).toBe(200);
    expect(await anchorOf(mountId)).toBe(p2);

    // 显式 providerId 仍是可写成员 → 优先保留（既有调用方兼容）
    expect(
      (
        await patchMount(mountId, {
          providerId: p1,
          poolMembers: [
            { providerId: p1, sortOrder: 0 },
            { providerId: p2, sortOrder: 1 },
          ],
        })
      ).status
    ).toBe(200);
    expect(await anchorOf(mountId)).toBe(p1);

    // 显式 providerId 指向备用成员 → 忽略请求值，派生到第一个非备用成员 p1
    expect(
      (
        await patchMount(mountId, {
          providerId: p2,
          poolMembers: [
            { providerId: p1, sortOrder: 0 },
            { providerId: p2, sortOrder: 1, standby: true },
          ],
        })
      ).status
    ).toBe(200);
    expect(await anchorOf(mountId)).toBe(p1);

    // 清空池（[] = 单桶语义）→ 池内只剩锚点本身，锚点不动，写入仍落锚点
    expect((await patchMount(mountId, { poolMembers: [] })).status).toBe(200);
    expect((await listMounts()).find((m) => m.id === mountId)?.poolMembers.map((m) => m.providerId)).toEqual([
      p1,
    ]);
    expect(await anchorOf(mountId)).toBe(p1);
    const { authCookie } = await registerAndLogin(ctx, 'sb_anchor_user');
    expect((await uploadFile(authCookie, '/sb-anchor', 'x.txt', 'anchor-x')).providerId).toBe(p1);
  });

  it('④ 三桶池含一个备用成员：hash 取模与 round_robin 只在非备用成员上计算（确定性不退化）', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'sb_det_user');

    // hash：取模基准 = 非备用子集（p1/p3），备用桶 p2 不占模位
    const hStandby = await createProvider('sb-det-h-standby');
    const h1 = await createProvider('sb-det-h1');
    const h3 = await createProvider('sb-det-h3');
    await createMount({
      providerId: h1,
      mountPath: '/sb-det-hash',
      name: 'sb-det-hash',
      poolStrategy: 'hash',
      poolMembers: [
        { providerId: h1, sortOrder: 0 },
        { providerId: hStandby, sortOrder: 1, standby: true },
        { providerId: h3, sortOrder: 2 },
      ],
    });
    const hMembers = [h1, h3].sort(byProviderId);
    const dirs = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
    const expected = dirs.map((d) => hMembers[fnv1a(`/${d}`) % hMembers.length]);
    expect(new Set(expected).size).toBe(2);
    for (const [i, dir] of dirs.entries()) {
      await ensureFolder(authCookie, '/sb-det-hash', dir);
      expect((await uploadFile(authCookie, '/sb-det-hash/' + dir, 'x.txt', `det-${dir}`)).providerId).toBe(
        expected[i]
      );
    }

    // round_robin：轮转位只含非备用成员 → 第 1/2/3 个文件依次落 hMembers[0] / hMembers[1] / hMembers[0]
    const rStandby = await createProvider('sb-det-r-standby');
    const r1 = await createProvider('sb-det-r1');
    const r3 = await createProvider('sb-det-r3');
    await createMount({
      providerId: r1,
      mountPath: '/sb-det-rr',
      name: 'sb-det-rr',
      poolStrategy: 'round_robin',
      poolMembers: [
        { providerId: r1, sortOrder: 0 },
        { providerId: rStandby, sortOrder: 1, standby: true },
        { providerId: r3, sortOrder: 2 },
      ],
    });
    const rMembers = [r1, r3].sort(byProviderId);
    const uploaded = [
      (await uploadFile(authCookie, '/sb-det-rr', 'a.txt', 'det-rr-a')).providerId,
      (await uploadFile(authCookie, '/sb-det-rr', 'b.txt', 'det-rr-b')).providerId,
      (await uploadFile(authCookie, '/sb-det-rr', 'c.txt', 'det-rr-c')).providerId,
    ];
    expect(uploaded).toEqual([rMembers[0], rMembers[1], rMembers[0]]);
  });

  it('⑤ 创建：providerId 缺省 = 入池第一个桶；既无 providerId 又无池成员 → 400', async () => {
    const p1 = await createProvider('sb-def1');
    const p2 = await createProvider('sb-def2');
    const created = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: {
        mountPath: '/sb-def',
        name: 'sb-def',
        poolMembers: [
          { providerId: p2, sortOrder: 0 },
          { providerId: p1, sortOrder: 1 },
        ],
      },
    });
    expect(created.status).toBe(201);
    const createdMount = (await json<{ data: { mount: { id: string; providerId: string } } }>(created)).data.mount;
    expect(createdMount.providerId).toBe(p2);
    expect(await anchorOf(createdMount.id)).toBe(p2);

    const none = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { mountPath: '/sb-none', name: 'sb-none' },
    });
    expect(none.status).toBe(400);
    expect((await json<{ error: { code: string } }>(none)).error.code).toBe('VALIDATION_ERROR');
    expect((await listMounts()).some((m) => m.mountPath === '/sb-none')).toBe(false);
  });

  it('⑥ 池内没有非备用成员 → 400 VALIDATION_ERROR 且不落库（POST 与 PATCH 同处校验）', async () => {
    const p1 = await createProvider('sb-val1');
    const p2 = await createProvider('sb-val2');

    // POST：成员全标备用 → 400，挂载点不创建
    const bad = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: {
        providerId: p1,
        mountPath: '/sb-val',
        name: 'sb-val',
        poolMembers: [
          { providerId: p1, standby: true },
          { providerId: p2, standby: true },
        ],
      },
    });
    expect(bad.status).toBe(400);
    const badBody = await json<{ error: { code: string; message: string } }>(bad);
    expect(badBody.error.code).toBe('VALIDATION_ERROR');
    expect(badBody.error.message).toContain('至少需要一个非备用桶用于写入');
    expect((await listMounts()).some((m) => m.mountPath === '/sb-val')).toBe(false);

    // PATCH：把最后一个非备用成员标备用 → 400，成员集与备用标志都不发生部分写入
    const mountId = await createMount({
      providerId: p1,
      mountPath: '/sb-val2',
      name: 'sb-val2',
      poolMembers: [
        { providerId: p1, sortOrder: 0 },
        { providerId: p2, sortOrder: 1 },
      ],
    });
    const badPatch = await patchMount(mountId, {
      poolMembers: [
        { providerId: p1, standby: true },
        { providerId: p2, standby: true },
      ],
    });
    expect(badPatch.status).toBe(400);
    expect((await json<{ error: { code: string } }>(badPatch)).error.code).toBe('VALIDATION_ERROR');
    const rows = ctx.db
      .prepare('SELECT provider_id, standby FROM mount_providers WHERE mount_id = ?')
      .all(mountId) as Array<{ provider_id: string; standby: number }>;
    expect(Object.fromEntries(rows.map((r) => [r.provider_id, Number(r.standby)]))).toEqual({
      [p1]: 0,
      [p2]: 0,
    });
    expect(
      (await listMounts())
        .find((m) => m.id === mountId)
        ?.poolMembers.map((m) => m.providerId)
        .sort(byProviderId)
    ).toEqual([p1, p2].sort(byProviderId));

    // 单成员池把自己标备用 → 同样拒绝（唯一可写成员不能是备用桶）
    expect((await patchMount(mountId, { poolMembers: [{ providerId: p1, standby: true }] })).status).toBe(400);
  });
});
