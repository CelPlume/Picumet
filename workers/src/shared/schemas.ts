// 共享 Zod schemas：路径、文件名、分页、UUID、密码（spec_refactored.md §共享基础设施）
import { z } from 'zod';

// 路径验证：必须以 / 开头，长度限制
export const PathSchema = z.string()
  .regex(/^\//, '路径必须以 / 开头')
  .max(2048, '路径长度不能超过2048');

// 文件名验证：禁止 <> : " | ? * 与控制字符
export const FileNameSchema = z.string()
  .min(1, '文件名不能为空')
  .max(255, '文件名长度不能超过255')
  .regex(/^[^<>:"|?*\x00-\x1F]+$/, '文件名包含非法字符');

// 分页参数
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

// UUID 验证
export const UUIDSchema = z.string().uuid('无效的UUID格式');

// 密码验证
export const PasswordSchema = z.string()
  .min(1, '密码不能为空')
  .max(128, '密码长度不能超过128');

export type PathValue = z.infer<typeof PathSchema>;
export type FileNameValue = z.infer<typeof FileNameSchema>;
export type PaginationValue = z.infer<typeof PaginationSchema>;
