// 用户设置路由：个人资料、外观、修改密码
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { z } from 'zod';
import { UserRepo, QuotaRepo } from '../db';
import { getDb } from '../middleware/auth';
import { ok } from '../utils/response';
import { ApiError } from '../utils/errors';
import { verifyPassword, hashPassword } from '../utils/crypto';

const profileSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  avatarUrl: z.string().max(1000).nullable().optional(),
  locale: z.enum(['zh-CN', 'en-US']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  defaultPath: z.string().min(1).optional(),
});

const passwordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

export const userRoutes = new Hono<AppBindings>();

userRoutes.get('/me/settings', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  const quota = await QuotaRepo.getQuota(db, userId);
  return ok(c, {
    profile: {
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      defaultPath: user.defaultPath,
      locale: user.locale,
      role: user.role,
      createdAt: user.createdAt,
    },
    appearance: {
      theme: user.theme,
      accentColor: '#3B82F6',
      enableBlur: true,
    },
    quota,
  });
});

userRoutes.put('/me/settings', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('设置参数无效');
  const { displayName, avatarUrl, locale, theme, defaultPath } = parsed.data;
  const fields: Record<string, unknown> = {};
  if (displayName !== undefined) fields.display_name = displayName || null;
  if (avatarUrl !== undefined) fields.avatar_url = avatarUrl || null;
  if (locale !== undefined) fields.locale = locale;
  if (theme !== undefined) fields.theme = theme;
  if (defaultPath !== undefined) {
    if (!defaultPath.startsWith('/')) throw ApiError.badRequest('默认路径必须以 / 开头');
    fields.default_path = defaultPath;
  }
  await UserRepo.updateUser(db, userId, fields);
  return ok(c, { message: '已保存' });
});

userRoutes.put('/me/password', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const parsed = passwordSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('密码长度至少 8 位');
  const user = await UserRepo.getUserById(db, userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
  if (!verifyPassword(parsed.data.oldPassword, user.passwordHash ?? '')) {
    throw new ApiError(401, 'INVALID_PASSWORD', '当前密码错误');
  }
  await UserRepo.updateUser(db, userId, { password_hash: hashPassword(parsed.data.newPassword) });
  return ok(c, { message: '密码已修改' });
});
