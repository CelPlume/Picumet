// CORS 来源白名单：通配匹配语义 + 设置消费 + 管理端保存立即生效
// （此前 allowed_origins 设置只存不用：中间件只读环境变量；且不支持通配符）
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, registerAndLogin, getCsrf, json, type TestContext } from './helpers';
import { originMatches, parseOriginList, invalidateCorsCache } from '../src/utils/cors';
import { invalidateSettingsCache } from '../src/db/repos/system';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);
});

describe('originMatches 通配语义', () => {
  it('精确条目：scheme + host 全等，端口严格', () => {
    expect(originMatches('https://picumet.pages.dev', 'https://picumet.pages.dev')).toBe(true);
    expect(originMatches('http://picumet.pages.dev', 'https://picumet.pages.dev')).toBe(false);
    expect(originMatches('https://picumet.pages.dev:8443', 'https://picumet.pages.dev')).toBe(false);
    expect(originMatches('https://picumet.pages.dev:8443', 'https://picumet.pages.dev:8443')).toBe(true);
  });

  it('通配条目：任意层级子域 + 裸域；scheme 与端口受控', () => {
    expect(originMatches('https://a.cnies.org', 'https://*.cnies.org')).toBe(true);
    expect(originMatches('https://a.b.cnies.org', 'https://*.cnies.org')).toBe(true);
    expect(originMatches('https://cnies.org', 'https://*.cnies.org')).toBe(true);
    expect(originMatches('https://evil-cnies.org', 'https://*.cnies.org')).toBe(false);
    expect(originMatches('https://a.cnies.org.evil.com', 'https://*.cnies.org')).toBe(false);
    expect(originMatches('http://a.cnies.org', 'https://*.cnies.org')).toBe(false);
    expect(originMatches('https://a.cnies.org:8443', 'https://*.cnies.org')).toBe(false);
  });

  it('条目缺省 scheme 按 https；非法条目恒不匹配', () => {
    expect(originMatches('https://a.example.com', '*.example.com')).toBe(true);
    expect(originMatches('https://a.example.com', 'not a url')).toBe(false);
    expect(originMatches('https://a.example.com', 'https://a*b.com')).toBe(false);
  });

  it('parseOriginList：逗号与换行混排、去空去重', () => {
    expect(parseOriginList('a.com, b.com\nb.com\nc.com')).toEqual(['a.com', 'b.com', 'c.com']);
  });
});

describe('CORS 中间件消费设置白名单', () => {
  it('通配来源的预检获得 ACAO；未列入来源仅 204 无头', async () => {
    ctx.db.exec(`INSERT INTO system_settings (key, value, description, updated_at) VALUES ('allowed_origins', 'https://*.example.com,https://picumet.pages.dev', 'cors', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  invalidateSettingsCache();
    invalidateCorsCache();

    const preflight = await ctx.app.fetch(new Request('http://localhost:8787/api/auth/csrf-token', {
      method: 'OPTIONS',
      headers: { origin: 'https://api.example.com', 'access-control-request-method': 'GET' },
    }), ctx.env, {} as ExecutionContext);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://api.example.com');
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');

    // 直传客户端的签名头（cache-control / content-disposition）原样回显
    const presign = await ctx.app.fetch(new Request('http://localhost:8787/api/auth/csrf-token', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://api.example.com',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'cache-control, content-disposition, content-type',
      },
    }), ctx.env, {} as ExecutionContext);
    expect(presign.status).toBe(204);
    expect(presign.headers.get('access-control-allow-headers')).toBe('cache-control, content-disposition, content-type');

    // 根路径 SigV4 判别不得劫持预检：URL 带 X-Amz-Signature 的 OPTIONS 也由 corsHeaders 作答
    const presignPreflight = await ctx.app.fetch(new Request('http://localhost:8787/public/uploads/x.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&x-id=PutObject', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://api.example.com',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'cache-control, content-disposition, content-type',
      },
    }), ctx.env, {} as ExecutionContext);
    expect(presignPreflight.status).toBe(204);
    expect(presignPreflight.headers.get('access-control-allow-origin')).toBe('https://api.example.com');
    expect(presignPreflight.headers.get('access-control-allow-headers')).toBe('cache-control, content-disposition, content-type');

    // 实际响应（此处为无签名 PUT → 403 XML）也必须合并 CORS 头
    const actual = await ctx.app.fetch(new Request('http://localhost:8787/public/uploads/x.png?X-Amz-Signature=abc&x-id=PutObject', {
      method: 'PUT',
      headers: { origin: 'https://api.example.com', 'x-amz-date': '20261012T000000Z', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      body: 'x',
    }), ctx.env, {} as ExecutionContext);
    expect(actual.status).toBe(403);
    expect(actual.headers.get('access-control-allow-origin')).toBe('https://api.example.com');

    const stranger = await ctx.app.fetch(new Request('http://localhost:8787/api/auth/csrf-token', {
      method: 'OPTIONS',
      headers: { origin: 'https://stranger.org', 'access-control-request-method': 'GET' },
    }), ctx.env, {} as ExecutionContext);
    expect(stranger.status).toBe(204);
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('管理端保存 allowed_origins 后立即生效（缓存失效 + 审计）', async () => {
    invalidateCorsCache();
    const { authCookie } = await registerAndLogin(ctx, 'corsadmin');
    await ctx.db.exec(`UPDATE users SET role = 'admin' WHERE username = 'corsadmin'`);
    const login = await request(ctx, '/api/auth/login', { method: 'POST', body: { username: 'corsadmin', password: 'password123' } });
    const cookie = `auth_token=${(login.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[1] ?? ''}`;
    const csrf = await getCsrf(ctx, cookie);

    // 先隔离到不含目标来源的白名单并热缓存，保存新值后同 isolate 立即可见
    ctx.db.exec(`INSERT INTO system_settings (key, value, description, updated_at) VALUES ('allowed_origins', 'https://other.org', 'cors', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  invalidateSettingsCache();
    invalidateCorsCache();
    const before = await ctx.app.fetch(new Request('http://localhost:8787/api/auth/csrf-token', {
      method: 'OPTIONS', headers: { origin: 'https://fresh.example.com', 'access-control-request-method': 'GET' },
    }), ctx.env, {} as ExecutionContext);
    expect(before.headers.get('access-control-allow-origin')).toBeNull();

    const save = await request(ctx, '/api/admin/settings', {
      method: 'PATCH',
      cookie,
      headers: { 'X-CSRF-Token': csrf },
      body: { allowedOrigins: 'https://fresh.example.com' },
    });
    expect(save.status).toBe(200);
    const saved = await json(save) as { data: { savedKeys: string[] } };
    expect(saved.data.savedKeys).toContain('allowed_origins');

    const after = await ctx.app.fetch(new Request('http://localhost:8787/api/auth/csrf-token', {
      method: 'OPTIONS', headers: { origin: 'https://fresh.example.com', 'access-control-request-method': 'GET' },
    }), ctx.env, {} as ExecutionContext);
    expect(after.headers.get('access-control-allow-origin')).toBe('https://fresh.example.com');

    // 安全敏感设置：审计落 settings_update（记键不记值）
    const audit = ctx.db.prepare(
      `SELECT metadata FROM access_logs WHERE action = 'settings_update' ORDER BY created_at DESC LIMIT 1`
    ).get() as { metadata: string };
    expect(JSON.parse(audit.metadata).keys).toContain('allowed_origins');
  });
});
