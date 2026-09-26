// 站点标识资源中转（services/public/site-asset.ts）：防开放代理守卫
// - 只中转 system_settings 里「当前配置」的 site_logo / site_favicon，其余 404
// - validateEndpoint 拦截私网/保留地址（管理员误配内网地址时不放行）
// - 重定向逐跳校验：302 到私网不二次出网、公网跟随后正常返回、超过 3 跳 502；
//   跳转用例 stub 全局 fetch 与 caches，不触外网（真实抓取 + 边缘缓存仍由浏览器端到端验证覆盖）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('重定向逐跳校验', () => {
  // 缓存命中判断在 fetch 之前执行，所有跳转用例都需替换 caches；测后还原避免污染其他用例
  beforeEach(() => {
    const entries = new Map<string, Response>();
    vi.stubGlobal('caches', {
      default: {
        match: async (key: Request) => entries.get(key.url),
        put: async (key: Request, value: Response) => {
          entries.set(key.url, value);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 重定向响应（location 由攻击者/上游控制） */
  const redirectResponse = (location: string): Response => new Response(null, { status: 302, headers: { location } });

  it('上游 302 到私网地址 → 404，且不向私网发起实际请求', async () => {
    seedSettings('https://img.example.com/logo.png', 'https://example.com/favicon.png');
    const fetchMock = vi.fn(async (_input: unknown) => redirectResponse('http://169.254.169.254/latest/meta-data/'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(ctx, `/api/public/site-asset/logo?u=${encodeURIComponent('https://img.example.com/logo.png')}`);
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('NOT_FOUND');
    // 只有第一跳出网：私网目标被逐跳 validateEndpoint 拦截，绝不发起第二次 fetch
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(['https://img.example.com/logo.png']);
  });

  it('上游 302 到公网地址 → 跟随后正常返回图片', async () => {
    seedSettings('https://img.example.com/logo.png', 'https://example.com/favicon.png');
    const png = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://img.example.com/logo.png') return redirectResponse('https://cdn.example.com/real-logo.png');
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(ctx, `/api/public/site-asset/logo?u=${encodeURIComponent('https://img.example.com/logo.png')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://img.example.com/logo.png',
      'https://cdn.example.com/real-logo.png',
    ]);
  });

  it('3 跳以上重定向 → 502（最多出网 3 次）', async () => {
    seedSettings('https://img.example.com/logo.png', 'https://example.com/favicon.png');
    let seq = 0;
    const fetchMock = vi.fn(async () => redirectResponse(`https://hop${++seq}.example.com/next`));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(ctx, `/api/public/site-asset/logo?u=${encodeURIComponent('https://img.example.com/logo.png')}`);
    expect(res.status).toBe(502);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('UPSTREAM_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('重定向缺失 location → 502', async () => {
    seedSettings('https://img.example.com/logo.png', 'https://example.com/favicon.png');
    const fetchMock = vi.fn(async () => new Response(null, { status: 302 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(ctx, `/api/public/site-asset/logo?u=${encodeURIComponent('https://img.example.com/logo.png')}`);
    expect(res.status).toBe(502);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('UPSTREAM_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
