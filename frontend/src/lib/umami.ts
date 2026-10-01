// Umami tracker：注入与事件上报
//
// 注入安全（专项）：脚本地址与全部属性来自 /api/public/settings 下发的管理员配置
// （后端已按 utils/umami 口径校验 + 下发前复核），注入一律 document.createElement +
// setAttribute（禁 HTML 字符串拼装），且 data-* 属性按固定白名单逐个挑选——
// 不支持 data-before-send（指向全局函数名）等事件面，配置对象里多出来的键一律忽略。
// SPA pageview 由 tracker 自动监听 History API（pushState/replaceState/popstate）记录，
// 无需手动打点，也避免双重计数。

/** 公开设置（GET /api/public/settings）的 umami 字段形态；null = 不启用 */
export interface UmamiConfig {
  enabled: boolean;
  scriptUrl: string;
  websiteId: string;
  hostUrl?: string;
  domains?: string;
  performance?: boolean;
  excludeSearch?: boolean;
  doNotTrack?: boolean;
}

declare global {
  interface Window {
    umami?: {
      track: (nameOrPayload: string | Record<string, unknown>, data?: Record<string, unknown>) => unknown;
    };
  }
}

/** Umami 事件名上限（官方限制 50 字符；超长会被服务端静默截断，这里先行截断保证可预期） */
export const UMAMI_EVENT_NAME_MAX = 50;

let injected = false;

/** 按公开配置注入 tracker 脚本（幂等：页面生命周期内只注入一次）。未启用/配置不全不注入。 */
export function initUmami(cfg: UmamiConfig | null | undefined): void {
  if (injected || typeof document === 'undefined') return;
  if (!cfg || cfg.enabled !== true || !cfg.scriptUrl || !cfg.websiteId) return;
  const script = document.createElement('script');
  script.defer = true;
  script.src = cfg.scriptUrl;
  // 白名单 data-*（六个）：website-id / host-url / domains / performance / exclude-search / do-not-track
  script.setAttribute('data-website-id', cfg.websiteId);
  if (cfg.hostUrl) script.setAttribute('data-host-url', cfg.hostUrl);
  if (cfg.domains) script.setAttribute('data-domains', cfg.domains);
  if (cfg.performance) script.setAttribute('data-performance', 'true');
  if (cfg.excludeSearch) script.setAttribute('data-exclude-search', 'true');
  if (cfg.doNotTrack) script.setAttribute('data-do-not-track', 'true');
  document.head.appendChild(script);
  injected = true;
}

/**
 * 自定义事件上报（文件下载 / 分享下载 / 复制链接）。tracker 未注入或脚本未就绪时
 * 静默 no-op——统计永远不影响业务动作。事件名按官方上限截断到 50 字符。
 */
export function trackUmami(event: string, data?: Record<string, string | number | boolean>): void {
  if (typeof window === 'undefined') return;
  const umami = window.umami;
  if (!umami || typeof umami.track !== 'function') return;
  const name = event.slice(0, UMAMI_EVENT_NAME_MAX);
  if (!name) return;
  try {
    if (data) umami.track(name, data);
    else umami.track(name);
  } catch {
    // tracker 内部异常与业务无关
  }
}

/** 测试专用：复位注入状态（生产代码不调用） */
export function resetUmamiForTest(): void {
  injected = false;
}
