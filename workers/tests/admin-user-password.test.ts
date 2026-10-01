// 管理端改密（PUT /api/admin/users/:id 的 password 字段）：
// - 改密后新密码可登录、旧密码失效
// - 改密递增 session_version：该用户已签发 JWT 立即失效（与用户端改密同语义）
// - 空串 = 不修改（不误伤存量哈希与在途会话）
// - 长度下限 8 位由 schema 强校验，越界不落库
// - 审计留痕 admin_password_reset（归 admin 分组），且日志不含密码本身
// - 非管理员调用 403（adminMiddleware 门禁）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie: string;
let adminCsrf: string;

async function relogin(username: string): Promise<string> {
  const res = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username, password: 'password123' },
  });
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  return `auth_token=${token?.[1] ?? ''}`;
}

async function adminSetPassword(userId: string, password: string) {
  return request(ctx, `/api/admin/users/${userId}`, {
    method: 'PUT',
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': adminCsrf },
    body: { password },
  });
}

async function loginWith(username: string, password: string) {
  return request(ctx, '/api/auth/login', { method: 'POST', body: { username, password } });
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await registerAndLogin(ctx, 'apw_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'apw_admin'`);
  adminCookie = await relogin('apw_admin');
  adminCsrf = await getCsrf(ctx, adminCookie);
});

describe('管理端改密', () => {
  it('改密后新密码可登录、旧密码失效', async () => {
    const user = await registerAndLogin(ctx, 'apw_target');
    const res = await adminSetPassword(user.userId, 'brand-new-pass');
    expect(res.status).toBe(200);
    expect((await json<{ data: { passwordChanged: boolean } }>(res)).data.passwordChanged).toBe(true);

    expect((await loginWith('apw_target', 'brand-new-pass')).status).toBe(200);
    const old = await loginWith('apw_target', 'password123');
    expect(old.status).toBe(401);
  });

  it('改密使已签发会话立即失效（session_version 递增）', async () => {
    const user = await registerAndLogin(ctx, 'apw_session');
    // 改密前该会话可用
    expect((await request(ctx, '/api/auth/me', { cookie: user.authCookie })).status).toBe(200);
    const before = ctx.db.prepare(`SELECT session_version FROM users WHERE id = ?`).get(user.userId) as { session_version: number };

    await adminSetPassword(user.userId, 'session-buster-1');

    const after = ctx.db.prepare(`SELECT session_version FROM users WHERE id = ?`).get(user.userId) as { session_version: number };
    expect(after.session_version).toBe(before.session_version + 1);
    // 旧 JWT 被 SESSION_REVOKED 拒绝
    const stale = await request(ctx, '/api/auth/me', { cookie: user.authCookie });
    expect(stale.status).toBe(401);
  });

  it('空串 = 不修改：旧密码继续可用且会话不失效', async () => {
    const user = await registerAndLogin(ctx, 'apw_keep');
    const res = await adminSetPassword(user.userId, '');
    expect(res.status).toBe(200);
    expect((await json<{ data: { passwordChanged?: boolean } }>(res)).data.passwordChanged).toBeUndefined();
    expect((await loginWith('apw_keep', 'password123')).status).toBe(200);
    expect((await request(ctx, '/api/auth/me', { cookie: user.authCookie })).status).toBe(200);
  });

  it('长度不足 8 位直接 400 且不落库', async () => {
    const user = await registerAndLogin(ctx, 'apw_short');
    const res = await adminSetPassword(user.userId, 'short7c');
    expect(res.status).toBe(400);
    // 原密码仍有效（未写入）
    expect((await loginWith('apw_short', 'password123')).status).toBe(200);
  });

  it('审计留痕 admin_password_reset，且不记录密码内容', async () => {
    const user = await registerAndLogin(ctx, 'apw_audit');
    await adminSetPassword(user.userId, 'audit-secret-9');
    const row = ctx.db
      .prepare(`SELECT action, path, user_id, metadata FROM access_logs WHERE action = 'admin_password_reset' ORDER BY created_at DESC LIMIT 1`)
      .get() as { action: string; path: string; user_id: string; metadata: string | null } | undefined;
    expect(row?.action).toBe('admin_password_reset');
    expect(row?.path).toBe(`/api/admin/users/${user.userId}`);
    // 操作者是管理员，被操作者是目标用户；密码不出现在任何字段
    expect(row?.user_id).not.toBe(user.userId);
    expect(JSON.stringify(row)).not.toContain('audit-secret-9');
  });

  it('非管理员调用改密 403（adminMiddleware 门禁）', async () => {
    const victim = await registerAndLogin(ctx, 'apw_victim');
    const attacker = await registerAndLogin(ctx, 'apw_attacker');
    const res = await request(ctx, `/api/admin/users/${victim.userId}`, {
      method: 'PUT',
      cookie: attacker.authCookie,
      headers: { 'X-CSRF-Token': await getCsrf(ctx, attacker.authCookie) },
      body: { password: 'pwned-by-attacker' },
    });
    expect(res.status).toBe(403);
    expect((await loginWith('apw_victim', 'password123')).status).toBe(200);
  });
});
