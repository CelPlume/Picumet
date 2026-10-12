// 邀请码路由：批量生成 + 我的邀请码与受邀记录
// 挂载于 protectedApi（authMiddleware + csrf + 限流），见 workers/src/index.ts。
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { InviteRepo, type InviteCode } from '../../db';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';
import { ApiError } from '../../shared/errors';
import { uuid } from '../../utils/crypto';
import { CreateInvitesSchema } from './schemas';
import { canGenerateInvites, generateInviteCode, loadInviteSettings } from './invites';
import type { InviteCodeView, InviteCodeWithInvited, InvitedUserView } from './types';

export const inviteRoutes = new Hono<AppBindings>();

/** 唯一约束碰撞重试上限：36^6 ≈ 2.2e9 码空间，碰撞概率可忽略，重试只是兜底 */
const COLLISION_RETRIES = 5;

// ============ 生成邀请码（批量） ============
inviteRoutes.post('/', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const settings = await loadInviteSettings(db);
  if (!canGenerateInvites(settings, c.get('userRole'))) {
    throw new ApiError(403, 'FORBIDDEN', '当前设置下无权生成邀请码');
  }
  const body = await c.req.json().catch(() => null);
  const parsed = CreateInvitesSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '邀请码参数无效');
  const count = parsed.data.count ?? 1;
  const trimmed = parsed.data.name?.trim();
  const name = trimmed ? trimmed : null;
  const createdAt = Date.now();

  // 数量上限与插入收敛在单条条件 INSERT：D1 事务（batch 收集器）不支持事务内读，
  // 原「事务内计数 + 逐条插入」生产必 500；上限校验由语句内 WHERE 子查询原子生效
  //（D1 单写者串行，天然 TOCTOU 安全）。不足全部拒绝，不做部分创建。
  for (let attempt = 0; attempt <= COLLISION_RETRIES; attempt++) {
    const batch: Array<InviteCode> = [];
    for (let i = 0; i < count; i++) {
      batch.push({ id: uuid(), code: generateInviteCode(), name, createdBy: userId, createdAt });
    }
    try {
      const changes = await InviteRepo.createBatch(db, batch, settings.maxPerUser);
      if (changes === 0) {
        // 条件 INSERT 的 WHERE 未命中 = 累计上限命中（meta.changes 为 0）
        throw new ApiError(403, 'INVITE_LIMIT', `邀请码累计数量不能超过 ${settings.maxPerUser} 个`);
      }
      const created: InviteCodeView[] = batch.map((inv) => ({ id: inv.id, code: inv.code, name: inv.name, createdAt: inv.createdAt }));
      return ok(c, { codes: created }, undefined, 201);
    } catch (err) {
      // 仅码值唯一约束碰撞可重试（整批换新码）；上限 403 与其余错误直接上抛
      if (err instanceof ApiError) throw err;
      if (!/unique constraint/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
  throw ApiError.internal('邀请码生成失败：唯一码碰撞超过重试上限');
});

// ============ 我的邀请码与受邀记录 ============
inviteRoutes.get('/', async (c) => {
  const db = getDb(c);
  const userId = c.get('userId');
  const settings = await loadInviteSettings(db);
  if (!canGenerateInvites(settings, c.get('userRole'))) {
    throw new ApiError(403, 'FORBIDDEN', '当前设置下无权生成邀请码');
  }
  const codes = await InviteRepo.listByUser(db, userId);
  const invited = await InviteRepo.listInvitedUsers(db, codes.map((ic) => ic.id));
  const byCodeId = new Map<string, InvitedUserView[]>();
  for (const row of invited) {
    const list = byCodeId.get(row.codeId);
    const view: InvitedUserView = { username: row.username, code: row.code, registeredAt: row.registeredAt };
    if (list) list.push(view);
    else byCodeId.set(row.codeId, [view]);
  }
  const items: InviteCodeWithInvited[] = codes.map((ic) => ({
    id: ic.id,
    code: ic.code,
    name: ic.name,
    createdAt: ic.createdAt,
    invitedUsers: byCodeId.get(ic.id) ?? [],
  }));
  return ok(c, { codes: items, max: settings.maxPerUser });
});
