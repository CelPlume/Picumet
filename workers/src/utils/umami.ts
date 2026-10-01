// Umami 访问统计：配置校验与公开配置装配
//
// 信任边界：脚本地址是全站唯一可配置的脚本执行面——浏览器直接以 <script> 加载，
// 等价于把全站 JS 执行权交给该地址。因此写入口按安全敏感设置对待（仅管理员 +
// 审计日志 + 本文件的写入校验），公开端点下发前再经 resolveUmamiPublicConfig 复核
// （DB 里即便落了脏值也不会被注入）。
// 脚本地址按官方语义即「站点自己的实例」：自托管 https://<instance>/script.js
// （采集端点 <instance>/api/send）、Umami Cloud https://cloud.umami.is/script.js；
// 采集端点可经 hostUrl（data-host-url）覆盖，域名白名单走 domains（data-domains）。
//
// 校验口径：
// - URL：仅 http(s):、无内嵌凭据、无 fragment、长度 ≤500；http 仅回环主机（本地联调）。
//   与 validateEndpoint 不同：脚本由浏览器加载而非 Worker 请求，无 SSRF 面，
//   因此不限端口白名单（本地 umami 常跑 3000 等非标准端口），也不拒私网 https
//   （内网自托管实例是合法形态）。
// - website-id：UUID（自托管与 Umami Cloud 均签发 UUID）。
// - domains：逗号分隔裸 hostname，逐项校验（不含 scheme/路径/端口/凭据；IPv6 用方括号字面量）。
// - 白名单 data-* 属性只有 website-id / host-url / domains / performance /
//   exclude-search / do-not-track 六个；data-before-send（指向全局函数名）不支持。

/** Website ID（data-website-id）：UUID 规范形态 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** http 仅允许的回环主机（本地联调）；URL.hostname 对 IPv6 保留方括号 */
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '[::1]': true };

export const UMAMI_URL_MAX = 500;
export const UMAMI_DOMAINS_MAX = 500;

/** 脚本地址 / 上报地址（data-host-url）校验 */
export function validateUmamiUrl(raw: string): boolean {
  if (!raw || raw.length > UMAMI_URL_MAX) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  if (url.hash) return false;
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS[url.hostname.toLowerCase()]) return false;
  return true;
}

export function isUmamiWebsiteId(raw: string): boolean {
  return UUID_RE.test(raw);
}

/** data-domains 逐项校验：借 URL 解析器拒绝 scheme/路径/端口/凭据（只留裸 hostname） */
export function validateUmamiDomains(raw: string): boolean {
  if (!raw || raw.length > UMAMI_DOMAINS_MAX) return false;
  return raw.split(',').every((item) => {
    const host = item.trim();
    if (!host || host.length > 253) return false;
    let url: URL;
    try {
      url = new URL(`https://${host}/`);
    } catch {
      return false;
    }
    return url.hostname === host.toLowerCase();
  });
}

/** 公开配置（GET /api/public/settings 的 umami 字段）：前端注入器消费的完整形态 */
export interface UmamiPublicConfig {
  enabled: true;
  scriptUrl: string;
  websiteId: string;
  hostUrl?: string;
  domains?: string;
  performance: boolean;
  excludeSearch: boolean;
  doNotTrack: boolean;
}

/**
 * 公开 Umami 配置装配：stats_source='umami' 且 umami_enabled 且脚本地址/Website ID
 * 复核通过才下发，否则 null（前端不注入 = 来源仍是 D1 侧，避免双写双计）。
 * 可选项 hostUrl/domains 脏值只丢弃该项，不破坏主采集路径。
 * 入参为设置原始值（JSON 布尔已还原；缺失/垃圾值一律 fail-safe 判定）。
 */
export function resolveUmamiPublicConfig(s: Record<string, unknown>): UmamiPublicConfig | null {
  if (s['stats_source'] !== 'umami') return null;
  if (s['umami_enabled'] !== true) return null;
  const scriptUrl = typeof s['umami_script_url'] === 'string' ? s['umami_script_url'].trim() : '';
  const websiteId = typeof s['umami_website_id'] === 'string' ? s['umami_website_id'].trim() : '';
  if (!validateUmamiUrl(scriptUrl) || !isUmamiWebsiteId(websiteId)) return null;
  const hostUrl = typeof s['umami_host_url'] === 'string' ? s['umami_host_url'].trim() : '';
  const domains = typeof s['umami_domains'] === 'string' ? s['umami_domains'].trim() : '';
  return {
    enabled: true,
    scriptUrl,
    websiteId: websiteId.toLowerCase(),
    ...(hostUrl && validateUmamiUrl(hostUrl) ? { hostUrl } : {}),
    ...(domains && validateUmamiDomains(domains) ? { domains } : {}),
    performance: s['umami_performance'] === true,
    excludeSearch: s['umami_exclude_search'] === true,
    doNotTrack: s['umami_do_not_track'] === true,
  };
}

/**
 * camelCase（PATCH 请求体 / GET 响应）→ snake_case（system_settings 键）。
 * 同时充当「访问统计面」键集合：保存命中任一键即写审计日志。
 */
export const UMAMI_SETTINGS_MAP = {
  statsSource: 'stats_source',
  umamiEnabled: 'umami_enabled',
  umamiScriptUrl: 'umami_script_url',
  umamiWebsiteId: 'umami_website_id',
  umamiHostUrl: 'umami_host_url',
  umamiDomains: 'umami_domains',
  umamiPerformance: 'umami_performance',
  umamiExcludeSearch: 'umami_exclude_search',
  umamiDoNotTrack: 'umami_do_not_track',
} as const;
