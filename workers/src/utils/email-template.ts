// 邮件模板：视觉语言直接复刻落地页（components/landing/landing.css 的设计令牌）
//
// 落地页视觉语言 → 邮件映射（**邮件只做浅色版**：客户端深色模式由客户端自己反色，
// 我们不依赖 prefers-color-scheme，避免 QQ 邮箱 / Outlook 的深色渲染把对比度打穿）：
//   --lp-surface  #fafafb  窗体底色      → 外层页面底 + 卡片底
//   --lp-sunken   #f4f4f6  内凹区        → 验证码终端块 / 页脚条 / 链接兜底块
//   --lp-ink      #0a0a0b  主按钮墨色    → 主行动按钮（白字）
//   --lp-term     #101014  终端深底      → 验证码等宽字符块
//   --lp-term-fg  #d9d9e0  终端前景      → 验证码字符
//   --lp-ok/warn/bad                      → 状态语义色
//   14px 圆角 + 两层柔和大投影 + 顶部 9px 标题栏（三点 + mono 地址）→ .lp-window
//   .lp-num 墨色方块数字                → 步骤序号
//
// 客户端兼容：table layout + 全内联样式；不用 flex/grid/CSS 变量；圆角外再给一层实色兜底。
export interface MailBrand {
  /** 站点标题（缺省 Picumet） */
  siteTitle?: string;
  /** 站点 Logo 绝对地址（可空：为空时用首字母墨色方块兜底，同落地页 .lp-num） */
  siteLogo?: string;
  /** 站点主页绝对地址（页脚「由 xxx 发送」的链接目标） */
  siteUrl?: string;
  /** 强调色（hex）。仅用于**语义点缀**（顶部渐变条 / 焦点描边），主体仍用墨色按钮，
   *  与落地页「墨色主行动 + primary 点缀」的层级一致。非法值回退默认蓝 */
  primary?: string;
}

const DEFAULT_PRIMARY = '#4e80ee';

// 落地页令牌（浅色版）
const LP = {
  page: '#eef0f4',
  surface: '#fafafb',
  sunken: '#f4f4f6',
  border: '#e3e5ea',
  ink: '#0a0a0b',
  inkFg: '#ffffff',
  term: '#101014',
  termFg: '#d9d9e0',
  termDim: '#8b8b96',
  body: '#3f3f46',
  muted: '#6b7280',
  dim: '#9ca3af',
  ok: '#1a8a5a',
  warn: '#c2751a',
  bad: '#c8342f',
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif",
  mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace",
} as const;

function normalizePrimary(input?: string): string {
  const v = (input ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_PRIMARY;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** 与色相混合到白色，alpha = 0..1（用于主色浅底 / 渐变尾色） */
function tint(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * alpha).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

/** 与黑色混合，ratio = 0..1（用于主色深前景，保证白字对比度） */
function shade(hex: string, ratio: number): string {
  const [r, g, b] = hexToRgb(hex);
  const dark = (c: number) => Math.max(0, Math.round(c * ratio)).toString(16).padStart(2, '0');
  return `#${dark(r)}${dark(g)}${dark(b)}`;
}

/** 站点主页地址：品牌未配置时用相对路径（客户端会按邮件上下文解析，多数客户端会落成无效链接，故给绝对地址） */
function siteUrl(brand?: MailBrand): string {
  return brand?.siteUrl && /^https?:\/\//i.test(brand.siteUrl) ? brand.siteUrl : '';
}

function esc(input: string): string {
  return String(input).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m] as string);
}

function escAttr(input: string): string {
  return esc(String(input).replace(/[\r\n]/g, ''));
}

interface ShellOptions {
  heading: string;
  lede?: string;
  body: string;
  cta?: { label: string; url: string };
  /** 终端块右上角的 mono 标签（如 /api/auth/verify-email） */
  badge?: string;
  footnote?: string;
  brand?: MailBrand;
}

/** 邮件外壳：落地页窗体（标题栏 + 圆角 + 双层柔光投影） */
export function mailShell(opts: ShellOptions): string {
  const brand = opts.brand ?? {};
  const primary = normalizePrimary(brand.primary);
  const title = brand.siteTitle ?? 'Picumet';
  const initial = esc((title.trim().charAt(0) || 'P').toUpperCase());

  // Logo：优先真实图片（圆角 9px，同 .lp-num 比例），无图时用墨色方块 + 首字母
  const mark = brand.siteLogo
    ? `<img src="${escAttr(brand.siteLogo)}" alt="" width="22" height="22" style="display:block;border:0;border-radius:6px;">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
         <td width="22" height="22" align="center" bgcolor="${LP.ink}" style="width:22px;height:22px;border-radius:6px;font:600 11px/22px ${LP.font};color:${LP.inkFg};">${initial}</td>
       </tr></table>`;

  const button = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 2px;">
         <tr><td align="left" bgcolor="${LP.ink}" style="border-radius:9px;">
           <a href="${escAttr(opts.cta.url)}" style="display:inline-block;padding:12px 22px;font:600 14px/1 ${LP.font};color:${LP.inkFg};text-decoration:none;border-radius:9px;">${esc(opts.cta.label)}</a>
         </td></tr>
       </table>`
    : '';

  const foot = opts.footnote
    ? `<p style="margin:20px 0 0;padding-top:18px;border-top:1px solid ${LP.border};font:400 12px/1.75 ${LP.font};color:${LP.dim};">${esc(opts.footnote)}</p>`
    : '';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:${LP.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${LP.page};padding:32px 14px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:528px;">
      <tr><td style="border-radius:14px;overflow:hidden;border:1px solid ${LP.border};background:${LP.surface};box-shadow:0 60px 120px -50px ${LP.ink}29,0 24px 48px -24px ${LP.ink}1f;">
        <tr><td style="padding:26px 28px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="middle" width="22">${mark}</td>
            <td valign="middle" style="padding-left:9px;font:600 13px/1.3 ${LP.font};color:${LP.body};letter-spacing:.1px;">${esc(title)}</td>
          </tr></table>
          ${opts.badge ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;"><tr><td bgcolor="${tint(primary, 0.9)}" style="border-radius:6px;padding:3px 8px;font:500 11px/1.6 ${LP.mono};color:${shade(primary, 0.7)};">${esc(opts.badge)}</td></tr></table>` : ''}
          <h1 style="margin:${opts.badge ? '14px' : '20px'} 0 0;font:600 21px/1.45 ${LP.font};color:${LP.ink};letter-spacing:-.2px;">${esc(opts.heading)}</h1>
          ${opts.lede ? `<p style="margin:9px 0 0;font:400 14px/1.75 ${LP.font};color:${LP.muted};">${esc(opts.lede)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:18px 28px 28px;">
          ${opts.body}
          ${button}
          ${foot}
        </td></tr>
      </td></tr>
      <tr><td style="padding-top:18px;text-align:center;font:400 11px/1.7 ${LP.font};color:${LP.dim};letter-spacing:.3px;">
        由 <a href="${escAttr(siteUrl(brand))}" style="color:${LP.muted};text-decoration:none;font-weight:600;">${esc(title)}</a> 发送 · 自动邮件，请勿直接回复
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** 验证码终端块：落地页 .lp-term 的邮件版（深底 + 等宽大字 + 顶部 mono 标签） */
export function mailCodeBlock(code: string, brand?: MailBrand): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px;">
  <tr><td bgcolor="${LP.term}" style="border-radius:12px;padding:18px 20px 20px;">
    <p style="margin:0;font:500 10px/1.4 ${LP.mono};color:${LP.termDim};letter-spacing:.8px;text-transform:uppercase;">verification code</p>
    <p style="margin:14px 0 0;font:700 34px/1.1 ${LP.mono};color:${LP.termFg};letter-spacing:12px;text-align:center;">${esc(code)}</p>
    <p style="margin:14px 0 0;text-align:center;font:400 11px/1.6 ${LP.font};color:${LP.termDim};">${brand?.siteTitle ?? 'Picumet'} · 5 分钟内有效 · 仅可使用一次</p>
  </td></tr>
</table>`;
}

/** 内凹提示条（落地页 --lp-sunken）：用于有效期 / 兜底链接等次级信息 */
export function mailNote(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">
  <tr><td bgcolor="${LP.sunken}" style="border-radius:9px;padding:13px 15px;">
    <p style="margin:0;font:400 13px/1.8 ${LP.font};color:${LP.body};">${esc(text).replace(/\n/g, '<br>')}</p>
  </td></tr></table>`;
}

/** 兜底链接块：按钮点不了时复制到浏览器（链接本身不设超链接样式，避免被客户端吃掉） */
export function mailFallbackLink(label: string, url: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">
  <tr><td bgcolor="${LP.sunken}" style="border-radius:9px;padding:13px 15px;">
    <p style="margin:0 0 6px;font:400 12px/1.7 ${LP.font};color:${LP.muted};">${esc(label)}</p>
    <p style="margin:0;font:400 12px/1.7 ${LP.mono};color:${LP.ink};word-break:break-all;">${esc(url)}</p>
  </td></tr></table>`;
}

/** 注册验证码邮件 */
export function renderRegisterOtpMail(code: string, brand?: MailBrand): string {
  return mailShell({
    brand,
    badge: '注册',
    heading: '注册验证码',
    lede: '在注册页填入下面的 6 位验证码即可完成账号创建。',
    body: mailCodeBlock(code, brand) + mailNote('若非本人操作，请忽略本邮件——不会有账号被创建。'),
  });
}

/** 邮箱验证 / 完成注册邮件（带一键按钮 + 兜底链接）
 *  variant='confirmRegister'：待验证注册核销（迁移 0016），账号在点链接前**未落库**
 *  variant='verify'（默认）：存量已建号用户的补验证
 */
export function renderVerifyEmailMail(
  username: string,
  url: string,
  brand?: MailBrand,
  variant: 'verify' | 'confirmRegister' = 'verify'
): string {
  const isRegister = variant === 'confirmRegister';
  return mailShell({
    brand,
    badge: isRegister ? '完成注册' : '邮箱验证',
    heading: isRegister ? `${username}，确认创建你的账号` : `${username}，验证你的邮箱`,
    lede: isRegister
      ? '点击下方按钮即完成注册并登录。你的账号在点击之前尚未创建，因此此链接 24 小时内有效。'
      : '点击下方按钮完成邮箱验证，此链接 24 小时内有效。',
    body: mailFallbackLink('按钮无法点击？复制此链接到浏览器打开', url),
    cta: { label: isRegister ? '创建账号' : '验证邮箱', url },
    footnote: '若非本人操作，请忽略本邮件——你的账号不会被创建。',
  });
}

/** 密码重置邮件 */
export function renderPasswordResetMail(username: string, url: string, brand?: MailBrand): string {
  return mailShell({
    brand,
    badge: '密码重置',
    heading: `${username}，重置你的密码`,
    lede: '点击下方按钮设置新密码，此链接 15 分钟内有效。',
    body: mailFallbackLink('按钮无法点击？复制此链接到浏览器打开', url),
    cta: { label: '重置密码', url },
    footnote: '若非本人操作，请忽略本邮件——你的密码不会被更改。',
  });
}

/** 测试邮件（管理端「发送测试邮件」，用于核对 SMTP 与模板渲染） */
export function renderTestMail(to: string, brand?: MailBrand): string {
  const primary = normalizePrimary(brand?.primary);
  return mailShell({
    brand,
    badge: 'SMTP 自检',
    heading: '邮件服务配置正常',
    lede: `这是一封发往 ${to} 的测试邮件，收到即表示 SMTP 配置与发信通道可用。`,
    body: mailNote(`强调色 ${primary} · 模板 branded-v2 · 由管理端「发送测试邮件」触发。`),
  });
}
// ============ 账号安全类验证码（改密 / 换绑邮箱） ============

/** 从设置行读取邮件品牌（users/handlers 的 MailSettings 形状） */
export function mailBrandFrom(mail: { get: (k: string) => unknown }): MailBrand {
  const str = (k: string): string | undefined => {
    const v = mail.get(k);
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  return {
    siteTitle: str('site_title') || 'Picumet',
    siteLogo: str('site_logo'),
    siteUrl: str('site_url'),
    primary: str('accent_color'),
  };
}

/** 修改密码验证码 */
export function renderPasswordCodeMail(code: string, brand: MailBrand, username: string): string {
  return mailShell({
    brand,
    badge: '账号安全',
    heading: `${username}，修改密码验证码`,
    lede: '在「修改密码」表单中填入下面的 6 位验证码即可完成改密。',
    body: mailCodeBlock(code, brand) + mailNote('若非本人操作，请忽略本邮件——你的密码不会被更改。'),
  });
}

/** 换绑邮箱验证码（label 为动作说明，如「确认新邮箱」） */
export function renderEmailCodeMail(code: string, brand: MailBrand, label: string): string {
  return mailShell({
    brand,
    badge: '账号安全',
    heading: label === '确认新邮箱' ? '确认你的新邮箱' : '邮箱验证码',
    lede: '在「邮箱管理」表单中填入下面的 6 位验证码完成操作。',
    body: mailCodeBlock(code, brand) + mailNote('若非本人操作，请忽略本邮件——你的邮箱不会被更改。'),
  });
}
