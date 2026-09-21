// 传输并发限制：同一主体（用户/IP）在途传输数上限（system_settings.max_concurrent_transfers）
//
// 生产环境才生效，因此测试里把 ENVIRONMENT 切成 production（认证限流也会生效，所以用户只注册一次）。
// 槽位状态直接读写 transfer_slots，避免依赖真实并发（同进程内顺序请求会立即释放槽位）。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let authCookie = '';
let userId = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  const account = await registerAndLogin(ctx, 'cc_user');
  authCookie = account.authCookie;
  userId = account.userId;
  (ctx.env as unknown as { ENVIRONMENT: string }).ENVIRONMENT = 'production';
});

beforeEach(() => {
  ctx.db.prepare(`DELETE FROM transfer_slots`).run();
});

function setLimit(value: number): void {
  ctx.db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('max_concurrent_transfers', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(String(value), Date.now());
}

function slotCount(): number {
  const row = ctx.db.prepare(`SELECT COUNT(*) AS c FROM transfer_slots WHERE scope = 'user' AND scope_id = ?`).get(userId) as
    | { c?: number }
    | undefined;
  return Number(row?.c ?? 0);
}

function seedSlots(count: number, createdAt = Date.now()): void {
  for (let i = 0; i < count; i++) {
    ctx.db
      .prepare(`INSERT INTO transfer_slots (token, scope, scope_id, created_at) VALUES (?, 'user', ?, ?)`)
      .run(`seed-${Date.now()}-${i}`, userId, createdAt);
  }
}

async function initUpload(): Promise<Response> {
  const csrf = await getCsrf(ctx, authCookie);
  return request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: '/', fileName: `concurrency-${Date.now()}.txt`, fileSize: 5, mimeType: 'text/plain' },
  });
}

describe('传输并发限制', () => {
  it('达到上限时拒绝新的传输请求（429 CONCURRENCY_LIMIT_EXCEEDED），且不泄漏槽位', async () => {
    setLimit(2);
    seedSlots(2);
    expect(slotCount()).toBe(2);

    const res = await initUpload();
    expect(res.status).toBe(429);
    expect(((await json(res)) as { error: { code: string } }).error.code).toBe('CONCURRENCY_LIMIT_EXCEEDED');
    expect(slotCount()).toBe(2);
  });

  it('未达上限的传输请求正常通过，并在结束后释放槽位', async () => {
    setLimit(2);
    seedSlots(1);

    const res = await initUpload();
    expect(res.status).toBe(200);
    expect(slotCount()).toBe(1);
  });

  it('上限设为 0 表示不限：即使已有槽位也放行且不占用槽位', async () => {
    setLimit(0);
    seedSlots(5);

    const res = await initUpload();
    expect(res.status).toBe(200);
    expect(slotCount()).toBe(5);
  });

  it('泄漏槽位超过 30 分钟不计入并发，且成功请求会正常占用并释放', async () => {
    setLimit(1);
    seedSlots(3, Date.now() - 31 * 60_000);
    expect(slotCount()).toBe(3);

    const res = await initUpload();
    expect(res.status).toBe(200);
    expect(slotCount()).toBe(3);
  });

  it('非传输接口不受并发限制影响', async () => {
    setLimit(1);
    seedSlots(3);

    const res = await request(ctx, '/api/files?path=/', { cookie: authCookie });
    expect(res.status).toBe(200);
    expect(slotCount()).toBe(3);
  });

  it('开发环境跳过并发限制', async () => {
    const env = ctx.env as unknown as { ENVIRONMENT: string };
    env.ENVIRONMENT = 'development';
    try {
      setLimit(1);
      seedSlots(3);
      const res = await initUpload();
      expect(res.status).toBe(200);
      expect(slotCount()).toBe(3);
    } finally {
      env.ENVIRONMENT = 'production';
    }
  });
});
