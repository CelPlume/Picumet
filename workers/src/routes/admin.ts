// 管理员路由：仪表板、用户管理、分享、文件、日志、系统设置、公告
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { z } from 'zod';
import {
  UserRepo, QuotaRepo, ShareRepo, LogRepo, SettingsRepo, AnnouncementRepo,
  ProviderRepo, FileRepo,
} from '../db';
import { getDb } from '../middleware/auth';
import { ok } from '../utils/response';
import { ApiError } from '../utils/errors';
import { toFileListItem } from '../db/repos/files';
import { parseJson } from '../db';

const userUpdateSchema = z.object({
  role: z.enum(['admin', 'user', 'guest']).optional(),
  status: z.enum(['active', 'disabled', 'banned']).optional(),
  defaultPath: z.string().min(1).optional(),
  maxStorage: z.number().int().min(0).optional(),
  maxFiles: z.number().int().min(0).optional(),
});

const settingsSchema = z.object({
  siteTitle: z.string().max(100).optional(),
  siteLogo: z.string().max(1000).nullable().optional(),
  siteFavicon: z.string().max(1000).nullable().optional(),
  allowRegistration: z.boolean().optional(),
  allowGuestAccess: z.boolean().optional(),
  requireEmailVerification: z.boolean().optional(),
  enableTurnstile: z.boolean().optional(),
  turnstileSiteKey: z.string().max(1000).nullable().optional(),
  rateLimitEnabled: z.boolean().optional(),
  rateLimitRequestsPerMinute: z.number().int().min(1).max(10000).optional(),
});

const announcementSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  level: z.enum(['info', 'warning', 'danger']).optional(),
  expiresIn: z.number().int().min(60).optional(),
});

export const adminRoutes = new Hono<AppBindings>();

// ============ 仪表板 ============
adminRoutes.get('/dashboard', async (c) => {
  const db = getDb(c);
  const users = await UserRepo.countUsers(db);
  const files = await FileRepo.countFiles(db);
  const providers = await ProviderRepo.listProviders(db);
  const storage = await FileRepo.countFilesByProvider(db, providers.map((p) => p.id));
  const recentActivity = await LogRepo.recentActivity(db, 10);
  const requests24h = await LogRepo.countRecent(db, Date.now() - 24 * 3600 * 1000);
  return ok(c, {
    stats: {
      users,
      files,
      storage: storage.map((s) => {
        const p = providers.find((x) => x.id === s.providerId);
        return { providerId: s.providerId, name: p?.name ?? '未知', usedSpace: s.usedSpace, fileCount: s.fileCount };
      }),
    },
    requests24h,
    recentActivity,
  });
});
adminRoutes.get('/stats', async (c) => {
  const db = getDb(c);
  const users = await UserRepo.countUsers(db);
  const files = await FileRepo.countFiles(db);
  const providers = await ProviderRepo.listProviders(db);
  const storage = await FileRepo.countFilesByProvider(db, providers.map((p) => p.id));
  const recentActivity = await LogRepo.recentActivity(db, 10);
  return ok(c, {
    users,
    files,
    storage: storage.map((s) => {
      const p = providers.find((x) => x.id === s.providerId);
      return { providerId: s.providerId, name: p?.name ?? '未知', usedSpace: s.usedSpace, fileCount: s.fileCount };
    }),
    recentActivity,
  });
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
  const parsed = userUpdateSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('用户参数无效');
  const { maxStorage, maxFiles, ...rest } = parsed.data;
  const fields: Record<string, unknown> = {};
  if (rest.role !== undefined) fields.role = rest.role;
  if (rest.status !== undefined) fields.status = rest.status;
  if (rest.defaultPath !== undefined) {
    if (!rest.defaultPath.startsWith('/')) throw ApiError.badRequest('默认路径必须以 / 开头');
    fields.default_path = rest.defaultPath;
  }
  if (Object.keys(fields).length) await UserRepo.updateUser(db, id, fields);
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
  await UserRepo.deleteUser(db, id);
  return ok(c, null);
});

// ============ 全局分享 ============
adminRoutes.get('/shares', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
  const { rows, total } = await ShareRepo.listAllShares(db, { page, limit, status: q.status });
  const items = await Promise.all(
    rows.map(async (s) => {
      const file = await FileRepo.getFileById(db, s.fileId);
      return {
        id: s.id,
        title: s.title,
        creatorId: s.creatorId,
        file: file ? toFileListItem(file) : null,
        viewCount: s.viewCount,
        maxViews: s.maxViews,
        downloadCount: s.downloadCount,
        maxDownloads: s.maxDownloads,
        status: s.status,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      };
    })
  );
  return ok(c, { items, pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } });
});

adminRoutes.delete('/shares/:id', async (c) => {
  const db = getDb(c);
  await ShareRepo.revokeShare(db, c.req.param('id'));
  return ok(c, null);
});

// ============ 全部文件 ============
adminRoutes.get('/files', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
  const { rows, total } = await FileRepo.searchFiles(db, { query: q.search ?? '', page, limit });
  return ok(c, {
    items: rows.map(toFileListItem),
    pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

// ============ 访问日志 ============
adminRoutes.get('/logs', async (c) => {
  const db = getDb(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
  const { rows, total } = await LogRepo.list(db, {
    page,
    limit,
    userId: q.userId,
    action: q.action,
    search: q.search,
    from: q.from ? Number(q.from) : undefined,
    to: q.to ? Number(q.to) : undefined,
  });
  return ok(c, { logs: rows, pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } });
});

// ============ 系统设置 ============
adminRoutes.get('/settings', async (c) => {
  const db = getDb(c);
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
  return ok(c, {
    siteTitle: get('site_title') ?? 'Picumet',
    siteLogo: get('site_logo'),
    siteFavicon: get('site_favicon'),
    allowRegistration: get('allow_registration') ?? true,
    allowGuestAccess: get('allow_guest_access') ?? false,
    requireEmailVerification: get('require_email_verification') ?? false,
    enableTurnstile: get('enable_turnstile') ?? false,
    turnstileSiteKey: get('turnstile_site_key'),
    rateLimitEnabled: get('rate_limit_enabled') ?? true,
    rateLimitRequestsPerMinute: Number(get('rate_limit_requests_per_minute') ?? 50),
  });
});

adminRoutes.patch('/settings', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = settingsSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('设置参数无效');
  const map: Record<string, string> = {
    siteTitle: 'site_title',
    siteLogo: 'site_logo',
    siteFavicon: 'site_favicon',
    allowRegistration: 'allow_registration',
    allowGuestAccess: 'allow_guest_access',
    requireEmailVerification: 'require_email_verification',
    enableTurnstile: 'enable_turnstile',
    turnstileSiteKey: 'turnstile_site_key',
    rateLimitEnabled: 'rate_limit_enabled',
    rateLimitRequestsPerMinute: 'rate_limit_requests_per_minute',
  };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    await SettingsRepo.set(db, map[k] ?? k, v);
  }
  return ok(c, { message: '已保存' });
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
  const parsed = announcementSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('公告参数无效');
  const id = await AnnouncementRepo.create(db, {
    title: parsed.data.title,
    content: parsed.data.content,
    level: parsed.data.level,
    expiresAt: parsed.data.expiresIn ? Date.now() + parsed.data.expiresIn * 1000 : undefined,
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
