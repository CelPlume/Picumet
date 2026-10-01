// 公开路由：站点设置、公告
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { AnnouncementRepo, SettingsRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { loadRoutePrefixes } from '../storage/direct-links';
import { ok } from '../../shared/response';
import { resolveUmamiPublicConfig } from '../../utils/umami';
import { resolveSsoPublicConfig } from '../sso/config';

export const publicRoutes = new Hono<AppBindings>();

publicRoutes.get('/settings', async (c) => {
  const db = getDb(c);
  const raw = await SettingsRepo.getAll(db);
  const prefixes = await loadRoutePrefixes(db);
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
    siteHeaderTitle: parse('site_header_title'),
    siteLogo: parse('site_logo'),
    siteFavicon: parse('site_favicon'),
    allowGuestAccess: parse('allow_guest_access') ?? false,
    allowRegistration: parse('allow_registration') ?? true,
    requireEmailVerification: parse('require_email_verification') ?? false,
    // 邀请码注册机制：注册页据 enabled/required 决定是否展示邀请码输入与必填语义；
    // generation 供个性化设置页判定邀请码区块可见性（与用户角色组合，非敏感配置）
    inviteEnabled: parse('invite_enabled') ?? false,
    inviteRequired: parse('invite_required') ?? false,
    inviteGeneration: parse('invite_generation') ?? 'all_users',
    // 第三方登录（0012 迁移）：总开关 + 启用的来源（仅 id/kind/name），登录页据此渲染按钮
    sso: await resolveSsoPublicConfig(db),
    // 路由前缀（公开直链命名空间与根路径语义）：前端据此生成直链、决定 '/' 行为
    directPrefix: prefixes.directPrefix,
    rootTarget: prefixes.rootTarget,
    // Umami 访问统计：stats_source='umami' 且启用且脚本地址/Website ID 复核通过才下发
    // （null = 不启用，前端不注入 tracker）；下发前复核 = DB 落脏值也不会被注入
    umami: resolveUmamiPublicConfig({
      stats_source: parse('stats_source'),
      umami_enabled: parse('umami_enabled'),
      umami_script_url: parse('umami_script_url'),
      umami_website_id: parse('umami_website_id'),
      umami_host_url: parse('umami_host_url'),
      umami_domains: parse('umami_domains'),
      umami_performance: parse('umami_performance'),
      umami_exclude_search: parse('umami_exclude_search'),
      umami_do_not_track: parse('umami_do_not_track'),
    }),
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

// 健康检查（就绪探针报告初始化状态，供部署/负载均衡判定；置于公开路由避免认证拦截）
publicRoutes.get('/health/live', (c) => c.json({ service: 'picumet-api', status: 'ok' }));
publicRoutes.get('/health/ready', async (c) => {
  const env = c.env;
  let ready = false;
  let detail = 'unknown';
  try {
    const marker = await env.KV.get('seed:done');
    ready = marker === '1';
    // detail 只回枚举值，不回传 KV 异常文本（生产信息泄露面）
    detail = ready ? 'seeded' : 'not-seeded';
  } catch {
    detail = 'kv-unavailable';
  }
  return c.json({ service: 'picumet-api', status: ready ? 'ok' : 'degraded', ready, detail }, ready ? 200 : 503);
});
