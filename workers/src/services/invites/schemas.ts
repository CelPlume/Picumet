// 邀请码服务 Zod schemas
import { z } from 'zod';

/**
 * 生成邀请码（批量）：count 缺省 1；name 可选备注（同批共用，'' 视同未填）。
 * 码值格式/存在性校验不在这里——注册 handler 需要按错误场景返回具体错误码
 * （INVITE_CODE_FORMAT / INVITE_CODE_INVALID），见 services/invites/invites.ts。
 */
export const CreateInvitesSchema = z.object({
  count: z.number().int().min(1).max(10).optional(),
  name: z.string().max(50).optional(),
});

export type CreateInvitesRequest = z.infer<typeof CreateInvitesSchema>;
