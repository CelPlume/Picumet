// 登录支持「用户名或邮箱」同一输入框（UserRepo.findByLoginIdentifier 收敛）：
// - 用户名登录路径走 findByLoginIdentifier 的 username 分支
// - 邮箱可登录；邮箱列 BINARY 排序，补一次小写匹配（注册按原样存储大小写混合邮箱）
// - 标识两端空白被裁剪（复制粘贴友好）
// - 错误密码与不存在的标识回同一错误码/文案（不泄露账号是否存在）
// - login_failed 审计对邮箱登录同样落库
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, type TestContext } from './helpers';

let ctx: TestContext;

async function login(identifier: string, password: string) {
  return request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: identifier, password },
  });
}

function authCookieOf(res: Response): string {
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  return `auth_token=${token?.[1] ?? ''}`;
}

async function register(username: string, email: string): Promise<void> {
  const res = await request(ctx, '/api/auth/register', {
    method: 'POST',
    body: { username, password: 'password123', email },
  });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  await register('li_plain', 'li_plain@test.local');
  await register('li_mixed', 'Li.Mixed@Test.local');
});

describe('登录标识：用户名或邮箱', () => {
  it('用户名登录仍可用（回归）', async () => {
    const res = await login('li_plain', 'password123');
    expect(res.status).toBe(200);
    const body = await json<{ data: { user: { username: string; email: string } } }>(res);
    expect(body.data.user.username).toBe('li_plain');
    expect(body.data.user.email).toBe('li_plain@test.local');
  });

  it('邮箱可登录并回填同一账号', async () => {
    const res = await login('li_plain@test.local', 'password123');
    expect(res.status).toBe(200);
    const body = await json<{ data: { user: { username: string } } }>(res);
    expect(body.data.user.username).toBe('li_plain');
    // 签发的会话可用
    expect((await request(ctx, '/api/auth/me', { cookie: authCookieOf(res) })).status).toBe(200);
  });

  it('邮箱大小写不敏感：大小写混合注册的邮箱可用小写登录', async () => {
    const res = await login('li.mixed@test.local', 'password123');
    expect(res.status).toBe(200);
    const body = await json<{ data: { user: { username: string } } }>(res);
    expect(body.data.user.username).toBe('li_mixed');
  });

  it('标识两端空白被裁剪', async () => {
    expect((await login('  li_plain  ', 'password123')).status).toBe(200);
    expect((await login('  li_plain@test.local  ', 'password123')).status).toBe(200);
  });

  it('邮箱 + 错误密码 → 401 INVALID_CREDENTIALS（与用户名路径同码同文案）', async () => {
    const res = await login('li_plain@test.local', 'wrong-password');
    expect(res.status).toBe(401);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    expect(body.error.message).toBe('用户名或密码错误');
  });

  it('不存在的标识与错误密码回同一错误（不泄露账号是否存在）', async () => {
    const unknownUser = await login('no_such_user_xyz', 'password123');
    const unknownEmail = await login('no-such-user@test.local', 'password123');
    const wrongPass = await login('li_plain', 'wrong-password');
    let firstMessage = '';
    for (const res of [unknownUser, unknownEmail, wrongPass]) {
      expect(res.status).toBe(401);
      const body = await json<{ error: { code: string; message: string } }>(res);
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
      if (firstMessage === '') firstMessage = body.error.message;
      else expect(body.error.message).toBe(firstMessage);
    }
    expect(firstMessage).toBe('用户名或密码错误');
  });

  it('login_failed 审计对邮箱登录同样落库（记录已解析到的用户）', async () => {
    const before = ctx.db.prepare(`SELECT COUNT(*) AS n FROM access_logs WHERE action = 'login_failed'`).get() as { n: number };
    expect((await login('li_plain@test.local', 'wrong-password')).status).toBe(401);
    const row = ctx.db
      .prepare(`SELECT user_id FROM access_logs WHERE action = 'login_failed' ORDER BY created_at DESC LIMIT 1`)
      .get() as { user_id: string | null };
    const user = ctx.db.prepare(`SELECT id FROM users WHERE username = 'li_plain'`).get() as { id: string };
    // 用户已定位到，审计带上 user_id（便于按用户排查暴力破解）
    expect(row.user_id).toBe(user.id);
    const after = ctx.db.prepare(`SELECT COUNT(*) AS n FROM access_logs WHERE action = 'login_failed'`).get() as { n: number };
    expect(after.n).toBe(before.n + 1);
  });

  it('空标识 / 空密码仍被拦下：空串 400，纯空白回统一 401（不与「账号不存在」区分）', async () => {
    expect((await login('', 'password123')).status).toBe(400);
    expect((await login('li_plain', '')).status).toBe(400);
    // 纯空白：schema 的 min(1) 放行（长度 3），裁剪后为空 → 与「标识不存在」同一 401，不泄露差异
    const blank = await login('   ', 'password123');
    expect(blank.status).toBe(401);
    expect((await json<{ error: { code: string } }>(blank)).error.code).toBe('INVALID_CREDENTIALS');
  });
});
