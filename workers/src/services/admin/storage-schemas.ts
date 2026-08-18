// 管理服务存储 Zod schemas（存储提供商、挂载点、权限规则）
import { z } from 'zod';

// 审计 M-03：公网/上传域名必须为合法 URL，且生产仅允许 https（本地 localhost 允许 http）。
// 防止管理员误配 http/非预期主机导致混合内容或数据外传。
function httpsUrl(message: string) {
  return z
    .string()
    .trim()
    .url(message)
    .refine((v) => {
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return false;
      }
      if (url.protocol === 'https:') return true;
      // 仅本地开发允许 http://localhost / http://127.0.0.1
      if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        return true;
      }
      return false;
    }, '仅允许 https 公网地址（本地开发可使用 http://localhost）');
}

// 存储提供商
export const ProviderSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['r2', 's3', 'oracle']),
  endpoint: z.string().max(500).optional(),
  region: z.string().max(100).optional(),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().max(500).optional(),
  secretAccessKey: z.string().max(500).optional(),
  publicDomain: httpsUrl('公网域名格式不正确').nullable().optional(),
  uploadDomain: httpsUrl('上传域名格式不正确').nullable().optional(),
  pathPrefix: z.string().max(500).optional(),
});

// 挂载点
export const MountSchema = z.object({
  providerId: z.string().min(1),
  mountPath: z.string().min(1),
  name: z.string().min(1).max(100),
  sortBy: z.enum(['name', 'time', 'size', 'manual']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  priority: z.number().int().optional(),
});

// 权限规则
export const RuleSchema = z.object({
  pathPattern: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
  mountId: z.string().nullable().optional(),
  role: z.enum(['admin', 'user', 'guest']).nullable().optional(),
  userId: z.string().nullable().optional(),
  apiKeyId: z.string().nullable().optional(),
  permissions: z.array(z.enum(['read', 'write', 'update', 'delete', 'share', 'download'])).min(1),
  requirePassword: z.boolean().optional(),
  password: z.string().min(1).max(128).optional(),
  allowedIps: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
});

export type ProviderRequest = z.infer<typeof ProviderSchema>;
export type MountRequest = z.infer<typeof MountSchema>;
export type RuleRequest = z.infer<typeof RuleSchema>;
