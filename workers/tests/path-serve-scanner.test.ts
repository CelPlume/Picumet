// path-serve 扫描器噪声过滤：`.env*` / `.git/*` / `*.bak` 等必须在**任何 D1 查询之前**被拒。
//
// 回归背景：公网扫描器持续探测 `/.env`、`/.git/config`、`/config.php.bak`、`/.aws/credentials`。
// path-serve 是 catch-all，这些请求原本全部落进 3 次 D1 查询后才 404，扫描量级下把正常直链
// 的 D1 配额与延迟一起拖慢（表现为偶发 ERR_TIMED_OUT）。
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, request, initSeeded, type TestContext } from './helpers';
import { Db } from '../src/db';

function dbi(ctx: TestContext): Db {
  return Db.fromAny(ctx.env.DB as D1Database);
}

describe('path-serve 扫描器噪声过滤', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
    await initSeeded(ctx);
  });

  it.each([
    '/.env',
    '/.env.local',
    '/.env.production',
    '/.git/config',
    '/.git/index',
    '/.git/HEAD',
    '/.aws/credentials',
    '/.ssh/id_rsa',
    '/config.php.bak',
    '/database.sqlite',
    '/server.pem',
    '/web.config.bak',
    '/wp-config.php',
    '/.htaccess',
    '/composer.lock.bak',
    '/app/settings.yml',
  ])('扫描器路径 %s 返回 404', async (path) => {
    const res = await request(ctx, path);
    expect(res.status).toBe(404);
  });

  it('噪声路径在查库前就被拒：不落「未挂载」日志、不写库', async () => {
    const before = await dbi(ctx).first(`SELECT COUNT(*) AS c FROM access_logs`);
    const beforeCount = Number(before?.c ?? 0);
    await request(ctx, '/.env');
    await request(ctx, '/.git/config');
    const after = await dbi(ctx).first(`SELECT COUNT(*) AS c FROM access_logs`);
    expect(Number(after?.c ?? 0)).toBe(beforeCount);
  });

  it('正常文件路径仍可直服（未被误伤）', async () => {
    const row = await dbi(ctx).first(`SELECT path, name FROM file_metadata WHERE type='file' LIMIT 1`);
    if (!row) return; // 无文件数据时跳过断言
    const dir = String(row.path);
    const name = String(row.name);
    const res = await request(ctx, `${dir === '/' ? '' : dir}/${name}`);
    // 匿名直链在未开放游客访问时可能是 401/403，只要不是 404-not-found 式的路由未命中即可
    expect([200, 401, 403]).toContain(res.status);
  });

  it('正常文件夹名（含点）不被误伤', async () => {
    const res = await request(ctx, '/my.folder.name/x.png');
    // 未挂载路径返回 404，但走的是「路径不存在或未挂载」而非扫描器拦截
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('NOT_FOUND');
  });
});