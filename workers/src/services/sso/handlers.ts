// 第三方登录（SSO / OIDC）路由：授权跳转、回调、补充注册、待办查询
//
// 登录态与密码登录完全一致（同一 JWT Cookie、同一 session_version 撤销通道）。
// 回调后的三条分支（docs/ARCHITECTURE_CN.md「SSO / OIDC 登录服务」）：
//   1) (provider_id, subject) 已关联  → 直接登录
//   2) 提供方**已验证**的邮箱命中既有账号 → 自动关联并登录
//   3) 其余 → 暂存档案 + 一次性令牌，跳前端 /sso/complete 由用户自填
//      邮箱 / 用户名 / 密码并通过邮箱验证码（不复用提供方档案，第三方记录仍落库）
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings, Env } from '../../shared/types';
import type { SsoPendingProfile } from '@shared/types';
import { ApiError } from '../../shared/errors';
import { ok } from '../../shared/response';
import { getDb } from '../../middleware/auth';
import { authRateLimitMiddleware } from '../../middleware/rate-limit';
import { requestIp } from '../../utils/ip';
import { hashPassword, randomString, timingSafeEqualStr } from '../../utils/crypto';
import {
  LogRepo,
  QuotaRepo,
  SettingsRepo,
  SsoIdentityRepo,
  SsoProviderRepo,
  UserRepo,
  parseJson,
  type Db,
  type SsoProviderRow,
} from '../../db';
import { loadInviteSettings, resolveInviteCode } from '../invites/invites';
import { setAuthCookie } from '../auth/session';
import { toPublicUser } from '../auth/public-user';
import { SsoCompleteSchema } from './schemas';
import {
  DEFAULT_SCOPES,
  allowLoopbackIssuer,
  loadSsoEnabled,
  resolveRedirectUri,
  sealCredential,
  unsealCredential,
} from './config';
import { buildAuthorizeUrl, exchangeCode, loadDiscovery, pkceChallenge, resolveProfile } from './oidc';
import type { SsoPendingEntry, SsoProfile, SsoStateEntry, SsoTokens } from './types';

const STATE_TTL = 600; // 授权会话 10 分钟
const PENDING_TTL = 900; // 补充注册上下文 15 分钟

/**
 * 授权事务 / 补充注册的**绑定 Cookie**：state 与 pending 令牌只写在 KV 与 URL 里时，
 * 任何浏览器拿到 URL 就能完成登录——攻击者用自己的账号跑完授权、把回调/补充注册链接丢给
 * 受害者，受害者拿到的是**攻击者账号**的会话（登录 CSRF / 会话固定），或把身份关联到攻击者的
 * 提供方 subject 上。
 * 因此两者都额外写一份同值 HttpOnly Cookie，消费时必须与之匹配：第三方站点无法为受害者浏览器
 * 预置该 Cookie，链接转发即失效。`SameSite=Lax` 是必需的——回调是**跨站顶层 GET 跳转**，
 * Strict 会把 Cookie 一起丢掉。
 */
const TX_COOKIE = 'sso_tx';
const PENDING_COOKIE = 'sso_pending';
const BIND_COOKIE_PATH = '/api/auth/sso';

export const ssoRoutes = new Hono<AppBindings>();

/** 追加写入绑定 Cookie（同一响应可能有多个 Set-Cookie：清绑定 + 发会话） */
function appendBindCookie(c: Context<AppBindings>, name: string, value: string, maxAge: number): void {
  const secure = c.env.ENVIRONMENT === 'production' ? '; Secure' : '';
  c.header(
    'Set-Cookie',
    `${name}=${value}; Path=${BIND_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
    { append: true }
  );
}

function readBindCookie(c: Context<AppBindings>, name: string): string | null {
  const cookie = c.req.header('cookie');
  if (!cookie) return null;
  const prefix = `${name}=`;
  const match = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

/**
 * 绑定校验：请求携带的绑定 Cookie 必须与本次要消费的值一致（常量时间比较）。
 * 只在失败时清 Cookie：`sso_pending` 会在 `/pending` 与 `/complete` 各读一次，
 * 无条件清会让第二次请求（真正建号的那次）必然失败。
 * `sso_tx` 由回调在通过校验后显式清除（一次性）；`sso_pending` 在注册成功后清除。
 */
function assertBindCookie(c: Context<AppBindings>, name: string, expected: string, code: string, message: string): void {
  const provided = readBindCookie(c, name);
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    // 失败即清：不匹配的值留着只会让后续请求继续带着错值试探
    appendBindCookie(c, name, '', 0);
    throw new ApiError(400, code, message);
  }
}

/** 浏览器入口的失败出口：统一回登录页并带错误码（前端按码显示 i18n 文案） */
function errorRedirect(c: Context<AppBindings>, code: string): Response {
  const url = new URL('/login', c.env.APP_BASE_URL);
  url.searchParams.set('sso_error', code);
  return c.redirect(url.toString(), 302);
}

/**
 * 登录成功落地页（与密码登录默认跳转一致）。
 * 必须走 c.redirect：session Cookie 由 c.header 写入，裸 Response.redirect 会丢掉它。
 */
function successRedirect(c: Context<AppBindings>): Response {
  return c.redirect(new URL('/files', c.env.APP_BASE_URL).toString(), 302);
}

/** 失败留痕 + 跳转：5xx 与未知异常写服务端日志（对外只回错误码） */
async function failAndRedirect(c: Context<AppBindings>, providerId: string, err: unknown): Promise<Response> {
  const code = err instanceof ApiError ? err.code : 'SSO_INTERNAL_ERROR';
  // 4xx 属用户/配置层面的预期失败（取消授权、state 过期等），不写服务端错误日志
  if (!(err instanceof ApiError) || err.statusCode >= 500) {
    console.log('sso flow error', code, err instanceof Error ? err.message : String(err));
  }
  try {
    await LogRepo.create(getDb(c), {
      action: 'login_failed',
      path: `/api/auth/sso/${providerId}/callback`,
      metadata: JSON.stringify({ sso: providerId, code }),
      ipAddress: requestIp(c.req.raw),
      userAgent: c.req.header('user-agent'),
    });
  } catch {
    /* 审计失败不影响登录主流程 */
  }
  return errorRedirect(c, code);
}

/**
 * 站点是否具备发信能力：决定 SSO 注册能否要求邮箱验证码。
 * 直接解析 `smtp_host` 设置（迁移种子把空值写成 JSON 字符串 `""`，
 * 走 resolveSmtpConfig 会把它当成已配置主机），其次看 env 兜底。
 */
async function mailAvailable(db: Db, env: Env): Promise<boolean> {
  const raw = await SettingsRepo.getAll(db);
  const parsed = parseJson<unknown>(raw['smtp_host'], raw['smtp_host']);
  const host = typeof parsed === 'string' ? parsed.trim() : '';
  return Boolean(host || env.SMTP_HOST);
}

/**
 * 本次补充注册是否需要邮箱验证码——判定基准是**用户实际提交的邮箱**，不是提供方档案：
 * - 提供方已**验证同一个**邮箱 → 邮箱控制权已证明，免验证码；
 * - 其余（提供方没给邮箱 / 声称未验证 / 用户改成了别的邮箱）→ 站点开启邮箱验证，
 *   或站点有可用发信能力（`smtp_host` 已配置）时必须通过验证码。
 * `submittedEmail` 缺省（/pending 预检）时用待填档案里的邮箱代表当前表单值；
 * /complete 必须传真实提交值，否则「提供方验证过 A 邮箱 → 关掉验证码 → 用 B 邮箱注册」可被滥用。
 */
async function emailVerificationRequired(
  db: Db,
  env: Env,
  pending: SsoPendingEntry,
  submittedEmail?: string
): Promise<boolean> {
  const target = (submittedEmail ?? pending.profile.email ?? '').trim().toLowerCase();
  const providerEmail = pending.profile.email?.trim().toLowerCase() ?? '';
  if (providerEmail && pending.profile.emailVerified && target === providerEmail) return false;
  const siteRequires = ((await SettingsRepo.get(db, 'require_email_verification')) ?? 'false') !== 'false';
  return siteRequires || (await mailAvailable(db, env));
}

/**
 * 已完成身份认证后的收尾：发放会话 Cookie + 审计。
 * `linked` 表示本次是否新建了身份关联行（用于审计区分「登录」与「关联」）。
 */
async function issueSession(
  c: Context<AppBindings>,
  user: { id: string; username: string; role: string; sessionVersion: number },
  provider: SsoProviderRow,
  linked: boolean
): Promise<void> {
  await UserRepo.updateUser(getDb(c), user.id, { last_login_at: Date.now() });
  await setAuthCookie(c, user);
  await LogRepo.create(getDb(c), {
    userId: user.id,
    action: 'login',
    path: '/',
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
    metadata: JSON.stringify({ sso: provider.kind, providerId: provider.id, linked }),
  });
}

/** 凭据加密落库形态（access/refresh token 一律 `enc:` 密文） */
async function sealTokens(tokens: SsoTokens, key: string) {
  return {
    accessToken: await sealCredential(tokens.accessToken, key),
    refreshToken: await sealCredential(tokens.refreshToken, key),
    tokenType: tokens.tokenType,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
  };
}

/** 授权跳转：生成 state + PKCE + nonce，写入 KV 后 302 到提供方 */
ssoRoutes.get('/:id/start', authRateLimitMiddleware, async (c) => {
  const env = c.env;
  const providerId = c.req.param('id');
  try {
    const db = getDb(c);
    if (!(await loadSsoEnabled(db))) throw new ApiError(403, 'SSO_DISABLED', '站点未启用第三方登录');
    const provider = await SsoProviderRepo.getById(db, providerId);
    if (!provider || !provider.enabled) throw new ApiError(404, 'SSO_PROVIDER_NOT_FOUND', '该登录来源不可用');
    const allowLoopback = allowLoopbackIssuer(env);
    const discovery = await loadDiscovery(env, provider, allowLoopback);
    const state = randomString(40);
    const verifier = randomString(64);
    const nonce = randomString(32);
    const entry: SsoStateEntry = { providerId: provider.id, verifier, nonce };
    await env.KV.put(`sso:state:${state}`, JSON.stringify(entry), { expirationTtl: STATE_TTL });
    // 与发起浏览器绑定（回调时校验）；scope 空串回落到类型默认（脏行不让空 scope 进授权请求）
    appendBindCookie(c, TX_COOKIE, state, STATE_TTL);
    return c.redirect(
      buildAuthorizeUrl(provider, discovery, {
        redirectUri: resolveRedirectUri(env, provider.id),
        state,
        nonce,
        challenge: await pkceChallenge(verifier),
        scope: provider.scopes?.trim() || DEFAULT_SCOPES[provider.kind],
      }),
      302
    );
  } catch (err) {
    return failAndRedirect(c, providerId, err);
  }
});

/** 回调：换 token → 解析档案 → 登录 / 自动关联 / 转补充注册 */
ssoRoutes.get('/:id/callback', authRateLimitMiddleware, async (c) => {
  const env = c.env;
  const providerId = c.req.param('id');
  try {
    const db = getDb(c);
    if (!(await loadSsoEnabled(db))) throw new ApiError(403, 'SSO_DISABLED', '站点未启用第三方登录');
    if (c.req.query('error')) throw new ApiError(400, 'SSO_CANCELLED', '授权被取消或拒绝');
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) throw new ApiError(400, 'SSO_STATE_INVALID', '回调参数不完整');
    // state 一次性消费（防重放）：先删除再判定，**任何**回调尝试都会作废该 state
    // （包括绑定 Cookie 不匹配的请求），避免同一 state 被反复试探
    const stateKey = `sso:state:${state}`;
    const rawState = await env.KV.get(stateKey);
    await env.KV.delete(stateKey);
    // 绑定校验：本次授权必须由「发起时写入 sso_tx Cookie 的那个浏览器」完成（防登录 CSRF/会话固定）
    assertBindCookie(c, TX_COOKIE, state, 'SSO_STATE_INVALID', '授权会话与当前浏览器不匹配，请重新发起登录');
    // 校验通过即清：该 state 已消费，绑定值不再需要
    appendBindCookie(c, TX_COOKIE, '', 0);
    if (!rawState) throw new ApiError(400, 'SSO_STATE_INVALID', '授权会话已失效，请重新发起登录');
    let entry: SsoStateEntry;
    try {
      entry = JSON.parse(rawState) as SsoStateEntry;
    } catch {
      throw new ApiError(400, 'SSO_STATE_INVALID', '授权会话无效，请重新发起登录');
    }
    if (entry.providerId !== providerId) throw new ApiError(400, 'SSO_STATE_INVALID', '授权会话与登录来源不匹配');

    const provider = await SsoProviderRepo.getById(db, providerId);
    if (!provider || !provider.enabled) throw new ApiError(404, 'SSO_PROVIDER_NOT_FOUND', '该登录来源不可用');
    const clientSecret = await unsealCredential(provider.clientSecret, env.ENCRYPTION_KEY);
    if (!clientSecret) {
      throw new ApiError(500, 'SSO_SECRET_UNAVAILABLE', '该来源的 Client Secret 无法解密，请在管理端重新保存');
    }
    const client: SsoProviderRow = { ...provider, clientSecret };
    const allowLoopback = allowLoopbackIssuer(env);
    const discovery = await loadDiscovery(env, client, allowLoopback);
    const raw = await exchangeCode(client, discovery, code, entry.verifier, resolveRedirectUri(env, providerId), allowLoopback);
    const { profile, tokens } = await resolveProfile(client, discovery, raw, entry.nonce, allowLoopback);
    return await completeAuthentication(c, client, profile, tokens);
  } catch (err) {
    return failAndRedirect(c, providerId, err);
  }
});

/** 已认证后的归属判定（三条分支） */
async function completeAuthentication(
  c: Context<AppBindings>,
  provider: SsoProviderRow,
  profile: SsoProfile,
  tokens: SsoTokens
): Promise<Response> {
  const db = getDb(c);
  const env = c.env;
  const sealed = await sealTokens(tokens, env.ENCRYPTION_KEY);
  const snapshot = {
    email: profile.email,
    username: profile.username,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
  };

  // 1) 既有身份关联 → 直接登录（刷新凭据与档案快照）
  const existing = await SsoIdentityRepo.findByProviderSubject(db, provider.id, profile.subject);
  if (existing) {
    const user = await UserRepo.getUserById(db, existing.userId);
    if (!user || user.status !== 'active') throw new ApiError(403, 'SSO_ACCOUNT_DISABLED', '账号已被禁用');
    await SsoIdentityRepo.refresh(db, existing.id, { ...snapshot, ...sealed });
    await issueSession(c, user, provider, false);
    return successRedirect(c);
  }

  // 2) **被信任的**来源 + 提供方已验证邮箱命中既有账号 → 自动关联
  //    「信任提供方邮箱验证」是逐来源开关（迁移 0013）：内置 Google/GitHub 端点固定、邮箱验证由提供方保证，
  //    默认开启；自定义 OIDC 默认关闭——其 issuer 只过地址白名单，若该 IdP 允许用户自填任意邮箱并回
  //    email_verified=true，开启它就等于允许接管任意既有账号；关闭时这些用户走补充注册页。
  if (provider.trustEmailVerified && profile.email && profile.emailVerified) {
    // 大小写无关匹配：邮箱列是 BINARY 排序且按输入原样存储，精确匹配会漏掉大小写变体（导致重复建号）
    const user = await UserRepo.findByEmailInsensitive(db, profile.email);
    if (user) {
      if (user.status !== 'active') throw new ApiError(403, 'SSO_ACCOUNT_DISABLED', '账号已被禁用');
      await SsoIdentityRepo.create(db, {
        providerId: provider.id,
        userId: user.id,
        subject: profile.subject,
        ...snapshot,
        ...sealed,
      });
      if (!user.emailVerified) await UserRepo.updateUser(db, user.id, { email_verified: 1 });
      // 关联是敏感动作（把第三方身份接到既有账号）→ 除登录审计外单独留一条 sso_link
      await LogRepo.create(db, {
        userId: user.id,
        action: 'sso_link',
        path: '/',
        metadata: JSON.stringify({ providerId: provider.id, kind: provider.kind, reason: 'provider_email_verified' }),
      });
      await issueSession(c, user, provider, true);
      return successRedirect(c);
    }
  }

  // 3) 无可关联账号 → 补充注册页（注册总闸在此前置判定，避免让用户填完才被拒）
  const allowRegistration = (await SettingsRepo.get(db, 'allow_registration')) ?? 'true';
  if (allowRegistration === 'false') throw new ApiError(403, 'REGISTRATION_DISABLED', '站点当前关闭注册');
  const token = randomString(43);
  const pending: SsoPendingEntry = {
    providerId: provider.id,
    providerName: provider.name,
    kind: provider.kind,
    profile,
    // 暂存期间同样加密（KV 不是用户可读面，但「凭据一律 enc: 密文」是既定不变量）；
    // /complete 直接把该密文写入 sso_identities，不重复加密
    tokens: sealed,
  };
  await env.KV.put(`sso:pending:${token}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL });
  // 与当前浏览器绑定：没有这个 Cookie 的请求（例如他人转发的链接）无法完成注册
  appendBindCookie(c, PENDING_COOKIE, token, PENDING_TTL);
  const url = new URL('/sso/complete', env.APP_BASE_URL);
  url.searchParams.set('token', token);
  return c.redirect(url.toString(), 302);
}

/** 补充注册页读取待填档案（仅含展示字段，不含任何令牌） */
ssoRoutes.get('/pending', authRateLimitMiddleware, async (c) => {
  const db = getDb(c);
  if (!(await loadSsoEnabled(db))) throw new ApiError(403, 'SSO_DISABLED', '站点未启用第三方登录');
  const token = c.req.query('token');
  if (!token) throw ApiError.badRequest('缺少注册令牌');
  assertBindCookie(c, PENDING_COOKIE, token, 'SSO_PENDING_INVALID', '注册会话与当前浏览器不匹配，请重新使用第三方登录');
  const raw = await c.env.KV.get(`sso:pending:${token}`);
  if (!raw) throw new ApiError(400, 'SSO_PENDING_INVALID', '注册会话已过期，请重新使用第三方登录');
  let pending: SsoPendingEntry;
  try {
    pending = JSON.parse(raw) as SsoPendingEntry;
  } catch {
    throw new ApiError(400, 'SSO_PENDING_INVALID', '注册会话无效，请重新使用第三方登录');
  }
  // 来源在补充注册期间被停用/删除时不再继续（与 /start、/callback 同口径）
  const provider = await SsoProviderRepo.getById(db, pending.providerId);
  if (!provider || !provider.enabled) throw new ApiError(404, 'SSO_PROVIDER_NOT_FOUND', '该登录来源不可用');
  const invite = await loadInviteSettings(db);
  const data: SsoPendingProfile = {
    providerId: pending.providerId,
    providerName: pending.providerName,
    kind: pending.kind,
    email: pending.profile.email,
    emailVerified: pending.profile.emailVerified,
    username: pending.profile.username,
    displayName: pending.profile.displayName,
    avatarUrl: pending.profile.avatarUrl,
    emailVerificationRequired: await emailVerificationRequired(db, c.env, pending),
    inviteEnabled: invite.enabled,
    inviteRequired: invite.required,
  };
  return ok(c, data);
});

/**
 * 补充注册完成：用户自填邮箱 / 用户名 / 密码（+ 验证码 + 邀请码），
 * 与 /register 的门控同源（注册开关、邮箱验证、邀请码），随后建立身份关联并登录。
 */
ssoRoutes.post('/complete', authRateLimitMiddleware, async (c) => {
  const db = getDb(c);
  const env = c.env;
  if (!(await loadSsoEnabled(db))) throw new ApiError(403, 'SSO_DISABLED', '站点未启用第三方登录');
  const body = await c.req.json().catch(() => null);
  const parsed = SsoCompleteSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '注册信息无效', parsed.error.flatten());
  }
  const { token, username, password, email, emailCode } = parsed.data;
  // 绑定校验：只有持有 sso_pending Cookie 的浏览器能消费该令牌（他人转发的链接直接失效）
  assertBindCookie(c, PENDING_COOKIE, token, 'SSO_PENDING_INVALID', '注册会话与当前浏览器不匹配，请重新使用第三方登录');
  const rawPending = await env.KV.get(`sso:pending:${token}`);
  if (!rawPending) throw new ApiError(400, 'SSO_PENDING_INVALID', '注册会话已过期，请重新使用第三方登录');
  let pending: SsoPendingEntry;
  try {
    pending = JSON.parse(rawPending) as SsoPendingEntry;
  } catch {
    throw new ApiError(400, 'SSO_PENDING_INVALID', '注册会话无效，请重新使用第三方登录');
  }
  const provider = await SsoProviderRepo.getById(db, pending.providerId);
  if (!provider || !provider.enabled) throw new ApiError(404, 'SSO_PROVIDER_NOT_FOUND', '该登录来源不可用');

  const allowRegistration = (await SettingsRepo.get(db, 'allow_registration')) ?? 'true';
  if (allowRegistration === 'false') throw new ApiError(403, 'REGISTRATION_DISABLED', '站点当前关闭注册');

  // 邮箱验证码：与 /register 共用同一 KV 命名空间（注册验证码），一次消费。
  // 判定基准是**本次提交的邮箱**（见 emailVerificationRequired 注释）。
  const otpRequired = await emailVerificationRequired(db, env, pending, email);
  if (otpRequired) {
    const stored = await env.KV.get(`email:otp:register:${email.toLowerCase()}`);
    if (!stored || stored !== emailCode) throw new ApiError(400, 'INVALID_OTP', '邮箱验证码错误或已过期');
    await env.KV.delete(`email:otp:register:${email.toLowerCase()}`);
  }

  // 邀请码门控（与 /register 同源语义与错误码）
  const inviteSettings = await loadInviteSettings(db);
  const invitedByCodeId = await resolveInviteCode(db, inviteSettings, parsed.data.inviteCode);

  const existingUser = await UserRepo.getUserByUsername(db, username);
  if (existingUser) throw new ApiError(409, 'ALREADY_EXISTS', '用户名已被占用');
  // 邮箱查重同样大小写无关：否则同一邮箱的大小写变体会建出两个账号，
  // 而登录按 lower(email) 解析 → 其中一个账号永远登不进去（且自动关联会命中错误的行）
  const existingEmail = await UserRepo.findByEmailInsensitive(db, email);
  if (existingEmail) {
    throw new ApiError(409, 'ALREADY_EXISTS', '该邮箱已在本站注册，请直接用该邮箱登录（第三方身份暂不自动关联该账号）');
  }

  const user = await UserRepo.createUser(db, {
    username,
    email,
    passwordHash: hashPassword(password),
    role: 'user',
    invitedByCodeId,
  });
  // 邮箱已验证的两种情形：本次通过了验证码；或提供方验证的就是**这个**邮箱（等价于控制权证明）
  const emailVerified =
    otpRequired ||
    (pending.profile.emailVerified && pending.profile.email?.trim().toLowerCase() === email.trim().toLowerCase());
  if (emailVerified) await UserRepo.updateUser(db, user.id, { email_verified: 1 });

  // 第三方身份与凭据落库：pending.tokens 在回调时已加密（`enc:` 密文），直接落库不重复加密
  await SsoIdentityRepo.create(db, {
    providerId: provider.id,
    userId: user.id,
    subject: pending.profile.subject,
    email: pending.profile.email,
    username: pending.profile.username,
    displayName: pending.profile.displayName,
    avatarUrl: pending.profile.avatarUrl,
    ...pending.tokens,
  });
  // 令牌一次性：注册成功后上下文与绑定 Cookie 立即失效（失败重试期间保留至 TTL）
  await env.KV.delete(`sso:pending:${token}`);
  appendBindCookie(c, PENDING_COOKIE, '', 0);

  await LogRepo.create(db, {
    userId: user.id,
    action: 'register',
    path: '/',
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
    metadata: JSON.stringify({ sso: provider.kind, providerId: provider.id }),
  });
  await issueSession(c, user, provider, true);
  const fresh = await UserRepo.getUserById(db, user.id);
  const quota = await QuotaRepo.getQuota(db, user.id);
  return ok(c, { user: toPublicUser(fresh ?? user), quota }, '注册成功', 201);
});
