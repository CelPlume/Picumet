// 用户设置路由：个人资料、外观、修改密码
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { UserRepo, QuotaRepo, SettingsRepo, num, str, parseJson } from '../../db';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { verifyPassword, hashPassword, uuid } from '../../utils/crypto';
import { sendMail, resolveSmtpConfig } from '../../utils/smtp';
import { ProfileSchema, PasswordSchema as ChangePasswordSchema, SendOtpSchema, VerifyOtpSchema } from './schemas';

export const userRoutes = new Hono<AppBindings>();

userRoutes.get('/me/settings', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  const quota = await QuotaRepo.getQuota(db, userId);
  return ok(c, {
    profile: {
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      defaultPath: user.defaultPath,
      locale: user.locale,
      role: user.role,
      createdAt: user.createdAt,
    },
    appearance: {
      theme: user.theme,
      accentColor: '#3B82F6',
      enableBlur: true,
    },
    quota,
  });
});

userRoutes.put('/me/settings', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('设置参数无效');
  const { displayName, avatarUrl, locale, theme, defaultPath } = parsed.data;
  const fields: Record<string, unknown> = {};
  if (displayName !== undefined) fields.display_name = displayName || null;
  if (avatarUrl !== undefined) fields.avatar_url = avatarUrl || null;
  if (locale !== undefined) fields.locale = locale;
  if (theme !== undefined) fields.theme = theme;
  if (defaultPath !== undefined) {
    if (!defaultPath.startsWith('/')) throw ApiError.badRequest('默认路径必须以 / 开头');
    fields.default_path = defaultPath;
  }
  await UserRepo.updateUser(db, userId, fields);
  return ok(c, { message: '已保存' });
});

userRoutes.put('/me/password', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const parsed = ChangePasswordSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('密码长度至少 8 位');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  if (!verifyPassword(parsed.data.oldPassword, user.passwordHash ?? '')) {
    throw new ApiError(401, 'INVALID_PASSWORD', '当前密码错误');
  }
  await UserRepo.updateUser(db, userId, { password_hash: hashPassword(parsed.data.newPassword) });
  // 审计 H-05：改密后旧 JWT 立即失效，需重新登录
  await UserRepo.bumpSessionVersion(db, userId);
  return ok(c, { message: '密码已修改，请重新登录' });
});

// ============ OTP 邮箱验证 ============

userRoutes.post('/me/email/send-otp', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const parsed = SendOtpSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('邮箱格式无效');
  const email = parsed.data.email;

  const existing = await UserRepo.getUserByEmail(db, email);
  if (existing && existing.id !== userId) throw ApiError.badRequest('该邮箱已被使用');

  const raw = await SettingsRepo.getAll(db);
  const get = (key: string) => {
    const v = raw[key];
    if (v === undefined || v === 'null') return undefined;
    try {
      return parseJson<unknown>(v, v);
    } catch {
      return v;
    }
  };
  const emailEnabled = String(get('email_enabled') ?? 'false');
  const host = String(get('smtp_host') ?? '') || c.env.SMTP_HOST;
  if (emailEnabled !== 'true' || !host) {
    throw ApiError.badRequest('邮件服务未启用，请联系管理员');
  }

  // 6 位数字验证码
  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000;

  // 删除旧的待验证 token，写入新 token
  await db.run(`DELETE FROM email_tokens WHERE user_id = ? AND email = ? AND purpose = 'verify'`, [userId, email]);
  await db.run(
    `INSERT INTO email_tokens (id, user_id, email, code, purpose, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, 'verify', ?, 0, ?)`,
    [uuid(), userId, email, code, expiresAt, now]
  );

  const fromEmail = String(get('smtp_from_email') ?? '') || c.env.SMTP_FROM || '';
  const fromName = String(get('smtp_from_name') ?? 'Picumet');
  try {
    const smtpConfig = await resolveSmtpConfig(raw as Record<string, unknown>, c.env as unknown as { ENCRYPTION_KEY: string; SMTP_HOST?: string });
    await sendMail(
      {
        host: smtpConfig?.host ?? host,
        port: smtpConfig?.port ?? Number(get('smtp_port') ?? 587),
        user: smtpConfig?.user ?? (String(get('smtp_user') ?? '') || c.env.SMTP_USER),
        pass: smtpConfig?.pass ?? (String(get('smtp_password') ?? '') || c.env.SMTP_PASS),
        from: fromEmail ? `${fromName} <${fromEmail}>` : fromEmail,
      },
      email,
      'Picumet 邮箱验证码',
      `<p>您的邮箱验证码是：<strong>${code}</strong></p><p>验证码 5 分钟内有效，请勿泄露给他人。</p>`
    );
  } catch {
    // 发信失败：清理 token，避免残留
    await db.run(`DELETE FROM email_tokens WHERE user_id = ? AND email = ? AND purpose = 'verify'`, [userId, email]);
    throw new ApiError(500, 'MAIL_ERROR', '验证码发送失败');
  }
  return ok(c, { success: true, expiresIn: 300 });
});

userRoutes.post('/me/email/verify-otp', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const parsed = VerifyOtpSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('验证码格式无效');
  const { email, code } = parsed.data;

  const row = await db.first(
    `SELECT id, code, attempts, expires_at FROM email_tokens
     WHERE user_id = ? AND email = ? AND purpose = 'verify'
     ORDER BY created_at DESC LIMIT 1`,
    [userId, email]
  );
  if (!row || num(row.expires_at) <= Date.now()) {
    if (row) await db.run(`DELETE FROM email_tokens WHERE id = ?`, [row.id]);
    throw ApiError.badRequest('验证码无效或已过期');
  }
  if (num(row.attempts) >= 5) {
    await db.run(`DELETE FROM email_tokens WHERE id = ?`, [row.id]);
    throw ApiError.badRequest('错误次数过多，请重新发送');
  }
  if (str(row.code) !== code) {
    await db.run(`UPDATE email_tokens SET attempts = attempts + 1 WHERE id = ?`, [row.id]);
    throw ApiError.badRequest('验证码错误');
  }
  await UserRepo.updateUser(db, userId, { email, email_verified: 1 });
  await db.run(`DELETE FROM email_tokens WHERE id = ?`, [row.id]);
  return ok(c, { success: true });
});
