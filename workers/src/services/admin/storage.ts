// 管理员路由：存储提供商、挂载点、权限规则
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { ProviderRepo, MountRepo, MountProviderRepo, MountRolePermissionsRepo, MountProviderRolePermissionsRepo, RuleRepo, writableMembers, firstWritableMember } from '../../db';
import type { Db, MountProviderMemberInput } from '../../db';
import { getDb } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { encryptSecret, hashPassword, uuid } from '../../utils/crypto';
import { normalizePath } from '../../utils/path';
import type { Env } from '../../shared/types';
import { validateEndpoint } from '../../utils/ssrf';
import { ensureAllMountFolders, ensureMountFolder, removeMountFolder } from '../storage/mount-folders';
import { ProviderSchema, ProviderSchemaBase, MountSchema, RuleSchema } from './storage-schemas';

export const adminStorageRoutes = new Hono<AppBindings>();

/** 管理端池成员入参：§E/§30 成员字段（weight/capacityBytes/sortOrder/standby）+ §31 该桶桶级矩阵（全量替换） */
type PoolMemberInput = MountProviderMemberInput & {
  rolePermissions?: Array<{ role: string; permissions: string[] }>;
};

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

/** §E 存储池：校验成员 provider 存在后整体替换（§32：池 = 入参成员集，主存储锚点随后派生） */
async function setPoolMembersValidated(
  db: Db,
  mountId: string,
  primaryProviderId: string,
  members: PoolMemberInput[]
): Promise<void> {
  for (const member of members) {
    const provider = await ProviderRepo.getProviderById(db, member.providerId);
    if (!provider) throw ApiError.badRequest(`存储提供商不存在：${member.providerId}`);
  }
  await MountProviderRepo.setMembers(db, mountId, primaryProviderId, members);
  // §31 桶级默认角色权限矩阵：按 (挂载点, 桶) 全量替换——缺省 = 不改，[] = 清空该桶矩阵
  for (const member of members) {
    if (member.rolePermissions !== undefined) {
      await MountProviderRolePermissionsRepo.setForMount(db, mountId, member.providerId, member.rolePermissions);
    }
  }
}

/**
 * §32 主存储锚点维护：`mounts.provider_id` 已降级为**内部锚点**，不再由用户选择，只承载三件事：
 * ① 池成员为空（清空成员 / 池化前的存量挂载）时的写路径兜底（单桶语义）；
 * ② `file_metadata.provider_id IS NULL` 存量行的读回退与用量归属（含 §30 成员容量聚合）；
 * ③ 删除提供商时的级联判定。
 *
 * 池成员全量替换后按池内次序重新派生：**第一个非备用成员**（sort_order 升序、同序 provider_id 升序，
 * 与 ordered 策略一致）——锚点被移出池、被标为备用、或成员集合重排都会随之更新。
 * 请求里显式给的可写成员优先保留（兼容既有管理端调用方）；池内没有成员时不改动（单桶语义的锚点即唯一成员）。
 */
async function syncPrimaryAnchor(db: Db, mountId: string, requestedProviderId: string | null): Promise<void> {
  const members = await MountProviderRepo.listMembers(db, mountId);
  const writable = writableMembers(members);
  const first = firstWritableMember(members);
  // 池内没有可写成员：无成员行 = 单桶语义（显式请求即锚点，否则不动）；成员全为备用 = 坏配置（不动，写路径拒写）
  const anchor =
    first !== null
      ? (writable.find((m) => m.providerId === requestedProviderId)?.providerId ?? first.providerId)
      : members.length === 0
        ? requestedProviderId
        : null;
  if (!anchor) return;
  const mount = await MountRepo.getMountById(db, mountId);
  if (mount && mount.providerId !== anchor) await MountRepo.updateMount(db, mountId, { provider_id: anchor });
}

/** 池成员入参归一化：poolMembers 优先；poolProviderIds 为等价简写（weight=1、不限容量、sortOrder=0） */
function normalizePoolMembers(input: {
  poolMembers?: PoolMemberInput[];
  poolProviderIds?: string[];
}): PoolMemberInput[] {
  if (input.poolMembers !== undefined) return input.poolMembers;
  return (input.poolProviderIds ?? []).map((providerId) => ({ providerId }));
}

/**
 * §31 容量两层一致性：挂载点总上限不得超过各桶上限之和（未设上限的桶不参与求和）。
 * 两者都未设（总上限 null / 没有任何桶设上限）→ 无约束。桶上限是放置硬上限（§30），
 * 总上限是挂载点写入配额，此处只约束两者的**配置关系**，判定仍各自独立。
 */
function assertTotalWithinBuckets(
  maxStorage: number | null | undefined,
  poolMembers: Array<{ capacityBytes?: number | null }>
): void {
  if (maxStorage == null) return;
  const capped = poolMembers.map((m) => m.capacityBytes).filter((c): c is number => c != null);
  if (capped.length === 0) return;
  const bucketsTotal = capped.reduce((sum, c) => sum + c, 0);
  if (maxStorage > bucketsTotal) {
    throw ApiError.badRequest(
      `挂载点总上限不得超过各存储桶上限之和（当前 ${maxStorage} > ${bucketsTotal}，未设上限的桶不参与求和）`
    );
  }
}

/**
 * §32 写入候选非空：池内必须至少保留 1 个非备用成员——备用桶只作读回退（§G），不参与写入放置。
 * 空池（清空成员）= 单桶语义（写路径回退主存储锚点），不在此限。与 assertTotalWithinBuckets 同处校验：
 * 先校验后落库，非法组合不产生部分写入。
 */
function assertWritableMemberPresent(poolMembers: Array<{ standby?: boolean | null }>): void {
  if (poolMembers.length === 0) return;
  if (poolMembers.every((m) => m.standby === true)) {
    throw ApiError.badRequest('至少需要一个非备用桶用于写入（全部池成员都被标记为备用）');
  }
}

// ============ 挂载点 ============
adminStorageRoutes.get('/mounts', async (c) => {
  const db = getDb(c);
  // §H 挂载点皆目录：打开管理页即自愈补齐缺失的挂载点目录行
  await ensureAllMountFolders(db);
  const mounts = await MountRepo.allMounts(db);
  const providers = await ProviderRepo.listProviders(db);
  const pInfo: Record<string, { name: string; type: string }> = {};
  for (const p of providers) pInfo[p.id] = { name: p.name, type: p.type };
  // §E 池成员（一次查询后在内存按挂载分组）；§31 桶级矩阵同样一次 IN 查询后分组（禁止 N+1）
  const memberRows = await db.all(
    'SELECT mount_id, provider_id, weight, capacity_bytes, sort_order, standby FROM mount_providers'
  );
  const poolMembers = memberRows.map((r) => ({
    mountId: String(r.mount_id),
    providerId: String(r.provider_id),
    weight: Number(r.weight ?? 1),
    capacityBytes: r.capacity_bytes == null ? null : Number(r.capacity_bytes),
    sortOrder: Number(r.sort_order ?? 0),
    standby: r.standby === 1 || r.standby === true,
  }));
  // §28 挂载点级默认角色权限矩阵（一次 IN 查询后在内存按挂载分组，避免 N+1）
  const rolePermissions = await MountRolePermissionsRepo.listByMounts(db, mounts.map((m) => m.id));
  // §31 桶级默认角色权限矩阵（同上，一次 IN 查询后按 (挂载, 桶) 分组）
  const bucketMatrices = await MountProviderRolePermissionsRepo.listByMounts(db, mounts.map((m) => m.id));
  return ok(c, {
    mounts: mounts.map((m) => {
      const bucketEntries = bucketMatrices.get(m.id) ?? [];
      return {
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
        maxStorage: m.maxStorage,
        capacityBytes: m.capacityBytes,
        usedStorage: m.usedStorage,
        quotaReserved: m.quotaReserved,
        poolStrategy: m.poolStrategy,
        uploadMode: m.uploadMode,
        rolePermissions: rolePermissions.get(m.id) ?? [],
        poolMembers: poolMembers
          .filter((p) => p.mountId === m.id)
          .map((p) => ({
            providerId: p.providerId,
            weight: p.weight,
            name: pInfo[p.providerId]?.name ?? '未知',
            capacityBytes: p.capacityBytes,
            sortOrder: p.sortOrder,
            standby: p.standby,
            rolePermissions: bucketEntries
              .filter((e) => e.providerId === p.providerId)
              .map(({ role, permissions }) => ({ role, permissions })),
          })),
      };
    }),
  });
});

adminStorageRoutes.post('/mounts', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = MountSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('挂载点参数无效');
  const mountPath = normalizePath(parsed.data.mountPath);
  // §32 主存储锚点：providerId 缺省时取入池的第一个桶（锚点随后由 syncPrimaryAnchor 派生，不再由用户选择）
  const poolMemberInput = normalizePoolMembers(parsed.data);
  const requestedProviderId = parsed.data.providerId ?? poolMemberInput[0]?.providerId ?? null;
  if (!requestedProviderId) {
    throw ApiError.badRequest('必须指定存储提供商（providerId），或在 poolMembers / poolProviderIds 中至少提供一个桶');
  }
  const provider = await ProviderRepo.getProviderById(db, requestedProviderId);
  if (!provider) throw ApiError.badRequest('存储提供商不存在');
  // §31/§32 校验：先校验再落库（非法组合不留半成品挂载点）
  assertTotalWithinBuckets(parsed.data.maxStorage ?? null, poolMemberInput);
  assertWritableMemberPresent(poolMemberInput);
  const mount = await MountRepo.createMount(db, {
    providerId: requestedProviderId,
    mountPath,
    name: parsed.data.name,
    sortBy: parsed.data.sortBy,
    sortOrder: parsed.data.sortOrder,
    priority: parsed.data.priority,
    maxStorage: parsed.data.maxStorage ?? null,
    poolStrategy: parsed.data.poolStrategy,
    capacityBytes: parsed.data.capacityBytes ?? null,
  });
  // §28 写入口模式：createMount 签名不覆盖该列，缺省由列默认 'free' 兜底
  if (parsed.data.uploadMode !== undefined) {
    await MountRepo.updateMount(db, mount.id, { upload_mode: parsed.data.uploadMode });
    mount.uploadMode = parsed.data.uploadMode;
  }
  // §28 挂载点级默认角色权限矩阵（全量替换：新建挂载点即为完整目标状态）
  if (parsed.data.rolePermissions !== undefined) {
    await MountRolePermissionsRepo.setForMount(db, mount.id, parsed.data.rolePermissions);
  }
  if (poolMemberInput.length > 0) {
    await setPoolMembersValidated(db, mount.id, requestedProviderId, poolMemberInput);
    // §32 池成员替换后派生主存储锚点（锚点被移出池 / 被标备用 / 成员重排都会随之更新）
    await syncPrimaryAnchor(db, mount.id, parsed.data.providerId ?? null);
  }
  // §H：挂载点必须是父命名空间里可见的目录（锚点可能已被派生改写，取最终行）
  const finalMount = (await MountRepo.getMountById(db, mount.id)) ?? mount;
  await ensureMountFolder(db, finalMount, c.get('userId') as string | undefined);
  return ok(
    c,
    { mount: finalMount, rolePermissions: await MountRolePermissionsRepo.listByMount(db, mount.id) },
    undefined,
    201
  );
});

// 挂载点更新：PUT 与 PATCH 同语义（PATCH 为 §28 管理端契约入口，PUT 为既有调用方兼容；
// 缺省字段不改、rolePermissions 全量替换：传 [] = 清空矩阵）
adminStorageRoutes.on(['PUT', 'PATCH'], '/mounts/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = MountSchema.partial().safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('挂载点参数无效');
  const before = await MountRepo.getMountById(db, id);
  if (!before) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  const fields: Record<string, unknown> = {};
  if (parsed.data.mountPath !== undefined) fields.mount_path = normalizePath(parsed.data.mountPath);
  if (parsed.data.name !== undefined) fields.name = parsed.data.name;
  if (parsed.data.sortBy !== undefined) fields.sort_by = parsed.data.sortBy;
  if (parsed.data.sortOrder !== undefined) fields.sort_order = parsed.data.sortOrder;
  if (parsed.data.priority !== undefined) fields.priority = parsed.data.priority;
  // §32：providerId 不直接落库——锚点由 syncPrimaryAnchor 按「池内可写成员」派生（不再是用户直选字段）
  if (parsed.data.maxStorage !== undefined) fields.max_storage = parsed.data.maxStorage;
  if (parsed.data.capacityBytes !== undefined) fields.capacity_bytes = parsed.data.capacityBytes;
  if (parsed.data.poolStrategy !== undefined) fields.pool_strategy = parsed.data.poolStrategy;
  if (parsed.data.uploadMode !== undefined) fields.upload_mode = parsed.data.uploadMode;
  // §31/§32 校验：以「本请求后的最终状态」判定（总上限、桶上限与备用标记都可能来自本次请求或库内现值），
  // 先校验再落库，非法组合不产生部分写入。
  const replacesMembers = parsed.data.poolMembers !== undefined || parsed.data.poolProviderIds !== undefined;
  const memberInput = replacesMembers ? normalizePoolMembers(parsed.data) : [];
  const finalMembers = replacesMembers ? memberInput : await MountProviderRepo.listMembers(db, id);
  assertTotalWithinBuckets(
    parsed.data.maxStorage !== undefined ? parsed.data.maxStorage : before.maxStorage,
    finalMembers
  );
  assertWritableMemberPresent(finalMembers);
  await MountRepo.updateMount(db, id, fields);
  // §28 挂载点级默认角色权限矩阵：全量替换（传 [] = 清空），缺省字段不改
  if (parsed.data.rolePermissions !== undefined) {
    await MountRolePermissionsRepo.setForMount(db, id, parsed.data.rolePermissions);
  }
  if (replacesMembers) {
    const existing = await MountRepo.getMountById(db, id);
    if (!existing) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
    // 空成员集 = 清空池（回到单桶语义）→ 以「请求锚点 ?? 当前锚点」作为唯一成员落库
    await setPoolMembersValidated(db, id, parsed.data.providerId ?? existing.providerId, memberInput);
  }
  // §32 主存储锚点派生：成员替换后按池内次序重算；只改 providerId 时同样以「可写成员」为准（非法值不会写库）
  if (replacesMembers || parsed.data.providerId !== undefined) {
    await syncPrimaryAnchor(db, id, parsed.data.providerId ?? null);
  }
  // §H：路径或显示名变化时同步挂载点目录行
  const after = await MountRepo.getMountById(db, id);
  if (after) {
    if (before.mountPath !== after.mountPath) await removeMountFolder(db, before);
    await ensureMountFolder(db, after, c.get('userId') as string | undefined);
  }
  return ok(c, { message: '已更新' });
});

adminStorageRoutes.delete('/mounts/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const countRow = await db.first(`SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ?`, [id]);
  if (Number(countRow?.c ?? 0) > 0) {
    throw new ApiError(409, 'OPERATION_FAILED', '挂载点下仍有文件，无法删除');
  }
  const mount = await MountRepo.getMountById(db, id);
  await MountRepo.deleteMount(db, id);
  // §H：连带清理父命名空间里的挂载点目录行
  if (mount) await removeMountFolder(db, mount);
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
