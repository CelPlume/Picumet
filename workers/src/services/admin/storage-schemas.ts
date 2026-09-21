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

// 存储提供商（报告 §5.2 单表单平铺）：
// type 由「有无 endpoint」在后端推导，不再是入参；绑定模式 = endpoint/AK/SK 全留空。
export const ProviderSchemaBase = z.object({
  name: z.string().min(1).max(100),
  endpoint: z.string().max(500).optional(),
  region: z.string().max(100).optional(),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().max(500).optional(),
  secretAccessKey: z.string().max(500).optional(),
  publicDomain: httpsUrl('公网域名格式不正确').nullable().optional(),
  pathPrefix: z.string().max(500).optional(),
  // 可选：提交时同事务创建挂载点（添加存储一步完成，§2.5 交互合并）
  mountPath: z.string().max(500).optional(),
});

// 创建用：endpoint/AK/SK 必须同填同空
export const ProviderSchema = ProviderSchemaBase.superRefine((data, ctx) => {
  const filled = [data.endpoint?.trim(), data.accessKeyId?.trim(), data.secretAccessKey?.trim()].filter(Boolean).length;
  if (filled !== 0 && filled !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endpoint'],
      message: 'Endpoint、Access Key ID、Secret Access Key 需同时填写或同时留空（留空 = 使用 R2 绑定）',
    });
  }
});

// 挂载点
export const MountSchema = z.object({
  providerId: z.string().min(1),
  mountPath: z.string().min(1),
  name: z.string().min(1).max(100),
  sortBy: z.enum(['name', 'time', 'size', 'manual']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  priority: z.number().int().optional(),
  // 挂载容量（字节）；null = 不限（默认）
  maxStorage: z.number().int().positive().nullable().optional(),
  // 展示容量（§26 仪表盘占用率，字节）；null/缺省 = 未设置
  capacityBytes: z.number().int().min(0).nullable().optional(),
  // 存储池（§E）：写入选桶策略 + 池成员 provider（缺省 = 仅主 provider）
  poolStrategy: z.enum(['least_used', 'round_robin', 'hash']).optional(),
  poolProviderIds: z.array(z.string().min(1)).max(20).optional(),
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
