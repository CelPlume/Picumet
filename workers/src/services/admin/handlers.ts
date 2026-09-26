// 管理员路由：仪表板、用户管理、角色、分享、文件、日志、系统设置、公告
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import {
  UserRepo, QuotaRepo, ShareRepo, LogRepo, SettingsRepo, AnnouncementRepo,
  DashboardRepo, FileRepo, MountRepo, ReconciliationRepo, Db, trendBucketCount,
} from '../../db';
import type { FileListItem, Share } from '@shared/types';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { toFileListItem } from '../../db/repos/files';
import { RoleDefaultsRepo } from '../../db/repos/role-defaults';
import { parseJson } from '../../db';
import { UserUpdateSchema, SettingsSchema, AnnouncementSchema, RoleNameSchema, RoleDefaultsSchema, FileBanSchema, TrendsQuerySchema } from './schemas';
import { sendMail, type SmtpConfig, resolveSmtpConfig } from '../../utils/smtp';
import { requestIp } from '../../utils/ip';
import { encryptSecret, hashPassword } from '../../utils/crypto';
import { escapeLikePattern } from '../../utils/path';
import { loadRoutePrefixes } from '../storage/direct-links';
import { AdminUpdateShareSchema } from '../shares/schemas';
import { encipherSharePassword } from '../shares/handlers';
import { z } from 'zod';

export const adminRoutes = new Hono<AppBindings>();

// ============ 仪表板 ============
/** /dashboard 与 /stats 共用载荷：stats 七项 + 挂载点关系数组 + 最近动态 */
async function dashboardPayload(db: Db) {
  const [users, stats, mounts, buckets, recentActivity] = await Promise.all([
    UserRepo.countUsers(db),
    DashboardRepo.stats(db),
    DashboardRepo.mounts(db),
    DashboardRepo.bucketTree(db),
    LogRepo.recentActivity(db, 10),
  ]);
  return {
    stats: {
      users,
      userRoles: stats.userRoles,
      files: stats.files,
      providers: stats.providers,
      activeMounts: stats.activeMounts,
      usedSpace: stats.usedSpace,
      totalCapacity: stats.totalCapacity,
    },
    mounts,
    buckets,
    recentActivity,
  };
}

adminRoutes.get('/dashboard', async (c) => {
  const db = getDb(c);
  const [payload, requests24h] = await Promise.all([
    dashboardPayload(db),
    LogRepo.countRecent(db, Date.now() - 24 * 3600 * 1000),
  ]);
  return ok(c, { ...payload, requests24h });
});
adminRoutes.get('/stats', async (c) => {
  const db = getDb(c);
  return ok(c, await dashboardPayload(db));
});

// 桶 → 挂载点树（全部文件挂载点视图骨架；仪表盘已含同数据，无需重复拉全量 dashboard）
adminRoutes.get('/mount-tree', async (c) => {
  const db = getDb(c);
  return ok(c, { buckets: await DashboardRepo.bucketTree(db) });
});

// ============ 趋势聚合（趋势面板曲线） ============
/** 缺省窗口：最近 30 天（省略 from/to 时） */
const TREND_DEFAULT_WINDOW_MS = 30 * 24 * 3600 * 1000;
/** 区间长度上限：2 年（粗粒度下桶数不设限的第二道闸） */
const TREND_MAX_RANGE_MS = 2 * 365 * 24 * 3600 * 1000;
/** 桶数上限：前端曲线与传输体积保护（超出提示缩小区间或粗化粒度） */
const TREND_MAX_BUCKETS = 400;

/**
 * GET /api/admin/dashboard/trends?metric=&granularity=&from=&to=
 * 区间左闭右开 [from, to)，from/to 为毫秒时间戳；缺省 = 最近 30 天。
 * 返回零填充的连续桶（UTC 对齐），供前端直接画图。
 */
adminRoutes.get('/dashboard/trends', async (c) => {
  const db = getDb(c);
  const parsed = TrendsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw ApiError.badRequest('趋势参数无效：metric / granularity 取值非法，或 from / to 不是毫秒时间戳');
  }
  const { metric, granularity } = parsed.data;
  const to = parsed.data.to ?? Date.now();
  const from = parsed.data.from ?? to - TREND_DEFAULT_WINDOW_MS;
  if (from >= to) throw ApiError.badRequest('from 必须小于 to');
  if (to - from > TREND_MAX_RANGE_MS) throw ApiError.badRequest('时间区间过长（上限 2 年），请缩小区间或改用更粗粒度');
  const bucketCount = trendBucketCount(from, to, granularity);
  if (bucketCount > TREND_MAX_BUCKETS) {
    throw ApiError.badRequest(`桶数过多（${bucketCount} > ${TREND_MAX_BUCKETS}），请缩小区间或改用更粗粒度`);
  }
  return ok(c, { metric, granularity, buckets: await DashboardRepo.trends(db, { metric, granularity, from, to }) });
});

// 挂载点展开层：顶层文件夹 + 递归文件计数（可选按落桶 provider 过滤，仪表盘只显示计数）
adminRoutes.get('/dashboard/mount-folders', async (c) => {
  const db = getDb(c);
  const mountId = c.req.query('mountId') ?? '';
  const providerId = c.req.query('providerId') || undefined;
  const mount = await MountRepo.getMountById(db, mountId);
  if (!mount) throw new ApiError(404, 'NOT_FOUND', '挂载点不存在');
  return ok(c, await DashboardRepo.mountFolderSummary(db, mount, providerId));
});


// ============ 用户管理 ============
adminRoutes.get('/users', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
  const { rows, total } = await UserRepo.listUsers(db, {
    page,
    limit,
    role: q.role,
    status: q.status,
    search: q.search,
  });
  const users = await Promise.all(
    rows.map(async (u) => {
      const quota = await QuotaRepo.getQuota(db, u.id);
      return { ...u, quota };
    })
  );
  return ok(c, { users, pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } });
});

adminRoutes.put('/users/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = UserUpdateSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('用户参数无效');
  const { maxStorage, maxFiles, capabilities, permissions, ...rest } = parsed.data;
  const fields: Record<string, unknown> = {};
  if (rest.role !== undefined) fields.role = rest.role;
  if (rest.status !== undefined) fields.status = rest.status;
  if (rest.defaultPath !== undefined) {
    if (!rest.defaultPath.startsWith('/')) throw ApiError.badRequest('默认路径必须以 / 开头');
    fields.default_path = rest.defaultPath;
  }
  if (capabilities !== undefined) fields.capabilities = JSON.stringify(capabilities);
  // 用户个别默认权限（§4.4 第 8 步）：null = 清除个别设置、跟随角色默认
  if (permissions !== undefined) fields.permissions = permissions === null ? null : JSON.stringify(permissions);
  // 禁用/封禁账户时递增会话版本，使其已签发 JWT 立即失效
  const disableChange = rest.status !== undefined && rest.status !== 'active';
  if (Object.keys(fields).length) {
    await UserRepo.updateUser(db, id, fields);
    if (disableChange) await UserRepo.bumpSessionVersion(db, id);
  }
  if (maxStorage !== undefined || maxFiles !== undefined) {
    await QuotaRepo.setQuota(db, id, maxStorage, maxFiles);
  }
  return ok(c, { message: '已更新' });
});

adminRoutes.delete('/users/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  if (id === c.get('userId')) throw new ApiError(400, 'VALIDATION_ERROR', '不能删除自己');
  const user = await UserRepo.getUserById(db, id);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  // 传统路径键/分片对象（blob_hash IS NULL）没有内容索引，users 级联删除后 file_metadata 行
  // 消失会让物理对象永久失去对账依据 → 删除前把落桶信息登记进 orphan_objects（与删除同事务，避免
  // 「已登记但删除失败」时清理队列指向仍被引用的对象），由 cleanupUserDeletedObjects 重试清理。
  const now = Date.now();
  await db.transaction(async (tx) => {
    await ReconciliationRepo.enqueueUserDeletedObjectsTx(tx, id, now);
    await UserRepo.deleteUserTx(tx, id);
  });
  return ok(c, null);
});

// ============ 全局分享 ============

/** 管理端分享详情视图：全属性 + 项目明细；不下发 object_key / physical_key / password_cipher 等内部字段 */
interface AdminShareView {
  id: string;
  title?: string;
  creatorId: string;
  creatorName: string;
  status: Share['status'];
  expiresAt?: number;
  maxViews?: number;
  viewCount: number;
  maxDownloads?: number;
  downloadCount: number;
  allowPreview: boolean;
  allowDownload: boolean;
  requireLogin: boolean;
  allowedUserCount: number;
  passwordProtected: boolean;
  createdAt: number;
  lastAccessedAt?: number;
  items: FileListItem[];
}

function adminShareView(share: Share, creatorName: string, items: FileListItem[]): AdminShareView {
  return {
    id: share.id,
    title: share.title,
    creatorId: share.creatorId,
    creatorName,
    status: share.status,
    expiresAt: share.expiresAt,
    maxViews: share.maxViews,
    viewCount: share.viewCount,
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount,
    allowPreview: share.allowPreview,
    allowDownload: share.allowDownload,
    requireLogin: share.requireLogin,
    allowedUserCount: share.allowedUserIds?.length ?? 0,
    passwordProtected: !!share.passwordHash,
    createdAt: share.createdAt,
    lastAccessedAt: share.lastAccessedAt,
    items,
  };
}

/** 读回管理端分享详情（改后回读同一入口，保证响应结构与 GET 一致） */
async function loadAdminShareView(db: Db, id: string): Promise<AdminShareView | null> {
  const info = await ShareRepo.getShareWithItems(db, id);
  if (!info) return null;
  return adminShareView(info.share, info.creatorName, info.items.map(toFileListItem));
}

adminRoutes.get('/shares', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
  const { rows, total } = await ShareRepo.listAllSharesWithSummary(db, { page, limit, status: q.status });
  const items = rows.map(({ share: s, itemCount, firstItem, creatorName }) => ({
    id: s.id,
    title: s.title,
    creatorId: s.creatorId,
    creatorName,
    file: firstItem,
    viewCount: s.viewCount,
    maxViews: s.maxViews,
    downloadCount: s.downloadCount,
    maxDownloads: s.maxDownloads,
    allowPreview: s.allowPreview,
    allowDownload: s.allowDownload,
    passwordProtected: !!s.passwordHash,
    requireLogin: s.requireLogin,
    allowedUserCount: s.allowedUserIds?.length ?? 0,
    status: s.status,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    itemCount,
  }));
  return ok(c, { items, pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } });
});

adminRoutes.get('/shares/:id', async (c) => {
  const db = getDb(c);
  const share = await loadAdminShareView(db, c.req.param('id'));
  if (!share) throw new ApiError(404, 'NOT_FOUND', '分享不存在');
  return ok(c, { share });
});

adminRoutes.patch('/shares/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = AdminUpdateShareSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '分享参数无效');
  if (!(await ShareRepo.getShare(db, id))) throw new ApiError(404, 'NOT_FOUND', '分享不存在');

  const data = parsed.data;
  const fields: Record<string, unknown> = {};
  if (data.status !== undefined) fields.status = data.status;
  if (data.expiresAt !== undefined) fields.expires_at = data.expiresAt;
  if (data.maxViews !== undefined) fields.max_views = data.maxViews;
  if (data.maxDownloads !== undefined) fields.max_downloads = data.maxDownloads;
  if (data.allowPreview !== undefined) fields.allow_preview = data.allowPreview ? 1 : 0;
  if (data.allowDownload !== undefined) fields.allow_download = data.allowDownload ? 1 : 0;
  if (data.requireLogin !== undefined) fields.require_login = data.requireLogin ? 1 : 0;
  // 指定用户白名单：用户名 → id（未知用户名直接拒绝，与创建分享同口径）；null / 空数组 = 清空
  if (data.allowedUsers !== undefined) {
    const ids: string[] = [];
    for (const username of data.allowedUsers ?? []) {
      const target = await UserRepo.getUserByUsername(db, username);
      if (!target) throw ApiError.badRequest(`用户不存在：${username}`);
      if (!ids.includes(target.id)) ids.push(target.id);
    }
    fields.allowed_user_ids = ids.length > 0 ? JSON.stringify(ids) : null;
  }
  // 密码：null / 空串 = 清除（哈希与密文一并置 NULL）；非空 = 重置（重算哈希 + 重写可逆密文）
  if (data.password !== undefined) {
    if (data.password === null || data.password === '') {
      fields.password_hash = null;
      fields.password_cipher = null;
    } else {
      fields.password_hash = hashPassword(data.password);
      fields.password_cipher = (await encipherSharePassword(data.password, c.env.ENCRYPTION_KEY)) ?? null;
    }
  }
  await ShareRepo.updateShare(db, id, fields);

  const share = await loadAdminShareView(db, id);
  return ok(c, { share });
});

adminRoutes.delete('/shares/:id', async (c) => {
  const db = getDb(c);
  await ShareRepo.revokeShare(db, c.req.param('id'));
  return ok(c, null);
});

// ============ 公开审核（§4.2：管理公开） + 可见性管理（用户设置的管控面） ============
adminRoutes.patch('/files/:id/review', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      status: z.enum(['approved', 'rejected', 'pending']).optional(),
      // 管理员可直接修改用户文件的可见性（private/users/public）
      visibility: z.enum(['private', 'users', 'public']).optional(),
    })
    .refine((v) => v.status !== undefined || v.visibility !== undefined, '至少提供 status 或 visibility')
    .safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('审核参数无效');
  const file = await FileRepo.getFileById(db, id);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');

  const fields: Record<string, unknown> = {};
  if (parsed.data.visibility !== undefined) {
    fields.visibility = parsed.data.visibility;
    // 管理员设置可见性视为已裁定，审核态归位 approved
    fields.review_status = 'approved';
  }
  if (parsed.data.status !== undefined) fields.review_status = parsed.data.status;
  await FileRepo.updateFile(db, id, fields);
  if (file.type === 'folder' && parsed.data.visibility !== undefined) {
    // folder 级联（与用户侧行为一致）：目录名可含 %/_，子树前缀先转义再拼「/%」，否则会误伤兄弟子树
    await db.run(
      `UPDATE file_metadata SET visibility = ?, review_status = ?, updated_at = ?
       WHERE mount_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`,
      [parsed.data.visibility, fields.review_status, Date.now(), file.mountId, file.path, `${escapeLikePattern(file.path)}/%`]
    );
  }
  await LogRepo.create(db, {
    userId: c.get('userId'),
    action: 'review',
    path: file.path,
    metadata: JSON.stringify({ fileId: id, status: parsed.data.status, visibility: parsed.data.visibility }),
  });
  return ok(c, { message: '已更新' });
});

// ============ 全部文件：扁平化树视图 ============
// 全命名空间按路径前缀取行（文件行 path=父目录、文件夹行 path=自身全路径），带属主用户名。
// 与列表视图共用 5 项筛选（挂载点/存储桶/用户/可见性/哈希）；5000 行封顶 + truncated 标记；
// 管理端不做 §4.4a 可见性过滤（管理员全量可见）。
adminRoutes.get('/files/tree', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const { rows, truncated } = await FileRepo.listTree(db, {
    withOwner: true,
    limit: 5000,
    filters: {
      mountId: q.mount || undefined,
      providerId: q.bucket || undefined,
      ownerId: q.user || undefined,
      visibility: q.visibility || undefined,
      blobHashLike: q.hash || undefined,
    },
  });
  return ok(c, {
    items: rows.map((r) => ({ ...toFileListItem(r), ownerName: r.ownerName ?? '' })),
    truncated,
  });
});

// ============ 全部文件 ============
adminRoutes.get('/files', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
  // §26 筛选：bucket=provider 精确、mount=挂载点精确、hash=blob_hash 子串、user=属主精确、
  // visibility/banned=枚举；非法取值忽略，与既有 search/分页/排序共存
  const { rows, total } = await FileRepo.searchFiles(db, {
    query: q.search ?? '',
    page,
    limit,
    mountId: q.mount || undefined,
    providerId: q.bucket || undefined,
    blobHashLike: q.hash || undefined,
    ownerId: q.user || undefined,
    visibility:
      q.visibility === 'private' || q.visibility === 'users' || q.visibility === 'public'
        ? (q.visibility as 'private' | 'users' | 'public')
        : undefined,
    banned: q.banned === 'true' ? true : q.banned === 'false' ? false : undefined,
  });
  // 上传用户（属主）用户名：一次 IN 查询，避免逐行查用户
  const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
  const owners = ownerIds.length
    ? await db.all(`SELECT id, username FROM users WHERE id IN (${ownerIds.map(() => '?').join(',')})`, ownerIds)
    : [];
  const ownerName = new Map(owners.map((o) => [String(o.id), String(o.username)]));
  // §26 每行富化：挂载点名 / 存储桶名按页 IN 批量补齐（mounts 一条、blob_objects 一条、providers 一条，禁止 N+1）
  const mountIds = [...new Set(rows.map((r) => r.mountId))];
  const mountRows = mountIds.length
    ? await db.all(`SELECT id, name FROM mounts WHERE id IN (${mountIds.map(() => '?').join(',')})`, mountIds)
    : [];
  const mountName = new Map(mountRows.map((m) => [String(m.id), String(m.name)]));
  const hashes = [...new Set(rows.map((r) => r.blobHash).filter((v): v is string => !!v))];
  // blob_objects 按 (hash, mount_id) 隔离，每挂载一行；同一 hash 可有多行（各挂载落桶的副本）。
  // 按展示行自身的 mount 匹配其 provider（匹配不到再退化为任取一行），避免把别的挂载的落桶误展示成本文件所在桶。
  const blobRows = hashes.length
    ? await db.all(`SELECT hash, mount_id, provider_id FROM blob_objects WHERE hash IN (${hashes.map(() => '?').join(',')})`, hashes)
    : [];
  const blobProviderByHashMount = new Map(blobRows.map((r) => [`${String(r.hash)}\u0000${String(r.mount_id)}`, String(r.provider_id)]));
  const blobProviderByHash = new Map(blobRows.map((r) => [String(r.hash), String(r.provider_id)]));
  const providerIds = [...new Set([
    ...rows.map((r) => r.providerId).filter((v): v is string => !!v),
    ...blobRows.map((r) => String(r.provider_id)),
  ])];
  const providerRows = providerIds.length
    ? await db.all(`SELECT id, name FROM storage_providers WHERE id IN (${providerIds.map(() => '?').join(',')})`, providerIds)
    : [];
  const providerName = new Map(providerRows.map((p) => [String(p.id), String(p.name)]));
  return ok(c, {
    items: rows.map((r) => {
      // buckets = 落桶 provider 名 + 内容寻址副本（blob_objects）的 provider 名，去重
      const bucketNames = new Set<string>();
      if (r.providerId) {
        const name = providerName.get(r.providerId);
        if (name) bucketNames.add(name);
      }
      const blobProviderId = r.blobHash
        ? blobProviderByHashMount.get(`${r.blobHash}\u0000${r.mountId}`) ?? blobProviderByHash.get(r.blobHash)
        : undefined;
      if (blobProviderId) {
        const name = providerName.get(blobProviderId);
        if (name) bucketNames.add(name);
      }
      const mount = mountName.get(r.mountId);
      return {
        ...toFileListItem(r),
        ownerName: ownerName.get(r.ownerId) ?? '',
        buckets: [...bucketNames],
        mounts: mount ? [mount] : [],
      };
    }),
    pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

// ============ 文件封禁（§26） ============
adminRoutes.put('/files/:id/ban', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = FileBanSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('封禁参数无效');
  const file = await FileRepo.getFileById(db, id);
  if (!file) throw new ApiError(404, 'NOT_FOUND', '文件不存在');
  await FileRepo.updateFile(db, id, { banned: parsed.data.banned ? 1 : 0 });
  return ok(c, { id, banned: parsed.data.banned });
});

// ============ 访问日志 ============
// 游标分页（(created_at, id) 稳定排序键、无 OFFSET、无每页 COUNT(*)）；
// 显式列不返回 metadata/user_agent 宽字段（热层只留可检索窄列，完整取证在审计归档冷层）。
adminRoutes.get('/logs', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
  const { rows, nextCursor, hasMore } = await LogRepo.listCursor(db, {
    limit,
    cursor: q.cursor,
    userId: q.userId,
    action: q.action,
    search: q.search,
    from: q.from ? Number(q.from) : undefined,
    to: q.to ? Number(q.to) : undefined,
  });
  return ok(c, { logs: rows, nextCursor, hasMore });
});

// 审计归档清单（冷层 manifest；仅管理员可见）
adminRoutes.get('/logs/archives', async (c) => {
  const db = getDb(c);
  const archives = await LogRepo.listArchives(db, 100);
  return ok(c, { archives });
});

// 归档对象下载（仅管理员；读取行为本身记录事件，便于审计追溯）
adminRoutes.get('/logs/archives/:id/download', async (c) => {
  const db = getDb(c);
  const bucket = c.env.AUDIT_BUCKET;
  if (!bucket) throw ApiError.badRequest('审计冷归档未配置（缺少 AUDIT_BUCKET 绑定）');
  const archive = await LogRepo.getArchive(db, c.req.param('id'));
  if (!archive) throw new ApiError(404, 'NOT_FOUND', '归档不存在');
  const object = await bucket.get(archive.objectKey);
  if (!object) throw new ApiError(404, 'NOT_FOUND', '归档对象不存在');
  await LogRepo.create(db, {
    userId: c.get('userId') as string,
    action: 'audit_archive_read',
    path: archive.objectKey,
    metadata: JSON.stringify({
      archiveId: archive.id,
      rangeStart: archive.rangeStart,
      rangeEnd: archive.rangeEnd,
      rowCount: archive.rowCount,
      sha256: archive.sha256,
    }),
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
  });
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${archive.objectKey.replace(/^audit\//, '').replace(/\//g, '-')}"`,
      ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
    },
  });
});

// ============ 系统设置 ============
adminRoutes.get('/settings', async (c) => {
  const db = getDb(c);
  const raw = await SettingsRepo.getAll(db);
  const prefixes = await loadRoutePrefixes(db);
  const get = (key: string) => {
    const v = raw[key];
    if (v === undefined || v === 'null') return undefined;
    try {
      return parseJson<unknown>(v, v);
    } catch {
      return v;
    }
  };
  return ok(c, {
    siteTitle: get('site_title') ?? 'Picumet',
    siteHeaderTitle: get('site_header_title'),
    siteLogo: get('site_logo'),
    siteFavicon: get('site_favicon'),
    allowRegistration: get('allow_registration') ?? true,
    allowGuestAccess: get('allow_guest_access') ?? false,
    requireEmailVerification: get('require_email_verification') ?? false,
    rateLimitEnabled: get('rate_limit_enabled') ?? true,
    rateLimitRequestsPerMinute: Number(get('rate_limit_requests_per_minute') ?? 50),
    maxConcurrentTransfers: Number(get('max_concurrent_transfers') ?? 4),
    rateLimitDownloadsPerMinute: Number(get('rate_limit_downloads_per_minute') ?? 120),
    smtpHost: get('smtp_host') ?? '',
    smtpPort: Number(get('smtp_port') ?? 587),
    smtpSecure: get('smtp_secure') ?? true,
    smtpUser: get('smtp_user') ?? '',
    smtpPassword: get('smtp_password') ? '******' : '',
    smtpFromName: get('smtp_from_name') ?? 'Picumet',
    smtpFromEmail: get('smtp_from_email') ?? '',
    emailEnabled: get('email_enabled') ?? false,
    directPrefix: prefixes.directPrefix,
    rootTarget: prefixes.rootTarget,
  });
});

adminRoutes.patch('/settings', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = SettingsSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '设置参数无效');
  // 跨字段约束按「落库后的生效值」校验（PATCH 是部分更新，不能只看本次请求体）
  const current = await loadRoutePrefixes(db);
  const nextDirectPrefix = parsed.data.directPrefix ?? current.directPrefix;
  const nextRootTarget = parsed.data.rootTarget ?? current.rootTarget;
  if (nextRootTarget === 'direct' && nextDirectPrefix !== '') {
    throw ApiError.badRequest('根路径指向直链命名空间时，直链前缀必须留空');
  }
  const map: Record<string, string> = {
    siteTitle: 'site_title',
    siteHeaderTitle: 'site_header_title',
    siteLogo: 'site_logo',
    siteFavicon: 'site_favicon',
    allowRegistration: 'allow_registration',
    allowGuestAccess: 'allow_guest_access',
    requireEmailVerification: 'require_email_verification',
    rateLimitEnabled: 'rate_limit_enabled',
    rateLimitRequestsPerMinute: 'rate_limit_requests_per_minute',
    maxConcurrentTransfers: 'max_concurrent_transfers',
    rateLimitDownloadsPerMinute: 'rate_limit_downloads_per_minute',
    smtpHost: 'smtp_host',
    smtpPort: 'smtp_port',
    smtpSecure: 'smtp_secure',
    smtpUser: 'smtp_user',
    smtpPassword: 'smtp_password',
    smtpFromName: 'smtp_from_name',
    smtpFromEmail: 'smtp_from_email',
    emailEnabled: 'email_enabled',
    directPrefix: 'direct_prefix',
    rootTarget: 'root_target',
  };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    // 占位符/空值表示保持原密码配置，不覆盖
    if (k === 'smtpPassword' && (v === '******' || v === '')) continue;
    // SMTP 密码加密落库（AES-256-GCM，enc: 前缀标记）
    if (k === 'smtpPassword' && typeof v === 'string' && c.env.ENCRYPTION_KEY) {
      const encrypted = await encryptSecret(v, c.env.ENCRYPTION_KEY);
      await SettingsRepo.set(db, 'smtp_password', `enc:${encrypted}`);
      continue;
    }
    await SettingsRepo.set(db, map[k] ?? k, v);
  }
  return ok(c, { message: '已保存' });
});

// ============ SMTP 测试邮件 ============
adminRoutes.post('/settings/test-email', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ to: z.string().email() }).safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('收件邮箱无效');
  const raw = await SettingsRepo.getAll(db);
  const get = (key: string) => {
    const v = raw[key];
    if (v === undefined || v === 'null') return undefined;
    try {
      return parseJson<unknown>(v, v);
    } catch {
      return v;
    }
  };
  const config = await resolveSmtpConfig(raw, c.env as unknown as { ENCRYPTION_KEY: string; SMTP_HOST?: string });
  if (!config?.host) throw ApiError.badRequest('邮件服务未配置');
  if (!config.from) throw ApiError.badRequest('发件邮箱未配置');
  try {
    await sendMail(config, parsed.data.to, 'Picumet 测试邮件', '<p>这是一封测试邮件</p>');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(500, 'MAIL_ERROR', `邮件发送失败：${message}`);
  }
  return ok(c, { message: '测试邮件已发送' });
});

// ============ 公告 ============
adminRoutes.get('/announcements', async (c) => {
  const db = getDb(c);
  const items = await AnnouncementRepo.listAll(db);
  return ok(c, { items });
});

adminRoutes.post('/announcements', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = AnnouncementSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('公告参数无效');
  const id = await AnnouncementRepo.create(db, {
    title: parsed.data.title,
    content: parsed.data.content,
    level: parsed.data.level,
    displayMode: parsed.data.displayMode,
    intervalSeconds: parsed.data.intervalSeconds,
    kind: parsed.data.kind,
    // until 模式的绝对截止时间复用既有 expires_at 列
    expiresAt: parsed.data.endsAt,
  });
  return ok(c, { id }, undefined, 201);
});

adminRoutes.put('/announcements/:id', async (c) => {
  const db = getDb(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const fields: Record<string, unknown> = {};
  if (body?.title !== undefined) fields.title = body.title;
  if (body?.content !== undefined) fields.content = body.content;
  if (body?.level !== undefined) fields.level = body.level;
  if (body?.active !== undefined) fields.active = body.active ? 1 : 0;
  await AnnouncementRepo.update(db, id, fields);
  return ok(c, { message: '已更新' });
});

adminRoutes.delete('/announcements/:id', async (c) => {
  const db = getDb(c);
  await AnnouncementRepo.delete(db, c.req.param('id'));
  return ok(c, null);
});

// ============ 角色管理 ============
adminRoutes.get('/roles', async (c) => {
  const db = getDb(c);
  // permissions 由仓库层按 role_defaults.permissions 读取（缺列/读不到时用兜底常量）
  const roles = await RoleDefaultsRepo.list(db);
  return ok(c, { roles });
});

adminRoutes.post('/roles', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({ role: RoleNameSchema, alias: z.string().max(32).nullable().optional() })
    .safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('角色名仅限小写字母、数字、-、_，以字母开头');
  const existing = await RoleDefaultsRepo.list(db);
  if (existing.some((r) => r.role === parsed.data.role)) throw ApiError.conflict('角色已存在');
  const role = await RoleDefaultsRepo.create(db, parsed.data.role, parsed.data.alias);
  return ok(c, role);
});

adminRoutes.delete('/roles/:role', async (c) => {
  const db = getDb(c);
  const role = c.req.param('role');
  const target = (await RoleDefaultsRepo.list(db)).find((r) => r.role === role);
  if (!target) throw new ApiError(404, 'NOT_FOUND', '角色不存在');
  if (target.isSystem) throw new ApiError(403, 'FORBIDDEN', '内置角色不可删除');
  if (target.members > 0) throw ApiError.badRequest('请先移除该角色下的用户');
  await RoleDefaultsRepo.remove(db, target.role);
  return ok(c, null);
});

adminRoutes.put('/roles/:role/defaults', async (c) => {
  const db = getDb(c);
  const role = c.req.param('role');
  if (!RoleNameSchema.safeParse(role).success) throw ApiError.badRequest('角色名仅限小写字母、数字、-、_，以字母开头');
  const body = await c.req.json().catch(() => null);
  const parsed = RoleDefaultsSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('默认设置参数无效');
  // 未提供的可选字段（alias/defaultStatus/capabilities/permissions）保持对应列现状；
  // permissions 只写 role_defaults（引擎第 8 步读取），不动 users 表
  const patch = { ...parsed.data };
  await RoleDefaultsRepo.upsertDefaults(db, role, patch);
  const affected = await RoleDefaultsRepo.applyToRole(db, role, patch);
  return ok(c, { message: '已保存并应用到该角色全部用户', affected });
});
