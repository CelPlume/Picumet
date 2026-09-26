// 成员级 quota_reserved 对账合并「在途会话 + 直写预留台账」，
// 并清理 TTL 之外的滞留台账行（旧实现只按会话重算，会把直写在途预留归零）。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { reconcileQuotas } from '../src/services/cleanup';

let ctx: TestContext;
let adminCookie = '';
let adminCsrf = '';
let adminId = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  const admin = await registerAndLogin(ctx, 'ql_admin');
  adminId = admin.userId;
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'ql_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'ql_admin', password: 'password123' },
  });
  const setCookie = relogin.headers.get('set-cookie') ?? '';
  adminCookie = `auth_token=${setCookie.match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
  adminCsrf = await getCsrf(ctx, adminCookie);
});

describe('直写预留台账', () => {
  it('对账 = 在途会话 + 台账；TTL 之外的滞留台账行被清理', async () => {
    const providerRes = await request(ctx, '/api/admin/storage/providers', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { name: 'ql-provider', bucket: 'ql-bucket' },
    });
    const providerId = ((await json(providerRes)).data as { provider: { id: string } }).provider.id;
    const mountRes = await request(ctx, '/api/admin/mounts', {
      method: 'POST',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body: { providerId, mountPath: '/ql', name: 'ql', priority: 300 },
    });
    const mountId = ((await json(mountRes)).data as { mount: { id: string } }).mount.id;

    const now = Date.now();
    // 在途会话预留 111
    ctx.db
      .prepare(
        `INSERT INTO upload_sessions (id, user_id, mount_id, object_key, path, file_name, file_size, quota_reserved,
           provider_id, status, expires_at, created_at)
         VALUES ('ql-sess', ?, ?, 'k', '/ql', 'f', 111, 111, ?, 'uploading', ?, ?)`
      )
      .run(adminId, mountId, providerId, now + 3_600_000, now);
    // 直写台账 222（有效）+ 333（过期 3 小时 > TTL 2 小时）
    ctx.db
      .prepare(`INSERT INTO quota_reservations (id, mount_id, provider_id, size, created_at) VALUES ('ql-r1', ?, ?, 222, ?)`)
      .run(mountId, providerId, now);
    ctx.db
      .prepare(`INSERT INTO quota_reservations (id, mount_id, provider_id, size, created_at) VALUES ('ql-r2', ?, ?, 333, ?)`)
      .run(mountId, providerId, now - 3 * 3_600_000);

    await reconcileQuotas(ctx.env);

    const member = ctx.db
      .prepare('SELECT quota_reserved FROM mount_providers WHERE mount_id = ? AND provider_id = ?')
      .get(mountId, providerId) as { quota_reserved: number };
    expect(Number(member.quota_reserved)).toBe(111 + 222);

    const stale = ctx.db.prepare(`SELECT COUNT(*) AS c FROM quota_reservations WHERE id = 'ql-r2'`).get() as { c: number };
    expect(Number(stale.c)).toBe(0);
    const active = ctx.db.prepare(`SELECT COUNT(*) AS c FROM quota_reservations WHERE id = 'ql-r1'`).get() as { c: number };
    expect(Number(active.c)).toBe(1);
  });
});
