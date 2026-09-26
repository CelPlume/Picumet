// 用户自建访问规则路由（§4.4b）：/api/users/rules
// 用户在设置页授权/禁止其他用户访问自己的文件；越权防线见 rule-guard.ts 与报告 §4.4。
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { FileRepo, RuleRepo, UserRepo, LogRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { getPrincipal } from '../permissions/principal';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { requestIp } from '../../utils/ip';
import { validateUserRule, type UserRuleInput } from './rule-guard';
import { z } from 'zod';

export const userRuleRoutes = new Hono<AppBindings>();

const UserRuleSchema = z.object({
  itemId: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
  targetUserId: z.string().optional(),
  allUsers: z.boolean().optional(),
  permissions: z.array(z.enum(['read', 'download'])).min(1),
});

userRuleRoutes.get('/rules', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const rules = await RuleRepo.listByCreator(db, userId);
  return ok(c, { rules });
});

userRuleRoutes.post('/rules', async (c) => {
  const db = getDb(c);
  const principal = await getPrincipal(c);
  const body = await c.req.json().catch(() => null);
  if (!body) throw ApiError.badRequest('请求体格式错误');
  const parsed = UserRuleSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '规则参数无效');
  const input: UserRuleInput = parsed.data;

  const item = await FileRepo.getFileById(db, input.itemId);
  if (!item) throw new ApiError(404, 'NOT_FOUND', '目标文件不存在');

  // 防线 3 补充：指定目标用户必须存在、可用、且非管理员（管理员不受限，规则无意义）
  if (input.targetUserId) {
    const target = await UserRepo.getUserById(db, input.targetUserId);
    if (!target || target.status !== 'active') throw ApiError.badRequest('目标用户不存在或不可用');
    if (target.role === 'admin') throw ApiError.badRequest('不能以管理员为规则目标');
    if (input.targetUserId === principal.id) throw ApiError.badRequest('不能对自己创建访问规则');
  }

  const result = validateUserRule(input, {
    id: principal.id,
    defaultPath: principal.defaultPath,
    capabilities: principal.capabilities ?? [],
    isAdmin: principal.role === 'admin',
  }, item);
  if (!result.ok) {
    throw new ApiError(result.status, result.code, result.message);
  }

  const rule = await RuleRepo.createRule(db, result.normalized);

  // 防线 7：审计
  await LogRepo.create(db, {
    userId: principal.id,
    action: 'grant',
    path: result.normalized.pathPattern,
    metadata: JSON.stringify({
      ruleId: rule.id,
      effect: rule.effect,
      target: input.allUsers ? 'role:user' : `user:${input.targetUserId}`,
      permissions: rule.permissions,
    }),
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
  });

  return ok(c, { rule }, undefined, 201);
});

userRuleRoutes.delete('/rules/:id', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const rule = await RuleRepo.getRuleById(db, c.req.param('id'));
  if (!rule) throw new ApiError(404, 'NOT_FOUND', '规则不存在');
  // 只能撤销自己创建的 user-origin 规则（admin 规则走管理端）
  if (rule.origin !== 'user' || rule.createdBy !== userId) {
    throw new ApiError(403, 'FORBIDDEN', '无权撤销此规则');
  }
  await RuleRepo.deleteRule(db, rule.id);
  await LogRepo.create(db, {
    userId,
    action: 'revoke',
    path: rule.pathPattern,
    metadata: JSON.stringify({ ruleId: rule.id }),
    ipAddress: requestIp(c.req.raw),
    userAgent: c.req.header('user-agent'),
  });
  return ok(c, null);
});
