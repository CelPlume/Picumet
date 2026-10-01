// 站点公开设置（站点标题 / Logo / Favicon）——从 /api/public/settings 读取并应用到文档。
// 设置本身存一份 localStorage：首帧就能套用标题与图标，不必等接口回来。
// Logo/Favicon 的外部地址经自家 Worker 中转（/api/public/site-asset/:kind，带长缓存头）：
// 外部图床往往不可缓存（302 到带临时 token 的地址、终态 private 且无 max-age），
// 直接引用会导致每次刷新重新下载整张图。
import { create } from 'zustand';
import type { SsoPublicConfig } from '@shared/types';
import { apiFetch } from '@/lib/api';
import { initUmami, type UmamiConfig } from '@/lib/umami';
import { DEFAULT_FAVICON_DATA_URL, getCachedAsset, cacheAsset } from '@/lib/image-cache';

export interface SiteSettings {
  siteTitle?: string;
  /** 左上角标题：undefined（后端未设置）= 跟随 siteTitle；'' = 只显示 Logo 不出文字 */
  siteHeaderTitle?: string;
  siteLogo?: string;
  siteFavicon?: string;
  /** 邀请码注册（注册设置分组）：注册页展示邀请码输入的门控与必填语义 */
  inviteEnabled?: boolean;
  inviteRequired?: boolean;
  /** 生成权限：个性化设置页据此（+ 用户角色）决定邀请码区块可见性 */
  inviteGeneration?: 'all_users' | 'admin_only';
  /** Umami 访问统计（stats_source=umami 且启用且配置有效时后端才下发；null = 不注入） */
  umami?: UmamiConfig | null;
  /** 第三方登录（SSO/OIDC）：总开关 + 启用的来源（仅 id/kind/name），登录页据此渲染按钮 */
  sso?: SsoPublicConfig;
}

interface SiteState extends SiteSettings {
  loaded: boolean;
  load: () => Promise<void>;
}

const STORAGE_KEY = 'picumet:site';

/** 外部图片地址改走自家中转（响应带 public max-age）；相对路径已是自家资源，保持原样 */
function siteAssetUrl(kind: 'logo' | 'favicon', url?: string): string | undefined {
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) return url;
  return `/api/public/site-asset/${kind}?u=${encodeURIComponent(url)}`;
}

function readCached(): Partial<SiteSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<SiteSettings>) : {};
  } catch {
    return {};
  }
}

function applyFavicon(faviconUrl?: string): void {
  if (typeof document === 'undefined') return;
  const link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? (() => {
    const el = document.createElement('link');
    el.rel = 'icon';
    document.head.appendChild(el);
    return el;
  })();

  // 未配置 favicon 时使用 Picumet 默认图标（左上角 Logo 去掉文字的矢量图）
  if (!faviconUrl) {
    link.href = DEFAULT_FAVICON_DATA_URL;
    return;
  }

  // 首帧优先读取已缓存的 Data URL：URL 未变则直接同步套用、不发网络请求
  const cached = getCachedAsset('favicon', faviconUrl);
  if (cached) {
    link.href = cached;
    return;
  }

  // 探测自定义 favicon 是否可用并后台缓存；加载失败立即回落默认 Picumet 矢量图标
  const probe = new Image();
  probe.onload = () => {
    link.href = faviconUrl;
    void cacheAsset('favicon', faviconUrl).then((dataUrl) => {
      if (dataUrl) link.href = dataUrl;
    });
  };
  probe.onerror = () => {
    link.href = DEFAULT_FAVICON_DATA_URL;
  };
  probe.src = faviconUrl;
}

function applySite(s: Partial<SiteSettings>): void {
  if (s.siteTitle) document.title = s.siteTitle;
  applyFavicon(s.siteFavicon);
}

export const useSite = create<SiteState>((set) => ({
  ...readCached(),
  loaded: false,
  load: async () => {
    try {
      const res = await apiFetch<SiteSettings>('/api/public/settings');
      const data = res.data;
      // tracker 只按本次服务端响应注入（不吃 localStorage 缓存——管理员关掉后不得凭缓存值注入）
      initUmami(data.umami);
      const mapped: SiteSettings = {
        ...data,
        siteLogo: siteAssetUrl('logo', data.siteLogo),
        siteFavicon: siteAssetUrl('favicon', data.siteFavicon),
      };
      set({ ...mapped, loaded: true });
      applySite(mapped);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(mapped));
      } catch {
        /* 隐私模式下写入失败：忽略 */
      }
    } catch {
      set({ loaded: true });
    }
  },
}));

// 首帧套用上次的设置（标题 + 图标），随后 load() 再对齐最新值
applySite(readCached());
