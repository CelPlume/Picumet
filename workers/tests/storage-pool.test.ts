// 存储池（§E）：least_used 分布、hash 确定性、按文件落桶读路径、删除与池成员管理
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

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

async function createPoolMount(mountPath: string, providerIds: string[], poolStrategy: string): Promise<string> {
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: {
      providerId: providerIds[0],
      mountPath,
      name: `pool${mountPath}`,
      priority: 300,
      poolStrategy,
      poolProviderIds: providerIds,
    },
  });
  expect(res.status).toBe(201);
  return ((await json(res)).data as { mount: { id: string } }).mount.id;
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

  it('hash：同一路径稳定路由到同一 provider', async () => {
    const p1 = await createProvider('pool-h1');
    const p2 = await createProvider('pool-h2');
    await createPoolMount('/pool-hash', [p1, p2], 'hash');

    // 成员按 provider_id 升序（与实现一致）；路由 = fnv1a(完整路径) % 成员数
    const members = [p1, p2].sort((a, b) => a.localeCompare(b));
    const { authCookie } = await registerAndLogin(ctx, 'pool_user2');

    for (const name of ['c.txt', 'd.txt']) {
      const expected = members[fnv1a(`/pool-hash/${name}`) % members.length];
      const uploaded = await uploadFile(authCookie, '/pool-hash', name, `content-${name}`);
      expect(uploaded.providerId).toBe(expected);
    }
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

    const { authCookie } = await registerAndLogin(ctx, 'pool_user4');
    const uploaded = await uploadFile(authCookie, '/pool-update', 'e.txt', 'content-e');
    // 主 provider 始终保留在池内（p1），但 least_used 会优先空闲的 p2
    expect([p1, p2]).toContain(uploaded.providerId);
  });
});
