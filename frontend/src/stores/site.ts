// 站点公开设置（站点标题 / Logo / Favicon）——从 /api/public/settings 读取并应用到文档。
// 设置本身存一份 localStorage：首帧就能套用标题与图标，不必等接口回来。
// Logo/Favicon 的外部地址经自家 Worker 中转（/api/public/site-asset/:kind，带长缓存头）：
// 外部图床往往不可缓存（302 到带临时 token 的地址、终态 private 且无 max-age），
// 直接引用会导致每次刷新重新下载整张图。
import { create } from 'zustand';
import { apiFetch } from '@/lib/api';

export interface SiteSettings {
  siteTitle?: string;
  /** 左上角标题：undefined（后端未设置）= 跟随 siteTitle；'' = 只显示 Logo 不出文字 */
  siteHeaderTitle?: string;
  siteLogo?: string;
  siteFavicon?: string;
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

function applySite(s: Partial<SiteSettings>): void {
  if (s.siteTitle) document.title = s.siteTitle;
  if (!s.siteFavicon) return;
  const link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? (() => {
    const el = document.createElement('link');
    el.rel = 'icon';
    document.head.appendChild(el);
    return el;
  })();
  link.href = s.siteFavicon;
}

export const useSite = create<SiteState>((set) => ({
  ...readCached(),
  loaded: false,
  load: async () => {
    try {
      const res = await apiFetch<SiteSettings>('/api/public/settings');
      const data = res.data;
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
