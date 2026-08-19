// 上传服务 Zod schemas（docs/ARCHITECTURE_CN.md §上传服务）
import { z } from 'zod';

// 初始化上传会话（单文件 / 分片）
export const InitUploadSchema = z.object({
  path: z.string().min(1),
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().min(0).max(20 * 1024 * 1024 * 1024),
  mimeType: z.string().optional(),
  partCount: z.number().int().min(1).optional(),
  idempotencyKey: z.string().optional(),
});

// 完成上传（审计 M-05：sessionId/etag/parts 统一校验）
export const CompleteUploadSchema = z.object({
  sessionId: z.string().min(1).max(200),
  etag: z.string().max(200).optional(),
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1).max(200) }))
    .max(10000)
    .optional(),
});

export type InitUploadRequest = z.infer<typeof InitUploadSchema>;
export type CompleteUploadRequest = z.infer<typeof CompleteUploadSchema>;
