// 管理员路由：存储提供商、挂载点、权限规则
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { ProviderRepo, MountRepo, RuleRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { encryptSecret, hashPassword, uuid } from '../../utils/crypto';
import { normalizePath } from '../../utils/path';
import type { Env } from '../../shared/types';
import { validateEndpoint } from '../../utils/ssrf';
import { ProviderSchema, ProviderSchemaBase, MountSchema, RuleSchema } from './storage-schemas';

export const adminStorageRoutes = new Hono<AppBindings>();

// ============ 存储提供商 ============
adminStorageRoutes.get('/storage/providers', async (c) => {
  const db = getDb(c);
  const providers = await ProviderRepo.listProviders(db);
  return ok(c, {
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      endpoint: p.endpoint,
      region: p.region,
      bucket: p.bucket,
      publicDomain: p.publicDomain,
      pathPrefix: p.pathPrefix,
      status: p.status,
      createdAt: p.createdAt,
      hasCredentials: p.accessKeyId !== '' && p.accessKeyId !== '__binding__',
    })),
  });
});

adminStorageRoutes.post('/storage/providers', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = ProviderSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '存储配置无效');

  const { name, endpoint, region, bucket, accessKeyId, secretAccessKey, publicDomain, pathPrefix, mountPath } = parsed.data;

  // §5.2：type 由「有无 endpoint」推导，不再是用户选择项
  const isBinding = !endpoint;
  // M-1：统一 SSRF 校验（scheme/端口/userinfo + IPv4/IPv6 私网保留段）
  if (!isBinding && !validateEndpoint(endpoint)) {
    throw ApiError.badRequest('存储端点无效：必须为公网 http(s) 地址，且不允许私网/保留地址');
  }

  // 可选一步创建挂载点：同事务 provider + mount（§2.5 交互合并，90% 场景 1:1）
  let normalizedMountPath: string | null = null;
  if (mountPath) {
    normalizedMountPath = normalizePath(mountPath);
    const existing = await MountRepo.listMounts(db);
    if (existing.some((m) => m.mountPath === normalizedMountPath)) {
      throw new ApiError(409, 'ALREADY_EXISTS', '挂载路径已存在');
    }
  }

  const now = Date.now();
  const providerId = uuid();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO storage_providers (id, name, type, endpoint, region, bucket, access_key_id, secret_access_key, public_domain, path_prefix, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        providerId,
        name,
        isBinding ? 'r2' : 's3',
        isBinding ? '' : endpoint,
        region || 'auto',
        bucket,
        isBinding ? '' : accessKeyId ?? '',
        isBinding ? '' : secretAccessKey ?? '',
        publicDomain ?? null,
        pathPrefix ?? '',
        now,
        now,
      ]
    );
    if (normalizedMountPath) {
      await tx.query(
        `INSERT INTO mounts (id, provider_id, mount_path, name, sort_by, sort_order, priority, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, 'name', 'asc', 0, ?, ?, 'active')`,
        [uuid(), providerId, normalizedMountPath, name, now, now]
      );
    }
  });

  return ok(c, { provider: { id: providerId }, mountPath: normalizedMountPath }, undefined, 201);
});

adminStorageRoutes.put('/storage/providers/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = ProviderSchemaBase.partial().safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('存储配置无效');
  const fields: Record<string, unknown> = {};
  const map: Record<string, string> = {
    name: 'name',
    endpoint: 'endpoint',
    region: 'region',
    bucket: 'bucket',
    publicDomain: 'public_domain',
    pathPrefix: 'path_prefix',
  };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    fields[map[k] ?? k] = v;
  }
  // endpoint 驱动 type：置空 = 切回绑定（清凭据）；填写 = S3 协议
  if (parsed.data.endpoint !== undefined) {
    if (parsed.data.endpoint === '') {
      fields.type = 'r2';
      fields.access_key_id = '';
      fields.secret_access_key = '';
    } else {
      fields.type = 's3';
    }
  }
  if (parsed.data.accessKeyId) fields.access_key_id = await encryptSecret(parsed.data.accessKeyId, c.env.ENCRYPTION_KEY as string);
  if (parsed.data.secretAccessKey) fields.secret_access_key = await encryptSecret(parsed.data.secretAccessKey, c.env.ENCRYPTION_KEY as string);
  await ProviderRepo.updateProvider(db, id, fields);
  return ok(c, { message: '已更新' });
});

adminStorageRoutes.post('/storage/providers/:id/test', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const provider = await ProviderRepo.getProviderById(db, id);
  if (!provider) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  const instance = await getProvider(db, provider, c.env as Env);
  const result = await instance.testConnection();
  return ok(c, result);
});

adminStorageRoutes.delete('/storage/providers/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const mounts = await MountRepo.allMounts(db);
  if (mounts.some((m) => m.providerId === id)) {
    throw new ApiError(409, 'OPERATION_FAILED', '该存储提供商仍有挂载点，请先删除挂载点');
  }
  await ProviderRepo.deleteProvider(db, id);
  return ok(c, null);
});

// ============ 挂载点 ============
adminStorageRoutes.get('/mounts', async (c) => {
  const db = getDb(c);
  const mounts = await MountRepo.allMounts(db);
  const providers = await ProviderRepo.listProviders(db);
  const pInfo: Record<string, { name: string; type: string }> = {};
  for (const p of providers) pInfo[p.id] = { name: p.name, type: p.type };
  return ok(c, {
    mounts: mounts.map((m) => ({
      id: m.id,
      mountPath: m.mountPath,
      name: m.name,
      providerId: m.providerId,
      providerName: pInfo[m.providerId]?.name ?? '未知',
      providerType: pInfo[m.providerId]?.type ?? 'r2',
      sortBy: m.sortBy,
      sortOrder: m.sortOrder,
      priority: m.priority,
      status: m.status,
    })),
  });
});

adminStorageRoutes.post('/mounts', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = MountSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('挂载点参数无效');
  const mountPath = normalizePath(parsed.data.mountPath);
  const provider = await ProviderRepo.getProviderById(db, parsed.data.providerId);
  if (!provider) throw ApiError.badRequest('存储提供商不存在');
  const mount = await MountRepo.createMount(db, {
    providerId: parsed.data.providerId,
    mountPath,
    name: parsed.data.name,
    sortBy: parsed.data.sortBy,
    sortOrder: parsed.data.sortOrder,
    priority: parsed.data.priority,
  });
  return ok(c, { mount }, undefined, 201);
});

adminStorageRoutes.put('/mounts/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = MountSchema.partial().safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('挂载点参数无效');
  const fields: Record<string, unknown> = {};
  if (parsed.data.mountPath !== undefined) fields.mount_path = normalizePath(parsed.data.mountPath);
  if (parsed.data.name !== undefined) fields.name = parsed.data.name;
  if (parsed.data.sortBy !== undefined) fields.sort_by = parsed.data.sortBy;
  if (parsed.data.sortOrder !== undefined) fields.sort_order = parsed.data.sortOrder;
  if (parsed.data.priority !== undefined) fields.priority = parsed.data.priority;
  if (parsed.data.providerId !== undefined) fields.provider_id = parsed.data.providerId;
  await MountRepo.updateMount(db, id, fields);
  return ok(c, { message: '已更新' });
});

adminStorageRoutes.delete('/mounts/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const countRow = await db.first(`SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ?`, [id]);
  if (Number(countRow?.c ?? 0) > 0) {
    throw new ApiError(409, 'OPERATION_FAILED', '挂载点下仍有文件，无法删除');
  }
  await MountRepo.deleteMount(db, id);
  return ok(c, null);
});

// ============ 权限规则 ============
adminStorageRoutes.get('/rules', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
  const { rows, total } = await RuleRepo.listRules(db, { page, limit });
  return ok(c, {
    rules: rows.map((r) => ({ ...r, passwordHash: r.passwordHash ? '***' : undefined })),
    pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

adminStorageRoutes.post('/rules', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = RuleSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '规则参数无效');
  const pattern = normalizePath(parsed.data.pathPattern);
  if (!pattern || pattern === '/') {
    // 根路径规则允许，但必须谨慎
  }
  // 校验规则主体唯一性
  const subjectCount = [parsed.data.role, parsed.data.userId, parsed.data.apiKeyId].filter(Boolean).length;
  if (subjectCount !== 1) {
    throw ApiError.badRequest('规则必须且只能指定 role、userId、apiKeyId 中的一个');
  }
  const { password, ...rest } = parsed.data;
  const rule = await RuleRepo.createRule(db, {
    ...rest,
    mountId: rest.mountId ?? undefined,
    role: rest.role ?? undefined,
    userId: rest.userId ?? undefined,
    apiKeyId: rest.apiKeyId ?? undefined,
    pathPattern: pattern,
    requirePassword: parsed.data.requirePassword,
    passwordHash: password ? hashPassword(password) : undefined,
  });
  return ok(c, { rule }, undefined, 201);
});

adminStorageRoutes.put('/rules/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = RuleSchema.partial().safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('规则参数无效');
  const fields: Record<string, unknown> = {};
  if (parsed.data.pathPattern !== undefined) fields.path_pattern = normalizePath(parsed.data.pathPattern);
  if (parsed.data.effect !== undefined) fields.effect = parsed.data.effect;
  if (parsed.data.mountId !== undefined) fields.mount_id = parsed.data.mountId;
  if (parsed.data.role !== undefined) fields.role = parsed.data.role;
  if (parsed.data.userId !== undefined) fields.user_id = parsed.data.userId;
  if (parsed.data.apiKeyId !== undefined) fields.api_key_id = parsed.data.apiKeyId;
  if (parsed.data.permissions !== undefined) fields.permissions = JSON.stringify(parsed.data.permissions);
  if (parsed.data.requirePassword !== undefined) fields.require_password = parsed.data.requirePassword ? 1 : 0;
  if (parsed.data.allowedIps !== undefined) fields.allowed_ips = parsed.data.allowedIps.join(',');
  if (parsed.data.priority !== undefined) fields.priority = parsed.data.priority;
  if (parsed.data.password) {
    fields.password_hash = hashPassword(parsed.data.password);
  }
  await RuleRepo.updateRule(db, id, fields);
  return ok(c, { message: '已更新' });
});

adminStorageRoutes.delete('/rules/:id', async (c) => {
  const db = getDb(c);
  await RuleRepo.deleteRule(db, c.req.param('id'));
  return ok(c, null);
});
