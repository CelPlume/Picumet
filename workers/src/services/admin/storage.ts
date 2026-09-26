// 管理员路由：存储提供商、挂载点、权限规则
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import type { Mount, StorageProvider } from '@shared/types';
import { ProviderRepo, MountRepo, MountProviderRepo, MountRolePermissionsRepo, MountProviderRolePermissionsRepo, RuleRepo, normalizeMemberInputs } from '../../db';
import type { Db, MountProviderMemberInput, Tx } from '../../db';
import { getDb } from '../../middleware/auth';
import { getProvider } from '../storage/providers';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { encryptSecret, uuid } from '../../utils/crypto';
import { escapeLikePattern, normalizePath } from '../../utils/path';
import type { Env } from '../../shared/types';
import { validateEndpoint } from '../../utils/ssrf';
import { applyMountFolderPlan, ensureAllMountFolders, removeMountFolder, resolveMountFolderPlan } from '../storage/mount-folders';
import { ProviderSchema, ProviderSchemaBase, MountSchema, RuleSchema } from './storage-schemas';

export const adminStorageRoutes = new Hono<AppBindings>();

/** 管理端池成员入参：§E/§30 成员字段（weight/capacityBytes/sortOrder/standby）+ §31 该桶桶级矩阵（全量替换） */
type PoolMemberInput = MountProviderMemberInput & {
  rolePermissions?: Array<{ role: string; permissions: string[] }>;
};

// ============ 存储提供商 ============

/**
 * Provider **物理引用**计数（PUT 物理定位守卫与 DELETE 全引用检查共用）：
 * 这些引用意味着桶内已有（或在途）对象，改变 bucket/endpoint/region/pathPrefix 会让它们失联。
 * 配置引用（mounts / mount_providers / 桶级矩阵）不改变落点，单列在各自调用点统计。
 */
async function providerPhysicalReferenceCounts(
  db: Db,
  id: string
): Promise<{ files: number; uploadSessions: number; blobObjects: number; blobGc: number }> {
  const files = Number((await db.first('SELECT COUNT(*) AS c FROM file_metadata WHERE provider_id = ?', [id]))?.c ?? 0);
  const uploadSessions = Number(
    (await db.first(
      `SELECT COUNT(*) AS c FROM upload_sessions WHERE provider_id = ? AND status IN ('pending','uploading','verifying')`,
      [id]
    ))?.c ?? 0
  );
  const blobObjects = Number((await db.first('SELECT COUNT(*) AS c FROM blob_objects WHERE provider_id = ?', [id]))?.c ?? 0);
  const blobGc = Number((await db.first('SELECT COUNT(*) AS c FROM blob_gc WHERE provider_id = ?', [id]))?.c ?? 0);
  return { files, uploadSessions, blobObjects, blobGc };
}

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
  // 统一 SSRF 校验（scheme/端口/userinfo + IPv4/IPv6 私网保留段）
  if (!isBinding && !validateEndpoint(endpoint)) {
    throw ApiError.badRequest('存储端点无效：必须为公网 http(s) 地址，且不允许私网/保留地址');
  }

  // 可选一步创建挂载点：同事务 provider + mount（§2.5 交互合并，90% 场景 1:1）
  let normalizedMountPath: string | null = null;
  let mountPriority = 0;
  if (mountPath) {
    normalizedMountPath = normalizePath(mountPath);
    // 一步创建同样走统一放置校验；未提供 priority → 取覆盖路径的祖先优先级（等值合法、深度决胜）
    mountPriority = await nestedDefaultPriority(db, normalizedMountPath);
    await assertMountPlacement(db, { mountPath: normalizedMountPath, priority: mountPriority });
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
         VALUES (?, ?, ?, ?, 'name', 'asc', ?, ?, ?, 'active')`,
        [uuid(), providerId, normalizedMountPath, name, mountPriority, now, now]
      );
    }
  });

  return ok(c, { provider: { id: providerId }, mountPath: normalizedMountPath }, undefined, 201);
});

adminStorageRoutes.put('/storage/providers/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const provider = await ProviderRepo.getProviderById(db, id);
  if (!provider) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  const body = await c.req.json().catch(() => null);
  const parsed = ProviderSchemaBase.partial().safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('存储配置无效');
  // 更新路径与创建路径同一 SSRF 校验——有凭据的 Provider 不能被改指私网/云元数据/任意外部主机；
  // 空串 = 切回 R2 绑定（不发起 S3 请求），放行。
  if (parsed.data.endpoint !== undefined && parsed.data.endpoint !== '' && !validateEndpoint(parsed.data.endpoint)) {
    throw ApiError.badRequest('存储端点无效：必须为公网 http(s) 地址，且不允许私网/保留地址');
  }
  // 物理定位字段（bucket/endpoint/region/pathPrefix，endpoint 置空/填写同时翻转 type）
  // 变更会让同 providerId 下的历史文件行、内容索引与在途会话指向新的物理位置（旧对象批量 404）。
  // 存在任一物理引用 → 409 要求先迁移；名称、公开域名与密钥轮换不改变落点，按无损规则放行。
  const physicalChanged =
    (parsed.data.bucket !== undefined && parsed.data.bucket !== provider.bucket) ||
    (parsed.data.region !== undefined && parsed.data.region !== provider.region) ||
    (parsed.data.pathPrefix !== undefined && (parsed.data.pathPrefix ?? '') !== (provider.pathPrefix ?? '')) ||
    (parsed.data.endpoint !== undefined && (parsed.data.endpoint ?? '') !== (provider.endpoint ?? ''));
  if (physicalChanged) {
    const counts = await providerPhysicalReferenceCounts(db, id);
    const total = counts.files + counts.uploadSessions + counts.blobObjects + counts.blobGc;
    if (total > 0) {
      throw new ApiError(
        409,
        'OPERATION_FAILED',
        '该存储提供商仍被文件/内容索引/在途会话引用，修改物理定位字段会让历史对象失联；请先迁移数据',
        counts
      );
    }
  }
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

/**
 * Provider 删除：全引用检查，存在任一引用 → 409（details 给各类数量），否则在事务内删除。
 * 覆盖：mounts.provider_id（锚点）、mount_providers.provider_id（含其他挂载的池成员）、
 * file_metadata.provider_id（物理落桶）、未完成 upload_sessions.provider_id、
 * blob_objects/blob_gc.provider_id（内容寻址索引与回收队列）、
 * mount_provider_role_permissions.provider_id（桶级矩阵）。
 * 迁移 0006 起 mount_providers / mount_provider_role_permissions 的 provider 外键为 ON DELETE RESTRICT，
 * 作为绕过应用层的兜底；其余无外键的引用由这里的应用层检查保证。
 */
adminStorageRoutes.delete('/storage/providers/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const provider = await ProviderRepo.getProviderById(db, id);
  if (!provider) throw new ApiError(404, 'NOT_FOUND', '存储提供商不存在');
  const physical = await providerPhysicalReferenceCounts(db, id);
  const counts = {
    mounts: Number((await db.first('SELECT COUNT(*) AS c FROM mounts WHERE provider_id = ?', [id]))?.c ?? 0),
    poolMembers: Number((await db.first('SELECT COUNT(*) AS c FROM mount_providers WHERE provider_id = ?', [id]))?.c ?? 0),
    ...physical,
    bucketMatrices: Number(
      (await db.first('SELECT COUNT(*) AS c FROM mount_provider_role_permissions WHERE provider_id = ?', [id]))?.c ?? 0
    ),
  };
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total > 0) {
    throw new ApiError(409, 'OPERATION_FAILED', '存储提供商仍被引用，请先迁移挂载点/文件/会话与内容索引', counts);
  }
  await db.transaction(async (tx) => {
    await ProviderRepo.deleteProvider(tx, id);
  });
  return ok(c, null);
});

/**
 * §E 存储池写阶段（写-only，由调用方包在 db.transaction 内）：
 * 成员差异化落库（保留 quota_reserved）+ §31 桶级矩阵全量替换（缺省 = 不改，[] = 清空该桶矩阵）。
 * 成员存在性 / 公开性一致性 / 移除前检查等读操作在事务外的校验阶段完成。
 */
async function applyPoolMembers(
  tx: Tx,
  mountId: string,
  primaryProviderId: string,
  members: PoolMemberInput[]
): Promise<void> {
  await MountProviderRepo.setMembers(tx, mountId, primaryProviderId, members);
  for (const member of members) {
    if (member.rolePermissions !== undefined) {
      await MountProviderRolePermissionsRepo.setForMount(tx, mountId, member.providerId, member.rolePermissions);
    }
  }
}

/** 池成员 provider 批量读取（读阶段：存在性 + 公开性一致性）；重复 providerId 只取一次。 */
async function loadMemberProviders(db: Db, members: Array<{ providerId: string }>): Promise<StorageProvider[]> {
  const providers: StorageProvider[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.providerId)) continue;
    seen.add(member.providerId);
    const provider = await ProviderRepo.getProviderById(db, member.providerId);
    if (!provider) throw ApiError.badRequest(`存储提供商不存在：${member.providerId}`);
    providers.push(provider);
  }
  return providers;
}

/**
 * 池公开性一致性：同一池成员的 publicDomain 必须「全有或全无」。
 * 否则读回退命中不同桶时，直链的公开/私有语义会随记录桶而变（公开 CDN 桶可能匿名直读私有回退桶）。
 */
function assertPoolPublicDomainConsistent(providers: StorageProvider[]): void {
  const withDomain = providers.filter((p) => Boolean(p.publicDomain)).length;
  if (withDomain !== 0 && withDomain !== providers.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', '同一池不得混用不同公开性策略（publicDomain 全有或全无）');
  }
}

/**
 * 成员移除前检查：对**将被移除**的成员，该挂载下仍有落桶文件（file_metadata.provider_id）、
 * 未完成上传会话（upload_sessions.provider_id）、内容索引行（blob_objects）或回收队列条目（blob_gc）
 * → 409。对象不会自动迁移，静默移除会让历史文件不可达。
 * blob 索引/GC 与 Provider 删除路径的检查对齐——含内容寻址索引的成员不能移出池，
 * 否则会留下悬空索引（对象不可达、清理语义失真）。
 */
async function assertMembersRemovable(db: Db, mountId: string, removedProviderIds: string[]): Promise<void> {
  if (removedProviderIds.length === 0) return;
  const blocking: Array<{ providerId: string; files: number; sessions: number; blobs: number; gc: number }> = [];
  for (const providerId of removedProviderIds) {
    const files = Number(
      (await db.first('SELECT COUNT(*) AS c FROM file_metadata WHERE mount_id = ? AND provider_id = ?', [mountId, providerId]))?.c ?? 0
    );
    const sessions = Number(
      (await db.first(
        `SELECT COUNT(*) AS c FROM upload_sessions WHERE mount_id = ? AND provider_id = ? AND status IN ('pending','uploading','verifying')`,
        [mountId, providerId]
      ))?.c ?? 0
    );
    const blobs = Number(
      (await db.first('SELECT COUNT(*) AS c FROM blob_objects WHERE mount_id = ? AND provider_id = ?', [mountId, providerId]))?.c ?? 0
    );
    const gc = Number(
      (await db.first('SELECT COUNT(*) AS c FROM blob_gc WHERE mount_id = ? AND provider_id = ?', [mountId, providerId]))?.c ?? 0
    );
    if (files > 0 || sessions > 0 || blobs > 0 || gc > 0) blocking.push({ providerId, files, sessions, blobs, gc });
  }
  if (blocking.length > 0) {
    throw new ApiError(409, 'OPERATION_FAILED', '成员仍有文件/在途会话/内容索引，无法移除，请先迁移', { members: blocking });
  }
}

/**
 * §32 主存储锚点派生（内存版，写阶段只落库）：池内**第一个可写成员**
 * （sort_order 升序、同序 provider_id 升序）；请求里显式给的可写成员优先保留（兼容既有管理端调用方）。
 * 池内无可写成员：成员集为空 = 单桶语义（显式请求即锚点，否则不动）；成员全为备用 = 坏配置（不动）。
 */
function deriveAnchor(members: Required<MountProviderMemberInput>[], requestedProviderId: string | null): string | null {
  const writable = members.filter((m) => !m.standby);
  if (writable.length === 0) return members.length === 0 ? requestedProviderId : null;
  const first = writable
    .slice()
    .sort((a, b) => ((a.sortOrder ?? 0) !== (b.sortOrder ?? 0) ? (a.sortOrder ?? 0) - (b.sortOrder ?? 0) : a.providerId.localeCompare(b.providerId)))[0];
  if (!first) return null;
  return writable.find((m) => m.providerId === requestedProviderId)?.providerId ?? first.providerId;
}

/**
 * 挂载放置统一校验（Provider 一步创建 / POST /mounts / PATCH|PUT /mounts/:id 共用）：
 * 1) 同规范化路径的另一个挂载 → 400 ALREADY_EXISTS；
 * 2) 嵌套不变量（**非严格**）：对任一现存祖先要求 X.priority >= 祖先.priority，
 *    对任一现存后代要求 X.priority <= 后代.priority（等值合法，深度决胜）；
 *    只禁止「祖先优先级严格高于后代」的遮蔽组合 → 400 并说明原因；
 * 3) 数据遮蔽守卫（checkDataShadow 时）：新/改路径 P 被现存祖先挂载 E 覆盖（E 为 P 的严格祖先），
 *    且 E 命名空间下已有 P 子树的 file_metadata 行（path = P 或 path LIKE 'P/%'）→ 409。
 */
async function assertMountPlacement(
  db: Db,
  input: { mountPath: string; priority: number; excludeMountId?: string; checkDataShadow?: boolean }
): Promise<void> {
  const path = normalizePath(input.mountPath);
  const others = (await MountRepo.allMounts(db)).filter((m) => m.id !== input.excludeMountId);
  for (const other of others) {
    if (other.mountPath === path) throw new ApiError(400, 'ALREADY_EXISTS', `挂载路径已存在：${path}`);
  }
  const ancestors = others.filter((m) => m.mountPath === '/' || path.startsWith(m.mountPath + '/'));
  const descendants = others.filter((m) => path === '/' || m.mountPath.startsWith(path + '/'));
  for (const ancestor of ancestors) {
    if (input.priority < ancestor.priority) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `优先级遮蔽：挂载 ${path}(priority=${input.priority}) 低于祖先 ${ancestor.mountPath}(priority=${ancestor.priority})，该子树将被祖先覆盖而不可达；要求子挂载 priority >= 祖先（等值合法，深度决胜）`
      );
    }
  }
  for (const descendant of descendants) {
    if (input.priority > descendant.priority) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `优先级遮蔽：挂载 ${path}(priority=${input.priority}) 高于后代 ${descendant.mountPath}(priority=${descendant.priority})，后代将被遮蔽；要求祖先 priority <= 后代（等值合法，深度决胜）`
      );
    }
  }
  if (input.checkDataShadow === false) return;
  const like = `${escapeLikePattern(path)}/%`;
  for (const ancestor of ancestors) {
    const row = await db.first(
      `SELECT 1 AS x FROM file_metadata WHERE mount_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\') LIMIT 1`,
      [ancestor.id, path, like]
    );
    if (row) {
      throw new ApiError(
        409,
        'OPERATION_FAILED',
        `目标路径已有父挂载数据，无 overlay 合并语义，请先迁移：${path}（父挂载 ${ancestor.mountPath}）`
      );
    }
  }
}

/**
 * 缺省 priority：取覆盖该路径的现存祖先挂载的最高 priority（等值合法、深度决胜，新建挂载不会被祖先遮蔽）。
 * 无祖先（创建根挂载）→ 0。显式提供 priority 时不走这里，按 assertMountPlacement 的非严格不等式校验。
 */
async function nestedDefaultPriority(db: Db, mountPath: string): Promise<number> {
  const path = normalizePath(mountPath);
  const mounts = await MountRepo.allMounts(db);
  return mounts.reduce(
    (max, m) => (m.mountPath === '/' || path.startsWith(m.mountPath + '/') ? Math.max(max, m.priority) : max),
    0
  );
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
  // §32 主存储锚点：providerId 缺省时取入池的第一个桶（锚点随后派生，不再由用户选择）
  const poolMemberInput = normalizePoolMembers(parsed.data);
  const requestedProviderId = parsed.data.providerId ?? poolMemberInput[0]?.providerId ?? null;
  if (!requestedProviderId) {
    throw ApiError.badRequest('必须指定存储提供商（providerId），或在 poolMembers / poolProviderIds 中至少提供一个桶');
  }
  const provider = await ProviderRepo.getProviderById(db, requestedProviderId);
  if (!provider) throw ApiError.badRequest('存储提供商不存在');

  // 读阶段：先校验后落库（非法组合不留半成品挂载点）
  const priority = parsed.data.priority ?? (await nestedDefaultPriority(db, mountPath));
  await assertMountPlacement(db, { mountPath, priority });
  assertTotalWithinBuckets(parsed.data.maxStorage ?? null, poolMemberInput);
  assertWritableMemberPresent(poolMemberInput);
  const finalMembers = normalizeMemberInputs(poolMemberInput, requestedProviderId);
  assertPoolPublicDomainConsistent(await loadMemberProviders(db, finalMembers));
  const anchor = deriveAnchor(finalMembers, parsed.data.providerId ?? null);

  // 目录行登记计划（读阶段解析）：同路径已有用户目录/文件 → 409（不隐式复用用户行）
  const mountId = uuid();
  const mountSource = { id: mountId, mountPath, name: parsed.data.name };
  const folderPlan = await resolveMountFolderPlan(db, mountSource, c.get('userId') as string | undefined, {
    strict: true,
  });

  // 写阶段（挂载行 / upload mode / 角色矩阵 / 成员 / 锚点 / 目录行登记同一事务）
  await db.transaction(async (tx) => {
    await MountRepo.insertMount(tx, {
      id: mountId,
      providerId: requestedProviderId,
      mountPath,
      name: parsed.data.name,
      sortBy: parsed.data.sortBy,
      sortOrder: parsed.data.sortOrder,
      priority,
      maxStorage: parsed.data.maxStorage ?? null,
      poolStrategy: parsed.data.poolStrategy,
      capacityBytes: parsed.data.capacityBytes ?? null,
      uploadMode: parsed.data.uploadMode,
    });
    // §28 挂载点级默认角色权限矩阵（全量替换：新建挂载点即为完整目标状态）
    if (parsed.data.rolePermissions !== undefined) {
      await MountRolePermissionsRepo.setForMount(tx, mountId, parsed.data.rolePermissions);
    }
    await applyPoolMembers(tx, mountId, requestedProviderId, poolMemberInput);
    // §32 主存储锚点：池内第一个可写成员（显式请求的可写成员优先保留）
    if (anchor) await MountRepo.updateMount(tx, mountId, { provider_id: anchor });
    if (folderPlan) await applyMountFolderPlan(tx, folderPlan, mountSource);
  });

  const finalMount = (await MountRepo.getMountById(db, mountId)) as Mount;
  return ok(
    c,
    { mount: finalMount, rolePermissions: await MountRolePermissionsRepo.listByMount(db, mountId) },
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

  const nextPath = parsed.data.mountPath !== undefined ? normalizePath(parsed.data.mountPath) : before.mountPath;
  const nextName = parsed.data.name ?? before.name;
  const nextPriority = parsed.data.priority ?? before.priority;
  const pathChanged = nextPath !== before.mountPath;
  const nameChanged = parsed.data.name !== undefined && parsed.data.name !== before.name;

  const fields: Record<string, unknown> = {};
  if (parsed.data.mountPath !== undefined) fields.mount_path = nextPath;
  if (parsed.data.name !== undefined) fields.name = parsed.data.name;
  if (parsed.data.sortBy !== undefined) fields.sort_by = parsed.data.sortBy;
  if (parsed.data.sortOrder !== undefined) fields.sort_order = parsed.data.sortOrder;
  if (parsed.data.priority !== undefined) fields.priority = parsed.data.priority;
  // §32：providerId 不直接落库——锚点按「池内可写成员」派生（不再是用户直选字段）
  if (parsed.data.maxStorage !== undefined) fields.max_storage = parsed.data.maxStorage;
  if (parsed.data.capacityBytes !== undefined) fields.capacity_bytes = parsed.data.capacityBytes;
  if (parsed.data.poolStrategy !== undefined) fields.pool_strategy = parsed.data.poolStrategy;
  if (parsed.data.uploadMode !== undefined) fields.upload_mode = parsed.data.uploadMode;

  // 读阶段：放置校验（改路径或改优先级时；改路径时查父挂载数据遮蔽）
  if (pathChanged || parsed.data.priority !== undefined) {
    await assertMountPlacement(db, {
      mountPath: nextPath,
      priority: nextPriority,
      excludeMountId: id,
      checkDataShadow: pathChanged,
    });
  }

  const replacesMembers = parsed.data.poolMembers !== undefined || parsed.data.poolProviderIds !== undefined;
  const memberInput = replacesMembers ? normalizePoolMembers(parsed.data) : [];
  // 成员集总是读出：即使本次不替换成员，总上限校验（§31）也需要既有桶上限参与判定
  const existingMembers = await MountProviderRepo.listMembers(db, id);
  const effectivePrimary = parsed.data.providerId ?? before.providerId;
  // 最终成员集（空成员集 = 单桶语义：回填主锚点），用于总上限校验与锚点派生
  const finalMembers = replacesMembers
    ? normalizeMemberInputs(memberInput, effectivePrimary)
    : normalizeMemberInputs(existingMembers, before.providerId);
  assertTotalWithinBuckets(
    parsed.data.maxStorage !== undefined ? parsed.data.maxStorage : before.maxStorage,
    finalMembers
  );
  assertWritableMemberPresent(finalMembers);

  // 读阶段：成员校验（存在性 / 公开性一致性 / 移除前检查）
  if (replacesMembers) {
    assertPoolPublicDomainConsistent(await loadMemberProviders(db, finalMembers));
    const finalIds = new Set(finalMembers.map((m) => m.providerId));
    const removed = existingMembers.map((m) => m.providerId).filter((providerId) => !finalIds.has(providerId));
    await assertMembersRemovable(db, id, removed);
  }
  const anchor =
    replacesMembers || parsed.data.providerId !== undefined
      ? deriveAnchor(finalMembers, parsed.data.providerId ?? null)
      : null;

  // 读阶段：目录行登记计划（改路径或改显示名）；同路径已有用户目录/文件 → 409
  const mountSource = { id, mountPath: nextPath, name: nextName };
  const folderPlan =
    pathChanged || nameChanged
      ? await resolveMountFolderPlan(db, mountSource, c.get('userId') as string | undefined, { strict: true })
      : null;

  // 写阶段（挂载行 / 角色矩阵 / 成员 / 锚点 / 目录行同一事务）
  await db.transaction(async (tx) => {
    await MountRepo.updateMount(tx, id, fields);
    // §28 挂载点级默认角色权限矩阵：全量替换（传 [] = 清空），缺省字段不改
    if (parsed.data.rolePermissions !== undefined) {
      await MountRolePermissionsRepo.setForMount(tx, id, parsed.data.rolePermissions);
    }
    if (replacesMembers) await applyPoolMembers(tx, id, effectivePrimary, memberInput);
    if (anchor) await MountRepo.updateMount(tx, id, { provider_id: anchor });
    // §H：改路径 → 先按身份删旧行，再登记新路径目录行；仅改显示名 → 更新身份行标题
    if (pathChanged) await removeMountFolder(tx, before);
    if (folderPlan) await applyMountFolderPlan(tx, folderPlan, mountSource);
  });

  return ok(c, { message: '已更新' });
});

adminStorageRoutes.delete('/mounts/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const mount = await MountRepo.getMountById(db, id);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  // 删除用一条条件 DELETE 同时判定无文件、无在途会话：消除「先查后删」的 TOCTOU；
  // 子表（池成员/角色矩阵/会话）由外键 ON DELETE CASCADE 清理——在途会话会带走预留行，故必须在条件里排除。
  const res = await db.run(
    `DELETE FROM mounts WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM file_metadata WHERE mount_id = ?)
       AND NOT EXISTS (SELECT 1 FROM upload_sessions WHERE mount_id = ? AND status IN ('pending','uploading','verifying'))`,
    [id, id, id]
  );
  if (res.changes === 0) {
    throw new ApiError(409, 'OPERATION_FAILED', '挂载点下仍有文件或在途上传会话，无法删除');
  }
  // §H：连带清理父命名空间里的挂载点目录行
  await removeMountFolder(db, mount);
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
  const rule = await RuleRepo.createRule(db, {
    ...parsed.data,
    mountId: parsed.data.mountId ?? undefined,
    role: parsed.data.role ?? undefined,
    userId: parsed.data.userId ?? undefined,
    apiKeyId: parsed.data.apiKeyId ?? undefined,
    pathPattern: pattern,
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
  if (parsed.data.priority !== undefined) fields.priority = parsed.data.priority;
  await RuleRepo.updateRule(db, id, fields);
  return ok(c, { message: '已更新' });
});

adminStorageRoutes.delete('/rules/:id', async (c) => {
  const db = getDb(c);
  await RuleRepo.deleteRule(db, c.req.param('id'));
  return ok(c, null);
});
