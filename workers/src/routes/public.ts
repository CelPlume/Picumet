// 公开路由：站点设置、公告
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { AnnouncementRepo, SettingsRepo } from '../db';
import { getDb } from '../middleware/auth';
import { ok } from '../utils/response';

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
