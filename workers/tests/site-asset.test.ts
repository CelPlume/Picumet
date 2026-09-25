// 站点标识资源中转（services/public/site-asset.ts）：防开放代理守卫
// - 只中转 system_settings 里「当前配置」的 site_logo / site_favicon，其余 404
// - validateEndpoint 拦截私网/保留地址（管理员误配内网地址时不放行）
// 快乐路径（真实抓取 + 边缘缓存）依赖外部网络，由浏览器端到端验证覆盖，这里不测。
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, initSeeded, request, json, type TestContext } from './helpers';

let ctx: TestContext;

beforeEach(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

const seedSettings = (logo: string, favicon: string): void => {
  for (const [key, value] of [
    ['site_logo', JSON.stringify(logo)],
    ['site_favicon', JSON.stringify(favicon)],
  ] as const) {
    ctx.db
      .prepare(`INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value, Date.now());
  }
};

describe('GET /api/public/site-asset/:kind', () => {
  it('未配置时一律 404，不触发抓取', async () => {
    const res = await request(ctx, `/api/public/site-asset/logo?u=${encodeURIComponent('https://example.com/logo.png')}`);
    expect(res.status).toBe(404);
    const data = await json<{ error: { code: string } }>(res);
    expect(data.error.code).toBe('NOT_FOUND');
  });

  it('配置地址与 u 不一致时 404（防开放代理）', async () => {
    seedSettings('https://example.com/logo.png', 'https://example.com/favicon.png');
    const res = await request(ctx, `/api/public/site-asset/logo?u=${encodeURIComponent('https://evil.example/steal')}`);
    expect(res.status).toBe(404);
  });

  it('非法 kind 404', async () => {
    seedSettings('https://example.com/logo.png', 'https://example.com/favicon.png');
    const res = await request(ctx, `/api/public/site-asset/other?u=${encodeURIComponent('https://example.com/logo.png')}`);
    expect(res.status).toBe(404);
  });

  it('配置的是内网地址时 404（SSRF 拦截，即使与 u 一致）', async () => {
    seedSettings('http://127.0.0.1:9000/private.png', 'https://example.com/favicon.png');
    const res = await request(ctx, `/api/public/site-asset/logo?u=${encodeURIComponent('http://127.0.0.1:9000/private.png')}`);
    expect(res.status).toBe(404);
  });

  it('非 80/443 端口的公网地址同样 404', async () => {
    seedSettings('https://example.com:8443/logo.png', 'https://example.com/favicon.png');
    const res = await request(ctx, `/api/public/site-asset/logo?u=${encodeURIComponent('https://example.com:8443/logo.png')}`);
    expect(res.status).toBe(404);
  });
});
