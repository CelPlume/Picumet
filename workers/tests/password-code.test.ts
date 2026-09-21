// 修改密码邮箱验证码：send-code 下发 6 位码（email_tokens purpose='password'），
// PUT /me/password 在「账号已绑定邮箱 + 站点启用邮件服务」时强制校验；否则回退为只校验旧密码。
// 发信统一 mock（不触网），验证码从 email_tokens 读取。
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
// 命名空间导入仅用于类型位（vi.mock 的 importOriginal 需要模块类型）
import * as smtp from '../src/utils/smtp';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

const { sendMailMock } = vi.hoisted(() => ({
  sendMailMock: vi.fn(async (_config: smtp.SmtpConfig, _to: string, _subject: string, _html: string) => undefined),
}));

vi.mock('../src/utils/smtp', async (importOriginal) => {
  const actual = await importOriginal<typeof smtp>();
  return { ...actual, sendMail: sendMailMock };
});

interface PasswordTokenRow {
  code: string;
  purpose: string;
  expires_at: number;
  attempts: number;
}

interface ApiErrorBody {
  error: { code: string; message: string };
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockImplementation(async () => undefined);
  ctx.db.prepare('DELETE FROM email_tokens').run();
  // 复原上一用例构造的「无邮箱」用户，避免 email 唯一约束冲突
  ctx.db.prepare(`UPDATE users SET email = username || '@test.local' WHERE email = ''`).run();
  setSetting('email_enabled', 'false');
  setSetting('smtp_host', '""');
  setSetting('smtp_from_email', '"noreply@test.local"');
});

function setSetting(key: string, value: string): void {
  ctx.db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, Date.now());
}

function enableMailService(): void {
  setSetting('email_enabled', 'true');
  setSetting('smtp_host', '"smtp.test"');
}

function passwordTokenRow(userId: string): PasswordTokenRow | undefined {
  return ctx.db
    .prepare(
      `SELECT code, purpose, expires_at, attempts FROM email_tokens
       WHERE user_id = ? AND purpose = 'password' ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId) as PasswordTokenRow | undefined;
}

function sessionVersion(userId: string): number {
  const row = ctx.db.prepare('SELECT session_version FROM users WHERE id = ?').get(userId) as { session_version: number };
  return row.session_version;
}

async function login(username: string, password: string): Promise<{ status: number; cookie: string }> {
  const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username, password } });
  const token = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[1];
  return { status: res.status, cookie: token ? `auth_token=${token}` : '' };
}

async function changePassword(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return request(ctx, '/api/users/me/password', {
    method: 'PUT',
    cookie,
    headers: { 'X-CSRF-Token': await getCsrf(ctx, cookie) },
    body,
  });
}

async function sendCode(cookie: string): Promise<Response> {
  return request(ctx, '/api/users/me/password/send-code', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': await getCsrf(ctx, cookie) },
  });
}

async function sendEmailOtp(cookie: string, email: string): Promise<Response> {
  return request(ctx, '/api/users/me/email/send-otp', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': await getCsrf(ctx, cookie) },
    body: { email },
  });
}

describe('邮箱验证码闸门（邮件服务启用 + 账号有邮箱）', () => {
  it('send-code 下发 6 位码、发信主题与正文、5 分钟有效', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_send');

    const res = await sendCode(authCookie);
    expect(res.status).toBe(200);
    expect((await json<{ data: { success: boolean; expiresIn: number } }>(res)).data).toEqual({ success: true, expiresIn: 300 });

    const row = passwordTokenRow(userId);
    expect(row?.purpose).toBe('password');
    expect(row?.code).toMatch(/^\d{6}$/);
    expect(row?.attempts).toBe(0);
    const ttl = (row?.expires_at ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = sendMailMock.mock.calls[0];
    expect(to).toBe('pc_send@test.local');
    expect(subject).toBe('Picumet 修改密码验证码');
    expect(html).toContain(row?.code ?? '');
    expect(html).toContain('5 分钟');
  });

  it('重复 send-code 只保留最新一条码', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_resend');
    await sendCode(authCookie);
    await sendCode(authCookie);

    const countRow = ctx.db.prepare(`SELECT COUNT(*) AS c FROM email_tokens WHERE user_id = ? AND purpose = 'password'`).get(userId) as {
      c: number;
    };
    expect(countRow.c).toBe(1);

    const res = await changePassword(authCookie, {
      oldPassword: 'password123',
      newPassword: 'newpassword456',
      emailCode: passwordTokenRow(userId)?.code ?? '',
    });
    expect(res.status).toBe(200);
  });

  it('未带验证码 → 400 且密码与会话版本不变', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_nocode');
    const before = sessionVersion(userId);

    const res = await changePassword(authCookie, { oldPassword: 'password123', newPassword: 'newpassword456' });
    expect(res.status).toBe(400);
    expect((await json<ApiErrorBody>(res)).error.code).toBe('INVALID_OTP');

    expect(sessionVersion(userId)).toBe(before);
    expect((await login('pc_nocode', 'password123')).status).toBe(200);
    expect((await login('pc_nocode', 'newpassword456')).status).toBe(401);
  });

  it('验证码错误 → 400 INVALID_OTP，密码不变', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_badcode');
    await sendCode(authCookie);
    const code = passwordTokenRow(userId)?.code ?? '';
    const wrong = code === '111111' ? '222222' : '111111';

    const res = await changePassword(authCookie, { oldPassword: 'password123', newPassword: 'newpassword456', emailCode: wrong });
    expect(res.status).toBe(400);
    expect((await json<ApiErrorBody>(res)).error.code).toBe('INVALID_OTP');
    expect((await login('pc_badcode', 'password123')).status).toBe(200);
    expect((await login('pc_badcode', 'newpassword456')).status).toBe(401);
  });

  it('正确验证码 → 改密成功、会话版本递增、旧密码失效，且码一次性消费', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_ok');
    const before = sessionVersion(userId);

    await sendCode(authCookie);
    const code = passwordTokenRow(userId)?.code ?? '';

    const res = await changePassword(authCookie, { oldPassword: 'password123', newPassword: 'newpassword456', emailCode: code });
    expect(res.status).toBe(200);
    expect((await json<{ data: { message: string } }>(res)).data.message).toBe('密码已修改，请重新登录');
    expect(sessionVersion(userId)).toBe(before + 1);
    expect(passwordTokenRow(userId)).toBeUndefined();
    expect((await login('pc_ok', 'password123')).status).toBe(401);
    expect((await login('pc_ok', 'newpassword456')).status).toBe(200);

    // 一次性：同一码再次使用被拒（先重新登录取得新会话）
    const relogin = await login('pc_ok', 'newpassword456');
    const again = await changePassword(relogin.cookie, {
      oldPassword: 'newpassword456',
      newPassword: 'thirdpassword789',
      emailCode: code,
    });
    expect(again.status).toBe(400);
    expect((await json<ApiErrorBody>(again)).error.code).toBe('INVALID_OTP');
  });

  it('过期验证码 → 400 INVALID_OTP', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_expired');
    await sendCode(authCookie);
    const code = passwordTokenRow(userId)?.code ?? '';
    ctx.db.prepare('UPDATE email_tokens SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, userId);

    const res = await changePassword(authCookie, { oldPassword: 'password123', newPassword: 'newpassword456', emailCode: code });
    expect(res.status).toBe(400);
    expect((await json<ApiErrorBody>(res)).error.code).toBe('INVALID_OTP');
  });

  it('连续 5 次错误后作废该码', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_attempts');
    await sendCode(authCookie);
    const code = passwordTokenRow(userId)?.code ?? '';
    const wrong = code === '111111' ? '222222' : '111111';

    for (let i = 0; i < 5; i++) {
      const res = await changePassword(authCookie, { oldPassword: 'password123', newPassword: 'newpassword456', emailCode: wrong });
      expect(res.status).toBe(400);
    }
    const res = await changePassword(authCookie, { oldPassword: 'password123', newPassword: 'newpassword456', emailCode: code });
    expect(res.status).toBe(400);
    expect(passwordTokenRow(userId)).toBeUndefined();
  });
});

describe('回退行为（不锁死用户）', () => {
  it('邮件服务未启用：不带验证码也能改密', async () => {
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_nomail');
    const before = sessionVersion(userId);

    const res = await changePassword(authCookie, { oldPassword: 'password123', newPassword: 'newpassword456' });
    expect(res.status).toBe(200);
    expect(sessionVersion(userId)).toBe(before + 1);
    expect((await login('pc_nomail', 'password123')).status).toBe(401);
    expect((await login('pc_nomail', 'newpassword456')).status).toBe(200);
  });

  it('邮件服务启用但账号未绑定邮箱：不带验证码也能改密', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_noemail');
    ctx.db.prepare(`UPDATE users SET email = '' WHERE id = ?`).run(userId);

    const res = await changePassword(authCookie, { oldPassword: 'password123', newPassword: 'newpassword456' });
    expect(res.status).toBe(200);
  });
});

describe('send-code 前置校验', () => {
  it('邮件服务未启用 → 400', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'pc_off');
    const res = await sendCode(authCookie);
    expect(res.status).toBe(400);
    expect((await json<ApiErrorBody>(res)).error.message).toBe('邮件服务未启用，请联系管理员');
  });

  it('账号未绑定邮箱 → 400', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_sc_noemail');
    ctx.db.prepare(`UPDATE users SET email = '' WHERE id = ?`).run(userId);

    const res = await sendCode(authCookie);
    expect(res.status).toBe(400);
    expect((await json<ApiErrorBody>(res)).error.message).toBe('账号未绑定邮箱，无法使用验证码改密');
  });

  it('发信失败 → 500 MAIL_ERROR 且验证码被清理', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_mailfail');
    sendMailMock.mockRejectedValueOnce(new Error('smtp down'));

    const res = await sendCode(authCookie);
    expect(res.status).toBe(500);
    expect((await json<ApiErrorBody>(res)).error.code).toBe('MAIL_ERROR');
    expect(passwordTokenRow(userId)).toBeUndefined();
  });
});

describe('未登录访问', () => {
  it('两个端点均 401', async () => {
    const put = await request(ctx, '/api/users/me/password', {
      method: 'PUT',
      body: { oldPassword: 'password123', newPassword: 'newpassword456' },
    });
    expect(put.status).toBe(401);

    const post = await request(ctx, '/api/users/me/password/send-code', { method: 'POST' });
    expect(post.status).toBe(401);
  });
});

// /me/email/send-otp 与改密共用邮件设置判定，此处锁住其对外行为未被改动
describe('send-otp（邮箱验证用途）行为不变', () => {
  it('邮件服务启用 → 落 purpose=verify 的码并发信', async () => {
    enableMailService();
    const { userId, authCookie } = await registerAndLogin(ctx, 'pc_otp');

    const res = await sendEmailOtp(authCookie, 'pc_otp@test.local');
    expect(res.status).toBe(200);

    const row = ctx.db.prepare(`SELECT purpose FROM email_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).get(userId) as
      | { purpose: string }
      | undefined;
    expect(row?.purpose).toBe('verify');
    expect(sendMailMock.mock.calls[0][2]).toBe('Picumet 邮箱验证码');
  });

  it('邮件服务未启用 → 400', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'pc_otp_off');
    const res = await sendEmailOtp(authCookie, 'pc_otp_off@test.local');
    expect(res.status).toBe(400);
    expect((await json<ApiErrorBody>(res)).error.message).toBe('邮件服务未启用，请联系管理员');
  });
});
