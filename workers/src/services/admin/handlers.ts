// 管理员路由：仪表板、用户管理、分享、文件、日志、系统设置、公告
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import {
  UserRepo, QuotaRepo, ShareRepo, LogRepo, SettingsRepo, AnnouncementRepo,
  ProviderRepo, FileRepo,
} from '../../db';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { toFileListItem } from '../../db/repos/files';
import { parseJson } from '../../db';
import { UserUpdateSchema, SettingsSchema, AnnouncementSchema } from './schemas';
import { sendMail, type SmtpConfig, resolveSmtpConfig } from '../../utils/smtp';
import { encryptSecret } from '../../utils/crypto';
import { z } from 'zod';

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
  const parsed = UserUpdateSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('用户参数无效');
  const { maxStorage, maxFiles, capabilities, ...rest } = parsed.data;
  const fields: Record<string, unknown> = {};
  if (rest.role !== undefined) fields.role = rest.role;
  if (rest.status !== undefined) fields.status = rest.status;
  if (rest.defaultPath !== undefined) {
    if (!rest.defaultPath.startsWith('/')) throw ApiError.badRequest('默认路径必须以 / 开头');
    fields.default_path = rest.defaultPath;
  }
  if (capabilities !== undefined) fields.capabilities = JSON.stringify(capabilities);
  // 审计 H-05：禁用/封禁账户时递增会话版本，使其已签发 JWT 立即失效
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
    // folder 级联（与用户侧行为一致）
    await db.run(
      `UPDATE file_metadata SET visibility = ?, review_status = ?, updated_at = ?
       WHERE mount_id = ? AND (path = ? OR path LIKE ?)`,
      [parsed.data.visibility, fields.review_status, Date.now(), file.mountId, file.path, `${file.path}/%`]
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
    smtpHost: get('smtp_host') ?? '',
    smtpPort: Number(get('smtp_port') ?? 587),
    smtpSecure: get('smtp_secure') ?? true,
    smtpUser: get('smtp_user') ?? '',
    smtpPassword: get('smtp_password') ? '******' : '',
    smtpFromName: get('smtp_from_name') ?? 'Picumet',
    smtpFromEmail: get('smtp_from_email') ?? '',
    emailEnabled: get('email_enabled') ?? false,
  });
});

adminRoutes.patch('/settings', async (c) => {
  const db = getDb(c);
  const body = await c.req.json().catch(() => null);
  const parsed = SettingsSchema.safeParse(body ?? {});
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
    smtpHost: 'smtp_host',
    smtpPort: 'smtp_port',
    smtpSecure: 'smtp_secure',
    smtpUser: 'smtp_user',
    smtpPassword: 'smtp_password',
    smtpFromName: 'smtp_from_name',
    smtpFromEmail: 'smtp_from_email',
    emailEnabled: 'email_enabled',
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
