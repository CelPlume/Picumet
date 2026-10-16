// 认证路由：注册、登录、登出、邮箱验证、密码找回
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { UserRepo, QuotaRepo, SettingsRepo, LogRepo, PendingRegistrationRepo } from '../../db';
import { z } from 'zod';
import { hashPassword, verifyPassword, verifyJwt, randomString, randomDigits, encryptSecret, decryptSecret } from '../../utils/crypto';
import { ApiError } from '../../shared/errors';
import { ok, fail } from '../../shared/response';
import { getDb } from '../../middleware/auth';
import { requestIp } from '../../utils/ip';
import { authRateLimitMiddleware, checkRegisterSuccessLimit, rateLimitsEnforced } from '../../middleware/rate-limit';
import { issueCsrfToken } from '../../middleware/csrf';
import { hasSmtp, sendMail, resolveSmtpConfig } from '../../utils/smtp';
import {
  renderRegisterOtpMail,
  renderVerifyEmailMail,
  renderPasswordResetMail,
  type MailBrand,
} from '../../utils/email-template';
import { RegisterSchema, LoginSchema, ForgotPasswordSchema, ResetPasswordSchema } from './schemas';
import { loadInviteSettings, resolveInviteCode } from '../invites/invites';
import { AUTH_COOKIE, setAuthCookie } from './session';
import { toPublicUser } from './public-user';
import { verifyTotpOrBackupCode } from './totp-verify';
import { assertCaptcha } from '../captcha';

export const authRoutes = new Hono<AppBindings>();

/** 设置值按 JSON 存储（种子写 '"..."'），解析失败回退原值 */
function parseJsonSafe(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** 邮件品牌（与站点 UI 同源）：站点标题 / Logo / 强调色 */
async function loadMailBrand(raw: Record<string, unknown>, baseUrl?: string): Promise<MailBrand> {
  const read = (key: string): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === null || v === 'null') return undefined;
    const parsed = parseJsonSafe(v);
    return typeof parsed === 'string' ? parsed : undefined;
  };
  return {
    siteTitle: read('site_title') || 'Picumet',
    siteLogo: read('site_logo'),
    siteUrl: read('return_url') || read('upload_url') || baseUrl,
    primary: read('accent_color'),
  };
}

// 注册邮箱验证码发送
authRoutes.post('/register/send-otp', authRateLimitMiddleware, async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ email: z.string().email() }).safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('邮箱格式无效');
  const email = parsed.data.email.toLowerCase();
  // 大小写无关：同一邮箱的大小写变体不得重复注册（否则登录按 lower(email) 解析会出现歧义）
  const existing = await UserRepo.findByEmailInsensitive(db, email);
  if (existing) throw new ApiError(409, 'ALREADY_EXISTS', '邮箱已被注册');
  const raw = await SettingsRepo.getAll(db);
  const smtp = await resolveSmtpConfig(raw, c.env as unknown as { ENCRYPTION_KEY: string; SMTP_HOST?: string });
  if (!smtp) throw ApiError.badRequest('邮件服务未配置，请联系管理员');
  // 注册验证码必须来自 CSPRNG（Math.random 可预测，可被枚举爆破）；
  // randomDigits 内部逐字节拒绝采样，6 位数字均匀分布。
  const code = randomDigits(6);
  const now = Date.now();
  // D1 存储 OTP：0 次 KV 写操作，彻底免疫 KV 写配额超限报错
  await db.run(`DELETE FROM email_tokens WHERE email = ? AND purpose = 'register'`, [email]);
  await db.run(
    `INSERT INTO email_tokens (id, user_id, email, code, purpose, expires_at, attempts, created_at)
     VALUES (?, 'register', ?, ?, 'register', ?, 0, ?)`,
    [crypto.randomUUID(), email, code, now + 300_000, now]
  );
  try {
    await c.env.KV?.put(`email:otp:register:${email}`, code, { expirationTtl: 300 });
  } catch {
    // 忽略 KV 配额超限异常（D1 为核心真值）
  }
  try {
    const brand = await loadMailBrand(raw, c.env.APP_BASE_URL);
    await sendMail(
      { ...smtp, from: smtp.from || 'Picumet <noreply@example.com>' },
      email,
      `${brand.siteTitle} 注册验证码`,
      renderRegisterOtpMail(code, brand)
    );
  } catch (err) {
    // 发信失败不留悬挂验证码（否则验证码已写入但永远收不到，徒增尝试次数）
    await db.run(`DELETE FROM email_tokens WHERE email = ? AND purpose = 'register'`, [email]);
    console.error('[auth] register OTP mail failed:', err instanceof Error ? err.message : String(err));
    throw new ApiError(502, 'MAIL_ERROR', '验证码邮件发送失败，请联系管理员检查邮件服务配置');
  }
  return ok(c, { success: true, expiresIn: 300 });
});

authRoutes.post('/register', authRateLimitMiddleware, async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '注册信息无效', parsed.error.flatten());
  }
  const { username, password, email, emailCode, turnstileToken } = parsed.data;

  // Turnstile 面（register）：OTP 校验之前断言
  const tsRegister = await assertCaptcha(c, 'register', turnstileToken);
  if (tsRegister.response) return tsRegister.response;

  // 注册邮箱 OTP 校验：站点开启邮箱验证时必需
  const reqVerify = (await SettingsRepo.get(db, 'require_email_verification')) ?? 'false';
  if (reqVerify !== 'false') {
    const row = await db.first(
      `SELECT id, code, attempts, expires_at FROM email_tokens
       WHERE email = ? AND purpose = 'register'
       ORDER BY created_at DESC LIMIT 1`,
      [email.toLowerCase()]
    );
    let verified = false;
    if (row && Number(row.expires_at) > Date.now() && Number(row.attempts) < 5) {
      if (String(row.code) === emailCode) {
        verified = true;
        await db.run(`DELETE FROM email_tokens WHERE id = ?`, [row.id]);
      } else {
        await db.run(`UPDATE email_tokens SET attempts = attempts + 1 WHERE id = ?`, [row.id]);
      }
    }
    if (!verified) {
      // 兼容在途可能未过期的 KV 存量令牌
      try {
        const stored = await c.env.KV?.get(`email:otp:register:${email.toLowerCase()}`);
        if (stored && stored === emailCode) {
          verified = true;
          await c.env.KV?.delete(`email:otp:register:${email.toLowerCase()}`);
        }
      } catch {
        // 忽略
      }
    }
    if (!verified) {
      throw new ApiError(400, 'INVALID_OTP', '邮箱验证码错误或已过期');
    }
  }

  const allowReg = (await SettingsRepo.get(db, 'allow_registration')) ?? 'true';
  if (allowReg === 'false') {
    throw new ApiError(403, 'FORBIDDEN', '站点当前关闭注册');
  }

  // 邀请码门控：语义与错误码见 services/invites/invites.ts。
  // 校验先于建号，核销（invited_by_code_id）随 createUser 事务原子落库。
  const invitedByCodeId = await resolveInviteCode(db, await loadInviteSettings(db), parsed.data.inviteCode);

  const requireVerify = (await SettingsRepo.get(db, 'require_email_verification')) ?? 'false';
  const needsVerify = requireVerify !== 'false';

  // 用户名/邮箱冲突：users 表与待验证注册表分别判定（pending 期也占位，避免两人同时抢同一标识）
  const pendingTaken = await PendingRegistrationRepo.isTaken(db, email, username);
  const existingUser = await UserRepo.getUserByUsername(db, username);
  if (existingUser || pendingTaken.username) throw new ApiError(409, 'ALREADY_EXISTS', '用户名已被占用');
  const existingEmail = await UserRepo.findByEmailInsensitive(db, email);
  if (existingEmail || pendingTaken.email) throw new ApiError(409, 'ALREADY_EXISTS', '邮箱已被注册');

  // 密码哈希加密后落 pending 表：DB 泄露不等同于密码泄露
  const passwordHash = hashPassword(password);
  const passwordHashEnc = await encryptSecret(passwordHash, c.env.ENCRYPTION_KEY);

  // ===== 无需验证的三种情形：当场建号（邮箱标记为已验证）=====
  //   · 站点未开启邮箱验证（require_email_verification=false）
  //   · 环境未配置 SMTP（否则用户永远收不到邮件，账号会被永久卡死）
  //   · 非生产环境（本地/测试无邮件通道，与迁移前行为一致）
  if (!needsVerify || !hasSmtp(c.env) || (c.env.ENVIRONMENT as string) !== 'production') {
    const user = await UserRepo.createVerifiedUser(db, {
      username,
      email,
      passwordHash,
      role: 'user',
      invitedByCodeId,
    });
    return finishRegister(c, db, user, { emailVerified: true, verifiedBy: 'otp' });
  }

  // ===== 要求邮箱验证：不落 users，只登记待验证注册 =====
  const token = randomString(40);
  await PendingRegistrationRepo.create(db, {
    token,
    username,
    email,
    passwordHashEnc: `enc:${passwordHashEnc}`,
    invitedByCodeId,
    expiresAt: Date.now() + 24 * 3600_000,
  });

  const url = `${c.env.APP_BASE_URL}/api/auth/verify-email?token=${token}`;
  const settingsRaw = await SettingsRepo.getAll(db);
  const smtp = await resolveSmtpConfig(settingsRaw, c.env as unknown as { ENCRYPTION_KEY: string; SMTP_HOST?: string });
  if (!smtp) {
    await PendingRegistrationRepo.deleteByToken(db, token);
    throw ApiError.badRequest('邮件服务未配置，请联系管理员');
  }
  const brand = await loadMailBrand(settingsRaw, c.env.APP_BASE_URL);
  try {
    await sendMail(
      { ...smtp, from: smtp.from || 'Picumet <noreply@example.com>' },
      email,
      `${brand.siteTitle} 完成注册`,
      renderVerifyEmailMail(username, url, brand, 'confirmRegister')
    );
  } catch (err) {
    // 发信失败不留悬挂待验证行（用户重试即重新登记，users 始终干净）
    await PendingRegistrationRepo.deleteByToken(db, token);
    console.error('[auth] register verify mail failed:', err instanceof Error ? err.message : String(err));
    throw new ApiError(502, 'MAIL_ERROR', '验证邮件发送失败，请稍后重试或联系管理员');
  }

  return ok(
    c,
    {
      pending: true,
      email,
      message: `验证邮件已发送到 ${email}，请点击邮件中的链接完成注册。`,
    },
    `验证邮件已发送到 ${email}`,
    201
  );
});

/**
 * 注册成功收尾：注册速率计数 + 审计日志 + 会话 Cookie。
 * 无邮箱验证分支（当场建号）与 SSO 补充注册分支共用。
 */
async function finishRegister(
  c: Parameters<typeof ok>[0],
  db: ReturnType<typeof getDb>,
  user: Parameters<typeof toPublicUser>[0] & { id: string; email: string },
  opts: { emailVerified: boolean; verifiedBy: 'otp' | 'token' }
): Promise<ReturnType<typeof ok>> {
  void opts;
  // 注册成功速率（register_success_per_hour_per_ip，默认 3，0 = 关闭）：
  // 按「注册成功」而非请求计数，防慢速批量注册；计数在建号后（先成功后计数，超限即冷却）。
  const regLimitRaw = await SettingsRepo.get(db, 'register_success_per_hour_per_ip');
  const regLimit = regLimitRaw == null ? 3 : Number(regLimitRaw) || 0;
  if (regLimit > 0 && rateLimitsEnforced(c.env)) {
    const regIp = requestIp(c.req.raw) ?? '127.0.0.1';
    const withinLimit = await checkRegisterSuccessLimit(c.env, regIp, regLimit);
    if (!withinLimit) {
      throw new ApiError(429, 'REGISTER_RATE_LIMITED', '注册过于频繁，请稍后再试');
    }
  }

  await LogRepo.create(db, {
    userId: user.id,
    action: 'register',
    path: '/',
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
  });

  return ok(
    c,
    {
      user: { ...toPublicUser(user as never), emailVerified: true },
      message: '注册成功',
    },
    '注册成功',
    201
  );
}

/**
 * 邮箱验证页（`/api/auth/verify-email` 与兼容别名 `/api/auth/verify`）
 *
 * 两条路径：
 * 1. **待验证注册核销**（迁移 0016 起的主路径）：点邮件链接才建号。
 *    事务内完成「核销邀请码 → 建号（email_verified=1）→ 删待验证行」，
 *    任一步失败整体回滚，users 保持干净（不再出现「注册说占用、登录进不去」）。
 * 2. **存量已建号用户的补验证**（迁移前发出去的旧链接）：直接把 email_verified 置 1。
 */
const verifyEmailHandler = async (c: Parameters<typeof ok>[0]) => {
  const db = getDb(c);
  const token = c.req.query('token');
  if (!token) return verifyResultPage(c, 'missing', '缺少验证令牌', '请使用邮件中的完整链接。');

  // ---- 路径 1：待验证注册核销 ----
  const pending = await PendingRegistrationRepo.getByToken(db, token);
  if (pending) {
    if (pending.expiresAt <= Date.now()) {
      await PendingRegistrationRepo.deleteByToken(db, token);
      return verifyResultPage(
        c,
        'expired',
        '注册链接已过期',
        '为保障账号安全，待验证注册 24 小时内有效。请返回注册页重新提交。',
        '/register'
      );
    }
    // 邀请码在待验证期可能被他人用掉或被删：这里二次核销（外键 + 邀请码存在性由 createVerifiedUser 的事务保证）
    if (pending.invitedByCodeId) {
      const stillOk = await db.first('SELECT id FROM invite_codes WHERE id = ? LIMIT 1', [pending.invitedByCodeId]);
      if (!stillOk) {
        await PendingRegistrationRepo.deleteByToken(db, token);
        return verifyResultPage(
          c,
          'invite-gone',
          '邀请码已失效',
          '注册所用的邀请码已被使用或删除。请返回注册页重新填写邀请码。',
          '/register'
        );
      }
    }
    // 期间该标识可能已被真实注册占用（理论上 pending 期已占位，这里防御性兜底）
    const conflict =
      (await UserRepo.getUserByUsername(db, pending.username)) ||
      (await UserRepo.findByEmailInsensitive(db, pending.email));
    if (conflict) {
      await PendingRegistrationRepo.deleteByToken(db, token);
      return verifyResultPage(
        c,
        'conflict',
        '该注册信息已被使用',
        '相同用户名或邮箱已完成注册。请直接登录，或换一个标识重新注册。',
        '/login'
      );
    }

    const passwordHash = await decryptSecret(pending.passwordHash.replace(/^enc:/, ''), c.env.ENCRYPTION_KEY);
    try {
      await UserRepo.createVerifiedUser(db, {
        username: pending.username,
        email: pending.email,
        passwordHash,
        role: 'user',
        invitedByCodeId: pending.invitedByCodeId,
      });
    } catch (err) {
      console.error('[auth] redeem pending registration failed:', err);
      return verifyResultPage(
        c,
        'error',
        '注册失败',
        '账号创建时发生冲突，请返回注册页重试。',
        '/register'
      );
    }
    await PendingRegistrationRepo.deleteByToken(db, token);
    await LogRepo.create(db, {
      userId: undefined,
      action: 'register',
      path: '/',
      ipAddress: requestIp(c.req.raw),
      userAgent: c.req.header('user-agent'),
      metadata: JSON.stringify({ via: 'email_verify_redeem', email: pending.email }),
    });
    return verifyResultPage(
      c,
      'registered',
      '注册完成',
      `账号 ${pending.username} 已创建并完成邮箱验证，现在可以登录了。`,
      '/login'
    );
  }

  // ---- 路径 2：存量已建号用户的补验证（旧链接兼容） ----
  const userIdRow = await db.first(
    `SELECT id, user_id, expires_at FROM email_tokens WHERE code = ? AND purpose = 'verify' LIMIT 1`,
    [token]
  );
  let userId: string | null = null;
  if (userIdRow && Number(userIdRow.expires_at) > Date.now()) {
    userId = String(userIdRow.user_id);
    await db.run(`DELETE FROM email_tokens WHERE id = ?`, [userIdRow.id]);
  } else {
    try {
      userId = await c.env.KV?.get(`email:verify:${token}`);
      if (userId) await c.env.KV?.delete(`email:verify:${token}`);
    } catch {
      // 忽略 KV 异常
    }
  }
  if (!userId) {
    return verifyResultPage(c, 'invalid', '验证链接无效或已过期', '链接可能已被使用或已失效，请重新发起验证。');
  }
  await UserRepo.updateUser(db, userId, { email_verified: 1 });
  return verifyResultPage(c, 'verified', '邮箱验证成功', '现在可以登录 Picumet 了。', '/login');
};

/** 验证结果页：视觉语言复刻落地页（墨色主按钮 + 内凹提示块 + 圆角窗体） */
function verifyResultPage(
  c: Parameters<typeof ok>[0],
  kind: 'registered' | 'verified' | 'expired' | 'invalid' | 'missing' | 'invite-gone' | 'conflict' | 'error',
  heading: string,
  detail: string,
  actionHref?: string
): Response {
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif";
  const tone: Record<typeof kind, { ring: string; dot: string; label: string }> = {
    registered: { ring: '#1a8a5a', dot: '#1a8a5a', label: '完成注册' },
    verified: { ring: '#1a8a5a', dot: '#1a8a5a', label: '邮箱验证' },
    expired: { ring: '#c2751a', dot: '#c2751a', label: '链接过期' },
    invalid: { ring: '#c8342f', dot: '#c8342f', label: '链接无效' },
    missing: { ring: '#6b7280', dot: '#6b7280', label: '缺少令牌' },
    'invite-gone': { ring: '#c2751a', dot: '#c2751a', label: '邀请码失效' },
    conflict: { ring: '#c2751a', dot: '#c2751a', label: '标识已被占用' },
    error: { ring: '#c8342f', dot: '#c8342f', label: '创建失败' },
  };
  const t = tone[kind];
  const cta = actionHref
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;"><tr>
         <td bgcolor="#0a0a0b" style="border-radius:9px;">
           <a href="${actionHref}" style="display:inline-block;padding:12px 22px;font:600 14px/1 ${font};color:#ffffff;text-decoration:none;border-radius:9px;">${
             kind === 'registered' || kind === 'verified' ? '前往登录' : '返回重试'
           }</a>
         </td></tr></table>`
    : '';
  return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${heading}</title></head>
<body style="margin:0;padding:0;background:#eef0f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef0f4;padding:40px 14px;">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
   <tr><td style="border-radius:14px;border:1px solid #e3e5ea;background:#fafafb;box-shadow:0 60px 120px -50px rgba(10,10,11,.17),0 24px 48px -24px rgba(10,10,11,.06);padding:34px 30px 30px;text-align:left;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" width="18" style="width:18px;"><div style="width:10px;height:10px;border-radius:50%;background:${t.dot};box-shadow:0 0 0 4px ${t.ring}1f;"></div></td>
      <td style="padding-left:9px;font:500 11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#9ca3af;letter-spacing:.8px;text-transform:uppercase;">${t.label}</td>
    </tr></table>
    <h1 style="margin:18px 0 0;font:600 21px/1.45 ${font};color:#0a0a0b;letter-spacing:-.2px;">${heading}</h1>
    <p style="margin:10px 0 0;font:400 14px/1.8 ${font};color:#6b7280;">${detail}</p>
    ${cta}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;"><tr>
      <td style="border-top:1px solid #e3e5ea;font:400 11px/1.7 ${font};color:#9ca3af;padding-top:16px;">Picumet · 自动邮件，请勿直接回复</td>
    </tr></table>
   </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`);
}

authRoutes.get('/verify-email', verifyEmailHandler);
authRoutes.get('/verify', verifyEmailHandler);

authRoutes.post('/login', authRateLimitMiddleware, async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('请输入用户名和密码');
  // username 字段承载「登录标识」：用户名或邮箱（UserRepo.findByLoginIdentifier 收敛）
  const { username, password, totpCode, turnstileToken } = parsed.data;

  // Turnstile 面（login）：在密码校验之前断言（省 bcrypt 开销）
  const ts = await assertCaptcha(c, 'login', turnstileToken);
  if (ts.response) return ts.response;

  const user = await UserRepo.findByLoginIdentifier(db, username);
  if (!user || !verifyPassword(password, user.passwordHash ?? '')) {
    await LogRepo.create(db, {
      userId: user?.id,
      action: 'login_failed',
      path: '/',
      ipAddress: requestIp(c.req.raw),
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

  // 两步验证（2FA / TOTP 第二因子）：已开启且未提供验证码时回退 403 TOTP_REQUIRED；
  // 提供验证码则校验动态码或一次性备用码
  if (user.totpEnabled) {
    const code = totpCode?.trim();
    if (!code) {
      return fail(c, new ApiError(403, 'TOTP_REQUIRED', '需要两步验证码'));
    }
    const totpValid = await verifyTotpOrBackupCode(db, c.env, user.id, code);
    if (!totpValid) {
      await LogRepo.create(db, {
        userId: user.id,
        action: 'login_failed',
        path: '/',
        ipAddress: requestIp(c.req.raw),
        userAgent: c.req.header('user-agent'),
        metadata: JSON.stringify({ reason: 'totp_failed' }),
      });
      throw new ApiError(401, 'INVALID_TOTP_CODE', '两步验证码或备用码错误');
    }
  }
  await UserRepo.updateUser(db, user.id, { last_login_at: Date.now() });
  await setAuthCookie(c, user);
  await LogRepo.create(db, {
    userId: user.id,
    action: 'login',
    path: '/',
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
  });
  const quota = await QuotaRepo.getQuota(db, user.id);
  // 回读一次以带出 last_login_at（更新后取最新行；理论上必存在，缺失时回退当前行）
  const fresh = await UserRepo.getUserById(db, user.id);
  return ok(c, { user: toPublicUser(fresh ?? user), quota });
});

authRoutes.post('/logout', async (c) => {
  // 会话撤销：登出时递增 session_version，使该用户所有 JWT 立即失效
  const db = getDb(c);
  const cookie = c.req.header('cookie');
  const match = cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith('auth_token='));
  const token = match ? match.slice('auth_token='.length) : null;
  if (token) {
    const payload = await verifyJwt(token, [c.env.JWT_SECRET as string, (c.env.JWT_SECRET_OLD as string) ?? '']);
    if (payload?.sub) {
      await UserRepo.bumpSessionVersion(db, payload.sub);
    }
  }
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
  return ok(c, { user: toPublicUser(user), quota });
});

authRoutes.get('/csrf-token', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', '未登录');
  const token = await issueCsrfToken(null, userId, (c.env.ENCRYPTION_KEY as string) ?? '');
  return ok(c, { token });
});

authRoutes.post('/forgot-password', authRateLimitMiddleware, async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = ForgotPasswordSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '请输入有效邮箱');
  // Turnstile 面（password_reset）：发信之前断言（不暴露邮箱存在性的语义不变）
  const tsReset = await assertCaptcha(c, 'password_reset', parsed.data.turnstileToken);
  if (tsReset.response) return tsReset.response;
  const { email } = parsed.data;
  const user = await UserRepo.getUserByEmail(db, email);
  if (!user) {
    // 不暴露用户是否存在
    return ok(c, { message: '如果该邮箱已注册，重置链接已发送' });
  }
  const token = randomString(40);
  const now = Date.now();
  await db.run(`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'`, [user.id]);
  await db.run(
    `INSERT INTO email_tokens (id, user_id, email, code, purpose, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, 'reset', ?, 0, ?)`,
    [crypto.randomUUID(), user.id, user.email, token, now + 900_000, now]
  );
  try {
    await c.env.KV?.put(`pwd:reset:${token}`, user.id, { expirationTtl: 15 * 60 });
  } catch {
    // 忽略 KV 异常
  }
  const url = `${c.env.APP_BASE_URL}/reset-password?token=${token}`;
  const resetRaw = await SettingsRepo.getAll(db);
  const smtp = await resolveSmtpConfig(resetRaw, c.env as unknown as { ENCRYPTION_KEY: string; SMTP_HOST?: string });
  if (smtp) {
    const brand = await loadMailBrand(resetRaw, c.env.APP_BASE_URL);
    await sendMail(
      { ...smtp, from: smtp.from || 'Picumet <noreply@example.com>' },
      user.email,
      `${brand.siteTitle} 密码重置`,
      renderPasswordResetMail(user.username, url, brand)
    );
  }
  return ok(c, { message: '如果该邮箱已注册，重置链接已发送' });
});

authRoutes.post('/reset-password', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = ResetPasswordSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('无效的令牌或密码过短');
  const { token, password } = parsed.data;
  const row = await db.first(
    `SELECT id, user_id, expires_at FROM email_tokens WHERE code = ? AND purpose = 'reset' LIMIT 1`,
    [token]
  );
  let userId: string | null = null;
  if (row && Number(row.expires_at) > Date.now()) {
    userId = String(row.user_id);
    await db.run(`DELETE FROM email_tokens WHERE id = ?`, [row.id]);
  } else {
    try {
      userId = await c.env.KV?.get(`pwd:reset:${token}`);
      if (userId) await c.env.KV?.delete(`pwd:reset:${token}`);
    } catch {
      // 忽略
    }
  }
  if (!userId) throw ApiError.badRequest('重置链接无效或已过期');
  await UserRepo.updateUser(db, userId, { password_hash: hashPassword(password) });
  await UserRepo.bumpSessionVersion(db, userId); // 改密后旧 JWT 全部失效
  return ok(c, { message: '密码已重置，请重新登录' });
});

// 兼容错误响应
export { fail };
