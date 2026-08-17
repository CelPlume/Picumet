// 管理员路由：存储提供商、挂载点、权限规则
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { z } from 'zod';
import { ProviderRepo, MountRepo, RuleRepo } from '../db';
import { getDb } from '../middleware/auth';
import { getProvider } from '../providers';
import { ok } from '../utils/response';
import { ApiError } from '../utils/errors';
import { encryptSecret, hashPassword } from '../utils/crypto';
import { normalizePath } from '../utils/path';
import type { Env } from '../types';
import { isPrivateHost } from '../utils/ssrf';

const providerSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['r2', 's3', 'oracle']),
  endpoint: z.string().max(500).optional(),
  region: z.string().max(100).optional(),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().max(500).optional(),
  secretAccessKey: z.string().max(500).optional(),
  publicDomain: z.string().max(500).nullable().optional(),
  uploadDomain: z.string().max(500).nullable().optional(),
  pathPrefix: z.string().max(500).optional(),
});

const mountSchema = z.object({
  providerId: z.string().min(1),
  mountPath: z.string().min(1),
  name: z.string().min(1).max(100),
  sortBy: z.enum(['name', 'time', 'size', 'manual']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  priority: z.number().int().optional(),
});

const ruleSchema = z.object({
  pathPattern: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
  role: z.enum(['admin', 'user', 'guest']).nullable().optional(),
  userId: z.string().nullable().optional(),
  apiKeyId: z.string().nullable().optional(),
  permissions: z.array(z.enum(['read', 'write', 'update', 'delete', 'share', 'download'])).min(1),
  requirePassword: z.boolean().optional(),
  password: z.string().min(1).max(128).optional(),
  allowedIps: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
});

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
      uploadDomain: p.uploadDomain,
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
  const parsed = providerSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '存储配置无效');

  const { name, type, endpoint, region, bucket, accessKeyId, secretAccessKey, publicDomain, uploadDomain, pathPrefix } = parsed.data;

  // R2 绑定模式：endpoint 为空表示使用本地/生产 R2 绑定
  const isBindingR2 = type === 'r2' && !endpoint;
  if (!isBindingR2 && endpoint) {
    try {
      if (!/^https?:\/\//.test(endpoint)) throw new Error('endpoint 需以 http(s):// 开头');
      const host = new URL(endpoint).hostname;
      if (isPrivateHost(host)) throw new Error('不允许使用内网/本地地址');
    } catch (err) {
      throw ApiError.badRequest(`存储端点无效：${err instanceof Error ? err.message : '格式错误'}`);
    }
  }

  const provider = await ProviderRepo.createProvider(db, {
    name,
    type,
    endpoint: isBindingR2 ? '__binding__' : (endpoint ?? ''),
    region: region ?? (type === 'r2' ? 'auto' : ''),
    bucket,
    accessKeyId: isBindingR2 ? '__binding__' : accessKeyId ?? '',
    secretAccessKey: isBindingR2 ? '__binding__' : secretAccessKey ?? '',
    publicDomain: publicDomain ?? undefined,
    uploadDomain: uploadDomain ?? undefined,
    pathPrefix: pathPrefix ?? '',
  });

  return ok(c, { provider: { id: provider.id } }, undefined, 201);
});

adminStorageRoutes.put('/storage/providers/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = providerSchema.partial().safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('存储配置无效');
  const fields: Record<string, unknown> = {};
  const map: Record<string, string> = {
    name: 'name',
    type: 'type',
    endpoint: 'endpoint',
    region: 'region',
    bucket: 'bucket',
    publicDomain: 'public_domain',
    uploadDomain: 'upload_domain',
    pathPrefix: 'path_prefix',
  };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    fields[map[k] ?? k] = v;
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
  const parsed = mountSchema.safeParse(body);
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
  const parsed = mountSchema.partial().safeParse(body ?? {});
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
  const rules = await RuleRepo.listRules(db);
  return ok(c, { rules: rules.map((r) => ({ ...r, passwordHash: r.passwordHash ? '***' : undefined })) });
});

adminStorageRoutes.post('/rules', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = ruleSchema.safeParse(body);
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
  const parsed = ruleSchema.partial().safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('规则参数无效');
  const fields: Record<string, unknown> = {};
  if (parsed.data.pathPattern !== undefined) fields.path_pattern = normalizePath(parsed.data.pathPattern);
  if (parsed.data.effect !== undefined) fields.effect = parsed.data.effect;
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
