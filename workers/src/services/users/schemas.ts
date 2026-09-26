// 用户设置服务 Zod schemas
import { z } from 'zod';

// 个人资料（defaultPath 归管理员在用户管理中设置，用户不可自助修改）
export const ProfileSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  avatarUrl: z.string().max(1000).nullable().optional(),
  locale: z.enum(['zh-CN', 'en-US']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
});

// 修改密码（emailCode：站点启用邮件服务且账号已绑定邮箱时由 /me/password/send-code 下发后必填）
export const PasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
  emailCode: z.string().regex(/^\d{6}$/, '验证码必须为 6 位数字').optional(),
});

// 发送邮箱验证码
export const SendOtpSchema = z.object({
  email: z.string().email(),
});

// 验证邮箱验证码
export const VerifyOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, '验证码必须为 6 位数字'),
});

// 公告撤回（body 可整体缺省；forever 缺省 true＝永久不再提示）
export const DismissAnnouncementSchema = z.object({
  forever: z.boolean().default(true),
});

export type ProfileRequest = z.infer<typeof ProfileSchema>;
export type PasswordRequest = z.infer<typeof PasswordSchema>;
export type SendOtpRequest = z.infer<typeof SendOtpSchema>;
export type VerifyOtpRequest = z.infer<typeof VerifyOtpSchema>;
