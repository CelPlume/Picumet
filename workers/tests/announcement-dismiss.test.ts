// 公告撤回持久化接入：GET /users/announcements/dismissed-ids 与 POST /users/announcements/:id/dismiss。
// 公告经 SQL 直插（管理端创建流程另有覆盖），验证撤回落库、404 与幂等语义。
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

interface ApiErrorBody {
  error: { code: string; message: string };
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

/** 直插一条生效公告（只需必填列，其余走表默认值） */
function insertAnnouncement(id: string): void {
  ctx.db
    .prepare(
      `INSERT INTO announcements (id, title, content, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    )
    .run(id, `公告 ${id}`, '测试公告内容', Date.now(), Date.now());
}

async function dismissedIds(cookie: string): Promise<Response> {
  return request(ctx, '/api/users/announcements/dismissed-ids', { cookie });
}

async function dismiss(cookie: string, id: string, body?: Record<string, unknown>): Promise<Response> {
  return request(ctx, `/api/users/announcements/${id}/dismiss`, {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': await getCsrf(ctx, cookie) },
    ...(body === undefined ? {} : { body }),
  });
}

describe('公告撤回持久化', () => {
  it('dismiss 后 dismissed-ids 含该公告 id', async () => {
    insertAnnouncement('ann-a');
    insertAnnouncement('ann-b');
    const { authCookie } = await registerAndLogin(ctx, 'ann_user');

    const res = await dismiss(authCookie, 'ann-a', { forever: true });
    expect(res.status).toBe(200);

    const data = await json<{ data: { ids: string[] } }>(await dismissedIds(authCookie));
    expect(data.data.ids).toContain('ann-a');
    expect(data.data.ids).not.toContain('ann-b');
  });

  it('不带 body 的 dismiss 亦可（forever 缺省 true）', async () => {
    insertAnnouncement('ann-nobody');
    const { authCookie } = await registerAndLogin(ctx, 'ann_nobody');

    const res = await dismiss(authCookie, 'ann-nobody');
    expect(res.status).toBe(200);
    expect((await json<{ data: null }>(res)).data).toBeNull();

    const data = await json<{ data: { ids: string[] } }>(await dismissedIds(authCookie));
    expect(data.data.ids).toEqual(['ann-nobody']);
  });

  it('不存在的公告 id → 404 NOT_FOUND 且不落撤回记录', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'ann_404');

    const res = await dismiss(authCookie, 'ann-missing', { forever: true });
    expect(res.status).toBe(404);
    const err = await json<ApiErrorBody>(res);
    expect(err.error.code).toBe('NOT_FOUND');
    expect(err.error.message).toBe('公告不存在');

    const data = await json<{ data: { ids: string[] } }>(await dismissedIds(authCookie));
    expect(data.data.ids).toEqual([]);
  });

  it('重复 dismiss 幂等：不报错且 ids 不重复', async () => {
    insertAnnouncement('ann-dup');
    const { authCookie } = await registerAndLogin(ctx, 'ann_dup');

    const first = await dismiss(authCookie, 'ann-dup', { forever: true });
    const second = await dismiss(authCookie, 'ann-dup', { forever: true });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const data = await json<{ data: { ids: string[] } }>(await dismissedIds(authCookie));
    expect(data.data.ids).toEqual(['ann-dup']);
  });
});
