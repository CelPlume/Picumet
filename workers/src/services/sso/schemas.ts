// SSO 服务 Zod schemas：管理端提供商配置 + 第三方注册完成
import { z } from 'zod';
import { PasswordSchema, UsernameSchema } from '../auth/schemas';
import { ISSUER_MAX_LENGTH } from './config';

// 管理端新建来源：issuer 校验在 handler（需按环境判定是否放行回环地址），此处只管形状
export const SsoProviderCreateSchema = z.object({
  kind: z.enum(['google', 'github', 'oidc']),
  name: z.string().trim().min(1, '请填写来源名称').max(50),
  issuerUrl: z.string().trim().max(ISSUER_MAX_LENGTH).nullable().optional(),
  clientId: z.string().trim().min(1, '请填写 Client ID').max(300),
  clientSecret: z.string().min(1, '请填写 Client Secret').max(500),
  scopes: z.string().trim().max(300).nullable().optional(),
  enabled: z.boolean().optional(),
  /**
   * 是否信任提供方声明的邮箱验证（默认：内置 google/github = true，自定义 oidc = false）：
   * 开启后，提供方声明「已验证」的邮箱可用于自动关联既有账号——仅在该 IdP 真的验证邮箱时安全。
   */
  trustEmailVerified: z.boolean().optional(),
});

/**
 * 更新：全字段可选；`clientSecret` 传空串或掩码 `******` 表示保持原值（与 SMTP 密码同约定），
 * 因此这里必须显式放宽 `.min(1)`——否则「空串 = 保持原值」的契约不可达。
 */
export const SsoProviderUpdateSchema = SsoProviderCreateSchema.omit({ kind: true })
  .partial()
  .extend({ clientSecret: z.string().max(500).optional() });

/**
 * 第三方注册完成：账号资料**由用户在本页自行填写**（不复用提供方档案），
 * 用户/邮箱规则与 /register 同源；邮箱验证码按站点设置与提供方验证状态判定是否必需。
 */
export const SsoCompleteSchema = z.object({
  token: z.string().min(20).max(200),
  username: UsernameSchema,
  password: PasswordSchema,
  email: z.string().email('邮箱格式不正确'),
  emailCode: z.string().regex(/^\d{6}$/, '验证码为 6 位数字').optional(),
  inviteCode: z.string().max(32).optional(),
});

export type SsoProviderCreateRequest = z.infer<typeof SsoProviderCreateSchema>;
export type SsoProviderUpdateRequest = z.infer<typeof SsoProviderUpdateSchema>;
export type SsoCompleteRequest = z.infer<typeof SsoCompleteSchema>;
