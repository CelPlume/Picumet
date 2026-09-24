// 管理服务 Zod schemas（用户管理、系统设置、公告）
import { z } from 'zod';
import { PERMISSION_MATRIX } from '@shared/types';
import { TREND_METRICS, TREND_GRANULARITIES } from '../../db';
import { DIRECT_PREFIX_VALUES, ROOT_TARGET_VALUES, normalizeRoutePrefix } from '../storage/direct-links';

// 角色名：小写字母开头，仅小写字母、数字、-、_（最长 32）
export const RoleNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

// 默认权限矩阵（§4.4 第 8 步）：查看/上传/修改/删除/下载 5 项；分享由能力位 can_share 表达，不入矩阵
export const RolePermissionsSchema = z
  .array(z.enum(PERMISSION_MATRIX))
  .transform((v) => [...new Set(v)]);

/** 用户个别默认权限：null = 清除个别设置、跟随角色默认 */
export const UserPermissionsSchema = RolePermissionsSchema.nullable();

// 角色默认设置（保存后立即覆盖该角色下全部用户：default_path / capabilities / permissions）
export const RoleDefaultsSchema = z.object({
  defaultPath: z.string().regex(/^\//),
  maxStorage: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  alias: z.string().max(32).nullable().optional(),
  defaultStatus: z.enum(['active', 'disabled']).optional(),
  capabilities: z.array(z.enum(['can_share', 'can_publish', 'can_grant'])).optional(),
  permissions: RolePermissionsSchema.optional(),
});

// 更新用户
export const UserUpdateSchema = z.object({
  role: RoleNameSchema.optional(),
  status: z.enum(['active', 'disabled', 'banned']).optional(),
  defaultPath: z.string().min(1).optional(),
  maxStorage: z.number().int().min(0).optional(),
  maxFiles: z.number().int().min(0).optional(),
  // 能力位（§4.4 防线 5）：can_publish / can_share / can_grant
  capabilities: z.array(z.enum(['can_publish', 'can_share', 'can_grant'])).optional(),
  // 用户个别默认权限（矩阵 5 项）：null = 清除个别设置、跟随角色默认
  permissions: UserPermissionsSchema.optional(),
});

// 路由前缀（§ ROUTING_CN）：写入先归一化（去尾斜杠、补前导斜杠）再校验枚举；
// 跨字段约束（root_target='direct' 需空前缀）在 handler 中校验。
// 归一化后再校验，所以 `/d/`、`download` 这类写法被接受并规范为 `/d`、`/download`。
const prefixSchema = <T extends readonly [string, ...string[]]>(allowed: T, label: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? normalizeRoutePrefix(v) : v),
    z.enum(allowed, {
      errorMap: () => ({ message: `${label}取值无效，只能是 ${allowed.map((x) => (x === '' ? '（空）' : x)).join(' / ')}` }),
    })
  );

export const DirectPrefixSchema = prefixSchema(DIRECT_PREFIX_VALUES, '直链前缀');

// 系统设置
export const SettingsSchema = z.object({
  siteTitle: z.string().max(100).optional(),
  // 左上角标题：undefined（未设置）= 跟随 siteTitle；'' = 只显示 Logo 不出文字
  siteHeaderTitle: z.string().max(100).nullable().optional(),
  siteLogo: z.string().max(1000).nullable().optional(),
  siteFavicon: z.string().max(1000).nullable().optional(),
  allowRegistration: z.boolean().optional(),
  allowGuestAccess: z.boolean().optional(),
  requireEmailVerification: z.boolean().optional(),
  enableTurnstile: z.boolean().optional(),
  turnstileSiteKey: z.string().max(1000).nullable().optional(),
  rateLimitEnabled: z.boolean().optional(),
  rateLimitRequestsPerMinute: z.number().int().min(1).max(10000).optional(),
  maxConcurrentTransfers: z.number().int().min(0).max(1000).optional(),
  rateLimitDownloadsPerMinute: z.number().int().min(0).max(100000).optional(),
  smtpHost: z.string().max(300).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().max(300).optional(),
  smtpPassword: z.string().nullable().optional(),
  smtpFromName: z.string().max(200).optional(),
  smtpFromEmail: z.string().email().nullable().optional(),
  emailEnabled: z.boolean().optional(),
  // 路由前缀：公开直链前缀（'' = 站点根）/ 根路径语义
  directPrefix: DirectPrefixSchema.optional(),
  rootTarget: z
    .enum(ROOT_TARGET_VALUES, { errorMap: () => ({ message: '根路径语义取值无效，只能是 landing / files / direct' }) })
    .optional(),
});

// 公告
export const AnnouncementSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  level: z.enum(['info', 'warning', 'danger']).optional(),
  /** 显示时长策略：always/daily/interval/until/duration + toast 专用 once（§27） */
  displayMode: z.enum(['always', 'daily', 'interval', 'until', 'duration', 'once']).optional(),
  /** interval/duration 的间隔秒数 */
  intervalSeconds: z.number().int().min(60).max(31536000).optional(),
  /** until 模式的绝对截止时间（ms） */
  endsAt: z.number().int().positive().optional(),
  /** 呈现形态：banner 常驻横幅 / toast 临时弹窗 */
  kind: z.enum(['banner', 'toast']).optional(),
});

// 文件封禁（§26）：PUT /api/admin/files/:id/ban —— true = 封禁、false = 解封
export const FileBanSchema = z.object({ banned: z.boolean() });

// 趋势查询（GET /api/admin/dashboard/trends）：metric/granularity 枚举 + 可选毫秒时间戳。
// 空串（?from=）视同未给；跨字段约束（from < to）与桶数上限在 handler 判定。
const msParam = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce.number({ invalid_type_error: 'from/to 必须是毫秒时间戳' }).int().nonnegative().optional()
);
export const TrendsQuerySchema = z.object({
  metric: z.enum(TREND_METRICS),
  granularity: z.enum(TREND_GRANULARITIES),
  from: msParam,
  to: msParam,
});

export type UserUpdateRequest = z.infer<typeof UserUpdateSchema>;
export type RoleDefaultsRequest = z.infer<typeof RoleDefaultsSchema>;
export type SettingsRequest = z.infer<typeof SettingsSchema>;
export type AnnouncementRequest = z.infer<typeof AnnouncementSchema>;
export type FileBanRequest = z.infer<typeof FileBanSchema>;
