// 分享服务 Zod schemas（docs/ARCHITECTURE_CN.md §分享服务）
import { z } from 'zod';

// 创建分享链接：
//   项目集合 —— fileIds：1..50 个文件/文件夹混合（去重与顺序由服务端保证）
//   时间二选一 —— expiresIn（相对秒）或 expiresAt（绝对毫秒时间戳），都缺省 = 永久
//   访问权限 —— 缺省所有人；requireLogin = 仅登录；allowedUsers = 指定用户（用户名列表，服务端解析为 id）
export const CreateShareSchema = z
  .object({
    fileIds: z.array(z.string().min(1)).min(1).max(50),
    title: z.string().max(200).optional(),
    password: z.string().min(1).max(128).optional(),
    expiresIn: z.number().int().min(60).max(365 * 24 * 3600).optional(),
    expiresAt: z.number().int().positive().optional(),
    maxViews: z.number().int().min(1).optional(),
    maxDownloads: z.number().int().min(1).optional(),
    allowPreview: z.boolean().optional(),
    allowDownload: z.boolean().optional(),
    requireLogin: z.boolean().optional(),
    allowedUsers: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.expiresIn !== undefined && data.expiresAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiresIn 与 expiresAt 只能二选一',
      });
    }
  });

export type CreateShareRequest = z.infer<typeof CreateShareSchema>;

// 管理员修改分享属性（PATCH /api/admin/shares/:id）：全部可选，至少提供一项。
//   status —— 撤销/恢复都用该字段表达（active / revoked）
//   expiresAt / maxViews / maxDownloads —— null = 清除限制（永久 / 不限次数）
//   allowedUsers —— 用户名数组（服务端解析为 id 白名单）；null = 清空白名单
//   password —— null 或空串 = 清除密码；非空 = 重置为新密码
export const AdminUpdateShareSchema = z
  .object({
    status: z.enum(['active', 'revoked']).optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
    maxViews: z.number().int().min(1).nullable().optional(),
    maxDownloads: z.number().int().min(1).nullable().optional(),
    allowPreview: z.boolean().optional(),
    allowDownload: z.boolean().optional(),
    requireLogin: z.boolean().optional(),
    allowedUsers: z.array(z.string().trim().min(1).max(64)).max(50).nullable().optional(),
    password: z.string().max(128).nullable().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: '至少提供一项要修改的设置',
  });

export type AdminUpdateShareRequest = z.infer<typeof AdminUpdateShareSchema>;
