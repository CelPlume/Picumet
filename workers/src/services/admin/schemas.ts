// 管理服务 Zod schemas（用户管理、系统设置、公告）
import { z } from 'zod';

// 更新用户
export const UserUpdateSchema = z.object({
  role: z.enum(['admin', 'user', 'guest']).optional(),
  status: z.enum(['active', 'disabled', 'banned']).optional(),
  defaultPath: z.string().min(1).optional(),
  maxStorage: z.number().int().min(0).optional(),
  maxFiles: z.number().int().min(0).optional(),
});

// 系统设置
export const SettingsSchema = z.object({
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

// 公告
export const AnnouncementSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  level: z.enum(['info', 'warning', 'danger']).optional(),
  expiresIn: z.number().int().min(60).optional(),
});

export type UserUpdateRequest = z.infer<typeof UserUpdateSchema>;
export type SettingsRequest = z.infer<typeof SettingsSchema>;
export type AnnouncementRequest = z.infer<typeof AnnouncementSchema>;
