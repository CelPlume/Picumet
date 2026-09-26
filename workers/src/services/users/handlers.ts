// 用户设置路由：个人资料、外观、修改密码、公告撤回
import { Hono } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import type { Db } from '../../db';
import { UserRepo, QuotaRepo, SettingsRepo, AnnouncementRepo, num, str, parseJson } from '../../db';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { verifyPassword, hashPassword, uuid } from '../../utils/crypto';
import { sendMail, resolveSmtpConfig } from '../../utils/smtp';
import { ProfileSchema, PasswordSchema as ChangePasswordSchema, SendOtpSchema, VerifyOtpSchema, DismissAnnouncementSchema } from './schemas';

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
      capabilities: user.capabilities ?? [],
      createdAt: user.createdAt,
    },
    appearance: {
      theme: user.theme,
      accentColor: '#3B82F6',
      blurLevel: 'default',
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
  const { displayName, avatarUrl, locale, theme } = parsed.data;
  const fields: Record<string, unknown> = {};
  if (displayName !== undefined) fields.display_name = displayName || null;
  if (avatarUrl !== undefined) fields.avatar_url = avatarUrl || null;
  if (locale !== undefined) fields.locale = locale;
  if (theme !== undefined) fields.theme = theme;
  await UserRepo.updateUser(db, userId, fields);
  return ok(c, { message: '已保存' });
});

// ============ 修改密码（邮箱验证码） ============

const PASSWORD_CODE_PURPOSE = 'password';
const PASSWORD_CODE_TTL_MS = 5 * 60 * 1000;
const PASSWORD_CODE_MAX_ATTEMPTS = 5;

interface MailSettings {
  raw: Record<string, string>;
  get: (key: string) => unknown;
  host: string;
  fromEmail: string;
  fromName: string;
  /** 发信条件：管理员开启邮件服务且能解析出 SMTP host（设置 → 环境变量回退） */
  enabled: boolean;
}

/** 读取邮件服务设置：system_settings（JSON 值）→ 环境变量回退 */
async function readMailSettings(db: Db, env: Env): Promise<MailSettings> {
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
  const host = String(get('smtp_host') ?? '') || env.SMTP_HOST || '';
  return {
    raw,
    get,
    host,
    fromEmail: String(get('smtp_from_email') ?? '') || env.SMTP_FROM || '',
    fromName: String(get('smtp_from_name') ?? 'Picumet'),
    enabled: String(get('email_enabled') ?? 'false') === 'true' && Boolean(host),
  };
}

/** 按设置解析 SMTP 配置并发信 */
async function sendSettingMail(mail: MailSettings, env: Env, to: string, subject: string, html: string): Promise<void> {
  const smtpConfig = await resolveSmtpConfig(mail.raw, env);
  await sendMail(
    {
      host: smtpConfig?.host ?? mail.host,
      port: smtpConfig?.port ?? Number(mail.get('smtp_port') ?? 587),
      user: smtpConfig?.user ?? (String(mail.get('smtp_user') ?? '') || env.SMTP_USER),
      pass: smtpConfig?.pass ?? (String(mail.get('smtp_password') ?? '') || env.SMTP_PASS),
      from: mail.fromEmail ? `${mail.fromName} <${mail.fromEmail}>` : mail.fromEmail,
    },
    to,
    subject,
    html
  );
}

/** 生成 6 位改密验证码并落库（作废同用户+邮箱+用途的旧行），返回明文码 */
async function issuePasswordCode(db: Db, userId: string, email: string): Promise<string> {
  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  const now = Date.now();
  await db.run(`DELETE FROM email_tokens WHERE user_id = ? AND email = ? AND purpose = ?`, [userId, email, PASSWORD_CODE_PURPOSE]);
  await db.run(
    `INSERT INTO email_tokens (id, user_id, email, code, purpose, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [uuid(), userId, email, code, PASSWORD_CODE_PURPOSE, now + PASSWORD_CODE_TTL_MS, now]
  );
  return code;
}

/** 校验并一次性消费改密验证码；任何失败一律 400 INVALID_OTP（累计 5 次失败即作废） */
async function consumePasswordCode(db: Db, userId: string, code: string): Promise<void> {
  const row = await db.first(
    `SELECT id, code, attempts, expires_at FROM email_tokens
     WHERE user_id = ? AND purpose = ?
     ORDER BY created_at DESC LIMIT 1`,
    [userId, PASSWORD_CODE_PURPOSE]
  );
  if (!row || num(row.expires_at) <= Date.now() || num(row.attempts) >= PASSWORD_CODE_MAX_ATTEMPTS) {
    if (row) await db.run(`DELETE FROM email_tokens WHERE id = ?`, [row.id]);
    throw new ApiError(400, 'INVALID_OTP', '邮箱验证码错误或已过期');
  }
  if (str(row.code) !== code) {
    await db.run(`UPDATE email_tokens SET attempts = attempts + 1 WHERE id = ?`, [row.id]);
    throw new ApiError(400, 'INVALID_OTP', '邮箱验证码错误或已过期');
  }
  await db.run(`DELETE FROM email_tokens WHERE id = ?`, [row.id]);
}

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
  // 邮箱验证码闸门：仅当账号已绑定邮箱且站点启用邮件服务时强制；
  // 否则保持旧行为（只校验旧密码），避免邮件服务未配置时锁死用户。
  const mail = await readMailSettings(db, c.env);
  if (mail.enabled && user.email) {
    if (!parsed.data.emailCode) throw new ApiError(400, 'INVALID_OTP', '邮箱验证码错误或已过期');
    await consumePasswordCode(db, userId, parsed.data.emailCode);
  }
  await UserRepo.updateUser(db, userId, { password_hash: hashPassword(parsed.data.newPassword) });
  // 改密后旧 JWT 立即失效，需重新登录
  await UserRepo.bumpSessionVersion(db, userId);
  return ok(c, { message: '密码已修改，请重新登录' });
});

userRoutes.post('/me/password/send-code', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  if (!user.email) throw ApiError.badRequest('账号未绑定邮箱，无法使用验证码改密');

  const mail = await readMailSettings(db, c.env);
  if (!mail.enabled) throw ApiError.badRequest('邮件服务未启用，请联系管理员');

  const code = await issuePasswordCode(db, userId, user.email);
  try {
    await sendSettingMail(
      mail,
      c.env,
      user.email,
      'Picumet 修改密码验证码',
      `<p>您的修改密码验证码是：<strong>${code}</strong></p><p>验证码 5 分钟内有效，请勿泄露给他人。</p>`
    );
  } catch {
    // 发信失败：清理验证码，避免残留
    await db.run(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?`, [userId, PASSWORD_CODE_PURPOSE]);
    throw new ApiError(500, 'MAIL_ERROR', '验证码发送失败');
  }
  return ok(c, { success: true, expiresIn: 300 });
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

  const mail = await readMailSettings(db, c.env);
  if (!mail.enabled) throw ApiError.badRequest('邮件服务未启用，请联系管理员');

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

  try {
    await sendSettingMail(
      mail,
      c.env,
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

// ============ 公告撤回 ============

// 当前用户已撤回的公告 id 列表（前端据此过滤横幅/弹窗）
// 注意：字面路由注册在任何 /:id 形态路由之前
userRoutes.get('/announcements/dismissed-ids', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  return ok(c, { ids: await AnnouncementRepo.dismissedIds(db, userId) });
});

// 撤回公告：body 可选 { forever?: boolean }（缺省 true＝永久不再提示）；重复撤回幂等
userRoutes.post('/announcements/:id/dismiss', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = DismissAnnouncementSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('请求参数无效');
  const exists = (await AnnouncementRepo.listAll(db)).some((a) => a.id === id);
  if (!exists) throw ApiError.notFound('公告不存在');
  await AnnouncementRepo.dismiss(db, userId, id, parsed.data.forever);
  return ok(c, null);
});
