// 管理端第三方登录来源（SSO / OIDC）配置
// 路由挂载见 workers/src/index.ts（/api/admin/sso/providers*，继承 adminApi 的认证 + CSRF + 限流）。
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings } from '../../shared/types';
import type { SsoProviderAdmin, SsoProviderKind } from '@shared/types';
import { ApiError } from '../../shared/errors';
import { ok } from '../../shared/response';
import { getDb } from '../../middleware/auth';
import { LogRepo, SsoProviderRepo, type Db, type SsoProviderRow } from '../../db';
import { SsoProviderCreateSchema, SsoProviderUpdateSchema } from '../sso/schemas';
import { allowLoopbackIssuer, resolveRedirectUri, sealCredential, validateSsoIssuerUrl } from '../sso/config';
import { clearDiscoveryCache } from '../sso/oidc';

export const adminSsoRoutes = new Hono<AppBindings>();

/** clientSecret 只回掩码；`******` / 空串在更新时表示保持原值（与 SMTP 密码同约定） */
const SECRET_MASK = '******';

function toAdminView(c: Context<AppBindings>, p: SsoProviderRow): SsoProviderAdmin {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    issuerUrl: p.issuerUrl,
    clientId: p.clientId,
    clientSecret: p.clientSecret ? SECRET_MASK : '',
    scopes: p.scopes,
    enabled: p.enabled,
    trustEmailVerified: p.trustEmailVerified,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    redirectUri: resolveRedirectUri(c.env, p.id),
  };
}

/** 配置面审计（记键不记值：secret 永不入日志） */
async function auditConfig(c: Context<AppBindings>, action: string, metadata: Record<string, unknown>): Promise<void> {
  await LogRepo.create(getDb(c), {
    userId: c.get('userId') as string,
    action,
    path: '/api/admin/sso/providers',
    metadata: JSON.stringify(metadata),
  });
}

/**
 * issuer 校验：kind='oidc' 必填且需过地址白名单（Worker 会主动请求该地址，属真实 SSRF 面）；
 * 内置来源（google/github）端点固定，不接受 issuer。
 */
function resolveIssuerInput(kind: SsoProviderKind, issuerUrl: string | null | undefined, allowLoopback: boolean): string | null {
  if (kind !== 'oidc') {
    if (issuerUrl) throw ApiError.badRequest('Google / GitHub 使用内置端点，无需填写地址');
    return null;
  }
  const issuer = issuerUrl?.trim() ?? '';
  if (!issuer) throw ApiError.badRequest('自定义 OIDC 来源必须填写 issuer 地址');
  if (!validateSsoIssuerUrl(issuer, { allowLoopback })) {
    throw ApiError.badRequest(
      'issuer 地址无效：需为公网 http(s) 地址（80/443 端口、无内嵌凭据与查询串）；本地开发可使用 http://localhost'
    );
  }
  return issuer;
}

/** 单例约束：google / github 各至多一条（DB 侧另有部分唯一索引兜底） */
async function assertSingletonAvailable(db: Db, kind: SsoProviderKind, excludeId?: string): Promise<void> {
  if (kind === 'oidc') return;
  const dup = await SsoProviderRepo.findSingletonKind(db, kind, excludeId);
  if (dup) {
    throw new ApiError(409, 'SSO_PROVIDER_EXISTS', `${kind === 'google' ? 'Google' : 'GitHub'} 来源只能添加一个`);
  }
}

adminSsoRoutes.get('/sso/providers', async (c) => {
  const db = getDb(c);
  const rows = await SsoProviderRepo.list(db);
  return ok(c, { items: rows.map((p) => toAdminView(c, p)) });
});

adminSsoRoutes.post('/sso/providers', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = SsoProviderCreateSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '来源配置无效');
  const { kind, name, clientId, clientSecret, scopes, enabled, trustEmailVerified } = parsed.data;
  const issuerUrl = resolveIssuerInput(kind, parsed.data.issuerUrl, allowLoopbackIssuer(c.env));
  await assertSingletonAvailable(db, kind);
  const sealed = await sealCredential(clientSecret, c.env.ENCRYPTION_KEY);
  if (!sealed) throw ApiError.internal('凭据加密失败');
  const id = await SsoProviderRepo.create(db, {
    kind,
    name,
    issuerUrl,
    clientId,
    clientSecret: sealed,
    // 空串/纯空白 = 未设置（与更新路径同口径；避免空 scope 进授权请求）
    scopes: scopes?.trim() || null,
    enabled: enabled ?? true,
    // 默认值随类型：内置 google/github 的邮箱验证由提供方保证；自定义 oidc 需管理员显式开启
    trustEmailVerified: trustEmailVerified ?? kind !== 'oidc',
  });
  await auditConfig(c, 'sso_provider_create', { kind, name });
  const created = await SsoProviderRepo.getById(db, id);
  return ok(c, { item: created ? toAdminView(c, created) : null, message: '已创建' }, '已创建', 201);
});

adminSsoRoutes.patch('/sso/providers/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const existing = await SsoProviderRepo.getById(db, id);
  if (!existing) throw ApiError.notFound('该来源不存在');
  const body = await c.req.json().catch(() => null);
  const parsed = SsoProviderUpdateSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '来源配置无效');
  const { name, clientId, clientSecret, scopes, enabled, trustEmailVerified } = parsed.data;

  const fields: Parameters<typeof SsoProviderRepo.update>[2] = {};
  if (name !== undefined) fields.name = name;
  if (clientId !== undefined) fields.clientId = clientId;
  // 空串/纯空白 = 清空 scope（与创建路径同口径）
  if (scopes !== undefined) fields.scopes = scopes?.trim() || null;
  if (enabled !== undefined) fields.enabled = enabled;
  if (trustEmailVerified !== undefined) fields.trustEmailVerified = trustEmailVerified;
  if (parsed.data.issuerUrl !== undefined) {
    fields.issuerUrl = resolveIssuerInput(existing.kind, parsed.data.issuerUrl, allowLoopbackIssuer(c.env));
  }
  if (clientSecret !== undefined && clientSecret !== '' && clientSecret !== SECRET_MASK) {
    const sealed = await sealCredential(clientSecret, c.env.ENCRYPTION_KEY);
    if (!sealed) throw ApiError.internal('凭据加密失败');
    fields.clientSecret = sealed;
  }
  if (existing.kind !== 'oidc' && fields.issuerUrl) {
    throw ApiError.badRequest('Google / GitHub 使用内置端点，无法修改地址');
  }
  await SsoProviderRepo.update(db, id, fields);
  // issuer / clientId 变更后，缓存的 discovery 文档失效
  if (fields.issuerUrl !== undefined || fields.clientId !== undefined) await clearDiscoveryCache(c.env, id);
  await auditConfig(c, 'sso_provider_update', { kind: existing.kind, name: fields.name ?? existing.name, keys: Object.keys(fields) });
  const updated = await SsoProviderRepo.getById(db, id);
  return ok(c, { item: updated ? toAdminView(c, updated) : null, message: '已保存' });
});

adminSsoRoutes.delete('/sso/providers/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const existing = await SsoProviderRepo.getById(db, id);
  if (!existing) throw ApiError.notFound('该来源不存在');
  // 身份关联行随外键级联删除：重新添加同一来源后需重新完成一次登录
  await SsoProviderRepo.remove(db, id);
  await clearDiscoveryCache(c.env, id);
  await auditConfig(c, 'sso_provider_delete', { kind: existing.kind, name: existing.name });
  return ok(c, { message: '已删除' });
});
