// OIDC / GitHub 协议层：discovery、授权跳转、code 换 token、id_token 验签、档案归一化。
// Auth.js 未采用：其 provider 列表是构建期静态配置、自带 session/adapter 表结构，
// 与本项目「D1 运行时配置 + 自签 JWT Cookie + 自定义补充注册页」三处冲突；
// 直接用 jose（已有依赖）+ fetch 实现，协议面更小、可控。
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JSONWebKeySet } from 'jose';
import type { SsoProviderRow } from '../../db';
import type { Env } from '../../shared/types';
import { ApiError } from '../../shared/errors';
import type { SsoProviderKind } from '@shared/types';
import { isAllowedUpstreamUrl } from './config';
import type { SsoAuthResult, SsoDiscovery, SsoProfile } from './types';

/** Google 用标准 discovery（与自托管 OIDC 同一条代码路径，仅 issuer 固定） */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

/** GitHub 不签发 id_token（OAuth2 web application flow），端点固定 */
const GITHUB = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  user: 'https://api.github.com/user',
  emails: 'https://api.github.com/user/emails',
} as const;

const DISCOVERY_CACHE_TTL = 3600; // discovery 文档缓存 1 小时
const HTTP_TIMEOUT_MS = 10_000;

/**
 * 上游 JSON 请求。**不跟随重定向**：`redirect: 'manual'` 后任何 3xx 直接判失败——
 * 白名单只校验了初始地址，若交给 fetch 自动跟随，被入侵/恶意提供方可用 302 把请求
 * （含 client_secret 的表单、带 Bearer token 的 userinfo 读取）引向内网或云元数据地址。
 */
async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (res.status >= 300 && res.status < 400) {
    throw new ApiError(502, 'SSO_UPSTREAM_REDIRECT', '身份提供商的端点返回了重定向，已按安全策略拒绝');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function strOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** base64url（PKCE code_challenge 与 Basic 头用；Workers 无 Buffer） */
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256：code_challenge = base64url(sha256(code_verifier)) */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** 缓存失效：issuer / clientId 变更后缓存的 discovery 文档失效 */
export async function clearDiscoveryCache(env: Env, providerId: string): Promise<void> {
  await env.KV.delete(`sso:disc:${providerId}`);
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, '');
}

const GITHUB_DISCOVERY: SsoDiscovery = {
  issuer: GITHUB.authorize,
  authorizationEndpoint: GITHUB.authorize,
  tokenEndpoint: GITHUB.token,
  userinfoEndpoint: null,
  jwksUri: null,
  tokenAuthMethods: null,
  kind: 'github',
};

/** 端点地址白名单复核（缓存读取与文档解析共用同一判定，避免两处口径漂移） */
function isValidDiscovery(d: SsoDiscovery, issuer: string, kind: SsoProviderKind, allowLoopback: boolean): boolean {
  const opts = { allowLoopback };
  if (normalizeIssuer(d.issuer) !== issuer || d.kind !== kind) return false;
  if (!isAllowedUpstreamUrl(d.authorizationEndpoint, opts) || !isAllowedUpstreamUrl(d.tokenEndpoint, opts)) return false;
  if (d.jwksUri !== null && !isAllowedUpstreamUrl(d.jwksUri, opts)) return false;
  if (d.userinfoEndpoint !== null && !isAllowedUpstreamUrl(d.userinfoEndpoint, opts)) return false;
  return true;
}

/**
 * 解析（并缓存）OIDC discovery 文档。文档里的每个端点逐个复核地址白名单——
 * 文档由上游控制，不能因为它来自 https 就无条件信任；**缓存读取同样复核**
 * （缓存只是加速手段，不是信任来源），且必须与当前 provider 的 issuer/kind 一致。
 */
export async function loadDiscovery(env: Env, provider: SsoProviderRow, allowLoopback: boolean): Promise<SsoDiscovery> {
  if (provider.kind === 'github') return GITHUB_DISCOVERY;
  const issuer = normalizeIssuer(provider.kind === 'google' ? GOOGLE_ISSUER : (provider.issuerUrl ?? ''));
  if (!issuer) throw new ApiError(500, 'SSO_NOT_CONFIGURED', '该来源未配置 issuer');
  const cacheKey = `sso:disc:${provider.id}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as SsoDiscovery;
      if (isValidDiscovery(parsed, issuer, provider.kind, allowLoopback)) return parsed;
    } catch {
      /* 脏缓存 → 重新拉取 */
    }
  }
  const { status, data } = await fetchJson(`${issuer}/.well-known/openid-configuration`);
  if (status !== 200 || typeof data !== 'object' || data === null) {
    throw new ApiError(502, 'SSO_DISCOVERY_FAILED', `无法读取身份提供商的 openid-configuration（HTTP ${status}）`);
  }
  const doc = data as Record<string, unknown>;
  const docIssuer = strOf(doc.issuer);
  // OIDC 规范：文档必须声明 issuer 且与配置一致（尾斜杠归一后比较）；缺字段视为不合规文档
  if (!docIssuer) throw new ApiError(502, 'SSO_DISCOVERY_INVALID', '身份提供商的 discovery 文档缺少 issuer');
  if (normalizeIssuer(docIssuer) !== issuer) {
    throw new ApiError(502, 'SSO_DISCOVERY_MISMATCH', '身份提供商返回的 issuer 与配置不一致');
  }
  const authorizationEndpoint = strOf(doc.authorization_endpoint);
  const tokenEndpoint = strOf(doc.token_endpoint);
  const jwksUri = strOf(doc.jwks_uri);
  const userinfoEndpoint = strOf(doc.userinfo_endpoint);
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
    ? (doc.token_endpoint_auth_methods_supported as unknown[]).filter((m): m is string => typeof m === 'string')
    : null;
  if (
    !isAllowedUpstreamUrl(authorizationEndpoint, { allowLoopback }) ||
    !isAllowedUpstreamUrl(tokenEndpoint, { allowLoopback })
  ) {
    throw new ApiError(502, 'SSO_DISCOVERY_INVALID', '身份提供商的授权/令牌端点地址不合法');
  }
  if (jwksUri && !isAllowedUpstreamUrl(jwksUri, { allowLoopback })) {
    throw new ApiError(502, 'SSO_DISCOVERY_INVALID', '身份提供商的 jwks_uri 地址不合法');
  }
  if (userinfoEndpoint && !isAllowedUpstreamUrl(userinfoEndpoint, { allowLoopback })) {
    throw new ApiError(502, 'SSO_DISCOVERY_INVALID', '身份提供商的 userinfo 地址不合法');
  }
  const discovery: SsoDiscovery = {
    issuer,
    authorizationEndpoint: authorizationEndpoint!,
    tokenEndpoint: tokenEndpoint!,
    userinfoEndpoint,
    jwksUri: jwksUri ?? null,
    tokenAuthMethods: methods,
    kind: provider.kind,
  };
  await env.KV.put(cacheKey, JSON.stringify(discovery), { expirationTtl: DISCOVERY_CACHE_TTL });
  return discovery;
}

/** 授权跳转地址（OIDC：state + nonce + PKCE；GitHub：state） */
export function buildAuthorizeUrl(
  provider: SsoProviderRow,
  discovery: SsoDiscovery,
  params: { redirectUri: string; state: string; nonce: string; challenge: string; scope: string }
): string {
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  if (discovery.kind === 'github') return url.toString();
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

interface TokenPayload {
  accessToken: string | null;
  refreshToken: string | null;
  tokenType: string | null;
  scope: string | null;
  expiresAt: number | null;
  idToken: string | null;
}

/** code 换 token（client_secret_post 优先，上游仅支持 basic 时走 Basic 头） */
export async function exchangeCode(
  provider: SsoProviderRow,
  discovery: SsoDiscovery,
  code: string,
  verifier: string,
  redirectUri: string,
  allowLoopback: boolean
): Promise<TokenPayload> {
  if (!isAllowedUpstreamUrl(discovery.tokenEndpoint, { allowLoopback })) {
    throw new ApiError(502, 'SSO_DISCOVERY_INVALID', '令牌端点地址不合法');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (discovery.kind === 'github') {
    if (provider.clientSecret) body.set('client_secret', provider.clientSecret);
    headers['User-Agent'] = 'Picumet';
  } else {
    const methods = discovery.tokenAuthMethods;
    const useBasic = !!methods && methods.includes('client_secret_basic') && !methods.includes('client_secret_post');
    if (useBasic) {
      headers.Authorization = `Basic ${btoa(`${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret)}`)}`;
    } else {
      body.set('client_secret', provider.clientSecret);
    }
    body.set('code_verifier', verifier);
  }
  const { status, data } = await fetchJson(discovery.tokenEndpoint, { method: 'POST', headers, body });
  const payload = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const accessToken = strOf(payload.access_token);
  if (status !== 200 || !accessToken) {
    const err = strOf(payload.error) ?? `HTTP ${status}`;
    const desc = strOf(payload.error_description);
    throw new ApiError(502, 'SSO_TOKEN_FAILED', `身份提供商拒绝令牌交换（${err}${desc ? `：${desc}` : ''}）`);
  }
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : null;
  return {
    accessToken,
    refreshToken: strOf(payload.refresh_token),
    tokenType: strOf(payload.token_type),
    scope: strOf(payload.scope),
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    idToken: strOf(payload.id_token),
  };
}

/**
 * id_token 验签：JWKS 直接取回后本地验签（不依赖 jose 的远端 JWKS 缓存语义，
 * 且可以先过地址白名单再发请求），校验 issuer / audience / nonce。
 */
export async function verifyIdToken(
  provider: SsoProviderRow,
  discovery: SsoDiscovery,
  idToken: string,
  nonce: string,
  allowLoopback: boolean
): Promise<Record<string, unknown>> {
  if (!discovery.jwksUri || !isAllowedUpstreamUrl(discovery.jwksUri, { allowLoopback })) {
    throw new ApiError(502, 'SSO_DISCOVERY_INVALID', '身份提供商未提供可用的 jwks_uri');
  }
  const { status, data } = await fetchJson(discovery.jwksUri);
  if (status !== 200 || typeof data !== 'object' || data === null) {
    throw new ApiError(502, 'SSO_JWKS_FAILED', `无法读取身份提供商的 JWKS（HTTP ${status}）`);
  }
  let payload: Record<string, unknown>;
  try {
    const { payload: verified } = await jwtVerify(idToken, createLocalJWKSet(data as JSONWebKeySet), {
      issuer: discovery.issuer,
      audience: provider.clientId,
    });
    payload = verified as Record<string, unknown>;
  } catch (err) {
    // 验签失败不区分原因（避免向调用方泄露细节），服务端日志留痕
    console.log('sso id_token verify failed', err instanceof Error ? err.message : String(err));
    throw new ApiError(401, 'SSO_ID_TOKEN_INVALID', '身份提供商返回的 id_token 校验失败');
  }
  if (strOf(payload.nonce) !== nonce) {
    throw new ApiError(401, 'SSO_NONCE_MISMATCH', '身份提供商返回的 nonce 不匹配');
  }
  return payload;
}

/** OIDC claims → 归一化档案（缺 email 时回退 userinfo 端点） */
async function profileFromOidc(
  discovery: SsoDiscovery,
  payload: Record<string, unknown>,
  accessToken: string,
  allowLoopback: boolean
): Promise<SsoProfile> {
  let claims = payload;
  // userinfo 端点在**使用前**再复核一次地址白名单（文档可能来自缓存；请求会带上 access_token）
  const userinfoEndpoint = discovery.userinfoEndpoint && isAllowedUpstreamUrl(discovery.userinfoEndpoint, { allowLoopback })
    ? discovery.userinfoEndpoint
    : null;
  if (!strOf(claims.email) && userinfoEndpoint) {
    const { status, data } = await fetchJson(userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (status === 200 && typeof data === 'object' && data !== null) {
      claims = { ...claims, ...(data as Record<string, unknown>) };
    }
  }
  const subject = strOf(claims.sub);
  if (!subject) throw new ApiError(502, 'SSO_PROFILE_INVALID', '身份提供商未返回 subject');
  const email = strOf(claims.email);
  return {
    subject,
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    username: strOf(claims.preferred_username) ?? strOf(claims.nickname) ?? strOf(claims.name) ?? (email ? email.split('@')[0] : null),
    displayName: strOf(claims.name),
    avatarUrl: strOf(claims.picture),
  };
}

/** GitHub：/user + （无公开邮箱时）/user/emails，取 primary 且 verified 的邮箱 */
async function profileFromGithub(accessToken: string): Promise<SsoProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Picumet',
  };
  const { status, data } = await fetchJson(GITHUB.user, { headers });
  if (status !== 200 || typeof data !== 'object' || data === null) {
    throw new ApiError(502, 'SSO_PROFILE_FAILED', `无法读取 GitHub 用户信息（HTTP ${status}）`);
  }
  const user = data as Record<string, unknown>;
  const subject = user.id == null ? null : String(user.id);
  if (!subject) throw new ApiError(502, 'SSO_PROFILE_INVALID', 'GitHub 未返回用户 id');
  const login = strOf(user.login);
  // 公开资料里的 email 不保证已验证，一律以 /user/emails 的 verified 记录为准
  let email: string | null = null;
  let emailVerified = false;
  const emails = await fetchJson(GITHUB.emails, { headers });
  if (emails.status === 200 && Array.isArray(emails.data)) {
    const list = emails.data as Array<Record<string, unknown>>;
    const verified = list.filter((e) => e.verified === true);
    const primary = verified.find((e) => e.primary === true) ?? verified[0];
    email = primary ? strOf(primary.email) : null;
    emailVerified = email !== null;
  }
  return {
    subject,
    email,
    emailVerified,
    username: login,
    displayName: strOf(user.name),
    avatarUrl: strOf(user.avatar_url),
  };
}

/** 回调第二步：按 provider 类型解析档案（OIDC 验签 id_token，GitHub 拉用户信息） */
export async function resolveProfile(
  provider: SsoProviderRow,
  discovery: SsoDiscovery,
  tokens: TokenPayload,
  nonce: string,
  allowLoopback: boolean
): Promise<SsoAuthResult> {
  const base = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
  };
  if (discovery.kind === 'github') {
    return { profile: await profileFromGithub(tokens.accessToken!), tokens: base };
  }
  if (!tokens.idToken) throw new ApiError(502, 'SSO_PROFILE_INVALID', '身份提供商未返回 id_token');
  const payload = await verifyIdToken(provider, discovery, tokens.idToken, nonce, allowLoopback);
  return { profile: await profileFromOidc(discovery, payload, tokens.accessToken!, allowLoopback), tokens: base };
}
