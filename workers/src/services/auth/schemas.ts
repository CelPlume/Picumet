// 认证服务 Zod schemas（docs/ARCHITECTURE_CN.md §认证服务）
import { z } from 'zod';

// 账号字段规则：注册与第三方登录（SSO）注册完成共用同一口径
export const UsernameSchema = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[a-zA-Z0-9_]+$/, '用户名只能包含字母、数字、下划线');
export const PasswordSchema = z.string().min(8).max(128);

export const RegisterSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
  email: z.string().email(),
  emailCode: z.string().regex(/^\d{6}$/, '验证码为 6 位数字').optional(),
  // 邀请码（invite_enabled 时按 invite_required 语义校验；格式/存在性在 handler 判定，
  // 以便按场景返回具体错误码 INVITE_CODE_FORMAT / INVITE_CODE_INVALID 等）
  inviteCode: z.string().max(32).optional(),
});

export const LoginSchema = z.object({
  // 字段名沿用 username 以兼容客户端与调用方，语义为「登录标识」：用户名或邮箱皆可
  // （收敛见 UserRepo.findByLoginIdentifier；含 @ 视为邮箱并补小写匹配）
  username: z.string().min(1),
  password: z.string().min(1),
});

// 密码找回/重置 body 统一 Zod 校验
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
