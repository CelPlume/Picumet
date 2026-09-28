// 系统设置 schema：整表单 PATCH 场景下的字段语义
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

  it('LAB F-08：未知/大小写错误的键直接拒绝（不再静默丢弃）', () => {
    expect(SettingsSchema.safeParse({ ...fullForm, allow_guest_access: true }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...fullForm, unknownKey: 1 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...fullForm, Allowguestaccess: true }).success).toBe(false);
  });

  it('LAB F-13：siteLogo/siteFavicon 写入层拒绝私网与非标端口地址', () => {
    // 公网 http(s) 地址放行
    expect(SettingsSchema.safeParse({ ...fullForm, siteLogo: 'https://cdn.example.com/logo.png' }).success).toBe(true);
    // 私网 / 回环 / 内网主机名拒绝
    expect(SettingsSchema.safeParse({ ...fullForm, siteLogo: 'https://127.0.0.1:8443/logo.png' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...fullForm, siteFavicon: 'http://192.168.1.10/favicon.ico' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...fullForm, siteLogo: 'https://metadata.google.internal/x' }).success).toBe(false);
    // 非标端口拒绝（与取件层 validateEndpoint 口径一致）
    expect(SettingsSchema.safeParse({ ...fullForm, siteLogo: 'https://example.com:8443/logo.png' }).success).toBe(false);
    // '' / null = 清空，放行
    expect(SettingsSchema.safeParse({ ...fullForm, siteLogo: '' }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...fullForm, siteFavicon: null }).success).toBe(true);
  });
});
