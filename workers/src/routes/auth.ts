// 认证路由：注册、登录、登出、邮箱验证、密码找回
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { z } from 'zod';
import { UserRepo, QuotaRepo, SettingsRepo, LogRepo } from '../db';
import { hashPassword, verifyPassword, signJwt, randomString } from '../utils/crypto';
import { ApiError } from '../utils/errors';
import { ok, fail } from '../utils/response';
import { getDb, getClientIp } from '../middleware/auth';
import { authRateLimitMiddleware } from '../middleware/rate-limit';
import { issueCsrfToken } from '../middleware/csrf';
import { hasSmtp, sendMail } from '../utils/smtp';

const AUTH_COOKIE = 'auth_token';
const JWT_TTL = 7 * 24 * 3600; // 7 天

const registerSchema = z.object({
  username: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/, '用户名只能包含字母、数字、下划线'),
  password: z.string().min(8).max(128),
  email: z.string().email(),
  inviteCode: z.string().optional(),
  turnstileToken: z.string().optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  turnstileToken: z.string().optional(),
});

function publicUser(user: NonNullable<Awaited<ReturnType<typeof UserRepo.getUserById>>>) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    defaultPath: user.defaultPath,
    locale: user.locale,
    theme: user.theme,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

async function setAuthCookie(c: Parameters<typeof ok>[0], user: { id: string; username: string; role: string }): Promise<void> {
  const token = await signJwt(
    { sub: user.id, username: user.username, role: user.role },
    c.env.JWT_SECRET as string,
    JWT_TTL
  );
  const isSecure = (c.env.ENVIRONMENT as string) === 'production';
  c.header(
    'Set-Cookie',
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${JWT_TTL}${isSecure ? '; Secure' : ''}`
  );
}

export const authRoutes = new Hono<AppBindings>();

authRoutes.post('/register', authRateLimitMiddleware, async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '注册信息无效', parsed.error.flatten());
  }
  const { username, password, email } = parsed.data;

  const allowReg = (await SettingsRepo.get(db, 'allow_registration')) ?? 'true';
  if (allowReg === 'false') {
    throw new ApiError(403, 'FORBIDDEN', '站点当前关闭注册');
  }

  const existingUser = await UserRepo.getUserByUsername(db, username);
  if (existingUser) throw new ApiError(409, 'ALREADY_EXISTS', '用户名已被占用');
  const existingEmail = await UserRepo.getUserByEmail(db, email);
  if (existingEmail) throw new ApiError(409, 'ALREADY_EXISTS', '邮箱已被注册');

  const requireVerify = (await SettingsRepo.get(db, 'require_email_verification')) ?? 'false';
  const user = await UserRepo.createUser(db, {
    username,
    email,
    passwordHash: hashPassword(password),
    role: 'user',
  });

  let emailVerified = false;
  const needsVerify = requireVerify !== 'false';
  if (needsVerify && hasSmtp(c.env)) {
    const token = randomString(40);
    await c.env.KV.put(`email:verify:${token}`, user.id, { expirationTtl: 24 * 3600 });
    const url = `${c.env.APP_BASE_URL}/api/auth/verify-email?token=${token}`;
    await sendMail(
      {
        host: c.env.SMTP_HOST as string,
        port: Number(c.env.SMTP_PORT ?? 587),
        user: c.env.SMTP_USER as string,
        pass: c.env.SMTP_PASS as string,
        from: (c.env.SMTP_FROM as string) ?? 'Picumet <noreply@example.com>',
      },
      user.email,
      'Picumet 邮箱验证',
      `<p>你好 ${user.username}，</p><p>请点击以下链接完成邮箱验证（24 小时内有效）：</p><p><a href="${url}">${url}</a></p>`
    );
  } else if (needsVerify && (c.env.ENVIRONMENT as string) !== 'production') {
    // 开发环境无 SMTP：直接自动验证
    await UserRepo.updateUser(db, user.id, { email_verified: 1 });
    emailVerified = true;
  } else {
    emailVerified = true;
  }

  await LogRepo.create(db, {
    userId: user.id,
    action: 'register',
    path: '/',
    ipAddress: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });

  return ok(
    c,
    {
      user: { ...publicUser(user), emailVerified: emailVerified || user.emailVerified },
      message: '注册成功',
    },
    emailVerified ? '注册成功' : `验证邮件已发送到 ${user.email}`,
    201
  );
});

authRoutes.get('/verify-email', async (c) => {
  const db = getDb(c);
  const token = c.req.query('token');
  if (!token) throw ApiError.badRequest('缺少验证令牌');
  const userId = await c.env.KV.get(`email:verify:${token}`);
  if (!userId) throw ApiError.badRequest('验证链接无效或已过期');
  await UserRepo.updateUser(db, userId, { email_verified: 1 });
  await c.env.KV.delete(`email:verify:${token}`);
  // 返回可读页面
  return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>验证成功</title></head>
    <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f8fa">
      <div style="text-align:center;background:#fff;padding:48px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08)">
        <div style="font-size:48px">✅</div>
        <h2 style="margin:16px 0 8px">邮箱验证成功</h2>
        <p style="color:#666">现在可以登录 Picumet 了。</p>
        <a href="/login" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#3B82F6;color:#fff;border-radius:8px;text-decoration:none">前往登录</a>
      </div>
    </body></html>`);
});

authRoutes.post('/login', authRateLimitMiddleware, async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('请输入用户名和密码');
  const { username, password } = parsed.data;

  const user = await UserRepo.getUserByUsername(db, username);
  if (!user || !verifyPassword(password, user.passwordHash ?? '')) {
    await LogRepo.create(db, {
      userId: user?.id,
      action: 'login_failed',
      path: '/',
      ipAddress: getClientIp(c),
      userAgent: c.req.header('user-agent'),
    });
    throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
  }
  if (user.status !== 'active') {
    throw new ApiError(401, 'USER_DISABLED', '账号已被禁用');
  }
  const requireVerify = (await SettingsRepo.get(db, 'require_email_verification')) ?? 'false';
  if (requireVerify !== 'false' && !user.emailVerified) {
    throw new ApiError(403, 'EMAIL_NOT_VERIFIED', '请先完成邮箱验证');
  }

  await UserRepo.updateUser(db, user.id, { last_login_at: Date.now() });
  await setAuthCookie(c, user);
  await LogRepo.create(db, {
    userId: user.id,
    action: 'login',
    path: '/',
    ipAddress: getClientIp(c),
    userAgent: c.req.header('user-agent'),
  });
  const quota = await QuotaRepo.getQuota(db, user.id);
  return ok(c, {
    user: publicUser(await (UserRepo.getUserById(db, user.id) as Promise<typeof user>)),
    quota,
  });
});

authRoutes.post('/logout', async (c) => {
  c.header('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return ok(c, null);
});

authRoutes.get('/me', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId') as string | undefined;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', '未登录');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(401, 'UNAUTHORIZED', '未登录');
  const quota = await QuotaRepo.getQuota(db, user.id);
  return ok(c, { user: publicUser(user), quota });
});

authRoutes.get('/csrf-token', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', '未登录');
  const token = await issueCsrfToken(c.env.KV as KVNamespace, userId);
  return ok(c, { token });
});

authRoutes.post('/forgot-password', authRateLimitMiddleware, async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const email = body?.email as string | undefined;
  if (!email) throw ApiError.badRequest('请输入邮箱');
  const user = await UserRepo.getUserByEmail(db, email);
  if (!user) {
    // 不暴露用户是否存在
    return ok(c, { message: '如果该邮箱已注册，重置链接已发送' });
  }
  const token = randomString(40);
  await c.env.KV.put(`pwd:reset:${token}`, user.id, { expirationTtl: 15 * 60 });
  const url = `${c.env.APP_BASE_URL}/reset-password?token=${token}`;
  if (hasSmtp(c.env)) {
    await sendMail(
      {
        host: c.env.SMTP_HOST as string,
        port: Number(c.env.SMTP_PORT ?? 587),
        user: c.env.SMTP_USER as string,
        pass: c.env.SMTP_PASS as string,
        from: (c.env.SMTP_FROM as string) ?? 'Picumet <noreply@example.com>',
      },
      user.email,
      'Picumet 密码重置',
      `<p>你好 ${user.username}，</p><p>请点击以下链接重置密码（15 分钟内有效）：</p><p><a href="${url}">${url}</a></p>`
    );
  }
  return ok(c, { message: '如果该邮箱已注册，重置链接已发送' });
});

authRoutes.post('/reset-password', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const token = body?.token as string | undefined;
  const password = body?.password as string | undefined;
  if (!token || !password || password.length < 8) {
    throw ApiError.badRequest('无效的令牌或密码过短');
  }
  const userId = await c.env.KV.get(`pwd:reset:${token}`);
  if (!userId) throw ApiError.badRequest('重置链接无效或已过期');
  await UserRepo.updateUser(db, userId, { password_hash: hashPassword(password) });
  await c.env.KV.delete(`pwd:reset:${token}`);
  return ok(c, { message: '密码已重置，请重新登录' });
});

// 兼容错误响应
export { fail };
