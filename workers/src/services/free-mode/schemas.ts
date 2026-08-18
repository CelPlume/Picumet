// 自由模式服务 Zod schemas
import { z } from 'zod';

// 初始化自由模式会话
export const FreeModeInitSchema = z.object({
  type: z.enum(['r2', 's3', 'oracle']),
  endpoint: z.string().min(1).max(500),
  region: z.string().max(100).optional(),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().min(1).max(500),
  secretAccessKey: z.string().min(1).max(500),
  sessionHours: z.number().int().min(1).max(8).default(1),
});

export type FreeModeInitRequest = z.infer<typeof FreeModeInitSchema>;
