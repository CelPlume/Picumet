// 待验证注册（迁移 0016）：邮箱验证完成前**不得落库 users**，消除「注册说占用 / 登录进不去」死循环
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 测试环境无法真实连 SMTP：桩掉发送通道，只验证「pending → 核销建号」的落库时序
vi.mock('../src/utils/smtp', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/utils/smtp');
  return { ...actual, sendMail: vi.fn(async () => undefined) };
});
import { createTestContext, request, initSeeded, type TestContext } from './helpers';
import { Db } from '../src/db';
import { invalidateSettingsCache } from '../src/db/repos/system';

function dbi(ctx: TestContext): Db {
  return Db.fromAny(ctx.env.DB as D1Database);
}

async function countRows(ctx: TestContext, table: string): Promise<number> {
  const row = await dbi(ctx).first(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number(row?.c ?? 0);
}

/** 直接写注册验证码（测试环境无 SMTP，走 send-otp 会 400） */
async function seedOtp(ctx: TestContext, email: string, code = '123456'): Promise<void> {
  await dbi(ctx).run(
    `INSERT INTO email_tokens (id, user_id, email, code, purpose, expires_at, attempts, created_at)
     VALUES (?, 'register', ?, ?, 'register', ?, 0, ?)`,
    [crypto.randomUUID(), email, code, Date.now() + 300_000, Date.now()]
  );
}

/** 让测试环境进入「生产 + 有 SMTP」形态，从而走待验证注册分支 */
async function enableVerifyFlow(ctx: TestContext): Promise<void> {
  (ctx.env as unknown as Record<string, unknown>).ENVIRONMENT = 'production';
  (ctx.env as unknown as Record<string, unknown>).SMTP_HOST = 'smtp.test.local';
  (ctx.env as unknown as Record<string, unknown>).SMTP_PORT = '465';
  (ctx.env as unknown as Record<string, unknown>).SMTP_FROM = 'no-reply@test.local';
  await dbi(ctx).run(`UPDATE system_settings SET value = ? WHERE key = 'require_email_verification'`, ['true']);
  invalidateSettingsCache();
  // 邮件通道在测试里不可用：让 sendMail 的失败路径不阻塞（pending 行已在写库后才删，
  // 因此这里改为断言 pending 已写、随后手工核销）
}

async function setVerify(ctx: TestContext, on: boolean): Promise<void> {
  await dbi(ctx).run(`UPDATE system_settings SET value = ? WHERE key = 'require_email_verification'`, [
    on ? 'true' : 'false',
  ]);
  invalidateSettingsCache();
}

describe('待验证注册：不落库 + 点链接才建号', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
    await initSeeded(ctx);
    await setVerify(ctx, false);
  });

  it('要求邮箱验证时：/register 只写 pending，users 行数不变', async () => {
    await enableVerifyFlow(ctx);
    await seedOtp(ctx, 'pend@test.local');
    const usersBefore = await countRows(ctx, 'users');

    const res = await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'penduser', password: 'Pass12345', email: 'pend@test.local', emailCode: '123456' },
    });
    expect(res.status).toBe(201);
    expect((await res.json() as never as { data: { pending: boolean } }).data.pending).toBe(true);

    // 关键断言：users 没有新增任何行（未验证不得落库）
    expect(await countRows(ctx, 'users')).toBe(usersBefore);
    const pending = await dbi(ctx).first(`SELECT username FROM pending_registrations LIMIT 1`);
    expect(String(pending?.username)).toBe('penduser');
  });

  it('点验证链接后才建号，且 email_verified=1', async () => {
    await enableVerifyFlow(ctx);
    await seedOtp(ctx, 'redeem@test.local');
    await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'redeemuser', password: 'Pass12345', email: 'redeem@test.local', emailCode: '123456' },
    });
    const row = await dbi(ctx).first(`SELECT token FROM pending_registrations LIMIT 1`);
    const token = String(row?.token ?? '');
    expect(token).not.toBe('');

    const before = await countRows(ctx, 'users');
    const res = await request(ctx, `/api/auth/verify-email?token=${token}`);
    expect(res.status).toBe(200);
    expect(await countRows(ctx, 'users')).toBe(before + 1);

    const user = await dbi(ctx).first(`SELECT email_verified FROM users WHERE username = 'redeemuser'`);
    expect(Number(user?.email_verified)).toBe(1);
    expect(await countRows(ctx, 'pending_registrations')).toBe(0);
  });

  it('核销后可直接登录（无死循环）', async () => {
    await enableVerifyFlow(ctx);
    await seedOtp(ctx, 'loginfresh@test.local');
    await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'loginfresh', password: 'Pass12345', email: 'loginfresh@test.local', emailCode: '123456' },
    });
    const row = await dbi(ctx).first(`SELECT token FROM pending_registrations LIMIT 1`);
    await request(ctx, `/api/auth/verify-email?token=${String(row?.token)}`);

    const login = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'loginfresh', password: 'Pass12345' },
    });
    expect(login.status).toBe(200);
  });

  it('不要求邮箱验证时：当场建号（行为不回退）', async () => {
    const res = await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'directuser', password: 'Pass12345', email: 'direct@test.local' },
    });
    expect(res.status).toBe(201);
    expect(await dbi(ctx).first(`SELECT id FROM users WHERE username = 'directuser'`)).toBeTruthy();
    expect(await countRows(ctx, 'pending_registrations')).toBe(0);
  });

  it('同一标识在 pending 期被占用：再次注册报 409', async () => {
    await enableVerifyFlow(ctx);
    await seedOtp(ctx, 'dupe@test.local');
    const first = await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'dupeuser', password: 'Pass12345', email: 'dupe@test.local', emailCode: '123456' },
    });
    expect(first.status).toBe(201);
    // 第一次核销 OTP 后验证码即失效，第二次需重新发码（否则会先被 OTP 门控拦下）
    await seedOtp(ctx, 'dupe@test.local', '654321');
    const second = await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'dupeuser', password: 'Pass12345', email: 'dupe@test.local', emailCode: '654321' },
    });
    expect(second.status).toBe(409);
    expect(await countRows(ctx, 'pending_registrations')).toBe(1);
  });

  it('过期令牌：返回可读失败页且不建号', async () => {
    await enableVerifyFlow(ctx);
    await seedOtp(ctx, 'exp@test.local');
    await request(ctx, '/api/auth/register', {
      method: 'POST',
      body: { username: 'expuser', password: 'Pass12345', email: 'exp@test.local', emailCode: '123456' },
    });
    await dbi(ctx).run(`UPDATE pending_registrations SET expires_at = ? WHERE username = 'expuser'`, [Date.now() - 1000]);
    const row = await dbi(ctx).first(`SELECT token FROM pending_registrations LIMIT 1`);
    const before = await countRows(ctx, 'users');
    const res = await request(ctx, `/api/auth/verify-email?token=${String(row?.token)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('过期');
    expect(await countRows(ctx, 'users')).toBe(before);
  });

  it('无效令牌：返回可读失败页而非 500', async () => {
    const res = await request(ctx, '/api/auth/verify-email?token=bogus-token');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('无效');
  });

  it('缺少令牌：返回可读失败页', async () => {
    const res = await request(ctx, '/api/auth/verify-email');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('验证令牌');
  });
});