// 分享服务 Zod schemas（docs/ARCHITECTURE_CN.md §分享服务）
import { z } from 'zod';

// 创建分享链接
export const CreateShareSchema = z.object({
  fileId: z.string().min(1),
  title: z.string().max(200).optional(),
  password: z.string().min(1).max(128).optional(),
  expiresIn: z.number().int().min(60).max(365 * 24 * 3600).optional(),
  maxViews: z.number().int().min(1).optional(),
  maxDownloads: z.number().int().min(1).optional(),
  allowPreview: z.boolean().optional(),
  allowDownload: z.boolean().optional(),
});

export type CreateShareRequest = z.infer<typeof CreateShareSchema>;
