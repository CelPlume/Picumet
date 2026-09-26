// 站点标识资源中转：GET /api/public/site-asset/:kind?u=<配置地址>（kind = logo | favicon）
// 动机：管理员常把 Logo/Favicon 指到外部图床；这类地址往往不可缓存（302 到带临时 token 的
// 地址、终态只有 cache-control: private 且无 max-age），浏览器每次刷新都要重新下载整张图
// （实测示例 818 KB）。经 Worker 中转 + 边缘缓存后，我们的响应带 public max-age，
// 浏览器直接命中本地缓存，刷新不再触网。
// 防开放代理：只中转 system_settings 里「当前配置」的那两个地址，其余一律 404；
// 再过 validateEndpoint 拒绝私网/保留地址（管理员误配内网地址时不放行）。
// SEC-07：重定向不交给 fetch 自动跟随，逐跳重新过 validateEndpoint（见下方手动循环）。
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { SettingsRepo } from '../../db';
import { getDb } from '../../middleware/auth';
import { validateEndpoint } from '../../utils/ssrf';

/** 单个资源上限：站点 Logo/Favicon 正常几十 KB，超限视为配错（避免拖垮 Worker 内存） */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
/** 浏览器缓存时长：缓存键含完整 URL，管理员改地址即换键，无需短 TTL */
const BROWSER_TTL = 604800;

const KIND_SETTINGS = {
  logo: 'site_logo',
  favicon: 'site_favicon',
} as const;

export const siteAssetRoutes = new Hono<AppBindings>();

siteAssetRoutes.get('/site-asset/:kind', async (c) => {
  const kind = c.req.param('kind');
  const settingKey = kind in KIND_SETTINGS ? KIND_SETTINGS[kind as keyof typeof KIND_SETTINGS] : undefined;
  if (!settingKey) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404);
  }

  const target = c.req.query('u') ?? '';
  const raw = await SettingsRepo.getAll(getDb(c));
  // 设置值按 JSON 字符串存储（与 /api/public/settings 的 parse 约定一致）
  let configured: string | undefined;
  try {
    configured = raw[settingKey] === undefined ? undefined : (JSON.parse(raw[settingKey]) as string);
  } catch {
    configured = raw[settingKey];
  }
  if (!target || !configured || configured !== target || !validateEndpoint(target)) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404);
  }

  const cacheKey = new Request(c.req.url);
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;

  // SEC-07：重定向目标可能是攻击者控制的 302 → 私网/云元数据地址，交给 fetch 自动跟随等于绕过校验；
  // 必须手动逐跳：redirect: 'manual'，每一跳重新过 validateEndpoint（失败走上方 NOT_FOUND 分支），
  // location 缺失或超过 3 跳视为异常上游（502）。
  const REDIRECT_LIMIT = 3;
  // 301/302/303/307/308 = 会改写请求目标的重定向；其余状态（含 300/304）按终态响应处理
  const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];
  let current = target;
  let upstream: Response | null = null;
  for (let hop = 0; hop < REDIRECT_LIMIT; hop++) {
    if (!validateEndpoint(current)) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404);
    }
    const res = await fetch(current, { redirect: 'manual' });
    if (!REDIRECT_STATUSES.includes(res.status)) {
      upstream = res;
      break;
    }
    const location = res.headers.get('location');
    if (!location) {
      return c.json({ success: false, error: { code: 'UPSTREAM_ERROR', message: '资源获取失败' } }, 502);
    }
    try {
      current = new URL(location, current).toString();
    } catch {
      return c.json({ success: false, error: { code: 'UPSTREAM_ERROR', message: '资源获取失败' } }, 502);
    }
  }
  if (!upstream) {
    return c.json({ success: false, error: { code: 'UPSTREAM_ERROR', message: '资源获取失败' } }, 502);
  }
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !contentType.startsWith('image/')) {
    return c.json({ success: false, error: { code: 'UPSTREAM_ERROR', message: '资源获取失败' } }, 502);
  }
  const declared = Number(upstream.headers.get('content-length') ?? 0);
  const body = await upstream.arrayBuffer();
  if (declared > MAX_ASSET_BYTES || body.byteLength > MAX_ASSET_BYTES) {
    return c.json({ success: false, error: { code: 'ASSET_TOO_LARGE', message: '资源过大' } }, 413);
  }

  const etag = upstream.headers.get('etag');
  const res = new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${BROWSER_TTL}`,
      ...(etag ? { ETag: etag } : {}),
    },
  });
  await caches.default.put(cacheKey, res.clone());
  return res;
});
