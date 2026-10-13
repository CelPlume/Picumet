// 人机验证（服务端，双提供方：Cloudflare Turnstile / Google reCAPTCHA v2/v3 经典版）
//
// 面语义：assertCaptcha(c, action, token) —— 面未启用直接放行；启用后 token 缺失 403
// CAPTCHA_REQUIRED，siteverify 失败/action 不符 403 CAPTCHA_FAILED，siteverify 网络
// 异常/5xx 503 CAPTCHA_UNAVAILABLE（fail-closed：安全面宁可拒不可放）。
// siteverify 契约（官方文档核实）：
//   Turnstile  POST https://challenges.cloudflare.com/turnstile/v0/siteverify
//   reCAPTCHA  POST https://www.google.com/recaptcha/api/siteverify
//   均为 form（secret / response / remoteip）→ JSON { success, action?, ... }；token 2 分钟内
//   一次性消费；action 缺省的 v2 场景不做 action 比对。
// 配置来源：system_settings（captcha_provider / captcha_enabled / captcha_site_key /
// captcha_secret_key（AES-GCM 'enc:' 密文）/ captcha_face_* 七个面开关），进程内 60s 缓存，
// 管理端保存即失效。
import type { Context } from 'hono';
import type { Db } from '../db';
import { SettingsRepo } from '../db/repos/system';
import { decryptSecret } from '../utils/crypto';

export type CaptchaProvider = 'turnstile' | 'recaptcha';
export type CaptchaAction =
  | 'login'
  | 'register'
  | 'share_download'
  | 'upload'
  | 'password_change'
  | 'email_verify'
  | 'password_reset'
  | 'backup_codes';

export const CAPTCHA_FACES: readonly CaptchaAction[] = [
  'login',
  'register',
  'share_download',
  'upload',
  'password_change',
  'email_verify',
  'password_reset',
  'backup_codes',
];

interface CaptchaConfig {
  provider: CaptchaProvider;
  enabled: boolean;
  siteKey: string;
  secret: string;
  faces: Record<CaptchaAction, boolean>;
}

const EMPTY_FACES: Record<CaptchaAction, boolean> = {
  login: false,
  register: false,
  share_download: false,
  upload: false,
  password_change: false,
  email_verify: false,
  password_reset: false,
  backup_codes: false,
};

function parseBool(v: string | boolean | null | undefined): boolean {
  // 设置值可能被公开设置的 parse() JSON 解析为布尔字面量（'true' → true），两种形态都接受
  return v === true || v === 'true' || v === '1';
}

export function parseCaptchaConfig(raw: Record<string, string | boolean | null | undefined>): CaptchaConfig {
  const faces = { ...EMPTY_FACES };
  for (const face of CAPTCHA_FACES) {
    faces[face] = parseBool(raw[`captcha_face_${face}`]);
  }
  const secretEnc = raw['captcha_secret_key'] ?? '';
  return {
    provider: raw['captcha_provider'] === 'recaptcha' ? 'recaptcha' : 'turnstile',
    enabled: parseBool(raw['captcha_enabled']),
    siteKey: raw['captcha_site_key'] && raw['captcha_site_key'] !== 'null' ? String(raw['captcha_site_key']) : '',
    // secret 以 'enc:' 密文落库；此处仅判断是否已配置，解密在 siteverify 调用时进行
    secret: typeof secretEnc === 'string' && secretEnc.startsWith('enc:') ? secretEnc : '',
    faces,
  };
}

async function loadConfig(db: Db): Promise<CaptchaConfig> {
  // 逐键读取走 SettingsRepo 的 isolate 级 60s 设置缓存（键点查已零 DB 成本），
  // 此处不再自建缓存层——双缓存会让失效顺序变成隐藏契约
  const raw: Record<string, string | null | undefined> = {};
  const keys = ['captcha_provider', 'captcha_enabled', 'captcha_site_key', 'captcha_secret_key', ...CAPTCHA_FACES.map((f) => `captcha_face_${f}`)];
  for (const key of keys) {
    raw[key] = await SettingsRepo.get(db, key);
  }
  return parseCaptchaConfig(raw);
}

export interface CaptchaOutcome {
  /** 面未启用/未配置 → 放行（调用方继续原流程） */
  skipped: boolean;
  response?: Response;
}

export async function assertCaptcha(c: Context, action: CaptchaAction, token: string | undefined | null): Promise<CaptchaOutcome> {
  const db = c.get('db') as Db;
  const config = await loadConfig(db);
  // 总开关或该面未启用 → 放行；未配置 sitekey/secret（保存入口已阻止，兜底）→ 放行
  if (!config.enabled || !config.faces[action] || !config.siteKey || !config.secret) {
    return { skipped: true };
  }
  if (!token || !token.trim()) {
    return { skipped: false, response: failCaptcha(c, 403, 'CAPTCHA_REQUIRED', '请先完成人机验证') };
  }
  let secret = config.secret;
  try {
    if (c.env.ENCRYPTION_KEY) secret = (await decryptSecret(config.secret.slice(4), c.env.ENCRYPTION_KEY)) || '';
  } catch {
    secret = '';
  }
  if (!secret) {
    // 密文解不开 = 配置损坏 → fail-closed
    return { skipped: false, response: failCaptcha(c, 503, 'CAPTCHA_UNAVAILABLE', '人机验证配置异常，请稍后再试') };
  }

  const body = new URLSearchParams({ secret, response: token.trim() });
  const ip = c.req.header('cf-connecting-ip');
  if (ip) body.set('remoteip', ip);
  // siteverify 端点随提供方：Turnstile 与 reCAPTCHA 的表单字段与响应结构同构
  const endpoint =
    config.provider === 'recaptcha'
      ? 'https://www.google.com/recaptcha/api/siteverify'
      : 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  let verify: Response;
  try {
    verify = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { skipped: false, response: failCaptcha(c, 503, 'CAPTCHA_UNAVAILABLE', '人机验证服务暂不可用，请稍后再试') };
  }
  if (!verify.ok) {
    return { skipped: false, response: failCaptcha(c, 503, 'CAPTCHA_UNAVAILABLE', '人机验证服务暂不可用，请稍后再试') };
  }
  let result: { success?: boolean; 'error-codes'?: string[]; action?: string };
  try {
    result = (await verify.json()) as typeof result;
  } catch {
    return { skipped: false, response: failCaptcha(c, 503, 'CAPTCHA_UNAVAILABLE', '人机验证服务响应异常，请稍后再试') };
  }
  if (result.success !== true) {
    console.error('[captcha] verify failed:', JSON.stringify(result['error-codes'] ?? []));
    return { skipped: false, response: failCaptcha(c, 403, 'CAPTCHA_FAILED', '人机验证未通过，请重试') };
  }
  // action 绑定：一次性 token 是第一道防线，action 匹配是第二道（reCAPTCHA v2 无 action，跳过）
  if (result.action && result.action !== action) {
    return { skipped: false, response: failCaptcha(c, 403, 'CAPTCHA_FAILED', '人机验证与当前操作不符，请重试') };
  }
  return { skipped: true };
}

function failCaptcha(c: Context, status: number, code: string, message: string): Response {
  return c.json({ success: false, error: { code, message } }, status as 403 | 503);
}

/** 管理端校验：总开关或任一面开启 ⇒ sitekey 与 secret 必须已配置 */
export function validateCaptchaSave(
  input: { captchaEnabled?: boolean; captchaSiteKey?: string | null; captchaSecretKey?: string | null; faces: Record<CaptchaAction, boolean | undefined> },
  currentSecretConfigured: boolean
): string | null {
  const anyFace = CAPTCHA_FACES.some((f) => input.faces[f] === true);
  if (!input.captchaEnabled && !anyFace) return null;
  const siteKey = input.captchaSiteKey?.trim();
  if (input.captchaEnabled && anyFace && (!siteKey || (!currentSecretConfigured && !input.captchaSecretKey?.trim()))) {
    return '启用人机验证时必须填写 Site Key 与 Secret Key';
  }
  if (anyFace && siteKey && !currentSecretConfigured && !input.captchaSecretKey?.trim()) {
    return '启用人机验证面时必须填写 Secret Key';
  }
  return null;
}
