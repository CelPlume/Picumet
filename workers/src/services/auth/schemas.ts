// 认证服务 Zod schemas（docs/ARCHITECTURE_CN.md §认证服务）
import { z } from 'zod';

export const RegisterSchema = z.object({
  username: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/, '用户名只能包含字母、数字、下划线'),
  password: z.string().min(8).max(128),
  email: z.string().email(),
  emailCode: z.string().regex(/^\d{6}$/, '验证码为 6 位数字').optional(),
});

export const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// 审计 M-05：密码找回/重置 body 统一 Zod 校验
export const ForgotPasswordSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
});

export const ResetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(8).max(128, '密码长度至少 8 位'),
});

export type RegisterRequest = z.infer<typeof RegisterSchema>;
export type LoginRequest = z.infer<typeof LoginSchema>;
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordRequest = z.infer<typeof ResetPasswordSchema>;
