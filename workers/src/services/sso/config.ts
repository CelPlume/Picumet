// SSO 配置层：站点总开关、公开配置装配、issuer 校验、凭据加解密、回调地址
// 安全口径见 docs/ARCHITECTURE_CN.md「SSO / OIDC 登录服务」。
import type { Db } from '../../db';
import { SettingsRepo, SsoProviderRepo } from '../../db';
import type { SsoProviderKind, SsoPublicConfig } from '@shared/types';
import type { Env } from '../../shared/types';
import { decryptSecret, encryptSecret } from '../../utils/crypto';
import { isPrivateHost } from '../../utils/ssrf';

/** 凭据密文前缀（与存储凭据 / 分享密码同一约定；详见 services/storage/providers.ts） */
export const CIPHER_PREFIX = 'enc:';

/** issuer 地址长度上限（OIDC issuer 是短 URL，正常不超过 200） */
export const ISSUER_MAX_LENGTH = 500;

/** 站点级总开关：读设置（缺行 / 脏值 = 关闭） */
export async function loadSsoEnabled(db: Db): Promise<boolean> {
  return SettingsRepo.getBool(db, 'sso_enabled', false);
}

/**
 * 公开配置装配（`GET /api/public/settings` 的 `sso` 字段）：
 * 总开关 + 启用的来源列表（只含 id/kind/name，无任何凭据）。
 */
export async function resolveSsoPublicConfig(db: Db): Promise<SsoPublicConfig> {
  const enabled = await loadSsoEnabled(db);
  if (!enabled) return { enabled: false, providers: [] };
  const rows = await SsoProviderRepo.listEnabled(db);
  return {
    enabled: true,
    providers: rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name })),
  };
}

/**
 * 是否允许回环地址（本地 IdP 联调）。**必须显式开启**（`SSO_ALLOW_LOOPBACK=true`）且非生产环境：
 * 只按 `ENVIRONMENT !== 'production'` 判定的话，部署时把 ENVIRONMENT 写成别的值（`prod`、未设置）
 * 就会在生产静默放行 `http://127.0.0.1:<任意端口>`，等于打开 SSRF 面。生产环境无论该变量如何都不放行。
 */
export function allowLoopbackIssuer(env: Env): boolean {
  return env.ENVIRONMENT !== 'production' && env.SSO_ALLOW_LOOPBACK === 'true';
}

/**
 * issuer / discovery 端点地址校验。
 *
 * 生产口径与「存储端点」一致（`validateEndpoint`）：http(s)、无内嵌凭据、端口仅 80/443、
 * 拒绝私网/保留/回环地址——Worker 会主动请求这些地址，属真实 SSRF 面（与 Umami 的
 * 浏览器脚本面不同，不能套用其宽松口径）。额外要求 OIDC issuer 不带 query 与 fragment。
 *
 * 非生产环境额外放行回环主机（`localhost` / `127.0.0.1` / `[::1]`）且不限端口，
 * 用于本地 IdP（keycloak / authentik / logto 容器）联调。
 */
export function validateSsoIssuerUrl(raw: string, opts: { allowLoopback: boolean }): boolean {
  const value = raw.trim();
  if (!value || value.length > ISSUER_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  // OIDC issuer 规范：不得携带 query / fragment（discovery 路径由 issuer 拼接得出）
  if (url.search || url.hash) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (opts.allowLoopback && (host === 'localhost' || host === '127.0.0.1' || host === '::1')) return true;
  if (url.port && url.port !== '80' && url.port !== '443') return false;
  return !isPrivateHost(url.hostname);
}

/**
 * 上游端点（authorization/token/jwks/userinfo）校验：与 issuer 同口径，
 * 但不要求无 query（部分 IdP 的端点自带 query）；空值直接判否。
 */
export function isAllowedUpstreamUrl(raw: string | null | undefined, opts: { allowLoopback: boolean }): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (opts.allowLoopback && (host === 'localhost' || host === '127.0.0.1' || host === '::1')) return true;
  if (url.port && url.port !== '80' && url.port !== '443') return false;
  return !isPrivateHost(url.hostname);
}

/** 凭据加密（`enc:` 前缀密文）；空值返回 null */
export async function sealCredential(plain: string | null | undefined, key: string): Promise<string | null> {
  if (!plain) return null;
  return CIPHER_PREFIX + (await encryptSecret(plain, key));
}

/**
 * 凭据解密。无密文 / 密钥缺失 / 密文非法（遗留数据或换钥）→ null，
 * 调用方按「无凭据」处理（不阻断列表接口）。
 */
export async function unsealCredential(cipher: string | null | undefined, key: string | undefined): Promise<string | null> {
  if (!cipher || !key) return null;
  try {
    return await decryptSecret(cipher.startsWith(CIPHER_PREFIX) ? cipher.slice(CIPHER_PREFIX.length) : cipher, key);
  } catch {
    return null;
  }
}

/**
 * OAuth 回调地址：**必须**注册到提供方后台，且与前端同源（开发经 Vite 代理、生产同域）。
 * 用 APP_BASE_URL 而不是 c.req.url：Worker 侧直连地址（8787）与浏览器可见地址（5173）不同。
 */
export function resolveRedirectUri(env: Env, providerId: string): string {
  return `${env.APP_BASE_URL.replace(/\/$/, '')}/api/auth/sso/${providerId}/callback`;
}

/** 默认 scope（管理员未自定义 `scopes` 时按 kind 取用） */
export const DEFAULT_SCOPES: Record<SsoProviderKind, string> = {
  google: 'openid email profile',
  oidc: 'openid email profile',
  github: 'read:user user:email',
};
