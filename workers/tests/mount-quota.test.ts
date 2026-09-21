// 挂载点容量配额：双闸门语义（用户限额 + 挂载容量取交集）、预留累计、中止释放、管理端可见性
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';
let mountSeq = 0;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  // 注册并提升为管理员（复用 api-extras 的提权模式：角色变更后必须重新登录）
  await registerAndLogin(ctx, 'quotaadmin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'quotaadmin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'quotaadmin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/auth_token=([^;]+)/);
  adminCookie = `auth_token=${tokenMatch?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
  expect(adminCookie).toContain('auth_token=');
});

/** 建一个小容量挂载点（复用种子 R2 绑定 provider），返回挂载 id */
async function createSmallMount(maxBytes: number): Promise<string> {
  mountSeq += 1;
  const provRes = await request(ctx, '/api/admin/storage/providers', { cookie: adminCookie });
  expect(provRes.status).toBe(200);
  const providerId = (await json(provRes)).data.providers[0].id;
  const res = await request(ctx, '/api/admin/mounts', {
    method: 'POST',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: {
      providerId,
      mountPath: `/qtest-${mountSeq}`,
      name: `quota-test-${mountSeq}`,
      maxStorage: maxBytes,
      // 高于种子根挂载（priority 100），确保 findMountForPath 命中本挂载
      priority: 200,
    },
  });
  expect(res.status).toBe(201);
  return (await json(res)).data.mount.id;
}

async function initUpload(authCookie: string, csrf: string, mountPath: string, fileName: string, fileSize: number) {
  return request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: `${mountPath}/`, fileName, fileSize, mimeType: 'application/octet-stream' },
  });
}

describe('挂载点容量配额', () => {
  it('超过挂载容量的上传初始化被拒绝（MOUNT_QUOTA_EXCEEDED）', async () => {
    await createSmallMount(2000);
    const { authCookie } = await registerAndLogin(ctx, 'mountuser1');
    const csrf = await getCsrf(ctx, authCookie);

    const res = await initUpload(authCookie, csrf, `/qtest-${mountSeq}`, 'big.bin', 5000);
    expect(res.status).toBe(413);
    const data = await json(res);
    expect(data.error.code).toBe('MOUNT_QUOTA_EXCEEDED');
  });

  it('在途预留累计计入挂载容量：第二次预留不足被拒', async () => {
    await createSmallMount(2000);
    const { authCookie } = await registerAndLogin(ctx, 'mountuser2');
    const csrf = await getCsrf(ctx, authCookie);
    const path = `/qtest-${mountSeq}`;

    const first = await initUpload(authCookie, csrf, path, 'a.bin', 1200);
    expect(first.status).toBe(200);
    const firstId = (await json(first)).data.sessionId;

    const second = await initUpload(authCookie, csrf, path, 'b.bin', 1200);
    expect(second.status).toBe(413);
    expect((await json(second)).error.code).toBe('MOUNT_QUOTA_EXCEEDED');

    // 用户限额（1GiB）远未触顶 → 排除用户层误伤，确认是挂载闸门拦截
    const third = await initUpload(authCookie, csrf, '/', 'c.bin', 1200);
    expect(third.status).toBe(200);

    void firstId;
  });

  it('中止会话释放挂载预留，容量立即可复用', async () => {
    await createSmallMount(2000);
    const { authCookie, userId } = await registerAndLogin(ctx, 'mountuser3');
    const csrf = await getCsrf(ctx, authCookie);
    const path = `/qtest-${mountSeq}`;

    const first = await initUpload(authCookie, csrf, path, 'a.bin', 1500);
    expect(first.status).toBe(200);
    const sessionId = (await json(first)).data.sessionId;

    // 中止 → 预留释放
    const abortRes = await request(ctx, `/api/files/upload/multipart/${sessionId}`, {
      method: 'DELETE',
      cookie: authCookie,
      headers: { 'X-CSRF-Token': csrf },
    });
    expect(abortRes.status).toBe(200);

    // 释放后 1500 可再次预留
    const retry = await initUpload(authCookie, csrf, path, 'b.bin', 1500);
    expect(retry.status).toBe(200);

    // 管理端可见：挂载预留归零（仅一个在途会话）
    const mountsRes = await request(ctx, '/api/admin/mounts', { cookie: adminCookie });
    const mounts = (await json(mountsRes)).data.mounts as Array<{ mountPath: string; maxStorage: number | null; usedStorage: number; quotaReserved: number }>;
    const target = mounts.find((m) => m.mountPath === path);
    expect(target).toBeTruthy();
    expect(target?.maxStorage).toBe(2000);
    expect(target?.usedStorage).toBe(0);
    expect(target?.quotaReserved).toBe(1500);
    void userId;
  });

  it('挂载容量为 null（不限）时可正常预留', async () => {
    mountSeq += 1;
    const provRes = await request(ctx, '/api/admin/storage/providers', { cookie: adminCookie });
    const providerId = (await json(provRes)).data.providers[0].id;
    const res = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { providerId, mountPath: `/qtest-${mountSeq}`, name: `quota-unlimited-${mountSeq}`, priority: 200 },
    });
    expect(res.status).toBe(201);
    expect((await json(res)).data.mount.maxStorage).toBeNull();

    const { authCookie } = await registerAndLogin(ctx, 'mountuser4');
    const csrf = await getCsrf(ctx, authCookie);
    const ok = await initUpload(authCookie, csrf, `/qtest-${mountSeq}`, 'a.bin', 1024 * 1024 * 2);
    expect(ok.status).toBe(200);
  });

  it('maxStorage 必须为正整数（0 与负数被拒绝）', async () => {
    mountSeq += 1;
    const provRes = await request(ctx, '/api/admin/storage/providers', { cookie: adminCookie });
    const providerId = (await json(provRes)).data.providers[0].id;
    const res = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { providerId, mountPath: `/qtest-${mountSeq}`, name: `quota-bad-${mountSeq}`, maxStorage: 0 },
    });
    expect(res.status).toBe(400);
  });

  it('新用户默认限额为 1GiB', async () => {
    const { authCookie, userId } = await registerAndLogin(ctx, 'onegiguser');
    const meRes = await request(ctx, '/api/auth/me', { cookie: authCookie });
    const me = await json(meRes);
    expect(me.data.quota.maxStorage).toBe(1073741824);
    void userId;
  });
});
