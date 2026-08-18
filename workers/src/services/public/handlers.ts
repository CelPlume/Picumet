// 公开路由：站点设置、公告
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { AnnouncementRepo, SettingsRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { ok } from '../../shared/response';

export const publicRoutes = new Hono<AppBindings>();

publicRoutes.get('/settings', async (c) => {
  const db = getDb(c);
  const raw = await SettingsRepo.getAll(db);
  const parse = (key: string) => {
    const v = raw[key];
    if (v === undefined || v === 'null') return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  return ok(c, {
    siteTitle: parse('site_title') ?? 'Picumet',
    siteLogo: parse('site_logo'),
    siteFavicon: parse('site_favicon'),
    allowGuestAccess: parse('allow_guest_access') ?? false,
    allowRegistration: parse('allow_registration') ?? true,
    requireEmailVerification: parse('require_email_verification') ?? false,
  });
});

publicRoutes.get('/announcements', async (c) => {
  const db = getDb(c);
  const items = await AnnouncementRepo.listActive(db);
  return ok(c, { items });
});

publicRoutes.get('/health', (c) => {
  return c.json({ status: 'ok', time: Date.now() });
});

// 健康检查（M-06：就绪探针报告初始化状态，供部署/负载均衡判定；置于公开路由避免认证拦截）
publicRoutes.get('/health/live', (c) => c.json({ service: 'picumet-api', status: 'ok' }));
publicRoutes.get('/health/ready', async (c) => {
  const env = c.env;
  let ready = false;
  let detail = 'unknown';
  try {
    const marker = await env.KV.get('seed:done');
    ready = marker === '1';
    detail = ready ? 'seeded' : 'not-seeded';
  } catch (err) {
    detail = err instanceof Error ? err.message : 'kv-unavailable';
  }
  return c.json({ service: 'picumet-api', status: ready ? 'ok' : 'degraded', ready, detail }, ready ? 200 : 503);
});
