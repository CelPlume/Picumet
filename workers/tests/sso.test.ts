// 第三方登录（SSO / OIDC，迁移 0012 + 0013）：
// - 管理端来源 CRUD：单例约束（google/github 各一条）、issuer 校验（回环豁免需显式开关/生产口径）、
//   密钥掩码与「保持原值」语义、discovery 缓存失效、审计
// - 公开面：总开关 / 启用来源透出（仅 id/kind/name）
// - 登录链路（假 IdP：真 RS256 id_token + JWKS 验签）：既有身份直接登录 / 受信来源+已验证邮箱自动关联 /
//   补充注册（邮箱·用户名·密码 + 验证码 + 邀请码）、state 一次性、PKCE、GitHub 特例
// - 安全面：绑定 Cookie 防登录 CSRF、验证码以提交邮箱为准、trust_email_verified 开关、
//   大小写无关邮箱、上游重定向拒绝、停用来源拒绝、KV 不落明文令牌、空值口径
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';
import { decryptSecret } from '../src/utils/crypto';

const ISSUER = 'http://localhost:9443';
const OIDC_AUTHORIZE = `${ISSUER}/oauth2/authorize`;
const OIDC_TOKEN = `${ISSUER}/oauth2/token`;
const OIDC_JWKS = `${ISSUER}/oauth2/jwks`;
const OIDC_USERINFO = `${ISSUER}/oauth2/userinfo`;
const OIDC_DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = 'picumet-client';
const CLIENT_SECRET = 'picumet-secret';
const REDIRECT = 'http://localhost:8787/api/auth/sso/';

// GitHub 内置端点（生产固定地址，测试同样拦截）
const GH_TOKEN = 'https://github.com/login/oauth/access_token';
const GH_USER = 'https://api.github.com/user';
const GH_EMAILS = 'https://api.github.com/user/emails';

let ctx: TestContext;
let adminCookie: string;

// ============ 假 IdP ============
let publicJwk: JWK;
let signIdToken: (claims: Record<string, unknown>) => Promise<string>;

/** 假 IdP 的下一次响应内容（用例各自设置） */
const idp = {
  nonce: '',
  nonceOverride: null as string | null,
  audienceOverride: null as string | null,
  subject: 'idp-subject-1',
  email: 'sso_user@idp.test' as string | null,
  emailVerified: true,
  username: 'idp_user',
  /** discovery 覆盖项（缺 issuer / 内网端点 / 重定向等负向用例用） */
  discoveryOverride: null as Record<string, unknown> | null,
  /** 3xx 重定向注入：命中的 URL 前缀 → Location（验证「不跟随重定向」） */
  redirectFrom: null as string | null,
  /** OIDC token 端点最近一次收到的表单（断言 PKCE / client_secret 传递） */
  lastTokenForm: null as URLSearchParams | null,
  github: {
    id: 4242,
    login: 'gh_user',
    name: 'GH User',
    avatar_url: 'https://avatars.example.com/gh.png',
    emails: [{ email: 'gh_user@idp.test', primary: true, verified: true }],
  },
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (idp.redirectFrom && url.startsWith(idp.redirectFrom)) {
      return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    if (url === OIDC_DISCOVERY) {
      return jsonResponse(
        idp.discoveryOverride ?? {
          issuer: ISSUER,
          authorization_endpoint: OIDC_AUTHORIZE,
          token_endpoint: OIDC_TOKEN,
          jwks_uri: OIDC_JWKS,
          userinfo_endpoint: OIDC_USERINFO,
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        }
      );
    }
    if (url === OIDC_JWKS) return jsonResponse({ keys: [publicJwk] });
    if (url === OIDC_TOKEN && method === 'POST') {
      idp.lastTokenForm = new URLSearchParams(String(init?.body ?? ''));
      return jsonResponse({
        access_token: 'at-oidc',
        refresh_token: 'rt-oidc',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid email profile',
        id_token: await signIdToken({
          sub: idp.subject,
          email: idp.email ?? undefined,
          email_verified: idp.emailVerified,
          preferred_username: idp.username,
          name: 'IdP User',
          picture: 'https://cdn.example.com/idp.png',
        }),
      });
    }
    if (url === GH_TOKEN && method === 'POST') {
      return jsonResponse({ access_token: 'at-github', token_type: 'bearer', scope: 'read:user user:email' });
    }
    if (url === GH_USER) {
      return jsonResponse({
        id: idp.github.id,
        login: idp.github.login,
        name: idp.github.name,
        avatar_url: idp.github.avatar_url,
        email: null,
      });
    }
    if (url === GH_EMAILS) return jsonResponse(idp.github.emails);
    throw new Error(`unexpected outbound fetch: ${method} ${url}`);
  });
}

// ============ 测试辅助 ============
function setSetting(key: string, value: string): void {
  ctx.db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, Date.now());
}

function readSetting(key: string): string | undefined {
  const row = ctx.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

async function errCode(res: Response): Promise<string> {
  const body = await json<{ error: { code: string } }>(res);
  return body.error.code;
}

async function adminRequest(path: string, method: string, body?: unknown): Promise<Response> {
  return request(ctx, path, {
    method,
    cookie: adminCookie,
    headers: { 'X-CSRF-Token': await getCsrf(ctx, adminCookie) },
    body,
  });
}

interface ProviderItem {
  id: string;
  kind: string;
  name: string;
  issuerUrl: string | null;
  clientId: string;
  clientSecret: string;
  scopes: string | null;
  enabled: boolean;
  trustEmailVerified: boolean;
  redirectUri: string;
}

async function createProvider(body: Record<string, unknown>): Promise<Response> {
  return adminRequest('/api/admin/sso/providers', 'POST', body);
}

/** 建一个自定义 OIDC 来源：既有用例默认「信任提供方邮箱验证」（自动关联路径），不信任的场景显式传 false */
async function createOidcProvider(name = 'Lab OIDC', opts: { trustEmailVerified?: boolean } = {}): Promise<ProviderItem> {
  const res = await createProvider({
    kind: 'oidc',
    name,
    issuerUrl: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    trustEmailVerified: opts.trustEmailVerified ?? true,
  });
  expect(res.status).toBe(201);
  const body = await json<{ data: { item: ProviderItem } }>(res);
  return body.data.item;
}

async function listProviders(): Promise<ProviderItem[]> {
  const body = await json<{ data: { items: ProviderItem[] } }>(
    await request(ctx, '/api/admin/sso/providers', { cookie: adminCookie })
  );
  return body.data.items;
}

/** 响应里某个 Cookie 的值（同一响应可能有多个 Set-Cookie，中间件会合并成一条头） */
function cookieValue(res: Response, name: string): string {
  const raw = res.headers.get('set-cookie') ?? '';
  const match = raw.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,\\s]+)`));
  return match ? `${name}=${match[1]}` : '';
}

/** 最近一次 /start 写入的绑定 Cookie 与最近一次回调写入的待办 Cookie */
let lastTxCookie = '';
let lastPendingCookie = '';

/**
 * 极简 Cookie jar：响应里删掉的绑定 Cookie，测试侧也必须「忘掉」，
 * 否则用例会替实现兜底（例如实现无条件清 `sso_pending` 时，测试仍拿着旧值把请求送过去）。
 */
function syncJarFrom(res: Response): void {
  const raw = res.headers.get('set-cookie') ?? '';
  if (raw.includes('sso_tx=;')) lastTxCookie = '';
  if (raw.includes('sso_pending=;')) lastPendingCookie = '';
}

/**
 * 触发授权跳转：取 state / 非ce / 绑定 Cookie。
 * `sso_tx` 是发起浏览器与授权事务的绑定凭证（缺它回调会被拒）。
 */
async function startFlow(providerId: string): Promise<{ state: string; location: URL }> {
  const res = await request(ctx, `/api/auth/sso/${providerId}/start`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  const state = location.searchParams.get('state') ?? '';
  idp.nonce = location.searchParams.get('nonce') ?? '';
  lastTxCookie = cookieValue(res, 'sso_tx');
  return { state, location };
}

/** 回调：默认带上发起时的绑定 Cookie；`cookieOverride` 用于缺 Cookie / 伪造 Cookie 的负向用例 */
async function callback(
  providerId: string,
  state: string,
  code = 'auth-code-1',
  cookieOverride?: string
): Promise<Response> {
  const res = await request(ctx, `/api/auth/sso/${providerId}/callback?code=${code}&state=${state}`, {
    cookie: cookieOverride === undefined ? lastTxCookie : cookieOverride,
  });
  syncJarFrom(res);
  return res;
}

/** 302 目标（路径 + 查询串），便于断言前端落地页 */
function redirectTarget(res: Response): string {
  const url = new URL(res.headers.get('location') ?? '');
  return url.pathname + url.search;
}

/** 回调响应里的待办令牌（同时记下绑定 Cookie，供 /pending、/complete 使用） */
function pendingTokenFrom(res: Response): string {
  lastPendingCookie = cookieValue(res, 'sso_pending');
  const url = new URL(res.headers.get('location') ?? '');
  return url.searchParams.get('token') ?? '';
}

async function fetchPending(token: string, cookieOverride?: string): Promise<Response> {
  const res = await request(ctx, `/api/auth/sso/pending?token=${token}`, {
    cookie: cookieOverride === undefined ? lastPendingCookie : cookieOverride,
  });
  syncJarFrom(res);
  return res;
}

async function complete(token: string, body: Record<string, unknown>, cookieOverride?: string): Promise<Response> {
  const res = await request(ctx, '/api/auth/sso/complete', {
    method: 'POST',
    cookie: cookieOverride === undefined ? lastPendingCookie : cookieOverride,
    body: { token, ...body },
  });
  syncJarFrom(res);
  return res;
}

function rows(sql: string, params: (string | number | null)[] = []): Array<Record<string, unknown>> {
  return ctx.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

function authCookieOf(res: Response): string {
  const match = (res.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/);
  return match ? `auth_token=${match[1]}` : '';
}

beforeAll(async () => {
  const keyPair = await generateKeyPair('RS256');
  publicJwk = await exportJWK(keyPair.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  // 用闭包捕获私钥，避免在模块作用域声明 WebCrypto/Node 的联合密钥类型
  signIdToken = (claims) =>
    new SignJWT({ ...claims, nonce: idp.nonceOverride ?? idp.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(idp.audienceOverride ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keyPair.privateKey);

  ctx = createTestContext();
  await initSeeded(ctx);
  installFetchStub();
  await registerAndLogin(ctx, 'sso_admin');
  ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'sso_admin'`);
  const relogin = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'sso_admin', password: 'password123' },
  });
  adminCookie = authCookieOf(relogin);
  expect(adminCookie).not.toBe('');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // 每个用例复位：总开关、注册门控、IdP 默认档案与签发参数
  setSetting('sso_enabled', 'false');
  setSetting('allow_registration', 'true');
  setSetting('require_email_verification', 'false');
  setSetting('invite_enabled', 'false');
  setSetting('invite_required', 'false');
  setSetting('invite_generation', 'all_users');
  setSetting('invite_max_per_user', '5');
  ctx.db.exec('DELETE FROM sso_identities');
  ctx.db.exec('DELETE FROM sso_providers');
  lastTxCookie = '';
  lastPendingCookie = '';
  idp.nonce = '';
  idp.nonceOverride = null;
  idp.audienceOverride = null;
  idp.discoveryOverride = null;
  idp.redirectFrom = null;
  idp.subject = `idp-subject-${Math.random().toString(36).slice(2, 10)}`;
  idp.email = `sso_${Math.random().toString(36).slice(2, 8)}@idp.test`;
  idp.emailVerified = true;
  idp.username = 'idp_user';
  idp.github = {
    ...idp.github,
    id: 4000 + Math.floor(Math.random() * 1000),
    emails: [{ email: `gh_${Math.random().toString(36).slice(2, 8)}@idp.test`, primary: true, verified: true }],
  };
});

describe('管理端来源 CRUD', () => {
  it('创建自定义 OIDC 来源：密钥掩码回显 + 回调地址可复制 + 默认不信任邮箱验证', async () => {
    const res = await createProvider({
      kind: 'oidc',
      name: '公司 SSO',
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(res.status).toBe(201);
    const item = (await json<{ data: { item: ProviderItem } }>(res)).data.item;
    expect(item.kind).toBe('oidc');
    expect(item.issuerUrl).toBe(ISSUER);
    expect(item.clientId).toBe(CLIENT_ID);
    expect(item.clientSecret).toBe('******');
    expect(item.enabled).toBe(true);
    // 自定义 OIDC 默认不信任提供方的邮箱验证声明（防接管既有账号）
    expect(item.trustEmailVerified).toBe(false);
    expect(item.redirectUri).toBe(`${REDIRECT}${item.id}/callback`);
    // 密文落库（不是明文）
    const row = rows('SELECT client_secret FROM sso_providers WHERE id = ?', [item.id])[0];
    expect(String(row.client_secret).startsWith('enc:')).toBe(true);
    expect(await decryptSecret(String(row.client_secret).slice(4), ctx.env.ENCRYPTION_KEY)).toBe(CLIENT_SECRET);
  });

  it('内置来源默认信任邮箱验证；google / github 各只能添加一个，开源 OIDC 不限', async () => {
    const google = await createProvider({ kind: 'google', name: 'Google', clientId: 'g', clientSecret: 's' });
    expect(google.status).toBe(201);
    expect((await json<{ data: { item: ProviderItem } }>(google)).data.item.trustEmailVerified).toBe(true);
    expect((await createProvider({ kind: 'google', name: 'Google 2', clientId: 'g', clientSecret: 's' })).status).toBe(409);
    expect(await errCode(await createProvider({ kind: 'google', name: 'Google 3', clientId: 'g', clientSecret: 's' }))).toBe(
      'SSO_PROVIDER_EXISTS'
    );
    expect((await createProvider({ kind: 'github', name: 'GitHub', clientId: 'h', clientSecret: 's' })).status).toBe(201);
    expect((await createProvider({ kind: 'github', name: 'GitHub 2', clientId: 'h', clientSecret: 's' })).status).toBe(409);
    await createOidcProvider('OIDC A');
    await createOidcProvider('OIDC B');
    expect((await listProviders()).length).toBe(4);
  });

  it('issuer 校验：自定义 OIDC 必填且需公网口径（私网/非标端口/查询串拒绝，回环需显式开关）', async () => {
    const base = { kind: 'oidc', name: 'X', clientId: 'c', clientSecret: 's' };
    expect((await createProvider({ ...base, issuerUrl: '' })).status).toBe(400);
    expect((await createProvider({ ...base, issuerUrl: 'http://10.0.0.5' })).status).toBe(400);
    expect((await createProvider({ ...base, issuerUrl: 'https://example.com:8080' })).status).toBe(400);
    expect((await createProvider({ ...base, issuerUrl: 'https://idp.example.com/?q=1' })).status).toBe(400);
    expect((await createProvider({ ...base, issuerUrl: 'not-a-url' })).status).toBe(400);
    // 非生产 + 显式开关才放行回环（本地 IdP 联调）
    expect((await createProvider({ ...base, issuerUrl: 'http://127.0.0.1:8080' })).status).toBe(201);
    // 内置来源不接受自定义地址
    expect((await createProvider({ kind: 'github', name: 'GH', clientId: 'c', clientSecret: 's', issuerUrl: ISSUER })).status).toBe(400);
  });

  it('回环 issuer 需要显式开关：生产环境或未开开关时一律拒绝', async () => {
    const body = JSON.stringify({ kind: 'oidc', name: 'Prod', issuerUrl: ISSUER, clientId: 'c', clientSecret: 's' });
    const csrf = await getCsrf(ctx, adminCookie);
    const call = (env: unknown) =>
      ctx.app.fetch(
        new Request('http://localhost:8787/api/admin/sso/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'X-CSRF-Token': csrf },
          body,
        }),
        env as typeof ctx.env,
        {} as ExecutionContext
      );
    // 生产环境：即便开了开关也不放行
    expect((await call({ ...ctx.env, ENVIRONMENT: 'production', SSO_ALLOW_LOOPBACK: 'true' })).status).toBe(400);
    // 非生产但未显式开启（例如 ENVIRONMENT 被写成 'prod' 的误部署）→ 同样拒绝
    expect((await call({ ...ctx.env, ENVIRONMENT: 'prod', SSO_ALLOW_LOOPBACK: undefined })).status).toBe(400);
    // 非生产 + 显式开启 → 放行
    expect((await call({ ...ctx.env, SSO_ALLOW_LOOPBACK: 'true' })).status).toBe(201);
  });

  it('更新：clientSecret 传掩码或空串保持原值，改 clientId 清 discovery 缓存，scope 空串归一为未设置', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    await startFlow(item.id); // 触发 discovery 并写入 KV 缓存
    expect(await ctx.kv.get(`sso:disc:${item.id}`)).not.toBeNull();

    const withBlankSecret = await adminRequest(`/api/admin/sso/providers/${item.id}`, 'PATCH', {
      clientSecret: '',
      scopes: '   ',
    });
    // 空串 = 保持原值（契约可达）；空 scope = 未设置
    expect(withBlankSecret.status).toBe(200);
    const row = rows('SELECT client_secret, scopes FROM sso_providers WHERE id = ?', [item.id])[0];
    expect(await decryptSecret(String(row.client_secret).slice(4), ctx.env.ENCRYPTION_KEY)).toBe(CLIENT_SECRET);
    expect(row.scopes).toBeNull();

    const res = await adminRequest(`/api/admin/sso/providers/${item.id}`, 'PATCH', {
      name: '重命名',
      clientId: 'client-new',
    });
    expect(res.status).toBe(200);
    expect(rows('SELECT name FROM sso_providers WHERE id = ?', [item.id])[0].name).toBe('重命名');
    // clientId 变更 → discovery 缓存失效（下次请求重新拉取）
    expect(await ctx.kv.get(`sso:disc:${item.id}`)).toBeNull();
  });

  it('删除来源级联删除身份关联；非管理员不可访问', async () => {
    const item = await createOidcProvider();
    ctx.db
      .prepare(
        `INSERT INTO sso_identities (id, provider_id, user_id, subject, created_at, updated_at)
         SELECT 'ident-1', ?, id, 'sub-1', ?, ? FROM users WHERE username = 'sso_admin'`
      )
      .run(item.id, Date.now(), Date.now());
    expect((await adminRequest(`/api/admin/sso/providers/${item.id}`, 'DELETE')).status).toBe(200);
    expect(rows('SELECT id FROM sso_identities').length).toBe(0);

    const user = await registerAndLogin(ctx, 'sso_plain');
    const res = await request(ctx, '/api/admin/sso/providers', { cookie: user.authCookie });
    expect(res.status).toBe(403);
  });
});

describe('公开面：总开关与来源列表', () => {
  it('默认关闭时公开面不暴露来源', async () => {
    await createOidcProvider();
    const body = await json<{ data: { sso: { enabled: boolean; providers: unknown[] } } }>(
      await request(ctx, '/api/public/settings')
    );
    expect(body.data.sso).toEqual({ enabled: false, providers: [] });
  });

  it('开启后只下发 id/kind/name（无凭据）', async () => {
    const item = await createOidcProvider('公司 SSO');
    setSetting('sso_enabled', 'true');
    const body = await json<{ data: { sso: { enabled: boolean; providers: Array<Record<string, unknown>> } } }>(
      await request(ctx, '/api/public/settings')
    );
    expect(body.data.sso.enabled).toBe(true);
    expect(body.data.sso.providers).toEqual([{ id: item.id, kind: 'oidc', name: '公司 SSO' }]);
  });
});

describe('站点总开关（注册设置分组）', () => {
  it('PATCH /api/admin/settings 往返 ssoEnabled，公开面随之开关，并写审计（记键不记值）', async () => {
    const res = await adminRequest('/api/admin/settings', 'PATCH', { ssoEnabled: true });
    expect(res.status).toBe(200);
    const saved = await json<{ data: { savedKeys: string[] } }>(res);
    expect(saved.data.savedKeys).toContain('sso_enabled');
    expect(readSetting('sso_enabled')).toBe('true');
    const get = await json<{ data: { ssoEnabled: boolean } }>(await request(ctx, '/api/admin/settings', { cookie: adminCookie }));
    expect(get.data.ssoEnabled).toBe(true);
    const logs = rows(`SELECT metadata FROM access_logs WHERE action = 'settings_update' ORDER BY created_at DESC LIMIT 1`);
    expect(String(logs[0]?.metadata)).toContain('sso_enabled');
  });
});

describe('OIDC 登录链路', () => {
  it('总开关关闭时 /start 与回调都回登录页错误码', async () => {
    const item = await createOidcProvider();
    const start = await request(ctx, `/api/auth/sso/${item.id}/start`);
    expect(start.status).toBe(302);
    expect(redirectTarget(start)).toBe('/login?sso_error=SSO_DISABLED');
    const cb = await callback(item.id, 'whatever');
    expect(redirectTarget(cb)).toBe('/login?sso_error=SSO_DISABLED');
  });

  it('/start 带 state / PKCE / nonce / 绑定 Cookie 跳转，code 换 token 时带上 code_verifier', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    const { state, location } = await startFlow(item.id);
    expect(location.origin + location.pathname).toBe(OIDC_AUTHORIZE);
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(`${REDIRECT}${item.id}/callback`);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')?.length).toBeGreaterThan(20);
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(state.length).toBeGreaterThan(20);
    expect(lastTxCookie).toBe(`sso_tx=${state}`);

    const cb = await callback(item.id, state);
    expect(cb.status).toBe(302);
    expect(idp.lastTokenForm?.get('code_verifier')).toBeTruthy();
    expect(idp.lastTokenForm?.get('client_secret')).toBe(CLIENT_SECRET);
    expect(idp.lastTokenForm?.get('grant_type')).toBe('authorization_code');
    // 绑定 Cookie 一次性：回调即清
    expect((cb.headers.get('set-cookie') ?? '').includes('sso_tx=;')).toBe(true);
  });

  it('scope 为空串的脏行回落到类型默认，不进空 scope 授权请求', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    ctx.db.exec(`UPDATE sso_providers SET scopes = '' WHERE id = '${item.id}'`);
    const { location } = await startFlow(item.id);
    expect(location.searchParams.get('scope')).toBe('openid email profile');
  });

  it('无既有身份 → 跳补充注册页，/pending 返回待填档案', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    idp.emailVerified = false;
    const { state } = await startFlow(item.id);
    const cb = await callback(item.id, state);
    expect(cb.status).toBe(302);
    expect(new URL(cb.headers.get('location') ?? '').pathname).toBe('/sso/complete');
    const token = pendingTokenFrom(cb);
    expect(lastPendingCookie).toBe(`sso_pending=${token}`);

    const body = await json<{ data: Record<string, unknown> }>(await fetchPending(token));
    expect(body.data.providerName).toBe('Lab OIDC');
    expect(body.data.kind).toBe('oidc');
    expect(body.data.email).toBe(idp.email);
    expect(body.data.emailVerified).toBe(false);
    expect(body.data.username).toBe('idp_user');
    expect(body.data.displayName).toBe('IdP User');
    // 站点未开启邮箱验证且无 SMTP：免验证码
    expect(body.data.emailVerificationRequired).toBe(false);
    // 令牌不入响应（凭据只在服务端 KV 与 DB）
    expect(JSON.stringify(body.data)).not.toContain('at-oidc');
  });

  it('补充注册：验证码 + 建号 + 身份与令牌落库（加密）+ 会话 Cookie', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    setSetting('require_email_verification', 'true');
    idp.emailVerified = false;
    idp.email = 'complete_me@idp.test';
    const { state } = await startFlow(item.id);
    const token = pendingTokenFrom(await callback(item.id, state));
    const pendingBody = await json<{ data: { emailVerificationRequired: boolean } }>(await fetchPending(token));
    expect(pendingBody.data.emailVerificationRequired).toBe(true);

    // 验证码错误 → 400，上下文保留可重试
    const bad = await complete(token, {
      username: 'sso_newbie',
      password: 'password123',
      email: 'complete_me@idp.test',
      emailCode: '000000',
    });
    expect(bad.status).toBe(400);
    expect(await errCode(bad)).toBe('INVALID_OTP');

    await ctx.kv.put('email:otp:register:complete_me@idp.test', '123456', { expirationTtl: 300 });
    const ok = await complete(token, {
      username: 'sso_newbie',
      password: 'password123',
      email: 'complete_me@idp.test',
      emailCode: '123456',
    });
    expect(ok.status).toBe(201);
    const cookie = authCookieOf(ok);
    expect(cookie).not.toBe('');
    const created = rows('SELECT id, email_verified, role FROM users WHERE username = ?', ['sso_newbie'])[0];
    expect(Number(created.email_verified)).toBe(1);

    const identity = rows('SELECT * FROM sso_identities WHERE user_id = ?', [String(created.id)])[0];
    expect(identity.subject).toBe(idp.subject);
    expect(identity.email).toBe('complete_me@idp.test');
    expect(identity.username).toBe('idp_user');
    expect(String(identity.access_token).startsWith('enc:')).toBe(true);
    expect(await decryptSecret(String(identity.access_token).slice(4), ctx.env.ENCRYPTION_KEY)).toBe('at-oidc');
    expect(await decryptSecret(String(identity.refresh_token).slice(4), ctx.env.ENCRYPTION_KEY)).toBe('rt-oidc');
    expect(Number(identity.expires_at)).toBeGreaterThan(Date.now());

    // 已登录：/me 可用，且 OTP 一次性消费
    const me = await request(ctx, '/api/auth/me', { cookie });
    expect(me.status).toBe(200);
    expect(await ctx.kv.get('email:otp:register:complete_me@idp.test')).toBeNull();

    // 令牌一次性：重复提交同一待办令牌被拒
    const replay = await complete(token, { username: 'sso_newbie2', password: 'password123', email: 'other@idp.test' });
    expect(replay.status).toBe(400);
    expect(await errCode(replay)).toBe('SSO_PENDING_INVALID');
  });

  it('提供方已验证邮箱且命中既有账号（受信来源）→ 自动关联并直接登录 + sso_link 审计', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    await registerAndLogin(ctx, 'sso_linked');
    ctx.db.exec(`UPDATE users SET email = '${idp.email}' WHERE username = 'sso_linked'`);
    const { state } = await startFlow(item.id);
    const cb = await callback(item.id, state);
    expect(cb.status).toBe(302);
    expect(redirectTarget(cb)).toBe('/files');
    const identity = rows('SELECT * FROM sso_identities').at(0)!;
    expect(identity.subject).toBe(idp.subject);
    expect(rows('SELECT id FROM users WHERE username = ?', ['sso_linked']).length).toBe(1);
    // 关联留痕（审计可按 action 过滤）
    expect(rows(`SELECT id FROM access_logs WHERE action = 'sso_link'`).length).toBe(1);
  });

  it('提供方邮箱未验证时不自动关联（落到补充注册页）', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    await registerAndLogin(ctx, 'sso_no_link');
    ctx.db.exec(`UPDATE users SET email = '${idp.email}' WHERE username = 'sso_no_link'`);
    idp.emailVerified = false;
    const { state } = await startFlow(item.id);
    const cb = await callback(item.id, state);
    expect(new URL(cb.headers.get('location') ?? '').pathname).toBe('/sso/complete');
    expect(rows('SELECT id FROM sso_identities').length).toBe(0);
  });

  it('既有身份再次登录：直接登录并刷新令牌，不新建账号', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    const first = await startFlow(item.id);
    const pending = pendingTokenFrom(await callback(item.id, first.state));
    const created = await complete(pending, { username: 'sso_returning', password: 'password123', email: idp.email! });
    expect(created.status).toBe(201);
    const usersBefore = rows('SELECT id FROM users').length;

    const second = await startFlow(item.id);
    const cb = await callback(item.id, second.state);
    expect(redirectTarget(cb)).toBe('/files');
    expect(authCookieOf(cb)).not.toBe('');
    expect(rows('SELECT id FROM users').length).toBe(usersBefore);
    expect(rows('SELECT id FROM sso_identities').length).toBe(1);
  });

  it('state 一次性：重放与来源不匹配都被拒', async () => {
    const a = await createOidcProvider('A');
    const b = await createOidcProvider('B');
    setSetting('sso_enabled', 'true');
    const { state } = await startFlow(a.id);
    expect((await callback(a.id, state)).status).toBe(302);
    const replay = await callback(a.id, state);
    expect(redirectTarget(replay)).toBe('/login?sso_error=SSO_STATE_INVALID');
    // 另一来源的 state 用在 A 上（Cookie 值与 state 匹配，走到 provider 校验）
    const flowA = await startFlow(a.id);
    const mismatch = await callback(b.id, flowA.state);
    expect(redirectTarget(mismatch)).toBe('/login?sso_error=SSO_STATE_INVALID');
  });

  it('id_token 验签失败（nonce 不符 / audience 不符）回错误码', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    const { state } = await startFlow(item.id);
    idp.nonceOverride = 'wrong-nonce';
    // 验签通过但 nonce 不匹配（重放防护），错误码区分于「签名/iss/aud 校验失败」
    expect(redirectTarget(await callback(item.id, state))).toBe('/login?sso_error=SSO_NONCE_MISMATCH');

    const second = await startFlow(item.id);
    idp.nonceOverride = null;
    idp.audienceOverride = 'other-client';
    expect(redirectTarget(await callback(item.id, second.state))).toBe('/login?sso_error=SSO_ID_TOKEN_INVALID');
  });

  it('注册开关关闭时不再进入补充注册', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    setSetting('allow_registration', 'false');
    const { state } = await startFlow(item.id);
    expect(redirectTarget(await callback(item.id, state))).toBe('/login?sso_error=REGISTRATION_DISABLED');
  });

  it('邀请码门控：必填缺码 400，带有效码注册并核销', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    setSetting('invite_enabled', 'true');
    setSetting('invite_required', 'true');
    ctx.db.exec(
      `INSERT INTO invite_codes (id, code, name, created_by, created_at) VALUES ('code-1', 'ABC123', 'test', (SELECT id FROM users WHERE username = 'sso_admin'), ${Date.now()})`
    );

    const { state } = await startFlow(item.id);
    const token = pendingTokenFrom(await callback(item.id, state));
    const missing = await complete(token, { username: 'sso_invited', password: 'password123', email: idp.email! });
    expect(await errCode(missing)).toBe('INVITE_CODE_REQUIRED');

    const ok = await complete(token, {
      username: 'sso_invited',
      password: 'password123',
      email: idp.email!,
      inviteCode: 'ABC123',
    });
    expect(ok.status).toBe(201);
    expect(rows('SELECT invited_by_code_id FROM users WHERE username = ?', ['sso_invited'])[0].invited_by_code_id).toBe('code-1');
  });

  it('提供方已验证邮箱 → 免验证码（即使站点开启邮箱验证）', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    setSetting('require_email_verification', 'true');
    const { state } = await startFlow(item.id);
    const token = pendingTokenFrom(await callback(item.id, state));
    const pending = await json<{ data: { emailVerificationRequired: boolean } }>(await fetchPending(token));
    expect(pending.data.emailVerificationRequired).toBe(false);
    const ok = await complete(token, { username: 'sso_noverify', password: 'password123', email: idp.email! });
    expect(ok.status).toBe(201);
    expect(Number(rows('SELECT email_verified FROM users WHERE username = ?', ['sso_noverify'])[0].email_verified)).toBe(1);
  });
});

describe('GitHub（OAuth2，无 id_token）', () => {
  it('/start 走内置授权端点，回调经 /user + /user/emails 取已验证邮箱', async () => {
    const res = await createProvider({ kind: 'github', name: 'GitHub', clientId: 'gh-client', clientSecret: 'gh-secret' });
    const item = (await json<{ data: { item: ProviderItem } }>(res)).data.item;
    setSetting('sso_enabled', 'true');
    const { state, location } = await startFlow(item.id);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('scope')).toBe('read:user user:email');
    // GitHub 无 id_token / PKCE / nonce
    expect(location.searchParams.get('nonce')).toBeNull();
    expect(location.searchParams.get('code_challenge')).toBeNull();

    await registerAndLogin(ctx, 'gh_linked');
    ctx.db.exec(`UPDATE users SET email = '${idp.github.emails[0].email}' WHERE username = 'gh_linked'`);
    const cb = await callback(item.id, state);
    expect(redirectTarget(cb)).toBe('/files');
    const identity = rows('SELECT * FROM sso_identities').at(0)!;
    expect(identity.subject).toBe(String(idp.github.id));
    expect(identity.username).toBe('gh_user');
    expect(identity.email).toBe(idp.github.emails[0].email);
  });
});

// ============ 安全面 ============
describe('安全回归：绑定 Cookie（登录 CSRF / 会话固定）', () => {
  it('回调缺少 sso_tx 绑定 Cookie → 拒绝（他人转发的回调链接不可用）', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    const { state } = await startFlow(item.id);
    const cb = await callback(item.id, state, 'auth-code-1', '');
    expect(cb.status).toBe(302);
    expect(redirectTarget(cb)).toBe('/login?sso_error=SSO_STATE_INVALID');
    // 未建立会话、未写身份关联
    expect(authCookieOf(cb)).toBe('');
    expect(rows('SELECT id FROM sso_identities').length).toBe(0);
    // 该 state 已被消费 → 即便随后补上正确 Cookie 也无效（一次性）
    const retry = await callback(item.id, state);
    expect(redirectTarget(retry)).toBe('/login?sso_error=SSO_STATE_INVALID');
  });

  it('回调携带伪造的绑定 Cookie → 拒绝', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    const { state } = await startFlow(item.id);
    const cb = await callback(item.id, state, 'auth-code-1', 'sso_tx=forged-value');
    expect(redirectTarget(cb)).toBe('/login?sso_error=SSO_STATE_INVALID');
  });

  it('绑定 Cookie 在 /pending 与失败的 /complete 之后仍可用（只在成功后失效）', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    const { state } = await startFlow(item.id);
    const token = pendingTokenFrom(await callback(item.id, state));

    // 读一次 /pending 后 Cookie 必须还在（否则真正建号的那次提交必然被拒）
    expect((await fetchPending(token)).status).toBe(200);
    expect(lastPendingCookie).toBe(`sso_pending=${token}`);

    // 一次校验失败（验证码错误）后 Cookie 仍可用 → 用户能重试
    setSetting('require_email_verification', 'true');
    const bad = await complete(token, {
      username: 'retry_user',
      password: 'password123',
      email: 'retry@idp.test',
      emailCode: '000000',
    });
    expect(await errCode(bad)).toBe('INVALID_OTP');
    expect(lastPendingCookie).toBe(`sso_pending=${token}`);

    // 成功后上下文一次性失效（令牌重放被拒；Cookie 清理由响应完成，harness 只断言功能后果）
    await ctx.kv.put('email:otp:register:retry@idp.test', '111111', { expirationTtl: 300 });
    const ok = await complete(token, {
      username: 'retry_user',
      password: 'password123',
      email: 'retry@idp.test',
      emailCode: '111111',
    });
    expect(ok.status).toBe(201);
    expect(await errCode(await complete(token, { username: 'retry_user2', password: 'password123', email: 'other@idp.test' }))).toBe(
      'SSO_PENDING_INVALID'
    );
  });

  it('/pending 与 /complete 缺少 sso_pending 绑定 Cookie → 拒绝（链接转发无法完成注册）', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    const { state } = await startFlow(item.id);
    const token = pendingTokenFrom(await callback(item.id, state));

    expect(await errCode(await fetchPending(token, ''))).toBe('SSO_PENDING_INVALID');
    expect(await errCode(await fetchPending(token, 'sso_pending=forged'))).toBe('SSO_PENDING_INVALID');
    const res = await complete(
      token,
      { username: 'csrf_victim', password: 'password123', email: 'csrf@victim.test' },
      ''
    );
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('SSO_PENDING_INVALID');
    expect(rows(`SELECT id FROM users WHERE username = 'csrf_victim'`).length).toBe(0);

    // 带上正确 Cookie 仍可正常完成：负向探测按设计会清掉浏览器侧 Cookie，这里模拟「同一浏览器重新拿到该值」
    lastPendingCookie = `sso_pending=${token}`;
    const ok = await complete(token, { username: 'csrf_victim', password: 'password123', email: 'csrf@victim.test' });
    expect(ok.status).toBe(201);
  });
});

describe('安全回归：邮箱验证码以提交邮箱为准', () => {
  it('提供方验证过 A 邮箱，用户提交 B 邮箱仍必须过验证码', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    setSetting('require_email_verification', 'true');
    idp.email = 'provider-verified@idp.test';
    idp.emailVerified = true;
    const { state } = await startFlow(item.id);
    const token = pendingTokenFrom(await callback(item.id, state));

    // 提交另一个未被验证的邮箱 → 必须带验证码（否则等于绕过站点邮箱验证、可抢占任意地址）
    const noCode = await complete(token, { username: 'squatter', password: 'password123', email: 'victim@example.com' });
    expect(noCode.status).toBe(400);
    expect(await errCode(noCode)).toBe('INVALID_OTP');
    expect(rows(`SELECT id FROM users WHERE username = 'squatter'`).length).toBe(0);

    // 别人邮箱也没法用「提供方已验证」蒙混：只有同邮箱才免码
    const sameEmail = await complete(token, { username: 'squatter', password: 'password123', email: idp.email! });
    expect(sameEmail.status).toBe(201);
    expect(Number(rows(`SELECT email_verified FROM users WHERE username = 'squatter'`)[0].email_verified)).toBe(1);
  });
});

describe('安全回归：信任开关与大小写无关邮箱', () => {
  it('自定义 OIDC 默认不信任邮箱验证 → 命中既有账号也不自动关联，改为 409 提示', async () => {
    const item = await createOidcProvider('Untrusted OIDC', { trustEmailVerified: false });
    setSetting('sso_enabled', 'true');
    await registerAndLogin(ctx, 'existing_user');
    ctx.db.exec(`UPDATE users SET email = '${idp.email}' WHERE username = 'existing_user'`);

    const { state } = await startFlow(item.id);
    const cb = await callback(item.id, state);
    // 不自动关联：落到补充注册页
    expect(new URL(cb.headers.get('location') ?? '').pathname).toBe('/sso/complete');
    expect(rows('SELECT id FROM sso_identities').length).toBe(0);

    const token = pendingTokenFrom(cb);
    const res = await complete(token, { username: 'attacker_row', password: 'password123', email: idp.email! });
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe('ALREADY_EXISTS');
    expect(rows(`SELECT id FROM users WHERE username = 'attacker_row'`).length).toBe(0);
  });

  it('开启信任开关后才自动关联（管理员显式启用）', async () => {
    const item = await createOidcProvider('Trusted OIDC', { trustEmailVerified: false });
    await adminRequest(`/api/admin/sso/providers/${item.id}`, 'PATCH', { trustEmailVerified: true });
    setSetting('sso_enabled', 'true');
    await registerAndLogin(ctx, 'existing_trusted');
    ctx.db.exec(`UPDATE users SET email = '${idp.email}' WHERE username = 'existing_trusted'`);

    const { state } = await startFlow(item.id);
    const cb = await callback(item.id, state);
    expect(redirectTarget(cb)).toBe('/files');
    expect(rows('SELECT id FROM sso_identities').length).toBe(1);
  });

  it('邮箱大小写无关：既有账号 Mixed@Case.test 也能被 mixed@case.test 自动关联', async () => {
    const item = await createOidcProvider('Trusted', { trustEmailVerified: true });
    setSetting('sso_enabled', 'true');
    await registerAndLogin(ctx, 'mixed_case');
    ctx.db.exec(`UPDATE users SET email = 'Mixed@Case.test' WHERE username = 'mixed_case'`);
    idp.email = 'mixed@case.test';
    idp.emailVerified = true;

    const { state } = await startFlow(item.id);
    const cb = await callback(item.id, state);
    expect(redirectTarget(cb)).toBe('/files');
    expect(rows('SELECT id FROM sso_identities').length).toBe(1);
    expect(rows('SELECT id FROM users WHERE username = ?', ['mixed_case']).length).toBe(1);
  });

  it('补充注册拒绝大小写变体的既有邮箱（同一邮箱不得建出两个账号）', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    await registerAndLogin(ctx, 'case_owner');
    ctx.db.exec(`UPDATE users SET email = 'Owner@Example.test' WHERE username = 'case_owner'`);

    const { state } = await startFlow(item.id);
    const token = pendingTokenFrom(await callback(item.id, state));
    const res = await complete(token, { username: 'case_dup', password: 'password123', email: 'owner@example.test' });
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe('ALREADY_EXISTS');
  });
});

describe('安全回归：上游请求与停用来源', () => {
  it('上游端点返回 3xx 重定向时拒绝（不跟随到内网/云元数据）', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    idp.redirectFrom = OIDC_DISCOVERY;
    const res = await request(ctx, `/api/auth/sso/${item.id}/start`);
    expect(redirectTarget(res)).toBe('/login?sso_error=SSO_UPSTREAM_REDIRECT');
    idp.redirectFrom = null;
  });

  it('discovery 文档缺少 issuer / 端点指向内网 → 拒绝', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    idp.discoveryOverride = { authorization_endpoint: OIDC_AUTHORIZE, token_endpoint: OIDC_TOKEN, jwks_uri: OIDC_JWKS };
    expect(redirectTarget(await request(ctx, `/api/auth/sso/${item.id}/start`))).toBe('/login?sso_error=SSO_DISCOVERY_INVALID');

    idp.discoveryOverride = {
      issuer: ISSUER,
      authorization_endpoint: OIDC_AUTHORIZE,
      token_endpoint: 'http://169.254.169.254/token',
      jwks_uri: OIDC_JWKS,
    };
    expect(redirectTarget(await request(ctx, `/api/auth/sso/${item.id}/start`))).toBe('/login?sso_error=SSO_DISCOVERY_INVALID');
    idp.discoveryOverride = null;
  });

  it('来源被停用后再提交补充注册 → 拒绝（在途令牌不豁免）', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    const { state } = await startFlow(item.id);
    const token = pendingTokenFrom(await callback(item.id, state));
    await adminRequest(`/api/admin/sso/providers/${item.id}`, 'PATCH', { enabled: false });

    expect(await errCode(await fetchPending(token))).toBe('SSO_PROVIDER_NOT_FOUND');
    const res = await complete(token, { username: 'late_user', password: 'password123', email: 'late@idp.test' });
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('SSO_PROVIDER_NOT_FOUND');
    expect(rows(`SELECT id FROM users WHERE username = 'late_user'`).length).toBe(0);
  });

  it('待办上下文里的提供方令牌是密文（KV 不落明文凭据）', async () => {
    const item = await createOidcProvider();
    setSetting('sso_enabled', 'true');
    const { state } = await startFlow(item.id);
    const token = pendingTokenFrom(await callback(item.id, state));
    const raw = await ctx.kv.get(`sso:pending:${token}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('at-oidc');
    expect(raw).not.toContain('rt-oidc');
    expect(String(raw)).toContain('enc:');
  });
});
