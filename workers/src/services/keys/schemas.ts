// API 密钥服务 Zod schemas
import { z } from 'zod';

// 创建 API 密钥
export const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  permissions: z.array(z.enum(['read', 'write', 'delete'])).min(1),
  // s3：S3 兼容网关（SigV4 签名；见 docs/PICLIST_COMPAT_CN.md）
  protocols: z.array(z.enum(['webdav', 'api', 's3'])).min(1),
  uploadPath: z.string().min(1).optional(),
  allowedIps: z.array(z.string()).optional(),
  expiresIn: z.number().int().min(60).optional(),
});

export type CreateKeyRequest = z.infer<typeof CreateKeySchema>;
