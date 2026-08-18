// 用户设置服务 Zod schemas
import { z } from 'zod';

// 个人资料
export const ProfileSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  avatarUrl: z.string().max(1000).nullable().optional(),
  locale: z.enum(['zh-CN', 'en-US']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  defaultPath: z.string().min(1).optional(),
});

// 修改密码
export const PasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

export type ProfileRequest = z.infer<typeof ProfileSchema>;
export type PasswordRequest = z.infer<typeof PasswordSchema>;
