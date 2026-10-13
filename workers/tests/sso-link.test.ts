// SSO「关联已有账号」分支回归：
// /api/auth/sso/:id/link（密码验证 + 二次因子分发）与 /:id/link-verify（TOTP/备用码/邮箱码 → 绑定 + 登录）。
// 安全语义：绑定 Cookie（登录 CSRF 防线）、密码错误统一 401（防枚举）、
// TOTP 优先于邮箱码、subject 唯一（一身份一账号）、失败计数锁死、审计 sso_link。
//
// 测试直写 provider 行与 KV pending 条目（绕开假 IdP 全链路——loadPendingContext 只依赖
// KV + 绑定 Cookie + provider 表，与 pending 的产生方式无关），sendMail mock 为成功。
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as OTPAuth from 'otpauth';
import { createTestContext, initSeeded, request, json, type TestContext } from './helpers';
import { Db, UserRepo, type Db as DbT } from '../src/db';
import { kvStoreFor } from '../src/utils/kv-store';
import { randomString, encryptSecret, hashPassword } from '../src/utils/crypto';
import { invalidateSettingsCache } from '../src/db/repos/system';

const sendMailMock = vi.hoisted(() => ({
  sendMail: vi.fn(async () => undefined),
}));

vi.mock('../src/utils/smtp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/smtp')>();
  return { ...actual, sendMail: sendMailMock.sendMail };
});

let ctx: TestContext;
let db: DbT;
const PENDING_TTL = 900;
let providerId: string;
let pendingToken: string;
let pendingCookie: string;
let lastPendingSubject: string;

function setSetting(key: string, value: string): void {
  ctx.db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, Date.now());
  invalidateSettingsCache();
}

async function seedProvider(): Promise<string> {
  const id = crypto.randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO sso_providers (id, kind, name, issuer_url, client_id, client_secret, scopes, enabled, trust_email_verified, created_at, updated_at)
       VALUES (?, 'oidc', 'Lab OIDC', 'https://idp.test/oidc', 'cid', 'cs', '["openid","email","profile"]', 1, 0, ?, ?)`
    )
    .run(id, Date.now(), Date.now());
  return id;
}

/** 直写 KV pending + 绑定 Cookie（loadPendingContext 的全部依赖：KV 条目 + 绑定 Cookie + provider 行） */
async function seedPending(profileEmail: string, subject = `sub-${randomString(8)}`): Promise<string> {
  lastPendingSubject = subject;
  pendingToken = randomString(43);
  const entry = {
    providerId,
    providerName: 'Lab OIDC',
    kind: 'oidc',
    profile: { subject, email: profileEmail, emailVerified: false, username: 'idp_user', displayName: 'IdP User', avatarUrl: null },
    tokens: { accessToken: 'enc:at', refreshToken: 'enc:rt', tokenType: 'Bearer', scope: 'openid email profile', expiresAt: Date.now() + 3_600_000 },
  };
  await kvStoreFor(ctx.env).put(ctx.env.KV, `sso:pending:${pendingToken}`, JSON.stringify(entry), { expirationTtl: PENDING_TTL });
  pendingCookie = `sso_pending=${pendingToken}`;
  return pendingToken;
}

async function seedUser(username: string, email: string, opts: { totp?: string } = {}): Promise<string> {
  const user = await UserRepo.createUser(db, {
    username,
    email,
    passwordHash: await hashPassword('password123'),
  });
  if (opts.totp) {
    const sealed = await encryptSecret(opts.totp, ctx.env.ENCRYPTION_KEY ?? '');
    await UserRepo.setTotpSecret(db, user.id, `enc:${sealed}`);
    await UserRepo.enableTotp(db, user.id, 0);
  }
  return user.id;
}

/** 生成当前 TOTP 动态码 */
function totpCode(base32: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: 'Picumet',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32),
  });
  return totp.generate();
}

function cookieOf(res: Response, name: string): string {
  const match = (res.headers.get('set-cookie') ?? '').match(new RegExp(`${name}=([^;\\s]+)`));
  return match ? match[1] : '';
}

const LINK = (id: string) => `/api/auth/sso/${id}/link`;
const VERIFY = (id: string) => `/api/auth/sso/${id}/link-verify`;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  db = Db.fromAny(ctx.env.DB as unknown as Parameters<typeof Db.fromSqlite>[0]);
});

beforeEach(async () => {
  sendMailMock.sendMail.mockClear();
  setSetting('sso_enabled', 'true');
  providerId = await seedProvider();
  pendingToken = '';
  pendingCookie = '';
});

describe('关联已有账号：密码步骤', () => {
  it('缺绑定 Cookie → 400 SSO_PENDING_INVALID（登录 CSRF 防线与注册分支同源）', async () => {
    const token = await seedPending('any@idp.test');
    const res = await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: 'sso_pending=wrong-value',
      body: { token, identifier: 'someone', password: 'whatever' },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('SSO_PENDING_INVALID');
  });

  it('密码错误与不存在用户统一 401 文案（防枚举），并落 login_failed 审计', async () => {
    await seedUser('alice', 'alice@test.local');
    const token = await seedPending('sso_new@idp.test');
    for (const identifier of ['alice', 'nobody-here']) {
      const res = await request(ctx, LINK(providerId), {
        method: 'POST',
        cookie: pendingCookie,
        body: { token, identifier, password: 'wrong-pass' },
      });
      expect(res.status).toBe(401);
      expect((await json(res)).error.message).toBe('用户名或密码错误');
    }
    const audits = ctx.db.prepare(`SELECT COUNT(*) AS c FROM access_logs WHERE action = 'login_failed'`).get() as { c: number };
    expect(Number(audits.c)).toBe(2);
  });

  it('无 TOTP 无 SMTP：密码即全部因子，直接关联并登录（step done）', async () => {
    await seedUser('bob', 'bob@test.local');
    const token = await seedPending('sso_new@idp.test');
    const res = await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, identifier: 'bob', password: 'password123' },
    });
    expect(res.status).toBe(200);
    const body = await json<{ data: { step: string; user: { username: string } } }>(res);
    expect(body.data.step).toBe('done');
    expect(body.data.user.username).toBe('bob');
    // 会话 Cookie 已下发（linked=true 登录）
    expect(res.headers.get('set-cookie') ?? '').toContain('auth_token=');
    // 身份行落库 + 令牌密文
    const identity = ctx.db
      .prepare(`SELECT user_id, access_token FROM sso_identities WHERE provider_id = ?`)
      .get(providerId) as { user_id: string; access_token: string };
    expect(identity.access_token).toBe('enc:at');
    const user = ctx.db.prepare(`SELECT id FROM users WHERE username = 'bob'`).get() as { id: string };
    expect(identity.user_id).toBe(user.id);
    // sso_link 审计 + pending 一次性消费
    const audit = ctx.db.prepare(`SELECT action FROM access_logs WHERE user_id = ? AND action = 'sso_link'`).get(user.id) as { action: string };
    expect(audit.action).toBe('sso_link');
    expect(await ctx.env.KV.get(`sso:pending:${token}`)).toBeNull();
    expect(cookieOf(res, 'sso_pending')).toBe('');
  });

  it('已绑定同账号：幂等 done；已绑定其他账号：409 SSO_IDENTITY_BOUND', async () => {
    await seedUser('carol', 'carol@test.local');
    await seedUser('dave', 'dave@test.local');
    const token = await seedPending('sso_new@idp.test');
    // 预置身份行：该第三方 subject 已绑定 carol
    ctx.db
      .prepare(
        `INSERT INTO sso_identities (id, provider_id, user_id, subject, email, access_token, refresh_token, created_at, updated_at)
         VALUES (?, ?, (SELECT id FROM users WHERE username = 'carol'), ?, 'carol@idp.test', 'enc:at-old', 'enc:rt-old', ?, ?)`
      )
      .run(crypto.randomUUID(), providerId, lastPendingSubject, Date.now(), Date.now());

    // 另一个本地账号（dave）尝试用同一 pending 关联 → subject 已绑定 carol，409 且 pending 保留
    const res2 = await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, identifier: 'dave', password: 'password123' },
    });
    expect(res2.status).toBe(409);
    expect((await json(res2)).error.code).toBe('SSO_IDENTITY_BOUND');
    expect(await ctx.env.KV.get(`sso:pending:${token}`)).not.toBeNull();

    // 属主本人（carol）→ 幂等收尾：刷新身份行（令牌换成 pending 里的新密文）并登录
    const res = await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, identifier: 'carol', password: 'password123' },
    });
    expect(res.status).toBe(200);
    const body = await json<{ data: { step: string; user: { username: string } } }>(res);
    expect(body.data.step).toBe('done');
    expect(body.data.user.username).toBe('carol');
    const refreshed = ctx.db.prepare(`SELECT access_token FROM sso_identities WHERE provider_id = ?`).get(providerId) as { access_token: string };
    expect(refreshed.access_token).toBe('enc:at');
  });
});

describe('关联已有账号：二次因子', () => {
  it('TOTP 账号 → step totp；错码计数；对码完成绑定', async () => {
    const base32 = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await seedUser('erin', 'erin@test.local', { totp: base32 });
    const token = await seedPending('sso_new@idp.test');
    const first = await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, identifier: 'erin', password: 'password123' },
    });
    expect(first.status).toBe(200);
    expect((await json(first)).data.step).toBe('totp');
    // 中间态写回 KV（服务端持有目标账号，前端只拿步骤）
    expect(await ctx.env.KV.get(`sso:pending:${token}`)).toContain('"step":"totp"');

    const wrong = await request(ctx, VERIFY(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, code: '000000' },
    });
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).error.message).toContain('两步验证');

    const ok = await request(ctx, VERIFY(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, code: totpCode(base32) },
    });
    expect(ok.status).toBe(200);
    const body = await json<{ data: { step: string; user: { username: string } } }>(ok);
    expect(body.data.user.username).toBe('erin');
    const identity = ctx.db.prepare(`SELECT user_id FROM sso_identities WHERE provider_id = ?`).get(providerId) as { user_id: string };
    const erin = ctx.db.prepare(`SELECT id FROM users WHERE username = 'erin'`).get() as { id: string };
    expect(identity.user_id).toBe(erin.id);
  });

  it('邮箱步骤：发码到账号邮箱（非提供方邮箱）、错码进 attempts、对码消费后绑定', async () => {
    setSetting('smtp_host', '"smtp.test.local"');
    await seedUser('frank', 'frank@test.local');
    const token = await seedPending('sso_new@idp.test');
    const first = await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, identifier: 'frank@test.local', password: 'password123' },
    });
    expect(first.status).toBe(200);
    const body = await json<{ data: { step: string; emailMasked: string } }>(first);
    expect(body.data.step).toBe('email');
    expect(body.data.emailMasked).toBe('f***@test.local');
    // 验证码确实发往账号邮箱（renderSsoLinkOtpMail 收件人由 sendMail 参数决定）
    expect(sendMailMock.sendMail).toHaveBeenCalledWith(
      expect.anything(),
      'frank@test.local',
      expect.stringContaining('身份关联验证码'),
      expect.stringContaining('身份关联')
    );

    const row = ctx.db
      .prepare(`SELECT id, code, attempts FROM email_tokens WHERE email = 'frank@test.local' AND purpose = 'sso_link' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string; code: string; attempts: number };
    expect(row).toBeTruthy();

    const wrong = await request(ctx, VERIFY(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, code: '999999' },
    });
    expect(wrong.status).toBe(400);
    expect((ctx.db.prepare(`SELECT attempts FROM email_tokens WHERE id = ?`).get(row.id) as { attempts: number }).attempts).toBe(1);

    const ok = await request(ctx, VERIFY(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, code: String(row.code) },
    });
    expect(ok.status).toBe(200);
    // 验证码一次性消费
    expect(ctx.db.prepare(`SELECT COUNT(*) AS c FROM email_tokens WHERE id = ?`).get(row.id)).toMatchObject({ c: 0 });
  });

  it('连续 5 次错码 → 429 锁定并清 pending；再 link 也被拒', async () => {
    setSetting('smtp_host', '"smtp.test.local"');
    await seedUser('gina', 'gina@test.local');
    const token = await seedPending('sso_new@idp.test');
    await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, identifier: 'gina', password: 'password123' },
    });
    for (let i = 0; i < 5; i++) {
      const res = await request(ctx, VERIFY(providerId), { method: 'POST', cookie: pendingCookie, body: { token, code: '111111' } });
      expect([400, 429]).toContain(res.status);
    }
    const locked = await request(ctx, VERIFY(providerId), { method: 'POST', cookie: pendingCookie, body: { token, code: '111111' } });
    expect(locked.status).toBe(429);
    expect((await json(locked)).error.code).toBe('SSO_LINK_LOCKED');
    // pending 已清（绑定 Cookie 同步失效）：再走密码步骤也是 400，必须重新第三方授权
    const again = await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, identifier: 'gina', password: 'password123' },
    });
    expect(again.status).toBe(400);
    expect((await json(again)).error.code).toBe('SSO_PENDING_INVALID');
  });

  it('未过密码步骤直接调 verify → 400 SSO_LINK_NOT_STARTED', async () => {
    const token = await seedPending('sso_new@idp.test');
    const res = await request(ctx, VERIFY(providerId), { method: 'POST', cookie: pendingCookie, body: { token, code: '123456' } });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('SSO_LINK_NOT_STARTED');
  });
});

describe('关联已有账号：封禁与站点开关', () => {
  it('封禁账号：密码正确也 403 SSO_ACCOUNT_DISABLED', async () => {
    await seedUser('henry', 'henry@test.local');
    ctx.db.exec(`UPDATE users SET status = 'banned' WHERE username = 'henry'`);
    const token = await seedPending('sso_new@idp.test');
    const res = await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, identifier: 'henry', password: 'password123' },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('SSO_ACCOUNT_DISABLED');
  });

  it('SSO 总开关关闭 → 403 SSO_DISABLED', async () => {
    setSetting('sso_enabled', 'false');
    const token = await seedPending('sso_new@idp.test');
    const res = await request(ctx, LINK(providerId), {
      method: 'POST',
      cookie: pendingCookie,
      body: { token, identifier: 'someone', password: 'x' },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('SSO_DISABLED');
  });
});
