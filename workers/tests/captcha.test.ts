// 人机验证（Turnstile / reCAPTCHA）：面断言矩阵 + 管理端配置 + 公开配置下发
// siteverify 通过 stub fetch 模拟（成功 / 失败 / action 不符 / 网络异常）
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createTestContext, initSeeded, request, registerAndLogin, getCsrf, json, type TestContext } from './helpers';
import { parseCaptchaConfig } from '../src/services/captcha';
import { invalidateSettingsCache } from '../src/db/repos/system';
import { encryptSecret } from '../src/utils/crypto';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function enableFace(face: string, provider = 'turnstile'): Promise<void> {
  const sealed = 'enc:' + (await encryptSecret('test-secret', ctx.env.ENCRYPTION_KEY));
  ctx.db.exec(`INSERT INTO system_settings (key, value, description, updated_at) VALUES
    ('captcha_provider', '${provider}', 'p', 0),
    ('captcha_enabled', 'true', 'e', 0),
    ('captcha_site_key', '0x SITE', 'sk', 0),
    ('captcha_secret_key', '${sealed}', 'sk2', 0)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  ctx.db.exec(`INSERT INTO system_settings (key, value, description, updated_at) VALUES
    ('captcha_face_${face}', 'true', 'face', 0)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
}

describe('parseCaptchaConfig', () => {
  it('provider 归一化与面解析', () => {
    const cfg = parseCaptchaConfig({
      captcha_provider: 'recaptcha',
      captcha_enabled: 'true',
      captcha_site_key: '6Lxx',
      captcha_secret_key: 'enc:AAA',
      captcha_face_login: 'true',
      captcha_face_upload: 'false',
    });
    expect(cfg.provider).toBe('recaptcha');
    expect(cfg.enabled).toBe(true);
    expect(cfg.faces.login).toBe(true);
    expect(cfg.faces.upload).toBe(false);
    // 缺省 provider = turnstile
    expect(parseCaptchaConfig({}).provider).toBe('turnstile');
  });
});

describe('assertCaptcha 面断言', () => {
  it('login 面启用：无 token → 403 CAPTCHA_REQUIRED（在密码校验之前）', async () => {
    await enableFace('login');
    invalidateSettingsCache();
    const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'wrong' } });
    expect(res.status).toBe(403);
    const data = await json(res) as { error: { code: string } };
    expect(data.error.code).toBe('CAPTCHA_REQUIRED');
  });

  it('siteverify 成功 → 进入密码校验（401 INVALID_CREDENTIALS）', async () => {
    await enableFace('login');
    invalidateSettingsCache();
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('challenges.cloudflare.com/turnstile/v0/siteverify');
      return new Response(JSON.stringify({ success: true, action: 'login' }), { status: 200 });
    }));
    const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'wrong', turnstileToken: 'tok' } });
    expect(res.status).toBe(401);
    const data = await json(res) as { error: { code: string } };
    expect(data.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('siteverify 失败 → 403 CAPTCHA_FAILED；action 不符 → 403', async () => {
    await enableFace('login');
    invalidateSettingsCache();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 })));
    const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'wrong', turnstileToken: 'tok' } });
    expect((await json(res) as { error: { code: string } }).error.code).toBe('CAPTCHA_FAILED');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, action: 'other' }), { status: 200 })));
    const res2 = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'wrong', turnstileToken: 'tok' } });
    expect((await json(res2) as { error: { code: string } }).error.code).toBe('CAPTCHA_FAILED');
  });

  it('siteverify 网络异常 → 503 fail-closed', async () => {
    await enableFace('login');
    invalidateSettingsCache();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'wrong', turnstileToken: 'tok' } });
    expect(res.status).toBe(503);
    expect((await json(res) as { error: { code: string } }).error.code).toBe('CAPTCHA_UNAVAILABLE');
  });

  it('recaptcha 提供方：v2 无 action 视为成功；端点为 google siteverify', async () => {
    await enableFace('login', 'recaptcha');
    invalidateSettingsCache();
    let hit = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      hit = String(url);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }));
    const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'wrong', turnstileToken: 'tok' } });
    expect(hit).toContain('www.google.com/recaptcha/api/siteverify');
    expect(res.status).toBe(401);
  });

  it('面未启用 → 放行（不查 siteverify）', async () => {
    ctx.db.exec(`UPDATE system_settings SET value = 'false' WHERE key = 'captcha_face_login'`);
    invalidateSettingsCache();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'wrong' } });
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('管理端配置与公开下发', () => {
  it('PATCH 保存（secret 加密落库）→ GET 掩码回读 → 公开面下发 sitekey → 审计', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'captchaadmin');
    await ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'captchaadmin'`);
    const login = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'captchaadmin', password: 'password123' } });
    const cookie = `auth_token=${(login.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
    const csrf = await getCsrf(ctx, cookie);

    // 清掉前面用例残留的人机验证配置，从零开始
    ctx.db.exec(`DELETE FROM system_settings WHERE key LIKE 'captcha_%'`);
    invalidateSettingsCache();

    // 启用但缺 sitekey/secret → 400
    const bad = await request(ctx, '/api/admin/settings', {
      method: 'PATCH', cookie, headers: { 'X-CSRF-Token': csrf },
      body: { captchaEnabled: true, captchaFaceLogin: true },
    });
    expect(bad.status).toBe(400);

    // 完整配置 → 200
    const save = await request(ctx, '/api/admin/settings', {
      method: 'PATCH', cookie, headers: { 'X-CSRF-Token': csrf },
      body: {
        captchaProvider: 'recaptcha',
        captchaEnabled: true,
        captchaSiteKey: '6L SITEKEY',
        captchaSecretKey: '6L SECRET',
        captchaFaceLogin: true,
      },
    });
    expect(save.status).toBe(200);
    const saved = await json(save) as { data: { savedKeys: string[] } };
    expect(saved.data.savedKeys).toContain('captcha_provider');
    expect(saved.data.savedKeys).toContain('captcha_secret_key');

    // GET：secret 掩码
    const get = await request(ctx, '/api/admin/settings', { cookie, headers: { 'X-CSRF-Token': csrf } });
    const cfg = await json(get) as { data: { captchaProvider: string; captchaEnabled: boolean; captchaSiteKey: string; captchaSecretKey: string; captchaFaceLogin: boolean } };
    expect(cfg.data.captchaProvider).toBe('recaptcha');
    expect(cfg.data.captchaEnabled).toBe(true);
    expect(cfg.data.captchaSiteKey).toBe('6L SITEKEY');
    expect(cfg.data.captchaSecretKey).toBe('******');
    expect(cfg.data.captchaFaceLogin).toBe(true);

    // secret 落库为密文
    const row = ctx.db.prepare(`SELECT value FROM system_settings WHERE key = 'captcha_secret_key'`).get() as { value: string };
    expect(row.value.startsWith('enc:')).toBe(true);

    // 公开设置下发（无 secret）
    const pub = await request(ctx, '/api/public/settings');
    const pubData = await json(pub) as { data: { captcha: { provider: string; enabled: boolean; siteKey: string; login: boolean; upload: boolean } } };
    expect(pubData.data.captcha.provider).toBe('recaptcha');
    expect(pubData.data.captcha.enabled).toBe(true);
    expect(pubData.data.captcha.siteKey).toBe('6L SITEKEY');
    expect(pubData.data.captcha.login).toBe(true);
    expect(pubData.data.captcha.upload).toBe(false);
    expect(JSON.stringify(pubData.data.captcha)).not.toContain('SECRET');

    // 审计：captcha_* 键写 settings_update
    const audit = ctx.db.prepare(`SELECT metadata FROM access_logs WHERE action = 'settings_update' ORDER BY created_at DESC LIMIT 1`).get() as { metadata: string };
    const keys = JSON.parse(audit.metadata).keys as string[];
    expect(keys).toContain('captcha_enabled');
    expect(keys).toContain('captcha_secret_key');
  });
});
