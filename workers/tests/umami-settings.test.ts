// Umami 访问统计：配置校验（utils/umami 单元 + SettingsSchema）+ 管理端 PATCH/GET 往返 +
// 来源二选一跨字段校验 + 写入口审计 + 公开配置装配
// - 脚本面地址是全站唯一可配置脚本执行面：写入口校验口径（仅 http(s)、无内嵌凭据、
//   无 fragment、长度上限、http 仅回环主机本地联调）
// - stats_source=umami 时脚本地址与 Website ID 必须已有效配置（否则公开面静默不注入）
// - 命中访问统计面键的保存写 settings_update 审计日志（记键不记值）
import { describe, it, expect, beforeAll } from 'vitest';
import {
  validateUmamiUrl,
  isUmamiWebsiteId,
  validateUmamiDomains,
  resolveUmamiPublicConfig,
} from '../src/utils/umami';
import { SettingsSchema } from '../src/services/admin/schemas';
import { createTestContext, initSeeded, request, json, getCsrf, type TestContext } from './helpers';

const UUID = '94db1cb1-74f4-4a40-ad6c-962362670409';
const SCRIPT_URL = 'https://umami.example.com/script.js';

describe('validateUmamiUrl', () => {
  it('https 任意主机放行（浏览器加载、无 SSRF 面）', () => {
    expect(validateUmamiUrl('https://umami.example.com/script.js')).toBe(true);
    expect(validateUmamiUrl('https://cloud.umami.is/script.js')).toBe(true);
    expect(validateUmamiUrl('https://192.168.1.10/script.js')).toBe(true); // 内网自托管 https 合法
  });

  it('http 仅回环主机（本地联调），其余拒绝', () => {
    expect(validateUmamiUrl('http://localhost:3000/script.js')).toBe(true);
    expect(validateUmamiUrl('http://127.0.0.1:3000/script.js')).toBe(true);
    expect(validateUmamiUrl('http://[::1]:3000/script.js')).toBe(true);
    expect(validateUmamiUrl('http://example.com/script.js')).toBe(false);
    expect(validateUmamiUrl('http://192.168.1.10/script.js')).toBe(false);
  });

  it('非 http(s) scheme / 内嵌凭据 / fragment / 超长 / 空 一律拒绝', () => {
    expect(validateUmamiUrl('javascript:alert(1)')).toBe(false);
    expect(validateUmamiUrl('data:text/html,x')).toBe(false);
    expect(validateUmamiUrl('https://user:pass@example.com/script.js')).toBe(false);
    expect(validateUmamiUrl('https://example.com/script.js#frag')).toBe(false);
    expect(validateUmamiUrl(`https://example.com/${'a'.repeat(500)}`)).toBe(false);
    expect(validateUmamiUrl('')).toBe(false);
  });
});

describe('isUmamiWebsiteId / validateUmamiDomains', () => {
  it('Website ID 必须是 UUID', () => {
    expect(isUmamiWebsiteId(UUID)).toBe(true);
    expect(isUmamiWebsiteId('94db1cb1')).toBe(false);
    expect(isUmamiWebsiteId('')).toBe(false);
  });

  it('域名白名单：逗号分隔裸 hostname；含 scheme/路径/端口/凭据/空项拒绝', () => {
    expect(validateUmamiDomains('example.com,www.example.com')).toBe(true);
    expect(validateUmamiDomains('example.com, www.example.com ')).toBe(true);
    expect(validateUmamiDomains('https://example.com')).toBe(false);
    expect(validateUmamiDomains('example.com:8080')).toBe(false);
    expect(validateUmamiDomains('example.com/path')).toBe(false);
    expect(validateUmamiDomains('user@example.com')).toBe(false);
    expect(validateUmamiDomains('example.com,,foo.com')).toBe(false);
    expect(validateUmamiDomains('')).toBe(false);
  });
});

describe('resolveUmamiPublicConfig', () => {
  const base = {
    stats_source: 'umami',
    umami_enabled: true,
    umami_script_url: SCRIPT_URL,
    umami_website_id: UUID,
  };

  it('来源非 umami / 未启用 → null（不注入）', () => {
    expect(resolveUmamiPublicConfig({ ...base, stats_source: 'd1' })).toBeNull();
    expect(resolveUmamiPublicConfig({ ...base, umami_enabled: false })).toBeNull();
  });

  it('脚本地址/Website ID 复核不过 → null（DB 落脏值也不会被注入）', () => {
    expect(resolveUmamiPublicConfig({ ...base, umami_script_url: 'http://example.com/x.js' })).toBeNull();
    expect(resolveUmamiPublicConfig({ ...base, umami_website_id: 'not-a-uuid' })).toBeNull();
    expect(resolveUmamiPublicConfig({ ...base, umami_script_url: undefined })).toBeNull();
  });

  it('有效配置 → 完整公开形态（可选开关默认 false）', () => {
    const cfg = resolveUmamiPublicConfig(base);
    expect(cfg).toEqual({
      enabled: true,
      scriptUrl: SCRIPT_URL,
      websiteId: UUID.toLowerCase(),
      performance: false,
      excludeSearch: false,
      doNotTrack: false,
    });
  });

  it('hostUrl/domains 脏值只丢弃该项，不破坏主采集路径', () => {
    const cfg = resolveUmamiPublicConfig({
      ...base,
      umami_host_url: 'http://bad.example.com', // http 非回环 → 丢弃
      umami_domains: 'example.com',
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.hostUrl).toBeUndefined();
    expect(cfg?.domains).toBe('example.com');
  });

  it('合法可选项与开关透传', () => {
    const cfg = resolveUmamiPublicConfig({
      ...base,
      umami_host_url: 'https://stats.example.com',
      umami_domains: 'example.com',
      umami_performance: true,
      umami_exclude_search: true,
      umami_do_not_track: true,
    });
    expect(cfg?.hostUrl).toBe('https://stats.example.com');
    expect(cfg?.domains).toBe('example.com');
    expect(cfg?.performance).toBe(true);
  });
});

describe('SettingsSchema umami 字段', () => {
  const fullForm = {
    siteTitle: 'Picumet',
    allowRegistration: true,
    statsSource: 'umami',
    umamiEnabled: true,
    umamiScriptUrl: SCRIPT_URL,
    umamiWebsiteId: UUID,
    umamiHostUrl: 'https://stats.example.com',
    umamiDomains: 'example.com',
    umamiPerformance: true,
    umamiExcludeSearch: true,
    umamiDoNotTrack: true,
  } as const;

  it('合法整表单接受；空串 / null 清空放行', () => {
    expect(SettingsSchema.safeParse(fullForm).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...fullForm, umamiScriptUrl: '' }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...fullForm, umamiWebsiteId: null }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...fullForm, umamiDomains: '' }).success).toBe(true);
  });

  it('非法脚本地址 / 非 UUID / 非法域名 / 坏枚举拒绝', () => {
    expect(SettingsSchema.safeParse({ ...fullForm, umamiScriptUrl: 'http://example.com/x.js' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...fullForm, umamiScriptUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...fullForm, umamiWebsiteId: 'not-a-uuid' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...fullForm, umamiDomains: 'example.com:8080' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...fullForm, statsSource: 'both' }).success).toBe(false);
  });
});

describe('管理端设置往返 + 审计 + 公开装配', () => {
  let ctx: TestContext;
  let adminCookie = '';
  let adminCsrf = '';

  beforeAll(async () => {
    ctx = createTestContext();
    await initSeeded(ctx);
    const login = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'admin123456' },
    });
    expect(login.status).toBe(200);
    adminCookie = `auth_token=${(login.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
    adminCsrf = await getCsrf(ctx, adminCookie);
  });

  async function patchSettings(body: Record<string, unknown>): Promise<Response> {
    return request(ctx, '/api/admin/settings', {
      method: 'PATCH',
      cookie: adminCookie,
      headers: { 'X-CSRF-Token': adminCsrf },
      body,
    });
  }

  async function publicSettings(): Promise<Record<string, unknown>> {
    const res = await request(ctx, '/api/public/settings');
    expect(res.status).toBe(200);
    return (await json<{ data: Record<string, unknown> }>(res)).data;
  }

  it('来源切 umami 但脚本地址/Website ID 未配置 → 400', async () => {
    const res = await patchSettings({ statsSource: 'umami' });
    expect(res.status).toBe(400);
    const err = await json<{ error: { code: string; message: string } }>(res);
    expect(err.error.message).toContain('脚本地址');
  });

  it('配置完整后 PATCH/GET 往返 + 公开装配下发', async () => {
    const res = await patchSettings({
      statsSource: 'umami',
      umamiEnabled: true,
      umamiScriptUrl: SCRIPT_URL,
      umamiWebsiteId: UUID.toUpperCase(),
      umamiHostUrl: 'https://stats.example.com',
      umamiDomains: 'example.com',
      umamiPerformance: true,
    });
    expect(res.status).toBe(200);
    const saved = await json<{ data: { savedKeys: string[] } }>(res);
    expect(saved.data.savedKeys).toEqual(
      expect.arrayContaining(['stats_source', 'umami_enabled', 'umami_script_url', 'umami_website_id']),
    );

    const adminGet = await json<{ data: Record<string, unknown> }>(await request(ctx, '/api/admin/settings', { cookie: adminCookie }));
    expect(adminGet.data.statsSource).toBe('umami');
    expect(adminGet.data.umamiEnabled).toBe(true);
    expect(adminGet.data.umamiScriptUrl).toBe(SCRIPT_URL);

    const pub = await publicSettings();
    const umami = pub.umami as Record<string, unknown>;
    expect(umami.enabled).toBe(true);
    expect(umami.scriptUrl).toBe(SCRIPT_URL);
    expect(umami.websiteId).toBe(UUID.toLowerCase());
    expect(umami.domains).toBe('example.com');
  });

  it('写入口审计：访问统计面键变更落 settings_update 日志（记键不记值）', async () => {
    await patchSettings({ umamiPerformance: false });
    const row = ctx.db
      .prepare(`SELECT action, metadata FROM access_logs WHERE action = 'settings_update' ORDER BY created_at DESC LIMIT 1`)
      .get() as { action: string; metadata: string } | undefined;
    expect(row?.action).toBe('settings_update');
    const keys = (JSON.parse(row?.metadata ?? '{}') as { keys: string[] }).keys;
    expect(keys).toContain('umami_performance');
  });

  it('来源切回 d1 → 公开配置不再下发（不注入）', async () => {
    const res = await patchSettings({ statsSource: 'd1' });
    expect(res.status).toBe(200);
    const pub = await publicSettings();
    expect(pub.umami).toBeNull();
  });
});
