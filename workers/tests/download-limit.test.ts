// 下载限速：system_settings.rate_limit_downloads_per_minute 单独限制下载类请求（默认 120，0 = 不限）
//
// 生产环境才生效；测试直接写设置与 KV 计数，覆盖：放行、超限 429、0 表示不限、
// 非下载路径不受影响、开发环境跳过。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let authCookie = '';
let userId = '';

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
  const account = await registerAndLogin(ctx, 'dl_user');
  authCookie = account.authCookie;
  userId = account.userId;
  (ctx.env as unknown as { ENVIRONMENT: string }).ENVIRONMENT = 'production';
  // 关掉全局限流，避免同一分钟窗口内的 IP 计数干扰本文件的断言（下载限速独立读自己的设置）
  ctx.db
    .prepare(`INSERT INTO system_settings (key, value, updated_at) VALUES ('rate_limit_enabled', '"false"', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(Date.now());
});

beforeEach(() => {
  ctx.db.prepare(`DELETE FROM transfer_slots`).run();
});

function setLimit(value: number): void {
  ctx.db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('rate_limit_downloads_per_minute', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(String(value), Date.now());
}

/** 预置当前分钟窗口内的下载计数 */
async function seedDownloads(count: number): Promise<void> {
  const windowStart = Date.now() - (Date.now() % 60_000);
  await ctx.kv.put(`dl:user:${userId}:${windowStart}`, String(count));
}

async function downloadLink(): Promise<Response> {
  const csrf = await getCsrf(ctx, authCookie);
  return request(ctx, '/api/files/missing-file/download', {
    method: 'GET',
    cookie: authCookie,
    headers: { 'X-CSRF-Token': csrf },
  });
}

describe('下载限速', () => {
  it('未达上限：下载请求正常进入业务逻辑（此处为 404，非 429）', async () => {
    setLimit(3);
    await seedDownloads(1);
    const res = await downloadLink();
    expect(res.status).not.toBe(429);
  });

  it('达到上限：返回 429 RATE_LIMIT_EXCEEDED', async () => {
    setLimit(2);
    await seedDownloads(2);
    const res = await downloadLink();
    expect(res.status).toBe(429);
    expect(((await json(res)) as { error: { code: string } }).error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('上限为 0 表示不限：即使已有计数也放行', async () => {
    setLimit(0);
    await seedDownloads(999);
    const res = await downloadLink();
    expect(res.status).not.toBe(429);
  });

  it('非下载路径不受下载限速影响', async () => {
    setLimit(1);
    await seedDownloads(50);
    const res = await request(ctx, '/api/files?path=/', { cookie: authCookie });
    expect(res.status).toBe(200);
  });

  it('开发环境跳过下载限速', async () => {
    const env = ctx.env as unknown as { ENVIRONMENT: string };
    env.ENVIRONMENT = 'development';
    try {
      setLimit(1);
      await seedDownloads(50);
      const res = await downloadLink();
      expect(res.status).not.toBe(429);
    } finally {
      env.ENVIRONMENT = 'production';
    }
  });

  it('下载请求成功后计数递增（固定窗口）', async () => {
    setLimit(5);
    ctx.db.prepare(`DELETE FROM system_settings WHERE key = 'rate_limit_downloads_per_minute'`).run();
    await downloadLink();
    const windowStart = Date.now() - (Date.now() % 60_000);
    const counted = await ctx.kv.get(`dl:user:${userId}:${windowStart}`);
    expect(Number(counted ?? '0')).toBeGreaterThanOrEqual(1);
  });
});
