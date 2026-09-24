// 系统设置 schema 回归：整表单 PATCH 场景下的字段语义（§ 2026-09-24）
// - smtpFromEmail 空串 = 清空发件地址：未配置时 GET 返回 ''，整表单回传不能被 .email() 判 400
//   （历史 bug：z.string().email() 拒绝 ''，改 Logo/任意字段保存整体失败）
// - siteHeaderTitle 三态：undefined（未设置，跟随 siteTitle）/ ''（只显示 Logo）/ 字符串
import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '../src/services/admin/schemas';

// GET /api/admin/settings 返回的最小整表单（smtpFromEmail 未配置即为 ''）
const fullForm = {
  siteTitle: 'Picumet 本地测试',
  siteHeaderTitle: '',
  siteLogo: 'https://example.com/logo.png',
  siteFavicon: 'https://example.com/favicon.png',
  allowRegistration: true,
  allowGuestAccess: false,
  requireEmailVerification: false,
  enableTurnstile: false,
  rateLimitEnabled: true,
  rateLimitRequestsPerMinute: 50,
  maxConcurrentTransfers: 4,
  rateLimitDownloadsPerMinute: 120,
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: true,
  smtpUser: '',
  smtpPassword: '',
  smtpFromName: 'Picumet',
  smtpFromEmail: '',
  emailEnabled: false,
  directPrefix: '',
  rootTarget: 'landing' as const,
};

describe('SettingsSchema', () => {
  it('accepts a whole-form PATCH with an unconfigured (empty) sender email', () => {
    const parsed = SettingsSchema.safeParse(fullForm);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.smtpFromEmail).toBe('');
  });

  it('still rejects a malformed sender email', () => {
    expect(SettingsSchema.safeParse({ ...fullForm, smtpFromEmail: 'not-an-email' }).success).toBe(false);
  });

  it('treats siteHeaderTitle as a three-state field', () => {
    // 键缺失（后端未设置）→ undefined = 跟随 siteTitle
    const { siteHeaderTitle: _omitted, ...withoutHeader } = fullForm;
    const missing = SettingsSchema.safeParse(withoutHeader);
    expect(missing.success).toBe(true);
    if (missing.success) expect(missing.data.siteHeaderTitle).toBeUndefined();
    // '' = 只显示 Logo；字符串 = 自定义标题
    expect(SettingsSchema.parse({ siteHeaderTitle: '' }).siteHeaderTitle).toBe('');
    expect(SettingsSchema.parse({ siteHeaderTitle: 'HXCN' }).siteHeaderTitle).toBe('HXCN');
  });
});
