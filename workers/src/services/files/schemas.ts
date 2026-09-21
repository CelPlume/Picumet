// 文件服务 Zod schemas（docs/ARCHITECTURE_CN.md §文件管理服务）
import { z } from 'zod';

// 更新元数据 / 重命名 / 可见性
export const UpdateFileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  customTitle: z.string().max(200).nullable().optional(),
  customColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  coverUrl: z.string().max(1000).nullable().optional(),
  // 自定义图标：可存 Emoji / 图片 URL（http/https、data:image/） / SVG 代码
  iconEmoji: z.string().max(2000).nullable().optional(),
  accessPassword: z.string().min(1).max(128).nullable().optional(),
  manualPosition: z.number().int().nullable().optional(),
  // §4.4a：三级可见性（folder 置可见性时级联子树）
  visibility: z.enum(['private', 'users', 'public']).optional(),
  // §C 文件级游客可见性：inherit（或不传）= 未设置（跟随角色默认/不额外开放）；none/download/view = 显式
  guestVisibility: z.enum(['inherit', 'none', 'download', 'view']).optional(),
  // 可见性级联开关：缺省 true（folder 置可见性时级联整棵子树）；false = 只改本项本身
  cascade: z.boolean().optional(),
});

// 创建文件夹
export const CreateFolderSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(255),
});

// 移动文件
export const MoveFileSchema = z.object({
  targetPath: z.string().min(1),
  newName: z.string().min(1).max(255).optional(),
});

// 批量操作
export const BatchOpSchema = z.object({
  action: z.enum(['delete', 'move']),
  fileIds: z.array(z.string()).min(1).max(100),
  targetPath: z.string().optional(),
  permanent: z.boolean().optional(),
});

// 密码验证
export const VerifyPasswordSchema = z.object({
  password: z.string().min(1).max(128),
});

// 文件列表查询参数（审计 M-05：query 统一 Zod 校验，限制长度/枚举/数字范围）
export const ListQuerySchema = z.object({
  path: z.string().min(1).max(2048).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  sort: z.enum(['name', 'time', 'size', 'manual']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  type: z.enum(['file', 'folder']).optional(),
  search: z.string().max(255).optional(),
});

export type UpdateFileRequest = z.infer<typeof UpdateFileSchema>;
export type CreateFolderRequest = z.infer<typeof CreateFolderSchema>;
export type MoveFileRequest = z.infer<typeof MoveFileSchema>;
export type BatchOpRequest = z.infer<typeof BatchOpSchema>;
export type VerifyPasswordRequest = z.infer<typeof VerifyPasswordSchema>;
export type ListQueryRequest = z.infer<typeof ListQuerySchema>;
